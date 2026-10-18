//! Files the agents produced, as things the operator can open (ADR 0026).
//!
//! An agent that writes a report says so in its reply — usually as an absolute path. The UI turns
//! that path into a card; this module answers the two questions the card asks: *what is this file*
//! (`stat`) and *open it, or show it in its folder* (`open`).
//!
//! The boundary is the one every other file endpoint here uses: the configured teams root, which
//! holds the team files and the agents' managed workspaces (`.loomwatch/<team>/<agent>/`), plus the
//! folders the operator gave a team or an agent to read or work in ([`given_folders`]). An agent
//! names the files it read there as its sources, and they are the operator's own. Any other path is
//! refused, so a page cannot use this daemon to probe or launch arbitrary files. Opening is further
//! limited to documents, media and data: the system's default app is launched for those, never for a
//! program, script or app bundle — those can still be shown in their folder.

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

/// The folders and files outside the teams root that the operator gave a team or one of their
/// agents: each agent's working folder (`spawn.cwd`) and each folder or file it reads (ADR 0035),
/// in every team file, every saved agent (ADR 0030) and every one-agent team the test bench and an
/// agent's own chat run. Canonical, so a link is followed before a path is compared with them. Team
/// files are read for their shape only, without the checks a run makes, so a team with a wiring
/// problem still gave what it names.
pub(crate) fn given_folders(teams_root: &Path) -> Vec<PathBuf> {
    let mut given: Vec<PathBuf> = Vec::new();
    let mut add = |path: PathBuf| {
        if let Ok(resolved) = crate::platform::canonicalize(&path)
            && !resolved.starts_with(teams_root)
            && !given.contains(&resolved)
        {
            given.push(resolved);
        }
    };
    let bench = teams_root
        .join(crate::jobs::JOBS_DIR)
        .join(crate::jobs::BENCH_DIR);
    let bench_teams = std::fs::read_dir(bench)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "yaml")
        });
    let team_files = crate::api::discover_team_files(teams_root)
        .unwrap_or_default()
        .into_iter()
        .map(|relative| teams_root.join(relative))
        .chain(bench_teams);
    for file in team_files {
        let Some(team) = std::fs::read_to_string(&file)
            .ok()
            .and_then(|text| serde_yaml::from_str::<crate::config::TeamConfig>(&text).ok())
        else {
            continue;
        };
        let folder = file.parent().unwrap_or(teams_root);
        for agent in &team.agents {
            // As a run resolves it: absolute as written, else against the team file's folder.
            add(folder.join(&agent.spawn.cwd));
            for capability in &agent.capabilities {
                if capability.kind == crate::config::CapabilityKind::Knowledge
                    && let Some(path) = &capability.path
                {
                    add(crate::chosen_knowledge::resolve(folder, path));
                }
            }
        }
    }
    if let Ok(jobs) = crate::jobs::list_jobs(teams_root) {
        for read in jobs.jobs.iter().flat_map(|job| &job.spec.reads) {
            if let Some(path) = &read.path {
                add(crate::chosen_knowledge::resolve(
                    teams_root,
                    Path::new(path),
                ));
            }
        }
    }
    given
}

/// The canonical file a request names: inside the teams root, or — asked for by its full path —
/// inside a folder the operator gave a team ([`given_folders`]). Anything else keeps the refusal the
/// teams root gave it.
fn resolve_allowed(teams_root: &Path, requested: &Path) -> Result<PathBuf, ApiError> {
    match resolve_existing_team_path(teams_root, requested) {
        Err(error) if error.status == StatusCode::FORBIDDEN && requested.is_absolute() => {
            crate::platform::canonicalize(requested)
                .ok()
                .filter(|resolved| {
                    given_folders(teams_root)
                        .iter()
                        .any(|folder| resolved.starts_with(folder))
                })
                .ok_or(error)
        }
        resolved => resolved,
    }
}

