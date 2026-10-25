use chrono::{DateTime, Utc};
use sqlx::{PgPool, Row, postgres::PgPoolOptions};
use thiserror::Error;
use uuid::Uuid;
use wudang_crypto::EncryptedPayload;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("record not found")]
    NotFound,
    #[error("record already exists")]
    Conflict,
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("database migration failed: {0}")]
    Migration(#[from] sqlx::migrate::MigrateError),
}

#[derive(Clone)]
pub struct PgStore {
    pool: PgPool,
}

#[derive(Clone, Debug)]
pub struct UserRecord {
    pub user_id: Uuid,
    pub email: String,
    pub display_name: String,
    pub avatar_url: String,
    pub password_hash: String,
}

#[derive(Clone, Debug)]
pub struct SessionRecord {
    pub session_id: Uuid,
    pub user_id: Uuid,
    pub expires_at: DateTime<Utc>,
}

#[derive(Clone, Debug)]
pub struct RepositoryRecord {
    pub repository_id: Uuid,
    pub organization_id: Uuid,
    pub name: String,
    pub storage_key: String,
    pub default_branch: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug)]
pub struct EncryptedDeltaRecord {
    pub key_id: String,
    pub nonce: [u8; 12],
    pub ciphertext: Vec<u8>,
}

impl PgStore {
    pub async fn connect(database_url: &str, max_connections: u32) -> Result<Self, StoreError> {
        let pool = PgPoolOptions::new()
            .max_connections(max_connections)
            .connect(database_url)
            .await?;
        Ok(Self { pool })
    }

