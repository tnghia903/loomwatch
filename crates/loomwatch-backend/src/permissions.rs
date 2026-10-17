//! `LoomWatch` decides what a run's agents may do without asking (ADR 0037).
//!
//! Every tool call an agent makes that reaches past reading its own folder is described as a
//! permission request (`agent::PermissionRequest`) and answered here by one policy: what the
//! operator connected to the agent, plus the switches in its `allow:` block. Anything else is put
//! to the operator of the run while the agent waits (ADR 0040, [`PermissionAsker`]), and declined
//! when nobody can be asked or nobody answers.

use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::config::{AgentAllow, AgentConfig, CapabilityKind, CapabilityRef, TurnedOff};
use crate::delivery::{Delivery, RESERVED_SERVER};

/// Folders an agent may never edit, even inside its own folder: a change there could give it more
/// on its next session than the operator switched on. `.agents` and `.claude` hold the skills it is
/// offered, `.loomwatch` what `LoomWatch` keeps for the team, and `.git` hooks run code.
const PROTECTED_FOLDERS: [&str; 4] = [".claude", ".agents", ".git", ".loomwatch"];

/// How one run agent's permission requests are answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionPolicy {
    allow: AgentAllow,
    /// The agent's working folder, resolved: where `allow.edits` lets it change files.
    folder: PathBuf,
    /// Folders and files the operator connected as knowledge, and `LoomWatch`'s folder of copies
    /// for this agent, resolved.
    readable: Vec<PathBuf>,
    /// MCP servers `LoomWatch` handed this session: the Team Bus and every connected tool.
    servers: Vec<String>,
    /// What the operator turned off for this agent that `LoomWatch` does not also give it
    /// (ADR 0060): left out of the skills the agent is offered.
    turned_off: Vec<TurnedOff>,
    /// `LoomWatch`'s own state folder: the key, the database, the approvals. Never read without
    /// asking, whatever the agent's folder or knowledge reaches.
    state_dir: Option<PathBuf>,
    /// `LoomWatch`'s skills folder inside it, which every agent reads its skills from.
    skills_folder: Option<PathBuf>,
}

impl PermissionPolicy {
    #[must_use]
    pub fn new(
        allow: AgentAllow,
        folder: &Path,
        readable: impl IntoIterator<Item = PathBuf>,
        servers: impl IntoIterator<Item = String>,
    ) -> Self {
        let installed = crate::ai::installed();
        Self {
            allow,
            folder: resolve(folder),
            readable: readable.into_iter().map(|path| resolve(&path)).collect(),
            servers: servers.into_iter().collect(),
            turned_off: Vec::new(),
            state_dir: installed.map(|ai| resolve(&ai.state_dir())),
            skills_folder: installed.map(|ai| resolve(&ai.skills_folder())),
        }
    }

    /// This policy keeping `state_dir` private, with its `skills` folder readable.
    #[cfg(test)]
    fn keeping_private(mut self, state_dir: &Path) -> Self {
        self.state_dir = Some(resolve(state_dir));
        self.skills_folder = Some(resolve(&state_dir.join("skills")));
        self
    }

    /// The policy for a run agent working in `folder` with what `delivery` connected to it. The
    /// Team Bus is always approved: it is how a team hands work on, and `LoomWatch` serves it.
    #[must_use]
    pub fn for_agent(allow: AgentAllow, folder: &Path, delivery: &Delivery) -> Self {
        let readable = delivery
            .knowledge
            .iter()
            .flat_map(|knowledge| knowledge.folders.iter().chain(&knowledge.files))
            .map(PathBuf::from)
            .chain(delivery.copies.clone());
        Self::new(allow, folder, readable, [RESERVED_SERVER.to_owned()])
    }

    /// The policy for one of a run's agents: [`Self::for_agent`] with what the operator turned off
    /// for it (ADR 0060).
    #[must_use]
    pub fn for_run_agent(agent: &AgentConfig, folder: &Path, delivery: &Delivery) -> Self {
        Self::for_agent(agent.allow, folder, delivery)
            .turning_off(&agent.turned_off, &agent.capabilities)
    }

