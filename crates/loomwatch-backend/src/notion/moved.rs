//! Moving the Notion sign-in Connections made before Notion was a tool (ADR 0049) to the Notion
//! tool (ADR 0070), once, at startup, so the operator signs in to Notion once and keeps the page
//! answers go under.
//!
//! The old connection lived in its own Keychain item (`LoomWatch.Notion`, Credential Manager on
//! Windows, `notion-credentials.json` for a trial copy), with what Connections showed of it, and
//! no credential, in `notion-connection.json`. That status file says whether anything is there,
//! so a `LoomWatch` that never connected Notion reads no Keychain item at all. Afterwards the
//! status file is gone, so the move is never tried twice:
//!
//! - A sign-in becomes the Notion tool's, unless a Notion tool is already connected with its own;
//!   then the old one is revoked. Its item is removed.
//! - An integration token is not moved: the hosted server Notion tools reach doesn't take one. Its
//!   item is left as it is, since removing an item another build made can bring up a Keychain
//!   dialog nobody asked for, and the operator signs in to Notion under Tools.
//! - The page answers go under moves either way, unless one was chosen since.
use std::path::{Path, PathBuf};
use std::time::Duration;

use rmcp::transport::auth::{AuthorizationMetadata, StoredCredentials};
use serde::Deserialize;
use serde_json::json;

use super::{Destination, MCP_URL, Page};
use crate::connected_tools::{Adopted, Tools};

#[cfg(any(target_os = "macos", windows))]
const SERVICE: &str = "LoomWatch.Notion";
#[cfg(any(target_os = "macos", windows))]
const ACCOUNT: &str = "local-workspace";
/// Where a trial copy kept the old connection, in its state folder.
const CREDENTIALS_FILE: &str = "notion-credentials.json";
/// What Connections showed of the old connection, with no credential.
const SHOWN_FILE: &str = "notion-connection.json";

/// Notion's sign-in addresses, as its authorization server metadata publishes them
/// (`https://mcp.notion.com/.well-known/oauth-authorization-server`). Tests point them at a
/// stand-in.
pub(super) struct Endpoints {
    pub(super) mcp: String,
    pub(super) authorize: String,
    pub(super) token: String,
    pub(super) register: String,
}

impl Endpoints {
    fn notion() -> Self {
        Self {
            mcp: MCP_URL.into(),
            authorize: "https://mcp.notion.com/authorize".into(),
            token: "https://mcp.notion.com/token".into(),
            register: "https://mcp.notion.com/register".into(),
        }
    }

    /// What the moved sign-in renews through, so a renewal needs no discovery first. No issuer:
    /// the old grant never recorded one, so none is checked against it.
    fn metadata(&self) -> AuthorizationMetadata {
        let mut metadata = AuthorizationMetadata::default();
        metadata.authorization_endpoint.clone_from(&self.authorize);
        metadata.token_endpoint.clone_from(&self.token);
        metadata.registration_endpoint = Some(self.register.clone());
        metadata.code_challenge_methods_supported = Some(vec!["S256".to_owned()]);
        metadata
    }
}

/// Where the old connection was kept.
pub(super) enum Old {
    Keychain,
    File(PathBuf),
    #[cfg(test)]
    Memory(std::sync::Arc<std::sync::Mutex<Option<String>>>),
    /// A Keychain that refuses to be read, as one does when the person chooses Deny.
    #[cfg(test)]
    Refusing,
}

/// The old connection as it was stored. Only what moving needs is read.
#[derive(Deserialize)]
struct Connection {
    #[serde(flatten)]
    access: Access,
    #[serde(default)]
    destination: Option<Page>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Access {
    SignIn {
        #[serde(rename = "signIn")]
        sign_in: Grant,
    },
    Token {
        #[allow(dead_code)] // recognized, never moved
        token: serde::de::IgnoredAny,
    },
}

/// The old sign-in's grant. Deliberately no Debug implementation: it holds credentials.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Grant {
    client_id: String,
    access_token: String,
    refresh_token: String,
    /// Unix seconds at which Notion stops accepting `access_token`.
    expires_at: i64,
}

