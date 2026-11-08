//! The Mac's own apps as tools (ADR 0121): Calendar, Reminders, Notes and Contacts.
//!
//! The person connects one in Connections like any other tool and gives it to an agent; each
//! action then asks them first, as every connected tool's does (ADR 0069), and deleting asks every
//! time ([`crate::connected_tools::ToolCall::cant_undo`]). Only the daemon runs an action: it
//! starts `loomwatch-mac-apps` (built from `crates/loomwatch-mac-apps`, beside `loomwatchd`) once
//! for each, outside the command sandbox, with the action's arguments as JSON on its standard
//! input. That program asks macOS for the app's data in `LoomWatch`'s name, so the person allows it
//! once under Privacy & Security, and the agent never runs a command to reach the app.
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde_json::{Value, json};

use crate::agent::BoxFuture;
use crate::connected_tools::ToolCall;

/// The program beside `loomwatchd` that runs the actions.
pub(crate) const PROGRAM: &str = "loomwatch-mac-apps";
/// How long one action may take, macOS's question to the person included.
const WAIT: Duration = Duration::from_secs(200);

/// One of the Mac's apps an agent can be given.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum App {
    Calendar,
    Reminders,
    Notes,
    Contacts,
}

impl App {
    pub(crate) const ALL: [Self; 4] =
        [Self::Calendar, Self::Reminders, Self::Notes, Self::Contacts];

    /// What `tools.json` keeps as its address: never a place on the internet.
    pub(crate) const fn url(self) -> &'static str {
        match self {
            Self::Calendar => "loomwatch:apple-calendar",
            Self::Reminders => "loomwatch:apple-reminders",
            Self::Notes => "loomwatch:apple-notes",
            Self::Contacts => "loomwatch:contacts",
        }
    }

    /// The app at `url`, the address its tool keeps.
    pub(crate) fn at(url: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|app| app.url() == url.trim())
    }

    /// The app as the helper names it.
    const fn word(self) -> &'static str {
        match self {
            Self::Calendar => "calendar",
            Self::Reminders => "reminders",
            Self::Notes => "notes",
            Self::Contacts => "contacts",
        }
    }

    /// Where its icon is drawn from.
    pub(crate) const fn bundle(self) -> &'static str {
        match self {
            Self::Calendar => "/System/Applications/Calendar.app",
            Self::Reminders => "/System/Applications/Reminders.app",
            Self::Notes => "/System/Applications/Notes.app",
            Self::Contacts => "/System/Applications/Contacts.app",
        }
    }

    /// What the icon route calls it: `mac-calendar`.
    pub(crate) fn icon_name(self) -> String {
        format!("mac-{}", self.word())
    }

    /// The app whose icon the route names as `name`.
    pub(crate) fn of_icon(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|app| app.icon_name() == name)
    }

    /// The System Settings pane where the person allows it, opened from Connections.
    pub(crate) const fn settings(self) -> &'static str {
        match self {
            Self::Calendar => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars"
            }
            Self::Reminders => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders"
            }
            Self::Notes => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"
            }
            Self::Contacts => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts"
            }
        }
    }

    /// What macOS kept the person from giving, in words for Connections.
    pub(crate) const fn refused(self) -> &'static str {
        match self {
            Self::Calendar => {
                "macOS hasn't let LoomWatch see your calendars. Allow LoomWatch, with Full Access, in System Settings → Privacy & Security → Calendars."
            }
            Self::Reminders => {
                "macOS hasn't let LoomWatch see your reminders. Allow LoomWatch, with Full Access, in System Settings → Privacy & Security → Reminders."
            }
            Self::Notes => {
                "macOS hasn't let LoomWatch use Notes. Turn on Notes under LoomWatch in System Settings → Privacy & Security → Automation."
            }
            Self::Contacts => {
                "macOS hasn't let LoomWatch see your contacts. Allow LoomWatch in System Settings → Privacy & Security → Contacts."
            }
        }
    }

    /// What it lets an agent do: every action, described for the model.
    pub(crate) fn calls(self) -> Vec<ToolCall> {
        let specs: &[Spec] = match self {
            Self::Calendar => CALENDAR,
            Self::Reminders => REMINDERS,
            Self::Notes => NOTES,
            Self::Contacts => CONTACTS,
        };
        specs
            .iter()
            .map(|spec| ToolCall {
                name: spec.name.to_owned(),
                title: Some(spec.title.to_owned()),
                description: spec.description.to_owned(),
                input_schema: (spec.schema)(),
                read_only: spec.reads_only,
                cant_undo: spec.cant_undo,
            })
            .collect()
    }
}

