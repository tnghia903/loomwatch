//! Other devices connected to `LoomWatch` on this computer (ADR 0102): a phone, or another
//! computer whose notch, menu bar and browser show this one.
//!
//! This computer keeps everything: agents, keys, sign-ins, files and run history. A connected
//! device keeps only a key of its own, made when it pairs and never stored here, only its SHA-256.
//! Devices reach `LoomWatch` through the door ([`door`]), a second listener on this computer's own
//! address, which something the person set up here brings them to: their own Tailscale today
//! ([`reach`]). The door lets a phone do what a phone may, and a computer what a person sitting
//! here may. Making a pairing code, the list and Remove are on this computer's own address only
//! ([`api`]).

pub mod api;
pub mod connected;
mod door;
#[cfg(test)]
mod pairing_tests;
mod pass;
mod phone;
pub mod push;
pub mod reach;
#[cfg(all(test, unix))]
mod reach_tests;
#[cfg(test)]
mod tests;

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use base64::Engine as _;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub use door::router as door_router;

/// Where the door answers unless `LOOMWATCH_DEVICES_LISTEN` says otherwise. Tailscale's share
/// points at it, so it stays the same from one start to the next.
pub const DOOR: &str = "127.0.0.1:3440";

/// How long a pairing code works.
pub const CODE_LIFETIME: Duration = Duration::from_mins(10);

/// Wrong codes in a row before every open code ends.
pub const WRONG_CODES: u32 = 5;

/// How often a device's last use is written down. Every request would be a write.
const SEEN_EVERY: chrono::TimeDelta = chrono::TimeDelta::minutes(10);

/// The longest name a device keeps.
const NAME_LIMIT: usize = 60;

/// What kind of device a pairing code is for, which decides what the device may do.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    /// See, answer, approve, start, stop, chat and Ask: the phone's list ([`phone::ALLOWED`]).
    Phone,
    /// Everything a person at this computer can do: it runs the whole app.
    Computer,
}

impl Kind {
    fn default_name(self) -> &'static str {
        match self {
            Self::Phone => "iPhone",
            Self::Computer => "Computer",
        }
    }
}

/// A connected device as the app shows it. Never its key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub kind: Kind,
    pub paired_at: DateTime<Utc>,
    pub last_seen: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    id: String,
    name: String,
    kind: Kind,
    /// SHA-256 of the device's key, in hex.
    key_sha256: String,
    paired_at: DateTime<Utc>,
    #[serde(default)]
    last_seen: Option<DateTime<Utc>>,
    /// Where a phone's pushes go, once it has given its token ([`push`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    push: Option<push::PushTarget>,
}

impl Stored {
    fn device(&self) -> Device {
        Device {
            id: self.id.clone(),
            name: self.name.clone(),
            kind: self.kind,
            paired_at: self.paired_at,
            last_seen: self.last_seen,
        }
    }
}

#[derive(Default, Serialize, Deserialize)]
struct File {
    devices: Vec<Stored>,
}

/// A pairing code waiting to be used. Kept in memory only: a restart ends it.
struct Open {
    code_sha256: [u8; 32],
    kind: Kind,
    until: DateTime<Utc>,
}

#[derive(Default)]
struct State {
    devices: Vec<Stored>,
    open: Option<Open>,
    wrong: u32,
}

/// A code made on this computer for one kind of device.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Code {
    pub code: String,
    pub kind: Kind,
    pub expires_at: DateTime<Utc>,
}

/// Why a code didn't pair.
#[derive(Debug, PartialEq, Eq)]
pub enum Refused {
    /// Wrong, used, or run out. One answer for all three, so a guess learns nothing.
    NoSuchCode,
    /// The right code, made for this other kind of device.
    MadeFor(Kind),
}

/// The devices connected to this computer.
pub struct Devices {
    /// `devices.json` in the state folder. None in tests that keep it in memory.
    file: Option<PathBuf>,
    state: Mutex<State>,
}

