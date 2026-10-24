//! The island at the notch (ADR 0083): where it goes, and what passes between the Mac app's
//! see-through panels and the page drawn in each.
//!
//! Every screen has a panel of its own, hanging from the middle of its top. At a notch it holds the
//! island: the teams at rest beside the camera, and their news popping out (decision 1). Without a
//! notch nothing is drawn there, and the menu bar face is in the menu bar instead; the panel only
//! holds the box to message an agent, while it is called (decision 11). The panel on the screen the
//! pointer is on is the live one: the box opens there, and what its agent does drops out there.
//! The page (`ui/island.html`, served by `loomwatchd`) draws all of it, decides when it pops out
//! and tucks away, and answers a permission with the same calls the browser makes. The app only
//! places the panels, lets clicks through everywhere but what the page draws, and tells each page
//! whether it is live, whether it shows the teams' news, where the pointer is, whether the person
//! is away, and whether an app is full screen. A panel never takes the keyboard, except while a
//! message to an agent is written (decision 9), and then only because its page asked. Kept apart
//! from `AppKit` so it is the same, and tested, everywhere.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// The panel's size in points. The island and whatever drops out of it fit inside, an agent's
/// workbench under its box included; everything else in the panel lets clicks through to the app
/// underneath.
pub const PANEL_WIDTH: f64 = 560.0;
pub const PANEL_HEIGHT: f64 = 640.0;
/// No mouse or key for this long and the person is away: a question that drops while they are
/// waits for them instead of tucking away unseen.
pub const AWAY_AFTER_SECONDS: f64 = 60.0;

/// A rectangle in points. On a screen, the origin is the bottom-left corner of the main screen and
/// `y` grows upwards, as `AppKit` has it; in the panel, as the page sees it, the origin is the
/// panel's top-left corner and `y` grows downwards.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub const fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    pub fn max_x(&self) -> f64 {
        self.x + self.width
    }

    pub fn max_y(&self) -> f64 {
        self.y + self.height
    }

    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.max_x() && y >= self.y && y < self.max_y()
    }

    /// Whether the pointer at (`x`, `y`) on screen is on this screen. macOS puts a pointer pushed
    /// up to the very top of a screen at its top edge, and none at its bottom edge, which is the
    /// top of the screen below (`NSMouseInRect`): so the top edge is in and the bottom edge out,
    /// and a pointer in a `MacBook`'s notch is on the `MacBook`.
    pub fn holds_pointer(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.max_x() && y > self.y && y <= self.max_y()
    }
}

/// The camera housing at the top of a screen, in screen points.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Notch {
    pub min_x: f64,
    pub max_x: f64,
    pub height: f64,
}

impl Notch {
    pub fn width(&self) -> f64 {
        self.max_x - self.min_x
    }

    fn mid_x(&self) -> f64 {
        f64::midpoint(self.min_x, self.max_x)
    }
}

/// What the app knows of one screen.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Screen {
    pub frame: Rect,
    /// The height of its menu bar, from the top of the screen to the top of its visible area.
    pub menu_bar: f64,
    pub notch: Option<Notch>,
}

/// A screen's notch from what `NSScreen` reports: the top of its safe area, and the two pieces of
/// menu bar either side of the camera. A screen without a notch has no safe area at the top, and
/// reports empty pieces. Its height is the menu bar's beside it, which can be a little taller than
/// the camera housing: the island fills the menu bar either side of the notch.
pub fn notch_from(safe_top: f64, left: Rect, right: Rect) -> Option<Notch> {
    let notch = Notch {
        min_x: left.max_x(),
        max_x: right.x,
        height: safe_top.max(left.height),
    };
    (safe_top > 0.0 && left.width > 0.0 && right.width > 0.0 && notch.width() > 0.0)
        .then_some(notch)
}

/// The menu bar face is in the menu bar wherever a screen has no notch to hold the island, so the
/// teams' work and the app's menu are on every screen: a monitor beside a `MacBook`, an iMac, a Mac
/// mini, a `MacBook` with its lid closed. On a `MacBook` alone the island takes its place.
pub fn menu_bar_face_shows(screens: &[Screen]) -> bool {
    screens.is_empty() || screens.iter().any(|screen| screen.notch.is_none())
}

