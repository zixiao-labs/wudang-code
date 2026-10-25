use std::pin::Pin;

use futures_core::Stream;
use tokio::sync::{broadcast, mpsc};
use tokio_stream::wrappers::ReceiverStream;
use tonic::{Request, Response, Status};
use wudang_protocol::collab::{
    ClientCollabMessage, CollabError, GetDocumentSnapshotRequest, Heartbeat, ResyncReason,
    ResyncRequired, ServerCollabMessage, client_collab_message,
    collaboration_service_server::CollaborationService, server_collab_message,
};

use crate::AppState;

#[derive(Clone)]
pub struct CollaborationGrpc {
    state: AppState,
}

impl CollaborationGrpc {
    pub fn new(state: AppState) -> Self {
        Self { state }
    }
}

type CollabStream =
    Pin<Box<dyn Stream<Item = Result<ServerCollabMessage, Status>> + Send + 'static>>;

#[tonic::async_trait]
impl CollaborationService for CollaborationGrpc {
    type SyncDocumentStream = CollabStream;

    async fn sync_document(
        &self,
        request: Request<tonic::Streaming<ClientCollabMessage>>,
    ) -> Result<Response<Self::SyncDocumentStream>, Status> {
        let mut input = request.into_inner();
        let first = input
            .message()
            .await?
            .ok_or_else(|| Status::invalid_argument("OpenDocument must be the first frame"))?;
        let open = match first.payload {
            Some(client_collab_message::Payload::Open(open)) => open,
            _ => {
                return Err(Status::invalid_argument(
                    "OpenDocument must be the first frame",
                ));
            }
        };
        if open.replica_id.is_empty() {
            return Err(Status::invalid_argument("replica_id is required"));
        }
        let room = self
            .state
            .collab
            .open(&open.document_id, &open.workspace_id)
            .await
            .map_err(|error| Status::invalid_argument(error.to_string()))?;
        let mut events = self.state.collab.subscribe(&room);
        let ready = self
            .state
            .collab
            .ready(&room, open.known_version.as_ref())
            .await
            .map_err(|error| Status::internal(error.to_string()))?;
        let engine = self.state.collab.clone();
        let document_id = open.document_id;
        let (sender, receiver) = mpsc::channel(128);

        tokio::spawn(async move {
            if sender
                .send(Ok(ServerCollabMessage {
                    payload: Some(server_collab_message::Payload::Ready(Box::new(ready))),
                }))
                .await
                .is_err()
            {
                return;
            }

            loop {
                tokio::select! {
                    inbound = input.message() => {
                        match inbound {
                            Ok(Some(message)) => {
                                if !handle_client_message(
                                    &engine,
                                    &room,
                                    &document_id,
                                    message,
                                    &sender,
                                ).await {
                                    break;
                                }
                            }
                            Ok(None) => break,
                            Err(status) => {
                                let _ = sender.send(Err(status)).await;
                                break;
                            }
                        }
                    }
                    outbound = events.recv() => {
                        match outbound {
                            Ok(message) => {
                                if sender.send(Ok(message)).await.is_err() {
                                    break;
                                }
                            }
                            Err(broadcast::error::RecvError::Lagged(_)) => {
                                let version = engine
                                    .snapshot(&room)
                                    .await
                                    .ok()
                                    .and_then(|snapshot| snapshot.version);
                                let message = ServerCollabMessage {
                                    payload: Some(server_collab_message::Payload::ResyncRequired(
                                        ResyncRequired {
                                            reason: ResyncReason::HistoryCompacted as i32,
                                            server_version: version,
                                            message: "subscriber lagged; fetch a fresh snapshot".to_owned(),
                                        },
                                    )),
                                };
                                let _ = sender.send(Ok(message)).await;
                                break;
                            }
                            Err(broadcast::error::RecvError::Closed) => break,
                        }
                    }
                }
            }
        });

        Ok(Response::new(Box::pin(ReceiverStream::new(receiver))))
    }

    async fn get_document_snapshot(
        &self,
        request: Request<GetDocumentSnapshotRequest>,
    ) -> Result<Response<wudang_protocol::collab::DocumentSnapshot>, Status> {
        let request = request.into_inner();
        let room = self
            .state
            .collab
            .open(&request.document_id, "")
            .await
            .map_err(|error| Status::invalid_argument(error.to_string()))?;
        let snapshot = self
            .state
            .collab
            .snapshot(&room)
            .await
            .map_err(|error| Status::internal(error.to_string()))?;
        Ok(Response::new(snapshot))
    }
}

async fn handle_client_message(
    engine: &wudang_collab::CollaborationEngine,
    room: &wudang_collab::DocumentRoom,
    document_id: &str,
    message: ClientCollabMessage,
    sender: &mpsc::Sender<Result<ServerCollabMessage, Status>>,
) -> bool {
    match message.payload {
        Some(client_collab_message::Payload::Delta(delta)) => {
            match engine.submit(room, delta).await {
                Ok(ack) => sender
                    .send(Ok(ServerCollabMessage {
                        payload: Some(server_collab_message::Payload::DeltaAck(ack)),
                    }))
                    .await
                    .is_ok(),
                Err(error) => sender
                    .send(Ok(error_message(
                        "DELTA_REJECTED",
                        error.to_string(),
                        false,
                    )))
                    .await
                    .is_ok(),
            }
        }
        Some(client_collab_message::Payload::Presence(presence)) => {
            if presence.document_id != document_id {
                return sender
                    .send(Ok(error_message(
                        "DOCUMENT_MISMATCH",
                        "presence document_id does not match the open stream",
                        false,
                    )))
                    .await
                    .is_ok();
            }
            engine.publish_presence(room, presence);
            true
        }
        Some(client_collab_message::Payload::Ack(_)) => true,
        Some(client_collab_message::Payload::Heartbeat(Heartbeat { nonce })) => sender
            .send(Ok(ServerCollabMessage {
                payload: Some(server_collab_message::Payload::Heartbeat(Heartbeat {
                    nonce,
                })),
            }))
            .await
            .is_ok(),
        Some(client_collab_message::Payload::Open(_)) => sender
            .send(Ok(error_message(
                "ALREADY_OPEN",
                "a collaboration stream can open only one document",
                false,
            )))
            .await
            .is_ok(),
        None => sender
            .send(Ok(error_message(
                "EMPTY_FRAME",
                "collaboration frame has no payload",
                false,
            )))
            .await
            .is_ok(),
    }
}

fn error_message(
    code: impl Into<String>,
    message: impl Into<String>,
    retryable: bool,
) -> ServerCollabMessage {
    ServerCollabMessage {
        payload: Some(server_collab_message::Payload::Error(CollabError {
            code: code.into(),
            message: message.into(),
            retryable,
        })),
    }
}
