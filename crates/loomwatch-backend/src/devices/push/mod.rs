//! Push to a connected iPhone: when someone waits for the person, or a run finishes, this computer
//! tells Apple's push service, which wakes the phone at once, closed or locked. Whatever changes,
//! news or not (a wait answered on this computer, work starting or ending), the phone's badge,
//! notices, widgets and Live Activity are brought in step with it as well.
//!
//! Sent with the person's own Apple push key ([`key`]), straight from here to Apple ([`apns`]); a
//! relay that sends for people without a key of their own can stand in behind [`Sender`] later.
//! A push says only which thing it is about, by its ids. The phone reads the words from here
//! itself, over the person's own Tailscale, so nothing anyone wrote passes through Apple. That
//! holds for the Live Activity too: its state goes as ids, and the phone says it in its own words.
//!
//! A phone gives its push token, its notification settings and its Live Activity's own token at
//! `PUT /phone/v0/push`, kept with the device in `devices.json`; `DELETE` stops pushes to it.
//! [`spawn`] watches what needs the person, as the phone's home screen shows it, and sends what
//! changed ([`watch`]).

pub mod apns;
pub mod key;
mod watch;

use std::str::FromStr as _;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use axum::Json;
use axum::body::to_bytes;
use axum::extract::Request;
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Timelike as _, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::pass::{no_store, problem};
use super::phone::Daemon;
use super::{Device, Devices, Kind};
use key::KeyPlace;

/// Where a phone gives its push token and settings.
pub const ROUTE: &str = "/phone/v0/push";

/// How often what needs the person is read here.
const EVERY: Duration = Duration::from_secs(3);

/// How long after finding no key, or Apple refusing it, the key is read again.
const KEY_AGAIN: Duration = Duration::from_mins(1);

/// Where pushes go instead of Apple, for a stand-in on this computer: honoured only for a loopback
/// address, so nothing outside can take them.
pub const APNS_URL_ENV: &str = "LOOMWATCH_APNS_URL";

/// Which of Apple's push services a phone's token belongs to: an app built from Xcode gets
/// sandbox tokens, one from `TestFlight` or the App Store production ones.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Environment {
    Sandbox,
    Production,
}

/// Where one phone's pushes go, and what it wants to hear, as its own Settings say.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushTarget {
    /// The phone's push token, in hex.
    pub token: String,
    pub environment: Environment,
    #[serde(default = "yes")]
    pub tell_needs_me: bool,
    #[serde(default = "yes")]
    pub tell_done: bool,
    /// Hours when only a permission ask rings; the rest waits for them to end.
    #[serde(default)]
    pub quiet: Option<Quiet>,
    /// The Live Activity the phone shows now, which this computer keeps in step while the app is
    /// closed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity: Option<ActivityTarget>,
    /// The phone's token for starting a Live Activity from here, in hex, when it has none and
    /// someone starts waiting. Absent when its Live Activities are turned off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_token: Option<String>,
    /// The token of the phone's widgets, in hex, so they read this computer again whenever what
    /// they show changes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub widget_token: Option<String>,
}

/// A Live Activity on the phone: the work it follows, and its own push token from `ActivityKit`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityTarget {
    /// In hex. Not the app's token: Apple gives each Live Activity its own.
    pub token: String,
    /// The run it follows.
    pub run: String,
}

fn yes() -> bool {
    true
}

/// Quiet hours, in the phone's own time: minutes after midnight, across midnight when `from` is
/// later than `to`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quiet {
    pub from: u16,
    pub to: u16,
    /// Such as `Asia/Ho_Chi_Minh`. One this computer doesn't know is UTC.
    pub time_zone: String,
}

impl Quiet {
    #[must_use]
    pub fn holds(&self, now: DateTime<Utc>) -> bool {
        let zone = chrono_tz::Tz::from_str(&self.time_zone).unwrap_or(chrono_tz::UTC);
        let local = now.with_timezone(&zone);
        let minute = u16::try_from(local.hour() * 60 + local.minute()).unwrap_or(0);
        if self.from == self.to {
            return false;
        }
        if self.from < self.to {
            (self.from..self.to).contains(&minute)
        } else {
            minute >= self.from || minute < self.to
        }
    }
}

