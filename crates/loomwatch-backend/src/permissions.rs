//! `LoomWatch` decides what a run's agents may do without asking (ADR 0037).
//!
//! An app asks before it acts only when its own settings say to, and `LoomWatch` cannot ask the
//! operator in the middle of a run. So each run agent's session is put in its app's ask-first mode
//! (`acp.rs`, `ensure_ask_first`), and every `session/request_permission` it sends is answered here
//! by one policy, the same for every app: what the operator connected to the agent, plus the
//! switches in its `allow:` block. Anything else is declined, as every request was before.

use std::path::{Component, Path, PathBuf};

use serde_json::Value;

use crate::config::AgentAllow;
use crate::delivery::{Delivery, RESERVED_SERVER};

/// App settings folders an agent may never edit, even inside its own folder: a change there could
/// grant it more on its next session than the operator switched on.
const PROTECTED_FOLDERS: [&str; 7] = [
    ".claude",
    ".agents",
    ".codex",
    ".gemini",
    ".opencode",
    ".git",
    ".loomwatch",
];

/// Mode ids that make an app ask before it acts, in the order they are tried: Claude Code's and
/// Gemini CLI's `default` ("Always ask before making changes", "Prompts for approval") and
/// Codex's `read-only` ("Requires approval to edit files and access the internet").
pub(crate) const ASK_FIRST_MODES: [&str; 2] = ["default", "read-only"];

/// How one run agent's permission requests are answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionPolicy {
    allow: AgentAllow,
    /// The agent's working folder, resolved: where `allow.edits` lets it change files.
    folder: PathBuf,
    /// Folders and files the operator connected as knowledge, resolved.
    readable: Vec<PathBuf>,
    /// MCP servers `LoomWatch` handed this session: the Team Bus and every connected tool.
    servers: Vec<String>,
}

impl PermissionPolicy {
    #[must_use]
    pub fn new(
        allow: AgentAllow,
        folder: &Path,
        readable: impl IntoIterator<Item = PathBuf>,
        servers: impl IntoIterator<Item = String>,
    ) -> Self {
        Self {
            allow,
            folder: resolve(folder),
            readable: readable.into_iter().map(|path| resolve(&path)).collect(),
            servers: servers.into_iter().collect(),
        }
    }

    /// The policy for a run agent working in `folder` with what `delivery` connected to it. The
    /// Team Bus is always approved: it is how a team hands work on, and `LoomWatch` serves it.
    #[must_use]
    pub fn for_agent(allow: AgentAllow, folder: &Path, delivery: &Delivery) -> Self {
        let readable = delivery
            .knowledge
            .iter()
            .flat_map(|knowledge| knowledge.folders.iter().chain(&knowledge.files))
            .map(PathBuf::from);
        let servers = std::iter::once(RESERVED_SERVER.to_owned())
            .chain(delivery.tools.iter().map(|tool| tool.server.clone()));
        Self::new(allow, folder, readable, servers)
    }

    /// Whether to approve one `session/request_permission`, from the tool call it describes.
    ///
    /// The app's `kind` decides which switch applies: `fetch` is the web, `execute` a command,
    /// `edit` a file change, which must also land inside the agent's own folder. A request that
    /// names no kind, or a kind no switch covers (`delete`, `move`, `other`), is declined.
    #[must_use]
    pub fn approves(&self, request: &Value) -> bool {
        if self
            .servers
            .iter()
            .any(|server| crate::acp::asks_about_server_tool(request, server))
        {
            return true;
        }
        let kind = request
            .pointer("/params/toolCall/kind")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match kind {
            "fetch" => self.allow.web,
            "execute" => self.allow.commands,
            "edit" => self.allow.edits && self.every_location(request, |path| self.editable(path)),
            "read" | "search" => self.every_location(request, |path| self.readable(path)),
            _ => false,
        }
    }

