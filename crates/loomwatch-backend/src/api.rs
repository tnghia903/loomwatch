//! REST surface consumed by the `LoomWatch` web UI.

use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use axum::extract::{Query, Request, State};
use axum::http::{StatusCode, header, uri::Authority};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::config::TeamConfig;

const TEAM_SCHEMA: &str = include_str!("../../../schemas/team.schema.yaml");

#[derive(Debug, Clone)]
struct ApiState {
    search_path: Option<OsString>,
    teams_root: PathBuf,
    allowed_hosts: Vec<String>,
}

#[derive(Debug, Clone, Copy)]
struct HarnessSpec {
    id: &'static str,
    name: &'static str,
    command: &'static str,
    acp_command: &'static str,
    acp_args: &'static [&'static str],
}

const HARNESSES: &[HarnessSpec] = &[
    HarnessSpec {
        id: "claude",
        name: "Claude",
        command: "claude",
        acp_command: "claude-agent-acp",
        acp_args: &[],
    },
    HarnessSpec {
        id: "codex",
        name: "Codex",
        command: "codex",
        acp_command: "codex-acp",
        acp_args: &[],
    },
    HarnessSpec {
        id: "gemini",
        name: "Gemini",
        command: "gemini",
        acp_command: "gemini",
        acp_args: &["--acp"],
    },
    HarnessSpec {
        id: "opencode",
        name: "OpenCode",
        command: "opencode",
        acp_command: "opencode",
        acp_args: &["acp"],
    },
];

/// One supported harness detected on the daemon's `PATH`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedHarness {
    pub id: String,
    pub name: String,
    pub command: String,
    pub executable_path: String,
    pub spawn: HarnessSpawn,
}

/// Spawn descriptor the UI can copy into a new team agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HarnessSpawn {
    pub cmd: String,
    pub args: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct TeamPath {
    path: PathBuf,
}

/// A byte-preserving team-file representation used for both load and save.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamFile {
    pub path: PathBuf,
    pub yaml: String,
}

/// Build the REST router using the daemon process's `PATH`.
///
/// # Errors
///
/// Returns an error when `teams_root` cannot be canonicalized.
pub fn router(teams_root: PathBuf, allowed_hosts: Vec<String>) -> io::Result<Router> {
    router_with_path(teams_root, allowed_hosts, std::env::var_os("PATH"))
}

/// Build the REST router with an explicit executable search path.
///
/// Keeping the search path in router state makes harness discovery deterministic in tests
/// and avoids mutating the process environment.
///
/// # Errors
///
/// Returns an error when `teams_root` cannot be canonicalized.
pub fn router_with_path(
    teams_root: PathBuf,
    allowed_hosts: Vec<String>,
    search_path: Option<OsString>,
) -> io::Result<Router> {
    let state = ApiState {
        search_path,
        teams_root: fs::canonicalize(teams_root)?,
        allowed_hosts: allowed_hosts
            .into_iter()
            .map(|host| normalize_hostname(&host))
            .filter(|host| !host.is_empty())
            .collect(),
    };
    Ok(Router::new()
        .route("/api/harnesses", get(get_harnesses))
        .route("/api/team", get(get_team).put(put_team))
        .route("/api/config/schema", get(get_config_schema))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            enforce_allowed_host,
        ))
        .with_state(state))
}

async fn enforce_allowed_host(
    State(state): State<ApiState>,
    request: Request,
    next: Next,
) -> Response {
    let allowed = request
        .uri()
        .authority()
        .cloned()
        .or_else(|| {
            request
                .headers()
                .get(header::HOST)
                .and_then(|host| host.to_str().ok())
                .and_then(|host| host.parse::<Authority>().ok())
        })
        .map(|authority| normalize_hostname(authority.host()))
        .is_some_and(|host| state.allowed_hosts.iter().any(|allowed| allowed == &host));

    if !allowed {
        return ApiError::new(StatusCode::FORBIDDEN, "host is not allowed".to_owned())
            .into_response();
    }
    next.run(request).await
}

