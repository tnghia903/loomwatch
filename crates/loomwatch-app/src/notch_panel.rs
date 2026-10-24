//! The see-through panels over the notch that hold the island page (ADR 0083, `crate::island`):
//! one on every screen, so no screen's island comes and goes as the pointer moves between them.
//!
//! `AppKit` and `WebKit` have no safe Rust interface for what the island needs: a panel above the
//! menu bar that takes the keyboard only while a message to the pinned agent is written, a web
//! view with no background, and messages from the page. So this module, and only this one in the
//! workspace, calls them directly. Everything it decides is in `crate::island`, where it is
//! tested; what is left here is placing the panels, passing the pointer, and carrying messages.
#![allow(unsafe_code)]

use std::cell::{Cell, RefCell};
use std::ffi::c_void;
use std::ptr::NonNull;
use std::rc::Rc;
use std::time::Instant;

use block2::{DynBlock, RcBlock};
use objc2::rc::{Retained, Weak};
use objc2::runtime::{AnyClass, AnyObject, ProtocolObject};
use objc2::{
    ClassType, DefinedClass, MainThreadMarker, MainThreadOnly, Message, define_class, msg_send,
};
use objc2_app_kit::{
    NSApplication, NSApplicationDidChangeScreenParametersNotification,
    NSApplicationPresentationOptions, NSAutoresizingMaskOptions, NSBackingStoreType, NSColor,
    NSDraggingInfo, NSEvent, NSEventMask, NSFilePromiseReceiver, NSMainMenuWindowLevel, NSPanel,
    NSPasteboard, NSPasteboardNameDrag, NSPasteboardTypeHTML, NSPasteboardTypeString, NSResponder,
    NSScreen, NSView, NSWindow, NSWindowCollectionBehavior, NSWindowStyleMask, NSWorkspace,
    NSWorkspaceActiveSpaceDidChangeNotification, NSWorkspaceDidActivateApplicationNotification,
};
use objc2_foundation::{
    NSArray, NSDictionary, NSError, NSNotification, NSNotificationCenter, NSNumber, NSObject,
    NSObjectNSKeyValueCoding, NSObjectProtocol, NSOperationQueue, NSPoint, NSRect, NSSize,
    NSString, NSURL, NSURLRequest, ns_string,
};
use objc2_web_kit::{
    WKFrameInfo, WKNavigationDelegate, WKOpenPanelParameters, WKScriptMessage,
    WKScriptMessageHandler, WKUIDelegate, WKUserContentController, WKWebView,
    WKWebViewConfiguration,
};
use tray_icon::menu::{ContextMenu, Menu};

use crate::island::{self, FromPage, Rect, Screen, ToPage};

/// What the panels hear, for the app's event loop.
#[derive(Debug)]
pub enum IslandEvent {
    /// A message from the page of one screen's island, by the island's number.
    Page {
        from: u32,
        message: FromPage,
    },
    /// The page of one screen's island is gone: `WebKit` ended its process.
    PageGone {
        from: u32,
    },
    /// The pointer moved.
    Pointer,
    /// A click landed somewhere other than `LoomWatch`.
    ClickOutside,
    /// Screens, spaces or the frontmost app changed: place the panels again.
    Screens,
    /// The left button went down, or up, in another app: a drag may begin, or ends.
    PressStarted,
    PressEnded,
    /// ⌃⌥Space, from any app.
    Shortcut,
}

type Sender = Rc<dyn Fn(IslandEvent)>;

/// The island on every screen. Dropped, every panel closes and `LoomWatch` stops watching the
/// pointer and gives ⌃⌥Space back: Show at the notch, unticked.
pub struct NotchPanels {
    mtm: MainThreadMarker,
    send: Sender,
    /// One island for each screen, in the order `NSScreen` lists them, the main screen first.
    islands: Vec<ScreenIsland>,
    /// The number the next island made gets, so a page's message reaches only its own island.
    next_id: u32,
    /// Which of them is live: the one on the screen the pointer is on.
    live: Option<usize>,
    /// Every screen, as last measured.
    screens: Vec<Screen>,
    /// `loomwatchd`'s address, once it answers: the island of a screen plugged in later loads its
    /// page from it.
    origin: Option<String>,
    /// The drag pasteboard's count when the left button went down in another app: a different
    /// count while it is held means something is being dragged, not a window or a selection.
    pressed_at: Option<isize>,
    /// What every page was last told, so they hear only of changes.
    away: bool,
    full_screen: bool,
    /// Taken out when the islands go: the event monitors, the observers and their notification
    /// centres, and ⌃⌥Space, `None` when another app holds it.
    monitors: Vec<Retained<AnyObject>>,
    observers: Vec<Observer>,
    _shortcut: Option<Shortcut>,
}

type Observer = (
    Retained<NSNotificationCenter>,
    Retained<ProtocolObject<dyn NSObjectProtocol>>,
);

impl NotchPanels {
    /// No islands yet: [`NotchPanels::place`] makes one for each screen, and
    /// [`NotchPanels::load`] shows them. `send` hands what they hear to the app's event loop.
    pub fn new(mtm: MainThreadMarker, send: impl Fn(IslandEvent) + 'static) -> Self {
        let send: Sender = Rc::new(send);
        Self {
            mtm,
            islands: Vec::new(),
            next_id: 0,
            live: None,
            screens: Vec::new(),
            origin: None,
            pressed_at: None,
            away: false,
            full_screen: false,
            monitors: monitors(&send),
            observers: observers(&send),
            _shortcut: register_shortcut(&send),
            send,
        }
    }