struct Spec {
    name: &'static str,
    title: &'static str,
    description: &'static str,
    schema: fn() -> Value,
    reads_only: bool,
    cant_undo: bool,
}

const TIME: &str = "A date (2026-11-08) or a time in this Mac's time zone (2026-11-08T14:00), or with its offset (2026-11-08T14:00:00+07:00).";

fn object(properties: Value, required: &[&str]) -> Value {
    let mut schema = serde_json::Map::new();
    schema.insert("type".to_owned(), json!("object"));
    schema.insert("properties".to_owned(), properties);
    schema.insert("required".to_owned(), json!(required));
    Value::Object(schema)
}

fn nothing() -> Value {
    object(json!({}), &[])
}

fn limit() -> Value {
    json!({"type": "integer", "description": "The most to list, up to 200."})
}

const CALENDAR: &[Spec] = &[
    Spec {
        name: "list_calendars",
        title: "List calendars",
        description: "The calendars on this Mac, with whether each can be changed.",
        schema: nothing,
        reads_only: true,
        cant_undo: false,
    },
    Spec {
        name: "find_events",
        title: "Find events",
        description: "Events between two times, soonest first. Repeating events come once for each time they happen. Without `from`, from now; without `to`, the week after `from`. At most 366 days at a time.",
        schema: || {
            object(
                json!({
                    "from": {"type": "string", "description": TIME},
                    "to": {"type": "string", "description": TIME},
                    "calendar": {"type": "string", "description": "Only this calendar, by name."},
                    "text": {"type": "string", "description": "Only events with these words in their title, place or notes."},
                    "limit": limit(),
                }),
                &[],
            )
        },
        reads_only: true,
        cant_undo: false,
    },
    Spec {
        name: "add_event",
        title: "Add event",
        description: "Adds an event. Without `end`, it lasts an hour, or the whole day when `start` is a date.",
        schema: || {
            object(
                json!({
                    "title": {"type": "string"},
                    "start": {"type": "string", "description": TIME},
                    "end": {"type": "string", "description": TIME},
                    "all_day": {"type": "boolean"},
                    "calendar": {"type": "string", "description": "By name; without it, the Mac's default calendar."},
                    "location": {"type": "string"},
                    "notes": {"type": "string"},
                }),
                &["title", "start"],
            )
        },
        reads_only: false,
        cant_undo: false,
    },
    Spec {
        name: "change_event",
        title: "Change event",
        description: "Changes what is given of an event found with find_events. For a repeating event, give `occurrence` (the `start` find_events showed) and `which`.",
        schema: || {
            object(
                json!({
                    "id": {"type": "string"},
                    "occurrence": {"type": "string", "description": "For a repeating event: when the one to change starts."},
                    "which": {"type": "string", "enum": ["this", "future"], "description": "For a repeating event: this one only, or this one and the later ones."},
                    "title": {"type": "string"},
                    "start": {"type": "string", "description": TIME},
                    "end": {"type": "string", "description": TIME},
                    "all_day": {"type": "boolean"},
                    "calendar": {"type": "string"},
                    "location": {"type": "string"},
                    "notes": {"type": "string"},
                }),
                &["id"],
            )
        },
        reads_only: false,
        cant_undo: false,
    },
    Spec {
        name: "delete_event",
        title: "Delete event",
        description: "Deletes an event found with find_events. It can't be undone. For a repeating event, give `occurrence` and `which`.",
        schema: || {
            object(
                json!({
                    "id": {"type": "string"},
                    "occurrence": {"type": "string", "description": "For a repeating event: when the one to delete starts."},
                    "which": {"type": "string", "enum": ["this", "future"]},
                }),
                &["id"],
            )
        },
        reads_only: false,
        cant_undo: true,
    },
];

