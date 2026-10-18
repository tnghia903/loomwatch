//! Tools the operator connects (ADR 0069): MCP servers on the internet, such as Linear's or
//! Notion's, that an agent the operator gives one to can call.
//!
//! - The list lives in `<state dir>/tools.json`: each tool's name, address, how it signs in, and
//!   the calls it offered when last checked. None of it is a secret.
//! - Secrets (a sign-in's tokens, a pasted token) are in the Keychain or a private file
//!   ([`vault`]).
//! - Connecting happens in Connections or an agent's Tools block ([`api`]). A server that wants a
//!   sign-in gets one through its own site in a new window ([`sign_in`]); one that wants a token
//!   gets the one the operator pastes.
//! - In a run, an agent given a tool is offered its calls ([`host::OutsideTools`]). Each call asks
//!   the operator first unless they always allow that call for that agent (`alwaysAllow` on the
//!   agent's tool entry). Only the daemon ever holds the connection; the agent never sees a token.
//!
//! Only servers reached over HTTPS (or this computer's own address) are connected; nothing here
//! starts a program.

mod api;
mod catalog;
mod client;
mod host;
mod icons;
mod sign_in;
mod vault;

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use rmcp::transport::auth::AuthorizationMetadata;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex;

pub use api::router;
pub(crate) use host::OutsideTools;
pub(crate) use vault::CREDENTIALS_FILE;

/// The list of connected tools, in the state folder.
pub(crate) const TOOLS_FILE: &str = "tools.json";
/// The most tools one `LoomWatch` keeps.
const MAX_TOOLS: usize = 50;
/// The most calls of one tool an agent is offered: a server offering more than this still works,
/// it just lends the first ones.
pub(crate) const MAX_CALLS: usize = 40;
/// The longest name a tool may have.
const MAX_NAME_CHARS: usize = 40;

/// How a tool proves who is calling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Auth {
    /// Nothing: anyone may call it.
    None,
    /// A token the operator pasted.
    Token,
    /// A sign-in through the tool's own site.
    SignIn,
}

/// One connected tool, as `tools.json` keeps it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedTool {
    pub id: String,
    /// What the operator and the agents call it: "Linear". Unique, ignoring case.
    pub name: String,
    pub url: String,
    pub auth: Auth,
    /// What it offered when last checked.
    #[serde(default)]
    pub calls: Vec<ToolCall>,
    /// RFC 3339: when its calls were last listed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<String>,
    /// For a sign-in: where its site signs in and renews tokens, as discovered when it was
    /// connected. Addresses only, no secret; kept so a run doesn't look them up again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) metadata: Option<AuthorizationMetadata>,
    /// Set while connecting and cleared once it works: a tool waiting for its sign-in or token.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub pending: bool,
    /// What went wrong the last time it was used, in words, until it works again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
}

/// One call a tool offers, as its server described it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    /// The server's own name for it: `create_issue`.
    pub name: String,
    /// Its title for people, when the server gives one: "Create issue".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default)]
    pub description: String,
    /// The JSON Schema of its arguments.
    pub input_schema: Value,
    /// The server says it only reads. A hint, shown to the operator; it never skips asking.
    #[serde(default)]
    pub read_only: bool,
}

impl ToolCall {
    /// What a person reads: its title, or its name with the underscores taken out and a capital
    /// first letter ("Ask wiki question").
    #[must_use]
    pub fn label(&self) -> String {
        self.title
            .as_deref()
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .map_or_else(
                || {
                    let words = self.name.replace(['_', '-'], " ");
                    let mut chars = words.chars();
                    chars.next().map_or_else(String::new, |first| {
                        first.to_uppercase().chain(chars).collect()
                    })
                },
                str::to_owned,
            )
    }
}

/// `tools.json`.
#[derive(Debug, Default, Serialize, Deserialize)]
struct ToolsFile {
    #[serde(default)]
    tools: Vec<ConnectedTool>,
}

/// The connected tools: their list, their secrets, and sign-ins under way. Cheap to clone.
#[derive(Clone)]
pub struct Tools {
    inner: Arc<Inner>,
}

struct Inner {
    file: PathBuf,
    /// Where the tools' icons are kept (`icons.rs`).
    icons: PathBuf,
    vault: vault::Vault,
    http: reqwest::Client,
    /// Every read-modify-write of `tools.json` holds this.
    writes: Mutex<()>,
    sign_ins: sign_in::Pending,
    /// One refresh at a time per tool, across every run and the API.
    refreshing: std::sync::Mutex<std::collections::HashMap<String, Arc<Mutex<()>>>>,
}

/// The one [`Tools`] runs use, set once at startup.
static INSTALLED: OnceLock<Tools> = OnceLock::new();

/// Makes `tools` the ones runs use. The daemon calls this once, at startup; a second call is
/// ignored.
pub fn install(tools: Tools) {
    let _ = INSTALLED.set(tools);
}

/// The installed [`Tools`], if the daemon set them. Tests and one-off commands may have none, and
/// then no agent has a connected tool.
pub(crate) fn installed() -> Option<&'static Tools> {
    INSTALLED.get()
}

impl Tools {
    /// The tools kept in `state_dir`, with their secrets in the Keychain, or in a private file
    /// there with `LOOMWATCH_KEY_STORE=file`. Opening reads nothing.
    ///
    /// # Errors
    /// Returns an error if the HTTPS client cannot be initialized.
    pub fn open(state_dir: &Path) -> anyhow::Result<Self> {
        Ok(Self::with(
            state_dir,
            vault::Vault::chosen(state_dir, crate::ai::keys_in_file()),
        )?)
    }

