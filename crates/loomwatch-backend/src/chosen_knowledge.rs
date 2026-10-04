//! Knowledge the operator chose, rather than knowledge the Library found (ADR 0035).
//!
//! The Library lists knowledge it discovers: the project folder, the folders `OpenCode` ran in,
//! team memory. An operator also wants to hand an agent a folder of their own, or one document
//! such as a PDF, and the Library cannot discover those. Here a knowledge capability with a `path`
//! is read straight from that path. There are two shapes:
//!
//! * **A folder** is linked where it is. The agent is handed the same snapshot a Library folder
//!   gets — its listing and README — and a read grant for the folder, so a later run sees its
//!   current contents.
//! * **A file** is added to the team: the panel copies it beside the team file under
//!   `<team>.files/`, so the team stays self-contained. The agent is handed its text — extracted
//!   with `pdftotext` for a PDF, so an app that cannot open PDFs still reads it — and a read grant
//!   for the file. A long file's prompt section is its opening. Its full text is written into the
//!   agent's working folder for the agent to read when it needs more. That is the "preview, then
//!   retrieve" shape that keeps a prompt small without hiding anything.
//!
//! Every reader goes through [`snapshot`], so what the panel previews is what the agent gets.

use std::ffi::OsString;
use std::fs;
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::capabilities::{CapabilityDefinition, KnowledgeSnapshot, TextCopy, folder_contents};

/// Characters of an added file's text carried in the prompt. Past this, the prompt carries the
/// opening and says where the rest is. About 3,000 tokens: enough to judge whether the document
/// matters to the task, small enough that five documents stay inside the knowledge budget.
pub const FILE_EXCERPT_CHARS: usize = 12_000;

/// The largest file the panel adds. Bigger documents belong in a linked folder.
pub const MAX_FILE_BYTES: usize = 25 * 1024 * 1024;

/// Where an excerpted file's full text is put, relative to the agent's working folder.
pub const TEXT_COPY_DIR: &str = "knowledge";

/// The largest file read as text. A bigger non-PDF is described, not read.
const MAX_TEXT_READ_BYTES: u64 = 8 * 1024 * 1024;

/// Files listed by the folder picker before it says how many more there are.
const PICKER_FILE_LIMIT: usize = 40;

/// `teams/trip.yaml` → `teams/trip.files`, the folder [`store_file`] copies added files into.
/// Deleting the team moves it to the trash with the team file.
#[must_use]
pub fn files_folder(team_file: &Path) -> PathBuf {
    team_file.with_extension("files")
}

/// Resolve a capability path the way the team file means it: absolute as written, `~/` against
/// the home folder, anything else against the team file's own directory.
#[must_use]
pub fn resolve(team_dir: &Path, path: &Path) -> PathBuf {
    if let Ok(rest) = path.strip_prefix("~")
        && let Some(home) = std::env::var_os("HOME")
    {
        return PathBuf::from(home).join(rest);
    }
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        team_dir.join(path)
    }
}

/// What a chosen folder or file holds, as the agent is handed it.
///
/// # Errors
///
/// Returns the reason, in a sentence fragment, when the path does not exist or cannot be read.
pub fn snapshot(team_dir: &Path, path: &Path) -> Result<KnowledgeSnapshot, String> {
    let resolved = resolve(team_dir, path);
    let canonical = fs::canonicalize(&resolved)
        .map_err(|_| format!("{} does not exist on this computer", resolved.display()))?;
    if canonical.is_dir() {
        let contents = folder_contents(&canonical, "Linked");
        if contents.is_empty() {
            return Err(format!("{} could not be read", canonical.display()));
        }
        return Ok(KnowledgeSnapshot {
            contents,
            folders: vec![canonical],
            ..KnowledgeSnapshot::default()
        });
    }
    let (source, content, text_copy) = file_contents(&canonical)?;
    Ok(KnowledgeSnapshot {
        contents: vec![CapabilityDefinition {
            source,
            path: canonical.to_string_lossy().into_owned(),
            content,
        }],
        files: vec![canonical],
        text_copy,
        ..KnowledgeSnapshot::default()
    })
}

