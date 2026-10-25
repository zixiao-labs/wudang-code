use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use async_trait::async_trait;
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;
use wudang_crypto::{EncryptedPayload, EnvelopeCipher};

const MAGIC: &[u8; 4] = b"WDB1";

#[derive(Debug, Error)]
pub enum BlobStoreError {
    #[error("blob key cannot be empty")]
    EmptyKey,
    #[error("blob is corrupt")]
    Corrupt,
    #[error("blob I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("blob encryption failed: {0}")]
    Crypto(#[from] wudang_crypto::CryptoError),
    #[error("io_uring storage is supported only on Linux")]
    UringUnsupported,
    #[error("io_uring worker stopped")]
    WorkerStopped,
}

#[async_trait]
pub trait BlobStore: Send + Sync {
    async fn put(&self, key: &str, plaintext: &[u8]) -> Result<(), BlobStoreError>;
    async fn get(&self, key: &str) -> Result<Vec<u8>, BlobStoreError>;
}

#[derive(Clone)]
pub struct PortableBlobStore {
    root: Arc<PathBuf>,
    cipher: EnvelopeCipher,
}

impl PortableBlobStore {
    pub async fn new(
        root: impl Into<PathBuf>,
        cipher: EnvelopeCipher,
    ) -> Result<Self, BlobStoreError> {
        let root = root.into();
        tokio::fs::create_dir_all(&root).await?;
        Ok(Self {
            root: Arc::new(root),
            cipher,
        })
    }
}

#[async_trait]
impl BlobStore for PortableBlobStore {
    async fn put(&self, key: &str, plaintext: &[u8]) -> Result<(), BlobStoreError> {
        let path = blob_path(&self.root, key)?;
        let encrypted = self.cipher.seal(plaintext, key.as_bytes())?;
        let encoded = encode_payload(&encrypted)?;
        let temporary = path.with_extension(format!("tmp-{}", Uuid::new_v4()));
        tokio::fs::write(&temporary, encoded).await?;
        tokio::fs::rename(&temporary, &path).await?;
        Ok(())
    }

    async fn get(&self, key: &str) -> Result<Vec<u8>, BlobStoreError> {
        let encoded = tokio::fs::read(blob_path(&self.root, key)?).await?;
        let encrypted = decode_payload(&encoded)?;
        Ok(self.cipher.open(&encrypted, key.as_bytes())?)
    }
}

#[cfg(target_os = "linux")]
mod uring {
    use std::{
        sync::atomic::{AtomicUsize, Ordering},
        thread,
    };

    use tokio::sync::{mpsc, oneshot};

    use super::*;

    enum Command {
        Put {
            path: PathBuf,
            bytes: Vec<u8>,
            response: oneshot::Sender<Result<(), BlobStoreError>>,
        },
        Get {
            path: PathBuf,
            response: oneshot::Sender<Result<Vec<u8>, BlobStoreError>>,
        },
    }

    #[derive(Clone)]
    pub struct UringBlobStore {
        root: Arc<PathBuf>,
        cipher: EnvelopeCipher,
        workers: Arc<Vec<mpsc::UnboundedSender<Command>>>,
        next_worker: Arc<AtomicUsize>,
    }

    impl UringBlobStore {
        pub fn new(
            root: impl Into<PathBuf>,
            cipher: EnvelopeCipher,
            worker_count: usize,
        ) -> Result<Self, BlobStoreError> {
            let root = root.into();
            std::fs::create_dir_all(&root)?;
            let mut workers = Vec::with_capacity(worker_count.max(1));
            for index in 0..worker_count.max(1) {
                let (sender, mut receiver) = mpsc::unbounded_channel();
                let thread_name = format!("wudang-uring-{index}");
                thread::Builder::new().name(thread_name).spawn(move || {
                    tokio_uring::start(async move {
                        while let Some(command) = receiver.recv().await {
                            match command {
                                Command::Put {
                                    path,
                                    bytes,
                                    response,
                                } => {
                                    let result = write_atomic(path, bytes).await;
                                    let _ = response.send(result);
                                }
                                Command::Get { path, response } => {
                                    let result = read_all(path).await;
                                    let _ = response.send(result);
                                }
                            }
                        }
                    });
                })?;
                workers.push(sender);
            }
            Ok(Self {
                root: Arc::new(root),
                cipher,
                workers: Arc::new(workers),
                next_worker: Arc::new(AtomicUsize::new(0)),
            })
        }

        fn worker(&self) -> &mpsc::UnboundedSender<Command> {
            let index = self.next_worker.fetch_add(1, Ordering::Relaxed) % self.workers.len();
            &self.workers[index]
        }
    }

    #[async_trait]
    impl BlobStore for UringBlobStore {
        async fn put(&self, key: &str, plaintext: &[u8]) -> Result<(), BlobStoreError> {
            let encrypted = self.cipher.seal(plaintext, key.as_bytes())?;
            let bytes = encode_payload(&encrypted)?;
            let path = blob_path(&self.root, key)?;
            let (response, result) = oneshot::channel();
            self.worker()
                .send(Command::Put {
                    path,
                    bytes,
                    response,
                })
                .map_err(|_| BlobStoreError::WorkerStopped)?;
            result.await.map_err(|_| BlobStoreError::WorkerStopped)?
        }

