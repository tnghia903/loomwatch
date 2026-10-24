//! Knowledge the operator chose, rather than knowledge the Library found (ADR 0035).
//!
//! The one kind of knowledge the Library finds is team memory (ADR 0036). An operator also wants to hand an agent a folder of their own, or one document
//! such as a PDF, and the Library cannot discover those. Here a knowledge capability with a `path`
//! is read straight from that path. There are two shapes:
//!
//! * **A folder** is linked where it is. The agent is handed the same snapshot a Library folder
//!   gets — its listing and README — and a read grant for the folder, so a later run sees its
//!   current contents.
//! * **A file** is added to the team: the panel copies it beside the team file under
//!   `<team>.files/`, so the team stays self-contained. The agent is handed its text — read from a
//!   PDF, Word, Excel or `PowerPoint` file by [`crate::documents`] — and a read grant for the file.
//!   A long file's prompt section is its opening. Its full text is written into the agent's working
//!   folder for the agent to read when it needs more. That is the "preview, then retrieve" shape
//!   that keeps a prompt small without hiding anything. A picture is described, and the agent looks
//!   at it with `read_file`.
//!
//! Every reader goes through [`snapshot`], so what the panel previews is what the agent gets.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::capabilities::{CapabilityDefinition, KnowledgeSnapshot, TextCopy, folder_contents};
use crate::documents::{self, Kind};

/// Characters of an added file's text carried in the prompt. Past this, the prompt carries the
/// opening and says where the rest is. About 3,000 tokens: enough to judge whether the document
/// matters to the task, small enough that five documents stay inside the knowledge budget.
pub const FILE_EXCERPT_CHARS: usize = 12_000;

/// The largest file the panel adds. Bigger documents belong in a linked folder.
pub const MAX_FILE_BYTES: usize = 25 * 1024 * 1024;

/// Where an excerpted file's full text is put, relative to the agent's working folder.
pub const TEXT_COPY_DIR: &str = "knowledge";