const REMINDERS: &[Spec] = &[
    Spec {
        name: "list_lists",
        title: "List reminder lists",
        description: "The reminder lists on this Mac.",
        schema: nothing,
        reads_only: true,
        cant_undo: false,
    },
    Spec {
        name: "find_reminders",
        title: "Find reminders",
        description: "Reminders not done yet, or with `done`, ones already done.",
        schema: || {
            object(
                json!({
                    "list": {"type": "string", "description": "Only this list, by name."},
                    "done": {"type": "boolean"},
                    "due_before": {"type": "string", "description": TIME},
                    "text": {"type": "string", "description": "Only reminders with these words in their title or notes."},
                    "limit": limit(),
                }),
                &[],
            )
        },
        reads_only: true,
        cant_undo: false,
    },
    Spec {
        name: "add_reminder",
        title: "Add reminder",
        description: "Adds a reminder. A `due` date with no time is due that day.",
        schema: || {
            object(
                json!({
                    "title": {"type": "string"},
                    "due": {"type": "string", "description": TIME},
                    "list": {"type": "string", "description": "By name; without it, the default list."},
                    "notes": {"type": "string"},
                    "priority": {"type": "integer", "description": "1 high, 5 medium, 9 low, 0 none."},
                }),
                &["title"],
            )
        },
        reads_only: false,
        cant_undo: false,
    },
    Spec {
        name: "change_reminder",
        title: "Change reminder",
        description: "Changes what is given of a reminder found with find_reminders.",
        schema: || {
            object(
                json!({
                    "id": {"type": "string"},
                    "title": {"type": "string"},
                    "due": {"type": "string", "description": TIME},
                    "list": {"type": "string"},
                    "notes": {"type": "string"},
                    "priority": {"type": "integer"},
                }),
                &["id"],
            )
        },
        reads_only: false,
        cant_undo: false,
    },
    Spec {
        name: "complete_reminder",
        title: "Mark reminder done",
        description: "Ticks a reminder off, or with `done: false`, marks it not done again.",
        schema: || {
            object(
                json!({"id": {"type": "string"}, "done": {"type": "boolean"}}),
                &["id"],
            )
        },
        reads_only: false,
        cant_undo: false,
    },
    Spec {
        name: "delete_reminder",
        title: "Delete reminder",
        description: "Deletes a reminder. It can't be undone.",
        schema: || object(json!({"id": {"type": "string"}}), &["id"]),
        reads_only: false,
        cant_undo: true,
    },
];

