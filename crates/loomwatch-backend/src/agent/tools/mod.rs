//! The tools a built-in agent can call itself: files in its folder, commands, its plan, the long
//! tool outputs it set aside, and the pages at links the person wrote.
//!
//! Each tool says up front what it will touch ([`Prepared`]), so the session can ask
//! [`Permissions`](super::Permissions) with the exact paths or command before anything happens.
//! Tools the daemon serves (the Team Bus, Ask's tools) are not here: they come in through
//! [`HostTools`](super::HostTools).

mod command;
mod files;
mod link;

use std::path::{Component, Path, PathBuf};

use serde_json::{Value, json};

use super::events::ToolKind;
use super::provider::{Cancel, Picture, ToolSpec};
use crate::prompt_blocks::Block;

pub(crate) use command::CommandSettings;
pub(crate) use link::{is_among as is_link_among, written_in as links_written_in};

// What each tool says it does, read each time the agent picks a tool.
pub(crate) const LIST_FILES: Block = Block::new(
    "tool.list_files",
    "List the files and folders in a folder. Paths are relative to your work folder.",
);
pub(crate) const READ_FILE: Block = Block::new(
    "tool.read_file",
    "Read a file. Text comes with its lines numbered, and so does the text of a PDF, Word (.docx), \
     Excel (.xlsx, .xls) or PowerPoint (.pptx) file, and an email (.eml) as who wrote to whom, \
     when, its subject and its words. For a long file, read it in parts with offset and limit. A \
     picture (PNG, JPEG, GIF or WebP) is shown to you when the model you run on can see pictures.",
);
pub(crate) const SEARCH_FILES: Block = Block::new(
    "tool.search_files",
    "Search the text of files for a regular expression. Answers with path:line: text for each \
     match.",
);
pub(crate) const WRITE_FILE: Block = Block::new(
    "tool.write_file",
    "Create a file, or replace a file's whole content. Folders are created as needed.",
);
pub(crate) const EDIT_FILE: Block = Block::new(
    "tool.edit_file",
    "Change part of a file: replace old_text, which must appear exactly once, with new_text. Set \
     replace_all to replace every occurrence. Read the file first.",
);
/// What `run_command` says it does: which shell reads the command, and where it may change files,
/// which only the Mac's sandbox enforces.
pub(crate) const RUN_COMMAND: Block = Block::new(
    "tool.run_command",
    if cfg!(windows) {
        "Run a command in your work folder with cmd.exe, such as a script a skill provides. Write \
         it for cmd.exe; for PowerShell, run powershell -NoProfile -Command \"…\". The operator may \
         be asked first. Change files only inside your work folder."
    } else if cfg!(target_os = "macos") {
        "Run a shell command in your work folder, such as a script a skill provides. The operator \
         may be asked first. It can change files only inside your work folder."
    } else {
        "Run a shell command in your work folder, such as a script a skill provides. The operator \
         may be asked first. Change files only inside your work folder."
    },
);
pub(crate) const UPDATE_PLAN: Block = Block::new(
    "tool.update_plan",
    "Keep your plan for this task: the whole list of steps, each pending, in_progress or \
     completed. Send the full list every time it changes.",
);
pub(crate) const READ_TOOL_OUTPUT: Block = Block::new(
    "tool.read_tool_output",
    "Read more of a long tool output that was set aside, by the id the shortened output named.",
);
/// For an agent whose web switch is off (ADR 0104): the web, asked for.
pub(crate) const READ_PAGE: Block = Block::new(
    "tool.read_page",
    "Read the web page, PDF or text at an address. A link the person wrote to you is read at once; \
     any other address asks the person first, and their yes lets you use the web from then on.",
);
pub(crate) const SEARCH_WEB: Block = Block::new(
    "tool.search_web",
    "Search the web. This asks the person first; their yes gives you web search and page reading \
     from your next step.",
);

