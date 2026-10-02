//! Files the agents produced, as things the operator can open (ADR 0026).
//!
//! An agent that writes a report says so in its reply — usually as an absolute path. The UI turns
//! that path into a card; this module answers the two questions the card asks: *what is this file*
//! (`stat`) and *open it, or show it in its folder* (`open`).
//!
//! The boundary is the one every other file endpoint here uses: the configured teams root, which
//! holds the team files and the agents' managed workspaces (`.loomwatch/<team>/<agent>/`). A path
//! outside it is refused, so a page cannot use this daemon to probe or launch arbitrary files.
//! Opening is further limited to documents, media and data: the system's default app is launched
//! for those, never for a program, script or app bundle — those can still be shown in their folder.

use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::SystemTime;

use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::api::{ApiError, resolve_existing_team_path};

/// What the card shows about one file.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileFacts {
    /// The path as the caller asked for it, so the UI can match the answer to its request.
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) exists: bool,
    pub(crate) is_dir: bool,
    pub(crate) size_bytes: Option<u64>,
    pub(crate) modified_at: Option<String>,
    /// `document`, `spreadsheet`, `slides`, `pdf`, `image`, `media`, `markdown`, `text`, `web`,
    /// `data`, `archive`, `code`, `folder` or `file`.
    pub(crate) kind: &'static str,
    /// The containing folder relative to the teams root (`.loomwatch/team/agent`), for display.
    pub(crate) folder: Option<String>,
    /// The default app may be launched for it (`open` without `reveal`).
    pub(crate) openable: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenRequest {
    pub(crate) path: PathBuf,
    /// Show the file in its folder instead of opening it.
    #[serde(default)]
    pub(crate) reveal: bool,
}

const KINDS: &[(&str, &[&str])] = &[
    ("document", &["doc", "docx", "odt", "pages", "rtf"]),
    (
        "spreadsheet",
        &["xls", "xlsx", "ods", "numbers", "csv", "tsv"],
    ),
    ("slides", &["ppt", "pptx", "odp", "key"]),
    ("pdf", &["pdf"]),
    (
        "image",
        &[
            "png", "jpg", "jpeg", "gif", "webp", "svg", "heic", "tif", "tiff", "bmp",
        ],
    ),
    ("media", &["mp3", "wav", "m4a", "mp4", "mov", "webm"]),
    ("markdown", &["md", "markdown", "mdx"]),
    ("text", &["txt", "log"]),
    ("web", &["html", "htm"]),
    ("data", &["json", "yaml", "yml", "toml", "xml"]),
    ("archive", &["zip"]),
    (
        "code",
        &[
            "py", "js", "ts", "tsx", "jsx", "rs", "go", "java", "rb", "sh", "css", "sql",
        ],
    ),
];

/// Kinds the system's default app may be launched for. Code is excluded on purpose: on several
/// systems the default action for a script is to run it.
const OPENABLE_KINDS: &[&str] = &[
    "document",
    "spreadsheet",
    "slides",
    "pdf",
    "image",
    "media",
    "markdown",
    "text",
    "web",
    "data",
    "archive",
];

fn extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
}

pub(crate) fn kind_of(path: &Path, is_dir: bool) -> &'static str {
    if is_dir {
        return "folder";
    }
    let Some(ext) = extension(path) else {
        return "file";
    };
    KINDS
        .iter()
        .find(|(_, exts)| exts.contains(&ext.as_str()))
        .map_or("file", |(kind, _)| kind)
}

/// Folders open in the file manager; files only when their kind is a document, media or data.
pub(crate) fn openable(path: &Path, is_dir: bool) -> bool {
    is_dir || OPENABLE_KINDS.contains(&kind_of(path, false))
}

/// A path is inside the root without touching the disk: no `..`, and the root as its prefix.
fn lexically_under(root: &Path, requested: &Path) -> bool {
    let candidate = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        root.join(requested)
    };
    !candidate
        .components()
        .any(|part| matches!(part, Component::ParentDir))
        && candidate.starts_with(root)
        && candidate != root
}

fn folder_of(root: &Path, file: &Path) -> Option<String> {
    file.parent()
        .and_then(|parent| parent.strip_prefix(root).ok())
        .map(|relative| relative.to_string_lossy().into_owned())
}

