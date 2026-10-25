use std::sync::Arc;

use dashmap::DashMap;
use tonic::{Request, Response, Status};
use uuid::Uuid;
use wudang_protocol::changes::{
    ApplyPatchRequest, ApplyPatchResponse, ChangeSet, CreateReviewCommentRequest, DiffStats,
    FileChange, FileChangeKind, GetChangeSetRequest, PatchPreview, PreviewPatchRequest,
    ResolveReviewCommentRequest, ReviewComment, change_service_server::ChangeService,
};

use crate::{AppState, now_timestamp};

#[derive(Clone, Default)]
pub struct ChangeState {
    previews: Arc<DashMap<String, StoredPreview>>,
    changes: Arc<DashMap<String, ChangeSet>>,
    comments: Arc<DashMap<String, ReviewComment>>,
}

#[derive(Clone)]
struct StoredPreview {
    workspace_id: String,
    expected_revision: u64,
    preview: PatchPreview,
}

#[derive(Clone)]
pub struct ChangeGrpc {
    state: AppState,
}

impl ChangeGrpc {
    pub fn new(state: AppState) -> Self {
        Self { state }
    }
}

#[tonic::async_trait]
impl ChangeService for ChangeGrpc {
    async fn preview_patch(
        &self,
        request: Request<PreviewPatchRequest>,
    ) -> Result<Response<PatchPreview>, Status> {
        let request = request.into_inner();
        if request.workspace_id.is_empty() {
            return Err(Status::invalid_argument("workspace_id is required"));
        }
        if request.unified_patch.is_empty() {
            return Err(Status::invalid_argument("unified_patch is required"));
        }
        let patch_id = Uuid::new_v4().to_string();
        let (files, stats, warnings) = summarize_patch(&request.unified_patch);
        let preview = PatchPreview {
            patch_id: patch_id.clone(),
            proposed_change_set: Some(ChangeSet {
                change_set_id: String::new(),
                workspace_id: request.workspace_id.clone(),
                base_revision: request.expected_revision,
                head_revision: request.expected_revision.saturating_add(1),
                base_commit_oid: String::new(),
                created_by_run_id: String::new(),
                files,
                stats: Some(stats),
                created_at: Some(now_timestamp()),
            }),
            warnings,
        };
        self.state.changes.previews.insert(
            patch_id,
            StoredPreview {
                workspace_id: request.workspace_id,
                expected_revision: request.expected_revision,
                preview: preview.clone(),
            },
        );
        Ok(Response::new(preview))
    }

    async fn apply_patch(
        &self,
        request: Request<ApplyPatchRequest>,
    ) -> Result<Response<ApplyPatchResponse>, Status> {
        let request = request.into_inner();
        let stored = self
            .state
            .changes
            .previews
            .get(&request.patch_id)
            .map(|value| value.clone())
            .ok_or_else(|| Status::not_found("patch preview not found"))?;
        if stored.workspace_id != request.workspace_id {
            return Err(Status::failed_precondition(
                "workspace does not match preview",
            ));
        }
        if stored.expected_revision != request.expected_revision {
            return Err(Status::aborted("workspace revision changed"));
        }
        let mut change_set = stored
            .preview
            .proposed_change_set
            .ok_or_else(|| Status::internal("patch preview is corrupt"))?;
        change_set.change_set_id = Uuid::new_v4().to_string();
        change_set.created_at = Some(now_timestamp());
        self.state
            .changes
            .changes
            .insert(change_set.change_set_id.clone(), change_set.clone());
        Ok(Response::new(ApplyPatchResponse {
            change_set: Some(change_set),
        }))
    }

    async fn get_change_set(
        &self,
        request: Request<GetChangeSetRequest>,
    ) -> Result<Response<ChangeSet>, Status> {
        let change_set_id = request.into_inner().change_set_id;
        let change_set = self
            .state
            .changes
            .changes
            .get(&change_set_id)
            .map(|value| value.clone())
            .ok_or_else(|| Status::not_found("change set not found"))?;
        Ok(Response::new(change_set))
    }

    async fn create_review_comment(
        &self,
        request: Request<CreateReviewCommentRequest>,
    ) -> Result<Response<ReviewComment>, Status> {
        let request = request.into_inner();
        let anchor = request
            .anchor
            .ok_or_else(|| Status::invalid_argument("anchor is required"))?;
        if request.markdown.trim().is_empty() {
            return Err(Status::invalid_argument("comment cannot be empty"));
        }
        if !self
            .state
            .changes
            .changes
            .contains_key(&anchor.change_set_id)
        {
            return Err(Status::not_found("change set not found"));
        }
        let comment = ReviewComment {
            comment_id: Uuid::new_v4().to_string(),
            anchor: Some(anchor),
            author_id: String::new(),
            markdown: request.markdown,
            resolved: false,
            created_at: Some(now_timestamp()),
            resolved_at: None,
        };
        self.state
            .changes
            .comments
            .insert(comment.comment_id.clone(), comment.clone());
        Ok(Response::new(comment))
    }

    async fn resolve_review_comment(
        &self,
        request: Request<ResolveReviewCommentRequest>,
    ) -> Result<Response<ReviewComment>, Status> {
        let request = request.into_inner();
        let mut comment = self
            .state
            .changes
            .comments
            .get_mut(&request.comment_id)
            .ok_or_else(|| Status::not_found("review comment not found"))?;
        comment.resolved = request.resolved;
        comment.resolved_at = request.resolved.then(now_timestamp);
        Ok(Response::new(comment.clone()))
    }
}

fn summarize_patch(patch: &str) -> (Vec<FileChange>, DiffStats, Vec<String>) {
    let mut files = Vec::new();
    let mut additions = 0_u32;
    let mut deletions = 0_u32;
    for line in patch.lines() {
        let (kind, path) = if let Some(path) = line.strip_prefix("*** Add File: ") {
            (FileChangeKind::Added, path)
        } else if let Some(path) = line.strip_prefix("*** Delete File: ") {
            (FileChangeKind::Deleted, path)
        } else if let Some(path) = line.strip_prefix("*** Update File: ") {
            (FileChangeKind::Modified, path)
        } else {
            if line.starts_with('+') && !line.starts_with("+++") {
                additions = additions.saturating_add(1);
            } else if line.starts_with('-') && !line.starts_with("---") {
                deletions = deletions.saturating_add(1);
            }
            continue;
        };
        files.push(FileChange {
            file_change_id: Uuid::new_v4().to_string(),
            file_id: path.to_owned(),
            kind: kind as i32,
            old_path: if kind == FileChangeKind::Added {
                String::new()
            } else {
                path.to_owned()
            },
            new_path: if kind == FileChangeKind::Deleted {
                String::new()
            } else {
                path.to_owned()
            },
            old_mode: String::new(),
            new_mode: String::new(),
            binary: false,
            hunks: Vec::new(),
        });
    }
    let warnings = if files.is_empty() {
        vec!["Patch contains no recognized file headers".to_owned()]
    } else {
        vec!["Hunks are materialized by the Workspace runner before application".to_owned()]
    };
    (
        files.clone(),
        DiffStats {
            files_changed: files.len() as u32,
            additions,
            deletions,
        },
        warnings,
    )
}
