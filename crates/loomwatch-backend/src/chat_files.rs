//! Files the operator puts in a team's chat (ADR 0082): pasted or dropped into the message box,
//! copied beside the team file under `<team>.files/chat/`, and sent with a message.
//!
//! The agents are handed them by path, in the words of the message, so every agent the work
//! reaches can find them and may open them without asking (`PermissionPolicy::for_run_agent`).
//! The agent the message reaches first is also shown its pictures with the words, when its model
//! can see pictures ([`pictures`]).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::chosen_knowledge;
use crate::documents::Kind;

/// The most files one message carries.
pub const MAX_FILES: usize = 10;

/// The folder inside `<team>.files/` the chat's files are copied into.
const FOLDER: &str = "chat";

/// `teams/trip.yaml` → `teams/trip.files/chat`: where the chat's files are kept, beside the team
/// file, so they are the operator's and go to the trash with the team.
#[must_use]
pub fn folder(team_file: &Path) -> PathBuf {
    chosen_knowledge::files_folder(team_file).join(FOLDER)
}

/// A file sent with a chat message, as the chat shows it and the agents are handed it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatFile {
    /// Its name in the chat's folder: the uploaded name, numbered when another file had it.
    pub name: String,
    /// Its full path.
    pub path: String,
    pub bytes: u64,
    /// PNG, JPEG, GIF or `WebP`: shown in the chat, and to an agent whose model sees pictures.
    pub picture: bool,
}

impl ChatFile {
    fn at(path: &Path) -> Option<Self> {
        let metadata = std::fs::metadata(path)
            .ok()
            .filter(std::fs::Metadata::is_file)?;
        Some(Self {
            name: path.file_name()?.to_string_lossy().into_owned(),
            path: path.to_string_lossy().into_owned(),
            bytes: metadata.len(),
            picture: Kind::of(path) == Some(Kind::Picture),
        })
    }
}

/// A file a message names, as the message box sends it: by the path its upload answered with.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SentFile {
    pub path: String,
}

/// Copy an uploaded file into the team's chat folder. An identical file already there is reused.
///
/// # Errors
///
/// The reason, when the name is unusable, the file is too large or it can't be written.
pub fn store(team_file: &Path, requested_name: &str, bytes: &[u8]) -> Result<ChatFile, String> {
    let within = chosen_knowledge::files_folder(team_file);
    let (folder, stored) = chosen_knowledge::save_unique(&within, FOLDER, requested_name, bytes)?;
    ChatFile::at(&folder.join(&stored)).ok_or_else(|| format!("{stored} could not be saved"))
}

/// The files a message names, each checked to be one the chat stored for this team. A message
/// can't name any other path: every agent of the team may read what it names without asking.
///
/// # Errors
///
/// The reason, for more than [`MAX_FILES`] files or one that isn't in the team's chat folder.
pub fn check(team_file: &Path, sent: &[SentFile]) -> Result<Vec<ChatFile>, String> {
    if sent.len() > MAX_FILES {
        return Err(format!("A message can carry at most {MAX_FILES} files."));
    }
    if sent.is_empty() {
        return Ok(Vec::new());
    }
    let kept = crate::platform::canonicalize(folder(team_file))
        .map_err(|_| "Those files aren't in this team's chat. Add them again.".to_owned())?;
    let mut files: Vec<ChatFile> = Vec::with_capacity(sent.len());
    for file in sent {
        let found = crate::platform::canonicalize(Path::new(file.path.trim()))
            .ok()
            .filter(|path| path.parent() == Some(kept.as_path()))
            .and_then(|path| ChatFile::at(&path))
            .ok_or_else(|| {
                format!(
                    "{} isn't in this team's chat. Add it again.",
                    file.path.rsplit(['/', '\\']).next().unwrap_or(&file.path)
                )
            })?;
        if !files.iter().any(|kept| kept.path == found.path) {
            files.push(found);
        }
    }
    Ok(files)
}

