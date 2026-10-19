//! Where the operator's `OpenRouter` key is kept.
//!
//! On a Mac it is a Keychain item, `LoomWatch.OpenRouter`, the way the Notion connection is kept;
//! on Windows a generic credential of the same name in Credential Manager, which only this Windows
//! account can read. On Linux it is `<state dir>/keys.json`, readable by this account only. Either
//! way it is read once per process: macOS asks the person to allow each read by a program it
//! doesn't trust yet, and every run needs the key.
//!
//! Only keys entered in `LoomWatch` are used. An `OPENROUTER_API_KEY` in the daemon's environment
//! is ignored, and nothing here ever looks for another app's credentials.
//!
//! The sources a person's plan pays for (ADR 0073), a Claude API key and the sign-in with `ChatGPT`,
//! share one more item, `LoomWatch.Plans` (`<state dir>/plans.json` off a Mac and Windows), so a Mac
//! asks once for both. Saving one never touches the other.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::agent::ApiKey;

#[cfg(any(target_os = "macos", windows))]
const SERVICE: &str = "LoomWatch.OpenRouter";
#[cfg(any(target_os = "macos", windows))]
const ACCOUNT: &str = "api-key";
pub(crate) const FILE_NAME: &str = "keys.json";
#[cfg(any(target_os = "macos", windows))]
const PLANS_SERVICE: &str = "LoomWatch.Plans";
#[cfg(any(target_os = "macos", windows))]
const PLANS_ACCOUNT: &str = "plans";
/// The plans' secrets in the state folder, where they are kept off a Mac and Windows.
pub(crate) const PLANS_FILE: &str = "plans.json";

/// What the sources a plan pays for keep secret. Deliberately no Debug implementation.
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanSecrets {
    /// The Anthropic API key, such as one that spends a Claude Max or Team plan's API credit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anthropic: Option<String>,
    /// The sign-in with `ChatGPT`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chatgpt: Option<ChatGptSecret>,
}

impl PlanSecrets {
    fn is_empty(&self) -> bool {
        self.anthropic.is_none() && self.chatgpt.is_none()
    }
}

/// What a sign-in with `ChatGPT` keeps: the client `OpenAI` issued `LoomWatch` for this account, and
/// the refresh token. The access token is never kept: it lasts an hour and is made again from this.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatGptSecret {
    pub client_id: String,
    pub refresh_token: String,
    /// The account, from the validated ID token.
    pub subject: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub scopes: Vec<String>,
}

/// The operator's provider keys.
#[derive(Clone)]
pub struct Keys {
    store: Store,
    cached: Arc<Mutex<Cached>>,
    plans: PlansPlace,
    /// The plans' secrets as last read or written; `None` until then, and again after a read fails.
    plans_known: Arc<Mutex<Option<PlanSecrets>>>,
}

#[derive(Clone)]
enum PlansPlace {
    #[cfg(any(target_os = "macos", windows))]
    System,
    File(PathBuf),
    #[cfg(test)]
    Memory(Arc<std::sync::Mutex<Option<String>>>),
}

impl std::fmt::Debug for Keys {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Keys(…)")
    }
}

#[derive(Default)]
enum Cached {
    #[default]
    Unread,
    Known(Option<ApiKey>),
}

#[derive(Clone)]
enum Store {
    /// The system's own store, under this service name: the macOS Keychain, or Windows
    /// Credential Manager.
    #[cfg(any(target_os = "macos", windows))]
    System(&'static str),
    File(PathBuf),
    #[cfg(test)]
    Memory(Arc<std::sync::Mutex<Option<String>>>),
}

#[derive(Default, Serialize, Deserialize)]
struct KeyFile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    openrouter: Option<String>,
}

