use chrono::{Duration, TimeZone as _, Utc};
use tonic::{Request, Response, Status};
use uuid::Uuid;
use wudang_crypto::{hash_refresh_token, issue_refresh_token};
use wudang_persistence::{StoreError, UserRecord};
use wudang_protocol::auth::{
    BeginOAuthRequest, BeginOAuthResponse, CompleteOAuthRequest, GetCurrentUserRequest,
    LoginLocalRequest, RefreshSessionRequest, RegisterLocalRequest, RevokeSessionRequest,
    RevokeSessionResponse, Session, User, auth_service_server::AuthService,
};

use crate::{AppState, datetime_timestamp};

#[derive(Clone)]
pub struct AuthGrpc {
    state: AppState,
}

impl AuthGrpc {
    pub fn new(state: AppState) -> Self {
        Self { state }
    }

    async fn create_session(
        &self,
        user: UserRecord,
        client: Option<wudang_protocol::auth::ClientInfo>,
    ) -> Result<Session, Status> {
        let refresh_token = issue_refresh_token();
        let refresh_hash = hash_refresh_token(&refresh_token, self.state.refresh_pepper.as_slice());
        let refresh_expires_at = Utc::now() + Duration::days(self.state.refresh_ttl_days);
        let client = client.unwrap_or_default();
        let stored_session = self
            .state
            .store
            .create_session(
                user.user_id,
                &refresh_hash,
                &client.device_id,
                &client.device_name,
                refresh_expires_at,
            )
            .await
            .map_err(store_status)?;
        let (access_token, claims) = self
            .state
            .jwt
            .issue(
                user.user_id.to_string(),
                stored_session.session_id.to_string(),
            )
            .map_err(|_| Status::internal("failed to issue access token"))?;
        let access_expires_at = Utc
            .timestamp_opt(claims.exp as i64, 0)
            .single()
            .ok_or_else(|| Status::internal("access token expiry is invalid"))?;

        Ok(Session {
            session_id: stored_session.session_id.to_string(),
            access_token,
            refresh_token,
            token_type: "Bearer".to_owned(),
            access_token_expires_at: Some(datetime_timestamp(access_expires_at)),
            user: Some(user_message(user)),
        })
    }
}

#[tonic::async_trait]
impl AuthService for AuthGrpc {
    async fn register_local(
        &self,
        request: Request<RegisterLocalRequest>,
    ) -> Result<Response<Session>, Status> {
        if !self.state.allow_local_registration {
            return Err(Status::permission_denied(
                "local account registration is disabled",
            ));
        }
        let request = request.into_inner();
        validate_email(&request.email)?;
        validate_password(&request.password)?;
        if request.display_name.trim().is_empty() {
            return Err(Status::invalid_argument("display_name is required"));
        }

        let password = request.password;
        let password_service = self.state.password.clone();
        let password_hash = tokio::task::spawn_blocking(move || password_service.hash(&password))
            .await
            .map_err(|_| Status::internal("password hashing task failed"))?
            .map_err(|_| Status::internal("password hashing failed"))?;
        let user = self
            .state
            .store
            .create_local_user(&request.email, request.display_name.trim(), &password_hash)
            .await
            .map_err(store_status)?;
        Ok(Response::new(
            self.create_session(user, request.client).await?,
        ))
    }

    async fn login_local(
        &self,
        request: Request<LoginLocalRequest>,
    ) -> Result<Response<Session>, Status> {
        let request = request.into_inner();
        validate_email(&request.email)?;
        let user = self
            .state
            .store
            .local_user_by_email(&request.email)
            .await
            .map_err(|_| Status::unauthenticated("invalid credentials"))?;
        let password = request.password;
        let encoded_hash = user.password_hash.clone();
        let password_service = self.state.password.clone();
        let verified =
            tokio::task::spawn_blocking(move || password_service.verify(&password, &encoded_hash))
                .await
                .map_err(|_| Status::internal("password verification task failed"))?
                .map_err(|_| Status::unauthenticated("invalid credentials"))?;
        if !verified {
            return Err(Status::unauthenticated("invalid credentials"));
        }
        Ok(Response::new(
            self.create_session(user, request.client).await?,
        ))
    }

    async fn begin_o_auth(
        &self,
        _request: Request<BeginOAuthRequest>,
    ) -> Result<Response<BeginOAuthResponse>, Status> {
        Err(Status::unimplemented(
            "OAuth provider adapters are not configured",
        ))
    }

