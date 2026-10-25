//! Office files drawn as their pages (ADR 0091). A slide deck or a Word document is turned into a
//! PDF by `LibreOffice`, when it is on this computer, and the reader draws that PDF as it draws any
//! PDF, so a part of a slide or a page can be asked about where it is. `LibreOffice` runs headless,
//! with a profile of its own in the state folder (never the person's own), one file at a time, for
//! at most [`CONVERT_LIMIT`]. The PDF is kept in the state folder by the file's path, size and last
//! change, so a file is converted once until it changes. Without `LibreOffice` the reader shows the
//! file's words, as it always has.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, UNIX_EPOCH};

use sha2::{Digest as _, Sha256};

/// How long one file may take to become pages.
const CONVERT_LIMIT: Duration = Duration::from_secs(120);
/// The folder in the state folder the pages are kept in.
const PAGES_FOLDER: &str = "pages";

/// Where the pages are kept, set once at startup ([`install`]).
static INSTALLED: OnceLock<PathBuf> = OnceLock::new();
/// `LibreOffice` keeps one profile open at a time: files are turned into pages one after another.
static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

/// Names the state folder the pages are kept in. The daemon calls this once, at startup; a second
/// call is ignored. Without it (tests, one-off commands) pages are kept in the temporary folder.
pub fn install(state_dir: &Path) {
    let _ = INSTALLED.set(state_dir.join(PAGES_FOLDER));
}

/// Whether `path` is a kind of file drawn as its pages through `LibreOffice`: a slide deck or a
/// Word or `OpenDocument` text.
#[must_use]
pub fn has_pages(path: &Path) -> bool {
    matches!(
        extension(path).as_deref(),
        Some("pptx" | "pptm" | "ppt" | "odp" | "docx" | "docm" | "doc" | "odt" | "rtf")
    )
}

/// Whether `path` is a slide deck: its pages are slides.
#[must_use]
pub fn is_slides(path: &Path) -> bool {
    matches!(
        extension(path).as_deref(),
        Some("pptx" | "pptm" | "ppt" | "odp" | "key")
    )
}

fn extension(path: &Path) -> Option<String> {
    path.extension()
        .map(|extension| extension.to_string_lossy().to_ascii_lowercase())
}

/// Why a file has no pages to show.
#[derive(Debug, PartialEq, Eq)]
pub enum NoPages {
    /// `LibreOffice` isn't on this computer.
    NoOffice,
    /// It took longer than [`CONVERT_LIMIT`].
    TooSlow,
    /// `LibreOffice` couldn't turn it into a PDF.
    Failed,
}

/// The PDF of `file`'s pages, made now or kept from before. Blocking: it may run `LibreOffice`.
///
/// # Errors
/// Says why there are no pages: no `LibreOffice`, too slow, or a file it couldn't read.
pub fn pages(file: &Path) -> Result<PathBuf, NoPages> {
    let folder = INSTALLED
        .get()
        .cloned()
        .unwrap_or_else(|| std::env::temp_dir().join("loomwatch-pages"));
    pages_in(
        file,
        &folder,
        crate::platform::office_program,
        CONVERT_LIMIT,
    )
}

/// [`pages`], kept in `folder`, with the `LibreOffice` that `office` finds, given `limit`. It is
/// looked for only when the pages aren't kept already.
fn pages_in(
    file: &Path,
    folder: &Path,
    office: impl FnOnce() -> Option<PathBuf>,
    limit: Duration,
) -> Result<PathBuf, NoPages> {
    let kept = folder.join(format!("{}.pdf", key(file)));
    if kept.is_file() {
        return Ok(kept);
    }
    let program = office().ok_or(NoPages::NoOffice)?;
    let _turn = ONE_AT_A_TIME
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // Made while this one waited its turn.
    if kept.is_file() {
        return Ok(kept);
    }
    let work = folder.join(format!("{}.work", key(file)));
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).map_err(|_| NoPages::Failed)?;
    let made = convert(&program, file, &folder.join("profile"), &work, limit);
    let result = made.and_then(|pdf| {
        std::fs::rename(&pdf, &kept)
            .map(|()| kept.clone())
            .map_err(|_| NoPages::Failed)
    });
    let _ = std::fs::remove_dir_all(&work);
    result
}

