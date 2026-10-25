use std::{
    collections::VecDeque,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use futures_core::Stream;
use tokio::sync::{RwLock, broadcast};
use tonic::{Request, Response, Status};
use wudang_protocol::sync::{
    AcknowledgeCursorRequest, AcknowledgeCursorResponse, EventCursor, GetSnapshotRequest,
    ResourceRevision, SubscribeEventsRequest, SyncEvent, SyncScope, SyncSnapshot,
    sync_service_server::SyncService,
};

use crate::{AppState, now_timestamp};

#[derive(Clone)]
pub struct EventBus {
    inner: Arc<EventBusInner>,
}

struct EventBusInner {
    sequence: AtomicU64,
    retention: usize,
    backlog: RwLock<VecDeque<SyncEvent>>,
    live: broadcast::Sender<SyncEvent>,
}

impl EventBus {
    pub fn new(retention: usize) -> Self {
        let (live, _) = broadcast::channel(retention.max(16));
        Self {
            inner: Arc::new(EventBusInner {
                sequence: AtomicU64::new(0),
                retention,
                backlog: RwLock::new(VecDeque::with_capacity(retention)),
                live,
            }),
        }
    }

    pub async fn publish(&self, mut event: SyncEvent) -> EventCursor {
        let sequence = self.inner.sequence.fetch_add(1, Ordering::SeqCst) + 1;
        let cursor = EventCursor {
            stream_id: "domain".to_owned(),
            sequence,
        };
        event.cursor = Some(cursor.clone());
        if event.occurred_at.is_none() {
            event.occurred_at = Some(now_timestamp());
        }
        let mut backlog = self.inner.backlog.write().await;
        backlog.push_back(event.clone());
        while backlog.len() > self.inner.retention {
            backlog.pop_front();
        }
        drop(backlog);
        let _ = self.inner.live.send(event);
        cursor
    }

    fn current_cursor(&self) -> EventCursor {
        EventCursor {
            stream_id: "domain".to_owned(),
            sequence: self.inner.sequence.load(Ordering::SeqCst),
        }
    }
}

#[derive(Clone)]
pub struct SyncGrpc {
    state: AppState,
}

impl SyncGrpc {
    pub fn new(state: AppState) -> Self {
        Self { state }
    }
}

type EventStream = Pin<Box<dyn Stream<Item = Result<SyncEvent, Status>> + Send + 'static>>;

#[tonic::async_trait]
impl SyncService for SyncGrpc {
    type SubscribeEventsStream = EventStream;

    async fn subscribe_events(
        &self,
        request: Request<SubscribeEventsRequest>,
    ) -> Result<Response<Self::SubscribeEventsStream>, Status> {
        let request = request.into_inner();
        let scope = request
            .scope
            .ok_or_else(|| Status::invalid_argument("scope is required"))?;
        let after = request.after_cursor.unwrap_or(EventCursor {
            stream_id: "domain".to_owned(),
            sequence: 0,
        });
        if after.stream_id != "domain" {
            return Err(Status::invalid_argument("cursor stream_id is invalid"));
        }

        let mut live = self.state.events.inner.live.subscribe();
        let backlog = self
            .state
            .events
            .inner
            .backlog
            .read()
            .await
            .iter()
            .filter(|event| {
                event
                    .cursor
                    .as_ref()
                    .is_some_and(|cursor| cursor.sequence > after.sequence)
                    && event_matches_scope(event, &scope)
            })
            .cloned()
            .collect::<Vec<_>>();
        let oldest = self
            .state
            .events
            .inner
            .backlog
            .read()
            .await
            .front()
            .and_then(|event| event.cursor.as_ref())
            .map(|cursor| cursor.sequence)
            .unwrap_or(after.sequence);
        if after.sequence > 0 && after.sequence.saturating_add(1) < oldest {
            return Err(Status::out_of_range(
                "event cursor expired; request a snapshot",
            ));
        }

        let output = async_stream::try_stream! {
            for event in backlog {
                yield event;
            }
            loop {
                match live.recv().await {
                    Ok(event) if event_matches_scope(&event, &scope) => yield event,
                    Ok(_) => {}
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        Err(Status::out_of_range("event subscriber lagged; request a snapshot"))?;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        };
        Ok(Response::new(Box::pin(output)))
    }

    async fn get_snapshot(
        &self,
        request: Request<GetSnapshotRequest>,
    ) -> Result<Response<SyncSnapshot>, Status> {
        let scope = request
            .into_inner()
            .scope
            .ok_or_else(|| Status::invalid_argument("scope is required"))?;
        Ok(Response::new(SyncSnapshot {
            scope: Some(scope),
            cursor: Some(self.state.events.current_cursor()),
            resources: Vec::<ResourceRevision>::new(),
            generated_at: Some(now_timestamp()),
        }))
    }

    async fn acknowledge_cursor(
        &self,
        request: Request<AcknowledgeCursorRequest>,
    ) -> Result<Response<AcknowledgeCursorResponse>, Status> {
        let request = request.into_inner();
        let cursor = request
            .cursor
            .ok_or_else(|| Status::invalid_argument("cursor is required"))?;
        if cursor.stream_id != "domain"
            || cursor.sequence > self.state.events.current_cursor().sequence
        {
            return Err(Status::invalid_argument("cursor is invalid"));
        }
        Ok(Response::new(AcknowledgeCursorResponse {
            acknowledged_cursor: Some(cursor),
        }))
    }
}

fn event_matches_scope(event: &SyncEvent, requested: &SyncScope) -> bool {
    event
        .scope
        .as_ref()
        .is_some_and(|event_scope| event_scope == requested)
}