    /// Show the island page from the `loomwatchd` at `origin` on every screen. Done again when
    /// `loomwatchd` comes back on another port.
    pub fn load(&mut self, origin: &str) {
        self.origin = Some(origin.to_owned());
        for island in &mut self.islands {
            island.load(origin);
        }
    }

    /// One screen's page listens: tell it where it is and what it needs to know.
    pub fn page_ready(&mut self, from: u32) {
        let (away, full_screen) = (self.away, self.full_screen);
        if let Some(island) = self.island(from) {
            island.ready = true;
            if let Some(place) = island.place.clone() {
                island.send(&place);
            }
            island.send(&ToPage::Away { away });
            island.send(&ToPage::FullScreen { on: full_screen });
            island.send(&ToPage::Live { on: island.live });
        }
    }

    /// One screen's page is gone, and its panel shows nothing. Whatever the page was doing ends
    /// with it: the keyboard goes back, so the island on the screen the pointer goes to can be the
    /// live one again, and the page loads again, at once or, if it keeps ending, after a pause.
    pub fn page_gone(&mut self, from: u32) {
        let origin = self.origin.clone();
        if let Some(island) = self.island(from) {
            island.give_back_keyboard();
            island.forget_page();
            let wait = island.reloads.ended(Instant::now());
            match origin {
                Some(origin) if wait.is_zero() => island.load(&origin),
                _ => island.reload_at = Some(Instant::now() + wait),
            }
        }
        self.pointer();
    }

    /// Measure the screens again: an island for each, hanging from its top, and the one on the
    /// screen the pointer is on live.
    pub fn place(&mut self) {
        self.screens = screens(self.mtm);
        self.islands.truncate(self.screens.len());
        while self.islands.len() < self.screens.len() {
            let mut island = ScreenIsland::new(self.mtm, self.next_id, &self.send);
            self.next_id += 1;
            if let Some(origin) = &self.origin {
                island.load(origin);
            }
            self.islands.push(island);
        }
        for (island, screen) in self.islands.iter_mut().zip(&self.screens) {
            island.put(screen);
        }
        if self.live.is_some_and(|live| live >= self.islands.len()) {
            self.live = None;
        }
        self.follow_pointer();
        self.check_full_screen();
    }

    /// The island on the screen the pointer is on is live (`island::live_screen`), and the one
    /// that was goes back to rest. The island a message is being written in stays live, wherever
    /// the pointer goes.
    fn follow_pointer(&mut self) {
        if self
            .islands
            .iter()
            .any(|island| island.panel.ivars().keyboard.get())
        {
            return;
        }
        let at = NSEvent::mouseLocation();
        let live = island::live_screen(&self.screens, (at.x, at.y), self.live);
        if live == self.live {
            return;
        }
        if let Some(was) = self.live.and_then(|was| self.islands.get_mut(was)) {
            was.set_live(false);
        }
        if let Some(now) = live.and_then(|now| self.islands.get_mut(now)) {
            now.set_live(true);
        }
        self.live = live;
    }

    /// Where one screen's island and what dropped out of it are now.
    pub fn set_areas(&mut self, from: u32, areas: Vec<Rect>) {
        if let Some(island) = self.island(from) {
            island.areas = areas;
        }
        self.pointer();
    }

    /// The pointer moved: the live island's panel takes it only on the island, and its page hears
    /// which of its areas it is on.
    pub fn pointer(&mut self) {
        self.follow_pointer();
        let at = NSEvent::mouseLocation();
        self.drag_moved(at.x, at.y);
        if let Some(island) = self.live_island() {
            let (x, y) = island::in_panel(island.frame, at.x, at.y);
            island.set_area(island::area_under(&island.areas, x, y));
        }
    }

    /// While the left button is held in another app: once a drag of something begins, macOS sends
    /// other apps no more of the pointer, so the islands follow it from here, the live one opens as
    /// a slot when it comes near, and takes the pointer there, which makes its panel where the drag
    /// can drop. False once the button is up, wherever it came up: on an island, no other app
    /// hears it.
    pub fn poll_drag(&mut self) -> bool {
        if NSEvent::pressedMouseButtons() & 1 == 0 {
            self.press_ended();
            return false;
        }
        self.pointer();
        true
    }

    /// The left button went down in another app: note the drag pasteboard, to tell a drag of
    /// something (a file, a picture, text) from a drag of a window or a selection.
    pub fn press_started(&mut self) {
        self.pressed_at = Some(NSPasteboard::pasteboardWithName(drag_pasteboard()).changeCount());
    }

    /// The button came up: whatever was dragged was dropped, here or elsewhere.
    pub fn press_ended(&mut self) {
        self.pressed_at = None;
        for island in &mut self.islands {
            island.set_drag_near(false);
        }
    }

    /// While something is dragged, the live island's page hears whether it is near, so the island
    /// opens to take it; the page then reports the open island, and the panel takes the drag there
    /// like any pointer.
    fn drag_moved(&mut self, x: f64, y: f64) {
        let Some(pressed_at) = self.pressed_at else {
            return;
        };
        if NSPasteboard::pasteboardWithName(drag_pasteboard()).changeCount() == pressed_at {
            return;
        }
        let near = self
            .live
            .and_then(|live| self.screens.get(live))
            .is_some_and(|screen| island::near_island(screen, x, y));
        if let Some(island) = self.live_island() {
            island.set_drag_near(near);
        }
    }