/// Which screen's panel is live, where the box opens and its agent's work drops out: the one on the
/// screen the pointer is on, its top edge and notch included; with the pointer on none of them,
/// the one that `was`, or else the main screen's (`screens[0]`, the one with the menu bar in
/// Displays settings).
pub fn live_screen(screens: &[Screen], pointer: (f64, f64), was: Option<usize>) -> Option<usize> {
    screens
        .iter()
        .position(|screen| screen.frame.holds_pointer(pointer.0, pointer.1))
        .or_else(|| was.filter(|was| *was < screens.len()))
        .or_else(|| (!screens.is_empty()).then_some(0))
}

/// Which screen's island pops the teams' news out (a question, a result, a stop): the live one if
/// it has a notch; else the notched one that `was`, so the news stays at the notch while the
/// pointer is on a monitor beside it; else the first with a notch. None on a Mac without a notch,
/// where the menu bar face has the news.
pub fn news_screen(screens: &[Screen], live: Option<usize>, was: Option<usize>) -> Option<usize> {
    let notched = |index: &usize| {
        screens
            .get(*index)
            .is_some_and(|screen| screen.notch.is_some())
    };
    live.filter(notched)
        .or_else(|| was.filter(notched))
        .or_else(|| screens.iter().position(|screen| screen.notch.is_some()))
}

/// How far from the middle of the top of a screen, and how far down, something dragged is near
/// enough to the island for it to open and take it.
pub const DROP_REACH: Size = Size {
    width: 260.0,
    height: 180.0,
};

/// Whether something dragged to (`x`, `y`) on screen is near enough to the island on `screen` to
/// drop into it.
pub fn near_island(screen: &Screen, x: f64, y: f64) -> bool {
    let mid_x = screen.notch.map_or_else(
        || screen.frame.x + screen.frame.width / 2.0,
        |notch| notch.mid_x(),
    );
    screen.frame.holds_pointer(x, y)
        && (x - mid_x).abs() <= DROP_REACH.width
        && screen.frame.max_y() - y <= DROP_REACH.height
}

/// The shortcut that opens the box to write to an agent, from any app: ⌃⌥Space. As
/// `RegisterEventHotKey` takes it: the Space key's code, and Carbon's control and option bits.
/// The app's pages write it as `PINNED_SHORTCUT` (ui/src/island/bridge.ts).
pub const SHORTCUT_KEY: u32 = 49;
pub const SHORTCUT_MODIFIERS: u32 = 0x1000 | 0x0800;

/// The panel's frame on `screen`: hanging from its top edge, centred on the notch, or on the
/// screen without one, where the box hangs from the middle of the menu bar.
pub fn panel_frame(screen: &Screen) -> Rect {
    let mid_x = screen.notch.map_or_else(
        || screen.frame.x + screen.frame.width / 2.0,
        |notch| notch.mid_x(),
    );
    Rect::new(
        mid_x - PANEL_WIDTH / 2.0,
        screen.frame.max_y() - PANEL_HEIGHT,
        PANEL_WIDTH,
        PANEL_HEIGHT,
    )
}

/// A point on screen, in the panel's own terms: from its top-left corner, `y` downwards.
pub fn in_panel(panel: Rect, screen_x: f64, screen_y: f64) -> (f64, f64) {
    (screen_x - panel.x, panel.max_y() - screen_y)
}

/// Which of the island's areas the pointer at (`x`, `y`) in the panel is on: the island itself
/// first, then whatever dropped out of it, in the order the page reported them. Only there does the
/// panel take the mouse; everywhere else clicks go through.
pub fn area_under(areas: &[Rect], x: f64, y: f64) -> Option<usize> {
    areas.iter().position(|area| area.contains(x, y))
}

/// Whether someone who last touched the mouse or keyboard `idle_seconds` ago is away.
pub fn away(idle_seconds: f64) -> bool {
    idle_seconds >= AWAY_AFTER_SECONDS
}

/// The pasteboard type of an item whose app promises a file the new way (`NSFilePromiseProvider`).
const PROMISED_NEW_WAY: &str = "com.apple.NSFilePromiseItemMetaData";

