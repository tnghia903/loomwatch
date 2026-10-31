//! Changing a file in the reader, and the copies kept before every change so it can be put back
//! (ADR 0107).
//!
//! `PUT /api/files/write` writes the bytes the reader sends into a file it may change
//! ([`crate::files::writable`]). The request names, in `If-Match`, the version of the file the
//! change was made on ([`crate::files::version_of`]); a file that changed on disk since — an agent
//! wrote it again — is not written over, and the reader shows it as it is now.
//!
//! Before a file is written, the file as it was is kept under `<state>/kept/<id>/`, with a note of
//! where it came from and why ([`KeptCopy`]). `POST /api/files/put-back` writes a kept copy back,
//! keeping the file it replaces the same way, so putting back can itself be put back. Kept copies
//! are trimmed as they are added: the newest [`PER_FILE`] of each file, and at most [`MOST_BYTES`]
//! in all, the oldest going first.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::extract::{DefaultBodyLimit, Query, Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse as _, Response};
use axum::routing::{post, put};
use axum::{Json, Router};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};

use crate::api::{ApiError, atomic_write};
use crate::files::{is_text, version_of, writable};

/// The newest copies kept of one file.
pub const PER_FILE: usize = 30;
/// The most every kept copy may take up together, in bytes.
pub const MOST_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// The largest file the reader writes: the largest it is sent whole.
const WRITE_MAX_BYTES: usize = 50 * 1024 * 1024;

/// Why a copy was kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Why {
    /// The person changed the file in the reader.
    Edit,
    /// A kept copy was put back over it.
    PutBack,
    /// An agent's turn that makes the changes left for it (`crate::changes`).
    Changes,
}

/// One kept copy: the file it was, when, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeptCopy {
    pub id: String,
    /// The file it is a copy of, by its full path.
    pub path: PathBuf,
    pub kept_at: String,
    pub size: u64,
    pub why: Why,
}

/// Where kept copies are, and the lock every write to a file through here takes, so a change and
/// a put back never cross.
#[derive(Debug, Clone)]
pub struct Kept {
    root: PathBuf,
    writing: Arc<Mutex<()>>,
}

const NOTE: &str = "kept.json";
const COPY: &str = "file";

impl Kept {
    /// The kept copies in `<state>/kept/`. Nothing is made until a copy is kept.
    #[must_use]
    pub fn open(state_dir: &Path) -> Self {
        Self {
            root: state_dir.join("kept"),
            writing: Arc::default(),
        }
    }

    /// Keep a copy of `file` as it is now, then trim what is kept. Blocking.
    pub(crate) fn keep(&self, file: &Path, why: Why) -> io::Result<KeptCopy> {
        let id = uuid::Uuid::new_v4().simple().to_string();
        let folder = self.root.join(&id);
        std::fs::create_dir_all(&folder)?;
        let kept = (|| -> io::Result<KeptCopy> {
            let size = std::fs::copy(file, folder.join(COPY))?;
            let copy = KeptCopy {
                id: id.clone(),
                path: file.to_path_buf(),
                kept_at: Utc::now().to_rfc3339_opts(SecondsFormat::Nanos, true),
                size,
                why,
            };
            std::fs::write(folder.join(NOTE), serde_json::to_vec(&copy)?)?;
            Ok(copy)
        })();
        if kept.is_err() {
            let _ = std::fs::remove_dir_all(&folder);
        }
        let kept = kept?;
        self.trim(PER_FILE, MOST_BYTES);
        Ok(kept)
    }

    /// The kept copy `id`, and where its bytes are; `None` once it is no longer kept.
    pub(crate) fn find(&self, id: &str) -> Option<(KeptCopy, PathBuf)> {
        // An id is what `keep` made, never a path.
        if id.len() != 32 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        let folder = self.root.join(id);
        let note = std::fs::read(folder.join(NOTE)).ok()?;
        let copy: KeptCopy = serde_json::from_slice(&note).ok()?;
        (copy.id == id).then(|| (copy, folder.join(COPY)))
    }

