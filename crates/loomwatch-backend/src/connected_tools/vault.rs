//! Where connected tools' secrets are kept: a sign-in's tokens, or a token the operator pasted.
//!
//! All of them share one Keychain item (Credential Manager on Windows), so a Mac that does not yet
//! trust this build asks once, not once per tool. With `LOOMWATCH_KEY_STORE=file`
//! ([`crate::ai::KEY_STORE_ENV`]) they are kept in a private file in the state folder instead, so
//! a trial copy never reads or writes the item the installed app keeps. Nothing here is written to
//! `tools.json`, logged, or answered by the API.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use rmcp::transport::auth::{
    AuthError, CredentialRefreshGuard, CredentialStore, StoredCredentials,
};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

#[cfg(any(target_os = "macos", windows))]
const SERVICE: &str = "LoomWatch.Tools";
#[cfg(any(target_os = "macos", windows))]
const ACCOUNT: &str = "connected-tools";
/// What [`Place::File`] keeps, in the state folder: the JSON the Keychain item holds.
pub(crate) const CREDENTIALS_FILE: &str = "tool-credentials.json";

/// One tool's secret. Deliberately no Debug implementation: it holds credentials.
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(super) enum Secret {
    /// A sign-in through the tool's own site: the client it registered and the tokens it holds.
    SignIn { credentials: Box<StoredCredentials> },
    /// A token the operator pasted, sent as a bearer header.
    Token { token: String },
}

/// The secrets of every connected tool, by tool id. Cheap to clone.
#[derive(Clone)]
pub(super) struct Vault {
    inner: Arc<Inner>,
}

struct Inner {
    place: Place,
    /// What was last read or written, so the Keychain is read once per process. `None` until then,
    /// and again after a read fails, so the next use asks again.
    known: Mutex<Option<BTreeMap<String, Secret>>>,
}

enum Place {
    Keychain,
    /// `<state dir>/tool-credentials.json`, readable by this account only.
    File(PathBuf),
    #[cfg(test)]
    Memory(std::sync::Mutex<Option<String>>),
}

impl Vault {
    /// The Keychain, or the file in `state_dir` when `in_file`.
    pub(super) fn chosen(state_dir: &Path, in_file: bool) -> Self {
        Self::at(if in_file {
            Place::File(state_dir.join(CREDENTIALS_FILE))
        } else {
            Place::Keychain
        })
    }

    #[cfg(test)]
    pub(super) fn memory() -> Self {
        Self::at(Place::Memory(std::sync::Mutex::new(None)))
    }

    fn at(place: Place) -> Self {
        Self {
            inner: Arc::new(Inner {
                place,
                known: Mutex::new(None),
            }),
        }
    }

    /// Whether a secret can be kept here at all. Linux has no system store, so only the file keeps
    /// one there.
    pub(super) fn available(&self) -> bool {
        match self.inner.place {
            Place::Keychain => cfg!(any(target_os = "macos", windows)),
            Place::File(_) => true,
            #[cfg(test)]
            Place::Memory(_) => true,
        }
    }

    /// The secret kept for tool `id`, if any.
    pub(super) async fn get(&self, id: &str) -> Result<Option<Secret>, String> {
        let mut known = self.inner.known.lock().await;
        let all = self.loaded(&mut known).await?;
        Ok(all.get(id).cloned())
    }

    /// Keep `secret` for tool `id`, or forget it with `None`.
    pub(super) async fn set(&self, id: &str, secret: Option<Secret>) -> Result<(), String> {
        let mut known = self.inner.known.lock().await;
        let mut all = self.loaded(&mut known).await?.clone();
        match secret {
            Some(secret) => {
                all.insert(id.to_owned(), secret);
            }
            None => {
                if all.remove(id).is_none() {
                    return Ok(());
                }
            }
        }
        let text = if all.is_empty() {
            None
        } else {
            Some(serde_json::to_string(&all).map_err(|_| self.unavailable())?)
        };
        // Until the write is known to have landed, the next use reads the store again.
        *known = None;
        self.write(text).await?;
        *known = Some(all);
        Ok(())
    }