    pub fn from_pool(pool: PgPool) -> Self {
        Self { pool }
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub async fn migrate(&self) -> Result<(), StoreError> {
        sqlx::migrate!("../../migrations").run(&self.pool).await?;
        Ok(())
    }

    pub async fn create_local_user(
        &self,
        email: &str,
        display_name: &str,
        password_hash: &str,
    ) -> Result<UserRecord, StoreError> {
        let user_id = Uuid::new_v4();
        let normalized_email = normalize_email(email);
        let mut transaction = self.pool.begin().await?;

        let inserted = sqlx::query(
            r#"
            INSERT INTO users (user_id, email, display_name)
            VALUES ($1, $2, $3)
            ON CONFLICT (email) DO NOTHING
            RETURNING user_id
            "#,
        )
        .bind(user_id)
        .bind(&normalized_email)
        .bind(display_name)
        .fetch_optional(&mut *transaction)
        .await?;
        if inserted.is_none() {
            return Err(StoreError::Conflict);
        }

        sqlx::query(
            r#"
            INSERT INTO local_credentials (user_id, password_hash)
            VALUES ($1, $2)
            "#,
        )
        .bind(user_id)
        .bind(password_hash)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;

        Ok(UserRecord {
            user_id,
            email: normalized_email,
            display_name: display_name.to_owned(),
            avatar_url: String::new(),
            password_hash: password_hash.to_owned(),
        })
    }

    pub async fn local_user_by_email(&self, email: &str) -> Result<UserRecord, StoreError> {
        let row = sqlx::query(
            r#"
            SELECT u.user_id, u.email, u.display_name, u.avatar_url, c.password_hash
            FROM users u
            JOIN local_credentials c ON c.user_id = u.user_id
            WHERE u.email = $1
            "#,
        )
        .bind(normalize_email(email))
        .fetch_optional(&self.pool)
        .await?
        .ok_or(StoreError::NotFound)?;
        user_from_row(&row)
    }

    pub async fn user_by_id(&self, user_id: Uuid) -> Result<UserRecord, StoreError> {
        let row = sqlx::query(
            r#"
            SELECT u.user_id, u.email, u.display_name, u.avatar_url,
                   COALESCE(c.password_hash, '') AS password_hash
            FROM users u
            LEFT JOIN local_credentials c ON c.user_id = u.user_id
            WHERE u.user_id = $1
            "#,
        )
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or(StoreError::NotFound)?;
        user_from_row(&row)
    }

    pub async fn create_session(
        &self,
        user_id: Uuid,
        refresh_token_hash: &[u8],
        device_id: &str,
        device_name: &str,
        expires_at: DateTime<Utc>,
    ) -> Result<SessionRecord, StoreError> {
        let session_id = Uuid::new_v4();
        sqlx::query(
            r#"
            INSERT INTO sessions (
                session_id, user_id, refresh_token_hash, device_id, device_name, expires_at
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            "#,
        )
        .bind(session_id)
        .bind(user_id)
        .bind(refresh_token_hash)
        .bind(device_id)
        .bind(device_name)
        .bind(expires_at)
        .execute(&self.pool)
        .await?;
        Ok(SessionRecord {
            session_id,
            user_id,
            expires_at,
        })
    }

    pub async fn rotate_session_by_refresh_hash(
        &self,
        previous_refresh_token_hash: &[u8],
        new_refresh_token_hash: &[u8],
        expires_at: DateTime<Utc>,
    ) -> Result<SessionRecord, StoreError> {
        let row = sqlx::query(
            r#"
            UPDATE sessions
            SET refresh_token_hash = $2, expires_at = $3, rotated_at = now()
            WHERE refresh_token_hash = $1
              AND revoked_at IS NULL
              AND expires_at > now()
            RETURNING session_id, user_id, expires_at
            "#,
        )
        .bind(previous_refresh_token_hash)
        .bind(new_refresh_token_hash)
        .bind(expires_at)
        .fetch_optional(&self.pool)
        .await?
        .ok_or(StoreError::NotFound)?;
        Ok(SessionRecord {
            session_id: row.try_get("session_id")?,
            user_id: row.try_get("user_id")?,
            expires_at: row.try_get("expires_at")?,
        })
    }

    pub async fn revoke_session_by_refresh_hash(
        &self,
        refresh_token_hash: &[u8],
    ) -> Result<bool, StoreError> {
        let result = sqlx::query(
            r#"
            UPDATE sessions
            SET revoked_at = now()
            WHERE refresh_token_hash = $1 AND revoked_at IS NULL
            "#,
        )
        .bind(refresh_token_hash)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn create_repository(
        &self,
        organization_id: Uuid,
        name: &str,
        storage_key: &str,
        default_branch: &str,
    ) -> Result<RepositoryRecord, StoreError> {
        let repository_id = Uuid::new_v4();
        let row = sqlx::query(
            r#"
            INSERT INTO repositories (
                repository_id, organization_id, name, provider, storage_key, default_branch
            )
            VALUES ($1, $2, $3, 'wudang', $4, $5)
            ON CONFLICT (organization_id, name) DO NOTHING
            RETURNING created_at
            "#,
        )
        .bind(repository_id)
        .bind(organization_id)
        .bind(name)
        .bind(storage_key)
        .bind(default_branch)
        .fetch_optional(&self.pool)
        .await?
        .ok_or(StoreError::Conflict)?;
        Ok(RepositoryRecord {
            repository_id,
            organization_id,
            name: name.to_owned(),
            storage_key: storage_key.to_owned(),
            default_branch: default_branch.to_owned(),
            created_at: row.try_get("created_at")?,
        })
    }

    pub async fn repository_by_id(
        &self,
        repository_id: Uuid,
    ) -> Result<RepositoryRecord, StoreError> {
        let row = sqlx::query(
            r#"
            SELECT repository_id, organization_id, name, storage_key, default_branch, created_at
            FROM repositories
            WHERE repository_id = $1 AND deleted_at IS NULL
            "#,
        )
        .bind(repository_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or(StoreError::NotFound)?;
        repository_from_row(&row)
    }

    pub async fn list_repositories(
        &self,
        organization_id: Uuid,
        limit: i64,
        after: Option<Uuid>,
    ) -> Result<Vec<RepositoryRecord>, StoreError> {
        let rows = sqlx::query(
            r#"
            SELECT repository_id, organization_id, name, storage_key, default_branch, created_at
            FROM repositories
            WHERE organization_id = $1
              AND deleted_at IS NULL
              AND ($2::uuid IS NULL OR repository_id > $2)
            ORDER BY repository_id
            LIMIT $3
            "#,
        )
        .bind(organization_id)
        .bind(after)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(repository_from_row).collect()
    }

    pub async fn append_encrypted_delta(
        &self,
        document_id: &str,
        replica_id: &str,
        sequence: i64,
        payload: &EncryptedPayload,
    ) -> Result<bool, StoreError> {
        let result = sqlx::query(
            r#"
            INSERT INTO collab_deltas (
                document_id, replica_id, sequence, key_id, nonce, ciphertext
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (document_id, replica_id, sequence) DO NOTHING
            "#,
        )
        .bind(document_id)
        .bind(replica_id)
        .bind(sequence)
        .bind(&payload.key_id)
        .bind(payload.nonce.as_slice())
        .bind(&payload.ciphertext)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn encrypted_deltas(
        &self,
        document_id: &str,
    ) -> Result<Vec<EncryptedDeltaRecord>, StoreError> {
        let rows = sqlx::query(
            r#"
            SELECT key_id, nonce, ciphertext
            FROM collab_deltas
            WHERE document_id = $1
            ORDER BY created_at, replica_id, sequence
            "#,
        )
        .bind(document_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                let nonce: Vec<u8> = row.try_get("nonce")?;
                let nonce = nonce.try_into().map_err(|_| {
                    StoreError::Database(sqlx::Error::Protocol(
                        "collaboration nonce is not 12 bytes".to_owned(),
                    ))
                })?;
                Ok(EncryptedDeltaRecord {
                    key_id: row.try_get("key_id")?,
                    nonce,
                    ciphertext: row.try_get("ciphertext")?,
                })
            })
            .collect()
    }
}

fn user_from_row(row: &sqlx::postgres::PgRow) -> Result<UserRecord, StoreError> {
    Ok(UserRecord {
        user_id: row.try_get("user_id")?,
        email: row.try_get("email")?,
        display_name: row.try_get("display_name")?,
        avatar_url: row.try_get("avatar_url")?,
        password_hash: row.try_get("password_hash")?,
    })
}

fn repository_from_row(row: &sqlx::postgres::PgRow) -> Result<RepositoryRecord, StoreError> {
    Ok(RepositoryRecord {
        repository_id: row.try_get("repository_id")?,
        organization_id: row.try_get("organization_id")?,
        name: row.try_get("name")?,
        storage_key: row.try_get("storage_key")?,
        default_branch: row.try_get("default_branch")?,
        created_at: row.try_get("created_at")?,
    })
}

fn normalize_email(email: &str) -> String {
    email.trim().to_lowercase()
}