impl PushTarget {
    fn valid(&self) -> bool {
        let hex = |token: &str, most: usize| {
            (32..=most).contains(&token.len()) && token.chars().all(|c| c.is_ascii_hexdigit())
        };
        hex(&self.token, 200)
            && self.quiet.as_ref().is_none_or(|quiet| {
                quiet.from < 24 * 60 && quiet.to < 24 * 60 && quiet.time_zone.len() <= 64
            })
            && self.activity.as_ref().is_none_or(|activity| {
                hex(&activity.token, 400) && (1..=200).contains(&activity.run.len())
            })
            && [&self.start_token, &self.widget_token]
                .into_iter()
                .flatten()
                .all(|token| hex(token, 400))
    }
}

/// One thing to tell a phone about, by its ids only.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Notice {
    /// The same key the phone's home screen gives it, such as `answer-<run>-<node>` or
    /// `done-<run>`.
    pub target: String,
    pub about: About,
    pub run: Option<String>,
    /// The agent whose stop it is, so Approve on the notice can answer it.
    pub node: Option<String>,
    /// The team's file, so a finished run's notice opens its room.
    pub room: Option<String>,
    /// How many things wait for the person, for the app's badge.
    pub waiting: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum About {
    /// Someone waits for the person. `permission` rings; `review` takes Approve on the notice.
    Waiting {
        permission: bool,
        review: bool,
    },
    Finished,
    /// A message the person asked an agent for at a time (ADR 0108): it always rings.
    Message,
}

impl Notice {
    /// What Apple delivers. The words are the phone's to fill in from here (`mutable-content`);
    /// these are what shows when it can't reach this computer. It also wakes the app
    /// (`content-available`), which reads this computer and brings its widgets, Live Activity and
    /// other notices in step.
    #[must_use]
    pub fn payload(&self) -> Value {
        let (body, category, thread) = match self.about {
            About::Waiting { review, .. } => (
                "Something needs you",
                if review { "review" } else { "ask" },
                "desk",
            ),
            About::Finished => ("A team finished", "", "done"),
            About::Message => ("Your reminder", "", "message"),
        };
        let mut aps = json!({
            "alert": { "title": "LoomWatch", "body": body },
            "mutable-content": 1,
            "content-available": 1,
            "thread-id": thread,
            "badge": self.waiting,
        });
        if !category.is_empty() {
            aps["category"] = json!(category);
        }
        if matches!(
            self.about,
            About::Waiting {
                permission: true,
                ..
            } | About::Message
        ) {
            aps["sound"] = json!("default");
        }
        let mut payload = json!({ "aps": aps, "target": self.target });
        for (name, value) in [
            ("run", &self.run),
            ("node", &self.node),
            ("room", &self.room),
        ] {
            if let Some(value) = value {
                payload[name] = json!(value);
            }
        }
        payload
    }

    /// Apple's collapse id: the target, or its hash when the target is longer than Apple allows.
    #[must_use]
    pub fn collapse_id(&self) -> String {
        if self.target.len() <= 64 {
            return self.target.clone();
        }
        super::hex(&super::sha256(&self.target))
    }
}

/// One push to a phone.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Push {
    /// Something new: someone waits for the person, or work finished.
    Notice(Notice),
    /// What the phone shows changed with nothing new to tell, such as a wait answered on this
    /// computer or work that started: the badge, set at once, and the app woken to bring its
    /// widgets, Live Activity and notices in step. Silent, so it goes in quiet hours too.
    Changed { waiting: usize },
    /// The Live Activity's new state, by ids, as the phone's `WorkActivity.ContentState` reads it;
    /// or its end, with the last state it had.
    Activity {
        state: Option<Value>,
        end: bool,
        /// Someone now waits for the person: shown at once, not when the phone next saves power.
        urgent: bool,
    },
    /// A Live Activity started from here on a phone that has none, for run `run` of the team at
    /// `path`, showing `state`. Its attributes are ids too: the phone names the team.
    Start {
        run: String,
        path: String,
        state: Value,
    },
    /// What the phone's widgets show changed: they read this computer again, closed app or not.
    Widgets,
    /// An agent logged something for the phone to save in Apple Health (ADR 0123): the app is woken
    /// in the background to take it. Nothing about the entry goes through Apple.
    Health,
}

