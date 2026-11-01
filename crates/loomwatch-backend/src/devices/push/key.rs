//! The person's own Apple push key, which lets this computer send to their iPhone through Apple's
//! push service. It is the `.p8` file Apple's developer site gives once, with its key id and team.
//!
//! Kept in the Keychain on a Mac and Credential Manager on Windows, as `LoomWatch.Push`; in the
//! state folder elsewhere, or when `LOOMWATCH_KEY_STORE=file` keeps a trial's keys there. Never in
//! `devices.json`, a log or an answer.

use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::Arc;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// The key, in the state folder, where it isn't kept in the system's own store.
const KEY_FILE: &str = "push-key.json";

#[cfg(any(target_os = "macos", windows))]
const SERVICE: &str = "LoomWatch.Push";
#[cfg(any(target_os = "macos", windows))]
const ACCOUNT: &str = "apns-key";

/// The app pushes go to, unless the key says otherwise: `LoomWatch` for iPhone.
pub const APP: &str = "loomwatch.phone";

/// An Apple push key. Deliberately no Debug implementation: it holds the private key.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushKey {
    /// The key's id on Apple's developer site, such as `ABC123DEFG`.
    pub key_id: String,
    /// The developer team the key belongs to, such as `SR7RDMR5Z5`.
    pub team_id: String,
    /// The app pushes go to: its bundle id.
    pub topic: String,
    /// The `.p8` file's text: a PEM private key.
    pub p8: String,
}

impl PushKey {
    /// A key from what Apple's developer site gives: its id, the team's id and the `.p8` file.
    ///
    /// # Errors
    ///
    /// When an id isn't 10 letters and digits, or the file isn't a private key that can sign.
    pub fn new(key_id: &str, team_id: &str, topic: Option<&str>, p8: &str) -> Result<Self> {
        let key = Self {
            key_id: key_id.trim().to_owned(),
            team_id: team_id.trim().to_owned(),
            topic: topic.map_or(APP, str::trim).to_owned(),
            p8: p8.trim().to_owned(),
        };
        for (what, id) in [("key id", &key.key_id), ("team id", &key.team_id)] {
            anyhow::ensure!(
                id.len() == 10 && id.chars().all(|c| c.is_ascii_alphanumeric()),
                "the {what} should be 10 letters and digits, such as ABC123DEFG"
            );
        }
        anyhow::ensure!(!key.topic.is_empty(), "the app's bundle id is empty");
        super::apns::signing_key(&key.p8)?;
        Ok(key)
    }

    /// What can be said about the key without showing it.
    #[must_use]
    pub fn describe(&self) -> String {
        format!(
            "key {} of team {}, for {}",
            self.key_id, self.team_id, self.topic
        )
    }
}

/// Where this computer keeps the push key.
#[derive(Clone)]
pub struct KeyPlace(Place);

#[derive(Clone)]
enum Place {
    #[cfg(any(target_os = "macos", windows))]
    System,
    File(PathBuf),
    #[cfg(test)]
    Memory(Arc<std::sync::Mutex<Option<String>>>),
}

impl KeyPlace {
    #[must_use]
    pub fn open(state_dir: &Path) -> Self {
        #[cfg(any(target_os = "macos", windows))]
        if !crate::ai::keys_in_file() {
            return Self(Place::System);
        }
        Self(Place::File(state_dir.join(KEY_FILE)))
    }

    #[cfg(test)]
    pub(crate) fn memory() -> Self {
        Self(Place::Memory(Arc::default()))
    }

    /// # Errors
    ///
    /// When the store won't give it, or what it holds is damaged.
    pub async fn read(&self) -> Result<Option<PushKey>> {
        let place = self.0.clone();
        let text = tokio::task::spawn_blocking(move || -> Result<Option<String>> {
            match place {
                #[cfg(any(target_os = "macos", windows))]
                Place::System => match keyring::Entry::new(SERVICE, ACCOUNT)?.get_password() {
                    Ok(text) => Ok(Some(text)),
                    Err(keyring::Error::NoEntry) => Ok(None),
                    Err(error) => Err(error.into()),
                },
                Place::File(path) => match std::fs::read_to_string(&path) {
                    Ok(text) => Ok(Some(text)),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
                    Err(error) => Err(error.into()),
                },
                #[cfg(test)]
                Place::Memory(slot) => Ok(slot
                    .lock()
                    .map_err(|_| anyhow::anyhow!("poisoned"))?
                    .clone()),
            }
        })
        .await
        .context("the key store stopped")??;
        text.map(|text| serde_json::from_str(&text).context("the saved push key is damaged"))
            .transpose()
    }

    /// Keeps `key`; `None` removes it.
    ///
    /// # Errors
    ///
    /// When the store won't keep it.
    pub async fn write(&self, key: Option<&PushKey>) -> Result<()> {
        let text = key.map(serde_json::to_string).transpose()?;
        let place = self.0.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            match place {
                #[cfg(any(target_os = "macos", windows))]
                Place::System => {
                    let entry = keyring::Entry::new(SERVICE, ACCOUNT)?;
                    match text {
                        Some(text) => entry.set_password(&text).map_err(Into::into),
                        None => match entry.delete_credential() {
                            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                            Err(error) => Err(error.into()),
                        },
                    }
                }
                Place::File(path) => match text {
                    Some(text) => {
                        crate::approvals::write_private(&path, text.as_bytes()).map_err(Into::into)
                    }
                    None => match std::fs::remove_file(&path) {
                        Ok(()) => Ok(()),
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                        Err(error) => Err(error.into()),
                    },
                },
                #[cfg(test)]
                Place::Memory(slot) => {
                    *slot.lock().map_err(|_| anyhow::anyhow!("poisoned"))? = text;
                    Ok(())
                }
            }
        })
        .await
        .context("the key store stopped")?
    }
}
