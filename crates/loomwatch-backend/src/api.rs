//! REST surface consumed by the `LoomWatch` web UI.

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use axum::extract::{Query, State};
use axum::http::StatusCode;
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
pub fn router() -> Router {
    router_with_path(std::env::var_os("PATH"))
}

/// Build the REST router with an explicit executable search path.
///
/// Keeping the search path in router state makes harness discovery deterministic in tests
/// and avoids mutating the process environment.
pub fn router_with_path(search_path: Option<OsString>) -> Router {
    Router::new()
        .route("/api/harnesses", get(get_harnesses))
        .route("/api/team", get(get_team).put(put_team))
        .route("/api/config/schema", get(get_config_schema))
        .with_state(ApiState { search_path })
}

async fn get_harnesses(State(state): State<ApiState>) -> Json<Vec<DetectedHarness>> {
    Json(detect_harnesses(state.search_path.as_deref()))
}

async fn get_team(Query(query): Query<TeamPath>) -> Result<Json<TeamFile>, ApiError> {
    let yaml = fs::read_to_string(&query.path).map_err(|error| {
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

async fn put_team(Json(team_file): Json<TeamFile>) -> Result<Json<TeamFile>, ApiError> {
    TeamConfig::parse(&team_file.yaml)
        .map_err(|error| ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, error.to_string()))?;
    fs::write(&team_file.path, team_file.yaml.as_bytes()).map_err(|error| {
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

        let response = router_with_path(Some(search_path))
            .oneshot(
                Request::builder()
                    .uri("/api/harnesses")
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
        let response = router_with_path(None)
            .oneshot(
                Request::builder()
                    .uri("/api/config/schema")
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

        let response = router_with_path(None)
            .oneshot(
                Request::builder()
                    .uri(format!("/api/team?{query}"))
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response_json(response).await["yaml"], VALID_TEAM);
    }

    #[tokio::test]
    async fn team_endpoint_saves_valid_yaml_byte_for_byte() {
        let directory = TempDirectory::new();
        let path = directory.0.join("team.yaml");
        let body = serde_json::to_vec(&TeamFile {
            path: path.clone(),
            yaml: VALID_TEAM.to_owned(),
        })
        .expect("serialize request");

        let response = router_with_path(None)
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/team")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body))
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            fs::read_to_string(path).expect("read saved file"),
            VALID_TEAM
        );
        assert_eq!(response_json(response).await["yaml"], VALID_TEAM);
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

        let response = router_with_path(None)
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/team")
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
