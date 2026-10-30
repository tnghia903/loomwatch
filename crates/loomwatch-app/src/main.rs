//! `LoomWatch`'s own app program: what runs when someone opens `LoomWatch` from Applications on a
//! Mac, or from the Start menu on Windows.
//!
//! It starts `loomwatchd` from beside itself, opens `LoomWatch` in the browser, and stays in the
//! menu bar (macOS) or the notification area (Windows) with Open, Start at login and Quit. No
//! Terminal or console window, and nothing to keep open: closing the browser tab leaves `LoomWatch`
//! running until Quit. If `loomwatchd` stops on its own, it is started again.
//!
//! Everything a `loomwatchd` needs comes from its own defaults: the state folder and the database
//! in it, and `~/LoomWatch/teams`, which is made empty on first start, as the `loomwatch`
//! launcher makes it.

// A Windows program with no console window of its own.
#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(target_os = "macos")]
mod mac;
#[cfg(windows)]
mod windows;
// What the menu says about the teams' work. Built and tested everywhere, used by the Mac menu,
// and without the face's moods by the Windows one.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod progress;
// The island at the notch (ADR 0083): where it goes and what passes between the panel and its
// page, tested everywhere; and the panel itself, on a Mac.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod island;
#[cfg(target_os = "macos")]
mod notch_panel;
// The editing keys of the box at the notch, in a main menu nobody sees.
#[cfg(target_os = "macos")]
mod edit_keys;
// Update and restart: the app downloading the next release and putting it in its own place.
mod update;

/// The exit status `loomwatchd` asks to be started again the other way with (ADR 0102): connected
/// to `LoomWatch` on another computer, or running this computer's own
/// (`devices::connected::EXIT_TO_SWITCH`).
#[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
const EXIT_TO_SWITCH: i32 = 76;

/// In `loomwatchd`'s state folder while this computer shows `LoomWatch` on another one
/// (`devices::connected::FILE`): then the app starts `loomwatchd connect`, not `serve`.
#[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
const CONNECTED_FILE: &str = "connected.json";

#[cfg(target_os = "macos")]
fn main() -> anyhow::Result<()> {
    mac::run()
}

#[cfg(windows)]
fn main() -> anyhow::Result<()> {
    windows::run()
}

#[cfg(not(any(target_os = "macos", windows)))]
fn main() {
    eprintln!(
        "The LoomWatch app runs on macOS and Windows. Elsewhere, start LoomWatch with ./loomwatch."
    );
    std::process::exit(2);
}