impl Grant {
    /// The grant as rmcp keeps a sign-in, received `now`: it renews it when it is about to lapse,
    /// as the old connection did. Notion registered `LoomWatch` as a public client, so there is no
    /// secret to carry over.
    fn credentials(&self, now: i64) -> Option<StoredCredentials> {
        serde_json::from_value(json!({
            "client_id": self.client_id,
            "token_response": {
                "access_token": self.access_token,
                "token_type": "bearer",
                "expires_in": (self.expires_at - now).max(0),
                "refresh_token": self.refresh_token,
            },
            "granted_scopes": [],
            "token_received_at": now,
        }))
        .ok()
    }
}

/// What Connections showed of the old connection.
#[derive(Deserialize)]
struct Shown {
    connected: bool,
    #[serde(default)]
    destination: Option<Page>,
}

/// What the move did.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Moved {
    /// Nothing was connected in Connections.
    Nothing,
    /// The sign-in is the Notion tool's now.
    SignIn,
    /// A Notion tool was already connected, so it kept its own sign-in.
    AlreadyConnected,
    /// An integration token, which is not moved.
    Token,
    /// The old connection couldn't be read: the person chose Deny, or the item is gone.
    Unreadable,
    /// Where tools keep secrets can't keep it now. Everything stays, to try again next start.
    NotNow,
}

/// Moves the Notion sign-in Connections made to the Notion tool, if there is one to move. The
/// daemon runs this once, at startup, after installing `tools`; it waits on the network only to
/// list what the Notion tool offers.
pub async fn move_to_tools(state_dir: PathBuf, tools: Tools) {
    let old = if crate::ai::keys_in_file() {
        Old::File(state_dir.join(CREDENTIALS_FILE))
    } else {
        Old::Keychain
    };
    let moved = move_with(&state_dir, &tools, &old, &Endpoints::notion()).await;
    match moved {
        Moved::Nothing => {}
        Moved::SignIn => {
            println!("notion: the Notion sign-in from Connections is now the Notion tool's");
        }
        Moved::AlreadyConnected => println!(
            "notion: the Notion tool keeps its own sign-in; the one from Connections was revoked"
        ),
        Moved::Token => eprintln!(
            "notion: Notion was connected with an integration token, which LoomWatch no longer uses; sign in to Notion under Tools in Connections"
        ),
        Moved::Unreadable => eprintln!(
            "notion: the Notion sign-in from Connections couldn't be read; sign in to Notion under Tools in Connections"
        ),
        Moved::NotNow => eprintln!(
            "notion: the Notion sign-in from Connections couldn't be moved yet; it is tried again at the next start"
        ),
    }
}

pub(super) async fn move_with(
    state_dir: &Path,
    tools: &Tools,
    old: &Old,
    endpoints: &Endpoints,
) -> Moved {
    let shown_path = state_dir.join(SHOWN_FILE);
    let shown: Option<Shown> = tokio::fs::read(&shown_path)
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok());
    let old_file = if let Old::File(path) = old {
        tokio::fs::try_exists(path).await.unwrap_or(false)
    } else {
        false
    };
    // Nothing says anything is there: never read the Keychain for nothing. A trial copy's file
    // is looked at even without a status.
    if !(old_file || shown.as_ref().is_some_and(|shown| shown.connected)) {
        let _ = tokio::fs::remove_file(&shown_path).await;
        return Moved::Nothing;
    }
    let shown_destination = shown.and_then(|shown| shown.destination);
    let stored = old
        .read()
        .await
        .map(|stored| stored.and_then(|text| serde_json::from_str::<Connection>(&text).ok()));
    let (moved, destination) = match stored {
        Ok(Some(Connection {
            access: Access::SignIn { sign_in: grant },
            destination,
        })) => match adopt(tools, endpoints, &grant).await {
            Some(moved) => (moved, destination),
            None => return Moved::NotNow,
        },
        Ok(Some(Connection { destination, .. })) => (Moved::Token, destination),
        Ok(None) | Err(()) => (Moved::Unreadable, None),
    };
    if let Some(page) = destination.or(shown_destination) {
        let kept = Destination::in_folder(state_dir);
        // A page chosen since, through the Notion tool, stays.
        if kept.read().await.is_none() && kept.write(&page).await.is_err() {
            eprintln!("warning: could not keep the page Notion answers go under");
        }
    }
    if matches!(moved, Moved::SignIn | Moved::AlreadyConnected) || matches!(old, Old::File(_)) {
        old.forget().await;
    }
    let _ = tokio::fs::remove_file(&shown_path).await;
    moved
}

