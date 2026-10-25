mod auth;
mod changes;
mod collaboration;
mod repository;
mod sync;

use std::{env, net::SocketAddr, path::PathBuf, sync::Arc};

use anyhow::{Context, Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use tonic::transport::{Identity, Server, ServerTlsConfig};
use tonic::{Request, Status, service::Interceptor};
use tracing::info;
use wudang_blob_store::BlobStore;
use wudang_collab::CollaborationEngine;
use wudang_crypto::{AccessClaims, EnvelopeCipher, JwtIssuer, PasswordService};
use wudang_git_store::GitStore;
use wudang_persistence::PgStore;
use wudang_protocol::{
    FILE_DESCRIPTOR_SET, auth::auth_service_server::AuthServiceServer,
    changes::change_service_server::ChangeServiceServer,
    collab::collaboration_service_server::CollaborationServiceServer,
    repository::repository_service_server::RepositoryServiceServer,
    sync::sync_service_server::SyncServiceServer,
};

pub use sync::EventBus;

#[derive(Clone, Debug)]
pub struct ServerConfig {
    pub listen_addr: SocketAddr,
    pub database_url: String,
    pub git_root: PathBuf,
    pub blob_root: PathBuf,
    pub git_public_base_url: Option<String>,
    pub require_encrypted_git_volume: bool,
    pub git_volume_encrypted: bool,
    pub jwt_secret_base64: String,
    pub storage_key_base64: String,
    pub refresh_pepper: Arc<Vec<u8>>,
    pub storage_key_id: String,
    pub jwt_issuer: String,
    pub jwt_audience: String,
    pub access_ttl_seconds: u64,
    pub refresh_ttl_days: i64,
    pub postgres_max_connections: u32,
    pub allow_local_registration: bool,
    pub tls_cert_path: Option<PathBuf>,
    pub tls_key_path: Option<PathBuf>,
}

impl ServerConfig {
    pub fn from_env() -> Result<Self> {
        let listen_addr = env_or("WUDANG_LISTEN_ADDR", "127.0.0.1:50051")
            .parse()
            .context("WUDANG_LISTEN_ADDR must be a socket address")?;
        let database_url = required_env("WUDANG_DATABASE_URL")?;
        let jwt_secret_base64 = required_env("WUDANG_JWT_SECRET_BASE64")?;
        let storage_key_base64 = required_env("WUDANG_STORAGE_KEY_BASE64")?;
        let refresh_pepper = STANDARD
            .decode(required_env("WUDANG_REFRESH_PEPPER_BASE64")?)
            .context("WUDANG_REFRESH_PEPPER_BASE64 must be valid base64")?;
        if refresh_pepper.len() < 32 {
            bail!("WUDANG_REFRESH_PEPPER_BASE64 must decode to at least 32 bytes");
        }

        let tls_cert_path = optional_path("WUDANG_TLS_CERT_PATH");
        let tls_key_path = optional_path("WUDANG_TLS_KEY_PATH");
        if tls_cert_path.is_some() != tls_key_path.is_some() {
            bail!("WUDANG_TLS_CERT_PATH and WUDANG_TLS_KEY_PATH must be configured together");
        }

        Ok(Self {
            listen_addr,
            database_url,
            git_root: PathBuf::from(env_or("WUDANG_GIT_ROOT", "./data/git")),
            blob_root: PathBuf::from(env_or("WUDANG_BLOB_ROOT", "./data/blobs")),
            git_public_base_url: env::var("WUDANG_GIT_PUBLIC_BASE_URL")
                .ok()
                .filter(|value| !value.is_empty()),
            require_encrypted_git_volume: env_bool("WUDANG_REQUIRE_ENCRYPTED_GIT_VOLUME", true)?,
            git_volume_encrypted: env_bool("WUDANG_GIT_VOLUME_ENCRYPTED", false)?,
            jwt_secret_base64,
            storage_key_base64,
            refresh_pepper: Arc::new(refresh_pepper),
            storage_key_id: env_or("WUDANG_STORAGE_KEY_ID", "local-v1"),
            jwt_issuer: env_or("WUDANG_JWT_ISSUER", "wudang"),
            jwt_audience: env_or("WUDANG_JWT_AUDIENCE", "wudang-desktop"),
            access_ttl_seconds: env_parse("WUDANG_ACCESS_TTL_SECONDS", 900)?,
            refresh_ttl_days: env_parse("WUDANG_REFRESH_TTL_DAYS", 30)?,
            postgres_max_connections: env_parse("WUDANG_POSTGRES_MAX_CONNECTIONS", 32)?,
            allow_local_registration: env_bool("WUDANG_ALLOW_LOCAL_REGISTRATION", false)?,
            tls_cert_path,
            tls_key_path,
        })
    }
}

#[derive(Clone)]
pub struct AppState {
    pub store: PgStore,
    pub jwt: JwtIssuer,
    pub password: PasswordService,
    pub refresh_pepper: Arc<Vec<u8>>,
    pub refresh_ttl_days: i64,
    pub allow_local_registration: bool,
    pub collab: CollaborationEngine,
    pub git: GitStore,
    pub blobs: Arc<dyn BlobStore>,
    pub events: EventBus,
    pub changes: changes::ChangeState,
}

#[derive(Clone)]
struct JwtInterceptor {
    issuer: JwtIssuer,
}

impl Interceptor for JwtInterceptor {
    fn call(&mut self, mut request: Request<()>) -> std::result::Result<Request<()>, Status> {
        let authorization = request
            .metadata()
            .get("authorization")
            .ok_or_else(|| Status::unauthenticated("authorization metadata is required"))?
            .to_str()
            .map_err(|_| Status::unauthenticated("authorization metadata is invalid"))?;
        let token = authorization
            .strip_prefix("Bearer ")
            .ok_or_else(|| Status::unauthenticated("Bearer token is required"))?;
        let claims = self
            .issuer
            .verify(token)
            .map_err(|_| Status::unauthenticated("access token is invalid"))?;
        request.extensions_mut().insert(AuthenticatedUser(claims));
        Ok(request)
    }
}

#[derive(Clone, Debug)]
pub struct AuthenticatedUser(pub AccessClaims);

pub async fn build_state(config: &ServerConfig, blobs: Arc<dyn BlobStore>) -> Result<AppState> {
    let store = PgStore::connect(&config.database_url, config.postgres_max_connections)
        .await
        .context("connect to PostgreSQL")?;
    store.migrate().await.context("run PostgreSQL migrations")?;

    let jwt = JwtIssuer::from_base64(
        &config.jwt_secret_base64,
        &config.jwt_issuer,
        &config.jwt_audience,
        config.access_ttl_seconds,
    )
    .context("configure JWT issuer")?;
    let cipher = EnvelopeCipher::from_base64(&config.storage_key_id, &config.storage_key_base64)
        .context("configure storage encryption")?;
    let git = GitStore::new(
        &config.git_root,
        config.git_public_base_url.clone(),
        config.require_encrypted_git_volume,
        config.git_volume_encrypted,
    )
    .context("configure hosted Git storage")?;
    let collab = CollaborationEngine::new(store.clone(), cipher);

    Ok(AppState {
        store,
        jwt,
        password: PasswordService,
        refresh_pepper: config.refresh_pepper.clone(),
        refresh_ttl_days: config.refresh_ttl_days,
        allow_local_registration: config.allow_local_registration,
        collab,
        git,
        blobs,
        events: EventBus::new(4_096),
        changes: changes::ChangeState::default(),
    })
}

pub async fn serve(config: ServerConfig, state: AppState) -> Result<()> {
    let auth = auth::AuthGrpc::new(state.clone());
    let changes = changes::ChangeGrpc::new(state.clone());
    let collaboration = collaboration::CollaborationGrpc::new(state.clone());
    let repository = repository::RepositoryGrpc::new(state.clone());
    let sync = sync::SyncGrpc::new(state.clone());
    let authentication = JwtInterceptor {
        issuer: state.jwt.clone(),
    };
    let reflection = tonic_reflection::server::Builder::configure()
        .register_encoded_file_descriptor_set(FILE_DESCRIPTOR_SET)
        .build_v1()
        .context("build gRPC reflection service")?;

    let mut builder = Server::builder();
    if let (Some(cert_path), Some(key_path)) = (&config.tls_cert_path, &config.tls_key_path) {
        let certificate = tokio::fs::read(cert_path)
            .await
            .with_context(|| format!("read TLS certificate {}", cert_path.display()))?;
        let private_key = tokio::fs::read(key_path)
            .await
            .with_context(|| format!("read TLS private key {}", key_path.display()))?;
        builder = builder
            .tls_config(
                ServerTlsConfig::new().identity(Identity::from_pem(certificate, private_key)),
            )
            .context("configure gRPC TLS")?;
    } else if !config.listen_addr.ip().is_loopback() {
        bail!("TLS is required when WUDANG_LISTEN_ADDR is not loopback");
    }

    info!(address = %config.listen_addr, "starting Wudang gRPC server");
    builder
        .add_service(AuthServiceServer::new(auth))
        .add_service(ChangeServiceServer::with_interceptor(
            changes,
            authentication.clone(),
        ))
        .add_service(CollaborationServiceServer::with_interceptor(
            collaboration,
            authentication.clone(),
        ))
        .add_service(RepositoryServiceServer::with_interceptor(
            repository,
            authentication.clone(),
        ))
        .add_service(SyncServiceServer::with_interceptor(sync, authentication))
        .add_service(reflection)
        .serve(config.listen_addr)
        .await
        .context("serve gRPC")?;
    Ok(())
}

pub fn storage_cipher(config: &ServerConfig) -> Result<EnvelopeCipher> {
    EnvelopeCipher::from_base64(&config.storage_key_id, &config.storage_key_base64)
        .context("configure storage encryption")
}

fn env_or(name: &str, default: &str) -> String {
    env::var(name).unwrap_or_else(|_| default.to_owned())
}

fn required_env(name: &str) -> Result<String> {
    env::var(name).with_context(|| format!("{name} is required"))
}

fn optional_path(name: &str) -> Option<PathBuf> {
    env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn env_bool(name: &str, default: bool) -> Result<bool> {
    match env::var(name) {
        Ok(value) => value
            .parse()
            .with_context(|| format!("{name} must be true or false")),
        Err(_) => Ok(default),
    }
}

fn env_parse<T>(name: &str, default: T) -> Result<T>
where
    T: std::str::FromStr,
    T::Err: std::error::Error + Send + Sync + 'static,
{
    match env::var(name) {
        Ok(value) => value
            .parse()
            .with_context(|| format!("{name} has an invalid value")),
        Err(_) => Ok(default),
    }
}

pub(crate) fn now_timestamp() -> prost_types::Timestamp {
    let now = chrono::Utc::now();
    prost_types::Timestamp {
        seconds: now.timestamp(),
        nanos: now.timestamp_subsec_nanos() as i32,
    }
}

pub(crate) fn datetime_timestamp(value: chrono::DateTime<chrono::Utc>) -> prost_types::Timestamp {
    prost_types::Timestamp {
        seconds: value.timestamp(),
        nanos: value.timestamp_subsec_nanos() as i32,
    }
}