/// One file's section: a source label, the text the prompt carries, and the full text when that
/// is only an excerpt.
fn file_contents(file: &Path) -> Result<(String, String, Option<TextCopy>), String> {
    let name = file.file_name().map_or_else(
        || "file".to_owned(),
        |name| name.to_string_lossy().into_owned(),
    );
    let location = file.display();
    let size = fs::metadata(file)
        .map_err(|error| format!("{location} could not be read ({error})"))?
        .len();
    if is_pdf(file) {
        return Ok(match pdf_text(file) {
            Some(text) if !text.trim().is_empty() => {
                let (content, copy) = excerpt(&text, &format!("{name}.txt"));
                (format!("PDF · {name}, text extracted"), content, copy)
            }
            Some(_) => (
                format!("PDF · {name}"),
                format!(
                    "No text could be extracted from this PDF; it may be scanned pages. The file is at {location}; open it directly if your app can read PDFs."
                ),
                None,
            ),
            None => (
                format!("PDF · {name}"),
                format!(
                    "This PDF's text could not be extracted on this computer: pdftotext is not installed, or it could not read this file in time. The file is at {location}; open it directly if your app can read PDFs."
                ),
                None,
            ),
        });
    }
    let text = (size <= MAX_TEXT_READ_BYTES)
        .then(|| fs::read(file).ok())
        .flatten()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .filter(|text| !text.contains('\0'));
    Ok(match text {
        Some(text) => {
            let (content, copy) = excerpt(&text, &name);
            (format!("File · {name}"), content, copy)
        }
        None => (
            format!("File · {name}"),
            format!(
                "A {} file of {}. Its contents are not text; open it at {location} if your app can read this kind of file.",
                file.extension().map_or_else(
                    || "binary".to_owned(),
                    |ext| ext.to_string_lossy().to_uppercase()
                ),
                human_size(size)
            ),
            None,
        ),
    })
}

/// Where an excerpt says its full text is, for an agent that starts in its workspace.
fn copy_location(copy_name: &str) -> String {
    format!("{TEXT_COPY_DIR}/{copy_name} in your working folder")
}

/// An excerpt's note with the full text named by its path in `folder`, for an agent that works in
/// a folder the operator chose and reads its copies from the workspace (ADR 0042).
#[must_use]
pub fn relocate_copy_note(content: &str, copy_name: &str, folder: &Path) -> String {
    content.replace(
        &copy_location(copy_name),
        &folder.join(copy_name).display().to_string(),
    )
}

/// The whole text when it is short, or its opening, cut at a line, with where the rest is.
fn excerpt(text: &str, copy_name: &str) -> (String, Option<TextCopy>) {
    let text = text.replace('\u{c}', "\n");
    let total = text.chars().count();
    if total <= FILE_EXCERPT_CHARS {
        return (text.trim_end().to_owned(), None);
    }
    let head = text.chars().take(FILE_EXCERPT_CHARS).collect::<String>();
    // Cut at the last line break in the second half, so the excerpt ends on a whole line.
    let cut = head
        .rfind('\n')
        .filter(|index| *index > head.len() / 2)
        .map_or(head.as_str(), |index| &head[..index]);
    let rest = total - cut.chars().count();
    let content = format!(
        "{}\n\n… {rest} more characters. The full text is in {}; read it when the task needs more.",
        cut.trim_end(),
        copy_location(copy_name)
    );
    (
        content,
        Some(TextCopy {
            file_name: copy_name.to_owned(),
            text,
        }),
    )
}

fn is_pdf(file: &Path) -> bool {
    file.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
        || fs::File::open(file).is_ok_and(|mut handle| {
            use std::io::Read as _;
            let mut magic = [0u8; 5];
            handle.read_exact(&mut magic).is_ok() && &magic == b"%PDF-"
        })
}

/// How long `pdftotext` may take over one file, and how much text is kept from it. A PDF someone
/// shared could otherwise hold a worker or fill memory (ADR 0048); the prompt carries an excerpt
/// of far less anyway.
const PDF_DEADLINE: Duration = Duration::from_secs(15);
const PDF_TEXT_MAX: usize = 8 * 1024 * 1024;

/// A PDF's text, from `pdftotext`, at most [`PDF_TEXT_MAX`] bytes of it. `None` when `pdftotext`
/// is not installed, fails, or takes longer than [`PDF_DEADLINE`].
#[must_use]
pub fn pdf_text(file: &Path) -> Option<String> {
    extract_text(&pdftotext()?, file, PDF_DEADLINE, PDF_TEXT_MAX)
}