    /// Copy on an answer: on the clipboard as any app's Copy puts it, formatted (`html`) for an
    /// app that pastes formatting, such as Mail, Notes or Pages, and as plain `text` for the rest.
    pub fn copy(text: &str, html: Option<&str>) {
        let board = NSPasteboard::generalPasteboard();
        board.clearContents();
        if let Some(html) = html {
            // SAFETY: `NSPasteboardTypeHTML` is `AppKit`'s own constant.
            board.setString_forType(&NSString::from_str(html), unsafe { NSPasteboardTypeHTML });
        }
        // SAFETY: `NSPasteboardTypeString` is `AppKit`'s own constant.
        board.setString_forType(&NSString::from_str(text), unsafe { NSPasteboardTypeString });
    }

    /// A message to the pinned agent is being written in one screen's island: its panel takes the
    /// keyboard, without bringing `LoomWatch` to the front, so the app the person was in stays
    /// where it was.
    pub fn take_keyboard(&mut self, from: u32) {
        if let Some(island) = self.island(from) {
            island.take_keyboard();
        }
    }

    /// The message is sent, put away or left: the keyboard goes back to the app that had it.
    pub fn give_back_keyboard(&mut self, from: u32) {
        if let Some(island) = self.island(from) {
            island.give_back_keyboard();
        }
    }

    /// ⌃⌥Space: the box to write to the pinned agent opens in the live island, with the keyboard;
    /// pressed again while it is open, the page puts it away and gives the keyboard back.
    pub fn compose(&mut self) {
        if let Some(island) = self.live_island() {
            island.take_keyboard();
            island.send(&ToPage::Compose);
        }
    }

    /// A click elsewhere: a pop-out tucks away at once, on every island the click wasn't on.
    pub fn click_outside(&self) {
        for island in self.islands.iter().filter(|island| island.area.is_none()) {
            island.send(&ToPage::ClickOutside);
        }
    }

    /// Results looked at on one screen's island leave the others too.
    pub fn seen(&self, from: u32, runs: &[String]) {
        let seen = ToPage::Seen {
            runs: runs.to_vec(),
        };
        for island in self.islands.iter().filter(|island| island.id != from) {
            island.send(&seen);
        }
    }

    /// Every couple of seconds: is the person away, and is an app full screen?
    pub fn tick(&mut self) {
        // SAFETY: a plain query of the window server, with its documented constants.
        let idle = unsafe {
            CGEventSourceSecondsSinceLastEventType(COMBINED_SESSION_STATE, ANY_INPUT_EVENT)
        };
        let away = island::away(idle);
        if away != self.away {
            self.away = away;
            self.tell_all(&ToPage::Away { away });
        }
        self.check_full_screen();
        if let Some(origin) = self.origin.clone() {
            let now = Instant::now();
            for island in &mut self.islands {
                if island.reload_at.is_some_and(|at| at <= now) {
                    island.load(&origin);
                }
            }
        }
    }

    /// The app's menu, where one screen's island was right-clicked or its ⋯ pressed.
    pub fn show_menu(&mut self, from: u32, menu: &Menu) {
        if let Some(island) = self.island(from) {
            let view = Retained::as_ptr(&island.web).cast::<std::ffi::c_void>();
            // SAFETY: the web view is a valid `NSView` for as long as its island.
            unsafe { menu.show_context_menu_for_nsview(view, None) };
        }
    }

    fn check_full_screen(&mut self) {
        let on = NSApplication::sharedApplication(self.mtm)
            .currentSystemPresentationOptions()
            .contains(NSApplicationPresentationOptions::FullScreen);
        if on != self.full_screen {
            self.full_screen = on;
            self.tell_all(&ToPage::FullScreen { on });
        }
    }

    fn tell_all(&self, message: &ToPage) {
        for island in &self.islands {
            island.send(message);
        }
    }

    fn island(&mut self, id: u32) -> Option<&mut ScreenIsland> {
        self.islands.iter_mut().find(|island| island.id == id)
    }

    fn live_island(&mut self) -> Option<&mut ScreenIsland> {
        self.live.and_then(|live| self.islands.get_mut(live))
    }
}

impl Drop for NotchPanels {
    /// Show at the notch, unticked: every panel closes, and nothing of the island is left
    /// listening. ⌃⌥Space goes back with `Shortcut`'s own drop.
    fn drop(&mut self) {
        self.islands.clear();
        for monitor in &self.monitors {
            // SAFETY: a monitor `NSEvent` returned from `monitors`, removed once.
            unsafe { NSEvent::removeMonitor(monitor) };
        }
        for (centre, observer) in &self.observers {
            // SAFETY: an observer added to this centre in `observers`, removed once.
            unsafe { centre.removeObserver(AsRef::<AnyObject>::as_ref(&**observer)) };
        }
    }
}