fn normalize_hostname(host: &str) -> String {
    let host = host.trim().trim_end_matches('.');
    host.strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or(host)
        .to_ascii_lowercase()
}

async fn get_harnesses(State(state): State<ApiState>) -> Json<Vec<DetectedHarness>> {
    Json(detect_harnesses(state.search_path.as_deref()))
}

async fn get_team(
    State(state): State<ApiState>,
    Query(query): Query<TeamPath>,
) -> Result<Json<TeamFile>, ApiError> {
    let resolved_path = resolve_existing_team_path(&state.teams_root, &query.path)?;
    let yaml = fs::read_to_string(&resolved_path).map_err(|error| {
        let status = if error.kind() == std::io::ErrorKind::NotFound {
            StatusCode::NOT_FOUND
        } else {
            StatusCode::INTERNAL_SERVER_ERROR
        };
        ApiError::new(
            status,
            format!("failed to read team file {}: {error}", query.path.display()),
        )
    })?;
    Ok(Json(TeamFile {
        path: query.path,
        yaml,
    }))
}

async fn put_team(
    State(state): State<ApiState>,
    Json(team_file): Json<TeamFile>,
) -> Result<Json<TeamFile>, ApiError> {
    TeamConfig::parse(&team_file.yaml)
        .map_err(|error| ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, error.to_string()))?;
    let resolved_path = resolve_writable_team_path(&state.teams_root, &team_file.path)?;
    atomic_write(&resolved_path, team_file.yaml.as_bytes()).map_err(|error| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!(
                "failed to write team file {}: {error}",
                team_file.path.display()
            ),
        )
    })?;
    Ok(Json(team_file))
}

fn resolve_existing_team_path(teams_root: &Path, requested: &Path) -> Result<PathBuf, ApiError> {
    let candidate = rooted_candidate(teams_root, requested);
    let resolved = fs::canonicalize(&candidate).map_err(|error| {
        let status = if error.kind() == io::ErrorKind::NotFound {
            StatusCode::NOT_FOUND
        } else {
            StatusCode::BAD_REQUEST
        };
        ApiError::new(
            status,
            format!(
                "failed to resolve team file {}: {error}",
                requested.display()
            ),
        )
    })?;
    ensure_under_teams_root(teams_root, requested, resolved)
}

fn resolve_writable_team_path(teams_root: &Path, requested: &Path) -> Result<PathBuf, ApiError> {
    let candidate = rooted_candidate(teams_root, requested);
    match fs::symlink_metadata(&candidate) {
        Ok(_) => {
            let resolved = fs::canonicalize(&candidate).map_err(|error| {
                ApiError::new(
                    StatusCode::BAD_REQUEST,
                    format!(
                        "failed to resolve team file {}: {error}",
                        requested.display()
                    ),
                )
            })?;
            ensure_under_teams_root(teams_root, requested, resolved)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let file_name = candidate.file_name().ok_or_else(|| {
                ApiError::new(
                    StatusCode::BAD_REQUEST,
                    format!("team path {} has no file name", requested.display()),
                )
            })?;
            let parent = candidate.parent().ok_or_else(|| {
                ApiError::new(
                    StatusCode::BAD_REQUEST,
                    format!("team path {} has no parent", requested.display()),
                )
            })?;
            let resolved_parent = fs::canonicalize(parent).map_err(|error| {
                ApiError::new(
                    StatusCode::BAD_REQUEST,
                    format!(
                        "failed to resolve parent of team file {}: {error}",
                        requested.display()
                    ),
                )
            })?;
            ensure_under_teams_root(teams_root, requested, resolved_parent.join(file_name))
        }
        Err(error) => Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            format!(
                "failed to inspect team file {}: {error}",
                requested.display()
            ),
        )),
    }
}

fn rooted_candidate(teams_root: &Path, requested: &Path) -> PathBuf {
    if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        teams_root.join(requested)
    }
}

