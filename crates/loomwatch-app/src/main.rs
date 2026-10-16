//! `LoomWatch.app`'s own program: what runs when someone opens `LoomWatch` from Applications.
//!
//! It starts `loomwatchd` from beside itself in the app bundle, opens `LoomWatch` in the browser,
//! and stays in the menu bar with Open, Start at login and Quit. No Terminal window, and nothing
//! to keep open: closing the browser tab leaves `LoomWatch` running until Quit. If `loomwatchd`
//! stops on its own, it is started again.
//!
//! Everything a `loomwatchd` needs comes from its own defaults: the state folder and the database
//! in it, and `~/LoomWatch/teams`, which is made on first start with the offline demo team, as
//! the `./loomwatch` launcher makes it.

#[cfg(target_os = "macos")]
mod mac;

#[cfg(target_os = "macos")]
fn main() -> anyhow::Result<()> {
    mac::run()
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("LoomWatch.app runs on macOS. Elsewhere, start LoomWatch with ./loomwatch.");
    std::process::exit(2);
}