impl Keys {
    /// The Keychain on a Mac, Credential Manager on Windows, `<state_dir>/keys.json` elsewhere.
    #[must_use]
    pub fn open(state_dir: &Path) -> Self {
        #[cfg(any(target_os = "macos", windows))]
        let (store, plans) = {
            let _ = state_dir;
            (Store::System(SERVICE), PlansPlace::System)
        };
        #[cfg(not(any(target_os = "macos", windows)))]
        let (store, plans) = (
            Store::File(state_dir.join(FILE_NAME)),
            PlansPlace::File(state_dir.join(PLANS_FILE)),
        );
        Self::with(store, plans)
    }

    /// A file in `state_dir`, even on a Mac or Windows: for a trial copy that must not touch the
    /// key the installed app keeps.
    #[must_use]
    pub fn in_file(state_dir: &Path) -> Self {
        Self::with(
            Store::File(state_dir.join(FILE_NAME)),
            PlansPlace::File(state_dir.join(PLANS_FILE)),
        )
    }

    #[cfg(test)]
    pub(crate) fn in_memory() -> Self {
        Self::with(
            Store::Memory(Arc::default()),
            PlansPlace::Memory(Arc::default()),
        )
    }

    fn with(store: Store, plans: PlansPlace) -> Self {
        Self {
            store,
            cached: Arc::new(Mutex::new(Cached::Unread)),
            plans,
            plans_known: Arc::new(Mutex::new(None)),
        }
    }

    /// The plans' secrets: empty when nothing was connected.
    ///
    /// # Errors
    ///
    /// When the store can't be read, or what it holds is damaged.
    pub async fn plan_secrets(&self) -> Result<PlanSecrets> {
        let mut known = self.plans_known.lock().await;
        if let Some(secrets) = known.as_ref() {
            return Ok(secrets.clone());
        }
        let secrets = self.read_plans().await?;
        *known = Some(secrets.clone());
        Ok(secrets)
    }

    /// Changes the plans' secrets with `change` and keeps the result, read and written under one
    /// lock, so two changes never lose each other. Returns what was kept.
    ///
    /// # Errors
    ///
    /// When the store can't be read or written; nothing is changed then.
    pub async fn change_plan_secrets(
        &self,
        change: impl FnOnce(&mut PlanSecrets) + Send,
    ) -> Result<PlanSecrets> {
        let mut known = self.plans_known.lock().await;
        let mut secrets = match known.as_ref() {
            Some(secrets) => secrets.clone(),
            None => self.read_plans().await?,
        };
        change(&mut secrets);
        let text = if secrets.is_empty() {
            None
        } else {
            Some(serde_json::to_string(&secrets)?)
        };
        match self.write_plans(text).await {
            Ok(()) => {
                *known = Some(secrets.clone());
                Ok(secrets)
            }
            Err(error) => {
                *known = None;
                Err(error)
            }
        }
    }

    async fn read_plans(&self) -> Result<PlanSecrets> {
        let place = self.plans.clone();
        let text = tokio::task::spawn_blocking(move || -> Result<Option<String>> {
            match place {
                #[cfg(target_os = "macos")]
                PlansPlace::System => match credential_for(PLANS_SERVICE, PLANS_ACCOUNT)?
                    .get_password()
                {
                    Ok(value) => Ok(Some(value)),
                    Err(keyring::Error::NoEntry) => Ok(None),
                    Err(_) => bail!(
                        "{SYSTEM_STORE} wouldn't give LoomWatch your plans' sign-ins; {UNLOCK} and \
                         try again"
                    ),
                },
                #[cfg(windows)]
                PlansPlace::System => {
                    crate::connected_tools::vault::credential_manager::read(
                        PLANS_SERVICE,
                        PLANS_ACCOUNT,
                    )
                    .map_err(|()| {
                        anyhow::anyhow!(
                            "{SYSTEM_STORE} wouldn't give LoomWatch your plans' sign-ins; {UNLOCK} \
                             and try again"
                        )
                    })
                }
                PlansPlace::File(path) => match std::fs::read_to_string(&path) {
                    Ok(text) => Ok(Some(text)),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
                    Err(error) => Err(error).context("cannot read plans.json"),
                },
                #[cfg(test)]
                PlansPlace::Memory(slot) => Ok(slot
                    .lock()
                    .map_err(|_| anyhow::anyhow!("poisoned"))?
                    .clone()),
            }
        })
        .await
        .context("the key store stopped")??;
        match text {
            Some(text) if !text.trim().is_empty() => {
                serde_json::from_str(&text).context("the plans' saved sign-ins are damaged")
            }
            _ => Ok(PlanSecrets::default()),
        }
    }

