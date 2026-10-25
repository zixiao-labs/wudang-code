use tonic::{Request, Response, Status};
use uuid::Uuid;
use wudang_persistence::{RepositoryRecord, StoreError};
use wudang_protocol::repository::{
    CreateHostedRepositoryRequest, GetRepositoryRequest, ListRepositoriesRequest,
    ListRepositoriesResponse, Repository, RepositoryProvider,
    repository_service_server::RepositoryService,
};

use crate::{AppState, datetime_timestamp};

#[derive(Clone)]
pub struct RepositoryGrpc {
    state: AppState,
}

impl RepositoryGrpc {
    pub fn new(state: AppState) -> Self {
        Self { state }
    }

    async fn message(&self, record: RepositoryRecord) -> Result<Repository, Status> {
        let storage_key = record.storage_key.clone();
        let git = self.state.git.clone();
        let info = tokio::task::spawn_blocking(move || git.info(&storage_key))
            .await
            .map_err(|_| Status::internal("Git storage task failed"))?
            .map_err(|_| Status::internal("hosted Git repository is unavailable"))?;
        Ok(Repository {
            repository_id: record.repository_id.to_string(),
            organization_id: record.organization_id.to_string(),
            name: record.name,
            provider: RepositoryProvider::Wudang as i32,
            default_branch: record.default_branch,
            clone_url: info.clone_url,
            empty: info.empty,
            created_at: Some(datetime_timestamp(record.created_at)),
        })
    }
}

#[tonic::async_trait]
impl RepositoryService for RepositoryGrpc {
    async fn create_hosted_repository(
        &self,
        request: Request<CreateHostedRepositoryRequest>,
    ) -> Result<Response<Repository>, Status> {
        let request = request.into_inner();
        let organization_id = Uuid::parse_str(&request.organization_id)
            .map_err(|_| Status::invalid_argument("organization_id must be a UUID"))?;
        validate_name(&request.name)?;
        let default_branch = if request.default_branch.is_empty() {
            "main".to_owned()
        } else {
            request.default_branch
        };
        let storage_key = Uuid::new_v4().to_string();
        let git = self.state.git.clone();
        let create_storage_key = storage_key.clone();
        let create_branch = default_branch.clone();
        tokio::task::spawn_blocking(move || git.create_bare(&create_storage_key, &create_branch))
            .await
            .map_err(|_| Status::internal("Git storage task failed"))?
            .map_err(|error| Status::internal(format!("create Git repository: {error}")))?;

        let record = match self
            .state
            .store
            .create_repository(
                organization_id,
                &request.name,
                &storage_key,
                &default_branch,
            )
            .await
        {
            Ok(record) => record,
            Err(error) => {
                let git = self.state.git.clone();
                let rollback_key = storage_key.clone();
                let _ =
                    tokio::task::spawn_blocking(move || git.remove_if_empty(&rollback_key)).await;
                return Err(store_status(error));
            }
        };
        Ok(Response::new(self.message(record).await?))
    }

    async fn get_repository(
        &self,
        request: Request<GetRepositoryRequest>,
    ) -> Result<Response<Repository>, Status> {
        let repository_id = Uuid::parse_str(&request.into_inner().repository_id)
            .map_err(|_| Status::invalid_argument("repository_id must be a UUID"))?;
        let record = self
            .state
            .store
            .repository_by_id(repository_id)
            .await
            .map_err(store_status)?;
        Ok(Response::new(self.message(record).await?))
    }

    async fn list_repositories(
        &self,
        request: Request<ListRepositoriesRequest>,
    ) -> Result<Response<ListRepositoriesResponse>, Status> {
        let request = request.into_inner();
        let organization_id = Uuid::parse_str(&request.organization_id)
            .map_err(|_| Status::invalid_argument("organization_id must be a UUID"))?;
        let page_size = request.page_size.clamp(1, 100) as i64;
        let after = if request.page_token.is_empty() {
            None
        } else {
            Some(
                Uuid::parse_str(&request.page_token)
                    .map_err(|_| Status::invalid_argument("page_token is invalid"))?,
            )
        };
        let records = self
            .state
            .store
            .list_repositories(organization_id, page_size + 1, after)
            .await
            .map_err(store_status)?;
        let has_more = records.len() > page_size as usize;
        let selected = records.into_iter().take(page_size as usize);
        let mut repositories = Vec::new();
        for record in selected {
            repositories.push(self.message(record).await?);
        }
        let next_page_token = if has_more {
            repositories
                .last()
                .map(|repository| repository.repository_id.clone())
                .unwrap_or_default()
        } else {
            String::new()
        };
        Ok(Response::new(ListRepositoriesResponse {
            repositories,
            next_page_token,
        }))
    }
}

fn validate_name(name: &str) -> Result<(), Status> {
    if name.is_empty()
        || name.len() > 100
        || name.starts_with('.')
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(Status::invalid_argument("repository name is invalid"));
    }
    Ok(())
}

fn store_status(error: StoreError) -> Status {
    match error {
        StoreError::NotFound => Status::not_found("repository not found"),
        StoreError::Conflict => Status::already_exists("repository already exists"),
        StoreError::Database(_) | StoreError::Migration(_) => {
            Status::internal("database operation failed")
        }
    }
}