impl Devices {
    /// The devices kept in `<state_dir>/devices.json`. A missing or unreadable file is no devices:
    /// each one pairs again.
    #[must_use]
    pub fn open(state_dir: &Path) -> Arc<Self> {
        let file = state_dir.join("devices.json");
        let devices = std::fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<File>(&bytes).ok())
            .map(|file| file.devices)
            .unwrap_or_default();
        Arc::new(Self {
            file: Some(file),
            state: Mutex::new(State {
                devices,
                ..State::default()
            }),
        })
    }

    /// Devices kept in memory only.
    #[must_use]
    pub fn memory() -> Arc<Self> {
        Arc::new(Self {
            file: None,
            state: Mutex::default(),
        })
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Every connected device, the first paired first.
    #[must_use]
    pub fn list(&self) -> Vec<Device> {
        self.state().devices.iter().map(Stored::device).collect()
    }

    /// A new code for a `kind` of device. It works once, for [`CODE_LIFETIME`], and ends the code
    /// made before it.
    #[must_use]
    pub fn make_code(&self, kind: Kind) -> Code {
        let code = random_text::<16>();
        let expires_at = Utc::now()
            + chrono::TimeDelta::from_std(CODE_LIFETIME).unwrap_or(chrono::TimeDelta::zero());
        let mut state = self.state();
        state.open = Some(Open {
            code_sha256: sha256(&code),
            kind,
            until: expires_at,
        });
        state.wrong = 0;
        Code {
            code,
            kind,
            expires_at,
        }
    }

    /// Trades an open code for a device and its key, shown this once. [`WRONG_CODES`] wrong codes in
    /// a row end the open one. A device that says what it is (`expected`) gets only a code made for
    /// its kind.
    ///
    /// # Errors
    ///
    /// [`Refused::NoSuchCode`] for a wrong, used or old code; [`Refused::MadeFor`] for a code made
    /// for the other kind of device, which still works for that kind.
    pub fn claim(
        &self,
        code: &str,
        name: Option<&str>,
        expected: Option<Kind>,
    ) -> Result<(Device, String), Refused> {
        let mut state = self.state();
        let now = Utc::now();
        let matches = state
            .open
            .as_ref()
            .is_some_and(|open| same(&open.code_sha256, &sha256(code.trim())) && open.until > now);
        if !matches {
            state.wrong += 1;
            if state.wrong >= WRONG_CODES {
                state.open = None;
            }
            return Err(Refused::NoSuchCode);
        }
        // The right code on the wrong kind of device: said so, and the code still works.
        if let Some(open) = &state.open
            && expected.is_some_and(|expected| expected != open.kind)
        {
            return Err(Refused::MadeFor(open.kind));
        }
        let Some(open) = state.open.take() else {
            return Err(Refused::NoSuchCode);
        };
        state.wrong = 0;
        let key = random_text::<32>();
        let stored = Stored {
            id: uuid::Uuid::new_v4().simple().to_string(),
            name: clean_name(name, open.kind),
            kind: open.kind,
            key_sha256: hex(&sha256(&key)),
            paired_at: now,
            last_seen: Some(now),
            push: None,
        };
        let device = stored.device();
        state.devices.push(stored);
        self.save(&state);
        Ok((device, key))
    }

    /// The device holding `key`, now seen.
    #[must_use]
    pub fn check(&self, key: &str) -> Option<Device> {
        let given = hex(&sha256(key));
        let mut state = self.state();
        let now = Utc::now();
        let found = state
            .devices
            .iter_mut()
            .find(|device| same(device.key_sha256.as_bytes(), given.as_bytes()))?;
        let unseen = found
            .last_seen
            .is_none_or(|seen| now.signed_duration_since(seen) >= SEEN_EVERY);
        if unseen {
            found.last_seen = Some(now);
        }
        let device = found.device();
        if unseen {
            self.save(&state);
        }
        Some(device)
    }

    /// Removes a device: its key stops working at once. False when there was none.
    pub fn remove(&self, id: &str) -> bool {
        let mut state = self.state();
        let before = state.devices.len();
        state.devices.retain(|device| device.id != id);
        let removed = state.devices.len() != before;
        if removed {
            self.save(&state);
        }
        removed
    }

    /// Where device `id`'s pushes go from now on; `None` stops them. False when there is no such
    /// device.
    pub fn set_push(&self, id: &str, target: Option<push::PushTarget>) -> bool {
        let mut state = self.state();
        let Some(device) = state.devices.iter_mut().find(|device| device.id == id) else {
            return false;
        };
        if device.push != target {
            device.push = target;
            self.save(&state);
        }
        true
    }

    /// Every phone that has given a push token, by its id.
    #[must_use]
    pub fn push_targets(&self) -> Vec<(String, push::PushTarget)> {
        self.state()
            .devices
            .iter()
            .filter(|device| device.kind == Kind::Phone)
            .filter_map(|device| Some((device.id.clone(), device.push.clone()?)))
            .collect()
    }

    /// Forgets device `id`'s push token when it is still `token`: Apple said it's no good.
    pub fn forget_push_token(&self, id: &str, token: &str) {
        let mut state = self.state();
        let Some(device) = state.devices.iter_mut().find(|device| device.id == id) else {
            return;
        };
        if device.push.as_ref().is_some_and(|push| push.token == token) {
            device.push = None;
            self.save(&state);
        }
    }

    /// Connects a device of `kind` whose key is `key`, as pairing would.
    #[cfg(test)]
    fn connect_for_test(&self, kind: Kind, key: &str) -> Device {
        let stored = Stored {
            id: uuid::Uuid::new_v4().simple().to_string(),
            name: kind.default_name().to_owned(),
            kind,
            key_sha256: hex(&sha256(key)),
            paired_at: Utc::now(),
            last_seen: None,
            push: None,
        };
        let device = stored.device();
        self.state().devices.push(stored);
        device
    }

    fn save(&self, state: &State) {
        let Some(file) = &self.file else {
            return;
        };
        let body = File {
            devices: state.devices.clone(),
        };
        let Ok(bytes) = serde_json::to_vec_pretty(&body) else {
            return;
        };
        if let Some(folder) = file.parent() {
            let _ = std::fs::create_dir_all(folder);
        }
        if let Err(error) = crate::api::atomic_write(file, &bytes, false) {
            eprintln!(
                "warning: couldn't save connected devices to {}: {error}",
                file.display()
            );
        }
    }
}

