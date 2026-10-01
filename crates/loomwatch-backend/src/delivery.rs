//! Delivering wired knowledge sources and tools to an agent (ADR 0029).
//!
//! Skills are delivered by `workspace` (ADR 0012, 0019, 0021). This module does the same for the
//! other two Library kinds, and `workspace::materialise` calls it once per agent:
//!
//! * A **knowledge source** is supplied as the snapshot the inspector's Contents shows
//!   ([`capabilities::knowledge_snapshot`]) — what the operator sees is what the agent gets — and a
//!   source that is a folder is also a read grant for that folder.
//! * A **tool** is the operator's own MCP server definition, passed to the harness in ACP's
//!   `mcpServers` beside the Team Bus.
//!
//! Where `LoomWatch` knows the receiving harness's per-workspace permission file (Claude Code's
//! `.claude/settings.json`), the grant is written there, because the harness asks `LoomWatch` and
//! `LoomWatch` refuses every prompt. Elsewhere the harness's own policy decides, and the record
//! says so.
//!
//! A tool in the Library is an MCP server the operator already configured for Claude Code, Codex
//! or `OpenCode`. Delivering it to an agent means passing that same server in `session/new`'s
//! `mcpServers`, beside the Team Bus, so delivery works on every ACP harness rather than on the one
//! whose config file it happens to live in.
//!
//! The three config formats name the same facts differently, and each has a way to say something
//! ACP cannot carry. Those cases are refused with the reason rather than approximated: a server
//! delivered without the working directory or the tool filter its owner gave it is not the server
//! the operator configured.
//!
//! Values — environment variables, header values, tokens — leave this module only inside
//! [`DeliveredTool::server_definition`], which is handed to the harness process and never
//! serialised. Everything the archive, the API or the UI sees names them and nothing more.

use std::fmt;
use std::fs;
use std::path::Path;

use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};

use crate::capabilities::{
    self, CapabilityDefinition, CapabilityInventory, ToolDefinition, ToolFormat,
};
use crate::config::{AgentConfig, CapabilityKind};
use crate::workspace::Harness;

/// The most knowledge one agent is handed in its prompt. Each snapshot is already bounded (a
/// listing, a README excerpt, recent session titles); this stops many of them adding up to a
/// prompt nobody intended, and fails the run rather than shortening what the operator connected.
pub const KNOWLEDGE_BUDGET_BYTES: usize = 64 * 1024;

/// One knowledge source, read for one agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveredKnowledge {
    pub name: String,
    /// The Library's provenance, e.g. `LoomWatch + OpenCode`.
    pub source: String,
    /// Folders the agent may read, for a source that is one.
    pub folders: Vec<String>,
    /// Who decides whether reading [`Self::folders`] is allowed. `None` when there are none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_access: Option<Permission>,
    pub chars: usize,
    /// SHA-256 of the snapshot as supplied, so the record proves which bytes the agent read.
    pub sha256: String,
    /// The snapshot itself. Archived in full as its prompt section, so not twice here.
    #[serde(skip)]
    pub contents: Vec<CapabilityDefinition>,
}

impl DeliveredKnowledge {
    /// The snapshot as the prompt carries it.
    #[must_use]
    pub fn rendered_contents(&self) -> String {
        self.contents
            .iter()
            .map(|part| format!("### {} — {}\n{}", part.source, part.path, part.content))
            .collect::<Vec<_>>()
            .join("\n\n")
    }
}

/// Everything besides skills that one agent is handed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Delivery {
    pub knowledge: Vec<DeliveredKnowledge>,
    pub tools: Vec<DeliveredTool>,
}

impl Delivery {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.knowledge.is_empty() && self.tools.is_empty()
    }
}

/// The Team Bus's own server name, which no delivered tool may take.
pub const RESERVED_SERVER: &str = "loomwatch-team-bus";