    async fn write_plans(&self, text: Option<String>) -> Result<()> {
        let place = self.plans.clone();
        tokio::task::spawn_blocking(move || match place {
            #[cfg(target_os = "macos")]
            PlansPlace::System => {
                let entry = credential_for(PLANS_SERVICE, PLANS_ACCOUNT)?;
                match text {
                    Some(text) => entry.set_password(&text).with_context(|| {
                        format!("{SYSTEM_STORE} wouldn't keep the sign-in; {UNLOCK} and try again")
                    }),
                    None => match entry.delete_credential() {
                        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                        Err(_) => bail!("{SYSTEM_STORE} wouldn't remove the sign-in"),
                    },
                }
            }
            #[cfg(windows)]
            PlansPlace::System => crate::connected_tools::vault::credential_manager::write(
                PLANS_SERVICE,
                PLANS_ACCOUNT,
                text.as_deref(),
            )
            .map_err(|()| {
                anyhow::anyhow!("{SYSTEM_STORE} wouldn't keep the sign-in; {UNLOCK} and try again")
            }),
            PlansPlace::File(path) => match text {
                Some(text) => crate::approvals::write_private(&path, text.as_bytes())
                    .context("cannot write plans.json"),
                None => match std::fs::remove_file(&path) {
                    Ok(()) => Ok(()),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    Err(error) => Err(error).context("cannot remove plans.json"),
                },
            },
            #[cfg(test)]
            PlansPlace::Memory(slot) => {
                *slot.lock().map_err(|_| anyhow::anyhow!("poisoned"))? = text;
                Ok(())
            }
        })
        .await
        .context("the key store stopped")?
    }

    /// The `OpenRouter` key, if one was entered.
    ///
    /// # Errors
    ///
    /// When the store can't be read: a locked Keychain, a read the person refused, or a Windows
    /// session whose Credential Manager is unavailable.
    pub async fn openrouter(&self) -> Result<Option<ApiKey>> {
        let mut cached = self.cached.lock().await;
        if let Cached::Known(key) = &*cached {
            return Ok(key.clone());
        }
        let key = self.read().await?.as_deref().and_then(ApiKey::new);
        *cached = Cached::Known(key.clone());
        Ok(key)
    }

    /// Keeps `key` as the `OpenRouter` key.
    ///
    /// # Errors
    ///
    /// When it is empty or can't be kept.
    pub async fn set_openrouter(&self, key: &str) -> Result<()> {
        let Some(key) = ApiKey::new(key) else {
            bail!("the key is empty");
        };
        let mut cached = self.cached.lock().await;
        let written = self.write(Some(key.expose().to_owned())).await;
        *cached = if written.is_ok() {
            Cached::Known(Some(key))
        } else {
            Cached::Unread
        };
        written
    }

    /// Forgets the `OpenRouter` key.
    ///
    /// # Errors
    ///
    /// When the store can't be changed.
    pub async fn remove_openrouter(&self) -> Result<()> {
        let mut cached = self.cached.lock().await;
        let written = self.write(None).await;
        *cached = if written.is_ok() {
            Cached::Known(None)
        } else {
            Cached::Unread
        };
        written
    }

