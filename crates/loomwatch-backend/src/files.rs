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
//!
//! A file can also be read inside `LoomWatch` (ADR 0077), so a part of it can be asked about in the
//! chat: [`read`] answers its text — the file itself, or the words of a PDF, Word, Excel or
//! `PowerPoint` file — and [`raw`] answers a picture or a recording as it is. Nothing is run here:
//! the page shows a web page in a sandbox of its own.

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

/// What the reader shows of one file (`GET /api/files/read`).
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileText {
    /// The path as the caller asked for it.
    pub(crate) path: String,
    pub(crate) name: String,
    /// As [`FileFacts::kind`].
    pub(crate) kind: &'static str,
    /// The file's text, or the words read out of a document.
    pub(crate) text: String,
    /// The words were read out of a PDF, Word, Excel or `PowerPoint` file: the text without its
    /// layout, as the agents read it.
    pub(crate) extracted: bool,
    /// Only the start of it fits in [`READ_MAX_BYTES`].
    pub(crate) truncated: bool,
    pub(crate) size_bytes: u64,
    pub(crate) modified_at: Option<String>,
}

/// The most text the reader is sent. A report, a page or a table is far smaller; a log can be
/// larger, and its start is what fits.
pub(crate) const READ_MAX_BYTES: usize = 2 * 1024 * 1024;

/// The largest picture, data or font file [`raw`] answers: a page takes them in whole, and so does
/// a part of a picture cut out to be asked about. A recording or a PDF of any size is answered, a
/// part at a time (ADR 0091).
const WHOLE_MAX_BYTES: u64 = 50 * 1024 * 1024;

/// Kinds whose bytes are text the reader shows as they are.
const TEXT_KINDS: &[&str] = &["markdown", "text", "web", "data", "code"];

/// Read an allowed, existing file — or say why not, as [`open_target`] does.
fn existing(teams_root: &Path, requested: &Path) -> Result<PathBuf, ApiError> {
    match resolve_allowed(teams_root, requested) {
        Ok(resolved) if resolved.is_dir() => Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            format!("{} is a folder", requested.display()),
        )),
        Ok(resolved) => Ok(resolved),
        Err(error)
            if error.status == StatusCode::NOT_FOUND && would_be_allowed(teams_root, requested) =>
        {
            Err(ApiError::new(
                StatusCode::NOT_FOUND,
                format!("{} is not on this computer any more", requested.display()),
            ))
        }
        Err(error) if error.status == StatusCode::NOT_FOUND => {
            Err(outside(&requested.to_string_lossy()))
        }
        Err(error) => Err(error),
    }
}

fn unreadable(name: &str, why: &str) -> ApiError {
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        format!("{name} can't be read in LoomWatch: {why}. Open it in its own app instead."),
    )
}

/// `bytes` as text, cut to [`READ_MAX_BYTES`] at a character, or `None` for a binary file.
fn as_text(bytes: &[u8]) -> Option<(String, bool)> {
    let sample = &bytes[..bytes.len().min(8192)];
    if sample.contains(&0) {
        return None;
    }
    let truncated = bytes.len() > READ_MAX_BYTES;
    let mut kept = &bytes[..bytes.len().min(READ_MAX_BYTES)];
    // A cut in the middle of a character leaves its start off, rather than a replacement mark.
    if truncated
        && let Err(error) = std::str::from_utf8(kept)
        && error.error_len().is_none()
    {
        kept = &kept[..error.valid_up_to()];
    }
    let text = String::from_utf8_lossy(kept);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned();
    Some((text, truncated))
}