/// A built-in tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Builtin {
    ListFiles,
    ReadFile,
    SearchFiles,
    WriteFile,
    EditFile,
    RunCommand,
    UpdatePlan,
    ReadToolOutput,
    ReadPage,
    SearchWeb,
}

/// What a tool call will do, worked out before it is allowed.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Prepared {
    pub title: String,
    pub kind: ToolKind,
    pub locations: Vec<PathBuf>,
    /// Whether it needs the operator's policy to allow it. The plan and set-aside outputs don't.
    pub needs_permission: bool,
}

/// A tool's result, as the model reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Output {
    pub text: String,
    pub failed: bool,
    /// Pictures for the model to look at, after the text.
    pub pictures: Vec<Picture>,
}

impl Output {
    pub(crate) fn ok(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            failed: false,
            pictures: Vec::new(),
        }
    }

    pub(crate) fn failed(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            failed: true,
            pictures: Vec::new(),
        }
    }
}

/// Whether a picture `read_file` opens reaches the model, and how many more the conversation may
/// hold.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Pictures {
    /// The model the agent runs on can see pictures.
    pub seen: bool,
    /// How many more pictures the conversation may hold.
    pub room: usize,
    /// How much more picture data the conversation may hold, in base64 bytes.
    pub bytes: usize,
}

/// What a tool runs with.
pub(crate) struct Context<'a> {
    pub cwd: &'a Path,
    /// The folders the operator connected as knowledge ([`resolve_reading`]).
    pub connected: &'a [PathBuf],
    pub cancel: &'a Cancel,
    pub command: &'a CommandSettings,
    pub pictures: Pictures,
    /// The links the person wrote, which `read_page` reads without asking (ADR 0104).
    pub links: &'a [String],
    /// The agent may use the web, so `read_page` reads any address.
    pub web: bool,
}

