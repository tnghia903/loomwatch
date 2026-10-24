//! Reading the files people have, the way an agent needs them: a PDF's text; Word, Excel and
//! `PowerPoint` files as text; an email's headers and words; and pictures, for a model that can
//! look at them.
//!
//! The readers are part of `LoomWatch`, so they read the same on every computer and nothing has to
//! be installed. A file can come from anywhere, and a damaged or hostile one could keep a reader
//! busy for a long time or make it take a great deal of memory (ADR 0048). So the daemon reads each
//! file in a short-lived copy of itself, `loomwatchd read-document <file>` ([`use_helper`]): it is
//! stopped at [`DEADLINE`], whatever it starts goes with it, and when it fails only it does.
//! Without that program (tests, the library on its own) a file is read here, on a thread of its
//! own, with the same time limit.

use std::fmt::Write as _;
use std::fs;
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::{Arc, PoisonError, RwLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

mod email;
mod excel;
mod office;
mod pdf;
mod picture;

/// How long reading one file may take.
pub const DEADLINE: Duration = Duration::from_secs(30);
/// The most text kept from one document. It is far more than a model reads at once: it reads the
/// text in parts.
pub const MAX_TEXT_BYTES: usize = 8 * 1024 * 1024;
/// The longest side a picture is sent with: the most the current Claude models take in. A larger
/// picture is shrunk to it, which the provider would otherwise do itself after every upload.
pub const PICTURE_LONG_SIDE: u32 = 2576;
/// The largest picture sent as it is. Anthropic takes at most 5 MB of base64 for one picture.
pub const PICTURE_MAX_BYTES: usize = 3_750_000;
/// The largest document read.
const MAX_DOCUMENT_BYTES: u64 = 200 * 1024 * 1024;
/// The largest picture file read.
const MAX_PICTURE_FILE_BYTES: u64 = 50 * 1024 * 1024;
/// The most one part of an Office file (the document, a slide, its notes) is read to.
const MAX_PART_BYTES: u64 = 128 * 1024 * 1024;
/// The most an Office file may hold once unpacked.
const MAX_UNPACKED_BYTES: u128 = 1024 * 1024 * 1024;

/// The kinds of file read here. Twin: `ui/src/island/readable.ts`, which turns away at the notch
/// what an agent can't open; a kind read here is taken there too.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Pdf,
    Word,
    Excel,
    PowerPoint,
    /// An email (`.eml`), as Mail hands over a message dragged out of it.
    Email,
    /// PNG, JPEG, GIF or `WebP`: the formats every provider takes.
    Picture,
    /// A Word or `PowerPoint` file in the format from before 2007, which isn't read.
    OldOffice,
    /// An iPhone photo in HEIC, which no provider takes.
    Heic,
}

impl Kind {
    /// The kind `path` is, by its extension or, without a known one, by its first bytes. `None`:
    /// text, or a file none of these readers is for.
    #[must_use]
    pub fn of(path: &Path) -> Option<Self> {
        let extension = path
            .extension()
            .map(|extension| extension.to_string_lossy().to_ascii_lowercase());
        let by_name = match extension.as_deref() {
            Some("pdf") => Some(Self::Pdf),
            Some("docx" | "docm" | "dotx") => Some(Self::Word),
            Some("xlsx" | "xlsm" | "xlsb" | "xls" | "ods") => Some(Self::Excel),
            Some("pptx" | "pptm" | "ppsx") => Some(Self::PowerPoint),
            Some("eml") => Some(Self::Email),
            Some("png" | "jpg" | "jpeg" | "gif" | "webp") => Some(Self::Picture),
            Some("doc" | "ppt" | "pps") => Some(Self::OldOffice),
            Some("heic" | "heif") => Some(Self::Heic),
            _ => None,
        };
        by_name.or_else(|| {
            let mut start = [0_u8; 12];
            let read = fs::File::open(path)
                .and_then(|mut file| file.read(&mut start))
                .unwrap_or(0);
            by_content(&start[..read])
        })
    }

    /// Whether it is read as text.
    #[must_use]
    pub fn has_text(self) -> bool {
        matches!(
            self,
            Self::Pdf | Self::Word | Self::Excel | Self::PowerPoint | Self::Email
        )
    }

    /// What a person calls it.
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::Pdf => "PDF",
            Self::Word => "Word",
            Self::Excel => "Excel",
            Self::PowerPoint => "PowerPoint",
            Self::Email => "Email",
            Self::Picture | Self::Heic => "Picture",
            Self::OldOffice => "Office",
        }
    }
}

fn by_content(start: &[u8]) -> Option<Kind> {
    let picture = start.starts_with(b"\x89PNG\r\n\x1a\n")
        || start.starts_with(&[0xff, 0xd8, 0xff])
        || start.starts_with(b"GIF8")
        || (start.starts_with(b"RIFF") && start.get(8..12) == Some(b"WEBP"));
    if start.starts_with(b"%PDF-") {
        Some(Kind::Pdf)
    } else if picture {
        Some(Kind::Picture)
    } else {
        None
    }
}

/// A file read: a document's text, or a picture ready to send.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Document {
    Text { text: String },
    Picture(Picture),
}