    async fn read(&self) -> Result<Option<String>> {
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || match store {
            #[cfg(any(target_os = "macos", windows))]
            Store::System(service) => match credential(service)?.get_password() {
                Ok(value) => Ok(Some(value)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(_) => bail!(
                    "{SYSTEM_STORE} wouldn't give LoomWatch its OpenRouter key; {UNLOCK} and try \
                     again"
                ),
            },
            Store::File(path) => match std::fs::read(&path) {
                Ok(bytes) => Ok(serde_json::from_slice::<KeyFile>(&bytes)
                    .context("keys.json is damaged")?
                    .openrouter),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(error) => Err(error).context("cannot read keys.json"),
            },
            #[cfg(test)]
            Store::Memory(slot) => Ok(slot
                .lock()
                .map_err(|_| anyhow::anyhow!("poisoned"))?
                .clone()),
        })
        .await
        .context("the key store stopped")?
    }

    async fn write(&self, value: Option<String>) -> Result<()> {
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || match store {
            #[cfg(any(target_os = "macos", windows))]
            Store::System(service) => {
                let entry = credential(service)?;
                match value {
                    Some(value) => entry.set_password(&value).with_context(|| {
                        format!("{SYSTEM_STORE} wouldn't keep the key; {UNLOCK} and try again")
                    }),
                    None => match entry.delete_credential() {
                        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                        Err(_) => bail!("{SYSTEM_STORE} wouldn't remove the key"),
                    },
                }
            }
            Store::File(path) => {
                let file = KeyFile { openrouter: value };
                crate::approvals::write_private(&path, &serde_json::to_vec_pretty(&file)?)
                    .context("cannot write keys.json")
            }
            #[cfg(test)]
            Store::Memory(slot) => {
                *slot.lock().map_err(|_| anyhow::anyhow!("poisoned"))? = value;
                Ok(())
            }
        })
        .await
        .context("the key store stopped")?
    }
}

/// The system's store, as an error names it, and what the person can do when it refuses.
#[cfg(target_os = "macos")]
const SYSTEM_STORE: &str = "the macOS Keychain";
#[cfg(target_os = "macos")]
const UNLOCK: &str = "unlock it";
#[cfg(windows)]
const SYSTEM_STORE: &str = "Windows Credential Manager";
#[cfg(windows)]
const UNLOCK: &str = "sign in to Windows with your own account";

#[cfg(any(target_os = "macos", windows))]
fn credential(service: &str) -> Result<keyring::Entry> {
    credential_for(service, ACCOUNT)
}

