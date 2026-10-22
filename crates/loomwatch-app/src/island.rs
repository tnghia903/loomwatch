//! The island at the notch (ADR 0083): where it goes, and what passes between the Mac app's
//! see-through panel and the page drawn in it.
//!
//! The page (`ui/island.html`, served by `loomwatchd`) draws the island, decides when it pops out
//! and tucks away, and answers a permission with the same calls the browser makes. The app only
//! places the panel over the notch, lets clicks through everywhere but the island itself, and
//! tells the page where the pointer is, whether the person is away, and whether an app is full
//! screen. Kept apart from `AppKit` so it is the same, and tested, everywhere.

use serde::{Deserialize, Serialize};

/// The panel's size in points. The island and whatever drops out of it fit inside; everything
/// else in the panel lets clicks through to the app underneath.
pub const PANEL_WIDTH: f64 = 560.0;
pub const PANEL_HEIGHT: f64 = 460.0;
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

    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.max_x() && y >= self.y && y < self.max_y()
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

/// Where the island lives: around the notch of the first screen that has one; otherwise at the
/// top of the main screen (`screens[0]`, the one with the menu bar in Displays settings), where it
/// drops from the middle of the menu bar only for a question or a result.
pub fn island_screen(screens: &[Screen]) -> Option<&Screen> {
    screens
        .iter()
        .find(|screen| screen.notch.is_some())
        .or_else(|| screens.first())
}

/// The menu bar face stays wherever a screen has no notch to hold the island: an iMac, a Mac mini,
/// an external screen beside a `MacBook`.
pub fn menu_bar_face_shows(screens: &[Screen]) -> bool {
    screens.iter().any(|screen| screen.notch.is_none())
}

/// The panel's frame on `screen`: hanging from its top edge, centred on the notch, or on the
/// screen without one.
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
    fn the_island_lives_at_the_notch_and_the_face_stays_where_a_screen_has_none() {
        // A MacBook on its own: the island, and no face in the menu bar.
        assert_eq!(island_screen(&[macbook()]), Some(&macbook()));
        assert!(!menu_bar_face_shows(&[macbook()]));
        // With a screen beside it, even one listed first: the island stays at the notch, and the
        // face comes back for the other screen's menu bar.
        let both = [external(ABOVE), macbook()];
        assert_eq!(island_screen(&both), Some(&macbook()));
        assert!(menu_bar_face_shows(&both));
        // No notch anywhere (an iMac, or a MacBook closed on a desk): the main screen, and the face.
        let imac = [external(ABOVE)];
        assert_eq!(island_screen(&imac), Some(&imac[0]));
        assert!(menu_bar_face_shows(&imac));
        assert_eq!(island_screen(&[]), None);
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
    }

    #[test]
    fn a_minute_without_the_mouse_or_keyboard_is_away() {
        assert!(!away(5.0));
        assert!(away(60.0));
    }
}