    /// This policy with what the operator turned off for the agent (ADR 0060), less anything the
    /// canvas gives it: a skill wired to the agent is delivered, so the copy `LoomWatch` delivers
    /// is never caught by a turned-off entry of the same name.
    #[must_use]
    pub fn turning_off(mut self, turned_off: &[TurnedOff], given: &[CapabilityRef]) -> Self {
        self.turned_off = turned_off
            .iter()
            .filter(|entry| {
                let wired = given.iter().any(|capability| {
                    capability.kind == entry.kind && capability.name == entry.name
                });
                let served =
                    entry.kind == CapabilityKind::Tool && self.servers.contains(&entry.name);
                !wired && !served
            })
            .cloned()
            .collect();
        self
    }

    /// The skills turned off for this agent, by name: left out of the ones it is offered
    /// (ADR 0060).
    #[must_use]
    pub fn turned_off_skills(&self) -> Vec<String> {
        self.turned_off
            .iter()
            .filter(|entry| entry.kind == CapabilityKind::Skill)
            .map(|entry| entry.name.clone())
            .collect()
    }

    /// The agent's working folder, resolved: where Auto mode lets a command read (ADR 0061).
    #[must_use]
    pub fn folder(&self) -> &Path {
        &self.folder
    }

    /// The agent's `allow:` switches.
    #[must_use]
    pub const fn allow(&self) -> AgentAllow {
        self.allow
    }

    /// Whether to approve one permission request, from the tool call it describes.
    ///
    /// The call's `kind` decides which switch applies: `fetch` is the web, `execute` a command,
    /// `edit` a file change, which must also land inside the agent's own folder. A request that
    /// names no kind, or a kind no switch covers (`delete`, `move`, `other`), is declined.
    #[must_use]
    pub fn approves(&self, request: &Value) -> bool {
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

    /// Whether the request names `LoomWatch`'s own key file. No agent may touch it, even with the
    /// operator's answer: the key never leaves the daemon, and a newcomer could allow a card that
    /// reads "Read keys.json" without knowing what it hands the model.
    #[must_use]
    pub fn reaches_key(&self, request: &Value) -> bool {
        let Some(state) = &self.state_dir else {
            return false;
        };
        let key = state.join(crate::ai::KEY_FILE);
        request
            .pointer("/params/toolCall/locations")
            .and_then(Value::as_array)
            .is_some_and(|locations| {
                locations.iter().any(|location| {
                    location
                        .get("path")
                        .and_then(Value::as_str)
                        .is_some_and(|path| self.locate(path) == key)
                })
            })
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

    /// Whether a command may read `path` without asking, as a `read` request may: inside the
    /// agent's folder or its knowledge, and never a key file (ADR 0061).
    pub(crate) fn may_read(&self, path: &Path) -> bool {
        self.readable(&resolve(path))
    }

    /// Whether a command may write `path` without asking, as an `edit` request may: only with
    /// `allow.edits`, inside the agent's folder, never the folders it is offered skills from
    /// (ADR 0061).
    pub(crate) fn may_write(&self, path: &Path) -> bool {
        self.allow.edits && self.editable(&resolve(path))
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
        !self.private(path)
            && (path.starts_with(&self.folder)
                || self
                    .skills_folder
                    .as_ref()
                    .is_some_and(|skills| path.starts_with(skills))
                || self.readable.iter().any(|root| path.starts_with(root)))
    }

    /// Whether `path` is `LoomWatch`'s own, which no agent reads without asking wherever its folder
    /// or knowledge reaches: everything in the state folder but the skills. A file directly in the
    /// state folder (the key, the database, the approvals) stays private even for an agent working
    /// in the state folder itself.
    fn private(&self, path: &Path) -> bool {
        let Some(state) = &self.state_dir else {
            return false;
        };
        if !path.starts_with(state) {
            return false;
        }
        if let Some(skills) = &self.skills_folder
            && let Ok(inside) = path.strip_prefix(skills)
        {
            // What the Skills page took away or is still unpacking stays LoomWatch's.
            return inside
                .components()
                .next()
                .is_some_and(|first| first.as_os_str().to_string_lossy().starts_with('.'));
        }
        path.parent() == Some(state.as_path())
            || !(path.starts_with(&self.folder) && self.folder.starts_with(state))
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
    /// Why Auto mode left this command to the operator, when the run is in Auto mode (ADR 0061).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto: Option<String>,
    /// What the operator may change before allowing it ([`editable`]): the command to run or the
    /// address to fetch, whole. Absent for anything else.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edit: Option<PermissionEdit>,
    /// What "Allow for this run" covers ([`grant_scope`]). Internal: the card shows `kind`.
    #[serde(skip)]
    pub scope: String,
}

/// The one argument of a request the operator may change before allowing it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionEdit {
    /// `command` or `url`: the argument's name in the tool's input.
    pub field: String,
    /// Its whole value, uncut.
    pub value: String,
}

/// The longest edited command or address, or answer in the agent's place, the operator may send.
pub const MAX_ANSWER_CHARS: usize = 4000;

/// What of `request` the operator may change before allowing it: a command's command line, or the
/// address a fetch opens. An MCP tool's arguments are its own, so nothing of one is offered.
#[must_use]
pub fn editable(request: &Value) -> Option<PermissionEdit> {
    if mcp_tool(request).is_some() {
        return None;
    }
    let call = request.pointer("/params/toolCall")?;
    let field = match call.pointer("/kind").and_then(Value::as_str)? {
        "execute" => "command",
        "fetch" => "url",
        _ => return None,
    };
    let value = call
        .pointer(&format!("/rawInput/{field}"))
        .and_then(Value::as_str)?;
    Some(PermissionEdit {
        field: field.to_owned(),
        value: value.to_owned(),
    })
}

/// The tool input `request` asked for with its editable argument set to `text`, as the operator
/// changed it. `None` when nothing of the request may be changed.
#[must_use]
pub fn edited_input(request: &Value, input: &Value, text: &str) -> Option<Value> {
    let edit = editable(request)?;
    let mut input = input.clone();
    input
        .as_object_mut()?
        .insert(edit.field, Value::String(text.to_owned()));
    Some(input)
}

/// What the operator chose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionDecision {
    /// This request only.
    AllowOnce,
    /// This request and every later one of the same kind from this agent, until the run ends.
    AllowRun,
    /// This request and every later one for the same thing from any agent in the run, until it
    /// ends: one answer for a team whose agents all reach for the same tool.
    AllowTeam,
    Deny,
    /// This request only, as the operator changed it ([`PermissionEdit`]): the reply's text is the
    /// new command or address.
    Edit,
    /// Not this request: the reply's text goes back to the agent as what the tool returned.
    Answer,
}

/// The operator's answer to one request, as the waiting agent receives it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionReply {
    pub decision: PermissionDecision,
    /// The changed command or address for [`PermissionDecision::Edit`], or the words for
    /// [`PermissionDecision::Answer`].
    pub text: Option<String>,
}