fn ensure_under_teams_root(
    teams_root: &Path,
    requested: &Path,
    resolved: PathBuf,
) -> Result<PathBuf, ApiError> {
    if resolved.starts_with(teams_root) && resolved != teams_root {
        Ok(resolved)
    } else {
        Err(ApiError::new(
            StatusCode::FORBIDDEN,
            format!(
                "team path {} resolves outside the configured teams root",
                requested.display()
            ),
        ))
    }
}

/// Replace `path` without ever exposing a partially written team file.
///
/// The temporary file lives beside the destination so the final rename stays on one
/// filesystem and is atomic. Syncing it before the rename also prevents a successful
/// response from referring to bytes that are still only in userspace buffers.
fn atomic_write(path: &Path, contents: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let file_name = path.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "team file path has no file name",
        )
    })?;
    let temporary_path = parent.join(format!(
        ".{}.{}.tmp",
        file_name.to_string_lossy(),
        uuid::Uuid::new_v4()
    ));

    let result = (|| {
        let mut temporary_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)?;
        if let Ok(metadata) = fs::metadata(path) {
            temporary_file.set_permissions(metadata.permissions())?;
        }
        temporary_file.write_all(contents)?;
        temporary_file.sync_all()?;
        drop(temporary_file);
        fs::rename(&temporary_path, path)
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    result
}

async fn get_config_schema() -> Result<Json<Value>, ApiError> {
    let schema = serde_yaml::from_str(TEAM_SCHEMA).map_err(|error| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("embedded team schema is invalid: {error}"),
        )
    })?;
    Ok(Json(schema))
}

/// Scan a `PATH` value for the four supported vendor CLIs.
#[must_use]
pub fn detect_harnesses(search_path: Option<&std::ffi::OsStr>) -> Vec<DetectedHarness> {
    let Some(search_path) = search_path else {
        return Vec::new();
    };
    HARNESSES
        .iter()
        .filter_map(|spec| {
            find_executable(search_path, spec.command).map(|path| DetectedHarness {
                id: spec.id.to_owned(),
                name: spec.name.to_owned(),
                command: spec.command.to_owned(),
                executable_path: path.to_string_lossy().into_owned(),
                spawn: HarnessSpawn {
                    cmd: spec.acp_command.to_owned(),
                    args: spec.acp_args.iter().map(|arg| (*arg).to_owned()).collect(),
                },
            })
        })
        .collect()
}

fn find_executable(search_path: &std::ffi::OsStr, command: &str) -> Option<PathBuf> {
    std::env::split_paths(search_path)
        .flat_map(|directory| executable_candidates(&directory, command))
        .find(|candidate| is_executable(candidate))
}

#[cfg(not(windows))]
fn executable_candidates(directory: &Path, command: &str) -> Vec<PathBuf> {
    vec![directory.join(command)]
}