/// A file's text for the reader: text files as they are, and the words of a PDF, Word, Excel or
/// `PowerPoint` file. Pictures and recordings come from [`raw`]; anything else opens in its own app.
/// Blocking: it reads the file, and a document in a helper process of its own.
pub(crate) fn read(teams_root: &Path, requested: &Path) -> Result<FileText, ApiError> {
    let resolved = existing(teams_root, requested)?;
    let name = resolved.file_name().map_or_else(
        || requested.display().to_string(),
        |name| name.to_string_lossy().into_owned(),
    );
    let metadata = std::fs::metadata(&resolved).map_err(|error| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to read {name}: {error}"),
        )
    })?;
    let kind = kind_of(&resolved, false);
    let document = crate::documents::Kind::of(&resolved);
    let (text, extracted, truncated) = if document.is_some_and(crate::documents::Kind::has_text) {
        let text = crate::documents::text(&resolved)
            .map_err(|why| unreadable(&name, why.trim_end_matches('.')))?;
        let (text, truncated) = as_text(text.as_bytes()).unwrap_or_default();
        (text, true, truncated)
    } else if TEXT_KINDS.contains(&kind)
        || matches!(extension(&resolved).as_deref(), Some("csv" | "tsv"))
    {
        let mut bytes = Vec::new();
        std::fs::File::open(&resolved)
            .and_then(|file| {
                std::io::Read::read_to_end(
                    &mut std::io::Read::take(file, READ_MAX_BYTES as u64 + 4),
                    &mut bytes,
                )
            })
            .map_err(|error| {
                ApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("failed to read {name}: {error}"),
                )
            })?;
        let (text, truncated) =
            as_text(&bytes).ok_or_else(|| unreadable(&name, "it isn't text"))?;
        (
            text,
            false,
            truncated || metadata.len() > bytes.len() as u64,
        )
    } else {
        let why = match kind {
            "image" | "media" => "it is a picture or a recording",
            _ => "it isn't a kind of file LoomWatch reads",
        };
        return Err(unreadable(&name, why));
    };
    Ok(FileText {
        path: requested.to_string_lossy().into_owned(),
        name,
        kind,
        text,
        extracted,
        truncated,
        size_bytes: metadata.len(),
        modified_at: metadata.modified().ok().map(iso),
    })
}

/// The media type a picture, a recording, or the data or a font a web page loads beside it is
/// answered with, by its extension.
fn media_type(path: &Path) -> Option<&'static str> {
    Some(match extension(path)?.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        "heic" => "image/heic",
        // Drawn as its pages by the reader (ADR 0091), read a part at a time.
        "pdf" => "application/pdf",
        // Drawn by the reader itself as its slides or its pages (ADR 0091), from these bytes.
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "pptm" => "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "docm" => "application/vnd.ms-word.document.macroEnabled.12",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        // What a web page loads beside it (ADR 0091): its data and its fonts.
        "csv" => "text/csv; charset=utf-8",
        "tsv" => "text/tab-separated-values; charset=utf-8",
        "json" | "topojson" => "application/json",
        "geojson" => "application/geo+json",
        "txt" => "text/plain; charset=utf-8",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        _ => return None,
    })
}

/// A file to answer as it is: where it is, its media type and its size.
#[derive(Debug)]
pub(crate) struct RawFile {
    pub(crate) path: PathBuf,
    pub(crate) media_type: &'static str,
    pub(crate) size: u64,
}

/// A picture or a recording, to be answered as it is, for the reader and for a web page's own
/// pictures and clips; the data and fonts a page loads beside it; and a PDF, a slide deck or a Word
/// document, for the reader to draw. Only those: a page, a script or a text is never answered as
/// bytes, so nothing an agent wrote can run as this daemon's page. The bytes are read by the route, all or the part a player asks for ([`wanted`]). Blocking.
pub(crate) fn raw(teams_root: &Path, requested: &Path) -> Result<RawFile, ApiError> {
    let resolved = existing(teams_root, requested)?;
    let name = resolved.file_name().map_or_else(
        || requested.display().to_string(),
        |name| name.to_string_lossy().into_owned(),
    );
    let Some(media_type) = media_type(&resolved) else {
        return Err(unreadable(
            &name,
            "only pictures, recordings and the files a page uses are shown here",
        ));
    };
    let size = std::fs::metadata(&resolved)
        .map_err(|error| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to read {name}: {error}"),
            )
        })?
        .len();
    // A recording and a PDF are read a part at a time, so any size will do.
    let in_parts = media_type.starts_with("video/")
        || media_type.starts_with("audio/")
        || media_type == "application/pdf";
    if !in_parts && size > WHOLE_MAX_BYTES {
        return Err(unreadable(&name, "it is larger than 50 MB"));
    }
    Ok(RawFile {
        path: resolved,
        media_type,
        size,
    })
}