/// Where `pages` keeps the PDF of `file`'s pages, for a test to lay one down as if made before.
#[cfg(test)]
pub(crate) fn kept_for(file: &Path) -> PathBuf {
    let folder = INSTALLED
        .get()
        .cloned()
        .unwrap_or_else(|| std::env::temp_dir().join("loomwatch-pages"));
    folder.join(format!("{}.pdf", key(file)))
}

/// What a file's pages are kept under: its path, size and last change, so a changed file is
/// converted again and an unchanged one never is.
fn key(file: &Path) -> String {
    let metadata = std::fs::metadata(file).ok();
    let size = metadata.as_ref().map_or(0, std::fs::Metadata::len);
    let changed = metadata
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|at| at.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |at| at.as_nanos());
    let mut hash = Sha256::new();
    hash.update(file.to_string_lossy().as_bytes());
    hash.update(size.to_le_bytes());
    hash.update(changed.to_le_bytes());
    let mut name = String::with_capacity(32);
    for byte in &hash.finalize()[..16] {
        let _ = write!(name, "{byte:02x}");
    }
    name
}

/// Runs `LibreOffice` on `file`, writing its PDF into `work` within `limit`, and answers where it is.
fn convert(
    program: &Path,
    file: &Path,
    profile: &Path,
    work: &Path,
    limit: Duration,
) -> Result<PathBuf, NoPages> {
    let profile_url = url::Url::from_directory_path(profile)
        .map_err(|()| NoPages::Failed)?
        .to_string();
    // Hidden slides are kept, so the slide numbers the reader shows are the deck's own.
    let filter = if is_slides(file) {
        r#"pdf:impress_pdf_Export:{"ExportHiddenSlides":{"type":"boolean","value":"true"}}"#
    } else {
        "pdf"
    };
    let mut command = Command::new(program);
    command
        .arg(format!("-env:UserInstallation={profile_url}"))
        .args([
            "--headless",
            "--norestore",
            "--nolockcheck",
            "--convert-to",
            filter,
            "--outdir",
        ])
        .arg(work)
        .arg(file)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        // The daemon has no console of its own, so a program it starts would open a window.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    // Its own process group, so whatever it starts is ended with it.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|_| NoPages::Failed)?;
    let tree = crate::platform::ProcessTree::adopt_std(&child);
    let stop_by = Instant::now() + limit;
    let ended = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status.success()),
            Ok(None) if Instant::now() < stop_by => std::thread::sleep(Duration::from_millis(50)),
            _ => break None,
        }
    };
    let Some(well) = ended else {
        #[cfg(unix)]
        let _ = Command::new("kill")
            .args(["-KILL", "--", &format!("-{}", child.id())])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        tree.end();
        let _ = child.kill();
        let _ = child.wait();
        return Err(NoPages::TooSlow);
    };
    // Named after the file, whatever dots its name has: deck.v2.pptx becomes deck.v2.pdf.
    let stem = file.file_stem().unwrap_or_default().to_string_lossy();
    let pdf = work.join(format!("{stem}.pdf"));
    if well && pdf.is_file() {
        Ok(pdf)
    } else {
        Err(NoPages::Failed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{fake_program, sh_path};

    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "lw-pages-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&path).expect("scratch folder");
            Self(path)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Stands in for `LibreOffice`: runs `first`, then writes a PDF named after the file into the
    /// folder after `--outdir`, and notes what it was given in `ran.log`.
    fn stand_in(scratch: &Path, first: &str) -> PathBuf {
        let log = sh_path(&scratch.join("ran.log"));
        fake_program(
            &scratch.join("soffice"),
            &format!(
                "#!/bin/sh\necho \"$@\" >> '{log}'\nfor last in \"$@\"; do :; done\n\
                 while [ \"$1\" != --outdir ]; do shift; done\nname=$(basename \"$last\")\n{first}\n\
                 printf '%%PDF-1.4 %s' \"$name\" > \"$2/${{name%.*}}.pdf\"\n"
            ),
        )
    }

    #[test]
    fn a_deck_becomes_its_pages_once_until_it_changes() {
        let scratch = Scratch::new();
        let deck = scratch.0.join("deck.v2.pptx");
        std::fs::write(&deck, b"slides").expect("write the deck");
        let office = stand_in(&scratch.0, "");
        let folder = scratch.0.join("pages");
        let made = pages_in(&deck, &folder, || Some(office.clone()), CONVERT_LIMIT).expect("pages");
        assert_eq!(
            std::fs::read(&made).expect("read the pages"),
            b"%PDF-1.4 deck.v2.pptx"
        );
        let ran = std::fs::read_to_string(scratch.0.join("ran.log")).expect("read the log");
        assert!(ran.contains("--headless"), "{ran}");
        assert!(
            ran.contains("ExportHiddenSlides"),
            "hidden slides kept: {ran}"
        );
        assert!(
            ran.contains("-env:UserInstallation=file:"),
            "its own profile: {ran}"
        );
        // Kept: asked again, LibreOffice isn't looked for or run again.
        let again = pages_in(&deck, &folder, || panic!("not looked for"), CONVERT_LIMIT);
        assert_eq!(again, Ok(made.clone()));
        // Changed, though no larger: made again, apart from the old.
        std::fs::write(&deck, b"SLIDES").expect("change the deck");
        std::fs::File::options()
            .write(true)
            .open(&deck)
            .and_then(|file| {
                file.set_modified(std::time::SystemTime::now() + Duration::from_secs(60))
            })
            .expect("the deck changed later");
        let changed = pages_in(&deck, &folder, || Some(office.clone()), CONVERT_LIMIT);
        assert!(
            changed.as_ref().is_ok_and(|changed| *changed != made),
            "{changed:?}"
        );
        // No work folder is left behind.
        let left = std::fs::read_dir(&folder)
            .expect("read the pages folder")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".work"))
            .count();
        assert_eq!(left, 0);
    }

    #[test]
    fn a_word_document_becomes_its_pages_without_the_slides_option() {
        let scratch = Scratch::new();
        let letter = scratch.0.join("letter.docx");
        std::fs::write(&letter, b"words").expect("write the letter");
        let office = stand_in(&scratch.0, "");
        let made = pages_in(
            &letter,
            &scratch.0.join("pages"),
            || Some(office.clone()),
            CONVERT_LIMIT,
        );
        assert!(made.is_ok(), "{made:?}");
        let ran = std::fs::read_to_string(scratch.0.join("ran.log")).expect("read the log");
        assert!(ran.contains("--convert-to pdf "), "{ran}");
        assert!(!ran.contains("ExportHiddenSlides"), "{ran}");
    }

    #[test]
    fn without_libreoffice_or_when_it_fails_or_stalls_there_are_no_pages() {
        let scratch = Scratch::new();
        let deck = scratch.0.join("deck.pptx");
        std::fs::write(&deck, b"slides").expect("write the deck");
        let folder = scratch.0.join("pages");
        assert_eq!(
            pages_in(&deck, &folder, || None, CONVERT_LIMIT),
            Err(NoPages::NoOffice)
        );
        let broken = stand_in(&scratch.0, "exit 1");
        assert_eq!(
            pages_in(&deck, &folder, || Some(broken.clone()), CONVERT_LIMIT),
            Err(NoPages::Failed)
        );
        let stalls = stand_in(&scratch.0, "sleep 30");
        let started = Instant::now();
        assert_eq!(
            pages_in(
                &deck,
                &folder,
                || Some(stalls.clone()),
                Duration::from_millis(300)
            ),
            Err(NoPages::TooSlow)
        );
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "stopped, not waited for"
        );
    }

    #[test]
    fn only_slides_and_documents_have_pages() {
        for name in [
            "a.pptx", "a.PPT", "a.odp", "a.docx", "a.doc", "a.odt", "a.rtf",
        ] {
            assert!(has_pages(Path::new(name)), "{name}");
        }
        for name in ["a.pdf", "a.xlsx", "a.html", "a.key"] {
            assert!(!has_pages(Path::new(name)), "{name}");
        }
        assert!(is_slides(Path::new("a.pptx")) && !is_slides(Path::new("a.docx")));
    }
}