/// The largest file read as text. A bigger one that isn't a document is described, not read.
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
        && let Some(home) = crate::platform::home_dir()
    {
        return home.join(rest);
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
    let canonical = crate::platform::canonicalize(&resolved)
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
    match Kind::of(file) {
        Some(kind) if kind.has_text() => {
            let label = kind.label();
            return Ok(match documents::text(file) {
                Ok(text) => {
                    let (content, copy) = excerpt(&text, &format!("{name}.txt"));
                    (format!("{label} · {name}, text extracted"), content, copy)
                }
                Err(reason) => (
                    format!("{label} · {name}"),
                    format!("{reason} The file is at {location}."),
                    None,
                ),
            });
        }
        Some(Kind::Picture) => {
            return Ok((
                format!("Picture · {name}"),
                format!(
                    "A picture of {}. To see it, read it with read_file: {location}",
                    human_size(size)
                ),
                None,
            ));
        }
        _ => {}
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
pub(crate) fn excerpt(text: &str, copy_name: &str) -> (String, Option<TextCopy>) {
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

pub(crate) fn human_size(bytes: u64) -> String {
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
    let folder = crate::platform::canonicalize(&start)
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
        .chain(drives())
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

/// Each drive on a Windows computer, `C:` first: a folder on `D:\` is under no other place, and
/// going up from one stops at its drive. None elsewhere, where everything is under `/`.
fn drives() -> Vec<FolderEntry> {
    if !cfg!(windows) {
        return Vec::new();
    }
    // A and B are floppy drives, which a computer of today doesn't have but may still answer for
    // slowly.
    (b'C'..=b'Z')
        .map(|letter| format!("{}:\\", char::from(letter)))
        .filter(|root| Path::new(root).is_dir())
        .map(|root| FolderEntry {
            name: root.trim_end_matches('\\').to_owned(),
            path: root,
        })
        .collect()
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
    /// Something the operator should know, such as a PDF whose text couldn't be read.
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
    let team_dir = team_file.parent().ok_or("the team file has no folder")?;
    let folder = files_folder(team_file);
    let folder_name = folder
        .file_name()
        .ok_or("the team file has no name")?
        .to_string_lossy()
        .into_owned();
    store_file_in(team_dir, &folder_name, requested_name, bytes)
}

/// Copy an uploaded file into the folder `folder_name` inside `within`, made when missing, the
/// way [`store_file`] does for a team. The stored file's `path` is relative to `within`.
///
/// # Errors
///
/// As [`store_file`].
pub fn store_file_in(
    within: &Path,
    folder_name: &str,
    requested_name: &str,
    bytes: &[u8],
) -> Result<StoredFile, String> {
    let (resolved, stored) = save_unique(within, folder_name, requested_name, bytes)?;
    let team_dir = crate::platform::canonicalize(within).map_err(|error| error.to_string())?;
    let relative = format!("{folder_name}/{stored}");
    let snapshot = snapshot(&team_dir, Path::new(&relative))?;
    let content = snapshot
        .contents
        .first()
        .map(|part| part.content.as_str())
        .unwrap_or_default();
    let unread = Kind::of(&resolved.join(&stored)).is_some_and(Kind::has_text)
        && !snapshot
            .contents
            .first()
            .is_some_and(|part| part.source.ends_with("text extracted"));
    let note = unread.then(|| {
        let reason = content.split(" The file is at ").next().unwrap_or_default();
        format!("Agents are told where it is but not given its text. {reason}")
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

/// Write `bytes` into the folder `folder_name` inside `within`, made when missing, under the
/// uploaded name kept recognisable: an identical file already there is reused, a different one
/// with the same name gets a numbered name rather than being replaced. Returns the folder,
/// resolved, and the name the file has in it. No text is read: [`store_file_in`] does that for
/// knowledge, and the chat hands its files over by path.
///
/// # Errors
///
/// Returns the reason when the name is unusable, the file is too large, the folder would resolve
/// outside `within`, or the write fails.
pub(crate) fn save_unique(
    within: &Path,
    folder_name: &str,
    requested_name: &str,
    bytes: &[u8],
) -> Result<(PathBuf, String), String> {
    if bytes.len() > MAX_FILE_BYTES {
        return Err(format!(
            "{requested_name} is larger than {} MB. Put it in a folder and add the folder instead.",
            MAX_FILE_BYTES / 1024 / 1024
        ));
    }
    let name = safe_name(requested_name)
        .ok_or_else(|| format!("{requested_name:?} cannot be used as a file name"))?;
    let folder = within.join(folder_name);
    fs::create_dir_all(&folder)
        .map_err(|error| format!("{} could not be created ({error})", folder.display()))?;
    // Re-checked after creating: a symlinked folder already on the way would put the file outside
    // the team.
    let resolved = crate::platform::canonicalize(&folder).map_err(|error| error.to_string())?;
    let within = crate::platform::canonicalize(within).map_err(|error| error.to_string())?;
    if !resolved.starts_with(&within) {
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
    Ok((resolved, stored))
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
    use crate::test_support::{docx, minimal_pdf, png};

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
                Self(crate::platform::canonicalize(path).expect("canonical scratch dir"))
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
            dir.path().join("data.bin"),
            [0x89, b'P', b'N', b'G', 0, 1, 2],
        )
        .unwrap();
        let snapshot = snapshot(dir.path(), Path::new("data.bin")).unwrap();
        assert!(snapshot.contents[0].content.starts_with("A BIN file of"));
        assert_eq!(
            snapshot.files.len(),
            1,
            "it can still be opened by an app that reads it"
        );
    }

    #[test]
    fn a_missing_path_says_so() {
        let dir = scratch();
        let error = snapshot(dir.path(), Path::new("gone.pdf")).unwrap_err();
        assert!(error.contains("does not exist on this computer"), "{error}");
    }

    #[test]
    fn a_pdf_or_an_office_file_is_supplied_as_its_text() {
        let dir = scratch();
        let pdf = dir.path().join("memo.pdf");
        fs::write(&pdf, minimal_pdf(&["Quarterly revenue rose"])).unwrap();
        let snapshot = snapshot(dir.path(), &pdf).unwrap();
        assert_eq!(
            snapshot.contents[0].source,
            "PDF · memo.pdf, text extracted"
        );
        assert_eq!(snapshot.contents[0].content, "Quarterly revenue rose");
        assert_eq!(snapshot.files, [pdf]);

        let word = dir.path().join("plan.docx");
        fs::write(&word, docx("<w:p><w:r><w:t>Leave Friday</w:t></w:r></w:p>")).unwrap();
        let read = super::snapshot(dir.path(), &word).unwrap();
        assert_eq!(read.contents[0].source, "Word · plan.docx, text extracted");
        assert_eq!(read.contents[0].content, "Leave Friday");
    }

    #[test]
    fn a_long_document_keeps_its_full_text_for_the_workspace() {
        let dir = scratch();
        let line = "Quarterly revenue rose again".repeat(3);
        let pages: Vec<&str> = (0..200).map(|_| line.as_str()).collect();
        fs::write(dir.path().join("report.pdf"), minimal_pdf(&pages)).unwrap();
        let snapshot = snapshot(dir.path(), Path::new("report.pdf")).unwrap();
        assert!(
            snapshot.contents[0]
                .content
                .contains("knowledge/report.pdf.txt in your working folder")
        );
        let copy = snapshot.text_copy.expect("the full text");
        assert_eq!(copy.file_name, "report.pdf.txt");
        assert!(copy.text.contains("— Page 200 of 200 —"));
    }

    #[test]
    fn a_scanned_pdf_says_why_it_brings_no_text() {
        let dir = scratch();
        let team = dir.path().join("desk.yaml");
        fs::write(&team, "schemaVersion: 1").unwrap();
        let added = store_file(&team, "scan.pdf", &minimal_pdf(&[""])).unwrap();
        let note = added.note.expect("a note for the panel");
        assert!(
            note.starts_with("Agents are told where it is but not given its text."),
            "{note}"
        );
        assert!(note.contains("probably scanned pages"), "{note}");
        let read = snapshot(dir.path(), Path::new(&added.path)).unwrap();
        assert_eq!(read.contents[0].source, "PDF · scan.pdf");
        assert!(read.contents[0].content.contains("The file is at "));
        let read = store_file(&team, "memo.pdf", &minimal_pdf(&["Revenue rose"])).unwrap();
        assert_eq!(read.note, None);
    }

    #[test]
    fn a_picture_is_described_and_left_for_read_file() {
        let dir = scratch();
        fs::write(dir.path().join("shot.png"), png(40, 20, false)).unwrap();
        let snapshot = snapshot(dir.path(), Path::new("shot.png")).unwrap();
        assert_eq!(snapshot.contents[0].source, "Picture · shot.png");
        assert!(snapshot.contents[0].content.starts_with("A picture of "));
        assert!(
            snapshot.contents[0]
                .content
                .contains("read it with read_file")
        );
        assert_eq!(snapshot.files.len(), 1, "the agent may read it");
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
        // Windows lists its drives too, so a folder on another drive can be reached.
        assert_eq!(
            listing.places.iter().any(|place| place.path == "C:\\"),
            cfg!(windows)
        );
        assert!(list_folder(Some(Path::new("relative")), None).is_err());
    }
}
