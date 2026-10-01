//! The Notebook's REST surface: read a team's notes, keep/correct/retire them, move packs.
//!
//! Loopback-only, the same as run control, because notes are exact run evidence before they are
//! anything else.
//!
//! **Why this is not part of `GET /api/memory`.** The Brief half of the memory API lives in
//! `api.rs`, whose router is built from a teams root and no database — a team's Brief is Markdown
//! on disk and reading it must not depend on Postgres being up. The Notebook is rows. Axum cannot
//! route one path from two routers, so the two halves are sibling paths (`/api/memory` and
//! `/api/memory/notes`) rather than one endpoint that is half-broken whenever the archive is
//! disabled. The UI reads both and presents one panel.

use std::path::{Path, PathBuf};

use axum::Json;
use axum::Router;
use axum::extract::rejection::JsonRejection;
use axum::extract::{Path as RoutePath, Query, State};
use axum::http::StatusCode;
use axum::middleware;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::api::{ApiError, resolve_existing_team_path};
use crate::archive::EventArchive;
use crate::config::{KeepPolicy, TeamConfig};
use crate::memory::{
    MemoryRoots, Note, NoteFilter, NoteKind, NoteRevision, NoteState, OPERATOR_ACTOR, Pack,
    PackNote, TeamMemory,
};
use crate::watch_api::{ARCHIVE_DISABLED_MESSAGE, local_evidence};

#[derive(Clone)]
struct NotebookState {
    archive: Option<EventArchive>,
    teams_root: PathBuf,
}

/// Build the Notebook router. `teams_root` must be the same canonical root every other surface
/// uses, so a team the editor can open is exactly a team whose notes can be read.
pub fn router(archive: Option<EventArchive>, teams_root: PathBuf) -> Router {
    let teams_root = std::fs::canonicalize(&teams_root).unwrap_or(teams_root);
    Router::new()
        .route("/api/memory/notes", get(list_notes))
        .route("/api/memory/notes/{id}/history", get(note_history))
        .route("/api/memory/notes/{id}/keep", post(keep_note))
        .route("/api/memory/notes/{id}/correct", post(correct_note))
        .route("/api/memory/notes/{id}/retire", post(retire_note))
        .route("/api/memory/packs", post(move_pack))
        .route_layer(middleware::from_fn(local_evidence))
        .with_state(NotebookState {
            archive,
            teams_root,
        })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotesQuery {
    /// The team file, relative to the teams root. Named `team` here and `path` on
    /// `GET /api/memory`; both are accepted on both, so a client can use one spelling.
    #[serde(alias = "path")]
    team: PathBuf,
    #[serde(default)]
    run: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    state: Option<String>,
}

/// One team's notebook, plus what it inherits and cannot write.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NotebookView {
    /// The memory scope: the team's `id`, or its file stem when it declares none.
    team_id: String,
    /// `false` when the team has no enabled `memory:` block, or `memory.notebook.enabled: false`.
    /// Every list is then empty, and the panel says the Notebook is off rather than empty.
    enabled: bool,
    keep: &'static str,
    notes: Vec<Note>,
    /// Kept notes of the teams this team inherits. Read-only: every one of these is another
    /// team's, and this team can neither correct nor retire it.
    inherited: Vec<Note>,
    inherited_teams: Vec<String>,
}

async fn list_notes(
    State(state): State<NotebookState>,
    Query(query): Query<NotesQuery>,
) -> Result<Json<NotebookView>, ApiError> {
    let (archive, scope) = state.scope(&query.team)?;
    let filter = NoteFilter {
        kind: query.kind.as_deref().map(parse_kind).transpose()?,
        state: query.state.as_deref().map(parse_state).transpose()?,
        run_id: query.run.clone(),
    };
    let notebook = archive.notebook();
    let (notes, inherited) = if scope.enabled {
        (
            notebook
                .list(&scope.team_id, &filter)
                .await
                .map_err(unprocessable)?,
            notebook
                .kept_for_teams(&scope.inherited_teams)
                .await
                .map_err(unprocessable)?,
        )
    } else {
        (Vec::new(), Vec::new())
    };
    Ok(Json(NotebookView {
        team_id: scope.team_id,
        enabled: scope.enabled,
        keep: match scope.keep {
            KeepPolicy::Review => "review",
            KeepPolicy::Never => "never",
        },
        notes,
        inherited,
        inherited_teams: scope.inherited_teams,
    }))
}