/// Which of a drag's file promises to ask for their files, by their place among the `receivers`
/// `AppKit` read from it, one for each item that holds a promise (`items`: each item's types, and
/// `readable` the types a promise is read from). An app may promise its files both the old way and
/// the new, and fill only the new: Mail does, and its old way's files come empty or not at all.
/// Then only the new way's are asked. A drag that promises one way only is asked all of them, and
/// so is one whose items and receivers can't be matched.
pub fn promises_to_ask(items: &[Vec<String>], readable: &[String], receivers: usize) -> Vec<usize> {
    let new_way: Vec<bool> = items
        .iter()
        .filter(|types| types.iter().any(|kind| readable.contains(kind)))
        .map(|types| types.iter().any(|kind| kind == PROMISED_NEW_WAY))
        .collect();
    let both = new_way.contains(&true) && new_way.contains(&false);
    if !both || new_way.len() != receivers {
        return (0..receivers).collect();
    }
    (0..receivers).filter(|&at| new_way[at]).collect()
}

/// The files a drop's promises handed over, each once, by their place in `paths`: a promise may
/// name a file that never arrived, or one another promise named too. Of the files there, the
/// largest of each name.
pub fn received_once(paths: &[PathBuf]) -> Vec<usize> {
    let mut kept: Vec<(usize, u64)> = Vec::new();
    for (index, path) in paths.iter().enumerate() {
        let Ok(bytes) = std::fs::metadata(path).map(|file| file.len()) else {
            continue;
        };
        match kept
            .iter_mut()
            .find(|(other, _)| paths[*other].file_name() == path.file_name())
        {
            Some(same) if bytes > same.1 => *same = (index, bytes),
            Some(_) => {}
            None => kept.push((index, bytes)),
        }
    }
    kept.into_iter().map(|(index, _)| index).collect()
}

/// A page whose process ended loads again at once this many times a minute; past that, after
/// `SLOW_RELOAD`, so a page that keeps ending never keeps the Mac busy, and never stays gone.
pub const QUICK_RELOADS: usize = 3;
pub const SLOW_RELOAD: Duration = Duration::from_secs(30);
const RELOADS_WITHIN: Duration = Duration::from_secs(60);

/// When one screen's page loads again after its process ended. `WebKit` ends a page's process
/// when it crashes or breaks `WebKit`'s rules, and by itself loads it again only once.
#[derive(Debug, Default)]
pub struct Reloads {
    ended: Vec<Instant>,
}

impl Reloads {
    /// The page's process ended at `now`: how long to wait before loading it again.
    pub fn ended(&mut self, now: Instant) -> Duration {
        self.ended
            .retain(|at| now.saturating_duration_since(*at) < RELOADS_WITHIN);
        self.ended.push(now);
        if self.ended.len() <= QUICK_RELOADS {
            Duration::ZERO
        } else {
            SLOW_RELOAD
        }
    }
}

/// The file in `LoomWatch`'s state folder that says the island is off: Show at the notch,
/// unticked in the app's menu. Without it the island is at the notch, as it is the first time.
/// `loomwatchd` reads it too, so pinning an agent says how to reach it (its twin is
/// `NOTCH_OFF_FILE` in `crates/loomwatch-backend/src/pinned.rs`).
const OFF_FILE: &str = "app-notch-off";

/// Whether the island is at the notch, with `state` the state folder.
pub fn shown(state: &Path) -> bool {
    !state.join(OFF_FILE).exists()
}

/// Show the island at the notch from now on, or don't.
pub fn set_shown(state: &Path, shown: bool) -> std::io::Result<()> {
    let off = state.join(OFF_FILE);
    if shown {
        match std::fs::remove_file(&off) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            done => done,
        }
    } else {
        std::fs::create_dir_all(state)?;
        std::fs::write(off, b"")
    }
}