/// A picture as a model is sent it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Picture {
    /// `PNG`, `JPEG`, `GIF` or `WebP`, as it is sent.
    pub format: String,
    /// `image/png`, `image/jpeg`, `image/gif` or `image/webp`.
    pub media_type: String,
    /// Its bytes, in standard base64.
    pub data: String,
    pub width: u32,
    pub height: u32,
    /// Its size in the file, before any shrinking.
    pub original_width: u32,
    pub original_height: u32,
}

/// What `loomwatchd read-document` answers.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Answer {
    Read(Document),
    Refused(String),
}

static HELPER: RwLock<Option<PathBuf>> = RwLock::new(None);

/// Read every file in a copy of `program`, which answers `read-document <file>` with [`answer`].
/// The daemon names itself here when it starts.
pub fn use_helper(program: PathBuf) {
    *HELPER.write().unwrap_or_else(PoisonError::into_inner) = Some(program);
}

/// What `loomwatchd read-document <file>` prints: the file read, as one line of JSON.
#[must_use]
pub fn answer(path: &Path) -> String {
    let answer = match read_here(path) {
        Ok(document) => Answer::Read(document),
        Err(reason) => Answer::Refused(reason),
    };
    serde_json::to_string(&answer)
        .unwrap_or_else(|_| r#"{"refused":"The file couldn't be read."}"#.to_owned())
}

/// `path` read: a document's text or a picture.
///
/// # Errors
///
/// Why it can't be, in sentences an agent passes on: not a kind read here, scanned pages with no
/// text, locked with a password, too big, too slow to read, or damaged.
pub fn read(path: &Path) -> Result<Document, String> {
    let helper = HELPER
        .read()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    match helper {
        Some(program) => read_with(&program, path, DEADLINE),
        None => read_on_thread(path, DEADLINE),
    }
}

/// `path`'s text, for a kind that [`Kind::has_text`].
///
/// # Errors
///
/// As [`read`], and when `path` is a picture.
pub fn text(path: &Path) -> Result<String, String> {
    match read(path)? {
        Document::Text { text } => Ok(text),
        Document::Picture(_) => Err(format!("{} is a picture, not a document.", name(path))),
    }
}

fn read_with(program: &Path, path: &Path, deadline: Duration) -> Result<Document, String> {
    let mut command = Command::new(program);
    command.arg("read-document").arg(path);
    // JSON escapes text and base64 enlarges a picture, so the answer may be larger than either.
    let limit = 2 * MAX_TEXT_BYTES + 2 * PICTURE_MAX_BYTES;
    let output =
        bounded_output(&mut command, deadline, limit).map_err(|stopped| match stopped {
            Stopped::Late => too_slow(path),
            Stopped::Failed => damaged(path),
        })?;
    match serde_json::from_slice::<Answer>(&output) {
        Ok(Answer::Read(document)) => Ok(document),
        Ok(Answer::Refused(reason)) => Err(reason),
        Err(_) => Err(damaged(path)),
    }
}

fn read_on_thread(path: &Path, deadline: Duration) -> Result<Document, String> {
    let (sender, receiver) = std::sync::mpsc::channel();
    let owned = path.to_path_buf();
    std::thread::spawn(move || {
        let _ = sender.send(read_here(&owned));
    });
    match receiver.recv_timeout(deadline) {
        Ok(read) => read,
        Err(RecvTimeoutError::Timeout) => Err(too_slow(path)),
        // The reader panicked.
        Err(RecvTimeoutError::Disconnected) => Err(damaged(path)),
    }
}

fn too_slow(path: &Path) -> String {
    format!(
        "{} took longer than {} seconds to read, so LoomWatch stopped. It may be very large or \
         damaged.",
        name(path),
        DEADLINE.as_secs()
    )
}

fn damaged(path: &Path) -> String {
    format!(
        "{} couldn't be read: it may be damaged, or made by a program LoomWatch's reader doesn't \
         follow.",
        name(path)
    )
}

fn name(path: &Path) -> String {
    path.file_name().map_or_else(
        || path.display().to_string(),
        |name| name.to_string_lossy().into_owned(),
    )
}

/// `path` read in this process. [`read`] runs it where a bad file costs nothing else.
///
/// # Errors
///
/// As [`read`].
pub fn read_here(path: &Path) -> Result<Document, String> {
    let name = name(path);
    let kind = Kind::of(path)
        .ok_or_else(|| format!("{name} isn't a document or a picture LoomWatch reads."))?;
    let size = fs::metadata(path)
        .map_err(|error| format!("{name} couldn't be read: {error}"))?
        .len();
    let text = match kind {
        Kind::OldOffice => {
            return Err(format!(
                "{name} is in the old Office format from before 2007, which LoomWatch can't read. \
                 Ask the person to save it as a .docx or .pptx file."
            ));
        }
        Kind::Heic => {
            return Err(format!(
                "{name} is a HEIC photo, which can't be sent to a model. Ask the person to save it \
                 as a JPEG."
            ));
        }
        Kind::Picture => return picture::read(path, &name, size).map(Document::Picture),
        _ if size > MAX_DOCUMENT_BYTES => {
            return Err(format!(
                "{name} is {} MB, more than the {} MB LoomWatch reads.",
                size / 1024 / 1024,
                MAX_DOCUMENT_BYTES / 1024 / 1024
            ));
        }
        Kind::Pdf => pdf::text(path, &name)?,
        Kind::Word => office::word(path, &name)?,
        Kind::Excel => excel::text(path, &name)?,
        Kind::PowerPoint => office::powerpoint(path, &name)?,
        Kind::Email => email::text(path, &name)?,
    };
    let text = tidy(&text);
    if text.is_empty() {
        return Err(format!("{name} has no text in it."));
    }
    Ok(Document::Text {
        text: within_limit(text, &name),
    })
}

/// Lines without trailing spaces, at most one blank line in a row, and none at either end.
fn tidy(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut blank = 0;
    for line in text
        .replace("\r\n", "\n")
        .replace(['\r', '\u{c}'], "\n")
        .lines()
    {
        let line = line.trim_end();
        if line.is_empty() {
            blank += 1;
            continue;
        }
        if !out.is_empty() {
            out.push_str(if blank > 0 { "\n\n" } else { "\n" });
        }
        blank = 0;
        out.push_str(line);
    }
    out
}

fn within_limit(mut text: String, name: &str) -> String {
    if text.len() <= MAX_TEXT_BYTES {
        return text;
    }
    let cut = text.floor_char_boundary(MAX_TEXT_BYTES);
    text.truncate(cut);
    let _ = write!(
        text,
        "\n… The rest of {name} is past the {} MB of text LoomWatch reads from one file.",
        MAX_TEXT_BYTES / 1024 / 1024
    );
    text
}

// Bounded programs --------------------------------------------------------------------------------

/// Why a bounded program gave no output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stopped {
    /// It ran past its deadline.
    Late,
    /// It couldn't start, or it failed.
    Failed,
}