const NOTES: &[Spec] = &[
    Spec {
        name: "list_folders",
        title: "List folders",
        description: "The folders in Notes, with how many notes each holds.",
        schema: nothing,
        reads_only: true,
        cant_undo: false,
    },
    Spec {
        name: "find_notes",
        title: "Find notes",
        description: "Notes, most recently changed first: all of them, or those with these words, or in one folder. Read one with read_note.",
        schema: || {
            object(
                json!({
                    "text": {"type": "string"},
                    "folder": {"type": "string", "description": "By name."},
                    "limit": limit(),
                }),
                &[],
            )
        },
        reads_only: true,
        cant_undo: false,
    },
    Spec {
        name: "read_note",
        title: "Read note",
        description: "A note's words, up to 20,000 characters.",
        schema: || object(json!({"id": {"type": "string"}}), &["id"]),
        reads_only: true,
        cant_undo: false,
    },
    Spec {
        name: "add_note",
        title: "Add note",
        description: "Adds a note with this title and text. Lines stay lines.",
        schema: || {
            object(
                json!({
                    "title": {"type": "string"},
                    "text": {"type": "string"},
                    "folder": {"type": "string", "description": "By name; without it, the default folder."},
                }),
                &["title"],
            )
        },
        reads_only: false,
        cant_undo: false,
    },
    Spec {
        name: "change_note",
        title: "Change note",
        description: "Adds text to the end of a note, or with `how: replace`, writes its text again (a note's pictures and formatting are then lost).",
        schema: || {
            object(
                json!({
                    "id": {"type": "string"},
                    "text": {"type": "string"},
                    "how": {"type": "string", "enum": ["append", "replace"]},
                    "title": {"type": "string", "description": "With `replace`: a new title."},
                }),
                &["id", "text"],
            )
        },
        reads_only: false,
        cant_undo: false,
    },
    Spec {
        name: "delete_note",
        title: "Delete note",
        description: "Moves a note to Recently Deleted in Notes, where it stays for 30 days.",
        schema: || object(json!({"id": {"type": "string"}}), &["id"]),
        reads_only: false,
        // It stays in Notes' Recently Deleted for 30 days, so it can be undone.
        cant_undo: false,
    },
];

const CONTACTS: &[Spec] = &[
    Spec {
        name: "find_contacts",
        title: "Find contacts",
        description: "Contacts by name, email address or phone number.",
        schema: || {
            object(
                json!({"text": {"type": "string"}, "limit": limit()}),
                &["text"],
            )
        },
        reads_only: true,
        cant_undo: false,
    },
    Spec {
        name: "get_contact",
        title: "Get contact",
        description: "One contact, by the id find_contacts showed.",
        schema: || object(json!({"id": {"type": "string"}}), &["id"]),
        reads_only: true,
        cant_undo: false,
    },
    Spec {
        name: "add_contact",
        title: "Add contact",
        description: "Adds a contact. Give at least a name or an organization.",
        schema: || {
            object(
                json!({
                    "given_name": {"type": "string"},
                    "family_name": {"type": "string"},
                    "nickname": {"type": "string"},
                    "organization": {"type": "string"},
                    "job_title": {"type": "string"},
                    "phones": {"type": "array", "items": {"type": "object", "properties": {"label": {"type": "string", "description": "home, work, mobile, main or other"}, "number": {"type": "string"}}, "required": ["number"]}},
                    "emails": {"type": "array", "items": {"type": "object", "properties": {"label": {"type": "string", "description": "home, work or other"}, "address": {"type": "string"}}, "required": ["address"]}},
                }),
                &[],
            )
        },
        reads_only: false,
        cant_undo: false,
    },
    Spec {
        name: "change_contact",
        title: "Change contact",
        description: "Changes what is given of a contact. `phones` or `emails`, when given, replace all of that contact's.",
        schema: || {
            object(
                json!({
                    "id": {"type": "string"},
                    "given_name": {"type": "string"},
                    "family_name": {"type": "string"},
                    "nickname": {"type": "string"},
                    "organization": {"type": "string"},
                    "job_title": {"type": "string"},
                    "phones": {"type": "array", "items": {"type": "object", "properties": {"label": {"type": "string"}, "number": {"type": "string"}}, "required": ["number"]}},
                    "emails": {"type": "array", "items": {"type": "object", "properties": {"label": {"type": "string"}, "address": {"type": "string"}}, "required": ["address"]}},
                }),
                &["id"],
            )
        },
        reads_only: false,
        cant_undo: false,
    },
    Spec {
        name: "delete_contact",
        title: "Delete contact",
        description: "Deletes a contact. It can't be undone.",
        schema: || object(json!({"id": {"type": "string"}}), &["id"]),
        reads_only: false,
        cant_undo: true,
    },
];