/// A slide deck or a Word document as its pages (ADR 0091): the PDF `LibreOffice` makes of it,
/// answered as [`raw`] answers a PDF. Blocking: the first time, it waits for `LibreOffice`.
pub(crate) fn pages(teams_root: &Path, requested: &Path) -> Result<RawFile, ApiError> {
    let resolved = existing(teams_root, requested)?;
    let name = resolved.file_name().map_or_else(
        || requested.display().to_string(),
        |name| name.to_string_lossy().into_owned(),
    );
    if !crate::office::has_pages(&resolved) {
        return Err(unreadable(
            &name,
            "only slides and documents are shown here as their pages",
        ));
    }
    let shown = if crate::office::is_slides(&resolved) {
        "slides"
    } else {
        "pages"
    };
    let path = crate::office::pages(&resolved).map_err(|why| match why {
        crate::office::NoPages::NoOffice => ApiError::new(
            StatusCode::NOT_FOUND,
            format!(
                "{name} can be shown as {shown} only when LibreOffice is on this computer. Open it \
                 in its own app instead."
            ),
        ),
        crate::office::NoPages::TooSlow => ApiError::new(
            StatusCode::GATEWAY_TIMEOUT,
            format!("{name} took too long to show as {shown}. Open it in its own app instead."),
        ),
        crate::office::NoPages::Failed => unreadable(&name, "LibreOffice couldn't open it"),
    })?;
    let size = std::fs::metadata(&path)
        .map_err(|error| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to read the pages of {name}: {error}"),
            )
        })?
        .len();
    Ok(RawFile {
        path,
        media_type: "application/pdf",
        size,
    })
}

/// Which bytes of a file of `size` bytes a `Range` header asks for (RFC 9110 §14.1.2). A player
/// asks for a recording a part at a time, and Safari plays nothing it can't ask for so.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Wanted {
    /// The whole file: no header, several ranges at once, or one written in a way not read here.
    Whole,
    /// Bytes `start` to `end`, both included.
    Part { start: u64, end: u64 },
    /// A range wholly past the end.
    Unsatisfiable,
}