/// Starts `command`, trying again for a moment while its program file is busy. Linux refuses to run
/// a file that some process still holds open for writing ("text file busy"), and a process forked
/// while the file was being written holds it until it execs. CI met this when a test wrote a stand-in
/// program while other tests started processes.
fn spawn_when_not_busy(command: &mut Command) -> Option<std::process::Child> {
    for _ in 0..20 {
        match command.spawn() {
            Ok(child) => return Some(child),
            Err(error) if error.kind() == std::io::ErrorKind::ExecutableFileBusy => {
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => return None,
        }
    }
    None
}

/// Run `command` for at most `deadline`, keeping at most `limit` bytes of what it writes. A program
/// that writes more is stopped once the limit is read, and what was read is kept.
fn bounded_output(
    command: &mut Command,
    deadline: Duration,
    limit: usize,
) -> Result<Vec<u8>, Stopped> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        // The daemon has no console of its own, so a program it starts would open a window.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = spawn_when_not_busy(command).ok_or(Stopped::Failed)?;
    // Whatever it starts goes with it: on Windows a `.cmd` is cmd.exe running the real program,
    // which would otherwise keep writing into the pipe after cmd.exe is stopped.
    let mut tree = Some(crate::platform::ProcessTree::adopt_std(&child));
    let stdout = child.stdout.take().ok_or(Stopped::Failed)?;
    let full = Arc::new(AtomicBool::new(false));
    let reader = {
        let full = Arc::clone(&full);
        std::thread::spawn(move || {
            let mut text = Vec::new();
            // The pipe stays open until the limit is recorded: closing it stops the program, and
            // its exit must not be seen before we know it was stopped for having said enough.
            let mut pipe = stdout.take(u64::try_from(limit).unwrap_or(u64::MAX).saturating_add(1));
            let _ = pipe.read_to_end(&mut text);
            if text.len() > limit {
                text.truncate(limit);
                full.store(true, Ordering::Release);
            }
            drop(pipe);
            text
        })
    };
    let stop_by = Instant::now() + deadline;
    let ended = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status.success()),
            // Enough output: the rest is never read, so the program is stopped rather than left
            // blocked on a full pipe.
            Ok(None) if full.load(Ordering::Acquire) => {
                if let Some(tree) = tree.take() {
                    tree.end();
                }
                let _ = child.kill();
                let _ = child.wait();
                break Ok(true);
            }
            Ok(None) if Instant::now() < stop_by => {
                std::thread::sleep(Duration::from_millis(20));
            }
            waited => {
                if let Some(tree) = tree.take() {
                    tree.end();
                }
                let _ = child.kill();
                let _ = child.wait();
                break Err(if waited.is_err() {
                    Stopped::Failed
                } else {
                    Stopped::Late
                });
            }
        }
    };
    let text = reader.join().map_err(|_| Stopped::Failed)?;
    // Asked once the reader is done: a program stopped by the pipe closing behind the limit still
    // gave enough, though it may exit before the reader has said so.
    match ended {
        Ok(well) if well || full.load(Ordering::Acquire) => Ok(text),
        Ok(_) => Err(Stopped::Failed),
        Err(stopped) => Err(stopped),
    }
}

#[cfg(test)]
mod tests;