/// How a request the policy declined was finally answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AskOutcome {
    /// Nobody could be asked: a routine, a finished run, or no run at all. Declined.
    NotAsked,
    /// The operator allowed this kind for the rest of the run earlier; allowed without asking.
    AllowedForRun,
    /// The run is in Auto mode and the command only reads or downloads (ADR 0061).
    AutoApproved,
    Answered(PermissionDecision),
    /// Allowed once as the operator changed it: the new command or address.
    Edited(String),
    /// Not run: the operator answered in the agent's place with these words.
    AnsweredInstead(String),
    /// Nobody answered within [`PERMISSION_WAIT`]. Declined.
    TimedOut,
}

impl AskOutcome {
    /// Whether the tool runs. An answer in its place does not: the agent gets the words instead.
    #[must_use]
    pub fn allows(&self) -> bool {
        matches!(
            self,
            Self::AllowedForRun
                | Self::AutoApproved
                | Self::Edited(_)
                | Self::Answered(
                    PermissionDecision::AllowOnce
                        | PermissionDecision::AllowRun
                        | PermissionDecision::AllowTeam
                )
        )
    }

    /// The word the archive records for this outcome.
    #[must_use]
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::NotAsked => "not_asked",
            Self::AllowedForRun => "allowed_for_run",
            Self::AutoApproved => "auto_approved",
            Self::Answered(PermissionDecision::AllowOnce) => "allow_once",
            Self::Answered(PermissionDecision::AllowRun) => "allow_run",
            Self::Answered(PermissionDecision::AllowTeam) => "allow_team",
            Self::Answered(PermissionDecision::Deny) => "deny",
            Self::Answered(PermissionDecision::Edit) | Self::Edited(_) => "edited",
            Self::Answered(PermissionDecision::Answer) | Self::AnsweredInstead(_) => "answered",
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
/// Part of [`crate::engine::ProcessSpec`], so a respawned stage keeps asking the same run.
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