    async fn complete_o_auth(
        &self,
        _request: Request<CompleteOAuthRequest>,
    ) -> Result<Response<Session>, Status> {
        Err(Status::unimplemented(
            "OAuth provider adapters are not configured",
        ))
    }

    async fn refresh_session(
        &self,
        request: Request<RefreshSessionRequest>,
    ) -> Result<Response<Session>, Status> {
        let request = request.into_inner();
        let previous_hash =
            hash_refresh_token(&request.refresh_token, self.state.refresh_pepper.as_slice());
        let refresh_token = issue_refresh_token();
        let refresh_hash = hash_refresh_token(&refresh_token, self.state.refresh_pepper.as_slice());
        let refresh_expires_at = Utc::now() + Duration::days(self.state.refresh_ttl_days);
        let session = self
            .state
            .store
            .rotate_session_by_refresh_hash(&previous_hash, &refresh_hash, refresh_expires_at)
            .await
            .map_err(|_| Status::unauthenticated("refresh token is invalid"))?;
        let user = self
            .state
            .store
            .user_by_id(session.user_id)
            .await
            .map_err(store_status)?;

        let (access_token, claims) = self
            .state
            .jwt
            .issue(user.user_id.to_string(), session.session_id.to_string())
            .map_err(|_| Status::internal("failed to issue access token"))?;

        Ok(Response::new(Session {
            session_id: session.session_id.to_string(),
            access_token,
            refresh_token,
            token_type: "Bearer".to_owned(),
            access_token_expires_at: Some(prost_types::Timestamp {
                seconds: claims.exp as i64,
                nanos: 0,
            }),
            user: Some(user_message(user)),
        }))
    }

    async fn revoke_session(
        &self,
        request: Request<RevokeSessionRequest>,
    ) -> Result<Response<RevokeSessionResponse>, Status> {
        let request = request.into_inner();
        let refresh_hash =
            hash_refresh_token(&request.refresh_token, self.state.refresh_pepper.as_slice());
        let revoked = self
            .state
            .store
            .revoke_session_by_refresh_hash(&refresh_hash)
            .await
            .map_err(store_status)?;
        Ok(Response::new(RevokeSessionResponse { revoked }))
    }

    async fn get_current_user(
        &self,
        request: Request<GetCurrentUserRequest>,
    ) -> Result<Response<User>, Status> {
        let token = bearer_token(request.metadata())?;
        let claims = self
            .state
            .jwt
            .verify(token)
            .map_err(|_| Status::unauthenticated("access token is invalid"))?;
        let user_id = Uuid::parse_str(&claims.sub)
            .map_err(|_| Status::unauthenticated("access token subject is invalid"))?;
        let user = self
            .state
            .store
            .user_by_id(user_id)
            .await
            .map_err(store_status)?;
        Ok(Response::new(user_message(user)))
    }
}

fn user_message(user: UserRecord) -> User {
    User {
        user_id: user.user_id.to_string(),
        display_name: user.display_name,
        avatar_url: user.avatar_url,
        external_identities: Vec::new(),
        email: user.email,
    }
}

fn bearer_token(metadata: &tonic::metadata::MetadataMap) -> Result<&str, Status> {
    let authorization = metadata
        .get("authorization")
        .ok_or_else(|| Status::unauthenticated("authorization metadata is required"))?
        .to_str()
        .map_err(|_| Status::unauthenticated("authorization metadata is invalid"))?;
    authorization
        .strip_prefix("Bearer ")
        .ok_or_else(|| Status::unauthenticated("Bearer token is required"))
}

fn validate_email(email: &str) -> Result<(), Status> {
    let email = email.trim();
    if email.len() > 320 || !email.contains('@') {
        return Err(Status::invalid_argument("email is invalid"));
    }
    Ok(())
}

fn validate_password(password: &str) -> Result<(), Status> {
    if !(12..=256).contains(&password.len()) {
        return Err(Status::invalid_argument(
            "password must be between 12 and 256 bytes",
        ));
    }
    Ok(())
}

fn store_status(error: StoreError) -> Status {
    match error {
        StoreError::NotFound => Status::not_found("record not found"),
        StoreError::Conflict => Status::already_exists("record already exists"),
        StoreError::Database(_) | StoreError::Migration(_) => {
            Status::internal("database operation failed")
        }
    }
}