fn iso(time: SystemTime) -> String {
    DateTime::<Utc>::from(time).to_rfc3339()
}

/// What a file is, or that it is gone. A path outside the teams root is refused either way.
pub(crate) fn stat(teams_root: &Path, requested: &Path) -> Result<FileFacts, ApiError> {
    let shown = requested.to_string_lossy().into_owned();
    let name = requested
        .file_name()
        .map_or_else(|| shown.clone(), |name| name.to_string_lossy().into_owned());
    match resolve_existing_team_path(teams_root, requested) {
        Ok(resolved) => {
            let metadata = std::fs::metadata(&resolved).map_err(|error| {
                ApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("failed to read {shown}: {error}"),
                )
            })?;
            let is_dir = metadata.is_dir();
            Ok(FileFacts {
                path: shown,
                name,
                exists: true,
                is_dir,
                size_bytes: (!is_dir).then_some(metadata.len()),
                modified_at: metadata.modified().ok().map(iso),
                kind: kind_of(&resolved, is_dir),
                folder: folder_of(teams_root, &resolved),
                openable: openable(&resolved, is_dir),
            })
        }
        // Gone — but only say so for a path that would be inside the root; anything else is the
        // same refusal an existing outside file gets, so absence cannot be probed through here.
        Err(error)
            if error.status == StatusCode::NOT_FOUND && lexically_under(teams_root, requested) =>
        {
            let candidate = if requested.is_absolute() {
                requested.to_path_buf()
            } else {
                teams_root.join(requested)
            };
            Ok(FileFacts {
                path: shown,
                name,
                exists: false,
                is_dir: false,
                size_bytes: None,
                modified_at: None,
                kind: kind_of(&candidate, false),
                folder: folder_of(teams_root, &candidate),
                openable: false,
            })
        }
        Err(error) if error.status == StatusCode::NOT_FOUND => Err(outside(&shown)),
        Err(error) => Err(error),
    }
}

fn outside(shown: &str) -> ApiError {
    ApiError::new(
        StatusCode::FORBIDDEN,
        format!("{shown} is outside the teams folder, so LoomWatch will not open it"),
    )
}

/// The system command that opens (or reveals) a resolved path.
pub(crate) fn opener(resolved: &Path, reveal: bool) -> std::process::Command {
    #[cfg(target_os = "macos")]
    {
        let mut command = std::process::Command::new("open");
        if reveal {
            command.arg("-R");
        }
        command.arg(resolved);
        command
    }
    #[cfg(target_os = "windows")]
    {
        if reveal {
            let mut command = std::process::Command::new("explorer");
            command.arg(format!("/select,{}", resolved.display()));
            command
        } else {
            let mut command = std::process::Command::new("explorer.exe");
            command.arg(resolved);
            command
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(if reveal {
            resolved.parent().unwrap_or(resolved)
        } else {
            resolved
        });
        command
    }
}

/// Decide, without launching anything, which path to hand to the system — or why not.
pub(crate) fn open_target(teams_root: &Path, request: &OpenRequest) -> Result<PathBuf, ApiError> {
    let resolved = match resolve_existing_team_path(teams_root, &request.path) {
        Ok(resolved) => resolved,
        Err(error)
            if error.status == StatusCode::NOT_FOUND
                && lexically_under(teams_root, &request.path) =>
        {
            return Err(ApiError::new(
                StatusCode::NOT_FOUND,
                format!(
                    "{} is not on this computer any more",
                    request.path.display()
                ),
            ));
        }
        Err(error) if error.status == StatusCode::NOT_FOUND => {
            return Err(outside(&request.path.to_string_lossy()));
        }
        Err(error) => return Err(error),
    };
    let is_dir = resolved.is_dir();
    if !request.reveal && !openable(&resolved, is_dir) {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            format!(
                "LoomWatch opens documents, media and data files only; use Show in folder for {}",
                resolved.file_name().map_or_else(
                    || resolved.display().to_string(),
                    |name| name.to_string_lossy().into_owned()
                )
            ),
        ));
    }
    Ok(resolved)
}