#[cfg(any(target_os = "macos", windows))]
fn credential_for(service: &str, account: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(service, account).with_context(|| format!("{SYSTEM_STORE} is unavailable"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_key_is_kept_read_back_and_removed() {
        let keys = Keys::in_memory();
        assert!(keys.openrouter().await.unwrap().is_none());
        keys.set_openrouter("  sk-or-v1-abc  ").await.unwrap();
        assert_eq!(
            keys.openrouter().await.unwrap().unwrap().expose(),
            "sk-or-v1-abc"
        );
        assert!(keys.set_openrouter("   ").await.is_err());
        keys.remove_openrouter().await.unwrap();
        assert!(keys.openrouter().await.unwrap().is_none());
    }

    /// On Windows the key is a generic credential this account alone can read, kept across
    /// processes and removed with the key. A service name of its own, so the test never touches
    /// the key an installed `LoomWatch` keeps.
    #[cfg(windows)]
    #[tokio::test]
    async fn on_windows_the_key_is_kept_in_credential_manager() {
        const TEST_SERVICE: &str = "LoomWatch.Test.OpenRouter";
        let folder = std::env::temp_dir().join(format!("loomwatch-keys-{}", uuid::Uuid::new_v4()));
        let keys = Keys::with(
            Store::System(TEST_SERVICE),
            PlansPlace::File(folder.join(PLANS_FILE)),
        );
        keys.set_openrouter("sk-or-v1-credential-manager")
            .await
            .unwrap();
        assert!(!folder.join(FILE_NAME).exists());
        let fresh = Keys::with(
            Store::System(TEST_SERVICE),
            PlansPlace::File(folder.join(PLANS_FILE)),
        );
        assert_eq!(
            fresh.openrouter().await.unwrap().unwrap().expose(),
            "sk-or-v1-credential-manager"
        );
        fresh.remove_openrouter().await.unwrap();
        assert!(
            Keys::with(
                Store::System(TEST_SERVICE),
                PlansPlace::File(folder.join(PLANS_FILE))
            )
            .openrouter()
            .await
            .unwrap()
            .is_none()
        );
        // Forgetting a key that is already gone is not an error.
        fresh.remove_openrouter().await.unwrap();
    }

    fn signed_in() -> ChatGptSecret {
        ChatGptSecret {
            client_id: "oaiapp_test".into(),
            refresh_token: "rt_test".into(),
            subject: "user-1".into(),
            email: "a@example.com".into(),
            scopes: vec!["chatgpt.tokens.use.direct".into()],
        }
    }

    /// Saving the Claude key never loses the `ChatGPT` sign-in, nor the other way round, and neither
    /// touches the `OpenRouter` key.
    #[tokio::test]
    async fn the_plans_secrets_are_kept_side_by_side() {
        let keys = Keys::in_memory();
        assert!(keys.plan_secrets().await.unwrap().is_empty());
        keys.set_openrouter("sk-or-v1-abc").await.unwrap();
        keys.change_plan_secrets(|secrets| secrets.anthropic = Some("sk-ant-api03-x".into()))
            .await
            .unwrap();
        keys.change_plan_secrets(|secrets| secrets.chatgpt = Some(signed_in()))
            .await
            .unwrap();
        let kept = keys
            .change_plan_secrets(|secrets| secrets.anthropic = None)
            .await
            .unwrap();
        assert!(kept.anthropic.is_none() && kept.chatgpt == Some(signed_in()));
        assert!(keys.plan_secrets().await.unwrap().chatgpt == Some(signed_in()));
        assert_eq!(
            keys.openrouter().await.unwrap().unwrap().expose(),
            "sk-or-v1-abc"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_plans_file_is_private_and_goes_when_empty() {
        use std::os::unix::fs::PermissionsExt;
        let folder = std::env::temp_dir().join(format!("loomwatch-plans-{}", uuid::Uuid::new_v4()));
        let keys = Keys::in_file(&folder);
        keys.change_plan_secrets(|secrets| secrets.chatgpt = Some(signed_in()))
            .await
            .unwrap();
        let file = folder.join(PLANS_FILE);
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        // A fresh process reads it back, and the OpenRouter key file was never written.
        assert!(Keys::in_file(&folder).plan_secrets().await.unwrap().chatgpt == Some(signed_in()));
        assert!(!folder.join(FILE_NAME).exists());
        keys.change_plan_secrets(|secrets| secrets.chatgpt = None)
            .await
            .unwrap();
        assert!(!file.exists());
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(&file, "{not json").unwrap();
        assert!(Keys::in_file(&folder).plan_secrets().await.is_err());
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_key_file_is_private_to_this_account() {
        use std::os::unix::fs::PermissionsExt;
        let folder = std::env::temp_dir().join(format!("loomwatch-keys-{}", uuid::Uuid::new_v4()));
        let keys = Keys::in_file(&folder);
        keys.set_openrouter("sk-or-v1-file").await.unwrap();
        let mode = std::fs::metadata(folder.join(FILE_NAME))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        // A fresh process reads it back.
        assert_eq!(
            Keys::in_file(&folder)
                .openrouter()
                .await
                .unwrap()
                .unwrap()
                .expose(),
            "sk-or-v1-file"
        );
        let _ = std::fs::remove_dir_all(&folder);
    }
}
