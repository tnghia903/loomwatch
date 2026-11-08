//! `LoomWatch`'s helper for agents' actions in the Mac's own apps (ADR 0121).
//!
//! loomwatchd runs it once for each action an agent was allowed to take:
//!
//! ```text
//! loomwatch-mac-apps access <app>          asks macOS for the app's data, if it hasn't yet
//! loomwatch-mac-apps call <app> <action>   the action, with its arguments as JSON on stdin
//! ```
//!
//! `<app>` is `calendar`, `reminders`, `contacts` or `notes`. It prints one JSON object:
//! `{"ok": …}` with what the action found or did, `{"error": "…"}` in words a person can act on,
//! or, for `access`, `{"access": "granted" | "refused"}`.
//!
//! Calendar and Reminders go through `EventKit` and Contacts through the Contacts framework, so
//! macOS asks the person once, in `LoomWatch`'s name, under Privacy & Security. Notes has no
//! framework, so its actions are fixed scripts run by `/usr/bin/osascript`; their arguments reach
//! the script only as data (`run(argv)`), never as script text.
//!
//! It is its own program so that the `unsafe` calls into macOS stay out of loomwatchd, and so that
//! one action that crashes or hangs ends only itself.

// Only the Mac's own modules read most of these; elsewhere the program just says it works only on
// a Mac.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod args;
#[cfg(target_os = "macos")]
mod calendar;
#[cfg(target_os = "macos")]
mod contacts;
mod notes;
#[cfg(target_os = "macos")]
mod store;

use std::io::Read as _;
use std::process::ExitCode;

use serde_json::{Value, json};

fn main() -> ExitCode {
    let words: Vec<String> = std::env::args().skip(1).collect();
    let answer = match words.iter().map(String::as_str).collect::<Vec<_>>()[..] {
        ["access", app] => access(app),
        ["call", app, action] => {
            let mut input = String::new();
            let read = std::io::stdin().read_to_string(&mut input);
            let arguments = match read {
                Ok(_) if input.trim().is_empty() => Ok(json!({})),
                Ok(_) => serde_json::from_str::<Value>(&input)
                    .map_err(|_| "The action's arguments aren't JSON.".to_owned()),
                Err(error) => Err(format!("The action's arguments couldn't be read: {error}")),
            };
            match arguments.and_then(|arguments| call(app, action, &arguments)) {
                Ok(found) => json!({ "ok": found }),
                Err(said) => json!({ "error": said }),
            }
        }
        _ => {
            eprintln!(
                "usage: loomwatch-mac-apps access <app> | loomwatch-mac-apps call <app> <action>"
            );
            return ExitCode::from(2);
        }
    };
    println!("{answer}");
    ExitCode::SUCCESS
}

fn access(app: &str) -> Value {
    let granted = match app {
        "notes" => notes::access(),
        #[cfg(target_os = "macos")]
        "calendar" => Ok(store::access(store::Kind::Events)),
        #[cfg(target_os = "macos")]
        "reminders" => Ok(store::access(store::Kind::Reminders)),
        #[cfg(target_os = "macos")]
        "contacts" => Ok(contacts::access()),
        _ => Err(unknown_app(app)),
    };
    match granted {
        Ok(true) => json!({ "access": "granted" }),
        Ok(false) => json!({ "access": "refused" }),
        Err(said) => json!({ "error": said }),
    }
}

fn call(app: &str, action: &str, arguments: &Value) -> Result<Value, String> {
    let arguments = args::Args(arguments);
    match app {
        "notes" => notes::call(action, &arguments),
        #[cfg(target_os = "macos")]
        "calendar" => calendar::events(action, &arguments),
        #[cfg(target_os = "macos")]
        "reminders" => calendar::reminders(action, &arguments),
        #[cfg(target_os = "macos")]
        "contacts" => contacts::call(action, &arguments),
        _ => Err(unknown_app(app)),
    }
}

fn unknown_app(app: &str) -> String {
    if cfg!(target_os = "macos") {
        format!("There's no app called {app} here.")
    } else {
        "This works only on a Mac.".to_owned()
    }
}