    fn with(state_dir: &Path, vault: vault::Vault) -> reqwest::Result<Self> {
        Ok(Self {
            inner: Arc::new(Inner {
                file: state_dir.join(TOOLS_FILE),
                icons: state_dir.join(icons::ICONS_DIR),
                vault,
                http: client::http()?,
                writes: Mutex::new(()),
                sign_ins: sign_in::Pending::default(),
                refreshing: std::sync::Mutex::default(),
            }),
        })
    }

    #[cfg(test)]
    pub(crate) fn for_tests(state_dir: &Path) -> Self {
        Self::with(state_dir, vault::Vault::memory()).expect("an HTTP client")
    }

    /// Every connected tool, in the order they were connected.
    pub async fn list(&self) -> Vec<ConnectedTool> {
        self.read().await.tools
    }

    /// The tool called `name`, ignoring case, that has finished connecting.
    pub async fn named(&self, name: &str) -> Option<ConnectedTool> {
        let name = name.trim();
        self.list()
            .await
            .into_iter()
            .find(|tool| !tool.pending && tool.name.eq_ignore_ascii_case(name))
    }

    /// [`Self::named`], read now without waiting, for a run being set up.
    pub(crate) fn named_now(&self, name: &str) -> Option<ConnectedTool> {
        let name = name.trim();
        let file: ToolsFile = std::fs::read(&self.inner.file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        file.tools
            .into_iter()
            .find(|tool| !tool.pending && tool.name.eq_ignore_ascii_case(name))
    }

    async fn get(&self, id: &str) -> Option<ConnectedTool> {
        self.list().await.into_iter().find(|tool| tool.id == id)
    }

    async fn read(&self) -> ToolsFile {
        match tokio::fs::read(&self.inner.file).await {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|error| {
                eprintln!(
                    "warning: {} can't be read as connected tools ({error}); treating it as empty",
                    self.inner.file.display()
                );
                ToolsFile::default()
            }),
            Err(_) => ToolsFile::default(),
        }
    }

    /// Change the list under [`Inner::writes`] and keep it. `change` answers what the caller
    /// needs, or an error that leaves the file as it was.
    async fn change<T>(
        &self,
        change: impl FnOnce(&mut Vec<ConnectedTool>) -> Result<T, String>,
    ) -> Result<T, String> {
        let _writing = self.inner.writes.lock().await;
        let mut file = self.read().await;
        let answer = change(&mut file.tools)?;
        let text = serde_json::to_vec_pretty(&file).map_err(|error| error.to_string())?;
        let path = self.inner.file.clone();
        tokio::task::spawn_blocking(move || crate::approvals::write_private(&path, &text))
            .await
            .map_err(|_| file_error())?
            .map_err(|_| file_error())?;
        Ok(answer)
    }

    /// Note how using tool `id` went: what it offers now, or what went wrong.
    async fn note(&self, id: &str, outcome: Result<Option<Vec<ToolCall>>, &str>) {
        let id = id.to_owned();
        let noted = self
            .change(move |tools| {
                if let Some(tool) = tools.iter_mut().find(|tool| tool.id == id) {
                    match outcome {
                        Ok(calls) => {
                            if let Some(calls) = calls {
                                tool.calls = calls;
                                tool.checked_at = Some(now());
                            }
                            tool.problem = None;
                        }
                        Err(problem) => tool.problem = Some(problem.to_owned()),
                    }
                }
                Ok(())
            })
            .await;
        if let Err(error) = noted {
            eprintln!("warning: could not note how a connected tool went: {error}");
        }
    }

    fn refreshing(&self, id: &str) -> Arc<Mutex<()>> {
        let mut all = self
            .inner
            .refreshing
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        all.entry(id.to_owned()).or_default().clone()
    }

    fn sign_in_store(&self, id: &str) -> vault::SignInStore {
        vault::SignInStore {
            vault: self.inner.vault.clone(),
            id: id.to_owned(),
            refreshing: self.refreshing(id),
        }
    }
}

/// A name nobody has yet: `wanted` trimmed and cut to [`MAX_NAME_CHARS`], with " 2", " 3" … added
/// while another tool has it.
fn unique_name(wanted: &str, taken: &[ConnectedTool]) -> String {
    let base: String = wanted
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_NAME_CHARS)
        .collect();
    let base = if base.is_empty() {
        "Tool".to_owned()
    } else {
        base
    };
    let free = |name: &str| {
        !taken
            .iter()
            .any(|tool| tool.name.eq_ignore_ascii_case(name))
    };
    if free(&base) {
        return base;
    }
    // One more number than there are tools: one of them is free.
    (2..=taken.len() + 2)
        .map(|n| format!("{base} {n}"))
        .find(|name| free(name))
        .expect("one of them is free")
}

/// What a model may call tool `name`'s calls by: lowercase letters, digits and `_`, at most 20
/// characters, so `<slug>__<call>` stays inside the 64 characters a function name may have.
#[must_use]
pub(crate) fn slug(name: &str) -> String {
    let mut slug = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
        } else if !slug.is_empty() && !slug.ends_with('_') {
            slug.push('_');
        }
    }
    let slug: String = slug.trim_end_matches('_').chars().take(20).collect();
    let slug = slug.trim_end_matches('_').to_owned();
    if slug.is_empty() {
        "tool".to_owned()
    } else {
        slug
    }
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn file_error() -> String {
    format!("LoomWatch can't write {TOOLS_FILE} in its state folder. Check that folder and retry.")
}

#[cfg(test)]
mod tests;
