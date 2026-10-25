use std::{collections::BTreeSet, sync::Arc};

use dashmap::DashMap;
use prost::Message as _;
use thiserror::Error;
use tokio::sync::{Mutex, broadcast};
use wudang_crypto::{EncryptedPayload, EnvelopeCipher};
use wudang_domain as domain;
use wudang_persistence::{PgStore, StoreError};
use wudang_protocol::collab as proto;

#[derive(Debug, Error)]
pub enum CollabError {
    #[error("invalid collaboration message: {0}")]
    Invalid(&'static str),
    #[error("numeric value is outside the supported range")]
    NumericRange,
    #[error("document update failed: {0}")]
    Document(#[from] domain::DocumentError),
    #[error("collaboration persistence failed: {0}")]
    Store(#[from] StoreError),
    #[error("collaboration encryption failed: {0}")]
    Crypto(#[from] wudang_crypto::CryptoError),
}

pub struct DocumentRoom {
    document: proto::Document,
    state: Mutex<RoomState>,
    events: broadcast::Sender<proto::ServerCollabMessage>,
}

#[derive(Clone)]
struct RoomState {
    document: domain::DocumentState,
    history: Vec<proto::TextDelta>,
}

#[derive(Clone)]
pub struct CollaborationEngine {
    rooms: Arc<DashMap<String, Arc<DocumentRoom>>>,
    store: PgStore,
    cipher: EnvelopeCipher,
}

impl CollaborationEngine {
    pub fn new(store: PgStore, cipher: EnvelopeCipher) -> Self {
        Self {
            rooms: Arc::new(DashMap::new()),
            store,
            cipher,
        }
    }

    pub async fn open(
        &self,
        document_id: &str,
        workspace_id: &str,
    ) -> Result<Arc<DocumentRoom>, CollabError> {
        if document_id.is_empty() {
            return Err(CollabError::Invalid("document_id is required"));
        }
        if let Some(existing) = self.rooms.get(document_id) {
            return Ok(existing.clone());
        }

        let base = proto::GitVersion {
            repository_id: String::new(),
            commit_oid: String::new(),
            path: String::new(),
            blob_oid: format!("empty:{document_id}"),
        };
        let document = proto::Document {
            document_id: document_id.to_owned(),
            workspace_id: workspace_id.to_owned(),
            file_id: document_id.to_owned(),
            path: String::new(),
            base: Some(base.clone()),
        };
        let mut document_state = domain::DocumentState::new(base.blob_oid, "");
        let mut history = Vec::new();
        for stored in self.store.encrypted_deltas(document_id).await? {
            let payload = EncryptedPayload {
                key_id: stored.key_id,
                nonce: stored.nonce,
                ciphertext: stored.ciphertext,
            };
            let encoded = self.cipher.open(&payload, document_id.as_bytes())?;
            let delta = proto::TextDelta::decode(encoded.as_slice())
                .map_err(|_| CollabError::Invalid("stored delta cannot be decoded"))?;
            document_state.submit(delta_from_proto_parts(&delta, &document)?)?;
            history.push(delta);
        }

        let (events, _) = broadcast::channel(1_024);
        let room = Arc::new(DocumentRoom {
            document,
            state: Mutex::new(RoomState {
                document: document_state,
                history,
            }),
            events,
        });
        let entry = self
            .rooms
            .entry(document_id.to_owned())
            .or_insert_with(|| room.clone());
        Ok(entry.clone())
    }

    pub async fn ready(
        &self,
        room: &DocumentRoom,
        known_version: Option<&proto::CausalVersion>,
    ) -> Result<proto::DocumentReady, CollabError> {
        let state = room.state.lock().await;
        let version = version_to_proto(
            &state.document.current_version(),
            room.document.base.clone(),
        );
        let catch_up = if known_version.is_some_and(|known| known.digest == version.digest) {
            proto::document_ready::CatchUp::MissingDeltas(proto::DeltaBatch { deltas: Vec::new() })
        } else {
            proto::document_ready::CatchUp::Snapshot(Box::new(proto::DocumentSnapshot {
                document: Some(room.document.clone()),
                version: Some(version.clone()),
                base_text: String::new(),
                deltas: state.history.clone(),
                rendered_text: state.document.current_text()?,
                generated_at: Some(now_timestamp()),
            }))
        };
        Ok(proto::DocumentReady {
            document: Some(room.document.clone()),
            version: Some(version),
            catch_up: Some(catch_up),
        })
    }

    pub async fn submit(
        &self,
        room: &DocumentRoom,
        delta: proto::TextDelta,
    ) -> Result<proto::DeltaAck, CollabError> {
        if delta.document_id != room.document.document_id {
            return Err(CollabError::Invalid(
                "delta document_id does not match the open stream",
            ));
        }

        let domain_delta = delta_from_proto(&delta, room)?;
        let delta_id = domain_delta.id.clone();
        let mut state = room.state.lock().await;
        let mut candidate = state.document.clone();
        let applied = candidate.submit(domain_delta)?;

        let encoded = delta.encode_to_vec();
        let encrypted = self
            .cipher
            .seal(&encoded, room.document.document_id.as_bytes())?;
        let sequence = i64::try_from(delta_id.sequence).map_err(|_| CollabError::NumericRange)?;
        self.store
            .append_encrypted_delta(
                &room.document.document_id,
                &delta_id.replica_id,
                sequence,
                &encrypted,
            )
            .await?;

        state.document = candidate;
        if !applied.duplicate {
            state.history.push(delta.clone());
        }
        let version = version_to_proto(&applied.version, room.document.base.clone());
        drop(state);

        if !applied.duplicate {
            let _ = room.events.send(proto::ServerCollabMessage {
                payload: Some(proto::server_collab_message::Payload::Delta(delta)),
            });
        }

        Ok(proto::DeltaAck {
            delta_id: Some(proto::DeltaId {
                replica_id: delta_id.replica_id,
                sequence: delta_id.sequence,
            }),
            accepted_version: Some(version),
        })
    }

    pub fn publish_presence(&self, room: &DocumentRoom, presence: proto::Presence) {
        let _ = room.events.send(proto::ServerCollabMessage {
            payload: Some(proto::server_collab_message::Payload::Presence(presence)),
        });
    }

    pub fn subscribe(
        &self,
        room: &DocumentRoom,
    ) -> broadcast::Receiver<proto::ServerCollabMessage> {
        room.events.subscribe()
    }

    pub async fn snapshot(
        &self,
        room: &DocumentRoom,
    ) -> Result<proto::DocumentSnapshot, CollabError> {
        let state = room.state.lock().await;
        Ok(proto::DocumentSnapshot {
            document: Some(room.document.clone()),
            version: Some(version_to_proto(
                &state.document.current_version(),
                room.document.base.clone(),
            )),
            base_text: String::new(),
            deltas: state.history.clone(),
            rendered_text: state.document.current_text()?,
            generated_at: Some(now_timestamp()),
        })
    }
}

fn delta_from_proto(
    delta: &proto::TextDelta,
    room: &DocumentRoom,
) -> Result<domain::TextDelta, CollabError> {
    delta_from_proto_parts(delta, &room.document)
}

fn delta_from_proto_parts(
    delta: &proto::TextDelta,
    document: &proto::Document,
) -> Result<domain::TextDelta, CollabError> {
    let id = delta
        .delta_id
        .as_ref()
        .ok_or(CollabError::Invalid("delta_id is required"))?;
    let based_on = delta
        .based_on
        .as_ref()
        .ok_or(CollabError::Invalid("based_on is required"))?;
    let base = based_on
        .base
        .as_ref()
        .or(document.base.as_ref())
        .ok_or(CollabError::Invalid("Git base is required"))?;
    let frontier = based_on
        .frontier
        .iter()
        .map(|head| domain::DeltaId {
            replica_id: head.replica_id.clone(),
            sequence: head.sequence,
        })
        .collect::<BTreeSet<_>>();
    let edits = delta
        .edits
        .iter()
        .map(|edit| {
            Ok(domain::TextEdit {
                start_utf8: usize::try_from(edit.start_utf8)
                    .map_err(|_| CollabError::NumericRange)?,
                end_utf8: usize::try_from(edit.end_utf8).map_err(|_| CollabError::NumericRange)?,
                inserted_text: edit.inserted_text.clone(),
            })
        })
        .collect::<Result<Vec<_>, CollabError>>()?;
    let attribution = delta.attribution.as_ref();
    Ok(domain::TextDelta {
        id: domain::DeltaId {
            replica_id: id.replica_id.clone(),
            sequence: id.sequence,
        },
        based_on: domain::CausalVersion {
            base_digest: base.blob_oid.clone(),
            frontier,
        },
        edits,
        attribution: domain::Attribution {
            actor_id: attribution
                .map(|value| value.actor_id.clone())
                .unwrap_or_default(),
            agent_id: attribution
                .map(|value| value.agent_id.clone())
                .unwrap_or_default(),
            run_id: attribution
                .map(|value| value.run_id.clone())
                .unwrap_or_default(),
            prompt_message_id: attribution
                .map(|value| value.prompt_message_id.clone())
                .unwrap_or_default(),
        },
    })
}

fn version_to_proto(
    version: &domain::CausalVersion,
    base: Option<proto::GitVersion>,
) -> proto::CausalVersion {
    proto::CausalVersion {
        base,
        frontier: version
            .frontier
            .iter()
            .map(|head| proto::DeltaId {
                replica_id: head.replica_id.clone(),
                sequence: head.sequence,
            })
            .collect(),
        digest: version.digest(),
    }
}

fn now_timestamp() -> prost_types::Timestamp {
    let now = chrono::Utc::now();
    prost_types::Timestamp {
        seconds: now.timestamp(),
        nanos: now.timestamp_subsec_nanos() as i32,
    }
}
