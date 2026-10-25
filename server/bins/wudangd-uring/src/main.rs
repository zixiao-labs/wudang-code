use anyhow::{Result, bail};

#[cfg(target_os = "linux")]
use std::sync::Arc;
#[cfg(target_os = "linux")]
use tracing_subscriber::EnvFilter;
#[cfg(target_os = "linux")]
use wudang_api::{ServerConfig, build_state, serve, storage_cipher};
#[cfg(target_os = "linux")]
use wudang_blob_store::UringBlobStore;

#[cfg(target_os = "linux")]
#[tokio::main]
async fn main() -> Result<()> {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("wudang=info,tonic=info"));
    tracing_subscriber::fmt().with_env_filter(filter).init();

    let config = ServerConfig::from_env()?;
    let worker_count = std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1);
    let blobs = Arc::new(UringBlobStore::new(
        &config.blob_root,
        storage_cipher(&config)?,
        worker_count,
    )?);
    let state = build_state(&config, blobs).await?;
    serve(config, state).await
}

#[cfg(not(target_os = "linux"))]
fn main() -> Result<()> {
    bail!("wudangd-uring requires Linux kernel 5.10 or newer")
}