    /// Every kept copy, oldest first.
    fn all(&self) -> Vec<KeptCopy> {
        let mut copies: Vec<KeptCopy> = std::fs::read_dir(&self.root)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|entry| self.find(&entry.file_name().to_string_lossy()))
            .map(|(copy, _)| copy)
            .collect();
        copies.sort_by(|a, b| a.kept_at.cmp(&b.kept_at));
        copies
    }

    /// Keep the newest `per_file` copies of each file, then drop the oldest until what is kept
    /// takes `most_bytes` at most. A copy that can't be removed now is tried again next time.
    fn trim(&self, per_file: usize, most_bytes: u64) {
        let copies = self.all();
        let mut gone = std::collections::HashSet::new();
        let mut per_path: std::collections::HashMap<&Path, usize> =
            std::collections::HashMap::new();
        for copy in copies.iter().rev() {
            let count = per_path.entry(copy.path.as_path()).or_default();
            *count += 1;
            if *count > per_file {
                gone.insert(copy.id.clone());
            }
        }
        let mut total: u64 = copies
            .iter()
            .filter(|copy| !gone.contains(&copy.id))
            .map(|copy| copy.size)
            .sum();
        for copy in &copies {
            if total <= most_bytes {
                break;
            }
            if gone.insert(copy.id.clone()) {
                total = total.saturating_sub(copy.size);
            }
        }
        for id in gone {
            let _ = std::fs::remove_dir_all(self.root.join(id));
        }
    }
}

/// What a write or a put back answers: the file's version now, which the next change names, and
/// the copy kept of it as it was before, which puts it back.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Written {
    pub(crate) version: String,
    pub(crate) kept: String,
}

/// UTF-8's byte order mark.
const BYTE_ORDER_MARK: &[u8] = b"\xEF\xBB\xBF";

/// Whether the file starts with [`BYTE_ORDER_MARK`].
fn starts_marked(path: &Path) -> bool {
    let mut start = [0_u8; 3];
    std::fs::File::open(path)
        .and_then(|mut file| io::Read::read_exact(&mut file, &mut start))
        .is_ok_and(|()| start == BYTE_ORDER_MARK)
}

/// What a person is told when a file couldn't be saved or put back: plain, with what to do. What
/// went wrong goes to the daemon's log.
fn couldnt(doing: &str, name: &str, why: &dyn std::fmt::Display) -> ApiError {
    eprintln!("warning: could not {doing} {name}: {why}");
    ApiError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        format!("LoomWatch couldn't {doing} {name}. Try again, or open it in its own app."),
    )
}

/// Write `bytes` into the file `requested` names, if it is still the version `was`, keeping the
/// file as it was first. Blocking.
pub(crate) fn write(
    kept: &Kept,
    teams_root: &Path,
    requested: &Path,
    was: &str,
    bytes: &[u8],
) -> Result<Written, ApiError> {
    let resolved = writable(teams_root, requested)?;
    let name = resolved
        .file_name()
        .map_or_else(String::new, |name| name.to_string_lossy().into_owned());
    let _writing = kept
        .writing
        .lock()
        .map_err(|_| couldnt("save", &name, &"the write lock is unavailable"))?;
    let now = version_of(&resolved).map_err(|error| couldnt("save", &name, &error))?;
    if now != was {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            format!(
                "{name} changed since you opened it, so your change wasn't saved. It shows as it is now."
            ),
        ));
    }
    // The reader is sent a text without the byte order mark it may start with; the file keeps it.
    let bytes =
        if is_text(&resolved) && starts_marked(&resolved) && !bytes.starts_with(BYTE_ORDER_MARK) {
            [BYTE_ORDER_MARK, bytes].concat()
        } else {
            bytes.to_vec()
        };
    let copy = kept
        .keep(&resolved, Why::Edit)
        .map_err(|error| couldnt("save", &name, &error))?;
    atomic_write(&resolved, &bytes, false).map_err(|error| couldnt("save", &name, &error))?;
    Ok(Written {
        version: version_of(&resolved).map_err(|error| couldnt("save", &name, &error))?,
        kept: copy.id,
    })
}

/// Write the kept copy `id` back over its file, keeping the file it replaces first. Blocking.
pub(crate) fn put_back(kept: &Kept, teams_root: &Path, id: &str) -> Result<Written, ApiError> {
    let (copy, bytes) = kept.find(id).ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            "That earlier version is no longer kept, so it can't be put back.".to_owned(),
        )
    })?;
    let resolved = writable(teams_root, &copy.path)?;
    let name = resolved
        .file_name()
        .map_or_else(String::new, |name| name.to_string_lossy().into_owned());
    let _writing = kept
        .writing
        .lock()
        .map_err(|_| couldnt("put back", &name, &"the write lock is unavailable"))?;
    let earlier = std::fs::read(&bytes).map_err(|error| couldnt("put back", &name, &error))?;
    let now = kept
        .keep(&resolved, Why::PutBack)
        .map_err(|error| couldnt("put back", &name, &error))?;
    atomic_write(&resolved, &earlier, false).map_err(|error| couldnt("put back", &name, &error))?;
    Ok(Written {
        version: version_of(&resolved).map_err(|error| couldnt("put back", &name, &error))?,
        kept: now.id,
    })
}

