use std::{
    net::{SocketAddr, TcpListener},
    path::Path,
    sync::Arc,
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use tempfile::TempDir;
use tokio::{sync::mpsc, task::JoinHandle, time::sleep};
use tokio_stream::wrappers::ReceiverStream;
use tonic::{
    Code, Request,
    metadata::MetadataValue,
    transport::{Channel, Endpoint},
};
use uuid::Uuid;
use wudang_api::{ServerConfig, build_state, serve, storage_cipher};
use wudang_blob_store::PortableBlobStore;
use wudang_protocol::{
    auth::{
        ClientInfo, LoginLocalRequest, RefreshSessionRequest, RegisterLocalRequest,
        auth_service_client::AuthServiceClient,
    },
    changes::{ApplyPatchRequest, PreviewPatchRequest, change_service_client::ChangeServiceClient},
    collab::{
        ClientCollabMessage, DeltaId, GetDocumentSnapshotRequest, OpenDocument, TextDelta,
        TextEdit, client_collab_message, collaboration_service_client::CollaborationServiceClient,
        document_ready, server_collab_message,
    },
    repository::{
        CreateHostedRepositoryRequest, repository_service_client::RepositoryServiceClient,
    },
};

const TEST_PASSWORD: &str = "correct horse battery staple";

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires WUDANG_E2E_DATABASE_URL pointing to an isolated PostgreSQL database"]
async fn complete_local_workflow_and_restart_recovery() {
    let database_url = std::env::var("WUDANG_E2E_DATABASE_URL")
        .expect("WUDANG_E2E_DATABASE_URL must point to an isolated PostgreSQL database");
    let data = tempfile::tempdir().unwrap();
    let config = test_config(database_url, &data);
    let first = spawn_server(config.clone()).await;

    let mut auth = AuthServiceClient::new(first.channel.clone());
    let email = format!("e2e-{}@example.invalid", Uuid::new_v4());
    let session = auth
        .register_local(RegisterLocalRequest {
            request_id: Uuid::new_v4().to_string(),
            email: email.clone(),
            password: TEST_PASSWORD.to_owned(),
            display_name: "E2E User".to_owned(),
            client: Some(test_client()),
        })
        .await
        .unwrap()
        .into_inner();
    assert_eq!(session.user.as_ref().unwrap().email, email);
    assert_eq!(session.token_type, "Bearer");

    let login = auth
        .login_local(LoginLocalRequest {
            request_id: Uuid::new_v4().to_string(),
            email,
            password: TEST_PASSWORD.to_owned(),
            client: Some(test_client()),
        })
        .await
        .unwrap()
        .into_inner();
    assert!(!login.access_token.is_empty());

    let previous_refresh_token = session.refresh_token.clone();
    let refreshed = auth
        .refresh_session(RefreshSessionRequest {
            request_id: Uuid::new_v4().to_string(),
            refresh_token: previous_refresh_token.clone(),
            client: Some(test_client()),
        })
        .await
        .unwrap()
        .into_inner();
    assert_ne!(refreshed.refresh_token, previous_refresh_token);
    let replay = auth
        .refresh_session(RefreshSessionRequest {
            request_id: Uuid::new_v4().to_string(),
            refresh_token: previous_refresh_token,
            client: Some(test_client()),
        })
        .await
        .unwrap_err();
    assert_eq!(replay.code(), Code::Unauthenticated);

    let access_token = refreshed.access_token;
    let organization_id = Uuid::new_v4().to_string();
    let mut repositories = RepositoryServiceClient::new(first.channel.clone());
    let repository = repositories
        .create_hosted_repository(authenticated(
            CreateHostedRepositoryRequest {
                request_id: Uuid::new_v4().to_string(),
                organization_id,
                name: format!("e2e-{}", Uuid::new_v4()),
                default_branch: "main".to_owned(),
            },
            &access_token,
        ))
        .await
        .unwrap()
        .into_inner();
    assert!(repository.empty);
    assert_one_bare_repository(&config.git_root);

    let mut changes = ChangeServiceClient::new(first.channel.clone());
    let preview = changes
        .preview_patch(authenticated(
            PreviewPatchRequest {
                request_id: Uuid::new_v4().to_string(),
                workspace_id: "workspace-e2e".to_owned(),
                expected_revision: 7,
                unified_patch:
                    "*** Begin Patch\n*** Update File: src/lib.rs\n@@\n-old\n+new\n*** End Patch\n"
                        .to_owned(),
                tool_call_id: "tool-e2e".to_owned(),
            },
            &access_token,
        ))
        .await
        .unwrap()
        .into_inner();
    let applied = changes
        .apply_patch(authenticated(
            ApplyPatchRequest {
                request_id: Uuid::new_v4().to_string(),
                patch_id: preview.patch_id,
                workspace_id: "workspace-e2e".to_owned(),
                expected_revision: 7,
            },
            &access_token,
        ))
        .await
        .unwrap()
        .into_inner();
    assert_eq!(applied.change_set.unwrap().head_revision, 8);

    let document_id = format!("document-{}", Uuid::new_v4());
    apply_collaborative_edit(
        first.channel.clone(),
        &access_token,
        &document_id,
        "hello 武当",
    )
    .await;

    first.task.abort();
    let _ = first.task.await;

    let second = spawn_server(config).await;
    let mut collab = CollaborationServiceClient::new(second.channel.clone());
    let snapshot = collab
        .get_document_snapshot(authenticated(
            GetDocumentSnapshotRequest {
                document_id,
                preferred_version: None,
            },
            &access_token,
        ))
        .await
        .unwrap()
        .into_inner();
    assert_eq!(snapshot.rendered_text, "hello 武当");

    second.task.abort();
    let _ = second.task.await;
}

async fn apply_collaborative_edit(
    channel: Channel,
    access_token: &str,
    document_id: &str,
    text: &str,
) {
    let mut collab = CollaborationServiceClient::new(channel);
    let (sender, receiver) = mpsc::channel(8);
    sender
        .send(ClientCollabMessage {
            payload: Some(client_collab_message::Payload::Open(OpenDocument {
                document_id: document_id.to_owned(),
                workspace_id: "workspace-e2e".to_owned(),
                replica_id: "replica-e2e".to_owned(),
                device_id: "device-e2e".to_owned(),
                known_version: None,
            })),
        })
        .await
        .unwrap();
    let response = collab
        .sync_document(authenticated(ReceiverStream::new(receiver), access_token))
        .await
        .unwrap();
    let mut stream = response.into_inner();
    let ready = stream.message().await.unwrap().unwrap();
    let ready = match ready.payload.unwrap() {
        server_collab_message::Payload::Ready(ready) => ready,
        other => panic!("expected ready frame, got {other:?}"),
    };
    let version = ready.version.unwrap();
    assert!(matches!(
        ready.catch_up,
        Some(document_ready::CatchUp::Snapshot(_))
    ));

    sender
        .send(ClientCollabMessage {
            payload: Some(client_collab_message::Payload::Delta(TextDelta {
                document_id: document_id.to_owned(),
                delta_id: Some(DeltaId {
                    replica_id: "replica-e2e".to_owned(),
                    sequence: 1,
                }),
                based_on: Some(version),
                edits: vec![TextEdit {
                    start_utf8: 0,
                    end_utf8: 0,
                    inserted_text: text.to_owned(),
                }],
                attribution: None,
                request_id: Uuid::new_v4().to_string(),
                created_at: None,
            })),
        })
        .await
        .unwrap();

    loop {
        let message = stream.message().await.unwrap().unwrap();
        if matches!(
            message.payload,
            Some(server_collab_message::Payload::DeltaAck(_))
        ) {
            break;
        }
    }
}

struct RunningServer {
    channel: Channel,
    task: JoinHandle<anyhow::Result<()>>,
}

async fn spawn_server(config: ServerConfig) -> RunningServer {
    let blobs = Arc::new(
        PortableBlobStore::new(&config.blob_root, storage_cipher(&config).unwrap())
            .await
            .unwrap(),
    );
    let state = build_state(&config, blobs).await.unwrap();
    let endpoint = format!("http://{}", config.listen_addr);
    let task = tokio::spawn(serve(config, state));
    let channel = connect_with_retry(&endpoint).await;
    RunningServer { channel, task }
}

async fn connect_with_retry(endpoint: &str) -> Channel {
    let mut last_error = None;
    for _ in 0..50 {
        match Endpoint::from_shared(endpoint.to_owned())
            .unwrap()
            .connect()
            .await
        {
            Ok(channel) => return channel,
            Err(error) => {
                last_error = Some(error);
                sleep(Duration::from_millis(20)).await;
            }
        }
    }
    panic!("server did not start: {last_error:?}");
}

fn authenticated<T>(message: T, access_token: &str) -> Request<T> {
    let mut request = Request::new(message);
    request.metadata_mut().insert(
        "authorization",
        MetadataValue::try_from(format!("Bearer {access_token}")).unwrap(),
    );
    request
}

fn test_client() -> ClientInfo {
    ClientInfo {
        device_id: "device-e2e".to_owned(),
        device_name: "E2E runner".to_owned(),
        app_version: "0.1.0".to_owned(),
        platform: std::env::consts::OS.to_owned(),
    }
}

fn test_config(database_url: String, data: &TempDir) -> ServerConfig {
    ServerConfig {
        listen_addr: available_address(),
        database_url,
        git_root: data.path().join("git"),
        blob_root: data.path().join("blobs"),
        git_public_base_url: None,
        require_encrypted_git_volume: false,
        git_volume_encrypted: false,
        jwt_secret_base64: STANDARD.encode([1_u8; 32]),
        storage_key_base64: STANDARD.encode([2_u8; 32]),
        refresh_pepper: Arc::new(vec![3_u8; 32]),
        storage_key_id: "e2e-v1".to_owned(),
        jwt_issuer: "wudang-e2e".to_owned(),
        jwt_audience: "wudang-e2e-client".to_owned(),
        access_ttl_seconds: 300,
        refresh_ttl_days: 1,
        postgres_max_connections: 8,
        allow_local_registration: true,
        tls_cert_path: None,
        tls_key_path: None,
    }
}

fn available_address() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap()
}

fn assert_one_bare_repository(root: &Path) {
    let repositories = std::fs::read_dir(root)
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(repositories.len(), 1);
    assert!(git2::Repository::open_bare(repositories[0].path()).is_ok());
}
