use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use git2::{ErrorCode, Repository};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum GitStoreError {
    #[error("hosted Git storage must be placed on an encrypted volume")]
    EncryptionRequired,
    #[error("invalid repository storage key")]
    InvalidStorageKey,
    #[error("repository already exists")]
    AlreadyExists,
    #[error("repository does not exist")]
    NotFound,
    #[error("filesystem error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Git operation failed: {0}")]
    Git(#[from] git2::Error),
}

#[derive(Clone, Debug)]
pub struct GitRepositoryInfo {
    pub storage_key: String,
    pub path: PathBuf,
    pub clone_url: String,
    pub empty: bool,
}

#[derive(Clone)]
pub struct GitStore {
    inner: Arc<GitStoreInner>,
}

struct GitStoreInner {
    root: PathBuf,
    public_base_url: Option<String>,
}

impl GitStore {
    pub fn new(
        root: impl Into<PathBuf>,
        public_base_url: Option<String>,
        require_encrypted_volume: bool,
        volume_is_encrypted: bool,
    ) -> Result<Self, GitStoreError> {
        if require_encrypted_volume && !volume_is_encrypted {
            return Err(GitStoreError::EncryptionRequired);
        }
        let root = root.into();
        fs::create_dir_all(&root)?;
        Ok(Self {
            inner: Arc::new(GitStoreInner {
                root,
                public_base_url: public_base_url.filter(|value| !value.is_empty()),
            }),
        })
    }

    pub fn create_bare(
        &self,
        storage_key: &str,
        default_branch: &str,
    ) -> Result<GitRepositoryInfo, GitStoreError> {
        validate_storage_key(storage_key)?;
        validate_branch(default_branch)?;
        let path = self.repository_path(storage_key);
        if path.exists() {
            return Err(GitStoreError::AlreadyExists);
        }

        fs::create_dir(&path)?;
        let initialized = (|| -> Result<(), GitStoreError> {
            let repository = Repository::init_bare(&path)?;
            repository.set_head(&format!("refs/heads/{default_branch}"))?;
            let mut config = repository.config()?;
            config.set_bool("receive.denyNonFastForwards", true)?;
            config.set_bool("http.receivepack", true)?;
            Ok(())
        })();
        if let Err(error) = initialized {
            let _ = fs::remove_dir_all(&path);
            return Err(error);
        }

        self.info(storage_key)
    }

    pub fn info(&self, storage_key: &str) -> Result<GitRepositoryInfo, GitStoreError> {
        validate_storage_key(storage_key)?;
        let path = self.repository_path(storage_key);
        if !path.exists() {
            return Err(GitStoreError::NotFound);
        }
        let repository = Repository::open_bare(&path)?;
        let clone_url = self
            .inner
            .public_base_url
            .as_ref()
            .map(|base| format!("{}/{}.git", base.trim_end_matches('/'), storage_key))
            .unwrap_or_default();
        Ok(GitRepositoryInfo {
            storage_key: storage_key.to_owned(),
            path,
            clone_url,
            empty: repository_is_empty(&repository)?,
        })
    }

    pub fn remove_if_empty(&self, storage_key: &str) -> Result<bool, GitStoreError> {
        let info = self.info(storage_key)?;
        if !info.empty {
            return Ok(false);
        }
        fs::remove_dir_all(info.path)?;
        Ok(true)
    }

    pub fn root(&self) -> &Path {
        &self.inner.root
    }

    fn repository_path(&self, storage_key: &str) -> PathBuf {
        self.inner.root.join(format!("{storage_key}.git"))
    }
}

fn repository_is_empty(repository: &Repository) -> Result<bool, GitStoreError> {
    match repository.head() {
        Ok(head) => Ok(head.target().is_none()),
        Err(error) if matches!(error.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound) => {
            Ok(true)
        }
        Err(error) => Err(error.into()),
    }
}

fn validate_storage_key(storage_key: &str) -> Result<(), GitStoreError> {
    if storage_key.is_empty()
        || storage_key.len() > 128
        || !storage_key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(GitStoreError::InvalidStorageKey);
    }
    Ok(())
}

fn validate_branch(branch: &str) -> Result<(), GitStoreError> {
    if branch.is_empty()
        || branch.starts_with('-')
        || branch.contains("..")
        || branch.contains("@{")
        || branch
            .bytes()
            .any(|byte| byte.is_ascii_whitespace() || b"~^:\\?[*".contains(&byte))
    {
        return Err(GitStoreError::InvalidStorageKey);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_standard_bare_repository() {
        let directory = tempfile::tempdir().unwrap();
        let store = GitStore::new(directory.path(), None, false, false).unwrap();
        let info = store.create_bare("repo-1", "main").unwrap();

        assert!(info.empty);
        assert!(Repository::open_bare(info.path).is_ok());
    }

    #[test]
    fn enforces_encrypted_volume_policy() {
        let directory = tempfile::tempdir().unwrap();
        let result = GitStore::new(directory.path(), None, true, false);
        assert!(matches!(result, Err(GitStoreError::EncryptionRequired)));
    }
}