#[derive(Clone)]
struct EditState {
    kept: Kept,
    teams_root: Arc<PathBuf>,
}

#[derive(Debug, Deserialize)]
struct FilePath {
    path: PathBuf,
}

#[derive(Debug, Deserialize)]
struct PutBack {
    id: String,
}

/// The routes that change files in the reader. Only `LoomWatch`'s own page sends them: it names
/// itself with `X-LoomWatch-Request`, which no page on another site can send without a preflight
/// the daemon never answers.
pub fn router(kept: Kept, teams_root: &Path) -> Router {
    let state = EditState {
        kept,
        teams_root: Arc::new(
            crate::platform::canonicalize(teams_root).unwrap_or_else(|_| teams_root.to_path_buf()),
        ),
    };
    Router::new()
        .route(
            "/api/files/write",
            put(put_write).layer(DefaultBodyLimit::max(WRITE_MAX_BYTES)),
        )
        .route("/api/files/put-back", post(post_put_back))
        .route_layer(middleware::from_fn(from_loomwatch))
        .with_state(state)
}

async fn from_loomwatch(request: Request, next: Next) -> Response {
    let named = request
        .headers()
        .get("x-loomwatch-request")
        .is_some_and(|value| value == "1");
    if !named || !crate::watch_api::from_this_origin(request.headers()) {
        return ApiError::new(
            StatusCode::FORBIDDEN,
            "Change a file from its reader in LoomWatch.".to_owned(),
        )
        .into_response();
    }
    next.run(request).await
}

/// The version an `If-Match` header names, its quotes and any weak mark taken off.
fn named_version(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(header::IF_MATCH)?.to_str().ok()?.trim();
    let value = value.strip_prefix("W/").unwrap_or(value);
    Some(value.trim_matches('"').to_owned()).filter(|version| !version.is_empty())
}