/// Resolve every knowledge source and tool `agent` wires, or say which one cannot be delivered.
///
/// # Errors
///
/// Returns one sentence naming the capability and what to do: not found, a memory source wired as
/// knowledge, nothing readable, over the knowledge budget, a tool with no usable definition, or two
/// tools that would take the same server name.
pub fn prepare_for(
    home: Option<&Path>,
    teams_root: &Path,
    inventory: &CapabilityInventory,
    agent: &AgentConfig,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<Delivery, String> {
    let mut delivery = Delivery::default();
    let mut knowledge_bytes = 0usize;
    for capability in &agent.capabilities {
        let name = capability.name.as_str();
        match capability.kind {
            CapabilityKind::Skill => {}
            CapabilityKind::Knowledge => {
                if delivery.knowledge.iter().any(|item| item.name == name) {
                    continue;
                }
                let item = find(&inventory.sources, name).ok_or_else(|| {
                    format!("cannot use the knowledge source {name}: no source by that name was found on this machine.")
                })?;
                if item.memory.is_some() {
                    return Err(format!(
                        "cannot use {name} as a knowledge capability: it is team memory, which reaches an agent through the team's memory settings (memory.inherits), not through capabilities."
                    ));
                }
                let snapshot = capabilities::knowledge_snapshot(home, teams_root, item);
                if snapshot.contents.is_empty() {
                    return Err(format!(
                        "cannot use the knowledge source {name}: nothing readable was found for it."
                    ));
                }
                let mut knowledge = DeliveredKnowledge {
                    name: item.name.clone(),
                    source: item.source.clone(),
                    folders: snapshot
                        .folders
                        .iter()
                        .map(|folder| folder.to_string_lossy().into_owned())
                        .collect(),
                    read_access: (!snapshot.folders.is_empty())
                        .then_some(Permission::HarnessPolicy),
                    chars: 0,
                    sha256: String::new(),
                    contents: snapshot.contents,
                };
                let rendered = knowledge.rendered_contents();
                knowledge_bytes += rendered.len();
                if knowledge_bytes > KNOWLEDGE_BUDGET_BYTES {
                    return Err(format!(
                        "the knowledge connected to this agent exceeds {} KiB once {name} is added; connect fewer sources to it.",
                        KNOWLEDGE_BUDGET_BYTES / 1024
                    ));
                }
                knowledge.chars = rendered.chars().count();
                knowledge.sha256 = format!("{:x}", Sha256::digest(rendered.as_bytes()));
                delivery.knowledge.push(knowledge);
            }
            CapabilityKind::Tool => {
                if delivery.tools.iter().any(|tool| tool.name == name) {
                    continue;
                }
                let item = find(&inventory.tools, name).ok_or_else(|| {
                    format!("cannot use the tool {name}: no tool by that name is configured on this machine.")
                })?;
                let definitions = home
                    .map(|home| capabilities::tool_definitions_for(home, item))
                    .unwrap_or_default();
                let definition = preferred(&definitions, Harness::of(agent).label()).ok_or_else(|| {
                    format!("cannot use the tool {name}: its server definition could not be read from the config it was found in.")
                })?;
                let tool = prepare(&item.name, definition, env)
                    .map_err(|reason| format!("cannot use the tool {name}: {reason}"))?;
                if tool.server == RESERVED_SERVER {
                    return Err(format!(
                        "cannot use the tool {name}: its server is named {RESERVED_SERVER}, which is the Team Bus's name. Rename it in {}.",
                        display_path(Path::new(&tool.config_path), home)
                    ));
                }
                if let Some(other) = delivery
                    .tools
                    .iter()
                    .find(|other| other.server == tool.server)
                {
                    return Err(format!(
                        "cannot use the tools {} and {name} together: both are the MCP server {}.",
                        other.name, tool.server
                    ));
                }
                delivery.tools.push(tool);
            }
        }
    }
    Ok(delivery)
}

/// Exact name first, then case-insensitively, the way skills are matched.
fn find<'a>(
    items: &'a [capabilities::DetectedCapability],
    name: &str,
) -> Option<&'a capabilities::DetectedCapability> {
    items.iter().find(|item| item.name == name).or_else(|| {
        items
            .iter()
            .find(|item| item.name.eq_ignore_ascii_case(name))
    })
}

/// Write the grants wiring implies into a Claude Code workspace's `.claude/settings.json`.
///
/// `base` is the settings carried over from the agent's declared cwd (ADR 0012 decision 3), or
/// `None`. The grant is exactly what was wired — read access to each knowledge folder, every tool
/// of each delivered server — merged into the operator's own rules, never replacing them: a `deny`
/// they wrote still wins, because Claude Code evaluates deny first.
///
/// # Errors
///
/// Returns an error when the carried-over settings are not a JSON object, or the file cannot be
/// written. Either way the grant cannot be made, and a run whose grant silently failed would have
/// every call refused.
pub fn grant_claude_access(
    workspace: &Path,
    base: Option<&[u8]>,
    delivery: &mut Delivery,
) -> Result<(), String> {
    let folders = delivery
        .knowledge
        .iter()
        .flat_map(|knowledge| knowledge.folders.iter().cloned())
        .collect::<Vec<_>>();
    if folders.is_empty() && delivery.tools.is_empty() {
        return Ok(());
    }
    let mut settings = match base {
        Some(bytes) => serde_json::from_slice::<Value>(bytes).map_err(|error| {
            format!("cannot grant access to the connected knowledge and tools: the carried-over .claude/settings.json is not valid JSON ({error}).")
        })?,
        None => json!({}),
    };
    let permissions = settings
        .as_object_mut()
        .ok_or("cannot grant access to the connected knowledge and tools: the carried-over .claude/settings.json is not a JSON object.")?
        .entry("permissions")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("cannot grant access: `permissions` in the carried-over .claude/settings.json is not an object.")?;
    let mut extend = |key: &str, values: Vec<String>| -> Result<(), String> {
        let list = permissions
            .entry(key)
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or_else(|| format!("cannot grant access: `permissions.{key}` in the carried-over .claude/settings.json is not a list."))?;
        for value in values {
            if !list
                .iter()
                .any(|existing| existing.as_str() == Some(&value))
            {
                list.push(Value::String(value));
            }
        }
        Ok(())
    };
    extend("additionalDirectories", folders.clone())?;
    // `//` is Claude Code's spelling of an absolute path in a permission rule.
    let mut allow = folders
        .iter()
        .map(|folder| format!("Read(/{}/**)", folder.trim_end_matches('/')))
        .collect::<Vec<_>>();
    allow.extend(
        delivery
            .tools
            .iter()
            .map(|tool| format!("mcp__{}", tool.server)),
    );
    extend("allow", allow)?;
    let directory = workspace.join(".claude");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let text = serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())?;
    fs::write(directory.join("settings.json"), text).map_err(|error| {
        format!("cannot grant access to the connected knowledge and tools: {error}")
    })?;
    for knowledge in &mut delivery.knowledge {
        if knowledge.read_access.is_some() {
            knowledge.read_access = Some(Permission::Granted);
        }
    }
    for tool in &mut delivery.tools {
        tool.permission = Permission::Granted;
    }
    Ok(())
}

