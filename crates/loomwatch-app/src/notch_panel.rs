//! The see-through panel over the notch that holds the island page (ADR 0083, `crate::island`).
//!
//! `AppKit` and `WebKit` have no safe Rust interface for what the island needs: a panel above the
//! menu bar that never takes the keyboard, a web view with no background, and messages from the
//! page. So this module, and only this one in the workspace, calls them directly. Everything it
//! decides is in `crate::island`, where it is tested; what is left here is placing the panel,
//! passing the pointer, and carrying messages.
#![allow(unsafe_code)]

use std::ptr::NonNull;
use std::rc::Rc;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send};
use objc2_app_kit::{
    NSApplication, NSApplicationDidChangeScreenParametersNotification,
    NSApplicationPresentationOptions, NSAutoresizingMaskOptions, NSBackingStoreType, NSColor,
    NSEvent, NSEventMask, NSMainMenuWindowLevel, NSPanel, NSResponder, NSScreen, NSView,
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
}

type Sender = Rc<dyn Fn(IslandEvent)>;

pub struct NotchPanel {
    panel: Retained<NSPanel>,
    web: Retained<IslandWebView>,
    /// Kept for as long as the panel: the page's messages, the event monitors and the observers
    /// stop when these go.
    _bridge: Retained<Bridge>,
    _monitors: Vec<Retained<AnyObject>>,
    _observers: Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>>,
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
}

impl NotchPanel {
    /// The panel, empty and hidden until [`NotchPanel::load`]. `send` hands what it hears to the
    /// app's event loop.
    pub fn new(mtm: MainThreadMarker, send: impl Fn(IslandEvent) + 'static) -> Self {
        let send: Sender = Rc::new(send);
        let frame = Rect::new(0.0, 0.0, island::PANEL_WIDTH, island::PANEL_HEIGHT);

        // A panel that never becomes key or activates `LoomWatch`, so whatever the person is
        // typing into keeps the keyboard, above the menu bar on every space and beside full-screen
        // apps, and that lets every click through until the pointer is on the island.
        let panel = NSPanel::initWithContentRect_styleMask_backing_defer(
            NSPanel::alloc(mtm),
            ns_rect(frame),
            NSWindowStyleMask::Borderless | NSWindowStyleMask::NonactivatingPanel,
            NSBackingStoreType::Buffered,
            false,
        );
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

    /// Put the panel on the screen the island lives on (`island::island_screen`), and say whether
    /// the menu bar face is still needed for a screen without a notch.
    pub fn place(&mut self, mtm: MainThreadMarker) -> bool {
        let screens = screens(mtm);
        let Some(screen) = island::island_screen(&screens) else {
            return true;
        };
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
        self.check_full_screen(mtm);
        island::menu_bar_face_shows(&screens)
    }

    /// Where the island and what dropped out of it are now.
    pub fn set_areas(&mut self, areas: Vec<Rect>) {
        self.areas = areas;
        self.pointer();
    }

    /// The pointer moved: the panel takes it only on the island, and the page hears which of its
    /// areas it is on.
    pub fn pointer(&mut self) {
        let at = NSEvent::mouseLocation();
        let (x, y) = island::in_panel(self.frame, at.x, at.y);
        self.set_area(island::area_under(&self.areas, x, y));
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
            self.panel.setIgnoresMouseEvents(area.is_none());
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
    let mut kept = Vec::new();
    kept.extend(NSEvent::addGlobalMonitorForEventsMatchingMask_handler(
        moved, &pointer,
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

/// `kCGEventSourceStateCombinedSessionState` and `kCGAnyInputEventType`.
const COMBINED_SESSION_STATE: i32 = 0;
const ANY_INPUT_EVENT: u32 = u32::MAX;

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
}