/// One screen's island: its panel, and the page in it.
struct ScreenIsland {
    id: u32,
    panel: Retained<IslandPanel>,
    web: Retained<IslandWebView>,
    /// Kept for as long as the island: the page's messages stop when it goes.
    _bridge: Retained<Bridge>,
    /// The panel's frame on screen, and the island's areas in it, as the page last reported them.
    frame: Rect,
    areas: Vec<Rect>,
    /// What the page was last told, so it hears only of changes: which of the island's areas the
    /// pointer is on, whether something dragged is near, and whether it is the live island.
    area: Option<usize>,
    drag_near: bool,
    live: bool,
    place: Option<ToPage>,
    /// The page has loaded and listens.
    ready: bool,
    /// When the page loads again after its process ended, if it is to wait.
    reloads: island::Reloads,
    reload_at: Option<Instant>,
}

impl ScreenIsland {
    /// The panel, empty and hidden until [`ScreenIsland::load`]. Its page's messages go to `send`
    /// with `id`.
    fn new(mtm: MainThreadMarker, id: u32, send: &Sender) -> Self {
        let frame = Rect::new(0.0, 0.0, island::PANEL_WIDTH, island::PANEL_HEIGHT);

        // A panel that never activates `LoomWatch` and becomes key only while a message to the
        // pinned agent is written, so whatever the person is typing into keeps the keyboard; above
        // the menu bar on every space and beside full-screen apps; and that lets every click
        // through until the pointer is on the island.
        let panel = IslandPanel::new(mtm, frame);
        // SAFETY: the panel is kept in its island and closed only as that goes, so it must not
        // free itself.
        unsafe { panel.setReleasedWhenClosed(false) };
        panel.setFloatingPanel(true);
        panel.setBecomesKeyOnlyIfNeeded(true);
        panel.setHidesOnDeactivate(false);
        panel.setLevel(NSMainMenuWindowLevel + 3);
        panel.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::IgnoresCycle,
        );
        panel.setOpaque(false);
        panel.setBackgroundColor(Some(&NSColor::clearColor()));
        panel.setHasShadow(false);
        panel.setIgnoresMouseEvents(true);
        panel.setAcceptsMouseMovedEvents(true);

        let bridge = Bridge::new(mtm, id, Rc::clone(send));
        // SAFETY: a configuration and a web view made on the main thread, with a message handler
        // that lives as long as the island. `drawsBackground` is the web view's own switch for a
        // see-through page, set through key-value coding as `WebKit` documents for macOS.
        let web = unsafe {
            let configuration = WKWebViewConfiguration::new(mtm);
            configuration
                .userContentController()
                .addScriptMessageHandler_name(
                    ProtocolObject::from_ref(&*bridge),
                    ns_string!("island"),
                );
            let web: Retained<IslandWebView> = msg_send![
                super(IslandWebView::alloc(mtm).set_ivars(WebIvars::default())),
                initWithFrame: NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(frame.width, frame.height)),
                configuration: &*configuration,
            ];
            web.setValue_forKey(
                Some(&NSNumber::numberWithBool(false)),
                ns_string!("drawsBackground"),
            );
            // The bridge hears when the page's process ends, and the web view answers the page's
            // file picker with files it took from a drop itself. Both are held for as long as the
            // island, so `WebKit`'s weak references to them hold too.
            web.setNavigationDelegate(Some(ProtocolObject::from_ref(&*bridge)));
            web.setUIDelegate(Some(ProtocolObject::from_ref(&*web)));
            web
        };
        web.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewWidthSizable
                | NSAutoresizingMaskOptions::ViewHeightSizable,
        );
        panel.setContentView(Some(&web));

        Self {
            id,
            panel,
            web,
            _bridge: bridge,
            frame,
            areas: Vec::new(),
            area: None,
            drag_near: false,
            live: false,
            place: None,
            ready: false,
            reloads: island::Reloads::default(),
            reload_at: None,
        }
    }

    fn load(&mut self, origin: &str) {
        let address = NSString::from_str(&format!("{origin}/island.html"));
        let Some(url) = NSURL::URLWithString(&address) else {
            return;
        };
        self.forget_page();
        self.reload_at = None;
        // SAFETY: a request for an address made above, on the main thread.
        unsafe { self.web.loadRequest(&NSURLRequest::requestWithURL(&url)) };
        self.panel.orderFrontRegardless();
    }

    /// The page is gone or going: until the next one says it listens, the panel lets the pointer
    /// through everywhere.
    fn forget_page(&mut self) {
        self.ready = false;
        self.areas.clear();
        self.set_area(None);
        self.set_drag_near(false);
    }

    /// Hang the panel from the top of `screen`, centred on its notch or on the screen without
    /// one, and tell the page what it is around.
    fn put(&mut self, screen: &Screen) {
        let frame = island::panel_frame(screen);
        if frame != self.frame {
            self.panel.setFrame_display(ns_rect(frame), true);
            self.frame = frame;
        }
        let place = ToPage::place(screen);
        if self.place.as_ref() != Some(&place) {
            self.send(&place);
            self.place = Some(place);
        }
    }

    /// Live, the island may open and drop things out; no longer live, it goes back to rest and
    /// lets the pointer through.
    fn set_live(&mut self, on: bool) {
        if on != self.live {
            self.live = on;
            if !on {
                self.set_area(None);
                self.set_drag_near(false);
            }
            self.send(&ToPage::Live { on });
        }
    }

    fn take_keyboard(&self) {
        self.panel.ivars().keyboard.set(true);
        self.panel.makeKeyWindow();
        self.panel.makeFirstResponder(Some(&self.web));
    }

    /// The panel steps out and back, and the window server gives the key back to the app in
    /// front, which never stopped being in front.
    fn give_back_keyboard(&self) {
        self.panel.ivars().keyboard.set(false);
        if self.panel.isKeyWindow() {
            self.panel.orderOut(None);
            self.panel.orderFrontRegardless();
        }
    }

    /// While something dragged is near, the whole panel takes the pointer at once: macOS offers a
    /// window as a place to drop only as the drag moves over it, so waiting for the island to open
    /// first could leave a drag that has stopped moving with nowhere to land.
    fn set_drag_near(&mut self, near: bool) {
        if near != self.drag_near {
            self.drag_near = near;
            self.panel
                .setIgnoresMouseEvents(!near && self.area.is_none());
            self.send(&ToPage::Drag { near });
        }
    }

    fn set_area(&mut self, area: Option<usize>) {
        if area != self.area {
            self.area = area;
            self.panel
                .setIgnoresMouseEvents(area.is_none() && !self.drag_near);
            self.send(&ToPage::Pointer {
                over: area.is_some(),
                area,
            });
        }
    }

    fn send(&self, message: &ToPage) {
        if !self.ready {
            return;
        }
        let script = NSString::from_str(&message.script());
        // SAFETY: a script of our own making, run in our own page, with no completion handler.
        unsafe { self.web.evaluateJavaScript_completionHandler(&script, None) };
    }
}