/// The daemon's environment, for [`prepare_for`].
#[must_use]
pub fn process_env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// How a harness reaches the server. ACP requires every agent to accept `stdio`; `http` and `sse`
/// only when the agent advertises them in `agentCapabilities.mcpCapabilities`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Transport {
    Stdio,
    Http,
    Sse,
}

impl Transport {
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Stdio => "stdio",
            Self::Http => "HTTP",
            Self::Sse => "SSE",
        }
    }
}

/// Who decides whether a call to a delivered capability is allowed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Permission {
    /// `LoomWatch` wrote an allow rule for exactly this capability into the workspace's harness
    /// settings, because wiring it was the operator's grant (ADR 0029 decisions 3 and 7).
    Granted,
    /// `LoomWatch` knows no per-workspace grant for this harness, so the harness's own policy
    /// decides — and a prompt it raises is still refused like every other.
    HarnessPolicy,
}

/// One tool, ready to hand to a harness.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveredTool {
    /// The Library name the team file wires.
    pub name: String,
    /// The MCP server name the harness lists the tools under.
    pub server: String,
    /// Whose config the definition was read from: `Claude Code`, `Codex` or `OpenCode`.
    pub provider: String,
    pub config_path: String,
    pub transport: Transport,
    /// Names only. The values are in [`Self::server_definition`].
    pub env_names: Vec<String>,
    /// Names only, for the same reason.
    pub header_names: Vec<String>,
    pub permission: Permission,
    /// The ACP `McpServer` object, values included. Never serialised and never printed.
    #[serde(skip)]
    pub server_definition: Value,
}

impl fmt::Debug for DeliveredTool {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DeliveredTool")
            .field("name", &self.name)
            .field("server", &self.server)
            .field("provider", &self.provider)
            .field("transport", &self.transport)
            .field("env_names", &self.env_names)
            .field("header_names", &self.header_names)
            .field("permission", &self.permission)
            .finish_non_exhaustive()
    }
}