/// What the page sends the app.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FromPage {
    /// The page has loaded and listens.
    Ready,
    /// Where the island and what dropped out of it are now, in the panel's terms.
    Areas { rects: Vec<Rect> },
    /// Open `link`, an address inside `LoomWatch` such as `/?path=…&run=…`, in the browser.
    Open { link: String },
    /// A right-click on the island at (`x`, `y`) in the panel: the app's menu.
    Menu { x: f64, y: f64 },
    /// A message to an agent is being written: the panel takes the keyboard; or it is sent, put
    /// away or left, and the keyboard goes back to whatever had it.
    Keyboard { on: bool },
    /// The agent the box opens with, by name, or none when there is no agent to message.
    Agent { name: Option<String> },
    /// Put an answer on the clipboard, Copy on it: `text` for apps that take plain text, and
    /// `html`, when there is one, formatted for apps that take it.
    Copy {
        text: String,
        #[serde(default)]
        html: Option<String>,
    },
    /// Results looked at on this screen's island, by run: they leave every island.
    Seen { runs: Vec<String> },
}

impl FromPage {
    /// The page's message, or `None` for one this app does not know.
    pub fn parse(body: &str) -> Option<Self> {
        serde_json::from_str(body).ok()
    }
}

/// An address inside `LoomWatch` that the page may have opened in the browser, at `origin`
/// (`http://127.0.0.1:3000`). Anything else, another site or a scheme, is refused.
pub fn app_address(origin: &str, link: &str) -> Option<String> {
    (link.starts_with('/') && !link.starts_with("//") && !link.contains('\\'))
        .then(|| format!("{origin}{link}"))
}

/// What the app tells the page.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ToPage {
    /// Where the panel is. `notch` is the camera housing's size, centred at the top of the panel;
    /// without one the island drops from the middle of a menu bar `menuBar` points tall.
    #[serde(rename_all = "camelCase")]
    Place { notch: Option<Size>, menu_bar: f64 },
    /// The pointer moved onto one of the island's areas (`area`, as `area_under` numbers them),
    /// or off them all. The page can't tell by itself: `WebKit` follows the pointer only in a key
    /// window, and the island's panel never becomes one.
    Pointer { over: bool, area: Option<usize> },
    /// The person went away from the Mac, or came back.
    Away { away: bool },
    /// An app is full screen, or no longer is.
    FullScreen { on: bool },
    /// A click somewhere other than the island.
    ClickOutside,
    /// ⌃⌥Space was pressed, or Message in the app's menu: open the box to write to an agent, or put
    /// it away. The panel has the keyboard already when it opens.
    Compose,
    /// Something is being dragged near the island, so it opens to take it; or no longer is.
    Drag { near: bool },
    /// This panel is the live one, on the screen the pointer is on: the box opens here, and its
    /// agent's work and answer drop out here; or it is no longer, and stays at rest.
    Live { on: bool },
    /// This island pops the teams' news out (`news_screen`); or it no longer does, and only tucks
    /// it beside the notch. A panel without a notch is never told to.
    News { on: bool },
    /// Results looked at on another screen's island: they leave this one too.
    Seen { runs: Vec<String> },
    /// Files dropped on the island that the app took itself: files another app writes only once
    /// they are dropped, as Mail does with a message. The page asks for them through a file
    /// picker, which the app answers with them, so they arrive as a file from Finder does.
    Dropped,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

impl ToPage {
    /// The script that hands this message to the page, if it has loaded.
    pub fn script(&self) -> String {
        let message = serde_json::to_string(self).unwrap_or_else(|_| "null".to_owned());
        format!("window.loomwatchIsland && window.loomwatchIsland.receive({message})")
    }