impl Drop for ScreenIsland {
    /// A screen unplugged, or Show at the notch unticked: the page stops sending, and the panel
    /// closes.
    fn drop(&mut self) {
        // SAFETY: the handler added under this name in `ScreenIsland::new`, on the main thread.
        unsafe {
            self.web
                .configuration()
                .userContentController()
                .removeScriptMessageHandlerForName(ns_string!("island"));
        }
        self.panel.orderOut(None);
        self.panel.close();
    }
}

/// Every screen, as `crate::island` sees it.
fn screens(mtm: MainThreadMarker) -> Vec<Screen> {
    NSScreen::screens(mtm)
        .iter()
        .map(|screen| {
            let frame = rect(screen.frame());
            let visible = rect(screen.visibleFrame());
            // The notch's measurements came with macOS 12; an older Mac has no notch.
            let notch = if screen.respondsToSelector(objc2::sel!(safeAreaInsets)) {
                island::notch_from(
                    screen.safeAreaInsets().top,
                    rect(screen.auxiliaryTopLeftArea()),
                    rect(screen.auxiliaryTopRightArea()),
                )
            } else {
                None
            };
            Screen {
                frame,
                menu_bar: (frame.max_y() - visible.max_y()).max(0.0),
                notch,
            }
        })
        .collect()
}

/// The pointer anywhere, and clicks in other apps: `AppKit` tells a global monitor of what happens
/// in other apps, and a local one of what happens in `LoomWatch`'s own panels.
fn monitors(send: &Sender) -> Vec<Retained<AnyObject>> {
    let moved = NSEventMask::MouseMoved | NSEventMask::LeftMouseDragged;
    let pointer = {
        let send = Rc::clone(send);
        RcBlock::new(move |_: NonNull<NSEvent>| send(IslandEvent::Pointer))
    };
    let clicks = {
        let send = Rc::clone(send);
        RcBlock::new(move |_: NonNull<NSEvent>| send(IslandEvent::ClickOutside))
    };
    let here = {
        let send = Rc::clone(send);
        RcBlock::new(move |event: NonNull<NSEvent>| {
            send(IslandEvent::Pointer);
            event.as_ptr()
        })
    };
    let pressed = {
        let send = Rc::clone(send);
        RcBlock::new(move |_: NonNull<NSEvent>| send(IslandEvent::PressStarted))
    };
    let released = {
        let send = Rc::clone(send);
        RcBlock::new(move |_: NonNull<NSEvent>| send(IslandEvent::PressEnded))
    };
    let mut kept = Vec::new();
    kept.extend(NSEvent::addGlobalMonitorForEventsMatchingMask_handler(
        moved, &pointer,
    ));
    kept.extend(NSEvent::addGlobalMonitorForEventsMatchingMask_handler(
        NSEventMask::LeftMouseDown,
        &pressed,
    ));
    kept.extend(NSEvent::addGlobalMonitorForEventsMatchingMask_handler(
        NSEventMask::LeftMouseUp,
        &released,
    ));
    kept.extend(NSEvent::addGlobalMonitorForEventsMatchingMask_handler(
        NSEventMask::LeftMouseDown | NSEventMask::RightMouseDown | NSEventMask::OtherMouseDown,
        &clicks,
    ));
    // SAFETY: the handler returns the event it was given, unchanged.
    kept.extend(unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(moved, &here) });
    kept
}