/// The words an agent is handed: the message's, then where its files are.
#[must_use]
pub fn with_files(text: &str, files: &[ChatFile]) -> String {
    if files.is_empty() {
        return text.to_owned();
    }
    let listed = files
        .iter()
        .map(|file| {
            let kind = if file.picture { ", a picture" } else { "" };
            format!("- {}{kind}: {}", file.name, file.path)
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!("{text}\n\nFiles sent with this message, which you may open:\n{listed}")
}

/// The pictures among a message's files, shown to the agent it reaches first with its words.
#[must_use]
pub fn pictures(files: &[ChatFile]) -> Vec<PathBuf> {
    files
        .iter()
        .filter(|file| file.picture)
        .map(|file| PathBuf::from(&file.path))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::png;

    fn png_of(width: u32, height: u32) -> Vec<u8> {
        png(width, height, false)
    }

    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("loomwatch-chat-files-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).expect("scratch dir");
            Self(crate::platform::canonicalize(path).expect("canonical scratch dir"))
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn team(dir: &Scratch) -> PathBuf {
        let team = dir.0.join("trip.yaml");
        std::fs::write(&team, "team: {}\n").unwrap();
        team
    }

    fn sent(file: &ChatFile) -> SentFile {
        SentFile {
            path: file.path.clone(),
        }
    }

    #[test]
    fn a_stored_file_is_kept_beside_the_team_and_reused_when_the_same() {
        let dir = Scratch::new();
        let team = team(&dir);
        let first = store(&team, "Screen Shot.png", &png_of(4, 3)).unwrap();
        assert_eq!(first.name, "Screen Shot.png");
        assert_eq!(
            Path::new(&first.path),
            dir.0
                .join("trip.files")
                .join("chat")
                .join("Screen Shot.png")
        );
        assert!(first.picture);
        // The same bytes are the same file; other bytes under the name get a number.
        assert_eq!(
            store(&team, "Screen Shot.png", &png_of(4, 3)).unwrap(),
            first
        );
        let other = store(&team, "Screen Shot.png", &png_of(5, 3)).unwrap();
        assert_eq!(other.name, "Screen Shot (2).png");
        let notes = store(&team, "../notes.txt", b"hello").unwrap();
        assert_eq!(notes.name, "notes.txt");
        assert!(!notes.picture);
        assert_eq!(notes.bytes, 5);
    }

    #[test]
    fn a_message_names_only_files_the_chat_stored_for_its_team() {
        let dir = Scratch::new();
        let team = team(&dir);
        let shot = store(&team, "shot.png", &png_of(4, 3)).unwrap();
        assert_eq!(
            check(&team, &[sent(&shot), sent(&shot)]).unwrap(),
            vec![shot.clone()]
        );
        // A file anywhere else, even beside the team file, would be read without asking.
        let outside = dir.0.join("secret.txt");
        std::fs::write(&outside, "no").unwrap();
        let named = |path: &Path| SentFile {
            path: path.to_string_lossy().into_owned(),
        };
        assert!(check(&team, &[named(&outside)]).is_err());
        let sneaky = folder(&team).join("..").join("..").join("secret.txt");
        assert!(check(&team, &[named(&sneaky)]).is_err());
        assert!(check(&team, &[named(&folder(&team).join("gone.png"))]).is_err());
        // Another team's chat file is not this team's.
        let other = dir.0.join("other.yaml");
        std::fs::write(&other, "team: {}\n").unwrap();
        let theirs = store(&other, "theirs.txt", b"x").unwrap();
        assert!(check(&team, &[sent(&theirs)]).is_err());
        let many = vec![sent(&shot); MAX_FILES + 1];
        assert!(check(&team, &many).unwrap_err().contains("at most"));
    }

    #[test]
    fn the_agent_is_told_where_each_file_is_and_shown_the_pictures() {
        let shot = ChatFile {
            name: "shot.png".into(),
            path: "/teams/trip.files/chat/shot.png".into(),
            bytes: 10,
            picture: true,
        };
        let brief = ChatFile {
            name: "brief.pdf".into(),
            path: "/teams/trip.files/chat/brief.pdf".into(),
            bytes: 10,
            picture: false,
        };
        assert_eq!(with_files("Fix this", &[]), "Fix this");
        assert_eq!(
            with_files("Fix this", &[shot.clone(), brief.clone()]),
            "Fix this\n\nFiles sent with this message, which you may open:\n\
             - shot.png, a picture: /teams/trip.files/chat/shot.png\n\
             - brief.pdf: /teams/trip.files/chat/brief.pdf"
        );
        assert_eq!(
            pictures(&[shot, brief]),
            vec![PathBuf::from("/teams/trip.files/chat/shot.png")]
        );
    }
}