    /// The panel's place on `screen`.
    pub fn place(screen: &Screen) -> Self {
        Self::Place {
            notch: screen.notch.map(|notch| Size {
                width: notch.width(),
                height: notch.height,
            }),
            menu_bar: screen.menu_bar,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A 14-inch MacBook Pro at its default size: 1512 by 982 points, a 32-point notch from 662 to
    // 850, and a 1920 by 1080 screen above it.
    const BUILT_IN: Rect = Rect::new(0.0, 0.0, 1512.0, 982.0);
    const ABOVE: Rect = Rect::new(-204.0, 982.0, 1920.0, 1080.0);

    fn macbook() -> Screen {
        Screen {
            frame: BUILT_IN,
            menu_bar: 32.0,
            notch: notch_from(
                32.0,
                Rect::new(0.0, 950.0, 662.0, 32.0),
                Rect::new(850.0, 950.0, 662.0, 32.0),
            ),
        }
    }

    fn external(frame: Rect) -> Screen {
        Screen {
            frame,
            menu_bar: 24.0,
            notch: notch_from(
                0.0,
                Rect::new(0.0, 0.0, 0.0, 0.0),
                Rect::new(0.0, 0.0, 0.0, 0.0),
            ),
        }
    }

    #[test]
    fn a_notch_is_the_gap_between_the_two_pieces_of_menu_bar() {
        let notch = macbook().notch.expect("a MacBook has a notch");
        assert!((notch.min_x - 662.0).abs() < f64::EPSILON);
        assert!((notch.width() - 188.0).abs() < f64::EPSILON);
        assert!((notch.height - 32.0).abs() < f64::EPSILON);
        assert_eq!(external(ABOVE).notch, None);
        // A menu bar taller than the camera housing: the island is as tall as the menu bar.
        let taller = notch_from(
            32.0,
            Rect::new(0.0, 945.0, 662.0, 37.0),
            Rect::new(850.0, 945.0, 662.0, 37.0),
        );
        assert!((taller.expect("a notch").height - 37.0).abs() < f64::EPSILON);
    }

    #[test]
    fn the_face_is_in_the_menu_bar_wherever_a_screen_has_no_notch() {
        // A MacBook alone: the island takes its place.
        assert!(!menu_bar_face_shows(&[macbook()]));
        // A monitor beside it, an iMac, a MacBook with its lid closed.
        assert!(menu_bar_face_shows(&[external(ABOVE), macbook()]));
        assert!(menu_bar_face_shows(&[external(ABOVE)]));
        assert!(menu_bar_face_shows(&[]));
    }

    #[test]
    fn the_news_stays_at_the_notch_wherever_the_pointer_is() {
        let both = [external(ABOVE), macbook()];
        // The pointer on the MacBook: its island, which is live too.
        assert_eq!(news_screen(&both, Some(1), None), Some(1));
        // On the monitor above, which has no notch: still the MacBook's, from the start too.
        assert_eq!(news_screen(&both, Some(0), Some(1)), Some(1));
        assert_eq!(news_screen(&both, Some(0), None), Some(1));
        // A screen that is gone is no answer.
        assert_eq!(news_screen(&both, Some(7), Some(9)), Some(1));
        // No notch anywhere: the menu bar face has the news.
        assert_eq!(news_screen(&[external(ABOVE)], Some(0), Some(0)), None);
        assert_eq!(news_screen(&[], None, None), None);
        // Two screens with a notch: the one the pointer is on, else the one that had it.
        let mut above = macbook();
        above.frame = ABOVE;
        let two = [above, macbook()];
        assert_eq!(news_screen(&two, Some(0), Some(1)), Some(0));
        assert_eq!(news_screen(&two, None, Some(1)), Some(1));
    }

    #[test]
    fn the_live_island_is_on_the_screen_the_pointer_is_on_notch_or_not() {
        // The screen above is the main one: Displays settings put the menu bar on it.
        let both = [external(ABOVE), macbook()];
        // The pointer on the MacBook: its island is live.
        assert_eq!(live_screen(&both, (700.0, 500.0), None), Some(1));
        // On the screen above it, which has no notch: that screen's island.
        assert_eq!(live_screen(&both, (700.0, 1500.0), Some(1)), Some(0));
        // Nowhere a screen is: the island that was live stays so, or else the main screen's.
        assert_eq!(live_screen(&both, (-900.0, -900.0), Some(1)), Some(1));
        assert_eq!(live_screen(&both, (-900.0, -900.0), None), Some(0));
        assert_eq!(live_screen(&both, (-900.0, -900.0), Some(5)), Some(0));
        assert_eq!(live_screen(&[], (0.0, 0.0), None), None);
    }

    #[test]
    fn a_pointer_pushed_up_into_the_notch_stays_on_the_macbook() {
        // macOS puts a pointer at the very top of a screen at its top edge: 982 on the MacBook.
        // Each time it comes from the other screen, whose island was live.
        let top = (756.0, 982.0);
        // A main screen above the MacBook starts where the MacBook ends.
        let above = [external(ABOVE), macbook()];
        assert_eq!(live_screen(&above, top, Some(0)), Some(1));
        // The first point up is on the screen above.
        assert_eq!(live_screen(&above, (756.0, 982.5), Some(1)), Some(0));
        // A main screen beside the MacBook, its top level with the MacBook's: no screen above the
        // notch at all.
        let beside = [
            external(Rect::new(1512.0, -98.0, 1920.0, 1080.0)),
            macbook(),
        ];
        assert_eq!(live_screen(&beside, top, Some(0)), Some(1));
        assert_eq!(live_screen(&beside, (2000.0, 982.0), Some(1)), Some(0));
        // The very bottom of the MacBook is the top of nothing: still the MacBook.
        assert_eq!(live_screen(&beside, (756.0, 0.5), Some(0)), Some(1));
    }

    #[test]
    fn something_dragged_near_the_top_middle_of_the_screen_is_near_the_island() {
        let mac = macbook();
        // Just under the notch, and a little to one side; and right up at the top edge.
        assert!(near_island(&mac, 756.0, 960.0));
        assert!(near_island(&mac, 756.0 + 250.0, 820.0));
        assert!(near_island(&mac, 756.0, 982.0));
        // Too far down, too far aside, or on another screen.
        assert!(!near_island(&mac, 756.0, 700.0));
        assert!(!near_island(&mac, 200.0, 960.0));
        assert!(!near_island(&mac, 756.0, 1500.0));
        // A screen without a notch: around the middle of its top.
        let above = external(ABOVE);
        assert!(near_island(&above, 756.0, 2040.0));
        assert!(!near_island(&above, 1600.0, 2040.0));
    }

    #[test]
    fn the_panel_hangs_from_the_top_of_the_screen_centred_on_the_notch() {
        let frame = panel_frame(&macbook());
        assert!((frame.x + frame.width / 2.0 - 756.0).abs() < f64::EPSILON);
        assert!((frame.max_y() - 982.0).abs() < f64::EPSILON);
        let frame = panel_frame(&external(ABOVE));
        assert!((frame.x + frame.width / 2.0 - 756.0).abs() < f64::EPSILON);
        assert!((frame.max_y() - 2062.0).abs() < f64::EPSILON);
    }

    #[test]
    fn only_the_island_takes_the_pointer_and_clicks_beside_it_go_through() {
        let panel = panel_frame(&macbook());
        // The island with a question dropped below it: the notch and a piece of menu bar either
        // side at the panel's top, and the question's card further down.
        let areas = [
            Rect::new(PANEL_WIDTH / 2.0 - 140.0, 0.0, 280.0, 32.0),
            Rect::new(PANEL_WIDTH / 2.0 - 170.0, 160.0, 340.0, 100.0),
        ];
        let (x, y) = in_panel(panel, 756.0, 975.0);
        assert_eq!(area_under(&areas, x, y), Some(0));
        let (x, y) = in_panel(panel, 756.0, 782.0);
        assert_eq!(area_under(&areas, x, y), Some(1));
        // Just below the menu bar, and beside the island in it: the app underneath.
        let (x, y) = in_panel(panel, 756.0, 940.0);
        assert_eq!(area_under(&areas, x, y), None);
        let (x, y) = in_panel(panel, 600.0, 975.0);
        assert_eq!(area_under(&areas, x, y), None);
        // Nothing reported yet: everything goes through.
        assert_eq!(area_under(&[], PANEL_WIDTH / 2.0, 5.0), None);
    }

    #[test]
    fn the_page_may_open_addresses_inside_loomwatch_and_nothing_else() {
        let origin = "http://127.0.0.1:3000";
        assert_eq!(
            app_address(origin, "/?path=trip.yaml&run=r1").as_deref(),
            Some("http://127.0.0.1:3000/?path=trip.yaml&run=r1")
        );
        for elsewhere in [
            "https://example.com",
            "//example.com/x",
            "file:///etc",
            "javascript:x",
            "/\\example.com",
        ] {
            assert_eq!(app_address(origin, elsewhere), None, "{elsewhere}");
        }
    }

    #[test]
    fn messages_from_the_page_are_read_and_unknown_ones_ignored() {
        assert_eq!(
            FromPage::parse(r#"{"kind":"ready"}"#),
            Some(FromPage::Ready)
        );
        assert_eq!(
            FromPage::parse(r#"{"kind":"areas","rects":[{"x":1,"y":2,"width":3,"height":4}]}"#),
            Some(FromPage::Areas {
                rects: vec![Rect::new(1.0, 2.0, 3.0, 4.0)]
            })
        );
        assert_eq!(
            FromPage::parse(r#"{"kind":"open","link":"/"}"#),
            Some(FromPage::Open { link: "/".into() })
        );
        assert_eq!(
            FromPage::parse(r#"{"kind":"keyboard","on":true}"#),
            Some(FromPage::Keyboard { on: true })
        );
        assert_eq!(
            FromPage::parse(r#"{"kind":"agent","name":"Maya"}"#),
            Some(FromPage::Agent {
                name: Some("Maya".into())
            })
        );
        assert_eq!(
            FromPage::parse(r#"{"kind":"agent","name":null}"#),
            Some(FromPage::Agent { name: None })
        );
        assert_eq!(
            FromPage::parse(r#"{"kind":"copy","text":"Rent rises 4%.","html":null}"#),
            Some(FromPage::Copy {
                text: "Rent rises 4%.".into(),
                html: None
            })
        );
        assert_eq!(
            FromPage::parse(
                r#"{"kind":"copy","text":"Rent rises 4% (https://x.vn)","html":"<p>Rent rises <a href=\"https://x.vn\">4%</a></p>"}"#
            ),
            Some(FromPage::Copy {
                text: "Rent rises 4% (https://x.vn)".into(),
                html: Some(r#"<p>Rent rises <a href="https://x.vn">4%</a></p>"#.into())
            })
        );
        assert_eq!(
            FromPage::parse(r#"{"kind":"seen","runs":["r1","r2"]}"#),
            Some(FromPage::Seen {
                runs: vec!["r1".into(), "r2".into()]
            })
        );
        assert_eq!(FromPage::parse(r#"{"kind":"launch"}"#), None);
        assert_eq!(FromPage::parse("not json"), None);
    }

    #[test]
    fn messages_to_the_page_wait_for_it_to_listen() {
        assert_eq!(
            ToPage::place(&macbook()).script(),
            r#"window.loomwatchIsland && window.loomwatchIsland.receive({"kind":"place","notch":{"width":188.0,"height":32.0},"menuBar":32.0})"#
        );
        assert_eq!(
            ToPage::Pointer {
                over: true,
                area: Some(1)
            }
            .script(),
            r#"window.loomwatchIsland && window.loomwatchIsland.receive({"kind":"pointer","over":true,"area":1})"#
        );
        assert_eq!(
            ToPage::ClickOutside.script(),
            r#"window.loomwatchIsland && window.loomwatchIsland.receive({"kind":"clickOutside"})"#
        );
        assert_eq!(
            ToPage::Compose.script(),
            r#"window.loomwatchIsland && window.loomwatchIsland.receive({"kind":"compose"})"#
        );
        assert_eq!(
            ToPage::Drag { near: true }.script(),
            r#"window.loomwatchIsland && window.loomwatchIsland.receive({"kind":"drag","near":true})"#
        );
        assert_eq!(
            ToPage::Live { on: false }.script(),
            r#"window.loomwatchIsland && window.loomwatchIsland.receive({"kind":"live","on":false})"#
        );
        assert_eq!(
            ToPage::News { on: true }.script(),
            r#"window.loomwatchIsland && window.loomwatchIsland.receive({"kind":"news","on":true})"#
        );
        assert_eq!(
            ToPage::Seen {
                runs: vec!["r1".into()]
            }
            .script(),
            r#"window.loomwatchIsland && window.loomwatchIsland.receive({"kind":"seen","runs":["r1"]})"#
        );
    }

    #[test]
    fn files_the_app_took_from_a_drop_are_asked_for_by_the_page() {
        assert_eq!(
            ToPage::Dropped.script(),
            r#"window.loomwatchIsland && window.loomwatchIsland.receive({"kind":"dropped"})"#
        );
    }

    #[test]
    fn a_drag_promising_files_both_ways_is_asked_only_the_new_way() {
        let types = |kinds: &[&str]| {
            kinds
                .iter()
                .map(|kind| (*kind).to_owned())
                .collect::<Vec<_>>()
        };
        let old_way = "dyn.ah62d4rv4gu8yc6durvwwa3xmrvw1gkdusm1044pxqyuha2pxsvw0e55bsmwca7d3sbwu";
        let readable = types(&[
            PROMISED_NEW_WAY,
            old_way,
            "com.apple.pasteboard.promised-file-content-type",
        ]);
        let new_item = types(&[PROMISED_NEW_WAY, "com.apple.pasteboard.promised-file-name"]);
        // Mail, a conversation of two: one item promising both the old way, then one for each
        // message the new way.
        let mail = vec![
            types(&[
                "com.apple.mail.PasteboardTypeMessageTransfer",
                "public.utf8-plain-text",
                old_way,
            ]),
            new_item.clone(),
            new_item.clone(),
        ];
        assert_eq!(promises_to_ask(&mail, &readable, 3), vec![1, 2]);
        // Only the new way, or only the old: every promise.
        assert_eq!(
            promises_to_ask(&[new_item.clone(), new_item.clone()], &readable, 2),
            vec![0, 1]
        );
        assert_eq!(promises_to_ask(&[types(&[old_way])], &readable, 1), vec![0]);
        // An item with no promise is no receiver's; items and receivers that don't match: all.
        let with_text = vec![
            types(&["public.utf8-plain-text"]),
            types(&[old_way]),
            new_item.clone(),
        ];
        assert_eq!(promises_to_ask(&with_text, &readable, 2), vec![1]);
        assert_eq!(promises_to_ask(&mail, &readable, 2), vec![0, 1]);
    }

    #[test]
    fn files_promised_twice_or_never_written_arrive_once() {
        let folder = std::env::temp_dir().join(format!(
            "loomwatch-app-received-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let elsewhere = folder.join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        let survey = folder.join("Survey.eml");
        let reply = folder.join("RE Survey.eml");
        std::fs::write(&survey, "Subject: Survey\n\nHello").unwrap();
        std::fs::write(&reply, "Subject: RE Survey\n\nHi").unwrap();
        std::fs::write(elsewhere.join("Survey.eml"), "").unwrap();
        // As Mail hands back a conversation of two: each message the old way, then the new way;
        // the old way's copy empty or never written.
        let paths = vec![
            elsewhere.join("Survey.eml"),
            folder.join("never written.eml"),
            survey.clone(),
            reply.clone(),
            reply.clone(),
        ];
        assert_eq!(received_once(&paths), vec![2, 3]);
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn a_page_that_ended_loads_again_at_once_then_after_a_pause_and_never_stays_gone() {
        let start = Instant::now();
        let mut reloads = Reloads::default();
        let at = |seconds: u64| start + Duration::from_secs(seconds);
        // A drop that ends the page, again and again: back at once, three times in a minute.
        assert_eq!(reloads.ended(at(0)), Duration::ZERO);
        assert_eq!(reloads.ended(at(5)), Duration::ZERO);
        assert_eq!(reloads.ended(at(10)), Duration::ZERO);
        // A page that keeps ending waits before it loads again, but loads.
        assert_eq!(reloads.ended(at(15)), SLOW_RELOAD);
        assert_eq!(reloads.ended(at(50)), SLOW_RELOAD);
        // A minute after the first few, it is back at once again.
        assert_eq!(reloads.ended(at(116)), Duration::ZERO);
    }

    #[test]
    fn a_minute_without_the_mouse_or_keyboard_is_away() {
        assert!(!away(5.0));
        assert!(away(60.0));
    }

    #[test]
    fn show_at_the_notch_is_on_until_unticked_and_stays_as_left() {
        let state = std::env::temp_dir().join(format!(
            "loomwatch-app-island-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        // The first time, before the state folder is even made: at the notch.
        assert!(shown(&state));
        set_shown(&state, false).unwrap();
        assert!(!shown(&state));
        // Unticked twice, then ticked twice: each time as asked, and no error.
        set_shown(&state, false).unwrap();
        assert!(!shown(&state));
        set_shown(&state, true).unwrap();
        assert!(shown(&state));
        set_shown(&state, true).unwrap();
        assert!(shown(&state));
        let _ = std::fs::remove_dir_all(&state);
    }
}