/// Screens added, removed or rearranged; another space; another app in front.
fn observers(send: &Sender) -> Vec<Observer> {
    let block = {
        let send = Rc::clone(send);
        RcBlock::new(move |_: NonNull<NSNotification>| send(IslandEvent::Screens))
    };
    let app = NSNotificationCenter::defaultCenter();
    let workspace = NSWorkspace::sharedWorkspace().notificationCenter();
    // SAFETY: the names are `AppKit`'s own, and the block lives as long as the observer.
    unsafe {
        vec![
            (
                app.clone(),
                app.addObserverForName_object_queue_usingBlock(
                    Some(NSApplicationDidChangeScreenParametersNotification),
                    None,
                    None,
                    &block,
                ),
            ),
            (
                workspace.clone(),
                workspace.addObserverForName_object_queue_usingBlock(
                    Some(NSWorkspaceActiveSpaceDidChangeNotification),
                    None,
                    None,
                    &block,
                ),
            ),
            (
                workspace.clone(),
                workspace.addObserverForName_object_queue_usingBlock(
                    Some(NSWorkspaceDidActivateApplicationNotification),
                    None,
                    None,
                    &block,
                ),
            ),
        ]
    }
}

struct PanelIvars {
    /// The page asked for the keyboard, for a message to the pinned agent.
    keyboard: Cell<bool>,
}

define_class!(
    // SAFETY: `NSPanel` may be subclassed, and `IslandPanel` does not implement `Drop`.
    #[unsafe(super(NSPanel, NSWindow, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "LoomWatchIslandPanel"]
    #[ivars = PanelIvars]
    struct IslandPanel;

    impl IslandPanel {
        /// A borderless panel can't become key, so a click on the island never takes the keyboard
        /// from the app the person is typing in. It can while a message to the pinned agent is
        /// written, and only then.
        #[unsafe(method(canBecomeKeyWindow))]
        fn can_become_key_window(&self) -> bool {
            self.ivars().keyboard.get()
        }
    }
);

impl IslandPanel {
    fn new(mtm: MainThreadMarker, frame: Rect) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(PanelIvars {
            keyboard: Cell::new(false),
        });
        // SAFETY: `NSPanel`'s designated initialiser, with a style, backing and frame it accepts.
        unsafe {
            msg_send![
                super(this),
                initWithContentRect: ns_rect(frame),
                styleMask: NSWindowStyleMask::Borderless | NSWindowStyleMask::NonactivatingPanel,
                backing: NSBackingStoreType::Buffered,
                defer: false,
            ]
        }
    }
}

#[derive(Default)]
struct WebIvars {
    /// Files taken from a drop, waiting for the page's file picker to ask for them.
    taken: RefCell<Vec<Retained<NSURL>>>,
}

define_class!(
    // SAFETY: `WKWebView` may be subclassed, and `IslandWebView` does not implement `Drop`.
    #[unsafe(super(WKWebView, NSView, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "LoomWatchIslandWebView"]
    #[ivars = WebIvars]
    struct IslandWebView;

    impl IslandWebView {
        /// A click on the island counts the first time. The panel never becomes key, and `WebKit`
        /// would otherwise take a click in a window that isn't only to bring it forward.
        #[unsafe(method(acceptsFirstMouse:))]
        fn accepts_first_mouse(&self, _event: Option<&NSEvent>) -> bool {
            true
        }

        /// Something dropped on the island, which the page has said it takes. Files another app
        /// writes only once dropped, as Mail does with a message, the app takes itself: `WebKit`'s
        /// own way of taking them ends the page's process (it refuses the page's read of the
        /// drag), and the island would go. Anything else is the page's, as it always was.
        #[unsafe(method(performDragOperation:))]
        fn perform_drag_operation(&self, dragged: &ProtocolObject<dyn NSDraggingInfo>) -> bool {
            let board = dragged.draggingPasteboard();
            if !promises_files(&board) {
                // SAFETY: `WKWebView`'s own `performDragOperation:`, with what it was given.
                return unsafe { msg_send![super(self), performDragOperation: dragged] };
            }
            self.receive_promised(&board)
        }
    }

    // SAFETY: `NSObjectProtocol` has no safety requirements.
    unsafe impl NSObjectProtocol for IslandWebView {}

    // SAFETY: the method's signature is `WKUIDelegate`'s.
    unsafe impl WKUIDelegate for IslandWebView {
        /// The page's file picker: the files taken from a drop, if any wait; otherwise nothing
        /// is chosen, as `WebKit` has it without this.
        #[unsafe(method(webView:runOpenPanelWithParameters:initiatedByFrame:completionHandler:))]
        fn run_open_panel(
            &self,
            _web_view: &WKWebView,
            _parameters: &WKOpenPanelParameters,
            _frame: &WKFrameInfo,
            chosen: &DynBlock<dyn Fn(*mut NSArray<NSURL>)>,
        ) {
            let taken = self.ivars().taken.take();
            if taken.is_empty() {
                chosen.call((std::ptr::null_mut(),));
            } else {
                let files = NSArray::from_retained_slice(&taken);
                chosen.call((Retained::as_ptr(&files).cast_mut(),));
            }
        }
    }
);

