//! `LoomWatch` decides what a run's agents may do without asking (ADR 0037).
//!
//! An app asks before it acts only when its own settings say to. So each run agent's session is put
//! in its app's ask-first mode (`acp.rs`, `ensure_ask_first`), and every `session/request_permission`
//! it sends is answered here by one policy, the same for every app: what the operator connected to
//! the agent, plus the switches in its `allow:` block. Anything else is put to the operator of the
//! run while the app waits (ADR 0040, [`PermissionAsker`]), and declined when nobody can be asked
//! or nobody answers.

use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
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

// ---------------------------------------------------------------------------------------
// Asking the operator (ADR 0040)
// ---------------------------------------------------------------------------------------

/// How long a request waits for the operator before it is declined. The app is blocked on the
/// answer and the run with it, so a person who walked away costs at most this.
pub const PERMISSION_WAIT: std::time::Duration = std::time::Duration::from_mins(10);
/// Longest `detail` a request carries; the rest is cut with an ellipsis.
const DETAIL_CHARS: usize = 300;

/// One request an agent is waiting on the operator for, as the run record carries it
/// (`permissionRequests`). Live only: it exists while the app is blocked on the answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    pub id: String,
    /// The agent asking.
    pub agent: String,
    /// Its display name.
    pub name: String,
    /// What the app calls the action — "Web search", "Bash: npm test".
    pub title: String,
    /// The app's ACP tool kind: `fetch`, `execute`, `edit`, `read`, …
    pub kind: String,
    /// The `allow:` switch that would let it through without asking: `web`, `commands` or `edits`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub switch: Option<String>,
    /// The query, command, address or path, when the request names one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// RFC 3339.
    pub since: String,
    /// RFC 3339: when it is declined if nobody answers.
    pub expires_at: String,
    /// What "Allow for this run" covers ([`grant_scope`]). Internal: the card shows `kind`.
    #[serde(skip)]
    pub scope: String,
}

/// What the operator chose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionDecision {
    /// This request only.
    AllowOnce,
    /// This request and every later one of the same kind from this agent, until the run ends.
    AllowRun,
    Deny,
}

/// How a request the policy declined was finally answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AskOutcome {
    /// Nobody could be asked: a routine, a finished run, or no run at all. Declined.
    NotAsked,
    /// The operator allowed this kind for the rest of the run earlier; allowed without asking.
    AllowedForRun,
    Answered(PermissionDecision),
    /// Nobody answered within [`PERMISSION_WAIT`]. Declined.
    TimedOut,
}

impl AskOutcome {
    #[must_use]
    pub fn allows(self) -> bool {
        matches!(
            self,
            Self::AllowedForRun
                | Self::Answered(PermissionDecision::AllowOnce | PermissionDecision::AllowRun)
        )
    }

    /// The word the archive records for this outcome.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotAsked => "not_asked",
            Self::AllowedForRun => "allowed_for_run",
            Self::Answered(PermissionDecision::AllowOnce) => "allow_once",
            Self::Answered(PermissionDecision::AllowRun) => "allow_run",
            Self::Answered(PermissionDecision::Deny) => "deny",
            Self::TimedOut => "timed_out",
        }
    }
}

/// The switch a tool kind falls under, as `PermissionPolicy::approves` reads it.
#[must_use]
pub fn switch_for(kind: &str) -> Option<&'static str> {
    match kind {
        "fetch" => Some("web"),
        "execute" => Some("commands"),
        "edit" => Some("edits"),
        _ => None,
    }
}