async fn note_history(
    State(state): State<NotebookState>,
    RoutePath(id): RoutePath<String>,
    Query(query): Query<NotesQuery>,
) -> Result<Json<Vec<Note>>, ApiError> {
    let (archive, scope) = state.scope(&query.team)?;
    let history = archive
        .notebook()
        .history(&scope.team_id, &id)
        .await
        .map_err(unprocessable)?;
    if history.is_empty() {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            format!("note {id} is not in this team's notebook."),
        ));
    }
    Ok(Json(history))
}

/// The body every revision action shares: which team, and the revision the panel was showing.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviseRequest {
    #[serde(alias = "path")]
    team: PathBuf,
    /// The revision the operator was looking at. Optional, and when present it is the optimistic
    /// concurrency check: a panel that had gone stale is told so rather than silently overwriting
    /// a correction someone else made.
    #[serde(default)]
    revision: Option<i32>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    body: Option<String>,
}

async fn keep_note(
    State(state): State<NotebookState>,
    RoutePath(id): RoutePath<String>,
    body: Result<Json<ReviseRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    revise(&state, &id, body, |_| NoteRevision::Keep).await
}

async fn retire_note(
    State(state): State<NotebookState>,
    RoutePath(id): RoutePath<String>,
    body: Result<Json<ReviseRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    revise(&state, &id, body, |_| NoteRevision::Retire).await
}

async fn correct_note(
    State(state): State<NotebookState>,
    RoutePath(id): RoutePath<String>,
    body: Result<Json<ReviseRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    revise(&state, &id, body, |request| NoteRevision::Correct {
        title: request.title.clone(),
        body: request.body.clone(),
    })
    .await
}

async fn revise(
    state: &NotebookState,
    id: &str,
    body: Result<Json<ReviseRequest>, JsonRejection>,
    // A function pointer, not a closure trait object: the handler's future has to be `Send`, and
    // `&dyn Fn` is not.
    change: fn(&ReviseRequest) -> NoteRevision,
) -> Result<Response, ApiError> {
    let Json(request) = body.map_err(|rejection| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("invalid request: {}", rejection.body_text()),
        )
    })?;
    let (archive, scope) = state.scope(&request.team)?;
    if !scope.enabled {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "this team has no enabled memory.notebook block, so it has no notes to change."
                .to_owned(),
        ));
    }
    let change = change(&request);
    // `memory.notebook.keep: never` is a policy the team file states, and until now it was carried
    // and read by nothing: Keep was still offered, and the daemon would still have accepted it. A
    // policy the server does not enforce is a comment. Correct and Retire stay available — they
    // are about this run's record, not about what outlives it.
    if matches!(change, NoteRevision::Keep) && scope.keep == KeepPolicy::Never {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "this team's memory.notebook.keep is `never`, so a note cannot be kept for future \
             runs. Change the team file to `review` first."
                .to_owned(),
        ));
    }
    let note = archive
        .notebook()
        .revise(
            &scope.team_id,
            id,
            request.revision,
            OPERATOR_ACTOR,
            &change,
        )
        .await
        // A refused revision is almost always a stale panel or an already-applied action, which
        // is a conflict rather than a server fault. The message is the store's own, verbatim,
        // because it already names the revision the operator needs.
        .map_err(|error| ApiError::new(StatusCode::CONFLICT, error.message))?;
    Ok((StatusCode::OK, Json(note)).into_response())
}

/// Export this team's memory as a pack, or import one that is already under the teams root.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackRequest {
    #[serde(alias = "path")]
    team: PathBuf,
    /// `export` writes `<name>.memory/` beside the teams root; `import` reads one and copies its
    /// kept notes into this team's scope.
    action: String,
    /// Export only: what to call the pack. Defaults to the team's own name.
    #[serde(default)]
    name: Option<String>,
    /// Import only: the pack folder, relative to the teams root.
    #[serde(default)]
    pack: Option<PathBuf>,
}