/// What runs the apps' actions: the helper program, or a stand-in in tests.
pub(crate) trait Runner: Send + Sync {
    /// Whether macOS lets `LoomWatch` have `app`, asking the person first if it never has.
    fn access(&self, app: App) -> BoxFuture<'_, Result<bool, String>>;

    /// What `call` with `arguments` found or did, or what went wrong, in words.
    fn call<'a>(
        &'a self,
        app: App,
        call: &'a str,
        arguments: Value,
    ) -> BoxFuture<'a, Result<Value, String>>;
}

/// The runner on a Mac: `loomwatch-mac-apps` beside this program.
pub(crate) struct Helper {
    program: Option<PathBuf>,
}

impl Helper {
    /// `loomwatch-mac-apps` beside this program, or, for trials, the stand-in that
    /// `LOOMWATCH_MAC_APPS_PROGRAM` names (`scripts/mock-mac-apps.py`), which touches no real data.
    pub(crate) fn beside_this_program() -> Self {
        let stand_in = std::env::var_os("LOOMWATCH_MAC_APPS_PROGRAM")
            .filter(|path| !path.is_empty())
            .map(PathBuf::from);
        Self {
            program: stand_in.or_else(|| {
                std::env::current_exe()
                    .ok()
                    .map(|daemon| daemon.with_file_name(PROGRAM))
            }),
        }
    }

    async fn run(&self, words: &[&str], input: Option<&Value>) -> Result<Value, String> {
        if !cfg!(target_os = "macos") {
            return Err("This works only on a Mac.".to_owned());
        }
        let program = self
            .program
            .as_ref()
            .filter(|program| program.is_file())
            .ok_or_else(|| "Part of LoomWatch is missing. Install LoomWatch again.".to_owned())?;
        let mut command = tokio::process::Command::new(program);
        command
            .args(words)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .map_err(|error| format!("LoomWatch couldn't start {PROGRAM}: {error}"))?;
        if let Some(mut stdin) = child.stdin.take() {
            use tokio::io::AsyncWriteExt as _;
            let text = input.map_or_else(|| "{}".to_owned(), Value::to_string);
            stdin
                .write_all(text.as_bytes())
                .await
                .map_err(|error| format!("{PROGRAM} couldn't be given the action: {error}"))?;
        }
        let output = tokio::time::timeout(WAIT, child.wait_with_output())
            .await
            .map_err(|_| "The app didn't answer in time. Try again.".to_owned())?
            .map_err(|error| format!("{PROGRAM}'s answer couldn't be read: {error}"))?;
        let printed = String::from_utf8_lossy(&output.stdout);
        serde_json::from_str::<Value>(printed.trim()).map_err(|_| {
            format!(
                "{PROGRAM} stopped without an answer: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )
        })
    }
}

impl Runner for Helper {
    fn access(&self, app: App) -> BoxFuture<'_, Result<bool, String>> {
        Box::pin(async move {
            let printed = self.run(&["access", app.word()], None).await?;
            match printed.get("access").and_then(Value::as_str) {
                Some("granted") => Ok(true),
                Some(_) => Ok(false),
                None => Err(said(&printed)),
            }
        })
    }

    fn call<'a>(
        &'a self,
        app: App,
        call: &'a str,
        arguments: Value,
    ) -> BoxFuture<'a, Result<Value, String>> {
        Box::pin(async move {
            let printed = self
                .run(&["call", app.word(), call], Some(&arguments))
                .await?;
            printed.get("ok").cloned().ok_or_else(|| said(&printed))
        })
    }
}

fn said(printed: &Value) -> String {
    printed
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("The app didn't say what went wrong.")
        .to_owned()
}

/// A stand-in for tests: it answers every action with what it was asked, and keeps a list.
#[derive(Default)]
pub(crate) struct Fake {
    pub(crate) refuses: std::sync::atomic::AtomicBool,
    pub(crate) called: Mutex<Vec<(App, String, Value)>>,
}