/// A missing path would be inside the teams root or a given folder, so saying it is gone tells a
/// page nothing it could not already learn.
fn would_be_allowed(teams_root: &Path, requested: &Path) -> bool {
    lexically_under(teams_root, requested)
        || (requested.is_absolute()
            && !requested
                .components()
                .any(|part| matches!(part, Component::ParentDir))
            && given_folders(teams_root)
                .iter()
                .any(|folder| requested.starts_with(folder)))
}

/// The folder `file` is in, relative to `root` and `/`-separated, as the browser app names files.
fn folder_of(root: &Path, file: &Path) -> Option<String> {
    let relative = file.parent()?.strip_prefix(root).ok()?;
    Some(
        relative
            .components()
            .map(|part| part.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/"),
    )
}

fn iso(time: SystemTime) -> String {
    DateTime::<Utc>::from(time).to_rfc3339()
}

/// What a file is, or that it is gone. A path outside the teams root and the given folders is
/// refused either way.
pub(crate) fn stat(teams_root: &Path, requested: &Path) -> Result<FileFacts, ApiError> {
    let shown = requested.to_string_lossy().into_owned();
    let name = requested
        .file_name()
        .map_or_else(|| shown.clone(), |name| name.to_string_lossy().into_owned());
    match resolve_allowed(teams_root, requested) {
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
        // Gone — but only say so for a path that would be inside the root or a given folder;
        // anything else is the same refusal an existing outside file gets, so absence cannot be
        // probed through here.
        Err(error)
            if error.status == StatusCode::NOT_FOUND && would_be_allowed(teams_root, requested) =>
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
        format!("{shown} is outside the folders your teams use, so LoomWatch will not open it"),
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
        use std::os::windows::process::CommandExt;

        // Explorer opens a file with its default app, or selects it in its folder. Its command
        // line is passed exactly: Explorer reads `/select,"…"` its own way, and a Windows path can
        // never hold a quote. cmd.exe's `start` would also read `&` or `^` in a file name.
        let mut command = std::process::Command::new("explorer");
        let quoted = format!("\"{}\"", resolved.display());
        command.raw_arg(if reveal {
            format!("/select,{quoted}")
        } else {
            quoted
        });
        command
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
    let resolved = match resolve_allowed(teams_root, &request.path) {
        Ok(resolved) => resolved,
        Err(error)
            if error.status == StatusCode::NOT_FOUND
                && would_be_allowed(teams_root, &request.path) =>
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
    // Explorer reports failure (exit code 1) even when it opened the file.
    if status.success() || cfg!(windows) {
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
            Self(crate::platform::canonicalize(path).expect("canonical root"))
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

    /// A folder outside the teams root, removed afterwards.
    struct Elsewhere(PathBuf);
    impl Elsewhere {
        fn new(files: &[&str]) -> Self {
            let path =
                std::env::temp_dir().join(format!("loomwatch-given-{}", uuid::Uuid::new_v4()));
            for file in files {
                let file = path.join(file);
                std::fs::create_dir_all(file.parent().expect("parent")).expect("create folder");
                std::fs::write(file, b"# notes").expect("write file");
            }
            std::fs::create_dir_all(&path).expect("create folder");
            Self(crate::platform::canonicalize(path).expect("canonical folder"))
        }
    }
    impl Drop for Elsewhere {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn yaml_path(path: &Path) -> String {
        crate::test_support::sh_path(path)
    }

    #[test]
    fn opens_what_an_agent_read_in_a_folder_the_operator_gave_it() {
        let root = Root::new();
        let project = Elsewhere::new(&["kb/hub/00-hub.md", "kb/run.sh"]);
        let workplace = Elsewhere::new(&["README.md"]);
        let saved = Elsewhere::new(&["brief.pdf"]);
        let drafted = Elsewhere::new(&["plan.docx"]);
        let unrelated = Elsewhere::new(&["secret.md"]);
        std::fs::write(
            root.0.join("research.yaml"),
            format!(
                "schemaVersion: 1\nid: research\nentrypoint: researcher\nagents:\n  - id: researcher\n    model: openai/gpt-5.5\n    spawn:\n      cwd: \"{}\"\n    capabilities:\n      - kind: knowledge\n        name: project\n        path: \"{}\"\n",
                yaml_path(&workplace.0),
                yaml_path(&project.0)
            ),
        )
        .expect("write team");
        std::fs::create_dir_all(root.0.join(".jobs")).expect("jobs folder");
        std::fs::write(
            root.0.join(".jobs/reader.yaml"),
            format!(
                "name: Reader\ninstructions: Read it.\nreads:\n  - name: brief\n    path: \"{}\"\n",
                yaml_path(&saved.0.join("brief.pdf"))
            ),
        )
        .expect("write job");
        // An agent tried on the bench, or chatted with, before anything names it elsewhere.
        std::fs::create_dir_all(root.0.join(".jobs/.bench")).expect("bench folder");
        std::fs::write(
            root.0.join(".jobs/.bench/draft.yaml"),
            format!(
                "schemaVersion: 1\nentrypoint: draft\nagents:\n  - id: draft\n    model: openai/gpt-5.5\n    capabilities:\n      - kind: knowledge\n        name: plans\n        path: \"{}\"\n",
                yaml_path(&drafted.0)
            ),
        )
        .expect("write bench team");

        for file in [
            project.0.join("kb/hub/00-hub.md"),
            workplace.0.join("README.md"),
            saved.0.join("brief.pdf"),
            drafted.0.join("plan.docx"),
        ] {
            let facts = stat(&root.0, &file).expect("given folders are described");
            assert!(facts.exists && facts.openable, "{}", file.display());
            assert_eq!(facts.folder, None);
            assert!(
                open_target(
                    &root.0,
                    &OpenRequest {
                        path: file.clone(),
                        reveal: false
                    }
                )
                .is_ok(),
                "{}",
                file.display()
            );
        }
        // Still documents only, and still the same "gone" a team's own file gets.
        let script = OpenRequest {
            path: project.0.join("kb/run.sh"),
            reveal: false,
        };
        assert_eq!(
            open_target(&root.0, &script).expect_err("script").status,
            StatusCode::UNPROCESSABLE_ENTITY
        );
        let gone = stat(&root.0, &project.0.join("kb/old.md")).expect("gone is said");
        assert!(!gone.exists);

        // A folder no team was given stays refused, existing or not, and so does climbing out.
        for path in [
            unrelated.0.join("secret.md"),
            unrelated.0.join("missing.md"),
            project.0.join("../").join(
                unrelated
                    .0
                    .strip_prefix(project.0.parent().expect("temp"))
                    .expect("sibling")
                    .join("secret.md"),
            ),
        ] {
            let error = stat(&root.0, &path).expect_err("refused");
            assert_eq!(error.status, StatusCode::FORBIDDEN, "{}", path.display());
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_link_out_of_a_given_folder_is_followed_before_it_is_allowed() {
        let root = Root::new();
        let project = Elsewhere::new(&[]);
        let unrelated = Elsewhere::new(&["secret.md"]);
        std::os::unix::fs::symlink(unrelated.0.join("secret.md"), project.0.join("link.md"))
            .expect("link");
        std::fs::write(
            root.0.join("team.yaml"),
            format!(
                "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    model: openai/gpt-5.5\n    capabilities:\n      - kind: knowledge\n        name: project\n        path: \"{}\"\n",
                yaml_path(&project.0)
            ),
        )
        .expect("write team");
        let error = stat(&root.0, &project.0.join("link.md")).expect_err("refused");
        assert_eq!(error.status, StatusCode::FORBIDDEN);
    }

    #[test]
    fn classifies_by_extension_case_insensitively() {
        assert_eq!(kind_of(Path::new("Deck.PPTX"), false), "slides");
        assert_eq!(kind_of(Path::new("notes"), false), "file");
        assert_eq!(kind_of(Path::new("dir"), true), "folder");
        assert!(!openable(Path::new("tool.py"), false));
    }
}