    /// What this agent's next model call meets at its run's spool (ADR 0068): the same operator
    /// who answers its requests is the one who adds money or finishes the run.
    pub(crate) fn spend_gate(&self) -> crate::spend::Gate {
        self.desk
            .registry()
            .spend_gate(&self.run_id, &self.agent, &self.name)
    }

    /// Adds what one of this agent's model calls cost to its run's spool.
    pub(crate) fn count_spend(&self, usd: f64) {
        self.desk
            .registry()
            .count_spend(&self.run_id, &self.agent, usd);
    }

    /// Why this agent's run may make no more model calls at all, once it may not.
    pub(crate) fn spend_stopped(&self) -> Option<crate::spend::SpendStopped> {
        self.desk.registry().spend_stopped(&self.run_id)
    }

    /// What Auto mode makes of `request` (ADR 0061), when this run is in Auto mode and the request
    /// is one of the app's own commands; `policy` is the asking agent's.
    #[must_use]
    pub fn auto(
        &self,
        request: &Value,
        policy: &PermissionPolicy,
    ) -> Option<crate::auto_mode::Verdict> {
        if !self.desk.registry().auto_mode(&self.run_id) {
            return None;
        }
        crate::auto_mode::decide(request, policy)
    }

    /// Put one declined `session/request_permission` on the run record for the operator to answer,
    /// with why Auto mode left it to them, when it did. `None` when nobody can be asked — a
    /// routine, or a run that has ended — and the request is declined at once, as every request
    /// was before ADR 0040.
    #[must_use]
    pub fn open(&self, request: &Value, auto: Option<String>) -> Option<OpenRequest> {
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
            auto,
            edit: editable(request),
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
    answer: tokio::sync::oneshot::Receiver<PermissionReply>,
}

impl OpenRequest {
    /// Wait for the operator, at most [`PERMISSION_WAIT`], then take the request off the record.
    /// The app is blocked on this answer, so nothing races the ACP request timeout: that only
    /// runs while a line is being awaited.
    pub async fn wait(self) -> AskOutcome {
        let outcome = match tokio::time::timeout(PERMISSION_WAIT, self.answer).await {
            Ok(Ok(PermissionReply {
                decision: PermissionDecision::Edit,
                text: Some(text),
            })) => AskOutcome::Edited(text),
            Ok(Ok(PermissionReply {
                decision: PermissionDecision::Answer,
                text: Some(text),
            })) => AskOutcome::AnsweredInstead(text),
            Ok(Ok(reply)) => AskOutcome::Answered(reply.decision),
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
pub(crate) fn resolve(path: &Path) -> PathBuf {
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
        /// A folder of its own per test. The clock alone is not enough: on a Mac it counts in
        /// microseconds, so two tests starting together shared a folder, and the first to finish
        /// deleted it under the other.
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!(
                "loomwatch-permissions-{}-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
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

    /// "Edit, then allow" is offered for a command line or a fetch's address, whole, and for
    /// nothing else: not a file write, not an MCP tool, whatever kind it carries.
    #[test]
    fn only_a_command_or_an_address_may_be_changed_before_it_is_allowed() {
        let ask = |kind: &str, input: Value| json!({"params": {"toolCall": {"kind": kind, "title": "Run", "rawInput": input}}});
        let long = "echo ".to_owned() + &"x".repeat(DETAIL_CHARS * 2);
        let command = ask("execute", json!({"command": long}));
        assert_eq!(
            editable(&command),
            Some(PermissionEdit {
                field: "command".to_owned(),
                value: long.clone()
            })
        );
        assert_eq!(
            editable(&ask("fetch", json!({"url": "https://example.com"}))).map(|edit| edit.field),
            Some("url".to_owned())
        );
        assert_eq!(
            editable(&ask("edit", json!({"path": "a.md", "content": "x"}))),
            None
        );
        assert_eq!(
            editable(&ask(
                "execute",
                json!({"server": "notion", "tool": "search", "command": "x"})
            )),
            None
        );
        assert_eq!(
            edited_input(
                &command,
                &json!({"command": long, "timeout_seconds": 5}),
                "ls"
            ),
            Some(json!({"command": "ls", "timeout_seconds": 5}))
        );
    }

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

    /// ADR 0060: a skill the operator turned off is left out of the ones the agent is offered. One
    /// wired to the agent, or a tool `LoomWatch` serves it, is never caught: wiring is how it is
    /// delivered.
    #[test]
    fn a_turned_off_skill_or_tool_is_withheld_but_never_one_the_canvas_gives() {
        let off = |kind, name: &str| TurnedOff {
            kind,
            name: name.to_owned(),
        };
        let wired = CapabilityRef {
            kind: CapabilityKind::Skill,
            name: "canvas-design".to_owned(),
            path: None,
            notion: None,
        };
        let policy = PermissionPolicy::new(
            AgentAllow::default(),
            Path::new("/work"),
            [],
            ["loomwatch-team-bus".to_owned(), "notion-local".to_owned()],
        )
        .turning_off(
            &[
                off(CapabilityKind::Skill, "notebooklm"),
                off(CapabilityKind::Skill, "canvas-design"),
                off(CapabilityKind::Tool, "notion-local"),
            ],
            &[wired],
        );
        assert_eq!(policy.turned_off_skills(), vec!["notebooklm".to_owned()]);
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
    fn connected_knowledge_is_read_without_any_switch() {
        let scratch = Scratch::new();
        let none = policy(&scratch, AgentAllow::default());
        let brief = scratch.0.join("notes/brief.md");
        assert!(none.approves(&request(
            Some("read"),
            "Read brief.md",
            &[&brief.to_string_lossy()]
        )));
        assert!(!none.approves(&request(Some("read"), "Read hosts", &["/etc/hosts"])));
    }

    /// `LoomWatch`'s own files are never read without asking, wherever an agent's folder or
    /// knowledge reaches: the key, the database, the approvals. The skills in its skills folder are
    /// read by every agent.
    #[test]
    fn loomwatchs_own_files_are_never_read_without_asking() {
        let scratch = Scratch::new();
        let state = scratch.0.join("state");
        fs::create_dir_all(state.join("skills/notes")).expect("skills");
        let at = |relative: &str| scratch.0.join(relative).to_string_lossy().into_owned();
        let read = |policy: &PermissionPolicy, path: &str| {
            policy.approves(&request(Some("read"), "Read", &[path]))
        };
        let reaching =
            PermissionPolicy::new(ALL, &scratch.0.join("agent"), [scratch.0.clone()], [])
                .keeping_private(&state);
        assert!(!read(&reaching, &at("state/keys.json")));
        assert!(!read(&reaching, &at("state/loomwatch.db")));
        assert!(!read(&reaching, &at("state/models/cache.json")));
        assert!(read(&reaching, &at("state/skills/notes/SKILL.md")));
        assert!(!read(&reaching, &at("state/skills/.removed/old/SKILL.md")));
        assert!(!read(
            &reaching,
            &at("state/skills/.staging/inspect-1/SKILL.md")
        ));
        assert!(read(&reaching, &at("agent/notes.md")));
        // Its instructions list the skills in LoomWatch's folder, so it reads them wherever it works,
        // and still nothing else there.
        let elsewhere =
            PermissionPolicy::new(ALL, &scratch.0.join("agent"), [], []).keeping_private(&state);
        assert!(read(&elsewhere, &at("state/skills/notes/SKILL.md")));
        assert!(!read(&elsewhere, &at("state/skills/.removed/old/SKILL.md")));
        assert!(!read(&elsewhere, &at("state/keys.json")));
        // The key file is never put to the operator at all.
        let key_read = request(Some("read"), "Read keys.json", &[&at("state/keys.json")]);
        assert!(elsewhere.reaches_key(&key_read));
        assert!(!elsewhere.reaches_key(&request(
            Some("read"),
            "Read",
            &[&at("state/skills/notes/SKILL.md")]
        )));
        // An agent working inside the state folder keeps its own folder, never the files beside it.
        let inside =
            PermissionPolicy::new(ALL, &state.join("work"), [], []).keeping_private(&state);
        assert!(read(&inside, &at("state/work/draft.md")));
        assert!(!read(&inside, &at("state/keys.json")));
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