impl IslandWebView {
    /// Ask each app that promised files to write them into a folder of their own, and once the
    /// last has arrived, hand them to the page, each once (`island::received_once`). A file that
    /// fails is left out; with none, nothing is handed over, and the open slot closes as after any
    /// drag let go of elsewhere.
    fn receive_promised(&self, board: &NSPasteboard) -> bool {
        let classes = NSArray::<AnyClass>::from_slice(&[NSFilePromiseReceiver::class()]);
        // SAFETY: `NSFilePromiseReceiver` reads objects from a pasteboard, and no options.
        let read = unsafe { board.readObjectsForClasses_options(&classes, None) };
        let read: Vec<Retained<NSFilePromiseReceiver>> = read
            .map(|read| {
                read.iter()
                    .filter_map(|object| object.downcast::<NSFilePromiseReceiver>().ok())
                    .collect()
            })
            .unwrap_or_default();
        let items: Vec<Vec<String>> = board
            .pasteboardItems()
            .map(|items| {
                items
                    .iter()
                    .map(|item| item.types().iter().map(|kind| kind.to_string()).collect())
                    .collect()
            })
            .unwrap_or_default();
        let readable: Vec<String> = NSFilePromiseReceiver::readableDraggedTypes()
            .iter()
            .map(|kind| kind.to_string())
            .collect();
        let receivers: Vec<&Retained<NSFilePromiseReceiver>> =
            island::promises_to_ask(&items, &readable, read.len())
                .into_iter()
                .map(|at| &read[at])
                .collect();
        let expected: usize = receivers
            .iter()
            .map(|receiver| receiver.fileTypes().count())
            .sum();
        if expected == 0 {
            return false;
        }
        let Some(folder) = drop_folder() else {
            return false;
        };
        let folder = NSURL::fileURLWithPath_isDirectory(
            &NSString::from_str(&folder.to_string_lossy()),
            true,
        );
        let arrived: Rc<RefCell<(usize, Vec<Retained<NSURL>>)>> = Rc::default();
        let web = Weak::from(self);
        let reader = RcBlock::new(move |file: NonNull<NSURL>, error: *mut NSError| {
            let mut arrived = arrived.borrow_mut();
            arrived.0 += 1;
            if error.is_null() {
                // SAFETY: `AppKit` hands the reader the file it wrote.
                arrived.1.push(unsafe { file.as_ref() }.retain());
            }
            if arrived.0 < expected {
                return;
            }
            let arrived = std::mem::take(&mut arrived.1);
            let paths: Vec<std::path::PathBuf> = arrived
                .iter()
                .map(|file| {
                    file.path()
                        .map(|path| path.to_string())
                        .unwrap_or_default()
                        .into()
                })
                .collect();
            let files: Vec<Retained<NSURL>> = island::received_once(&paths)
                .into_iter()
                .map(|index| arrived[index].clone())
                .collect();
            if let Some(web) = web.load()
                && !files.is_empty()
            {
                web.ivars().taken.replace(files);
                let script = NSString::from_str(&ToPage::Dropped.script());
                // SAFETY: a script of our own making, run in our own page. `WebKit` runs it as if
                // the person did it, so the page's file picker may open.
                unsafe { web.evaluateJavaScript_completionHandler(&script, None) };
            }
        });
        let options = NSDictionary::new();
        let queue = NSOperationQueue::mainQueue();
        for receiver in receivers {
            // SAFETY: an empty options dictionary, and the main queue, where the reader's web view
            // lives.
            unsafe {
                receiver.receivePromisedFilesAtDestination_options_operationQueue_reader(
                    &folder, &options, &queue, &reader,
                );
            }
        }
        true
    }
}

/// Whether a drag carries files its app writes only once they are dropped.
fn promises_files(board: &NSPasteboard) -> bool {
    let promised = NSFilePromiseReceiver::readableDraggedTypes();
    board
        .types()
        .is_some_and(|types| types.iter().any(|kind| promised.containsObject(&kind)))
}

/// A new folder for one drop's files, in the user's own temporary folder, which macOS clears.
/// Kept after the drop: the page sends the files with the message, which may be written later.
fn drop_folder() -> Option<std::path::PathBuf> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    let folder = std::env::temp_dir()
        .join("LoomWatch drops")
        .join(stamp.to_string());
    std::fs::create_dir_all(&folder).ok()?;
    Some(folder)
}

struct BridgeIvars {
    /// The island whose page this hears.
    id: u32,
    send: Sender,
}

define_class!(
    // SAFETY: `NSObject` has no subclassing requirements, and `Bridge` does not implement `Drop`.
    #[unsafe(super = NSObject)]
    #[thread_kind = MainThreadOnly]
    #[name = "LoomWatchIslandBridge"]
    #[ivars = BridgeIvars]
    struct Bridge;

    // SAFETY: `NSObjectProtocol` has no safety requirements.
    unsafe impl NSObjectProtocol for Bridge {}

    // SAFETY: the method's signature is `WKScriptMessageHandler`'s.
    unsafe impl WKScriptMessageHandler for Bridge {
        #[unsafe(method(userContentController:didReceiveScriptMessage:))]
        fn did_receive(&self, _controller: &WKUserContentController, message: &WKScriptMessage) {
            // SAFETY: the body of a message from our own page; it posts JSON text.
            let body = unsafe { message.body() };
            if let Ok(text) = body.downcast::<NSString>()
                && let Some(message) = FromPage::parse(&text.to_string())
            {
                let ivars = self.ivars();
                (ivars.send)(IslandEvent::Page {
                    from: ivars.id,
                    message,
                });
            }
        }
    }

    // SAFETY: the method's signature is `WKNavigationDelegate`'s.
    unsafe impl WKNavigationDelegate for Bridge {
        /// `WebKit` ended the page's process: it crashed, or broke one of `WebKit`'s rules.
        #[unsafe(method(webViewWebContentProcessDidTerminate:))]
        fn page_gone(&self, _web_view: &WKWebView) {
            let ivars = self.ivars();
            (ivars.send)(IslandEvent::PageGone { from: ivars.id });
        }
    }
);