impl Runner for Arc<Fake> {
    fn access(&self, _app: App) -> BoxFuture<'_, Result<bool, String>> {
        let granted = !self.refuses.load(std::sync::atomic::Ordering::SeqCst);
        Box::pin(async move { Ok(granted) })
    }

    fn call<'a>(
        &'a self,
        app: App,
        call: &'a str,
        arguments: Value,
    ) -> BoxFuture<'a, Result<Value, String>> {
        Box::pin(async move {
            self.called
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push((app, call.to_owned(), arguments.clone()));
            Ok(json!({"did": call, "with": arguments}))
        })
    }
}

/// An action's answer as the agent reads it, and whether it failed.
pub(crate) fn for_the_agent(answer: Result<Value, String>) -> (String, bool) {
    match answer {
        Ok(found) => (found.to_string(), false),
        Err(said) => (said, true),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_app_has_an_address_of_its_own_and_actions_that_read_well() {
        for app in App::ALL {
            assert_eq!(App::at(app.url()), Some(app));
            assert_eq!(App::of_icon(&app.icon_name()), Some(app));
            let calls = app.calls();
            assert!(calls.len() >= 4, "{app:?}");
            for call in &calls {
                assert_eq!(call.input_schema["type"], "object", "{}", call.name);
                assert!(!call.description.is_empty(), "{}", call.name);
                // Only deleting can't be undone, except a note, which Notes keeps for 30 days.
                assert_eq!(
                    call.cant_undo,
                    call.name.starts_with("delete_") && app != App::Notes,
                    "{}",
                    call.name
                );
                assert!(!(call.read_only && call.cant_undo), "{}", call.name);
            }
            assert!(
                calls.iter().any(|call| call.name.starts_with("delete_")),
                "{app:?}"
            );
            assert!(calls.iter().any(|call| call.read_only), "{app:?}");
        }
        assert_eq!(App::at("https://mcp.linear.app/mcp"), None);
    }

    /// Under the hardened runtime, macOS refuses Calendar, Reminders and Contacts to a program
    /// whose signature doesn't ask for them, before it can ask the person; and it asks only when
    /// the app says why. The package signs the helper with these.
    #[test]
    fn the_app_ships_the_helper_signed_for_the_data_macos_guards() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let read = |path: &str| std::fs::read_to_string(root.join(path)).unwrap();
        // macOS checks the app it counts as asking, LoomWatch.app, not only the helper: on
        // 2026-11-08 v0.40.0 had them on the helper alone, and tccd refused Calendar without
        // asking ("requires entitlement … but it is missing for responsible=…LoomWatch").
        for file in [
            "packaging/macos/LoomWatch-app.entitlements",
            "packaging/macos/LoomWatch-mac-apps.entitlements",
        ] {
            let entitlements = read(file);
            for key in [
                "com.apple.security.personal-information.calendars",
                "com.apple.security.personal-information.addressbook",
            ] {
                assert!(
                    entitlements.contains(&format!("<key>{key}</key>")),
                    "{file}: {key}"
                );
            }
        }
        let package = read("scripts/package-macos-app.sh");
        assert!(package.contains("--entitlements \"$app_entitlements\""));
        let info = read("packaging/macos/Info.plist");
        for key in [
            "NSCalendarsFullAccessUsageDescription",
            "NSRemindersFullAccessUsageDescription",
            "NSContactsUsageDescription",
            "NSAppleEventsUsageDescription",
        ] {
            assert!(info.contains(&format!("<key>{key}</key>")), "{key}");
        }
        let package = read("scripts/package-macos-app.sh");
        assert!(package.contains("LoomWatch-mac-apps.entitlements"));
        assert!(package.contains(&format!("Contents/MacOS/{PROGRAM}")));
    }
}