impl Builtin {
    pub(crate) const ALL: [Self; 10] = [
        Self::ListFiles,
        Self::ReadFile,
        Self::SearchFiles,
        Self::WriteFile,
        Self::EditFile,
        Self::RunCommand,
        Self::UpdatePlan,
        Self::ReadToolOutput,
        Self::ReadPage,
        Self::SearchWeb,
    ];

    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::ListFiles => "list_files",
            Self::ReadFile => "read_file",
            Self::SearchFiles => "search_files",
            Self::WriteFile => "write_file",
            Self::EditFile => "edit_file",
            Self::RunCommand => "run_command",
            Self::UpdatePlan => "update_plan",
            Self::ReadToolOutput => "read_tool_output",
            Self::ReadPage => "read_page",
            Self::SearchWeb => "search_web",
        }
    }

    pub(crate) fn named(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|tool| tool.name() == name)
    }

    /// Whether the tool only reads: it changes nothing, so several of its calls can run at once.
    pub(crate) fn only_reads(self) -> bool {
        matches!(
            self,
            Self::ListFiles
                | Self::ReadFile
                | Self::SearchFiles
                | Self::ReadToolOutput
                | Self::ReadPage
        )
    }

    #[allow(clippy::too_many_lines)] // One table: each tool's description and argument schema.
    pub(crate) fn spec(self) -> ToolSpec {
        let (description, parameters) = match self {
            Self::ListFiles => (
                LIST_FILES,
                json!({
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "The folder. Default: your work folder."},
                        "recursive": {"type": "boolean", "description": "Also list everything inside subfolders."},
                    },
                    "additionalProperties": false,
                }),
            ),
            Self::ReadFile => (
                READ_FILE,
                json!({
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "offset": {"type": "integer", "minimum": 1, "description": "The first line to read, counting from 1."},
                        "limit": {"type": "integer", "minimum": 1, "description": "How many lines to read. Default: 2000."},
                    },
                    "required": ["path"],
                    "additionalProperties": false,
                }),
            ),
            Self::SearchFiles => (
                SEARCH_FILES,
                json!({
                    "type": "object",
                    "properties": {
                        "pattern": {"type": "string", "description": "A regular expression."},
                        "path": {"type": "string", "description": "The folder or file to search. Default: your work folder."},
                        "glob": {"type": "string", "description": "Only files whose name matches, such as *.md."},
                        "ignore_case": {"type": "boolean"},
                    },
                    "required": ["pattern"],
                    "additionalProperties": false,
                }),
            ),
            Self::WriteFile => (
                WRITE_FILE,
                json!({
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "content": {"type": "string"},
                    },
                    "required": ["path", "content"],
                    "additionalProperties": false,
                }),
            ),
            Self::EditFile => (
                EDIT_FILE,
                json!({
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "old_text": {"type": "string"},
                        "new_text": {"type": "string"},
                        "replace_all": {"type": "boolean"},
                    },
                    "required": ["path", "old_text", "new_text"],
                    "additionalProperties": false,
                }),
            ),
            Self::RunCommand => (
                RUN_COMMAND,
                json!({
                    "type": "object",
                    "properties": {
                        "command": {"type": "string"},
                        "timeout_seconds": {"type": "integer", "minimum": 1, "maximum": 600, "description": "Default: 120."},
                    },
                    "required": ["command"],
                    "additionalProperties": false,
                }),
            ),
            Self::UpdatePlan => (
                UPDATE_PLAN,
                json!({
                    "type": "object",
                    "properties": {
                        "steps": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "step": {"type": "string"},
                                    "status": {"type": "string", "enum": ["pending", "in_progress", "completed"]},
                                },
                                "required": ["step", "status"],
                                "additionalProperties": false,
                            },
                        },
                    },
                    "required": ["steps"],
                    "additionalProperties": false,
                }),
            ),
            Self::ReadToolOutput => (
                READ_TOOL_OUTPUT,
                json!({
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "offset": {"type": "integer", "minimum": 0, "description": "The first character to read. Default: 0."},
                        "limit": {"type": "integer", "minimum": 1, "description": "How many characters. Default: 20000."},
                    },
                    "required": ["id"],
                    "additionalProperties": false,
                }),
            ),
            Self::ReadPage => (
                READ_PAGE,
                json!({
                    "type": "object",
                    "properties": {
                        "url": {"type": "string", "description": "The page's address, with http:// or https://."},
                    },
                    "required": ["url"],
                    "additionalProperties": false,
                }),
            ),
            Self::SearchWeb => (
                SEARCH_WEB,
                json!({
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "What to search for."},
                    },
                    "required": ["query"],
                    "additionalProperties": false,
                }),
            ),
        };
        ToolSpec {
            name: self.name().to_owned(),
            description: description.text().to_owned(),
            parameters,
        }
    }

    /// What the call will do, or why it can't be done as asked. A reading tool also looks in the
    /// `connected` folders ([`resolve_reading`]).
    pub(crate) fn prepare(
        self,
        input: &Value,
        cwd: &Path,
        connected: &[PathBuf],
    ) -> Result<Prepared, String> {
        let connected = if self.only_reads() { connected } else { &[] };
        let path = |key: &str| -> Result<PathBuf, String> {
            let given = input.get(key).and_then(Value::as_str).unwrap_or(".");
            Ok(resolve_reading(cwd, connected, given))
        };
        let needs = |kind: ToolKind, title: String, locations: Vec<PathBuf>| Prepared {
            title,
            kind,
            locations,
            needs_permission: true,
        };
        Ok(match self {
            Self::ListFiles => {
                let folder = path("path")?;
                needs(
                    ToolKind::Read,
                    format!("List {}", shown(cwd, &folder)),
                    vec![folder],
                )
            }
            Self::ReadFile => {
                let file = required_path(input, cwd, connected)?;
                needs(
                    ToolKind::Read,
                    format!("Read {}", shown(cwd, &file)),
                    vec![file],
                )
            }
            Self::SearchFiles => {
                let pattern = required_str(input, "pattern")?;
                let folder = path("path")?;
                needs(
                    ToolKind::Search,
                    format!("Search {} for {pattern}", shown(cwd, &folder)),
                    vec![folder],
                )
            }
            Self::WriteFile => {
                let file = required_path(input, cwd, connected)?;
                required_str(input, "content")?;
                needs(
                    ToolKind::Edit,
                    format!("Write {}", shown(cwd, &file)),
                    vec![file],
                )
            }
            Self::EditFile => {
                let file = required_path(input, cwd, connected)?;
                required_str(input, "old_text")?;
                required_str(input, "new_text")?;
                needs(
                    ToolKind::Edit,
                    format!("Edit {}", shown(cwd, &file)),
                    vec![file],
                )
            }
            Self::RunCommand => {
                let command = required_str(input, "command")?;
                needs(
                    ToolKind::Execute,
                    format!("Run: {}", one_line(command, 120)),
                    vec![cwd.to_path_buf()],
                )
            }
            Self::UpdatePlan => Prepared {
                title: "Update the plan".to_owned(),
                kind: ToolKind::Think,
                locations: Vec::new(),
                needs_permission: false,
            },
            Self::ReadToolOutput => Prepared {
                title: "Read a set-aside output".to_owned(),
                kind: ToolKind::Read,
                locations: Vec::new(),
                needs_permission: false,
            },
            // The web, as its switch decides: the session lets a link the person wrote through, and
            // anything once the agent may use the web.
            Self::ReadPage => needs(
                ToolKind::Fetch,
                format!("Read {}", one_line(required_str(input, "url")?, 200)),
                Vec::new(),
            ),
            Self::SearchWeb => needs(
                ToolKind::Fetch,
                format!(
                    "Search the web: {}",
                    one_line(required_str(input, "query")?, 200)
                ),
                Vec::new(),
            ),
        })
    }

    /// Runs a file or command tool. The plan and set-aside outputs are the session's own and are
    /// answered there.
    pub(crate) async fn run(self, input: &Value, context: &Context<'_>) -> Output {
        match self {
            Self::ListFiles
            | Self::ReadFile
            | Self::SearchFiles
            | Self::WriteFile
            | Self::EditFile => {
                let input = input.clone();
                let cwd = context.cwd.to_path_buf();
                let connected = context.connected.to_vec();
                let pictures = context.pictures;
                tokio::task::spawn_blocking(move || {
                    files::run(self, &input, &cwd, &connected, pictures)
                })
                .await
                .unwrap_or_else(|error| Output::failed(format!("The tool stopped: {error}")))
            }
            Self::RunCommand => Box::pin(command::run(input, context)).await,
            Self::ReadPage => Box::pin(link::run(input, context)).await,
            Self::UpdatePlan | Self::ReadToolOutput | Self::SearchWeb => {
                Output::failed("This tool is answered by the session.")
            }
        }
    }
}

