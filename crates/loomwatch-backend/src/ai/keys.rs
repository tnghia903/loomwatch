//! Where the operator's `OpenRouter` key is kept.
//!
//! On a Mac it is a Keychain item, `LoomWatch.OpenRouter`, the way the Notion connection is kept.
//! Elsewhere it is `<state dir>/keys.json`, readable by this account only. Either way it is read
//! once per process: macOS asks the person to allow each read by a program it doesn't trust yet,
//! and every run needs the key.
//!
//! Only keys entered in `LoomWatch` are used. An `OPENROUTER_API_KEY` in the daemon's environment
//! is ignored, and nothing here ever looks for another app's credentials.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::agent::ApiKey;

#[cfg(target_os = "macos")]
const SERVICE: &str = "LoomWatch.OpenRouter";
#[cfg(target_os = "macos")]
const ACCOUNT: &str = "api-key";
const FILE_NAME: &str = "keys.json";

/// The operator's provider keys.
#[derive(Clone)]
pub struct Keys {
    store: Store,
    cached: Arc<Mutex<Cached>>,
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
    #[cfg(target_os = "macos")]
    Keychain,
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
    /// The Keychain on a Mac, `<state_dir>/keys.json` elsewhere.
    #[must_use]
    pub fn open(state_dir: &Path) -> Self {
        #[cfg(target_os = "macos")]
        let store = {
            let _ = state_dir;
            Store::Keychain
        };
        #[cfg(not(target_os = "macos"))]
        let store = Store::File(state_dir.join(FILE_NAME));
        Self::with(store)
    }

    /// A file in `state_dir`, even on a Mac: for a trial copy that must not touch the Keychain.
    #[must_use]
    pub fn in_file(state_dir: &Path) -> Self {
        Self::with(Store::File(state_dir.join(FILE_NAME)))
    }

    #[cfg(test)]
    pub(crate) fn in_memory() -> Self {
        Self::with(Store::Memory(Arc::default()))
    }

    fn with(store: Store) -> Self {
        Self {
            store,
            cached: Arc::new(Mutex::new(Cached::Unread)),
        }
    }

    /// The `OpenRouter` key, if one was entered.
    ///
    /// # Errors
    ///
    /// When the store can't be read: a locked Keychain, or a read the person refused.
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
            #[cfg(target_os = "macos")]
            Store::Keychain => match credential()?.get_password() {
                Ok(value) => Ok(Some(value)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(_) => bail!(
                    "the macOS Keychain wouldn't give LoomWatch its OpenRouter key; unlock it and \
                     try again"
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
            #[cfg(target_os = "macos")]
            Store::Keychain => {
                let entry = credential()?;
                match value {
                    Some(value) => entry.set_password(&value).context(
                        "the macOS Keychain wouldn't keep the key; unlock it and try again",
                    ),
                    None => match entry.delete_credential() {
                        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                        Err(_) => bail!("the macOS Keychain wouldn't remove the key"),
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

#[cfg(target_os = "macos")]
fn credential() -> Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, ACCOUNT).context("the macOS Keychain is unavailable")
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