/// Convert one definition into a deliverable tool, or say why it cannot be delivered as written.
///
/// `env` reads the daemon's environment; it is a parameter so a test can supply one.
///
/// # Errors
///
/// Returns a sentence naming the config file and what to change when the definition is disabled,
/// incomplete, uses a field ACP cannot carry, or references an environment variable the daemon
/// does not have.
pub fn prepare(
    name: &str,
    definition: &ToolDefinition,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<DeliveredTool, String> {
    let config = definition.config_path.display();
    let server = definition.server.as_str();
    let object = definition.value.as_object().ok_or_else(|| {
        format!("its definition {server} in {config} is not a table of settings.")
    })?;
    if object.get("enabled").and_then(Value::as_bool) == Some(false) {
        return Err(format!(
            "the server {server} is disabled in {config}. Enable it there, or disconnect the tool."
        ));
    }
    let spec = match definition.format {
        ToolFormat::Claude => claude_spec(object, env),
        ToolFormat::Codex => codex_spec(object, env),
        ToolFormat::OpenCode => opencode_spec(object, env),
    }
    .map_err(|reason| format!("the server {server} in {config} {reason}"))?;
    Ok(DeliveredTool {
        name: name.to_owned(),
        server: server.to_owned(),
        provider: definition.provider.clone(),
        config_path: definition.config_path.to_string_lossy().into_owned(),
        transport: spec.transport(),
        env_names: spec.env.iter().map(|(key, _)| key.clone()).collect(),
        header_names: spec.headers.iter().map(|(key, _)| key.clone()).collect(),
        permission: Permission::HarnessPolicy,
        server_definition: spec.acp(server),
    })
}

/// A server definition reduced to what ACP can carry.
struct ServerSpec {
    endpoint: Endpoint,
    env: Vec<(String, String)>,
    headers: Vec<(String, String)>,
}

enum Endpoint {
    Command { command: String, args: Vec<String> },
    Url { url: String, transport: Transport },
}

impl ServerSpec {
    const fn transport(&self) -> Transport {
        match &self.endpoint {
            Endpoint::Command { .. } => Transport::Stdio,
            Endpoint::Url { transport, .. } => *transport,
        }
    }

    fn acp(&self, server: &str) -> Value {
        let pairs = |items: &[(String, String)]| {
            items
                .iter()
                .map(|(name, value)| json!({"name": name, "value": value}))
                .collect::<Vec<_>>()
        };
        match &self.endpoint {
            Endpoint::Command { command, args } => json!({
                "name": server,
                "command": command,
                "args": args,
                "env": pairs(&self.env),
            }),
            Endpoint::Url { url, transport } => json!({
                "type": if *transport == Transport::Sse { "sse" } else { "http" },
                "name": server,
                "url": url,
                "headers": pairs(&self.headers),
            }),
        }
    }
}

type Object = serde_json::Map<String, Value>;

/// Claude Code's `mcpServers` entry: `{command, args, env}` or `{type: http|sse, url, headers}`,
/// with `${VAR}` and `${VAR:-default}` expanded in every string.
fn claude_spec(
    object: &Object,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<ServerSpec, String> {
    let expand = |text: &str| expand_braces(text, env);
    let kind = object.get("type").and_then(Value::as_str);
    if let Some(url) = object.get("url").and_then(Value::as_str) {
        let transport = match kind {
            Some("sse") => Transport::Sse,
            Some("http" | "streamable-http") | None => Transport::Http,
            Some(other) => return Err(format!("has the type {other}, which ACP cannot carry.")),
        };
        return Ok(ServerSpec {
            endpoint: Endpoint::Url {
                url: expand(url)?,
                transport,
            },
            env: Vec::new(),
            headers: string_map(object.get("headers"), "headers", &expand)?,
        });
    }
    if kind.is_some_and(|kind| kind != "stdio") {
        return Err("has a remote type but no url.".to_owned());
    }
    let command = object
        .get("command")
        .and_then(Value::as_str)
        .ok_or("names neither a command nor a url.")?;
    Ok(ServerSpec {
        endpoint: Endpoint::Command {
            command: expand(command)?,
            args: string_list(object.get("args"), "args", &expand)?,
        },
        env: string_map(object.get("env"), "env", &expand)?,
        headers: Vec::new(),
    })
}

/// Codex's `[mcp_servers.<name>]` table.
fn codex_spec(object: &Object, env: &dyn Fn(&str) -> Option<String>) -> Result<ServerSpec, String> {
    let literal = |text: &str| Ok::<_, String>(text.to_owned());
    // Each of these changes what the server is or what it exposes, and ACP's server definition has
    // nowhere to put it. Delivering the server without it would hand the agent something its owner
    // did not configure.
    for (field, why) in [
        ("cwd", "sets a working directory"),
        ("enabled_tools", "limits which of its tools are exposed"),
        ("disabled_tools", "hides some of its tools"),
    ] {
        if object.contains_key(field) {
            return Err(format!(
                "{why} (`{field}`), which ACP's MCP server definition cannot carry."
            ));
        }
    }
    let required = |variable: &str| {
        env(variable).ok_or_else(|| {
            format!("needs the environment variable {variable}, which the LoomWatch daemon was not started with.")
        })
    };
    if let Some(url) = object.get("url").and_then(Value::as_str) {
        let mut headers = string_map(object.get("http_headers"), "http_headers", &literal)?;
        for (header, variable) in
            string_map(object.get("env_http_headers"), "env_http_headers", &literal)?
        {
            headers.push((header, required(&variable)?));
        }
        if let Some(variable) = object.get("bearer_token_env_var").and_then(Value::as_str) {
            headers.push((
                "Authorization".to_owned(),
                format!("Bearer {}", required(variable)?),
            ));
        }
        return Ok(ServerSpec {
            endpoint: Endpoint::Url {
                url: url.to_owned(),
                transport: Transport::Http,
            },
            env: Vec::new(),
            headers,
        });
    }
    let command = object
        .get("command")
        .and_then(Value::as_str)
        .ok_or("names neither a command nor a url.")?;
    let mut variables = string_map(object.get("env"), "env", &literal)?;
    // `env_vars` passes the named variables through from Codex's own environment; the daemon's is
    // the closest equivalent, and a name it does not have is passed through as absent, as Codex
    // does.
    for variable in string_list(object.get("env_vars"), "env_vars", &literal)? {
        if let Some(value) = env(&variable) {
            variables.push((variable, value));
        }
    }
    Ok(ServerSpec {
        endpoint: Endpoint::Command {
            command: command.to_owned(),
            args: string_list(object.get("args"), "args", &literal)?,
        },
        env: variables,
        headers: Vec::new(),
    })
}

/// `OpenCode`'s `mcp.<name>` entry: `{type: local, command: [..], environment}` or
/// `{type: remote, url, headers}`, with `{env:VAR}` expanded.
fn opencode_spec(
    object: &Object,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<ServerSpec, String> {
    let expand = |text: &str| expand_opencode(text, env);
    match object.get("type").and_then(Value::as_str) {
        Some("remote") => {
            let url = object
                .get("url")
                .and_then(Value::as_str)
                .ok_or("is remote but has no url.")?;
            Ok(ServerSpec {
                endpoint: Endpoint::Url {
                    url: expand(url)?,
                    transport: Transport::Http,
                },
                env: Vec::new(),
                headers: string_map(object.get("headers"), "headers", &expand)?,
            })
        }
        Some("local") | None => {
            let mut command = string_list(object.get("command"), "command", &expand)?.into_iter();
            let program = command.next().ok_or("has an empty command.")?;
            Ok(ServerSpec {
                endpoint: Endpoint::Command {
                    command: program,
                    args: command.collect(),
                },
                env: string_map(object.get("environment"), "environment", &expand)?,
                headers: Vec::new(),
            })
        }
        Some(other) => Err(format!("has the type {other}, which ACP cannot carry.")),
    }
}

fn string_list(
    value: Option<&Value>,
    field: &str,
    expand: &dyn Fn(&str) -> Result<String, String>,
) -> Result<Vec<String>, String> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    value
        .as_array()
        .ok_or_else(|| format!("has a `{field}` that is not a list."))?
        .iter()
        .map(|item| {
            item.as_str()
                .ok_or_else(|| format!("has a `{field}` entry that is not text."))
                .and_then(expand)
        })
        .collect()
}

fn string_map(
    value: Option<&Value>,
    field: &str,
    expand: &dyn Fn(&str) -> Result<String, String>,
) -> Result<Vec<(String, String)>, String> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    value
        .as_object()
        .ok_or_else(|| format!("has a `{field}` that is not a table."))?
        .iter()
        .map(|(key, item)| {
            let text = item
                .as_str()
                .ok_or_else(|| format!("has a `{field}.{key}` that is not text."))?;
            Ok((key.clone(), expand(text)?))
        })
        .collect()
}

/// Claude Code's `${VAR}` and `${VAR:-default}`.
fn expand_braces(text: &str, env: &dyn Fn(&str) -> Option<String>) -> Result<String, String> {
    let mut output = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("${") {
        output.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let end = after
            .find('}')
            .ok_or_else(|| format!("has an unclosed `${{` in {text:?}."))?;
        let (variable, default) = after[..end]
            .split_once(":-")
            .map_or((&after[..end], None), |(name, default)| {
                (name, Some(default))
            });
        let value = env(variable).or_else(|| default.map(str::to_owned)).ok_or_else(|| {
            format!("needs the environment variable {variable}, which the LoomWatch daemon was not started with.")
        })?;
        output.push_str(&value);
        rest = &after[end + 1..];
    }
    output.push_str(rest);
    Ok(output)
}

/// `OpenCode`'s `{env:VAR}`, which expands to nothing when the variable is unset.
fn expand_opencode(text: &str, env: &dyn Fn(&str) -> Option<String>) -> Result<String, String> {
    let mut output = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("{env:") {
        output.push_str(&rest[..start]);
        let after = &rest[start + 5..];
        let end = after
            .find('}')
            .ok_or_else(|| format!("has an unclosed `{{env:` in {text:?}."))?;
        output.push_str(&env(&after[..end]).unwrap_or_default());
        rest = &after[end + 1..];
    }
    output.push_str(rest);
    Ok(output)
}

/// Pick the definition the receiving harness would itself use, when there is one: an agent on
/// Claude Code gets Claude Code's copy of a server configured in several places.
#[must_use]
pub fn preferred<'a>(
    definitions: &'a [ToolDefinition],
    harness_provider: &str,
) -> Option<&'a ToolDefinition> {
    definitions
        .iter()
        .find(|definition| definition.provider == harness_provider)
        .or_else(|| definitions.first())
}

