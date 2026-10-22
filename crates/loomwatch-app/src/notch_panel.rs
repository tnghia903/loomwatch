//! The see-through panel over the notch that holds the island page (ADR 0083, `crate::island`).
//!
//! `AppKit` and `WebKit` have no safe Rust interface for what the island needs: a panel above the
//! menu bar that takes the keyboard only while a message to the pinned agent is written, a web
//! view with no background, and messages from the page. So this module, and only this one in the workspace, calls them directly. Everything it
//! decides is in `crate::island`, where it is tested; what is left here is placing the panel,
//! passing the pointer, and carrying messages.
#![allow(unsafe_code)]

use std::cell::Cell;
use std::ffi::c_void;
use std::ptr::NonNull;
use std::rc::Rc;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send};
use objc2_app_kit::{
    NSApplication, NSApplicationDidChangeScreenParametersNotification,
    NSApplicationPresentationOptions, NSAutoresizingMaskOptions, NSBackingStoreType, NSColor,
    NSEvent, NSEventMask, NSMainMenuWindowLevel, NSPanel, NSPasteboard, NSPasteboardNameDrag,
    NSPasteboardTypeHTML, NSPasteboardTypeString, NSResponder, NSScreen, NSView, NSWindow,
    NSWindowCollectionBehavior, NSWindowStyleMask, NSWorkspace,
    NSWorkspaceActiveSpaceDidChangeNotification, NSWorkspaceDidActivateApplicationNotification,
};
use objc2_foundation::{
    NSNotification, NSNotificationCenter, NSNumber, NSObject, NSObjectNSKeyValueCoding,
    NSObjectProtocol, NSPoint, NSRect, NSSize, NSString, NSURL, NSURLRequest, ns_string,
};
use objc2_web_kit::{
    WKScriptMessage, WKScriptMessageHandler, WKUserContentController, WKWebView,
    WKWebViewConfiguration,
};
use tray_icon::menu::{ContextMenu, Menu};

use crate::island::{self, FromPage, Rect, Screen, ToPage};

/// What the panel hears, for the app's event loop.
#[derive(Debug)]
pub enum IslandEvent {
    /// A message from the page.
    Page(FromPage),
    /// The pointer moved.
    Pointer,
    /// A click landed somewhere other than `LoomWatch`.
    ClickOutside,
    /// Screens, spaces or the frontmost app changed: place the panel again.
    Screens,
    /// The left button went down, or up, in another app: a drag may begin, or ends.
    PressStarted,
    PressEnded,
    /// ⌃⌥Space, from any app.
    Shortcut,
}

type Sender = Rc<dyn Fn(IslandEvent)>;

pub struct NotchPanel {
    panel: Retained<IslandPanel>,
    web: Retained<IslandWebView>,
    /// Kept for as long as the panel: the page's messages, the event monitors and the observers
    /// stop when these go.
    _bridge: Retained<Bridge>,
    _monitors: Vec<Retained<AnyObject>>,
    _observers: Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>>,
    /// What ⌃⌥Space calls, for as long as the shortcut is registered; `None` when another app
    /// holds it.
    _shortcut: Option<Box<Sender>>,
    /// Every screen, as last measured: the island follows the pointer from one to the next.
    screens: Vec<Screen>,
    /// The drag pasteboard's count when the left button went down in another app: a different
    /// count while it is held means something is being dragged, not a window or a selection.
    pressed_at: Option<isize>,
    /// The panel's frame on screen, and the island's areas in it, as the page last reported them.
    frame: Rect,
    areas: Vec<Rect>,
    /// What the page was last told, so it hears only of changes.
    told: Told,
    place: Option<ToPage>,
    /// The page has loaded and listens.
    ready: bool,
}

#[derive(Default)]
struct Told {
    /// Which of the island's areas the pointer is on.
    area: Option<usize>,
    away: bool,
    full_screen: bool,
    /// Something is being dragged near the island.
    drag_near: bool,
}