/// Open the file with its default app, or show it in its folder.
pub(crate) async fn open(teams_root: &Path, request: &OpenRequest) -> Result<(), ApiError> {
    let resolved = open_target(teams_root, request)?;
    let mut command = tokio::process::Command::from(opener(&resolved, request.reveal));
    let status = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map_err(|error| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("could not ask the system to open it: {error}"),
            )
        })?;
    if status.success() {
        Ok(())
    } else {
        Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            format!("the system could not open {}", resolved.display()),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Root(PathBuf);
    impl Root {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("loomwatch-files-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(path.join(".loomwatch/team/writer")).expect("create workspace");
            Self(std::fs::canonicalize(path).expect("canonical root"))
        }
    }
    impl Drop for Root {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn describes_a_report_the_writer_produced() {
        let root = Root::new();
        let report = root.0.join(".loomwatch/team/writer/report.docx");
        std::fs::write(&report, b"PK fake docx").expect("write report");
        let facts = stat(&root.0, &report).expect("stat");
        assert!(facts.exists);
        assert_eq!(facts.name, "report.docx");
        assert_eq!(facts.kind, "document");
        assert_eq!(facts.size_bytes, Some(12));
        assert_eq!(facts.folder.as_deref(), Some(".loomwatch/team/writer"));
        assert!(facts.openable);
        assert!(facts.modified_at.is_some());
    }

    #[test]
    fn says_a_file_inside_the_root_is_gone() {
        let root = Root::new();
        let facts = stat(&root.0, &root.0.join(".loomwatch/team/writer/old.pdf")).expect("stat");
        assert!(!facts.exists);
        assert_eq!(facts.kind, "pdf");
        assert!(!facts.openable);
    }

    #[test]
    fn refuses_paths_outside_the_root_whether_or_not_they_exist() {
        let root = Root::new();
        let elsewhere = std::env::temp_dir();
        for path in [
            elsewhere.clone(),
            elsewhere.join("does-not-exist.docx"),
            root.0.join("../x.docx"),
            PathBuf::from("../x.docx"),
        ] {
            let error = stat(&root.0, &path).expect_err("refused");
            assert!(
                error.status.is_client_error(),
                "{} gave {}",
                path.display(),
                error.status
            );
        }
    }

    #[test]
    fn opens_documents_but_only_reveals_programs_and_scripts() {
        let root = Root::new();
        let script = root.0.join(".loomwatch/team/writer/build.sh");
        let report = root.0.join(".loomwatch/team/writer/report.pdf");
        std::fs::write(&script, b"#!/bin/sh\n").expect("write script");
        std::fs::write(&report, b"%PDF").expect("write pdf");
        assert!(
            open_target(
                &root.0,
                &OpenRequest {
                    path: report.clone(),
                    reveal: false
                }
            )
            .is_ok()
        );
        let refused = open_target(
            &root.0,
            &OpenRequest {
                path: script.clone(),
                reveal: false,
            },
        )
        .expect_err("script refused");
        assert_eq!(refused.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(
            open_target(
                &root.0,
                &OpenRequest {
                    path: script,
                    reveal: true
                }
            )
            .is_ok()
        );
    }

    #[test]
    fn will_not_open_what_it_will_not_describe() {
        let root = Root::new();
        let outside = open_target(
            &root.0,
            &OpenRequest {
                path: std::env::temp_dir(),
                reveal: true,
            },
        )
        .expect_err("outside");
        assert_eq!(outside.status, StatusCode::FORBIDDEN);
        let gone = open_target(
            &root.0,
            &OpenRequest {
                path: root.0.join(".loomwatch/team/writer/gone.docx"),
                reveal: false,
            },
        )
        .expect_err("gone");
        assert_eq!(gone.status, StatusCode::NOT_FOUND);
    }

    #[test]
    fn classifies_by_extension_case_insensitively() {
        assert_eq!(kind_of(Path::new("Deck.PPTX"), false), "slides");
        assert_eq!(kind_of(Path::new("notes"), false), "file");
        assert_eq!(kind_of(Path::new("dir"), true), "folder");
        assert!(!openable(Path::new("tool.py"), false));
    }
}