impl Bridge {
    fn new(mtm: MainThreadMarker, id: u32, send: Sender) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(BridgeIvars { id, send });
        // SAFETY: `NSObject`'s `init`.
        unsafe { msg_send![super(this), init] }
    }
}

const fn rect(rect: NSRect) -> Rect {
    Rect::new(
        rect.origin.x,
        rect.origin.y,
        rect.size.width,
        rect.size.height,
    )
}

const fn ns_rect(rect: Rect) -> NSRect {
    NSRect::new(
        NSPoint::new(rect.x, rect.y),
        NSSize::new(rect.width, rect.height),
    )
}

/// The pasteboard a drag carries what it drags on.
fn drag_pasteboard() -> &'static NSString {
    // SAFETY: `NSPasteboardNameDrag` is `AppKit`'s own constant.
    unsafe { NSPasteboardNameDrag }
}

/// ⌃⌥Space, held for as long as the islands are at the notch, and given back to macOS as they go:
/// where it is "Select next source in Input menu" with more than one input source.
struct Shortcut {
    hot_key: *mut c_void,
    handler: *mut c_void,
    /// What ⌃⌥Space calls: Carbon holds a pointer to it until the handler is removed.
    _send: Box<Sender>,
}

impl Drop for Shortcut {
    fn drop(&mut self) {
        // SAFETY: the hot key and handler `register_shortcut` installed, each removed once, before
        // `_send`, which the handler points at, goes.
        unsafe {
            UnregisterEventHotKey(self.hot_key);
            RemoveEventHandler(self.handler);
        }
    }
}

/// ⌃⌥Space from any app (`island::SHORTCUT_KEY`), through Carbon's hot keys: a shortcut that works
/// whichever app is in front, without asking for Accessibility. `None`, and a line in the log,
/// when another app holds it.
fn register_shortcut(send: &Sender) -> Option<Shortcut> {
    let held: Box<Sender> = Box::new(Rc::clone(send));
    let pressed = EventTypeSpec {
        class: KEYBOARD_EVENTS,
        kind: HOT_KEY_PRESSED,
    };
    let id = EventHotKeyId {
        signature: u32::from_be_bytes(*b"LWnt"),
        id: 1,
    };
    let mut handler = std::ptr::null_mut();
    let mut hot_key = std::ptr::null_mut();
    // SAFETY: the handler is called on the main thread with `held`, which lives in the `Shortcut`
    // for as long as the shortcut is registered, and the handler is removed if the key can't be.
    let status = unsafe {
        let target = GetApplicationEventTarget();
        let installed = InstallEventHandler(
            target,
            shortcut_pressed,
            1,
            &raw const pressed,
            std::ptr::from_ref::<Sender>(&held)
                .cast_mut()
                .cast::<c_void>(),
            &raw mut handler,
        );
        if installed != 0 {
            installed
        } else {
            let registered = RegisterEventHotKey(
                island::SHORTCUT_KEY,
                island::SHORTCUT_MODIFIERS,
                id,
                target,
                0,
                &raw mut hot_key,
            );
            if registered != 0 {
                RemoveEventHandler(handler);
            }
            registered
        }
    };
    if status != 0 {
        eprintln!("LoomWatch: ⌃⌥Space is not available ({status}); another app may hold it.");
        return None;
    }
    Some(Shortcut {
        hot_key,
        handler,
        _send: held,
    })
}

/// Carbon calls this for ⌃⌥Space.
unsafe extern "C" fn shortcut_pressed(
    _call: *mut c_void,
    _event: *mut c_void,
    data: *mut c_void,
) -> i32 {
    // SAFETY: `data` is the `Sender` boxed in `register_shortcut`, alive until the handler goes.
    let send = unsafe { &*data.cast::<Sender>() };
    send(IslandEvent::Shortcut);
    0
}

#[repr(C)]
struct EventTypeSpec {
    class: u32,
    kind: u32,
}

#[repr(C)]
struct EventHotKeyId {
    signature: u32,
    id: u32,
}

/// `kEventClassKeyboard` ('keyb') and `kEventHotKeyPressed`.
const KEYBOARD_EVENTS: u32 = u32::from_be_bytes(*b"keyb");
const HOT_KEY_PRESSED: u32 = 5;

type EventHandler = unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> i32;

#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
    fn GetApplicationEventTarget() -> *mut c_void;
    fn InstallEventHandler(
        target: *mut c_void,
        handler: EventHandler,
        type_count: usize,
        types: *const EventTypeSpec,
        user_data: *mut c_void,
        handler_ref: *mut *mut c_void,
    ) -> i32;
    fn RemoveEventHandler(handler_ref: *mut c_void) -> i32;
    fn RegisterEventHotKey(
        key_code: u32,
        modifiers: u32,
        id: EventHotKeyId,
        target: *mut c_void,
        options: u32,
        hot_key_ref: *mut *mut c_void,
    ) -> i32;
    fn UnregisterEventHotKey(hot_key_ref: *mut c_void) -> i32;
}

/// `kCGEventSourceStateCombinedSessionState` and `kCGAnyInputEventType`.
const COMBINED_SESSION_STATE: i32 = 0;
const ANY_INPUT_EVENT: u32 = u32::MAX;

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
}