/// The MCP tool a request is about — `server.tool`, or the app's title for it — or `None` for one
/// of the app's own tools. Apps label MCP calls with a broad kind (Codex calls every one of them
/// `execute`, a shell command's kind), so the kind alone cannot tell them apart.
fn mcp_tool(request: &Value) -> Option<String> {
    let call = request.pointer("/params/toolCall")?;
    let text = |pointer: &str| call.pointer(pointer).and_then(Value::as_str).map(str::trim);
    if let (Some(server), Some(tool)) = (text("/rawInput/server"), text("/rawInput/tool"))
        && !server.is_empty()
        && !tool.is_empty()
    {
        return Some(format!("{server}.{tool}"));
    }
    let flagged = request.pointer("/params/_meta/is_mcp_tool_approval") == Some(&Value::Bool(true))
        || call.pointer("/_meta/is_mcp_tool_call") == Some(&Value::Bool(true));
    let title = text("/title").unwrap_or_default();
    let titled =
        title.starts_with("mcp__") || title.starts_with("mcp.") || title.ends_with(" MCP Server)");
    (flagged || titled).then(|| title.to_owned())
}

/// What "Allow for this run" covers for this request: the tool kind for the app's own tools — every
/// web search, every command — but one MCP tool exactly, so allowing a tool never allows every
/// command that happens to share its kind.
#[must_use]
pub fn grant_scope(request: &Value) -> String {
    mcp_tool(request).map_or_else(
        || {
            request
                .pointer("/params/toolCall/kind")
                .and_then(Value::as_str)
                .unwrap_or("other")
                .to_owned()
        },
        |tool| format!("mcp:{tool}"),
    )
}

/// The parts of a `session/request_permission` a person needs to decide: title, kind and the one
/// concrete thing it would touch.
#[must_use]
pub fn describe(request: &Value) -> (String, String, Option<String>) {
    let call = request.pointer("/params/toolCall");
    let text = |pointer: &str| {
        call.and_then(|call| call.pointer(pointer))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
    };
    let kind = text("/kind").unwrap_or("other").to_owned();
    let title = text("/title").unwrap_or("An action").to_owned();
    let detail = [
        "/rawInput/command",
        "/rawInput/query",
        "/rawInput/url",
        "/rawInput/file_path",
        "/rawInput/path",
        "/locations/0/path",
    ]
    .iter()
    .find_map(|pointer| text(pointer))
    .filter(|detail| !title.contains(detail))
    .map(|detail| {
        if detail.chars().count() > DETAIL_CHARS {
            format!("{}…", detail.chars().take(DETAIL_CHARS).collect::<String>())
        } else {
            detail.to_owned()
        }
    });
    (title, kind, detail)
}

/// Who an agent's declined requests are put to: the operator of the run it belongs to (ADR 0040).
/// Part of [`crate::acp::ProcessSpec`], so a respawned stage keeps asking the same run.
#[derive(Clone, Debug)]
pub struct PermissionAsker {
    desk: crate::operator::OperatorDesk,
    run_id: String,
    agent: String,
    name: String,
}

impl PermissionAsker {
    #[must_use]
    pub fn new(desk: crate::operator::OperatorDesk, run_id: &str, agent: &str, name: &str) -> Self {
        Self {
            desk,
            run_id: run_id.to_owned(),
            agent: agent.to_owned(),
            name: if name.trim().is_empty() { agent } else { name }.to_owned(),
        }
    }

    /// The asker for `agent` of the run `run_id`, when the run has an operator to ask: the CLI path
    /// has neither a desk nor a person, so it keeps declining at once.
    #[must_use]
    pub fn for_run(
        desk: Option<&crate::operator::OperatorDesk>,
        run_id: Option<&str>,
        agent: &crate::config::AgentConfig,
    ) -> Option<Self> {
        Some(Self::new(desk?.clone(), run_id?, &agent.id, &agent.name))
    }

    /// Whether the operator already allowed what `request` asks ([`grant_scope`]) for this agent for
    /// the rest of the run.
    #[must_use]
    pub fn allowed_for_run(&self, request: &Value) -> bool {
        self.desk
            .registry()
            .allowed_for_run(&self.run_id, &self.agent, &grant_scope(request))
    }

