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
//!
//! Notion is one of them, and its sign-in is also the one `LoomWatch` itself uses to send answers
//! to Notion and to read the pages agents are given (ADR 0070): `crate::notion` asks for it here
//! ([`Tools::at`], [`Tools::bearer`]).

mod api;
mod catalog;
mod client;
mod host;
mod icons;
mod sign_in;
pub(crate) mod vault;

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use rmcp::transport::auth::{
    AuthError, AuthorizationManager, AuthorizationMetadata, StoredCredentials,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex;

pub use api::router;
pub(crate) use host::OutsideTools;
pub(crate) use vault::CREDENTIALS_FILE;
#[cfg(windows)]
pub(crate) use vault::{MAX_SECRET_PARTS, join_secret};

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

/// Why [`Tools::bearer`] has nothing to send.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Unusable {
    /// The sign-in has ended, or there never was one: the operator signs in again.
    SignInAgain,
    /// The tool's site couldn't be reached to renew it.
    Unreachable,
    /// Where secrets are kept can't be read: a locked Keychain, or a refused one.
    Unavailable,
}

impl Unusable {
    /// What an rmcp sign-in error leaves to do. Only a sign-in that is gone, or that the tool's
    /// site turned down, means signing in again; a renewal that couldn't reach the site is tried
    /// again later. [`client::open`] reads its errors the same way.
    fn of(error: &AuthError) -> Self {
        match error {
            AuthError::AuthorizationRequired
            | AuthError::TokenRefreshRejected(_)
            | AuthError::InsufficientScope { .. } => Self::SignInAgain,
            AuthError::CredentialStoreError(_) => Self::Unavailable,
            _ => Self::Unreachable,
        }
    }
}

/// What [`Tools::adopt_sign_in`] kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Adopted {
    /// The sign-in, as the tool there. Its `problem` says why what it offers couldn't be listed.
    Kept,
    /// Nothing: a tool was already connected there, with its own sign-in.
    AlreadyConnected,
}

/// Whether two tool addresses are the same, ignoring a final `/`.
pub(crate) fn same_address(one: &str, other: &str) -> bool {
    one.trim_end_matches('/') == other.trim_end_matches('/')
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

    /// A tool at `url` taking `token`, kept as connected without asking its server, for tests of
    /// code that uses connected tools.
    #[cfg(test)]
    pub(crate) async fn connected_for_tests(
        &self,
        name: &str,
        url: &str,
        token: &str,
    ) -> ConnectedTool {
        let tool = ConnectedTool {
            id: uuid::Uuid::new_v4().simple().to_string(),
            name: name.to_owned(),
            url: url.to_owned(),
            auth: Auth::Token,
            calls: Vec::new(),
            checked_at: None,
            metadata: None,
            pending: false,
            problem: None,
        };
        self.inner
            .vault
            .set(
                &tool.id,
                Some(vault::Secret::Token {
                    token: token.to_owned(),
                }),
            )
            .await
            .expect("kept in memory");
        let kept = tool.clone();
        self.change(move |tools| {
            tools.push(kept);
            Ok(())
        })
        .await
        .expect("listed");
        tool
    }

    /// Everything the vault keeps, as it keeps it, for tests that show where a secret went.
    #[cfg(test)]
    pub(crate) fn secrets_for_tests(&self) -> String {
        self.inner.vault.raw().unwrap_or_default()
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

    /// The tool connected at `url`, ignoring a final `/`, once it has finished connecting. One
    /// address is connected once at most.
    pub(crate) async fn at(&self, url: &str) -> Option<ConnectedTool> {
        self.list()
            .await
            .into_iter()
            .find(|tool| !tool.pending && same_address(&tool.url, url))
    }

    /// What `tool`'s server is sent to prove who is calling, for code that speaks to it itself
    /// rather than through an agent's session ([`client::open`]): a sign-in's access token,
    /// renewed first when it is about to lapse, or the token pasted for it.
    ///
    /// # Errors
    /// Why there is none to send, which says what the operator can do.
    pub(crate) async fn bearer(&self, tool: &ConnectedTool) -> Result<String, Unusable> {
        match tool.auth {
            Auth::None => Err(Unusable::SignInAgain),
            Auth::Token => match self.inner.vault.get(&tool.id).await {
                Ok(Some(vault::Secret::Token { token })) => Ok(token),
                Ok(_) => Err(Unusable::SignInAgain),
                Err(_) => Err(Unusable::Unavailable),
            },
            Auth::SignIn => {
                let mut manager = AuthorizationManager::new(tool.url.as_str())
                    .await
                    .map_err(|_| Unusable::Unreachable)?;
                manager.set_credential_store(self.sign_in_store(&tool.id));
                if let Some(metadata) = &tool.metadata {
                    manager.set_metadata(metadata.clone());
                }
                let unusable = |error: AuthError| Unusable::of(&error);
                if !manager.initialize_from_store().await.map_err(unusable)? {
                    return Err(Unusable::SignInAgain);
                }
                manager.get_access_token().await.map_err(unusable)
            }
        }
    }

    /// Keep a sign-in made before this tool existed as the tool `name` at `url` (ADR 0070: the
    /// Notion sign-in Connections made is moved here). A tool already connected there keeps its
    /// own sign-in, and `credentials` are dropped. Then what the tool offers is listed, when it
    /// can be: a tool that can't be reached yet is kept all the same, and listed when checked.
    ///
    /// # Errors
    /// Where secrets are kept can't keep this one, or `tools.json` can't be written.
    pub(crate) async fn adopt_sign_in(
        &self,
        name: &str,
        url: &str,
        metadata: AuthorizationMetadata,
        credentials: StoredCredentials,
    ) -> Result<Adopted, String> {
        let listed = self.list().await;
        if listed
            .iter()
            .any(|tool| !tool.pending && same_address(&tool.url, url))
        {
            return Ok(Adopted::AlreadyConnected);
        }
        // One waiting for its sign-in is finished by this one.
        let waiting = listed
            .iter()
            .find(|tool| same_address(&tool.url, url))
            .cloned();
        let tool = ConnectedTool {
            id: waiting.as_ref().map_or_else(
                || uuid::Uuid::new_v4().simple().to_string(),
                |tool| tool.id.clone(),
            ),
            name: waiting.map_or_else(|| unique_name(name, &listed), |tool| tool.name),
            url: url.to_owned(),
            auth: Auth::SignIn,
            calls: Vec::new(),
            checked_at: None,
            metadata: Some(metadata),
            pending: false,
            problem: None,
        };
        // The secret first, so the list never names a tool with no way in.
        self.inner
            .vault
            .set(
                &tool.id,
                Some(vault::Secret::SignIn {
                    credentials: Box::new(credentials),
                }),
            )
            .await?;
        let kept = tool.clone();
        self.change(move |tools| {
            tools.retain(|other| other.id != kept.id);
            tools.push(kept);
            Ok(())
        })
        .await?;
        // Noted either way: what it offers, or why that couldn't be listed yet.
        let _ = self.recheck(&tool).await;
        Ok(Adopted::Kept)
    }

    /// List what `tool` offers now and note it, or note what went wrong.
    async fn recheck(&self, tool: &ConnectedTool) -> Result<Vec<ToolCall>, String> {
        let listed = match client::open(self, tool).await {
            Ok(session) => {
                let listed = client::calls(&session, &tool.name).await;
                let _ = session.cancel().await;
                listed
            }
            Err(said) => Err(said),
        };
        self.note(
            &tool.id,
            listed
                .as_ref()
                .map(|calls| Some(calls.clone()))
                .map_err(String::as_str),
        )
        .await;
        listed
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