        async fn get(&self, key: &str) -> Result<Vec<u8>, BlobStoreError> {
            let path = blob_path(&self.root, key)?;
            let (response, result) = oneshot::channel();
            self.worker()
                .send(Command::Get { path, response })
                .map_err(|_| BlobStoreError::WorkerStopped)?;
            let bytes = result.await.map_err(|_| BlobStoreError::WorkerStopped)??;
            let encrypted = decode_payload(&bytes)?;
            Ok(self.cipher.open(&encrypted, key.as_bytes())?)
        }
    }

    async fn write_atomic(path: PathBuf, bytes: Vec<u8>) -> Result<(), BlobStoreError> {
        let temporary = path.with_extension(format!("tmp-{}", Uuid::new_v4()));
        let file = tokio_uring::fs::File::create(&temporary).await?;
        let (result, _) = file.write_all_at(bytes, 0).await;
        result?;
        file.sync_all().await?;
        file.close().await?;
        tokio_uring::fs::rename(&temporary, &path).await?;
        Ok(())
    }

    async fn read_all(path: PathBuf) -> Result<Vec<u8>, BlobStoreError> {
        let file = tokio_uring::fs::File::open(path).await?;
        let size = file.statx().await?.stx_size as usize;
        let (result, bytes) = file.read_exact_at(Vec::with_capacity(size), 0).await;
        result?;
        file.close().await?;
        Ok(bytes)
    }
}

#[cfg(target_os = "linux")]
pub use uring::UringBlobStore;

#[cfg(not(target_os = "linux"))]
#[derive(Clone)]
pub struct UringBlobStore;

#[cfg(not(target_os = "linux"))]
impl UringBlobStore {
    pub fn new(
        _root: impl Into<PathBuf>,
        _cipher: EnvelopeCipher,
        _worker_count: usize,
    ) -> Result<Self, BlobStoreError> {
        Err(BlobStoreError::UringUnsupported)
    }
}

#[cfg(not(target_os = "linux"))]
#[async_trait]
impl BlobStore for UringBlobStore {
    async fn put(&self, _key: &str, _plaintext: &[u8]) -> Result<(), BlobStoreError> {
        Err(BlobStoreError::UringUnsupported)
    }

    async fn get(&self, _key: &str) -> Result<Vec<u8>, BlobStoreError> {
        Err(BlobStoreError::UringUnsupported)
    }
}

fn blob_path(root: &Path, key: &str) -> Result<PathBuf, BlobStoreError> {
    if key.is_empty() {
        return Err(BlobStoreError::EmptyKey);
    }
    let digest = Sha256::digest(key.as_bytes());
    Ok(root.join(hex_string(&digest)))
}

fn encode_payload(payload: &EncryptedPayload) -> Result<Vec<u8>, BlobStoreError> {
    let key_id = payload.key_id.as_bytes();
    let key_id_length: u16 = key_id
        .len()
        .try_into()
        .map_err(|_| BlobStoreError::Corrupt)?;
    let mut encoded =
        Vec::with_capacity(4 + 2 + key_id.len() + payload.nonce.len() + payload.ciphertext.len());
    encoded.extend_from_slice(MAGIC);
    encoded.extend_from_slice(&key_id_length.to_be_bytes());
    encoded.extend_from_slice(key_id);
    encoded.extend_from_slice(&payload.nonce);
    encoded.extend_from_slice(&payload.ciphertext);
    Ok(encoded)
}

fn decode_payload(encoded: &[u8]) -> Result<EncryptedPayload, BlobStoreError> {
    if encoded.len() < 18 || &encoded[..4] != MAGIC {
        return Err(BlobStoreError::Corrupt);
    }
    let key_id_length = u16::from_be_bytes([encoded[4], encoded[5]]) as usize;
    let nonce_start = 6 + key_id_length;
    let ciphertext_start = nonce_start + 12;
    if encoded.len() < ciphertext_start {
        return Err(BlobStoreError::Corrupt);
    }
    let key_id = std::str::from_utf8(&encoded[6..nonce_start])
        .map_err(|_| BlobStoreError::Corrupt)?
        .to_owned();
    let nonce = encoded[nonce_start..ciphertext_start]
        .try_into()
        .map_err(|_| BlobStoreError::Corrupt)?;
    Ok(EncryptedPayload {
        key_id,
        nonce,
        ciphertext: encoded[ciphertext_start..].to_vec(),
    })
}

fn hex_string(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

#[cfg(test)]
mod tests {
    use base64::{Engine as _, engine::general_purpose::STANDARD};

    use super::*;

    #[tokio::test]
    async fn portable_store_encrypts_and_round_trips() {
        let directory = tempfile::tempdir().unwrap();
        let cipher = EnvelopeCipher::from_base64("test-v1", &STANDARD.encode([11_u8; 32])).unwrap();
        let store = PortableBlobStore::new(directory.path(), cipher)
            .await
            .unwrap();

        store.put("artifact/one", b"private source").await.unwrap();
        let stored_path = std::fs::read_dir(directory.path())
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert!(
            !std::fs::read(&stored_path)
                .unwrap()
                .windows(b"private source".len())
                .any(|window| window == b"private source")
        );
        assert_eq!(store.get("artifact/one").await.unwrap(), b"private source");
    }
}