/// The config file a definition came from, shortened under the home folder for messages.
#[must_use]
pub fn display_path(path: &Path, home: Option<&Path>) -> String {
    home.and_then(|home| path.strip_prefix(home).ok())
        .map_or_else(
            || path.display().to_string(),
            |relative| format!("~/{}", relative.display()),
        )
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::config::CapabilityRef;
    use crate::memory::PromptSectionKind as Kind;

    struct TempDirectory(PathBuf);

    impl TempDirectory {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("loomwatch-delivery-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).expect("create temp directory");
            Self(path)
        }
    }

    impl Drop for TempDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn agent(cmd: &str, capabilities: &[(CapabilityKind, &str)]) -> AgentConfig {
        let mut agent = crate::config::TeamConfig::parse(&format!(
            "schemaVersion: 1\nid: t\nname: T\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: {cmd}\n      cwd: .\n    model: test/model\n"
        ))
        .expect("team")
        .agents
        .remove(0);
        agent.capabilities = capabilities
            .iter()
            .map(|(kind, name)| CapabilityRef {
                kind: *kind,
                name: (*name).to_owned(),
            })
            .collect();
        agent
    }

    /// A machine with one project folder (the teams root's parent) and one MCP server configured
    /// for Claude Code.
    fn machine() -> (TempDirectory, PathBuf, PathBuf) {
        let directory = TempDirectory::new();
        let home = directory.0.join("home");
        let project = directory.0.join("demo");
        let teams = project.join("teams");
        fs::create_dir_all(&home).expect("home");
        fs::create_dir_all(&teams).expect("teams");
        fs::write(project.join("README.md"), "# Demo\nThe product.\n").expect("readme");
        fs::write(
            home.join(".claude.json"),
            r#"{"mcpServers": {"agentmemory": {"command": "npx", "args": ["-y", "@agentmemory/mcp"], "env": {"AGENTMEMORY_URL": "http://127.0.0.1:3111"}}}}"#,
        )
        .expect("claude config");
        (directory, home, teams)
    }

    #[test]
    fn a_wired_folder_and_tool_resolve_into_a_delivery() {
        let (_directory, home, teams) = machine();
        let inventory = capabilities::detect_capabilities(Some(&home), &teams);
        let delivery = prepare_for(
            Some(&home),
            &teams,
            &inventory,
            &agent(
                "claude-agent-acp",
                &[
                    (CapabilityKind::Knowledge, "demo project"),
                    (CapabilityKind::Tool, "Agent Memory"),
                    (CapabilityKind::Skill, "not-resolved-here"),
                ],
            ),
            &|_| None,
        )
        .expect("deliverable");

        let [knowledge] = delivery.knowledge.as_slice() else {
            panic!("one knowledge source: {delivery:?}");
        };
        let folder = fs::canonicalize(teams.parent().expect("project")).expect("canonical");
        assert_eq!(knowledge.folders, [folder.to_string_lossy()]);
        assert_eq!(knowledge.read_access, Some(Permission::HarnessPolicy));
        assert!(knowledge.rendered_contents().contains("The product."));
        assert_eq!(
            knowledge.chars,
            knowledge.rendered_contents().chars().count()
        );

        let [tool] = delivery.tools.as_slice() else {
            panic!("one tool: {delivery:?}");
        };
        assert_eq!(tool.server, "agentmemory");
        assert_eq!(tool.provider, "Claude Code");
        assert_eq!(tool.env_names, ["AGENTMEMORY_URL"]);
    }

    #[test]
    fn what_cannot_be_delivered_is_refused_by_name() {
        let (_directory, home, teams) = machine();
        let inventory = capabilities::detect_capabilities(Some(&home), &teams);
        for (kind, name, expected) in [
            (
                CapabilityKind::Knowledge,
                "nowhere project",
                "no source by that name",
            ),
            (
                CapabilityKind::Tool,
                "Missing Server",
                "no tool by that name",
            ),
        ] {
            let error = prepare_for(
                Some(&home),
                &teams,
                &inventory,
                &agent("claude-agent-acp", &[(kind, name)]),
                &|_| None,
            )
            .expect_err("refused");
            assert!(error.contains(name) && error.contains(expected), "{error}");
        }
    }

    /// Wiring is the operator's grant, so it is written — but into their rules, never over them.
    #[test]
    fn claude_grants_merge_into_the_operators_settings_and_keep_their_denies() {
        let (_directory, home, teams) = machine();
        let workspace = TempDirectory::new();
        let inventory = capabilities::detect_capabilities(Some(&home), &teams);
        let mut delivery = prepare_for(
            Some(&home),
            &teams,
            &inventory,
            &agent(
                "claude-agent-acp",
                &[
                    (CapabilityKind::Knowledge, "demo project"),
                    (CapabilityKind::Tool, "Agent Memory"),
                ],
            ),
            &|_| None,
        )
        .expect("deliverable");
        let base =
            br#"{"permissions": {"allow": ["WebSearch"], "deny": ["Bash"]}, "model": "opus"}"#;
        grant_claude_access(&workspace.0, Some(base), &mut delivery).expect("granted");
        // A second run over the same file adds nothing twice.
        grant_claude_access(&workspace.0, Some(base), &mut delivery).expect("granted again");

        let written: Value = serde_json::from_slice(
            &fs::read(workspace.0.join(".claude/settings.json")).expect("settings"),
        )
        .expect("json");
        let folder = &delivery.knowledge[0].folders[0];
        assert_eq!(
            written["permissions"]["allow"],
            json!([
                "WebSearch",
                format!("Read(/{folder}/**)"),
                "mcp__agentmemory"
            ])
        );
        assert_eq!(written["permissions"]["deny"], json!(["Bash"]));
        assert_eq!(
            written["permissions"]["additionalDirectories"],
            json!([folder])
        );
        assert_eq!(written["model"], "opus");
        assert_eq!(delivery.knowledge[0].read_access, Some(Permission::Granted));
        assert_eq!(delivery.tools[0].permission, Permission::Granted);

        let error = grant_claude_access(&workspace.0, Some(b"not json"), &mut delivery)
            .expect_err("unmergeable settings refuse the grant");
        assert!(error.contains("not valid JSON"), "{error}");
    }

    /// The sections land after the role and capabilities and before the task, the prompt text is
    /// exactly the sections joined (so the record and the prompt cannot disagree), and the
    /// knowledge is framed as material rather than instruction.
    #[test]
    fn knowledge_and_tools_are_composed_into_the_prompt_in_order() {
        let (_directory, home, teams) = machine();
        let inventory = capabilities::detect_capabilities(Some(&home), &teams);
        let wired = agent(
            "claude-agent-acp",
            &[
                (CapabilityKind::Knowledge, "demo project"),
                (CapabilityKind::Tool, "Agent Memory"),
            ],
        );
        let delivery =
            prepare_for(Some(&home), &teams, &inventory, &wired, &|_| None).expect("deliverable");
        let composed = crate::compose_prompt(
            &wired,
            &crate::memory::ContextPacket::default(),
            &crate::NodeTask::goal("Research the market"),
        )
        .with_delivery(&delivery, true);

        let kinds = composed
            .sections
            .iter()
            .map(|section| section.kind)
            .collect::<Vec<_>>();
        assert_eq!(
            kinds,
            [
                Kind::Role,
                Kind::Capabilities,
                Kind::Knowledge,
                Kind::Tool,
                Kind::Task
            ]
        );
        let joined = composed
            .sections
            .iter()
            .map(|section| format!("{}\n{}", section.heading, section.text))
            .collect::<Vec<_>>()
            .join("\n\n");
        assert_eq!(composed.text, joined);
        assert!(
            composed
                .text
                .contains("- demo project (knowledge)\n- Agent Memory (tool)")
        );
        assert!(
            composed.text.contains(
                "## Knowledge: demo project\nThe operator connected this knowledge source"
            )
        );
        assert!(composed.text.contains("not as instructions"));
        assert!(composed.text.contains("The product."));
        assert!(composed.text.contains("mcp__agentmemory__<tool>"));
        let meta = composed.meta();
        assert_eq!(meta["knowledge"][0]["name"], "demo project");
        assert_eq!(meta["tools"][0]["server"], "agentmemory");
        assert!(
            !meta.to_string().contains("http://127.0.0.1:3111"),
            "the record names env vars, never their values"
        );

        // Nothing wired, nothing changed.
        let plain = agent("claude-agent-acp", &[]);
        let before = crate::compose_prompt(
            &plain,
            &crate::memory::ContextPacket::default(),
            &crate::NodeTask::goal("x"),
        );
        let after = before.clone().with_delivery(&Delivery::default(), true);
        assert_eq!(before, after);
        assert!(after.meta().get("knowledge").is_none());
    }

    #[test]
    fn a_tool_cannot_take_the_team_bus_name() {
        let (_directory, home, teams) = machine();
        fs::write(
            home.join(".claude.json"),
            r#"{"mcpServers": {"loomwatch-team-bus": {"command": "x"}}}"#,
        )
        .expect("config");
        let inventory = capabilities::detect_capabilities(Some(&home), &teams);
        let error = prepare_for(
            Some(&home),
            &teams,
            &inventory,
            &agent(
                "claude-agent-acp",
                &[(CapabilityKind::Tool, "Loomwatch Team Bus")],
            ),
            &|_| None,
        )
        .expect_err("refused");
        assert!(error.contains("Team Bus"), "{error}");
    }

    fn definition(format: ToolFormat, value: Value) -> ToolDefinition {
        ToolDefinition {
            provider: match format {
                ToolFormat::Claude => "Claude Code",
                ToolFormat::Codex => "Codex",
                ToolFormat::OpenCode => "OpenCode",
            }
            .to_owned(),
            config_path: PathBuf::from("/home/operator/config"),
            server: "agentmemory".to_owned(),
            format,
            value,
        }
    }

    fn env(name: &str) -> Option<String> {
        match name {
            "TOKEN" => Some("secret-token".to_owned()),
            "HOME" => Some("/home/operator".to_owned()),
            _ => None,
        }
    }

    #[test]
    fn a_claude_stdio_server_becomes_an_acp_stdio_server_with_its_env_expanded() {
        let tool = prepare(
            "Agent Memory",
            &definition(
                ToolFormat::Claude,
                json!({"command": "npx", "args": ["-y", "agentmemory", "--home=${HOME}"], "env": {"API_KEY": "${TOKEN}", "MODE": "${MODE:-fast}"}}),
            ),
            &env,
        )
        .expect("deliverable");
        assert_eq!(tool.transport, Transport::Stdio);
        assert_eq!(
            tool.server_definition,
            json!({
                "name": "agentmemory",
                "command": "npx",
                "args": ["-y", "agentmemory", "--home=/home/operator"],
                "env": [{"name": "API_KEY", "value": "secret-token"}, {"name": "MODE", "value": "fast"}],
            })
        );
        assert_eq!(tool.env_names, ["API_KEY", "MODE"]);
    }

    /// The archive and the API see the delivered tool serialised and debug-printed; neither may
    /// carry a value from the operator's config.
    #[test]
    fn values_never_leave_through_serialisation_or_debug_output() {
        let tool = prepare(
            "Agent Memory",
            &definition(
                ToolFormat::Claude,
                json!({"type": "http", "url": "https://example.test/mcp", "headers": {"Authorization": "Bearer ${TOKEN}"}}),
            ),
            &env,
        )
        .expect("deliverable");
        assert_eq!(tool.transport, Transport::Http);
        assert_eq!(tool.header_names, ["Authorization"]);
        let serialised = serde_json::to_string(&tool).expect("serialise");
        let printed = format!("{tool:?}");
        for output in [&serialised, &printed] {
            assert!(!output.contains("secret-token"), "{output}");
        }
        assert!(
            tool.server_definition.to_string().contains("secret-token"),
            "the harness still receives the value"
        );
    }

    #[test]
    fn a_missing_variable_is_named_rather_than_delivered_empty() {
        let error = prepare(
            "Agent Memory",
            &definition(
                ToolFormat::Claude,
                json!({"command": "run", "env": {"KEY": "${NOPE}"}}),
            ),
            &env,
        )
        .expect_err("refused");
        assert!(error.contains("NOPE"), "{error}");
    }

    #[test]
    fn codex_servers_pass_their_env_and_refuse_what_acp_cannot_carry() {
        let tool = prepare(
            "Agent Memory",
            &definition(
                ToolFormat::Codex,
                json!({"command": "node", "args": ["server.js"], "env": {"A": "1"}, "env_vars": ["TOKEN", "UNSET"], "startup_timeout_sec": 10}),
            ),
            &env,
        )
        .expect("deliverable");
        assert_eq!(
            tool.server_definition["env"],
            json!([{"name": "A", "value": "1"}, {"name": "TOKEN", "value": "secret-token"}])
        );

        for (field, value) in [
            ("cwd", json!("/somewhere")),
            ("enabled_tools", json!(["one"])),
        ] {
            let mut object = json!({"command": "node"});
            object[field] = value;
            let error = prepare("Agent Memory", &definition(ToolFormat::Codex, object), &env)
                .expect_err("refused");
            assert!(error.contains(field), "{error}");
        }

        let disabled = prepare(
            "Computer Use",
            &definition(ToolFormat::Codex, json!({"command": "x", "enabled": false})),
            &env,
        )
        .expect_err("a disabled server is refused");
        assert!(disabled.contains("disabled"), "{disabled}");
    }

    #[test]
    fn a_codex_url_server_takes_its_bearer_token_from_the_environment() {
        let tool = prepare(
            "Docs",
            &definition(
                ToolFormat::Codex,
                json!({"url": "https://example.test/mcp", "bearer_token_env_var": "TOKEN"}),
            ),
            &env,
        )
        .expect("deliverable");
        assert_eq!(
            tool.server_definition["headers"],
            json!([{"name": "Authorization", "value": "Bearer secret-token"}])
        );
    }

    #[test]
    fn opencode_local_and_remote_servers_convert() {
        let local = prepare(
            "Agent Memory",
            &definition(
                ToolFormat::OpenCode,
                json!({"type": "local", "command": ["npx", "-y", "agentmemory"], "environment": {"KEY": "{env:TOKEN}"}, "enabled": true}),
            ),
            &env,
        )
        .expect("deliverable");
        assert_eq!(local.server_definition["command"], "npx");
        assert_eq!(
            local.server_definition["args"],
            json!(["-y", "agentmemory"])
        );
        assert_eq!(
            local.server_definition["env"],
            json!([{"name": "KEY", "value": "secret-token"}])
        );

        let remote = prepare(
            "Docs",
            &definition(
                ToolFormat::OpenCode,
                json!({"type": "remote", "url": "https://example.test/mcp"}),
            ),
            &env,
        )
        .expect("deliverable");
        assert_eq!(remote.transport, Transport::Http);
        assert_eq!(remote.server_definition["type"], "http");
    }

    #[test]
    fn the_receiving_harness_gets_its_own_copy_of_a_server_when_it_has_one() {
        let definitions = [
            definition(ToolFormat::Claude, json!({"command": "a"})),
            definition(ToolFormat::Codex, json!({"command": "b"})),
        ];
        assert_eq!(
            preferred(&definitions, "Codex").map(|item| item.provider.as_str()),
            Some("Codex")
        );
        assert_eq!(
            preferred(&definitions, "Gemini").map(|item| item.provider.as_str()),
            Some("Claude Code")
        );
    }
}