#[cfg(windows)]
fn executable_candidates(directory: &Path, command: &str) -> Vec<PathBuf> {
    let extensions =
        std::env::var_os("PATHEXT").unwrap_or_else(|| OsString::from(".COM;.EXE;.BAT;.CMD"));
    extensions
        .to_string_lossy()
        .split(';')
        .filter(|extension| !extension.is_empty())
        .map(|extension| directory.join(format!("{command}{extension}")))
        .collect()
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    fs::metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, message: String) -> Self {
        Self { status, message }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use axum::body::Body;
    use axum::http::{Request, header};
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    use uuid::Uuid;

    use super::*;

    const VALID_TEAM: &str = "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: opencode\n      cwd: .\n    model: test/model\n    budget:\n      limitUsd: 1\n";

    struct TempDirectory(PathBuf);

    impl TempDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("loomwatch-api-{}", Uuid::new_v4()));
            fs::create_dir(&path).expect("create temporary directory");
            Self(path)
        }
    }

    impl Drop for TempDirectory {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).expect("remove temporary directory");
        }
    }

    fn create_executable(directory: &Path, name: &str) {
        let path = directory.join(name);
        let mut file = fs::File::create(&path).expect("create executable");
        file.write_all(b"#!/bin/sh\n").expect("write executable");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o755))
                .expect("set executable bit");
        }
    }

    fn test_router(teams_root: &Path) -> Router {
        test_router_with_path(teams_root, None)
    }

    fn test_router_with_path(teams_root: &Path, search_path: Option<OsString>) -> Router {
        router_with_path(
            teams_root.to_path_buf(),
            vec!["localhost".to_owned()],
            search_path,
        )
        .expect("build API router")
    }

    async fn response_json(response: Response) -> Value {
        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("collect response body")
            .to_bytes();
        serde_json::from_slice(&bytes).expect("JSON response")
    }

    #[tokio::test]
    async fn harness_endpoint_scans_path_in_catalog_order() {
        let first = TempDirectory::new();
        let second = TempDirectory::new();
        create_executable(&first.0, "opencode");
        create_executable(&second.0, "claude");
        fs::write(first.0.join("codex"), b"not executable").expect("write non-executable");
        let search_path = std::env::join_paths([&first.0, &second.0]).expect("join search path");

        let response = test_router_with_path(&first.0, Some(search_path))
            .oneshot(
                Request::builder()
                    .uri("/api/harnesses")
                    .header(header::HOST, "localhost")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response_json(response).await,
            json!([
                {
                    "id": "claude",
                    "name": "Claude",
                    "command": "claude",
                    "executablePath": second.0.join("claude").to_string_lossy(),
                    "spawn": {"cmd": "claude-agent-acp", "args": []}
                },
                {
                    "id": "opencode",
                    "name": "OpenCode",
                    "command": "opencode",
                    "executablePath": first.0.join("opencode").to_string_lossy(),
                    "spawn": {"cmd": "opencode", "args": ["acp"]}
                }
            ])
        );
    }

    #[tokio::test]
    async fn schema_endpoint_returns_the_embedded_schema_as_json() {
        let directory = TempDirectory::new();
        let response = test_router(&directory.0)
            .oneshot(
                Request::builder()
                    .uri("/api/config/schema")
                    .header(header::HOST, "localhost")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        let schema = response_json(response).await;
        assert_eq!(
            schema["$id"],
            "https://loomwatch.dev/schemas/team.schema.yaml"
        );
        assert_eq!(schema["properties"]["schemaVersion"]["const"], 1);
    }

    #[tokio::test]
    async fn team_endpoint_loads_yaml_without_reformatting() {
        let directory = TempDirectory::new();
        let path = directory.0.join("team file.yaml");
        fs::write(&path, VALID_TEAM).expect("write team file");
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("path", path.to_str().expect("UTF-8 path"))
            .finish();

        let response = test_router(&directory.0)
            .oneshot(
                Request::builder()
                    .uri(format!("/api/team?{query}"))
                    .header(header::HOST, "localhost")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response_json(response).await["yaml"], VALID_TEAM);
    }

    #[tokio::test]
    async fn team_endpoint_atomically_replaces_valid_yaml_byte_for_byte() {
        let directory = TempDirectory::new();
        let path = directory.0.join("team.yaml");
        fs::write(&path, "old contents\n").expect("write original file");
        let body = serde_json::to_vec(&TeamFile {
            path: path.clone(),
            yaml: VALID_TEAM.to_owned(),
        })
        .expect("serialize request");

        let response = test_router(&directory.0)
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/team")
                    .header(header::HOST, "localhost")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            fs::read_to_string(&path).expect("read saved file"),
            VALID_TEAM
        );
        let entries = fs::read_dir(&directory.0)
            .expect("read team directory")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect team directory");
        assert_eq!(entries.len(), 1, "temporary file should be renamed away");
        assert_eq!(entries[0].path(), path);
        assert_eq!(response_json(response).await["yaml"], VALID_TEAM);
    }

    #[tokio::test]
    async fn team_endpoint_rejects_parent_traversal_outside_root() {
        let directory = TempDirectory::new();
        let teams_root = directory.0.join("teams");
        fs::create_dir(&teams_root).expect("create teams root");
        let outside_path = directory.0.join("outside.yaml");
        fs::write(&outside_path, "do not replace").expect("write outside file");
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("path", "../outside.yaml")
            .finish();
        let get_response = test_router(&teams_root)
            .oneshot(
                Request::builder()
                    .uri(format!("/api/team?{query}"))
                    .header(header::HOST, "localhost")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(get_response.status(), StatusCode::FORBIDDEN);

        let body = serde_json::to_vec(&TeamFile {
            path: PathBuf::from("../outside.yaml"),
            yaml: VALID_TEAM.to_owned(),
        })
        .expect("serialize request");

        let response = test_router(&teams_root)
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/team")
                    .header(header::HOST, "localhost")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body))
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            fs::read_to_string(outside_path).expect("read outside file"),
            "do not replace"
        );
    }

    #[tokio::test]
    async fn team_endpoint_rejects_absolute_path_outside_root() {
        let directory = TempDirectory::new();
        let teams_root = directory.0.join("teams");
        fs::create_dir(&teams_root).expect("create teams root");
        let outside_path = directory.0.join("outside.yaml");
        fs::write(&outside_path, VALID_TEAM).expect("write outside file");
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("path", outside_path.to_str().expect("UTF-8 path"))
            .finish();

        let response = test_router(&teams_root)
            .oneshot(
                Request::builder()
                    .uri(format!("/api/team?{query}"))
                    .header(header::HOST, "localhost")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        let body = serde_json::to_vec(&TeamFile {
            path: outside_path.clone(),
            yaml: VALID_TEAM.to_owned(),
        })
        .expect("serialize request");
        let put_response = test_router(&teams_root)
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/team")
                    .header(header::HOST, "localhost")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(put_response.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            fs::read_to_string(outside_path).expect("read outside file"),
            VALID_TEAM
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn team_endpoint_rejects_symlink_escape_after_resolution() {
        use std::os::unix::fs::symlink;

        let directory = TempDirectory::new();
        let teams_root = directory.0.join("teams");
        fs::create_dir(&teams_root).expect("create teams root");
        let outside_path = directory.0.join("outside.yaml");
        fs::write(&outside_path, "do not replace").expect("write outside file");
        let link_path = teams_root.join("team.yaml");
        symlink(&outside_path, &link_path).expect("create symlink");
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("path", link_path.to_str().expect("UTF-8 path"))
            .finish();

        let get_response = test_router(&teams_root)
            .oneshot(
                Request::builder()
                    .uri(format!("/api/team?{query}"))
                    .header(header::HOST, "localhost")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(get_response.status(), StatusCode::FORBIDDEN);

        let body = serde_json::to_vec(&TeamFile {
            path: link_path,
            yaml: VALID_TEAM.to_owned(),
        })
        .expect("serialize request");
        let put_response = test_router(&teams_root)
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/team")
                    .header(header::HOST, "localhost")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(put_response.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            fs::read_to_string(outside_path).expect("read outside file"),
            "do not replace"
        );
    }

    #[tokio::test]
    async fn api_rejects_a_host_outside_the_allowlist() {
        let directory = TempDirectory::new();
        let response = test_router(&directory.0)
            .oneshot(
                Request::builder()
                    .uri("/api/config/schema")
                    .header(header::HOST, "rebound.example:3000")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn invalid_save_does_not_replace_the_existing_file() {
        let directory = TempDirectory::new();
        let path = directory.0.join("team.yaml");
        fs::write(&path, VALID_TEAM).expect("write original team");
        let body = serde_json::to_vec(&TeamFile {
            path: path.clone(),
            yaml: "schemaVersion: 2\n".to_owned(),
        })
        .expect("serialize request");

        let response = test_router(&directory.0)
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/team")
                    .header(header::HOST, "localhost")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            fs::read_to_string(path).expect("read original file"),
            VALID_TEAM
        );
        assert!(
            response_json(response).await["error"]
                .as_str()
                .is_some_and(|error| error.contains("invalid team YAML"))
        );
    }
}
