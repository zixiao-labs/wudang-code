use std::sync::Arc;

use anyhow::Result;
use tracing_subscriber::EnvFilter;
use wudang_api::{ServerConfig, build_state, serve, storage_cipher};
use wudang_blob_store::PortableBlobStore;

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();
    let config = ServerConfig::from_env()?;
    let blobs =
        Arc::new(PortableBlobStore::new(&config.blob_root, storage_cipher(&config)?).await?);
    let state = build_state(&config, blobs).await?;
    serve(config, state).await
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("wudang=info,tonic=info"));
    tracing_subscriber::fmt().with_env_filter(filter).init();
}