fn required_str<'a>(input: &'a Value, key: &str) -> Result<&'a str, String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("`{key}` is required and must be text."))
}

fn required_path(input: &Value, cwd: &Path, connected: &[PathBuf]) -> Result<PathBuf, String> {
    let given = required_str(input, "path")?;
    if given.trim().is_empty() {
        return Err("`path` is empty.".to_owned());
    }
    Ok(resolve_reading(cwd, connected, given))
}

/// `given` as an absolute path: relative to `cwd`, with `.` and `..` worked out on the text alone,
/// so a path that doesn't exist yet resolves too. The permission policy decides whether it may be
/// touched; this only says which path it is.
pub(crate) fn resolve(cwd: &Path, given: &str) -> PathBuf {
    let given = given.trim();
    // `~\` too on Windows, where `~` is the user profile.
    let home_relative = given
        .strip_prefix("~/")
        .or_else(|| given.strip_prefix("~\\").filter(|_| cfg!(windows)));
    let given = home_relative.map_or_else(
        || PathBuf::from(given),
        |rest| {
            crate::platform::home_dir().map_or_else(|| PathBuf::from(given), |home| home.join(rest))
        },
    );
    let joined = if given.is_absolute() {
        given
    } else {
        cwd.join(given)
    };
    let mut out = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// Where a reading tool finds `given`: [`resolve`]d against the work folder, unless nothing is
/// there and exactly one of the `connected` folders holds it. The agent is shown a connected
/// folder's files by their names inside it (`drafts/prices.md`), and the folder by the name the
/// team file gives it (`notes/drafts/prices.md`), so a read by either name finds the file.
pub(crate) fn resolve_reading(cwd: &Path, connected: &[PathBuf], given: &str) -> PathBuf {
    let path = resolve(cwd, given);
    if path.exists() {
        return path;
    }
    let relative = Path::new(given.trim());
    let mut found: Vec<PathBuf> = connected
        .iter()
        .flat_map(|folder| {
            let by_name = folder
                .file_name()
                .filter(|name| relative.starts_with(name))
                .and(folder.parent())
                .map(|parent| resolve(parent, given));
            [Some(resolve(folder, given)), by_name]
                .into_iter()
                .flatten()
                .filter(move |inside| inside.starts_with(folder) && inside.exists())
        })
        .collect();
    found.sort();
    found.dedup();
    match found.as_slice() {
        [only] => only.clone(),
        _ => path,
    }
}

/// A path the way the operator's card shows it: relative to the work folder when inside it.
pub(crate) fn shown(cwd: &Path, path: &Path) -> String {
    match path.strip_prefix(cwd) {
        Ok(relative) if relative.as_os_str().is_empty() => "the work folder".to_owned(),
        Ok(relative) => slashed(relative),
        Err(_) => path.display().to_string(),
    }
}

/// A relative path written with `/` on every system, as the agent and the operator read it and as
/// the file tools take it back. Windows reads `/` too.
pub(crate) fn slashed(relative: &Path) -> String {
    relative
        .components()
        .map(|part| part.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// The first line of `text`, cut to `limit` characters.
pub(crate) fn one_line(text: &str, limit: usize) -> String {
    let line = text.lines().next().unwrap_or_default().trim();
    let cut: String = line.chars().take(limit).collect();
    if cut.len() < line.len() || text.lines().nth(1).is_some() {
        format!("{cut}…")
    } else {
        cut
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_resolve_against_the_work_folder_without_touching_the_disk() {
        let cwd = Path::new("/work/team");
        assert_eq!(
            resolve(cwd, "notes/a.md"),
            Path::new("/work/team/notes/a.md")
        );
        assert_eq!(resolve(cwd, "./a/../b.md"), Path::new("/work/team/b.md"));
        assert_eq!(resolve(cwd, "../../etc/passwd"), Path::new("/etc/passwd"));
        assert_eq!(resolve(cwd, "/tmp/x"), Path::new("/tmp/x"));
    }

    /// On Windows a path may start at a drive, at the root of the work folder's drive, or at `~\`,
    /// and use either separator.
    #[cfg(windows)]
    #[test]
    fn windows_paths_resolve_as_windows_reads_them() {
        let cwd = Path::new(r"C:\work\team");
        assert_eq!(
            resolve(cwd, r"notes\a.md"),
            Path::new(r"C:\work\team\notes\a.md")
        );
        assert_eq!(
            resolve(cwd, "notes/a.md"),
            Path::new(r"C:\work\team\notes\a.md")
        );
        assert_eq!(resolve(cwd, r"..\..\x.md"), Path::new(r"C:\x.md"));
        assert_eq!(resolve(cwd, r"\Users\x.md"), Path::new(r"C:\Users\x.md"));
        assert_eq!(resolve(cwd, r"D:\data\x.md"), Path::new(r"D:\data\x.md"));
        let home = crate::platform::home_dir().expect("a user profile");
        assert_eq!(resolve(cwd, r"~\notes.md"), home.join("notes.md"));
        assert_eq!(resolve(cwd, "~/notes.md"), home.join("notes.md"));
        assert_eq!(
            shown(cwd, &resolve(cwd, r"notes\a.md")),
            "notes/a.md",
            "the card shows a path inside the work folder relative to it, with `/`"
        );
    }

    /// The agent is shown a connected folder's files by their names inside it, and the folder by
    /// the name the team file gives it. A read by either name finds the file; the work folder's
    /// own file comes first; a name two folders hold is neither's; and a write never lands in a
    /// connected folder by a guess.
    #[test]
    fn a_read_by_a_name_inside_a_connected_folder_finds_the_file() {
        let root =
            std::env::temp_dir().join(format!("loomwatch-connected-{}", uuid::Uuid::new_v4()));
        let (work, notes) = (root.join("work"), root.join("notes"));
        let menus = root.join("shared").join("menus");
        for (file, text) in [
            (work.join("README.md"), "the work folder's"),
            (notes.join("README.md"), "the notes'"),
            (notes.join("drafts/prices.md"), "Basic: 139,000 VND"),
            (menus.join("drafts/menu.md"), "Pho"),
            (root.join("shared/secret.md"), "not connected"),
        ] {
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(&file, text).unwrap();
        }
        let connected = [notes.clone(), menus.clone()];
        let read = |given: &str| resolve_reading(&work, &connected, given);
        // Joined part by part, so Windows names it with `\` throughout, as the tools do.
        let prices = notes.join("drafts").join("prices.md");
        assert_eq!(read("drafts/prices.md"), prices);
        assert_eq!(read("./drafts/prices.md"), prices);
        assert_eq!(
            read("notes/drafts/prices.md"),
            prices,
            "by the folder's name"
        );
        assert_eq!(read("drafts/menu.md"), menus.join("drafts/menu.md"));
        assert_eq!(read("drafts"), work.join("drafts"), "both folders hold one");
        assert_eq!(read("README.md"), work.join("README.md"));
        assert_eq!(read("missing.md"), work.join("missing.md"));
        assert_eq!(read("../drafts/prices.md"), root.join("drafts/prices.md"));
        assert_eq!(
            read("../secret.md"),
            root.join("secret.md"),
            "never out of one"
        );
        assert_eq!(
            resolve_reading(&work, &[], "drafts/prices.md"),
            work.join("drafts/prices.md")
        );

        let reading = Builtin::ReadFile
            .prepare(&json!({"path": "drafts/prices.md"}), &work, &connected)
            .unwrap();
        assert_eq!(reading.locations, std::slice::from_ref(&prices));
        assert_eq!(reading.title, format!("Read {}", prices.display()));
        let writing = Builtin::WriteFile
            .prepare(
                &json!({"path": "drafts/prices.md", "content": "x"}),
                &work,
                &connected,
            )
            .unwrap();
        assert_eq!(writing.locations, [work.join("drafts/prices.md")]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_call_says_what_it_will_touch_before_it_runs() {
        let cwd = Path::new("/work");
        let prepared = Builtin::EditFile
            .prepare(
                &json!({"path": "a.md", "old_text": "x", "new_text": "y"}),
                cwd,
                &[],
            )
            .unwrap();
        assert_eq!(prepared.kind, ToolKind::Edit);
        assert_eq!(prepared.locations, [PathBuf::from("/work/a.md")]);
        assert_eq!(prepared.title, "Edit a.md");
        assert!(Builtin::ReadFile.prepare(&json!({}), cwd, &[]).is_err());
        let command = Builtin::RunCommand
            .prepare(&json!({"command": "python3 make.py\necho done"}), cwd, &[])
            .unwrap();
        assert_eq!(command.title, "Run: python3 make.py…");
        assert!(
            !Builtin::UpdatePlan
                .prepare(&json!({"steps": []}), cwd, &[])
                .unwrap()
                .needs_permission
        );
    }
}