/// Run `program` as `pdftotext` over `file` for at most `deadline`, keeping at most `limit` bytes
/// of what it writes. A program that writes more is stopped once the limit is read, and what was
/// read is kept.
fn extract_text(program: &Path, file: &Path, deadline: Duration, limit: usize) -> Option<String> {
    let mut child = Command::new(program)
        .args(["-enc", "UTF-8", "-q"])
        .arg(file)
        .arg("-")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let full = Arc::new(AtomicBool::new(false));
    let reader = {
        let full = Arc::clone(&full);
        std::thread::spawn(move || {
            let mut text = Vec::new();
            let _ = stdout
                .take(u64::try_from(limit).unwrap_or(u64::MAX).saturating_add(1))
                .read_to_end(&mut text);
            if text.len() > limit {
                text.truncate(limit);
                full.store(true, Ordering::Release);
            }
            text
        })
    };
    let stop_by = Instant::now() + deadline;
    let finished = loop {
        match child.try_wait() {
            // A program stopped by the pipe closing behind the text limit still gave enough text.
            Ok(Some(status)) => break status.success() || full.load(Ordering::Acquire),
            // Enough text: the rest is never read, so the program is stopped rather than left
            // blocked on a full pipe.
            Ok(None) if full.load(Ordering::Acquire) => {
                let _ = child.kill();
                let _ = child.wait();
                break true;
            }
            Ok(None) if Instant::now() < stop_by => {
                std::thread::sleep(Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    let text = reader.join().ok()?;
    finished.then(|| String::from_utf8_lossy(&text).into_owned())
}

/// Where `pdftotext` is. A daemon started outside a login shell sees a short `PATH`, and Homebrew
/// — where poppler's `pdftotext` usually comes from — is not on it, so its directories are tried
/// too.
fn pdftotext() -> Option<PathBuf> {
    let mut directories = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .unwrap_or_default();
    directories.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
    let search: OsString = std::env::join_paths(directories).ok()?;
    crate::api::find_executable(&search, "pdftotext")
}

fn human_size(bytes: u64) -> String {
    // Display only, so the precision lost in the cast does not matter.
    #[allow(clippy::cast_precision_loss)]
    let kib = bytes as f64 / 1024.0;
    if kib < 1024.0 {
        format!("{kib:.0} KB")
    } else {
        format!("{:.1} MB", kib / 1024.0)
    }
}

/// One folder, as the folder picker shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderListing {
    pub path: String,
    pub name: String,
    pub parent: Option<String>,
    pub folders: Vec<FolderEntry>,
    /// File names, so the operator recognises the folder. Not selectable.
    pub files: Vec<String>,
    pub more_files: usize,
    /// Places to start from: home, Desktop, Documents, Downloads — those that exist.
    pub places: Vec<FolderEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
    pub name: String,
    pub path: String,
}

/// List one folder for the picker: its subfolders and file names, hidden ones left out.
///
/// # Errors
///
/// Returns the reason when the path is relative, missing, not a folder, or unreadable.
pub fn list_folder(requested: Option<&Path>, home: Option<&Path>) -> Result<FolderListing, String> {
    let start = requested
        .map(Path::to_path_buf)
        .or_else(|| home.map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("/"));
    if !start.is_absolute() {
        return Err(format!("{} is not a full path", start.display()));
    }
    let folder = fs::canonicalize(&start)
        .map_err(|_| format!("{} does not exist on this computer", start.display()))?;
    if !folder.is_dir() {
        return Err(format!("{} is not a folder", folder.display()));
    }
    let entries = fs::read_dir(&folder)
        .map_err(|error| format!("{} could not be read ({error})", folder.display()))?;
    let mut folders = Vec::new();
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        // A symlink to a folder is a folder to the operator; `metadata` follows it.
        if fs::metadata(entry.path()).is_ok_and(|metadata| metadata.is_dir()) {
            folders.push(FolderEntry {
                path: entry.path().to_string_lossy().into_owned(),
                name,
            });
        } else {
            files.push(name);
        }
    }
    folders.sort_by_key(|entry| entry.name.to_lowercase());
    files.sort_by_key(|name| name.to_lowercase());
    let more_files = files.len().saturating_sub(PICKER_FILE_LIMIT);
    files.truncate(PICKER_FILE_LIMIT);
    let places = home
        .into_iter()
        .flat_map(|home| {
            [
                ("Home", home.to_path_buf()),
                ("Desktop", home.join("Desktop")),
                ("Documents", home.join("Documents")),
                ("Downloads", home.join("Downloads")),
            ]
        })
        .filter(|(_, path)| path.is_dir())
        .map(|(name, path)| FolderEntry {
            name: name.to_owned(),
            path: path.to_string_lossy().into_owned(),
        })
        .collect();
    Ok(FolderListing {
        name: folder.file_name().map_or_else(
            || folder.to_string_lossy().into_owned(),
            |name| name.to_string_lossy().into_owned(),
        ),
        parent: folder
            .parent()
            .map(|parent| parent.to_string_lossy().into_owned()),
        path: folder.to_string_lossy().into_owned(),
        folders,
        files,
        more_files,
        places,
    })
}

/// A file the panel added to a team, and what an agent will be handed from it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredFile {
    /// The name it was stored under, which is also its label.
    pub name: String,
    /// Relative to the team file's directory: what the team file's `path` holds.
    pub path: String,
    pub bytes: usize,
    /// Characters of text an agent is handed from it, excerpt included.
    pub chars: usize,
    /// The prompt carries only the opening; the full text goes into the agent's working folder.
    pub excerpted: bool,
    /// Something the operator should know, such as a PDF whose text could not be extracted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// Copy an uploaded file beside the team file, under `<team>.files/`.
///
/// The name is reduced to its last component and kept recognisable. An identical file already
/// there is reused; a different file with the same name gets a numbered name rather than
/// replacing it, because another agent may already be connected to the first.
///
/// # Errors
///
/// Returns the reason when the name is unusable, the file is too large, the folder would resolve
/// outside the team's directory, or the write fails.
pub fn store_file(
    team_file: &Path,
    requested_name: &str,
    bytes: &[u8],
) -> Result<StoredFile, String> {
    if bytes.len() > MAX_FILE_BYTES {
        return Err(format!(
            "{requested_name} is larger than {} MB. Put it in a folder and add the folder instead.",
            MAX_FILE_BYTES / 1024 / 1024
        ));
    }
    let name = safe_name(requested_name)
        .ok_or_else(|| format!("{requested_name:?} cannot be used as a file name"))?;
    let team_dir = team_file
        .parent()
        .ok_or("the team file has no folder")?
        .to_path_buf();
    let folder = files_folder(team_file);
    let folder_name = folder
        .file_name()
        .ok_or("the team file has no name")?
        .to_string_lossy()
        .into_owned();
    fs::create_dir_all(&folder)
        .map_err(|error| format!("{} could not be created ({error})", folder.display()))?;
    // Re-checked after creating: a symlinked folder already on the way would put the file outside
    // the team.
    let resolved = fs::canonicalize(&folder).map_err(|error| error.to_string())?;
    let team_dir = fs::canonicalize(&team_dir).map_err(|error| error.to_string())?;
    if !resolved.starts_with(&team_dir) {
        return Err(format!(
            "{folder_name} resolves outside the team's own folder"
        ));
    }
    let mut stored = name.clone();
    let mut counter = 2;
    loop {
        let target = resolved.join(&stored);
        match fs::read(&target) {
            Ok(existing) if existing == bytes => break,
            Ok(_) => {
                stored = numbered(&name, counter);
                counter += 1;
            }
            Err(_) => {
                let partial = resolved.join(format!(".{stored}.partial"));
                fs::write(&partial, bytes)
                    .map_err(|error| format!("{stored} could not be saved ({error})"))?;
                fs::rename(&partial, &target)
                    .map_err(|error| format!("{stored} could not be saved ({error})"))?;
                break;
            }
        }
    }
    let relative = format!("{folder_name}/{stored}");
    let snapshot = snapshot(&team_dir, Path::new(&relative))?;
    let content = snapshot
        .contents
        .first()
        .map(|part| part.content.as_str())
        .unwrap_or_default();
    let note = (is_pdf(&resolved.join(&stored)) && snapshot.text_copy.is_none() && content.contains("pdftotext is not installed"))
        .then(|| {
            "Its text could not be extracted on this computer, so agents are told where the PDF is but not given its text. Install pdftotext (brew install poppler) to fix that.".to_owned()
        });
    Ok(StoredFile {
        name: stored,
        path: relative,
        bytes: bytes.len(),
        chars: content.chars().count(),
        excerpted: snapshot.text_copy.is_some(),
        note,
    })
}

/// The last component of an uploaded name, without control characters or a leading dot.
fn safe_name(requested: &str) -> Option<String> {
    let last = requested.rsplit(['/', '\\']).next()?.trim();
    let cleaned = last
        .chars()
        .filter(|character| !character.is_control())
        .collect::<String>();
    let cleaned = cleaned.trim_start_matches('.').trim();
    if cleaned.is_empty() || cleaned.chars().count() > 160 {
        return None;
    }
    Some(cleaned.to_owned())
}

/// `report.pdf` → `report (2).pdf`.
fn numbered(name: &str, counter: u32) -> String {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => format!("{stem} ({counter}).{ext}"),
        _ => format!("{name} ({counter})"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> tempfile_lite::Dir {
        tempfile_lite::Dir::new()
    }

    /// A tiny temporary directory, so the tests need no new dependency.
    mod tempfile_lite {
        use std::path::{Path, PathBuf};

        pub struct Dir(PathBuf);

        impl Dir {
            pub fn new() -> Self {
                let path =
                    std::env::temp_dir().join(format!("loomwatch-chosen-{}", uuid::Uuid::new_v4()));
                std::fs::create_dir_all(&path).expect("scratch dir");
                Self(std::fs::canonicalize(path).expect("canonical scratch dir"))
            }

            pub fn path(&self) -> &Path {
                &self.0
            }
        }

        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    #[test]
    fn a_linked_folder_is_its_listing_and_a_read_grant() {
        let dir = scratch();
        let folder = dir.path().join("reports");
        fs::create_dir_all(folder.join("2026")).unwrap();
        fs::write(folder.join("README.md"), "Quarterly reports.").unwrap();
        fs::write(folder.join("q3.csv"), "a,b").unwrap();
        let snapshot = snapshot(dir.path(), &folder).unwrap();
        assert_eq!(snapshot.folders, std::slice::from_ref(&folder));
        assert!(snapshot.files.is_empty());
        let listing = &snapshot.contents[0];
        assert_eq!(listing.source, "Linked · folder");
        assert!(listing.content.contains("2026/") && listing.content.contains("q3.csv"));
        assert!(snapshot.contents[1].content.contains("Quarterly reports."));
    }

    #[test]
    fn a_short_text_file_is_supplied_whole_and_resolves_against_the_team_folder() {
        let dir = scratch();
        fs::create_dir_all(dir.path().join("desk.files")).unwrap();
        fs::write(
            dir.path().join("desk.files/brief.md"),
            "# Brief\nKeep it short.\n",
        )
        .unwrap();
        let snapshot = snapshot(dir.path(), Path::new("desk.files/brief.md")).unwrap();
        assert_eq!(snapshot.contents[0].source, "File · brief.md");
        assert_eq!(snapshot.contents[0].content, "# Brief\nKeep it short.");
        assert_eq!(snapshot.files, [dir.path().join("desk.files/brief.md")]);
        assert!(snapshot.text_copy.is_none());
    }

    #[test]
    fn a_long_file_is_an_excerpt_cut_at_a_line_with_its_full_text_kept_for_the_workspace() {
        let dir = scratch();
        let line = "x".repeat(99);
        let text = (0..300)
            .map(|_| line.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(dir.path().join("long.txt"), &text).unwrap();
        let snapshot = snapshot(dir.path(), Path::new("long.txt")).unwrap();
        let content = &snapshot.contents[0].content;
        let (body, note) = content.split_once("\n\n… ").unwrap();
        assert!(body.chars().count() <= FILE_EXCERPT_CHARS);
        assert!(body.ends_with(&line), "the excerpt ends on a whole line");
        assert!(
            note.contains("knowledge/long.txt in your working folder"),
            "{note}"
        );
        let copy = snapshot.text_copy.unwrap();
        assert_eq!(copy.file_name, "long.txt");
        assert_eq!(copy.text, text);
    }

    #[test]
    fn a_binary_file_is_described_not_pasted() {
        let dir = scratch();
        fs::write(
            dir.path().join("photo.png"),
            [0x89, b'P', b'N', b'G', 0, 1, 2],
        )
        .unwrap();
        let snapshot = snapshot(dir.path(), Path::new("photo.png")).unwrap();
        assert!(snapshot.contents[0].content.starts_with("A PNG file of"));
        assert_eq!(
            snapshot.files.len(),
            1,
            "it can still be opened by an app that reads images"
        );
    }

    #[test]
    fn a_missing_path_says_so() {
        let dir = scratch();
        let error = snapshot(dir.path(), Path::new("gone.pdf")).unwrap_err();
        assert!(error.contains("does not exist on this computer"), "{error}");
    }

    // Exercised only where poppler is installed; the no-pdftotext branch is the same code path
    // with `pdf_text` returning `None`.
    #[test]
    fn a_pdf_is_supplied_as_its_extracted_text_when_pdftotext_is_installed() {
        if pdftotext().is_none() {
            return;
        }
        let dir = scratch();
        let pdf = dir.path().join("memo.pdf");
        fs::write(&pdf, minimal_pdf("Quarterly revenue rose")).unwrap();
        let snapshot = snapshot(dir.path(), &pdf).unwrap();
        assert_eq!(
            snapshot.contents[0].source,
            "PDF · memo.pdf, text extracted"
        );
        assert!(
            snapshot.contents[0]
                .content
                .contains("Quarterly revenue rose"),
            "{:?}",
            snapshot.contents
        );
    }

    fn fake_pdftotext(dir: &Path, body: &str) -> PathBuf {
        let path = dir.join("fake-pdftotext");
        fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }

    /// ADR 0048: a PDF that keeps `pdftotext` busy, or makes it write without end, costs a bounded
    /// time and a bounded amount of memory.
    #[test]
    fn pdf_extraction_is_bounded_in_time_and_size() {
        let dir = scratch();
        let file = dir.path().join("shared.pdf");
        fs::write(&file, b"%PDF-").unwrap();

        let slow = fake_pdftotext(dir.path(), "exec sleep 30");
        let started = Instant::now();
        assert_eq!(
            extract_text(&slow, &file, Duration::from_millis(300), 1024),
            None
        );
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "{:?}",
            started.elapsed()
        );

        let endless = fake_pdftotext(dir.path(), "exec yes loomwatch");
        let text = extract_text(&endless, &file, Duration::from_secs(10), 1000).expect("text");
        assert_eq!(text.len(), 1000);
        assert!(text.starts_with("loomwatch\nloomwatch\n"));

        let quick = fake_pdftotext(dir.path(), "printf 'Quarterly revenue rose'");
        assert_eq!(
            extract_text(&quick, &file, Duration::from_secs(10), 1000).as_deref(),
            Some("Quarterly revenue rose")
        );
    }

    #[test]
    fn an_added_file_lands_beside_the_team_and_a_different_one_never_replaces_it() {
        let dir = scratch();
        let team = dir.path().join("desk.yaml");
        fs::write(&team, "schemaVersion: 1").unwrap();
        let first = store_file(&team, "../../notes.md", b"first").unwrap();
        assert_eq!(first.path, "desk.files/notes.md");
        assert_eq!(
            fs::read(dir.path().join("desk.files/notes.md")).unwrap(),
            b"first"
        );
        let same = store_file(&team, "notes.md", b"first").unwrap();
        assert_eq!(
            same.path, "desk.files/notes.md",
            "an identical file is reused"
        );
        let second = store_file(&team, "notes.md", b"second").unwrap();
        assert_eq!(second.path, "desk.files/notes (2).md");
        assert_eq!(
            fs::read(dir.path().join("desk.files/notes.md")).unwrap(),
            b"first"
        );
        assert!(store_file(&team, "..", b"x").is_err());
        assert_eq!(store_file(&team, ".env", b"x").unwrap().name, "env");
    }

    #[test]
    fn the_picker_lists_folders_and_files_but_not_hidden_ones() {
        let dir = scratch();
        fs::create_dir_all(dir.path().join("Beta")).unwrap();
        fs::create_dir_all(dir.path().join("alpha")).unwrap();
        fs::create_dir_all(dir.path().join(".git")).unwrap();
        fs::write(dir.path().join("readme.txt"), "x").unwrap();
        fs::write(dir.path().join(".env"), "x").unwrap();
        let listing = list_folder(Some(dir.path()), Some(dir.path())).unwrap();
        assert_eq!(
            listing
                .folders
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            ["alpha", "Beta"]
        );
        assert_eq!(listing.files, ["readme.txt"]);
        assert_eq!(listing.places[0].name, "Home");
        assert!(list_folder(Some(Path::new("relative")), None).is_err());
    }

    /// The smallest PDF `pdftotext` reads: one page, one line of Helvetica text.
    fn minimal_pdf(text: &str) -> Vec<u8> {
        let stream = format!("BT /F1 18 Tf 50 700 Td ({text}) Tj ET");
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>".to_owned(),
            format!("<< /Length {} >>\nstream\n{stream}\nendstream", stream.len()),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_owned(),
        ];
        let mut pdf = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (index, object) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.extend(format!("{} 0 obj\n{object}\nendobj\n", index + 1).bytes());
        }
        let xref = pdf.len();
        pdf.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).bytes());
        for offset in offsets {
            pdf.extend(format!("{offset:010} 00000 n \n").bytes());
        }
        pdf.extend(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
                objects.len() + 1
            )
            .bytes(),
        );
        pdf
    }
}