/// Keep `grant` as the Notion tool's sign-in, or revoke it when a Notion tool has its own. `None`
/// when where tools keep secrets can't keep it now.
async fn adopt(tools: &Tools, endpoints: &Endpoints, grant: &Grant) -> Option<Moved> {
    let Some(credentials) = grant.credentials(chrono::Utc::now().timestamp()) else {
        return Some(Moved::Unreadable);
    };
    match tools
        .adopt_sign_in("Notion", &endpoints.mcp, endpoints.metadata(), credentials)
        .await
    {
        Ok(Adopted::Kept) => Some(Moved::SignIn),
        Ok(Adopted::AlreadyConnected) => {
            revoke(endpoints, grant).await;
            Some(Moved::AlreadyConnected)
        }
        Err(said) => {
            eprintln!("warning: could not move the Notion sign-in to the Notion tool: {said}");
            None
        }
    }
}

/// Ask Notion to forget a grant no longer kept. Best effort: it is unused either way.
async fn revoke(endpoints: &Endpoints, grant: &Grant) {
    let Ok(client) = super::build_client() else {
        return;
    };
    let form = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs([
            ("token", grant.refresh_token.as_str()),
            ("token_type_hint", "refresh_token"),
            ("client_id", grant.client_id.as_str()),
        ])
        .finish();
    let _ = client
        .post(&endpoints.token)
        .header(
            reqwest::header::CONTENT_TYPE,
            "application/x-www-form-urlencoded",
        )
        .timeout(Duration::from_secs(5))
        .body(form)
        .send()
        .await;
}

impl Old {
    /// What is kept, or `Err` when it can't be read.
    async fn read(&self) -> Result<Option<String>, ()> {
        match self {
            Self::Keychain => keychain_read().await,
            Self::File(path) => {
                let path = path.clone();
                tokio::task::spawn_blocking(move || match std::fs::read_to_string(&path) {
                    Ok(text) => Ok(Some(text)),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
                    Err(_) => Err(()),
                })
                .await
                .map_err(|_| ())?
            }
            #[cfg(test)]
            Self::Memory(slot) => Ok(slot.lock().map_err(|_| ())?.clone()),
            #[cfg(test)]
            Self::Refusing => Err(()),
        }
    }

    /// Remove what is kept. Best effort: what is left is never read again.
    async fn forget(&self) {
        match self {
            Self::Keychain => keychain_forget().await,
            Self::File(path) => {
                let _ = tokio::fs::remove_file(path).await;
            }
            #[cfg(test)]
            Self::Memory(slot) => {
                if let Ok(mut slot) = slot.lock() {
                    *slot = None;
                }
            }
            #[cfg(test)]
            Self::Refusing => {}
        }
    }
}

/// Test builds never reach the item the installed app keeps.
#[cfg(test)]
fn never_the_keychain() {
    panic!("a test reached the real Keychain: give the move an Old::Memory or Old::File");
}