impl NotchPanel {
    /// The panel, empty and hidden until [`NotchPanel::load`]. `send` hands what it hears to the
    /// app's event loop.
    pub fn new(mtm: MainThreadMarker, send: impl Fn(IslandEvent) + 'static) -> Self {
        let send: Sender = Rc::new(send);
        let frame = Rect::new(0.0, 0.0, island::PANEL_WIDTH, island::PANEL_HEIGHT);

        // A panel that never activates `LoomWatch` and becomes key only while a message to the
        // pinned agent is written, so whatever the person is typing into keeps the keyboard; above
        // the menu bar on every space and beside full-screen apps; and that lets every click
        // through until the pointer is on the island.
        let panel = IslandPanel::new(mtm, frame);
        // SAFETY: the panel is kept in `NotchPanel` and never closed, so it must not free itself.
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

        let bridge = Bridge::new(mtm, Rc::clone(&send));
        // SAFETY: a configuration and a web view made on the main thread, with a message handler
        // that lives as long as the panel. `drawsBackground` is the web view's own switch for a
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
                super(IslandWebView::alloc(mtm).set_ivars(())),
                initWithFrame: NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(frame.width, frame.height)),
                configuration: &*configuration,
            ];
            web.setValue_forKey(
                Some(&NSNumber::numberWithBool(false)),
                ns_string!("drawsBackground"),
            );
            web
        };
        web.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewWidthSizable
                | NSAutoresizingMaskOptions::ViewHeightSizable,
        );
        panel.setContentView(Some(&web));

        Self {
            panel,
            web,
            _bridge: bridge,
            _monitors: monitors(&send),
            _observers: observers(&send),
            _shortcut: register_shortcut(&send),
            screens: Vec::new(),
            pressed_at: None,
            frame,
            areas: Vec::new(),
            told: Told::default(),
            place: None,
            ready: false,
        }
    }

    /// Show the island page from the `loomwatchd` at `origin`. Done again when `loomwatchd` comes
    /// back on another port.
    pub fn load(&mut self, origin: &str) {
        let address = NSString::from_str(&format!("{origin}/island.html"));
        let Some(url) = NSURL::URLWithString(&address) else {
            return;
        };
        self.ready = false;
        self.areas.clear();
        self.set_area(None);
        // SAFETY: a request for an address made above, on the main thread.
        unsafe { self.web.loadRequest(&NSURLRequest::requestWithURL(&url)) };
        self.panel.orderFrontRegardless();
    }

    /// The page listens: tell it where it is and what it needs to know.
    pub fn page_ready(&mut self) {
        self.ready = true;
        if let Some(place) = self.place.clone() {
            self.send(&place);
        }
        self.send(&ToPage::Away {
            away: self.told.away,
        });
        self.send(&ToPage::FullScreen {
            on: self.told.full_screen,
        });
    }

    /// Measure the screens again, and put the panel on the one the pointer is on.
    pub fn place(&mut self, mtm: MainThreadMarker) {
        self.screens = screens(mtm);
        self.follow_pointer();
        self.check_full_screen(mtm);
    }

    /// The island is on the screen the pointer is on (`island::island_screen`): around its notch,
    /// or at the middle of its menu bar. It stays put while a message is being written in it.
    fn follow_pointer(&mut self) {
        if self.panel.ivars().keyboard.get() {
            return;
        }
        let at = NSEvent::mouseLocation();
        let Some(screen) = island::island_screen(&self.screens, (at.x, at.y)).copied() else {
            return;
        };
        let frame = island::panel_frame(&screen);
        if frame != self.frame {
            self.panel.setFrame_display(ns_rect(frame), true);
            self.frame = frame;
        }
        let place = ToPage::place(&screen);
        if self.place.as_ref() != Some(&place) {
            self.send(&place);
            self.place = Some(place);
        }
    }

    /// Where the island and what dropped out of it are now.
    pub fn set_areas(&mut self, areas: Vec<Rect>) {
        self.areas = areas;
        self.pointer();
    }

    /// The pointer moved: the panel takes it only on the island, and the page hears which of its
    /// areas it is on.
    pub fn pointer(&mut self) {
        self.follow_pointer();
        let at = NSEvent::mouseLocation();
        self.drag_moved(at.x, at.y);
        let (x, y) = island::in_panel(self.frame, at.x, at.y);
        self.set_area(island::area_under(&self.areas, x, y));
    }

    /// While the left button is held in another app: once a drag of something begins, macOS sends
    /// other apps no more of the pointer, so the island follows it from here, opens as a slot when
    /// it comes near, and takes the pointer there, which makes the panel where the drag can drop.
    /// False once the button is up, wherever it came up: on the island, no other app hears it.
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
        self.set_drag_near(false);
    }

    /// While something is dragged, the page hears whether it is near the island, so the island
    /// opens to take it; the page then reports the open island, and the panel takes the drag
    /// there like any pointer.
    fn drag_moved(&mut self, x: f64, y: f64) {
        let Some(pressed_at) = self.pressed_at else {
            return;
        };
        if NSPasteboard::pasteboardWithName(drag_pasteboard()).changeCount() == pressed_at {
            return;
        }
        let near = self
            .screens
            .iter()
            .find(|screen| screen.frame.contains(x, y))
            .is_some_and(|screen| island::near_island(screen, x, y));
        self.set_drag_near(near);
    }

    /// While something dragged is near, the whole panel takes the pointer at once: macOS offers a
    /// window as a place to drop only as the drag moves over it, so waiting for the island to open
    /// first could leave a drag that has stopped moving with nowhere to land.
    fn set_drag_near(&mut self, near: bool) {
        if near != self.told.drag_near {
            self.told.drag_near = near;
            self.panel
                .setIgnoresMouseEvents(!near && self.told.area.is_none());
            self.send(&ToPage::Drag { near });
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

    /// A message to the pinned agent is being written: the panel takes the keyboard, without
    /// bringing `LoomWatch` to the front, so the app the person was in stays where it was.
    pub fn take_keyboard(&self) {
        self.panel.ivars().keyboard.set(true);
        self.panel.makeKeyWindow();
        self.panel.makeFirstResponder(Some(&self.web));
    }

    /// The message is sent, put away or left: the keyboard goes back to the app that had it. The
    /// panel steps out and back, and the window server gives the key back to the app in front,
    /// which never stopped being in front.
    pub fn give_back_keyboard(&self) {
        self.panel.ivars().keyboard.set(false);
        if self.panel.isKeyWindow() {
            self.panel.orderOut(None);
            self.panel.orderFrontRegardless();
        }
    }

    /// ⌃⌥Space: the box to write to the pinned agent opens, with the keyboard; pressed again
    /// while it is open, the page puts it away and gives the keyboard back.
    pub fn compose(&self) {
        self.take_keyboard();
        self.send(&ToPage::Compose);
    }

    /// A click elsewhere: a pop-out tucks away at once.
    pub fn click_outside(&self) {
        if self.told.area.is_none() {
            self.send(&ToPage::ClickOutside);
        }
    }

    /// Every couple of seconds: is the person away, and is an app full screen?
    pub fn tick(&mut self, mtm: MainThreadMarker) {
        // SAFETY: a plain query of the window server, with its documented constants.
        let idle = unsafe {
            CGEventSourceSecondsSinceLastEventType(COMBINED_SESSION_STATE, ANY_INPUT_EVENT)
        };
        let away = island::away(idle);
        if away != self.told.away {
            self.told.away = away;
            self.send(&ToPage::Away { away });
        }
        self.check_full_screen(mtm);
    }

    /// The app's menu, where the island was right-clicked.
    pub fn show_menu(&self, menu: &Menu) {
        let view = Retained::as_ptr(&self.web).cast::<std::ffi::c_void>();
        // SAFETY: the web view is a valid `NSView` for as long as `self`.
        unsafe { menu.show_context_menu_for_nsview(view, None) };
    }

    fn check_full_screen(&mut self, mtm: MainThreadMarker) {
        let on = NSApplication::sharedApplication(mtm)
            .currentSystemPresentationOptions()
            .contains(NSApplicationPresentationOptions::FullScreen);
        if on != self.told.full_screen {
            self.told.full_screen = on;
            self.send(&ToPage::FullScreen { on });
        }
    }

    fn set_area(&mut self, area: Option<usize>) {
        if area != self.told.area {
            self.told.area = area;
            self.panel
                .setIgnoresMouseEvents(area.is_none() && !self.told.drag_near);
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
/// in other apps, and a local one of what happens in `LoomWatch`'s own panel.
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
fn observers(send: &Sender) -> Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>> {
    let block = {
        let send = Rc::clone(send);
        RcBlock::new(move |_: NonNull<NSNotification>| send(IslandEvent::Screens))
    };
    let workspace = NSWorkspace::sharedWorkspace().notificationCenter();
    // SAFETY: the names are `AppKit`'s own, and the block lives as long as the observer.
    unsafe {
        vec![
            NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
                Some(NSApplicationDidChangeScreenParametersNotification),
                None,
                None,
                &block,
            ),
            workspace.addObserverForName_object_queue_usingBlock(
                Some(NSWorkspaceActiveSpaceDidChangeNotification),
                None,
                None,
                &block,
            ),
            workspace.addObserverForName_object_queue_usingBlock(
                Some(NSWorkspaceDidActivateApplicationNotification),
                None,
                None,
                &block,
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

define_class!(
    // SAFETY: `WKWebView` may be subclassed, and `IslandWebView` does not implement `Drop`.
    #[unsafe(super(WKWebView, NSView, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "LoomWatchIslandWebView"]
    struct IslandWebView;

    impl IslandWebView {
        /// A click on the island counts the first time. The panel never becomes key, and `WebKit`
        /// would otherwise take a click in a window that isn't only to bring it forward.
        #[unsafe(method(acceptsFirstMouse:))]
        fn accepts_first_mouse(&self, _event: Option<&NSEvent>) -> bool {
            true
        }
    }
);

struct BridgeIvars {
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
                (self.ivars().send)(IslandEvent::Page(message));
            }
        }
    }
);

impl Bridge {
    fn new(mtm: MainThreadMarker, send: Sender) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(BridgeIvars { send });
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

/// ⌃⌥Space from any app (`island::SHORTCUT_KEY`), through Carbon's hot keys: a shortcut that works
/// whichever app is in front, without asking for Accessibility. `None`, and a line in the log,
/// when another app holds it.
fn register_shortcut(send: &Sender) -> Option<Box<Sender>> {
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
    // SAFETY: the handler is called on the main thread with `held`, which lives in the panel for as
    // long as the shortcut is registered: the app's whole life.
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
        if installed == 0 {
            RegisterEventHotKey(
                island::SHORTCUT_KEY,
                island::SHORTCUT_MODIFIERS,
                id,
                target,
                0,
                &raw mut hot_key,
            )
        } else {
            installed
        }
    };
    if status != 0 {
        eprintln!("LoomWatch: ⌃⌥Space is not available ({status}); another app may hold it.");
        return None;
    }
    Some(held)
}

/// Carbon calls this for ⌃⌥Space.
unsafe extern "C" fn shortcut_pressed(
    _call: *mut c_void,
    _event: *mut c_void,
    data: *mut c_void,
) -> i32 {
    // SAFETY: `data` is the `Sender` boxed in `register_shortcut`, alive for the app's life.
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
    fn RegisterEventHotKey(
        key_code: u32,
        modifiers: u32,
        id: EventHotKeyId,
        target: *mut c_void,
        options: u32,
        hot_key_ref: *mut *mut c_void,
    ) -> i32;
}

/// `kCGEventSourceStateCombinedSessionState` and `kCGAnyInputEventType`.
const COMBINED_SESSION_STATE: i32 = 0;
const ANY_INPUT_EVENT: u32 = u32::MAX;

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
}
