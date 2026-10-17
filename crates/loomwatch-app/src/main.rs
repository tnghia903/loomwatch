//! `LoomWatch`'s own app program: what runs when someone opens `LoomWatch` from Applications on a
//! Mac, or from the Start menu on Windows.
//!
//! It starts `loomwatchd` from beside itself, opens `LoomWatch` in the browser, and stays in the
//! menu bar (macOS) or the notification area (Windows) with Open, Start at login and Quit. No
//! Terminal or console window, and nothing to keep open: closing the browser tab leaves `LoomWatch`
//! running until Quit. If `loomwatchd` stops on its own, it is started again.
//!
//! Everything a `loomwatchd` needs comes from its own defaults: the state folder and the database
//! in it, and `~/LoomWatch/teams`, which is made on first start with the offline demo team, as
//! the `loomwatch` launcher makes it.

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