    /// True when the request names at least one path and `test` holds for every one of them.
    fn every_location(&self, request: &Value, test: impl Fn(&Path) -> bool) -> bool {
        let Some(locations) = request
            .pointer("/params/toolCall/locations")
            .and_then(Value::as_array)
        else {
            return false;
        };
        !locations.is_empty()
            && locations.iter().all(|location| {
                location
                    .get("path")
                    .and_then(Value::as_str)
                    .is_some_and(|path| test(&self.locate(path)))
            })
    }

    fn locate(&self, path: &str) -> PathBuf {
        let path = Path::new(path);
        if path.is_absolute() {
            resolve(path)
        } else {
            resolve(&self.folder.join(path))
        }
    }

    fn editable(&self, path: &Path) -> bool {
        path.strip_prefix(&self.folder).is_ok_and(|inside| {
            inside.components().next().is_some()
                && inside.components().all(|component| match component {
                    Component::Normal(name) => {
                        !PROTECTED_FOLDERS.iter().any(|folder| name == *folder)
                    }
                    _ => false,
                })
        })
    }

    fn readable(&self, path: &Path) -> bool {
        path.starts_with(&self.folder) || self.readable.iter().any(|root| path.starts_with(root))
    }
}

/// `path` with `.` and `..` folded away and the symlinks in its existing part resolved, so
/// `/var/x` and `/private/var/x` compare equal, `folder/../elsewhere` is not inside `folder`, and a
/// link inside the folder that points out of it is judged by where it points. A file about to be
/// created does not exist yet, so only its deepest existing ancestor is resolved.
fn resolve(path: &Path) -> PathBuf {
    let mut lexical = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                lexical.pop();
            }
            other => lexical.push(other),
        }
    }
    let mut existing = lexical.clone();
    let mut missing = Vec::new();
    while !existing.exists() {
        let Some(name) = existing.file_name().map(ToOwned::to_owned) else {
            return lexical;
        };
        missing.push(name);
        existing.pop();
    }
    let mut resolved = std::fs::canonicalize(&existing).unwrap_or(existing);
    for name in missing.into_iter().rev() {
        resolved.push(name);
    }
    resolved
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::json;

    use super::*;

    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "loomwatch-permissions-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .expect("clock")
                    .as_nanos()
            ));
            fs::create_dir_all(path.join("agent")).expect("agent folder");
            fs::create_dir_all(path.join("notes")).expect("knowledge folder");
            Self(path)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn request(kind: Option<&str>, title: &str, paths: &[&str]) -> Value {
        let mut tool_call = json!({"toolCallId": "call-1", "title": title});
        if let Some(kind) = kind {
            tool_call["kind"] = json!(kind);
        }
        if !paths.is_empty() {
            tool_call["locations"] = paths.iter().map(|path| json!({"path": path})).collect();
        }
        json!({
            "jsonrpc": "2.0",
            "id": "permission-1",
            "method": "session/request_permission",
            "params": {"sessionId": "s", "toolCall": tool_call, "options": []}
        })
    }

    fn policy(scratch: &Scratch, allow: AgentAllow) -> PermissionPolicy {
        PermissionPolicy::new(
            allow,
            &scratch.0.join("agent"),
            [scratch.0.join("notes")],
            [RESERVED_SERVER.to_owned(), "agentmemory".to_owned()],
        )
    }

    const ALL: AgentAllow = AgentAllow {
        web: true,
        edits: true,
        commands: true,
    };

    #[test]
    fn nothing_switched_on_declines_web_commands_and_edits() {
        let scratch = Scratch::new();
        let none = policy(&scratch, AgentAllow::default());
        let inside = scratch.0.join("agent/draft.md");
        let inside = inside.to_string_lossy();
        assert!(!none.approves(&request(Some("fetch"), "Web search", &[])));
        assert!(!none.approves(&request(Some("execute"), "Bash: ls", &[])));
        assert!(!none.approves(&request(Some("edit"), "Write draft.md", &[&inside])));
    }

    #[test]
    fn each_switch_approves_its_own_kind_and_no_other() {
        let scratch = Scratch::new();
        let web = policy(
            &scratch,
            AgentAllow {
                web: true,
                ..AgentAllow::default()
            },
        );
        assert!(web.approves(&request(Some("fetch"), "Web search", &[])));
        assert!(!web.approves(&request(Some("execute"), "Bash: curl", &[])));
        let commands = policy(
            &scratch,
            AgentAllow {
                commands: true,
                ..AgentAllow::default()
            },
        );
        assert!(commands.approves(&request(Some("execute"), "Bash: ls", &[])));
        assert!(!commands.approves(&request(Some("fetch"), "Web search", &[])));
    }

    #[test]
    fn edits_land_only_inside_the_agents_folder_and_never_in_its_settings() {
        let scratch = Scratch::new();
        let edits = policy(&scratch, ALL);
        let at = |relative: &str| scratch.0.join(relative).to_string_lossy().into_owned();
        assert!(edits.approves(&request(Some("edit"), "Write", &[&at("agent/draft.md")])));
        assert!(edits.approves(&request(
            Some("edit"),
            "Write",
            &[&at("agent/new/dir/file.md")]
        )));
        assert!(edits.approves(&request(Some("edit"), "Write", &["relative.md"])));
        assert!(!edits.approves(&request(Some("edit"), "Write", &[&at("notes/draft.md")])));
        assert!(!edits.approves(&request(
            Some("edit"),
            "Write",
            &[&at("agent/../team.yaml")]
        )));
        assert!(!edits.approves(&request(
            Some("edit"),
            "Write",
            &[&at("agent/.claude/settings.json")]
        )));
        assert!(!edits.approves(&request(
            Some("edit"),
            "Write",
            &[&at("agent/sub/.git/config")]
        )));
        assert!(
            !edits.approves(&request(Some("edit"), "Write", &[&at("agent")])),
            "the folder itself"
        );
        // One path outside spoils the batch, and an edit that names no path is never approved.
        assert!(!edits.approves(&request(
            Some("edit"),
            "Edit",
            &[&at("agent/a.md"), "/etc/hosts"]
        )));
        assert!(!edits.approves(&request(Some("edit"), "Edit", &[])));
    }

    #[cfg(unix)]
    #[test]
    fn a_link_inside_the_folder_is_judged_by_where_it_points() {
        let scratch = Scratch::new();
        std::os::unix::fs::symlink(scratch.0.join("notes"), scratch.0.join("agent/out"))
            .expect("symlink");
        let edits = policy(&scratch, ALL);
        let through = scratch.0.join("agent/out/secret.md");
        assert!(!edits.approves(&request(
            Some("edit"),
            "Write",
            &[&through.to_string_lossy()]
        )));
    }

    #[test]
    fn connected_servers_and_knowledge_are_approved_without_any_switch() {
        let scratch = Scratch::new();
        let none = policy(&scratch, AgentAllow::default());
        for title in [
            "mcp__loomwatch-team-bus__handoff",
            "dispatch (loomwatch-team-bus MCP Server)",
            "agentmemory.search",
        ] {
            assert!(none.approves(&request(None, title, &[])), "{title}");
        }
        assert!(!none.approves(&request(None, "mcp__someone-else__dispatch", &[])));
        let brief = scratch.0.join("notes/brief.md");
        assert!(none.approves(&request(
            Some("read"),
            "Read brief.md",
            &[&brief.to_string_lossy()]
        )));
        assert!(!none.approves(&request(Some("read"), "Read hosts", &["/etc/hosts"])));
    }

    #[test]
    fn a_request_without_a_kind_or_with_an_uncovered_kind_is_declined() {
        let scratch = Scratch::new();
        let all = policy(&scratch, ALL);
        let inside = scratch.0.join("agent/old.md");
        let inside = inside.to_string_lossy();
        assert!(!all.approves(&request(None, "Something", &[])));
        assert!(!all.approves(&request(Some("delete"), "Delete old.md", &[&inside])));
        assert!(!all.approves(&request(Some("other"), "Mystery", &[])));
    }
}
