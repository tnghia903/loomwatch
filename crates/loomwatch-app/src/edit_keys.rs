//! The Edit menu every Mac app has, which nobody sees in `LoomWatch`: a menu-bar app has no menu
//! bar of its own. `AppKit` finds what ⌘V, ⌘C, ⌘X, ⌘A and ⌘Z do in the app's main menu, so
//! without one they do nothing in the box at the notch (`crate::notch_panel`).
//!
//! Only editing: while the box has the keyboard, the app in front still looks as if it had it, and
//! ⌘Q, ⌘W or ⌘H meant for that app must not quit, close or hide `LoomWatch`.

use tray_icon::menu::{Menu, PredefinedMenuItem, Result, Submenu};

/// Make the app's main menu: its own, empty, and Edit. The menu takes its items with it when it
/// goes, so keep it while the app runs.
pub fn install() -> Result<Menu> {
    let edit = Submenu::with_items(
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(None),
            &PredefinedMenuItem::redo(None),
            &PredefinedMenuItem::separator(),
            &PredefinedMenuItem::cut(None),
            &PredefinedMenuItem::copy(None),
            &PredefinedMenuItem::paste(None),
            &PredefinedMenuItem::paste_and_match_style(None),
            &PredefinedMenuItem::select_all(None),
        ],
    )?;
    // `AppKit` takes the first menu for the app's own, whatever it holds.
    let menu = Menu::with_items(&[&Submenu::new("LoomWatch", true), &edit])?;
    menu.init_for_nsapp();
    Ok(menu)
}