    /// Put one declined `session/request_permission` on the run record for the operator to answer.
    /// `None` when nobody can be asked — a routine, or a run that has ended — and the request is
    /// declined at once, as every request was before ADR 0040.
    #[must_use]
    pub fn open(&self, request: &Value) -> Option<OpenRequest> {
        let (title, kind, detail) = describe(request);
        let now = chrono::Utc::now();
        let wait = chrono::Duration::from_std(PERMISSION_WAIT).unwrap_or_default();
        let stamp = |at: chrono::DateTime<chrono::Utc>| {
            at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        };
        let request = PermissionRequest {
            id: uuid::Uuid::new_v4().to_string(),
            agent: self.agent.clone(),
            name: self.name.clone(),
            // An MCP tool is not what any switch is for, whatever kind the app gives it.
            switch: mcp_tool(request)
                .is_none()
                .then(|| switch_for(&kind))
                .flatten()
                .map(str::to_owned),
            scope: grant_scope(request),
            title,
            kind,
            detail,
            since: stamp(now),
            expires_at: stamp(now + wait),
        };
        let answer = self
            .desk
            .registry()
            .open_permission_request(&self.run_id, request.clone())?;
        Some(OpenRequest {
            asker: self.clone(),
            request,
            answer,
        })
    }
}

/// A request waiting on the run record for the operator's answer.
pub struct OpenRequest {
    asker: PermissionAsker,
    pub request: PermissionRequest,
    answer: tokio::sync::oneshot::Receiver<PermissionDecision>,
}

impl OpenRequest {
    /// Wait for the operator, at most [`PERMISSION_WAIT`], then take the request off the record.
    /// The app is blocked on this answer, so nothing races the ACP request timeout: that only
    /// runs while a line is being awaited.
    pub async fn wait(self) -> AskOutcome {
        let outcome = match tokio::time::timeout(PERMISSION_WAIT, self.answer).await {
            Ok(Ok(decision)) => AskOutcome::Answered(decision),
            // The waiting room dropped the request: the run ended while it was open.
            Ok(Err(_)) => AskOutcome::NotAsked,
            Err(_) => AskOutcome::TimedOut,
        };
        self.asker
            .desk
            .registry()
            .close_permission_request(&self.asker.run_id, &self.request.id);
        outcome
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

    /// ADR 0040: "Allow for this run" covers a kind for the app's own tools, but exactly one MCP
    /// tool, however the app labels it. Codex calls every MCP tool `execute`, so allowing a tool for
    /// the run must not allow every command, and no switch is offered for it.
    #[test]
    fn a_run_long_grant_covers_one_mcp_tool_never_every_command() {
        let ask = |call: Value| json!({"params": {"toolCall": call}});
        let command =
            ask(json!({"kind": "execute", "title": "Bash", "rawInput": {"command": "ls"}}));
        assert_eq!(grant_scope(&command), "execute");
        assert_eq!(mcp_tool(&command), None);

        let codex = ask(
            json!({"kind": "execute", "title": "mcp.notion.search", "rawInput": {"server": "notion", "tool": "search", "arguments": {}}}),
        );
        assert_eq!(grant_scope(&codex), "mcp:notion.search");
        let codex_flagged = json!({"params": {"_meta": {"is_mcp_tool_approval": true}, "toolCall": {"kind": "execute", "title": "Run search"}}});
        assert_eq!(grant_scope(&codex_flagged), "mcp:Run search");
        let claude = ask(json!({"kind": "other", "title": "mcp__notion__search"}));
        assert_eq!(grant_scope(&claude), "mcp:mcp__notion__search");
        let gemini = ask(json!({"kind": "execute", "title": "search (notion MCP Server)"}));
        assert_eq!(grant_scope(&gemini), "mcp:search (notion MCP Server)");
        assert_eq!(grant_scope(&ask(json!({"title": "?"}))), "other");
        assert_ne!(grant_scope(&codex), grant_scope(&command));
    }
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