/// Where the door listens: `LOOMWATCH_DEVICES_LISTEN`, [`DOOR`] without it, or nowhere for
/// `off`. Only this computer's own address: what reaches it from elsewhere is brought here.
///
/// # Errors
///
/// A setting that isn't `off` or an address on this computer.
pub fn door_address(setting: Option<&str>) -> Result<Option<SocketAddr>, String> {
    let setting = setting.map(str::trim).filter(|setting| !setting.is_empty());
    if setting.is_some_and(|setting| setting.eq_ignore_ascii_case("off")) {
        return Ok(None);
    }
    let address: SocketAddr = setting.unwrap_or(DOOR).parse().map_err(|_| {
        format!("LOOMWATCH_DEVICES_LISTEN must be off or an address such as {DOOR}")
    })?;
    if !address.ip().is_loopback() {
        return Err(format!(
            "LOOMWATCH_DEVICES_LISTEN must be on this computer's own address, such as {DOOR}, not {address}"
        ));
    }
    Ok(Some(address))
}

/// Opens the door on `address`, in front of `LoomWatch` on `home`, and starts pushing to phones
/// that gave a token ([`push`]). When the port is taken, this computer runs without a door and
/// says so; nothing else changes.
pub async fn open_door(
    devices: Arc<Devices>,
    push_key: push::key::KeyPlace,
    address: SocketAddr,
    home: SocketAddr,
) -> bool {
    let listener = match tokio::net::TcpListener::bind(address).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!(
                "warning: other devices can't connect: {address} is in use ({error}). Set LOOMWATCH_DEVICES_LISTEN to another port, or off."
            );
            return false;
        }
    };
    println!("devices connect through http://{address}");
    let home = format!("http://{home}");
    push::spawn(devices.clone(), push_key.clone(), &home);
    let app = door_router(devices, push_key, &home);
    tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, app).await {
            eprintln!("warning: the door for other devices closed: {error}");
        }
    });
    true
}

fn clean_name(name: Option<&str>, kind: Kind) -> String {
    let name: String = name
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if name.is_empty() {
        return kind.default_name().to_owned();
    }
    name.chars().take(NAME_LIMIT).collect()
}

/// `N` random bytes, as URL-safe text.
fn random_text<const N: usize>() -> String {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).expect("the system's random source works");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn sha256(text: &str) -> [u8; 32] {
    Sha256::digest(text.as_bytes()).into()
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut text, byte| {
        let _ = write!(text, "{byte:02x}");
        text
    })
}

/// Compares two values in time that doesn't depend on where they first differ.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |diff, (x, y)| diff | (x ^ y)) == 0
}