async fn put_write(
    State(state): State<EditState>,
    Query(query): Query<FilePath>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Json<Written>, ApiError> {
    let was = named_version(&headers).ok_or_else(|| {
        ApiError::new(
            StatusCode::PRECONDITION_REQUIRED,
            "Open the file again in LoomWatch, then change it.".to_owned(),
        )
    })?;
    tokio::task::spawn_blocking(move || {
        write(&state.kept, &state.teams_root, &query.path, &was, &body)
    })
    .await
    .map_err(|error| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
    .map(Json)
}

async fn post_put_back(
    State(state): State<EditState>,
    Json(request): Json<PutBack>,
) -> Result<Json<Written>, ApiError> {
    tokio::task::spawn_blocking(move || put_back(&state.kept, &state.teams_root, &request.id))
        .await
        .map_err(|error| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .map(Json)
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::Body;
    use http_body_util::BodyExt as _;
    use tower::ServiceExt as _;

    /// A teams root with a writer's folder, and a state folder, both removed afterwards.
    struct Place {
        root: PathBuf,
        state: PathBuf,
    }

    impl Place {
        fn new() -> Self {
            let base =
                std::env::temp_dir().join(format!("loomwatch-kept-{}", uuid::Uuid::new_v4()));
            let root = base.join("teams");
            std::fs::create_dir_all(root.join(".loomwatch/team/writer")).expect("workspace");
            std::fs::create_dir_all(base.join("state")).expect("state");
            let base = crate::platform::canonicalize(base).expect("canonical");
            Self {
                root: base.join("teams"),
                state: base.join("state"),
            }
        }

        fn made(&self, name: &str, bytes: &[u8]) -> PathBuf {
            let path = self.root.join(".loomwatch/team/writer").join(name);
            if let Some(folder) = path.parent() {
                std::fs::create_dir_all(folder).expect("folder");
            }
            std::fs::write(&path, bytes).expect("write");
            path
        }

        fn kept(&self) -> Kept {
            Kept::open(&self.state)
        }
    }

    impl Drop for Place {
        fn drop(&mut self) {
            if let Some(base) = self.root.parent() {
                let _ = std::fs::remove_dir_all(base);
            }
        }
    }

    /// **A change is written, and the file as it was is kept first (ADR 0107).** The answer names
    /// the new version, which the next change names, and the kept copy, which puts it back.
    #[test]
    fn writes_a_change_and_keeps_the_file_as_it_was() {
        let place = Place::new();
        let notes = place.made("notes.md", b"Since spring.\n");
        let kept = place.kept();
        let was = version_of(&notes).expect("version");

        let written = write(&kept, &place.root, &notes, &was, b"Since April.\n").expect("write");

        assert_eq!(std::fs::read(&notes).expect("read"), b"Since April.\n");
        assert_eq!(written.version, version_of(&notes).expect("version"));
        assert_ne!(written.version, was);
        let (copy, bytes) = kept.find(&written.kept).expect("kept");
        assert_eq!(
            std::fs::read(bytes).expect("kept bytes"),
            b"Since spring.\n"
        );
        assert_eq!(copy.path, notes);
        assert_eq!(copy.why, Why::Edit);
    }

    /// **A text that starts with a byte order mark keeps it.** The reader is sent the words without
    /// it, so a change it writes back has none.
    #[test]
    fn a_text_keeps_its_byte_order_mark() {
        let place = Place::new();
        let kept = place.kept();
        let notes = place.made("notes.md", "\u{feff}Since spring.\n".as_bytes());
        let was = version_of(&notes).expect("version");
        write(&kept, &place.root, &notes, &was, b"Since April.\n").expect("write");
        assert_eq!(
            std::fs::read(&notes).expect("read"),
            "\u{feff}Since April.\n".as_bytes()
        );

        // A file that had none gets none.
        let plain = place.made("plain.md", b"Since spring.\n");
        let was = version_of(&plain).expect("version");
        write(&kept, &place.root, &plain, &was, b"Since April.\n").expect("write");
        assert_eq!(std::fs::read(&plain).expect("read"), b"Since April.\n");
    }

    /// **A file that changed since it was read is not written over.** An agent wrote it again
    /// meanwhile: the person's change is refused, the file keeps the agent's words, and nothing is
    /// kept for a write that never happened.
    #[test]
    fn refuses_a_change_made_on_an_older_version() {
        let place = Place::new();
        let notes = place.made("notes.md", b"First draft.\n");
        let kept = place.kept();
        let was = version_of(&notes).expect("version");
        std::fs::write(&notes, b"The agent's second draft.\n").expect("agent writes");

        let refused = write(&kept, &place.root, &notes, &was, b"Mine.\n").expect_err("refused");

        assert_eq!(refused.status, StatusCode::CONFLICT);
        assert!(
            refused.message.contains("changed since you opened it"),
            "{}",
            refused.message
        );
        assert_eq!(
            std::fs::read(&notes).expect("read"),
            b"The agent's second draft.\n"
        );
        assert!(kept.all().is_empty());
    }

    /// **Putting back writes the kept copy, and keeps what it replaces,** so the put back can be put
    /// back in turn.
    #[test]
    fn puts_back_a_kept_copy_and_keeps_what_it_replaces() {
        let place = Place::new();
        let notes = place.made("notes.md", b"Before.\n");
        let kept = place.kept();
        let was = version_of(&notes).expect("version");
        let changed = write(&kept, &place.root, &notes, &was, b"After.\n").expect("write");

        let back = put_back(&kept, &place.root, &changed.kept).expect("put back");
        assert_eq!(std::fs::read(&notes).expect("read"), b"Before.\n");
        assert_eq!(back.version, was);
        assert_eq!(kept.find(&back.kept).expect("kept").0.why, Why::PutBack);

        put_back(&kept, &place.root, &back.kept).expect("put back again");
        assert_eq!(std::fs::read(&notes).expect("read"), b"After.\n");
    }

    /// **Only a file an agent made, or one in a folder given to a team, is changed, and only a kind
    /// the reader changes.** Never what `LoomWatch` keeps for an agent, nor a team file.
    #[test]
    fn changes_only_what_an_agent_made_or_was_given() {
        let place = Place::new();
        let kept = place.kept();
        let refused = |path: &Path| {
            let was = version_of(path).expect("version");
            match write(&kept, &place.root, path, &was, b"x") {
                Ok(written) => panic!("{} was written: {written:?}", path.display()),
                Err(error) => error.status,
            }
        };
        let elsewhere = |relative: &str| {
            let path = place.root.join(relative);
            std::fs::create_dir_all(path.parent().expect("folder")).expect("folder");
            std::fs::write(&path, b"words").expect("write");
            path
        };
        // Outside any agent's folder, directly in `.loomwatch/`, or under a hidden folder.
        assert_eq!(
            refused(&elsewhere("projects/plan.md")),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            refused(&elsewhere(".loomwatch/state.md")),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            refused(&elsewhere(".git/.loomwatch/team/writer/notes.md")),
            StatusCode::FORBIDDEN
        );
        let team = place.root.join("team.yaml");
        std::fs::write(&team, "schemaVersion: 1\n").expect("team file");
        assert_eq!(refused(&team), StatusCode::FORBIDDEN);
        assert_eq!(
            refused(&place.made("AGENTS.md", b"notes")),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            refused(&place.made("knowledge/brief.md", b"copy")),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            refused(&place.made(".agents/skills/deck/SKILL.md", b"skill")),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            refused(&place.made("chart.png", b"png")),
            StatusCode::UNPROCESSABLE_ENTITY
        );

        // A deck the writer made, and a sheet, are changed.
        for name in [
            "deck.pptx",
            "table.csv",
            "page.html",
            "data.json",
            "letter.docx",
            "budget.xlsx",
        ] {
            let file = place.made(name, b"before");
            let was = version_of(&file).expect("version");
            write(&kept, &place.root, &file, &was, b"after").expect(name);
        }

        // A file in a folder the person gave a team, outside the teams root.
        let given = place.root.parent().expect("base").join("given");
        std::fs::create_dir_all(given.join(".git")).expect("given folder");
        std::fs::write(
            place.root.join("research.yaml"),
            format!(
                "schemaVersion: 1\nid: research\nentrypoint: researcher\nagents:\n  - id: researcher\n    model: openai/gpt-5.5\n    spawn:\n      cwd: \"{}\"\n",
                given.display()
            ),
        )
        .expect("team file");
        let theirs = given.join("plan.md");
        std::fs::write(&theirs, b"plan").expect("given file");
        let was = version_of(&theirs).expect("version");
        write(&kept, &place.root, &theirs, &was, b"new plan").expect("given folder");
        let hidden = given.join(".git/notes.md");
        std::fs::write(&hidden, b"notes").expect("hidden file");
        assert_eq!(refused(&hidden), StatusCode::FORBIDDEN);
    }

    /// **Kept copies are trimmed as they are added:** the newest of each file, then the oldest
    /// until what is kept fits.
    #[test]
    fn keeps_the_newest_copies_of_each_file_and_drops_the_oldest_past_the_limit() {
        let place = Place::new();
        let kept = place.kept();
        let one = place.made("one.md", b"1234");
        let two = place.made("two.md", b"12345678");
        // Apart in time, so oldest and newest are told apart.
        let keep = |file: &Path| {
            std::thread::sleep(std::time::Duration::from_millis(3));
            kept.keep(file, Why::Edit).expect("keep").id
        };
        let ones: Vec<String> = (0..4).map(|_| keep(&one)).collect();
        let twos: Vec<String> = (0..2).map(|_| keep(&two)).collect();

        kept.trim(3, u64::MAX);
        let left: Vec<String> = kept.all().into_iter().map(|copy| copy.id).collect();
        assert_eq!(
            left,
            [&ones[1..], &twos[..]].concat(),
            "the oldest of one.md goes"
        );

        // 3 × 4 + 2 × 8 = 28 bytes; at most 20 drops the oldest two of one.md and nothing newer.
        kept.trim(3, 20);
        let left: Vec<String> = kept.all().into_iter().map(|copy| copy.id).collect();
        assert_eq!(left, [&ones[3..], &twos[..]].concat());
    }

    /// **An id is only ever one `keep` made,** never a path into the state folder or out of it.
    #[test]
    fn finds_a_kept_copy_by_its_id_only() {
        let place = Place::new();
        let kept = place.kept();
        let notes = place.made("notes.md", b"words");
        let copy = kept.keep(&notes, Why::Edit).expect("keep");
        assert!(kept.find(&copy.id).is_some());
        for id in [
            "../kept",
            "",
            &copy.id[..31],
            &format!("{}/", &copy.id[..31]),
        ] {
            assert!(kept.find(id).is_none(), "{id}");
        }
    }

    /// **Only a copy in the kept folder is found,** even a note elsewhere that names itself by a
    /// path out of it.
    #[test]
    fn finds_no_note_outside_the_kept_folder() {
        let place = Place::new();
        let kept = place.kept();
        let elsewhere = place.state.join("elsewhere");
        std::fs::create_dir_all(&elsewhere).expect("folder");
        let notes = place.made("notes.md", b"words");
        let note = KeptCopy {
            id: "../elsewhere".to_owned(),
            path: notes,
            kept_at: "2026-10-31T00:00:00Z".to_owned(),
            size: 5,
            why: Why::Edit,
        };
        std::fs::write(
            elsewhere.join(NOTE),
            serde_json::to_vec(&note).expect("note"),
        )
        .expect("note");
        std::fs::write(elsewhere.join(COPY), b"other").expect("copy");
        std::fs::create_dir_all(place.state.join("kept")).expect("kept folder");
        assert!(kept.find("../elsewhere").is_none());
    }

    /// **A change sent with the mark keeps one mark,** never two.
    #[test]
    fn a_text_sent_with_its_mark_keeps_one() {
        let place = Place::new();
        let kept = place.kept();
        let notes = place.made("notes.md", "\u{feff}Since spring.\n".as_bytes());
        let was = version_of(&notes).expect("version");
        write(
            &kept,
            &place.root,
            &notes,
            &was,
            "\u{feff}Since April.\n".as_bytes(),
        )
        .expect("write");
        assert_eq!(
            std::fs::read(&notes).expect("read"),
            "\u{feff}Since April.\n".as_bytes()
        );
    }

    async fn send(
        router: Router,
        request: axum::http::Request<Body>,
    ) -> (StatusCode, serde_json::Value) {
        let response = router.oneshot(request).await.expect("response");
        let status = response.status();
        let body = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        (status, serde_json::from_slice(&body).unwrap_or_default())
    }

    /// **Over HTTP, a change comes only from `LoomWatch`'s own page and names the version it was
    /// made on;** the answer's kept copy puts it back.
    #[tokio::test]
    async fn the_routes_write_and_put_back_for_the_reader_only() {
        let place = Place::new();
        let notes = place.made("notes.md", b"Before.\n");
        let was = version_of(&notes).expect("version");
        let request = |version: Option<&str>, ours: bool| {
            let mut request = axum::http::Request::builder()
                .method("PUT")
                .uri(format!("/api/files/write?path={}", notes.display()))
                .header(header::CONTENT_TYPE, "application/octet-stream");
            if ours {
                request = request.header("x-loomwatch-request", "1");
            }
            if let Some(version) = version {
                request = request.header(header::IF_MATCH, format!("\"{version}\""));
            }
            request.body(Body::from("After.\n")).expect("request")
        };
        let routes = || router(place.kept(), &place.root);

        let (status, _) = send(routes(), request(Some(&was), false)).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        // Another site's page, even naming LoomWatch's header, is refused.
        let mut foreign = request(Some(&was), true);
        foreign
            .headers_mut()
            .insert(header::HOST, "localhost:3440".parse().expect("host"));
        foreign.headers_mut().insert(
            header::ORIGIN,
            "https://elsewhere.example".parse().expect("origin"),
        );
        let (status, _) = send(routes(), foreign).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(std::fs::read(&notes).expect("read"), b"Before.\n");
        let (status, _) = send(routes(), request(None, true)).await;
        assert_eq!(status, StatusCode::PRECONDITION_REQUIRED);
        assert_eq!(std::fs::read(&notes).expect("read"), b"Before.\n");

        let (status, written) = send(routes(), request(Some(&was), true)).await;
        assert_eq!(status, StatusCode::OK, "{written}");
        assert_eq!(std::fs::read(&notes).expect("read"), b"After.\n");
        assert_eq!(written["version"], version_of(&notes).expect("version"));

        let (status, again) = send(routes(), request(Some(&was), true)).await;
        assert_eq!(status, StatusCode::CONFLICT, "{again}");

        let back = axum::http::Request::builder()
            .method("POST")
            .uri("/api/files/put-back")
            .header(header::CONTENT_TYPE, "application/json")
            .header("x-loomwatch-request", "1")
            .body(Body::from(
                serde_json::json!({ "id": written["kept"] }).to_string(),
            ))
            .expect("request");
        let (status, back) = send(routes(), back).await;
        assert_eq!(status, StatusCode::OK, "{back}");
        assert_eq!(std::fs::read(&notes).expect("read"), b"Before.\n");
    }
}