async fn keychain_read() -> Result<Option<String>, ()> {
    #[cfg(test)]
    never_the_keychain();
    tokio::task::spawn_blocking(|| {
        #[cfg(target_os = "macos")]
        {
            match keyring::Entry::new(SERVICE, ACCOUNT)
                .map_err(|_| ())?
                .get_password()
            {
                Ok(value) => Ok(Some(value)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(_) => Err(()),
            }
        }
        #[cfg(windows)]
        {
            credential_manager::read()
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            Ok(None)
        }
    })
    .await
    .map_err(|_| ())?
}

async fn keychain_forget() {
    #[cfg(test)]
    never_the_keychain();
    let _ = tokio::task::spawn_blocking(|| {
        #[cfg(target_os = "macos")]
        {
            if let Ok(entry) = keyring::Entry::new(SERVICE, ACCOUNT) {
                let _ = entry.delete_credential();
            }
        }
        #[cfg(windows)]
        {
            credential_manager::forget();
        }
    })
    .await;
}

/// The old connection in Windows Credential Manager, which kept a long one in several saved
/// credentials, `local-workspace`, `local-workspace#2`, … (`connected_tools::split_secret`).
#[cfg(windows)]
mod credential_manager {
    use super::{ACCOUNT, SERVICE};
    use crate::connected_tools::{MAX_SECRET_PARTS, join_secret};

    fn entry(part: usize) -> Option<keyring::Entry> {
        let account = if part == 0 {
            ACCOUNT.to_owned()
        } else {
            format!("{ACCOUNT}#{}", part + 1)
        };
        keyring::Entry::new(SERVICE, &account).ok()
    }

    fn get(part: usize) -> Result<Option<String>, ()> {
        match entry(part).ok_or(())?.get_secret() {
            Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| ()),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(()),
        }
    }

    pub(super) fn read() -> Result<Option<String>, ()> {
        let Some(first) = get(0)? else {
            return Ok(None);
        };
        join_secret(&first, |part| get(part).ok().flatten())
            .map(Some)
            .ok_or(())
    }

    pub(super) fn forget() {
        for part in 0..MAX_SECRET_PARTS {
            if let Some(entry) = entry(part) {
                let _ = entry.delete_credential();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use axum::http::StatusCode;
    use serde_json::{Value, json};

    use super::super::tests::{DESTINATION, Folder, Stand, fake_notion, notion_with, shown_by};
    use super::*;
    use crate::connected_tools::{Auth, Unusable};

    fn now() -> i64 {
        chrono::Utc::now().timestamp()
    }

    /// The connection Connections kept for a sign-in, as it kept it.
    fn signed_in(expires_at: i64, refresh: &str) -> String {
        json!({
            "signIn": {"clientId": "client-1", "accessToken": "access-1", "refreshToken": refresh, "expiresAt": expires_at, "workspaceId": "ws-1"},
            "name": "Acme",
            "destination": {"id": DESTINATION, "title": "Daily"},
        })
        .to_string()
    }

    fn kept(text: String) -> Arc<Mutex<Option<String>>> {
        Arc::new(Mutex::new(Some(text)))
    }

    /// What Connections showed of it, with no credential.
    fn shown(folder: &Folder, via: &str) {
        std::fs::write(
            folder.0.join(SHOWN_FILE),
            json!({"connected": true, "name": "Acme", "via": via, "destination": {"id": DESTINATION, "title": "Daily"}}).to_string(),
        )
        .unwrap();
    }

    async fn stand(refresh: &str) -> Stand {
        let stand = fake_notion("access-1").await;
        refresh.clone_into(&mut stand.fake.lock().unwrap().refresh);
        stand
    }

    /// The sign-in moves to the Notion tool, which lists what it offers through it, and nothing
    /// is left where it was; the page answers go under comes along; a second start moves nothing.
    #[tokio::test]
    async fn a_sign_in_made_in_connections_becomes_the_notion_tools() {
        let stand = stand("refresh-1").await;
        let folder = Folder::new();
        let tools = Tools::for_tests(&folder.0);
        let slot = kept(signed_in(now() + 3600, "refresh-1"));
        let old = Old::Memory(slot.clone());
        shown(&folder, "signIn");

        assert_eq!(
            move_with(&folder.0, &tools, &old, &stand.endpoints()).await,
            Moved::SignIn
        );
        let tool = tools.at(&stand.mcp()).await.expect("the Notion tool");
        assert_eq!((tool.name.as_str(), tool.auth), ("Notion", Auth::SignIn));
        assert_eq!(tool.calls.len(), 2, "{:?}", tool.problem);
        let secrets = tools.secrets_for_tests();
        assert!(secrets.contains("client-1") && secrets.contains("refresh-1"));
        assert!(slot.lock().unwrap().is_none(), "the old item is removed");
        assert!(!folder.0.join(SHOWN_FILE).exists());
        assert!(folder.destination().contains(DESTINATION));
        assert!(!folder.destination().contains("access-1"));

        let (router, publisher, reader) = notion_with(&tools, &stand.mcp(), &folder);
        assert_eq!(
            shown_by(&router).await,
            json!({"connected": true, "name": "Notion", "destination": {"id": DESTINATION, "title": "Daily"}, "problem": null})
        );
        // Used as it is until it lapses.
        assert_eq!(tools.bearer(&tool).await, Ok("access-1".to_owned()));
        assert!(reader.read(&[DESTINATION.to_owned()]).await.is_ok());
        assert!(publisher.publish("Report", "Hello").await.is_ok());
        assert_eq!(stand.fake.lock().unwrap().refreshed, 0);

        assert_eq!(
            move_with(&folder.0, &tools, &old, &stand.endpoints()).await,
            Moved::Nothing
        );
    }

    /// A sign-in that lapsed while it waited is renewed through Notion's token endpoint once,
    /// and the rotated refresh token is the one kept.
    #[tokio::test]
    async fn a_lapsed_sign_in_is_renewed_once_and_kept_renewed() {
        let stand = stand("refresh-1").await;
        let folder = Folder::new();
        let tools = Tools::for_tests(&folder.0);
        let old = Old::Memory(kept(signed_in(0, "refresh-1")));
        shown(&folder, "signIn");

        assert_eq!(
            move_with(&folder.0, &tools, &old, &stand.endpoints()).await,
            Moved::SignIn
        );
        let tool = tools.at(&stand.mcp()).await.expect("the Notion tool");
        assert_eq!(tool.calls.len(), 2, "{:?}", tool.problem);
        assert_eq!(tools.bearer(&tool).await, Ok("access-2".to_owned()));
        assert_eq!(stand.fake.lock().unwrap().refreshed, 1);
        let secrets = tools.secrets_for_tests();
        assert!(secrets.contains("refresh-2") && !secrets.contains("refresh-1"));
        let (_, publisher, _) = notion_with(&tools, &stand.mcp(), &folder);
        assert!(publisher.publish("Report", "Hello").await.is_ok());
    }

    /// Notion refusing to renew a moved sign-in means signing in again, in the words every
    /// surface uses, and the Notion tool says so too.
    #[tokio::test]
    async fn a_sign_in_notion_wont_renew_says_to_sign_in_again() {
        let stand = stand("refresh-1").await;
        let folder = Folder::new();
        let tools = Tools::for_tests(&folder.0);
        let old = Old::Memory(kept(signed_in(0, "retired")));
        shown(&folder, "signIn");

        assert_eq!(
            move_with(&folder.0, &tools, &old, &stand.endpoints()).await,
            Moved::SignIn
        );
        let tool = tools.at(&stand.mcp()).await.expect("kept all the same");
        assert!(tool.problem.is_some());
        assert_eq!(tools.bearer(&tool).await, Err(Unusable::SignInAgain));
        let (router, _, _) = notion_with(&tools, &stand.mcp(), &folder);
        let request = axum::http::Request::builder()
            .method("POST")
            .uri("/api/notion/pages")
            .header(axum::http::header::HOST, "127.0.0.1:3000")
            .header("x-loomwatch-request", "1")
            .header(axum::http::header::CONTENT_TYPE, "application/json")
            .body(axum::body::Body::from(json!({"query": ""}).to_string()))
            .unwrap();
        let response = tower::ServiceExt::oneshot(router, request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let body = http_body_util::BodyExt::collect(response.into_body())
            .await
            .unwrap()
            .to_bytes();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"], super::super::SIGN_IN_AGAIN);
    }

    /// A Notion tool connected before the move keeps its own sign-in; the old one is revoked and
    /// removed, and the page answers go under still comes along.
    #[tokio::test]
    async fn a_notion_tool_already_connected_keeps_its_own_sign_in() {
        let stand = stand("refresh-1").await;
        let folder = Folder::new();
        let tools = Tools::for_tests(&folder.0);
        tools
            .connected_for_tests("Notion", &stand.mcp(), "access-1")
            .await;
        let slot = kept(signed_in(now() + 3600, "refresh-old"));
        shown(&folder, "signIn");

        assert_eq!(
            move_with(
                &folder.0,
                &tools,
                &Old::Memory(slot.clone()),
                &stand.endpoints()
            )
            .await,
            Moved::AlreadyConnected
        );
        assert_eq!(tools.list().await.len(), 1);
        assert_eq!(stand.fake.lock().unwrap().revoked, ["refresh-old"]);
        assert!(slot.lock().unwrap().is_none());
        assert!(folder.destination().contains(DESTINATION));
    }

    /// An integration token is not moved, and its Keychain item is left alone, but the page
    /// answers go under is kept for when Notion is signed in to under Tools.
    #[tokio::test]
    async fn an_integration_token_is_not_moved_but_its_page_is() {
        let stand = stand("refresh-1").await;
        let folder = Folder::new();
        let tools = Tools::for_tests(&folder.0);
        let token = json!({"token": "secret_abc", "name": "Acme", "destination": {"id": DESTINATION, "title": "Daily"}}).to_string();
        let slot = kept(token.clone());
        shown(&folder, "token");

        assert_eq!(
            move_with(
                &folder.0,
                &tools,
                &Old::Memory(slot.clone()),
                &stand.endpoints()
            )
            .await,
            Moved::Token
        );
        assert!(tools.list().await.is_empty());
        assert_eq!(slot.lock().unwrap().as_deref(), Some(token.as_str()));
        assert!(folder.destination().contains(DESTINATION));
        assert!(!folder.0.join(SHOWN_FILE).exists());
    }

    /// With no status saying Notion was connected, nothing is read: a Keychain that would refuse
    /// is never asked.
    #[tokio::test]
    async fn nothing_is_read_when_nothing_was_connected() {
        let stand = stand("refresh-1").await;
        let folder = Folder::new();
        let tools = Tools::for_tests(&folder.0);
        assert_eq!(
            move_with(&folder.0, &tools, &Old::Refusing, &stand.endpoints()).await,
            Moved::Nothing
        );
        std::fs::write(folder.0.join(SHOWN_FILE), r#"{"connected":false}"#).unwrap();
        assert_eq!(
            move_with(&folder.0, &tools, &Old::Refusing, &stand.endpoints()).await,
            Moved::Nothing
        );
        assert!(!folder.0.join(SHOWN_FILE).exists());
    }

    /// A Keychain read the person refuses moves the page answers go under, and the next start
    /// never asks again: they sign in under Tools instead.
    #[tokio::test]
    async fn a_refused_read_keeps_the_page_and_never_asks_again() {
        let stand = stand("refresh-1").await;
        let folder = Folder::new();
        let tools = Tools::for_tests(&folder.0);
        shown(&folder, "signIn");
        assert_eq!(
            move_with(&folder.0, &tools, &Old::Refusing, &stand.endpoints()).await,
            Moved::Unreadable
        );
        assert!(folder.destination().contains(DESTINATION));
        assert_eq!(
            move_with(&folder.0, &tools, &Old::Refusing, &stand.endpoints()).await,
            Moved::Nothing
        );
    }

    /// `LOOMWATCH_KEY_STORE=file`: a trial copy's own file moves, status or not, and is removed.
    #[tokio::test]
    async fn a_trial_copy_moves_its_own_file() {
        let stand = stand("refresh-1").await;
        let folder = Folder::new();
        let tools = Tools::for_tests(&folder.0);
        let file = folder.0.join(CREDENTIALS_FILE);
        std::fs::write(&file, signed_in(now() + 3600, "refresh-1")).unwrap();
        assert_eq!(
            move_with(
                &folder.0,
                &tools,
                &Old::File(file.clone()),
                &stand.endpoints()
            )
            .await,
            Moved::SignIn
        );
        assert!(!file.exists());
        assert!(tools.at(&stand.mcp()).await.is_some());
    }
}
