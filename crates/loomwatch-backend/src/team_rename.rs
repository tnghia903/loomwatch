//! Rename moves a team's file (ADR 0099). The team's name and its file name say the same thing, so
//! `trip.yaml` renamed "Kyoto week" becomes `kyoto-week.yaml`, with everything kept beside it and
//! everything filed under its path: the run history, the chat, its search, the files sent in it.
//! The team's `id` never changes, so its notes, lessons, workspace and the teams that read its
//! memory, all filed by id, stay as they are.
//!
//! `api.rs` moves the files (`POST /api/team/rename`); this module re-files what names them.

use std::path::{Path, PathBuf};

use serde_json::Value;
use sqlx::Row;

/// Where Rename moved a team: its path before and after, relative to the teams folder and
/// `/`-separated as the history files it, the key its chat is filed under now, and its own
/// folder of files (`<team>.files`) before and after, in full.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Refile {
    pub from: String,
    pub to: String,
    pub key: String,
    pub files_from: PathBuf,
    pub files_to: PathBuf,
}

impl Refile {
    /// The key the chat was filed under while the team file had no `id` (ADR 0051).
    pub fn path_key(&self) -> String {
        format!("path:{}", self.from)
    }

    /// `path` in its new place, when it is inside the team's own folder of files.
    pub fn moved_file(&self, path: &str) -> Option<String> {
        let rest = Path::new(path).strip_prefix(&self.files_from).ok()?;
        let moved = if rest.as_os_str().is_empty() {
            self.files_to.clone()
        } else {
            self.files_to.join(rest)
        };
        Some(moved.to_string_lossy().into_owned())
    }
}

/// File the team's history under its new path, in one transaction: its runs, the messages in its
/// chat, the chat's search and its reactions. Rows filed by the path alone, from before the team
/// had an `id` or before the key was kept, take the key too, so the chat finds them by it. Files
/// sent in the chat and files its runs made inside the team's own folder are named in full, and
/// are named where they are now.
///
/// # Errors
///
/// Returns an error when the database fails; nothing is changed then.
pub(crate) async fn refile_history(db: &crate::db::Db, refile: &Refile) -> Result<(), sqlx::Error> {
    let path_key = refile.path_key();
    let mut transaction = db.writer().begin().await?;
    sqlx::query(
        "UPDATE runs SET team_path = $2,
             team_key = CASE WHEN team_key IS NULL OR team_key = '' OR team_key = $3
                             THEN $4 ELSE team_key END
         WHERE team_path = $1",
    )
    .bind(&refile.from)
    .bind(&refile.to)
    .bind(&path_key)
    .bind(&refile.key)
    .execute(&mut *transaction)
    .await?;
    for table in ["chat_messages", "work_passages"] {
        sqlx::query(&format!(
            "UPDATE {table} SET team_path = $2,
                 team_key = CASE WHEN team_key = $3 THEN $4 ELSE team_key END
             WHERE team_path = $1"
        ))
        .bind(&refile.from)
        .bind(&refile.to)
        .bind(&path_key)
        .bind(&refile.key)
        .execute(&mut *transaction)
        .await?;
    }
    sqlx::query("UPDATE chat_reactions SET team_key = $2 WHERE team_key = $1")
        .bind(&path_key)
        .bind(&refile.key)
        .execute(&mut *transaction)
        .await?;

    let sent = sqlx::query(
        "SELECT id, files FROM chat_messages WHERE team_path = $1 AND files IS NOT NULL",
    )
    .bind(&refile.to)
    .fetch_all(&mut *transaction)
    .await?;
    for row in sent {
        let files: String = row.try_get("files")?;
        if let Some(moved) = moved_json(&files, refile) {
            sqlx::query("UPDATE chat_messages SET files = $2 WHERE id = $1")
                .bind(row.try_get::<String, _>("id")?)
                .bind(moved)
                .execute(&mut *transaction)
                .await?;
        }
    }
    let made =
        sqlx::query("SELECT run_id, made FROM runs WHERE team_path = $1 AND made IS NOT NULL")
            .bind(&refile.to)
            .fetch_all(&mut *transaction)
            .await?;
    for row in made {
        let files: String = row.try_get("made")?;
        if let Some(moved) = moved_json(&files, refile) {
            sqlx::query("UPDATE runs SET made = $2 WHERE run_id = $1")
                .bind(row.try_get::<String, _>("run_id")?)
                .bind(moved)
                .execute(&mut *transaction)
                .await?;
        }
    }
    transaction.commit().await
}

/// Every team path the history files anything under, so Rename never gives a team a name whose
/// history is another team's.
///
/// # Errors
///
/// Returns an error when the database fails.
pub(crate) async fn filed_team_paths(
    db: &crate::db::Db,
) -> Result<std::collections::BTreeSet<String>, sqlx::Error> {
    sqlx::query_scalar("SELECT team_path FROM runs UNION SELECT team_path FROM chat_messages")
        .fetch_all(db.reader())
        .await
        .map(|paths| paths.into_iter().collect())
}

/// A JSON list of files, each a path or an object with a `path` (`chat_files::ChatFile`), with
/// the ones inside the team's own folder named where they are now; `None` when none moved.
fn moved_json(json: &str, refile: &Refile) -> Option<String> {
    let mut files: Value = serde_json::from_str(json).ok()?;
    let mut moved = false;
    for file in files.as_array_mut()? {
        let path = match file {
            Value::String(path) => path,
            Value::Object(fields) => match fields.get_mut("path") {
                Some(Value::String(path)) => path,
                _ => continue,
            },
            _ => continue,
        };
        if let Some(now) = refile.moved_file(path) {
            *path = now;
            moved = true;
        }
    }
    moved.then(|| files.to_string())
}