impl Push {
    /// What Apple delivers, as at `now`.
    #[must_use]
    pub fn payload(&self, now: DateTime<Utc>) -> Value {
        match self {
            Self::Notice(notice) => notice.payload(),
            Self::Changed { waiting } => json!({
                "aps": { "badge": waiting, "content-available": 1 },
            }),
            Self::Activity { state, end, .. } => {
                let mut aps = json!({
                    "timestamp": now.timestamp(),
                    "event": if *end { "end" } else { "update" },
                });
                if let Some(state) = state {
                    aps["content-state"] = state.clone();
                }
                if *end {
                    // Gone from the Lock Screen at once, as the app ends it: left there, it would show
                    // an Approve for work that no longer waits.
                    aps["dismissal-date"] = json!(now.timestamp());
                }
                json!({ "aps": aps })
            }
            Self::Start { run, path, state } => json!({
                "aps": {
                    "timestamp": now.timestamp(),
                    "event": "start",
                    "content-state": state,
                    "attributes-type": "WorkActivity",
                    "attributes": { "team": "", "path": path, "runId": run },
                    // Apple starts one only with an alert. Words nobody wrote, and no sound: the
                    // wait's own notice went a read before, and rang if it rings.
                    "alert": { "title": "LoomWatch", "body": "Something needs you" },
                    // A token of its own, which the phone gives here as it does for one it started.
                    "input-push-token": 1,
                },
            }),
            Self::Widgets => json!({ "aps": { "content-changed": true } }),
            Self::Health => json!({ "aps": { "content-available": 1 }, "health": "log" }),
        }
    }

    /// Apple's push type: an activity's own, or one for the app.
    #[must_use]
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Activity { .. } | Self::Start { .. } => "liveactivity",
            Self::Widgets => "widgets",
            Self::Health => "background",
            Self::Notice(_) | Self::Changed { .. } => "alert",
        }
    }

    /// 10 delivers at once; 5 when the phone saves power, and doesn't count against the Live
    /// Activity's budget.
    #[must_use]
    pub fn priority(&self) -> u8 {
        match self {
            // Apple takes a background push only at 5.
            Self::Activity { urgent: false, .. } | Self::Health => 5,
            _ => 10,
        }
    }

    /// Apple keeps only the newest push with the same id for a phone that is offline.
    #[must_use]
    pub fn collapse_id(&self) -> Option<String> {
        match self {
            Self::Notice(notice) => Some(notice.collapse_id()),
            Self::Changed { .. } => Some("changed".to_owned()),
            Self::Widgets => Some("widgets".to_owned()),
            Self::Health => Some("health".to_owned()),
            Self::Activity { .. } | Self::Start { .. } => None,
        }
    }
}

/// How a push went.
#[derive(Debug, PartialEq, Eq)]
pub enum Sent {
    Done,
    /// The token is no good any more: the app was removed, or it is the other kind of build's.
    Gone,
    /// Apple refused the key itself, such as one revoked on the developer site.
    KeyRefused(String),
    Failed(String),
}

/// What sends a push: Apple's service with the person's own key today. A Live Activity's push
/// goes to `to.activity`'s token, a start to `to.start_token`, the widgets' to
/// `to.widget_token`, the rest to the app's.
#[async_trait]
pub trait Sender: Send + Sync {
    async fn send(&self, to: &PushTarget, push: &Push) -> Sent;
}

/// `PUT` or `DELETE` [`ROUTE`] from `device`, a phone the door has let in. The answer says whether
/// this computer can send: `{"sending": true}` once a push key is set here.
pub async fn route(
    devices: &Devices,
    keys: &KeyPlace,
    device: &Device,
    request: Request,
) -> Response {
    if device.kind != Kind::Phone {
        return problem(StatusCode::NOT_FOUND, "Not found.");
    }
    let target = match *request.method() {
        Method::PUT => {
            let Ok(body) = to_bytes(request.into_body(), 8 * 1024).await else {
                return problem(StatusCode::PAYLOAD_TOO_LARGE, "That's too long.");
            };
            match serde_json::from_slice::<PushTarget>(&body) {
                Ok(target) if target.valid() => Some(target),
                _ => {
                    return problem(
                        StatusCode::BAD_REQUEST,
                        "That isn't a push token and settings this computer can use.",
                    );
                }
            }
        }
        Method::DELETE => None,
        _ => return problem(StatusCode::METHOD_NOT_ALLOWED, "Use PUT or DELETE."),
    };
    if !devices.set_push(&device.id, target) {
        return problem(
            StatusCode::NOT_FOUND,
            "This phone isn't connected any more.",
        );
    }
    let sending = matches!(keys.read().await, Ok(Some(_)));
    let mut response = Json(json!({ "sending": sending })).into_response();
    no_store(response.headers_mut());
    response
}