pub(crate) fn wanted(header: Option<&str>, size: u64) -> Wanted {
    let Some(spec) = header.and_then(|value| value.trim().strip_prefix("bytes=")) else {
        return Wanted::Whole;
    };
    if spec.contains(',') {
        return Wanted::Whole;
    }
    let Some((first, last)) = spec.split_once('-') else {
        return Wanted::Whole;
    };
    let (first, last) = (first.trim(), last.trim());
    if first.is_empty() {
        // The last `n` bytes.
        let Ok(n) = last.parse::<u64>() else {
            return Wanted::Whole;
        };
        if n == 0 || size == 0 {
            return Wanted::Unsatisfiable;
        }
        return Wanted::Part {
            start: size.saturating_sub(n),
            end: size - 1,
        };
    }
    let Ok(start) = first.parse::<u64>() else {
        return Wanted::Whole;
    };
    if start >= size {
        return Wanted::Unsatisfiable;
    }
    let end = if last.is_empty() {
        size - 1
    } else {
        let Ok(end) = last.parse::<u64>() else {
            return Wanted::Whole;
        };
        if end < start {
            return Wanted::Whole;
        }
        end.min(size - 1)
    };
    Wanted::Part { start, end }
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
    fn reads_a_text_file_an_agent_made_and_cuts_a_long_one_at_a_character() {
        let root = Root::new();
        let workspace = root.0.join(".loomwatch/team/writer");
        let report = workspace.join("report.md");
        std::fs::write(&report, "\u{feff}# Market\n\nSales grew.\n").expect("write report");
        let read = read(&root.0, &report).expect("read");
        assert_eq!(read.name, "report.md");
        assert_eq!(read.kind, "markdown");
        assert_eq!(read.text, "# Market\n\nSales grew.\n");
        assert!(!read.extracted && !read.truncated);

        let table = workspace.join("sales.csv");
        std::fs::write(&table, "month,sales\nMay,12\n").expect("write table");
        assert_eq!(
            super::read(&root.0, &table).expect("read table").text,
            "month,sales\nMay,12\n"
        );

        // Past what the reader is sent, the start is what fits, and no character is cut in two.
        let log = workspace.join("run.log");
        let mut written = "a".repeat(READ_MAX_BYTES - 1);
        written.push_str("éééé");
        std::fs::write(&log, &written).expect("write log");
        let read = super::read(&root.0, &log).expect("read log");
        assert!(read.truncated);
        assert_eq!(read.text.len(), READ_MAX_BYTES - 1);
        assert!(!read.text.contains('\u{fffd}'));
    }

    #[test]
    fn reads_neither_programs_nor_pictures_nor_anything_outside_the_root() {
        let root = Root::new();
        let workspace = root.0.join(".loomwatch/team/writer");
        let binary = workspace.join("data.json");
        std::fs::write(&binary, b"{\0\x01}").expect("write binary");
        assert_eq!(
            read(&root.0, &binary).unwrap_err().status,
            StatusCode::UNPROCESSABLE_ENTITY
        );
        let picture = workspace.join("chart.png");
        std::fs::write(&picture, b"\x89PNG\r\n\x1a\n").expect("write picture");
        let error = read(&root.0, &picture).unwrap_err();
        assert!(error.message.contains("picture"), "{}", error.message);
        let gone = workspace.join("old.md");
        assert_eq!(
            read(&root.0, &gone).unwrap_err().status,
            StatusCode::NOT_FOUND
        );
        let elsewhere =
            std::env::temp_dir().join(format!("loomwatch-elsewhere-{}.md", uuid::Uuid::new_v4()));
        std::fs::write(&elsewhere, "secret").expect("write elsewhere");
        let refused = read(&root.0, &elsewhere).unwrap_err();
        let _ = std::fs::remove_file(&elsewhere);
        assert_eq!(refused.status, StatusCode::FORBIDDEN);
        assert!(!refused.message.contains("secret"));
    }

    #[test]
    fn answers_pictures_as_they_are_and_never_a_page_or_a_script() {
        let root = Root::new();
        let workspace = root.0.join(".loomwatch/team/writer");
        let picture = workspace.join("chart.svg");
        std::fs::write(&picture, "<svg/>").expect("write picture");
        let file = raw(&root.0, &picture).expect("raw picture");
        assert_eq!(file.media_type, "image/svg+xml");
        assert_eq!(file.size, 6);
        assert_eq!(
            file.path.file_name().and_then(|name| name.to_str()),
            Some("chart.svg")
        );
        for name in [
            "page.html",
            "app.js",
            "report.md",
            "letter.doc",
            "notes.xml",
        ] {
            let file = workspace.join(name);
            std::fs::write(&file, "x").expect("write file");
            assert_eq!(
                raw(&root.0, &file).unwrap_err().status,
                StatusCode::UNPROCESSABLE_ENTITY,
                "{name}"
            );
        }
    }

    /// **A deck or a Word document is answered as it is, for the reader to draw (ADR 0091).** An
    /// old `.ppt` or `.doc` is not: the reader draws neither, and opens them in their own app.
    #[test]
    fn answers_a_deck_or_a_word_document_for_the_reader_to_draw() {
        let root = Root::new();
        let workspace = root.0.join(".loomwatch/team/writer");
        for (name, expected) in [
            (
                "deck.pptx",
                Some("application/vnd.openxmlformats-officedocument.presentationml.presentation"),
            ),
            (
                "deck.pptm",
                Some("application/vnd.ms-powerpoint.presentation.macroEnabled.12"),
            ),
            (
                "letter.docx",
                Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
            ),
            (
                "letter.docm",
                Some("application/vnd.ms-word.document.macroEnabled.12"),
            ),
            ("old.ppt", None),
            ("old.doc", None),
        ] {
            let path = workspace.join(name);
            std::fs::write(&path, "PK").expect("write file");
            match expected {
                Some(expected) => assert_eq!(raw(&root.0, &path).expect(name).media_type, expected),
                None => assert_eq!(
                    raw(&root.0, &path).unwrap_err().status,
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "{name}"
                ),
            }
        }
    }

    /// **A page's data and fonts are answered as they are (ADR 0091).** A dashboard loads the sheet
    /// beside it, whole, with the type a browser expects; past 50 MB it is refused, as a picture is.
    #[test]
    fn answers_the_data_and_fonts_a_page_loads_beside_it() {
        let root = Root::new();
        let workspace = root.0.join(".loomwatch/team/writer");
        for (name, expected) in [
            ("sales.csv", "text/csv; charset=utf-8"),
            ("sales.tsv", "text/tab-separated-values; charset=utf-8"),
            ("sales.json", "application/json"),
            ("map.geojson", "application/geo+json"),
            ("words.txt", "text/plain; charset=utf-8"),
            ("brand.woff2", "font/woff2"),
            ("brand.ttf", "font/ttf"),
        ] {
            let path = workspace.join(name);
            std::fs::write(&path, "a,b\n1,2\n").expect("write data");
            assert_eq!(raw(&root.0, &path).expect(name).media_type, expected);
        }
        let big = workspace.join("huge.csv");
        std::fs::File::create(&big)
            .and_then(|file| file.set_len(60 * 1024 * 1024))
            .expect("a large file");
        assert_eq!(
            raw(&root.0, &big).unwrap_err().status,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }

    /// **A recording of any size is answered; a picture past 50 MB is not (ADR 0091).** A page
    /// takes a picture in whole, but a player asks for a recording a part at a time.
    #[test]
    fn answers_a_recording_of_any_size_and_keeps_the_limit_for_pictures() {
        let root = Root::new();
        let workspace = root.0.join(".loomwatch/team/writer");
        let big = 60 * 1024 * 1024;
        for (name, answered) in [
            ("talk.mp4", true),
            ("song.mp3", true),
            ("report.pdf", true),
            ("huge.png", false),
        ] {
            let path = workspace.join(name);
            std::fs::File::create(&path)
                .and_then(|file| file.set_len(big))
                .expect("a large file");
            match raw(&root.0, &path) {
                Ok(file) => {
                    assert!(answered, "{name} answered");
                    assert_eq!(file.size, big);
                }
                Err(error) => {
                    assert!(!answered, "{name} refused: {}", error.message);
                    assert!(
                        error.message.contains("larger than 50 MB"),
                        "{}",
                        error.message
                    );
                }
            }
        }
    }

    #[test]
    fn reads_which_bytes_a_player_asks_for() {
        assert_eq!(wanted(None, 100), Wanted::Whole);
        assert_eq!(
            wanted(Some("bytes=10-19"), 100),
            Wanted::Part { start: 10, end: 19 }
        );
        assert_eq!(
            wanted(Some("bytes=90-"), 100),
            Wanted::Part { start: 90, end: 99 }
        );
        assert_eq!(
            wanted(Some("bytes=95-1000"), 100),
            Wanted::Part { start: 95, end: 99 }
        );
        assert_eq!(
            wanted(Some("bytes=-5"), 100),
            Wanted::Part { start: 95, end: 99 }
        );
        assert_eq!(
            wanted(Some("bytes=-500"), 100),
            Wanted::Part { start: 0, end: 99 }
        );
        assert_eq!(wanted(Some("bytes=100-"), 100), Wanted::Unsatisfiable);
        assert_eq!(wanted(Some("bytes=-0"), 100), Wanted::Unsatisfiable);
        assert_eq!(wanted(Some("bytes=0-"), 0), Wanted::Unsatisfiable);
        for whole in [
            "bytes=1-2,5-6",
            "items=0-9",
            "bytes=x-9",
            "bytes=9-3",
            "bytes=5",
        ] {
            assert_eq!(wanted(Some(whole), 100), Wanted::Whole, "{whole}");
        }
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