/// The folders a team keeps beside its file and names in it: its Brief and the files added to it.
const OWN_FOLDERS: [&str; 2] = ["brief", "files"];

/// `yaml` with each name of the team's own folders changed from `old` to `new`: `trip.brief/`
/// and `trip.files/` become `kyoto-week.brief/` and `kyoto-week.files/`, written relative to the
/// team file (`TEAM_CONFIG.md`) or in full under `folder`, the team file's folder. A name that only
/// ends the same way (`old-trip.files/`) or sits in another folder is left alone.
pub(crate) fn rename_own_folders(yaml: &str, folder: &Path, old: &str, new: &str) -> String {
    let folder = folder.to_string_lossy();
    let mut text = yaml.to_owned();
    for kind in OWN_FOLDERS {
        let from = format!("{old}.{kind}");
        let to = format!("{new}.{kind}");
        for separator in ['/', '\\'] {
            text = text.replace(
                &format!("{folder}{separator}{from}"),
                &format!("{folder}{separator}{to}"),
            );
        }
        text = replace_relative(&text, &from, &to);
    }
    text
}

/// Each `from` in `text` that starts a relative path (`from/…`, `./from/…`) and goes on into the
/// folder, replaced by `to`.
fn replace_relative(text: &str, from: &str, to: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(from) {
        let (before, found) = rest.split_at(at);
        out.push_str(before);
        let after = &found[from.len()..];
        let into_folder = after.starts_with(['/', '\\']);
        let written = &text[..text.len() - rest.len() + at];
        if into_folder && starts_a_path(written) {
            out.push_str(to);
        } else {
            out.push_str(from);
        }
        rest = after;
    }
    out.push_str(rest);
    out
}

/// Whether a relative path can start right after `before`: at the start, after `./`, or after
/// anything that cannot be part of a file name, such as a space, a quote or `:`.
fn starts_a_path(before: &str) -> bool {
    let before = before
        .strip_suffix("./")
        .or_else(|| before.strip_suffix(".\\"))
        .unwrap_or(before);
    before
        .chars()
        .next_back()
        .is_none_or(|last| !(last.is_alphanumeric() || "._-/\\~".contains(last)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refile() -> Refile {
        Refile {
            from: "trip.yaml".to_owned(),
            to: "kyoto-week.yaml".to_owned(),
            key: "trip".to_owned(),
            files_from: PathBuf::from("/teams/trip.files"),
            files_to: PathBuf::from("/teams/kyoto-week.files"),
        }
    }

    #[test]
    fn the_brief_and_added_files_are_named_where_they_move() {
        let yaml = "name: Kyoto week\nmemory:\n  brief:\n    - path: trip.brief/tone.md\n    - path: \"./trip.brief/plan.md\"\nagents:\n  - id: lead\n    capabilities:\n      - { kind: knowledge, name: map.pdf, path: trip.files/map.pdf }\n      - { kind: knowledge, name: old, path: /teams/trip.files/old.pdf }\n";
        let renamed = rename_own_folders(yaml, Path::new("/teams"), "trip", "kyoto-week");
        assert_eq!(
            renamed,
            "name: Kyoto week\nmemory:\n  brief:\n    - path: kyoto-week.brief/tone.md\n    - path: \"./kyoto-week.brief/plan.md\"\nagents:\n  - id: lead\n    capabilities:\n      - { kind: knowledge, name: map.pdf, path: kyoto-week.files/map.pdf }\n      - { kind: knowledge, name: old, path: /teams/kyoto-week.files/old.pdf }\n"
        );
    }

    #[test]
    fn names_that_only_look_alike_are_left_alone() {
        let yaml = "role: Read old-trip.files/notes.md, /elsewhere/trip.files/a.md and trip.briefing, not trip.files.\n";
        assert_eq!(
            rename_own_folders(yaml, Path::new("/teams"), "trip", "kyoto-week"),
            yaml
        );
    }

    #[test]
    fn a_file_inside_the_team_folder_is_named_where_it_is_now() {
        let refile = refile();
        let now = PathBuf::from("/teams/kyoto-week.files")
            .join("chat")
            .join("photo.png");
        let now = now.to_str().expect("UTF-8 path");
        assert_eq!(
            refile
                .moved_file("/teams/trip.files/chat/photo.png")
                .as_deref(),
            Some(now)
        );
        assert_eq!(refile.moved_file("/teams/trip.files2/photo.png"), None);
        assert_eq!(refile.moved_file("/elsewhere/photo.png"), None);
        assert_eq!(
            moved_json(
                r#"[{"name":"photo.png","path":"/teams/trip.files/chat/photo.png","bytes":3,"picture":true},{"name":"x","path":"/elsewhere/x","bytes":1,"picture":false}]"#,
                &refile
            )
            .map(|json| serde_json::from_str::<Value>(&json).expect("JSON")),
            Some(serde_json::json!([
                {"name":"photo.png","path":now,"bytes":3,"picture":true},
                {"name":"x","path":"/elsewhere/x","bytes":1,"picture":false}
            ]))
        );
        assert_eq!(moved_json(r#"["/elsewhere/x"]"#, &refile), None);
    }
}