    async fn loaded<'a>(
        &self,
        known: &'a mut Option<BTreeMap<String, Secret>>,
    ) -> Result<&'a BTreeMap<String, Secret>, String> {
        if known.is_none() {
            let all = match self.read().await? {
                Some(text) => serde_json::from_str(&text).map_err(|_| self.unavailable())?,
                None => BTreeMap::new(),
            };
            *known = Some(all);
        }
        Ok(known.as_ref().expect("filled above"))
    }

    async fn read(&self) -> Result<Option<String>, String> {
        match &self.inner.place {
            Place::Keychain => keychain_read().await,
            Place::File(path) => {
                let path = path.clone();
                tokio::task::spawn_blocking(move || match std::fs::read_to_string(&path) {
                    Ok(text) => Ok(Some(text)),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
                    Err(_) => Err(file_error()),
                })
                .await
                .map_err(|_| file_error())?
            }
            #[cfg(test)]
            Place::Memory(slot) => Ok(slot.lock().map_err(|_| file_error())?.clone()),
        }
    }

    async fn write(&self, text: Option<String>) -> Result<(), String> {
        match &self.inner.place {
            Place::Keychain => keychain_write(text).await,
            Place::File(path) => {
                let path = path.clone();
                tokio::task::spawn_blocking(move || {
                    match text {
                        Some(text) => crate::approvals::write_private(&path, text.as_bytes()),
                        None => match std::fs::remove_file(&path) {
                            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                            removed => removed,
                        },
                    }
                    .map_err(|_| file_error())
                })
                .await
                .map_err(|_| file_error())?
            }
            #[cfg(test)]
            Place::Memory(slot) => {
                *slot.lock().map_err(|_| file_error())? = text;
                Ok(())
            }
        }
    }

    fn unavailable(&self) -> String {
        if matches!(self.inner.place, Place::File(_)) {
            file_error()
        } else {
            storage_error()
        }
    }

    /// What is kept in the store itself, for tests that show a secret never lands anywhere else.
    #[cfg(test)]
    pub(super) fn raw(&self) -> Option<String> {
        match &self.inner.place {
            Place::Memory(slot) => slot.lock().ok()?.clone(),
            _ => None,
        }
    }
}

/// A sign-in's credentials as rmcp keeps them, in the [`Vault`] under the tool's id. Refreshes of
/// one tool's tokens take turns: a provider that rotates refresh tokens retires the old one as it
/// answers with the next.
pub(super) struct SignInStore {
    pub(super) vault: Vault,
    pub(super) id: String,
    pub(super) refreshing: Arc<Mutex<()>>,
}

#[async_trait]
impl CredentialStore for SignInStore {
    async fn load(&self) -> Result<Option<StoredCredentials>, AuthError> {
        match self.vault.get(&self.id).await {
            Ok(Some(Secret::SignIn { credentials })) => Ok(Some(*credentials)),
            Ok(_) => Ok(None),
            Err(said) => Err(AuthError::CredentialStoreError(said)),
        }
    }

    async fn save(&self, credentials: StoredCredentials) -> Result<(), AuthError> {
        self.vault
            .set(
                &self.id,
                Some(Secret::SignIn {
                    credentials: Box::new(credentials),
                }),
            )
            .await
            .map_err(AuthError::CredentialStoreError)
    }

    async fn clear(&self) -> Result<(), AuthError> {
        self.vault
            .set(&self.id, None)
            .await
            .map_err(AuthError::CredentialStoreError)
    }

    async fn acquire_refresh_guard(&self) -> Result<Option<CredentialRefreshGuard>, AuthError> {
        Ok(Some(CredentialRefreshGuard::new(
            self.refreshing.clone().lock_owned().await,
        )))
    }
}

fn storage_error() -> String {
    if cfg!(windows) {
        "Windows Credential Manager is unavailable, so LoomWatch can't keep this tool's sign-in. Sign in to Windows with your own account and retry.".to_owned()
    } else if cfg!(target_os = "macos") {
        "The macOS Keychain is unavailable or locked, so LoomWatch can't keep this tool's sign-in. Unlock it and retry.".to_owned()
    } else {
        "This computer has no store LoomWatch can keep a sign-in in. Start LoomWatch with LOOMWATCH_KEY_STORE=file to keep it in a private file instead.".to_owned()
    }
}

fn file_error() -> String {
    format!(
        "LoomWatch can't read or write {CREDENTIALS_FILE} in its state folder. Check that folder and retry."
    )
}

/// Tests keep secrets in memory: reaching the real Keychain is a mistake in the test.
#[cfg(test)]
fn never_the_keychain() {
    panic!("a test reached the real Keychain: give it Vault::memory()");
}

async fn keychain_read() -> Result<Option<String>, String> {
    #[cfg(test)]
    never_the_keychain();
    tokio::task::spawn_blocking(|| {
        #[cfg(target_os = "macos")]
        {
            match keyring::Entry::new(SERVICE, ACCOUNT)
                .map_err(|_| storage_error())?
                .get_password()
            {
                Ok(value) => Ok(Some(value)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(_) => Err(storage_error()),
            }
        }
        #[cfg(windows)]
        {
            credential_manager::read()
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            Err(storage_error())
        }
    })
    .await
    .map_err(|_| storage_error())?
}

async fn keychain_write(value: Option<String>) -> Result<(), String> {
    #[cfg(test)]
    never_the_keychain();
    tokio::task::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        {
            let entry = keyring::Entry::new(SERVICE, ACCOUNT).map_err(|_| storage_error())?;
            if let Some(value) = value {
                entry.set_password(&value).map_err(|_| storage_error())
            } else {
                match entry.delete_credential() {
                    Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                    Err(_) => Err(storage_error()),
                }
            }
        }
        #[cfg(windows)]
        {
            credential_manager::write(value.as_deref())
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            let _ = value;
            Err(storage_error())
        }
    })
    .await
    .map_err(|_| storage_error())?
}