/// Watches what needs the person here, at `home` (such as `http://127.0.0.1:3000`), and pushes
/// what is new to every phone with a token, for as long as `LoomWatch` runs.
pub fn spawn(devices: Arc<Devices>, keys: KeyPlace, home: &str) {
    let daemon = Daemon::at(home);
    tokio::spawn(async move {
        let mut watch = watch::Watch::default();
        let mut sender: Option<Arc<dyn Sender>> = None;
        let mut key_read: Option<Instant> = None;
        loop {
            tokio::time::sleep(EVERY).await;
            let phones = devices.push_targets();
            if phones.is_empty() {
                continue;
            }
            if sender.is_none() && key_read.is_none_or(|read| read.elapsed() >= KEY_AGAIN) {
                key_read = Some(Instant::now());
                sender = match keys.read().await {
                    Ok(Some(key)) => match apns::Apns::new(key) {
                        Ok(apns) => Some(Arc::new(apns)),
                        Err(error) => {
                            eprintln!("warning: the push key can't be used: {error:#}");
                            None
                        }
                    },
                    Ok(None) => None,
                    Err(error) => {
                        eprintln!("warning: couldn't read the push key: {error:#}");
                        None
                    }
                };
            }
            let Some(send) = sender.clone() else {
                continue;
            };
            wake_for_health(&devices, &phones, send.as_ref()).await;
            let (runs, requests) = tokio::join!(
                daemon.get_json("/api/runs?finishedWithin=86400&preview=true"),
                daemon.get_json("/api/team-requests"),
            );
            let Ok(runs) = runs else {
                continue;
            };
            let home = super::phone::home::home_view(&runs, &requests.unwrap_or_default());
            let mut pending = watch.next(&home, &phones, Utc::now()).into_iter();
            while let Some((id, target, push)) = pending.next() {
                match send.send(&target, &push).await {
                    Sent::Done => {
                        // An ended Live Activity takes no more pushes; the phone gives the next one.
                        if let (Push::Activity { end: true, .. }, Some(activity)) =
                            (&push, &target.activity)
                        {
                            devices.forget_activity(&id, &activity.token);
                        }
                    }
                    Sent::Gone => match (&push, &target.activity, &target.start_token) {
                        (Push::Activity { .. }, Some(activity), _) => {
                            devices.forget_activity(&id, &activity.token);
                        }
                        (Push::Start { .. }, _, Some(token)) => {
                            devices.forget_start_token(&id, token);
                        }
                        (Push::Widgets, _, _) => {
                            if let Some(token) = &target.widget_token {
                                devices.forget_widget_token(&id, token);
                            }
                        }
                        _ => devices.forget_push_token(&id, &target.token),
                    },
                    // Tried again on the next read: something waiting for the person must not
                    // be lost to a moment without a network.
                    Sent::Failed(why) => {
                        eprintln!("warning: a push didn't go: {why}");
                        watch.undo(&id, &push);
                    }
                    Sent::KeyRefused(reason) => {
                        eprintln!(
                            "warning: Apple refused the push key ({reason}); it is read again in a minute"
                        );
                        watch.undo(&id, &push);
                        for (id, _, push) in pending.by_ref() {
                            watch.undo(&id, &push);
                        }
                        sender = None;
                    }
                }
            }
        }
    });
}

/// Wakes each phone something waits for in Apple Health (ADR 0123). One that isn't woken, with no
/// token or no network, takes it when it is next opened or refreshes.
async fn wake_for_health(devices: &Devices, phones: &[(String, PushTarget)], send: &dyn Sender) {
    let Some(health) = crate::health::installed() else {
        return;
    };
    for id in health.take_wakes() {
        let Some((_, target)) = phones.iter().find(|(phone, _)| *phone == id) else {
            continue;
        };
        match send.send(target, &Push::Health).await {
            Sent::Gone => devices.forget_push_token(&id, &target.token),
            Sent::Failed(why) | Sent::KeyRefused(why) => {
                eprintln!("warning: couldn't wake the phone for Health: {why}");
            }
            Sent::Done => {}
        }
    }
}

#[cfg(test)]
mod tests;