async fn move_pack(
    State(state): State<NotebookState>,
    body: Result<Json<PackRequest>, JsonRejection>,
) -> Result<Response, ApiError> {
    let Json(request) = body.map_err(|rejection| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("invalid pack request: {}", rejection.body_text()),
        )
    })?;
    let (archive, scope) = state.scope(&request.team)?;
    match request.action.as_str() {
        "export" => {
            let notes = archive
                .notebook()
                .list(
                    &scope.team_id,
                    &NoteFilter {
                        state: Some(NoteState::Kept),
                        ..NoteFilter::default()
                    },
                )
                .await
                .map_err(unprocessable)?;
            let pack_notes: Vec<PackNote> = notes.iter().map(PackNote::from).collect();
            let name = request.name.unwrap_or_else(|| scope.team_id.clone());
            // The team's own Brief only. Re-exporting what this team inherited would make the
            // pack claim authorship of another team's writing.
            let folder = Pack::export(
                &state.teams_root,
                &scope.team_id,
                &name,
                &scope.memory.brief,
                &pack_notes,
            )
            .map_err(unprocessable)?;
            Ok((
                StatusCode::CREATED,
                Json(json!({
                    "pack": folder.to_string_lossy(),
                    "originTeamId": scope.team_id,
                    "brief": scope.memory.brief.len(),
                    "notes": pack_notes.len(),
                })),
            )
                .into_response())
        }
        "import" => {
            let pack = request.pack.ok_or_else(|| {
                ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "an import needs `pack`: the folder under the teams root to read.".to_owned(),
                )
            })?;
            let loaded = Pack::load(&state.teams_root, &pack).map_err(unprocessable)?;
            let imported = archive
                .notebook()
                .import_kept(
                    &scope.team_id,
                    &loaded.manifest.origin_team_id,
                    &loaded.notes,
                )
                .await
                .map_err(unprocessable)?;
            Ok((
                StatusCode::OK,
                Json(json!({
                    "pack": pack.to_string_lossy(),
                    "originTeamId": loaded.manifest.origin_team_id,
                    "name": loaded.manifest.name,
                    "brief": loaded.brief.len(),
                    "notes": loaded.notes.len(),
                    "imported": imported,
                    // The Brief half is not copied: it is pinned by referencing the pack from
                    // `memory.inherits`, which is a team-file edit the operator reviews and saves.
                    "next": "Add the pack to memory.inherits to pin its Brief."
                })),
            )
                .into_response())
        }
        other => Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("pack action {other:?} is not one of: export, import"),
        )),
    }
}

/// A team's memory scope, resolved from its file.
struct Scope {
    team_id: String,
    enabled: bool,
    keep: KeepPolicy,
    inherited_teams: Vec<String>,
    memory: TeamMemory,
}

impl NotebookState {
    fn scope(&self, team: &Path) -> Result<(EventArchive, Scope), ApiError> {
        let archive = self.archive.clone().ok_or_else(|| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                ARCHIVE_DISABLED_MESSAGE.to_owned(),
            )
        })?;
        let resolved = resolve_existing_team_path(&self.teams_root, team)?;
        let config = TeamConfig::load(&resolved).map_err(|error| {
            ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                format!("failed to read team file {}: {error:#}", team.display()),
            )
        })?;
        let roots = MemoryRoots::for_team(&resolved, Some(&self.teams_root));
        let memory = TeamMemory::load(&roots, &resolved, config.memory.as_ref())
            .map_err(|error| ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, error.message))?;
        Ok((
            archive,
            Scope {
                team_id: crate::memory::scope_id(&config.id, &resolved),
                enabled: memory.notebook_enabled,
                keep: memory.keep_policy,
                inherited_teams: memory.inherited_teams.clone(),
                memory,
            },
        ))
    }
}

fn parse_kind(value: &str) -> Result<NoteKind, ApiError> {
    NoteKind::parse(value).map_err(|error| ApiError::new(StatusCode::BAD_REQUEST, error.message))
}