/// The most bytes kept in one saved credential: Windows Credential Manager refuses more than
/// 2,560, and the first part also carries [`SECRET_PARTS_MARKER`].
#[cfg(any(windows, test))]
const SECRET_PART_BYTES: usize = 2_400;
/// How many saved credentials one secret may take, 24 KB in all: far more than every tool's
/// sign-in together is.
#[cfg(any(windows, test))]
pub(crate) const MAX_SECRET_PARTS: usize = 10;
/// How the first of several parts begins: never the start of what is kept, which is JSON.
#[cfg(any(windows, test))]
const SECRET_PARTS_MARKER: &str = "loomwatch-parts:";

/// `value` cut into parts no longer than [`SECRET_PART_BYTES`], on character boundaries. One part
/// is `value` itself; the first of several starts with [`SECRET_PARTS_MARKER`], the count, and a
/// newline.
#[cfg(any(windows, test))]
pub(crate) fn split_secret(value: &str) -> Vec<String> {
    if value.len() <= SECRET_PART_BYTES {
        return vec![value.to_owned()];
    }
    let mut parts = Vec::new();
    let mut rest = value;
    while !rest.is_empty() {
        let mut cut = rest.len().min(SECRET_PART_BYTES - 64);
        while !rest.is_char_boundary(cut) {
            cut -= 1;
        }
        let (part, after) = rest.split_at(cut);
        parts.push(part.to_owned());
        rest = after;
    }
    let count = parts.len();
    parts[0] = format!("{SECRET_PARTS_MARKER}{count}\n{}", parts[0]);
    parts
}

/// The value [`split_secret`] cut into parts, given its first part and a way to read part `n`.
/// `None` when a part it names is missing, or it names more than [`MAX_SECRET_PARTS`].
#[cfg(any(windows, test))]
pub(crate) fn join_secret(
    first: &str,
    mut part: impl FnMut(usize) -> Option<String>,
) -> Option<String> {
    let Some(rest) = first.strip_prefix(SECRET_PARTS_MARKER) else {
        return Some(first.to_owned());
    };
    let (count, head) = rest.split_once('\n')?;
    let count: usize = count.parse().ok()?;
    if !(2..=MAX_SECRET_PARTS).contains(&count) {
        return None;
    }
    let mut value = head.to_owned();
    for index in 1..count {
        value.push_str(&part(index)?);
    }
    Some(value)
}

/// Credential Manager refuses a secret over 2,560 bytes, so a long one is kept in several saved
/// credentials, `connected-tools`, `connected-tools#2`, …, the first of which says how many there
/// are ([`split_secret`]).
#[cfg(windows)]
mod credential_manager {
    use super::{ACCOUNT, MAX_SECRET_PARTS, SERVICE, join_secret, split_secret, storage_error};

    fn entry(part: usize) -> Result<keyring::Entry, String> {
        let account = if part == 0 {
            ACCOUNT.to_owned()
        } else {
            format!("{ACCOUNT}#{}", part + 1)
        };
        keyring::Entry::new(SERVICE, &account).map_err(|_| storage_error())
    }

    fn get(part: usize) -> Result<Option<String>, String> {
        match entry(part)?.get_secret() {
            Ok(bytes) => String::from_utf8(bytes)
                .map(Some)
                .map_err(|_| storage_error()),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(storage_error()),
        }
    }

    fn delete(part: usize) -> Result<(), String> {
        match entry(part)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(storage_error()),
        }
    }

    pub(super) fn read() -> Result<Option<String>, String> {
        let Some(first) = get(0)? else {
            return Ok(None);
        };
        join_secret(&first, |part| get(part).ok().flatten())
            .map(Some)
            .ok_or_else(storage_error)
    }

    pub(super) fn write(value: Option<&str>) -> Result<(), String> {
        let parts = value.map(split_secret).unwrap_or_default();
        for (part, text) in parts.iter().enumerate() {
            entry(part)?
                .set_secret(text.as_bytes())
                .map_err(|_| storage_error())?;
        }
        for part in parts.len()..MAX_SECRET_PARTS {
            delete(part)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A secret longer than one Windows credential holds is kept in several and read back whole,
    /// on character boundaries; a short one is kept exactly as it was.
    #[test]
    fn a_long_secret_is_kept_in_parts_and_read_back_whole() {
        let short = r#"{"token":"secret_abc","name":"Team"}"#;
        assert_eq!(split_secret(short), vec![short.to_owned()]);
        assert_eq!(join_secret(short, |_| None).as_deref(), Some(short));

        let long = format!(r#"{{"token":"{}","name":"Tài liệu"}}"#, "é".repeat(4_000));
        let parts = split_secret(&long);
        assert!(parts.len() > 1);
        assert!(parts.iter().all(|part| part.len() <= SECRET_PART_BYTES));
        assert!(parts[0].starts_with(SECRET_PARTS_MARKER));
        let read = join_secret(&parts[0], |index| parts.get(index).cloned());
        assert_eq!(read.as_deref(), Some(long.as_str()));
        assert_eq!(
            join_secret(&parts[0], |_| None),
            None,
            "a missing part is an error"
        );
        assert_eq!(
            join_secret(&format!("{SECRET_PARTS_MARKER}99\nx"), |_| None),
            None
        );
    }
}