fn parse_state(value: &str) -> Result<NoteState, ApiError> {
    NoteState::parse(value).map_err(|error| ApiError::new(StatusCode::BAD_REQUEST, error.message))
}

fn unprocessable(error: crate::memory::MemoryError) -> ApiError {
    ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, error.message)
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{Request, header};
    use http_body_util::BodyExt as _;
    use tower::ServiceExt as _;

    use super::*;
    use crate::memory::{NoteKind, NoteWrite};

    /// `memory.notebook.keep: never` was loaded, served and read by nothing: Keep was still
    /// offered and the daemon would still have accepted it. A policy the server does not enforce
    /// is a comment.
    ///
    /// Correct and Retire stay available under the same policy — they change this run's record,
    /// not what outlives it — and the second half of this test is what makes the first half mean
    /// something.
    #[sqlx::test(migrations = "../../migrations")]
    async fn keep_is_refused_when_the_team_file_says_never(pool: sqlx::PgPool) {
        let root = std::env::temp_dir().join(format!("loomwatch-keep-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("root");
        let root = std::fs::canonicalize(&root).expect("canonical root");
        let team = |name: &str, keep: &str| {
            std::fs::write(
                root.join(name),
                format!(
                    "schemaVersion: 1\nid: {id}\nname: {id}\nentrypoint: a\nmemory:\n  notebook:\n    enabled: true\n    keep: {keep}\nagents:\n  - id: a\n    name: A\n    role: r\n    spawn:\n      cmd: /bin/sh\n      args: []\n      cwd: .\n    model: m\n    budget:\n      limitUsd: 1\n",
                    id = name.trim_end_matches(".yaml"),
                ),
            )
            .expect("write team");
        };
        team("locked.yaml", "never");
        team("open.yaml", "review");

        let archive = EventArchive::from_pool(pool);
        let app = router(Some(archive.clone()), root.clone());
        let note = |team_id: &str, key: &str| NoteWrite {
            team_id: team_id.to_owned(),
            run_id: "run-1".to_owned(),
            author_agent_id: "a".to_owned(),
            kind: NoteKind::Finding,
            title: "codex-acp auto-approves".to_owned(),
            body: "Observed on this machine.".to_owned(),
            sources: Vec::new(),
            idempotency_key: key.to_owned(),
        };
        let locked = archive
            .notebook()
            .write(&note("locked", "k1"))
            .await
            .expect("write");
        let open = archive
            .notebook()
            .write(&note("open", "k2"))
            .await
            .expect("write");

        let post = |uri: String, team: &str| {
            Request::builder()
                .method("POST")
                .uri(uri)
                .header("host", "localhost")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "team": team }).to_string()))
                .expect("request")
        };

        let refused = app
            .clone()
            .oneshot(post(
                format!("/api/memory/notes/{}/keep", locked.id),
                "locked.yaml",
            ))
            .await
            .expect("response");
        assert_eq!(refused.status(), StatusCode::CONFLICT);
        let body: serde_json::Value =
            serde_json::from_slice(&refused.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert!(
            body["error"]
                .as_str()
                .unwrap_or_default()
                .contains("is `never`"),
            "{body}"
        );
        assert_eq!(
            archive
                .notebook()
                .list("locked", &NoteFilter::default())
                .await
                .expect("list")[0]
                .state,
            NoteState::Active,
            "the refusal changed nothing"
        );

        // Retire is still allowed under `never`: it is about this run's record.
        let retired = app
            .clone()
            .oneshot(post(
                format!("/api/memory/notes/{}/retire", locked.id),
                "locked.yaml",
            ))
            .await
            .expect("response");
        assert_eq!(retired.status(), StatusCode::OK);

        // Counterfactual: the same request against a team whose policy is `review` is accepted.
        let allowed = app
            .oneshot(post(
                format!("/api/memory/notes/{}/keep", open.id),
                "open.yaml",
            ))
            .await
            .expect("response");
        assert_eq!(allowed.status(), StatusCode::OK);
        let _ = std::fs::remove_dir_all(&root);
    }
}
