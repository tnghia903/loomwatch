//! ⌘V and the other editing keys work in the box at the notch: pressed, each finds its item in the
//! app's main menu (`src/edit_keys.rs`) and sends its action to whatever is typed in. And ⌘Q, ⌘W,
//! ⌘H and ⌘M, meant for the app in front, find nothing.
//!
//! `AppKit` makes menus only on the main thread, where libtest never runs a test, so this test is a
//! program of its own (`harness = false`). Nothing is shown and the clipboard is never touched:
//! the action goes up to the app's delegate, which here only notes what reached it.
#![cfg_attr(target_os = "macos", allow(unsafe_code))]

#[cfg(target_os = "macos")]
#[path = "../src/edit_keys.rs"]
mod edit_keys;

#[cfg(target_os = "macos")]
mod mac {
    use std::cell::RefCell;

    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send};
    use objc2_app_kit::{
        NSApplication, NSApplicationActivationPolicy, NSApplicationDelegate,
        NSApplicationTerminateReply, NSEvent,
    };
    use objc2_core_graphics::{CGEvent, CGEventFlags};

    use crate::edit_keys;

    define_class!(
        // SAFETY: `NSObject` has no subclassing requirements, and `Heard` does not implement `Drop`.
        #[unsafe(super = NSObject)]
        #[thread_kind = MainThreadOnly]
        #[name = "LoomWatchEditKeysTestHeard"]
        #[ivars = RefCell<Vec<&'static str>>]
        struct Heard;

        impl Heard {
            #[unsafe(method(undo:))]
            fn undo(&self, _sender: Option<&AnyObject>) {
                self.heard("undo:");
            }
            #[unsafe(method(redo:))]
            fn redo(&self, _sender: Option<&AnyObject>) {
                self.heard("redo:");
            }
            #[unsafe(method(cut:))]
            fn cut(&self, _sender: Option<&AnyObject>) {
                self.heard("cut:");
            }
            #[unsafe(method(copy:))]
            fn copy(&self, _sender: Option<&AnyObject>) {
                self.heard("copy:");
            }
            #[unsafe(method(paste:))]
            fn paste(&self, _sender: Option<&AnyObject>) {
                self.heard("paste:");
            }
            #[unsafe(method(pasteAsPlainText:))]
            fn paste_as_plain_text(&self, _sender: Option<&AnyObject>) {
                self.heard("pasteAsPlainText:");
            }
            #[unsafe(method(selectAll:))]
            fn select_all(&self, _sender: Option<&AnyObject>) {
                self.heard("selectAll:");
            }
            #[unsafe(method(performClose:))]
            fn perform_close(&self, _sender: Option<&AnyObject>) {
                self.heard("performClose:");
            }
        }

        // SAFETY: `NSObjectProtocol` has no safety requirements.
        unsafe impl NSObjectProtocol for Heard {}

        // SAFETY: the method's signature is `NSApplicationDelegate`'s.
        unsafe impl NSApplicationDelegate for Heard {
            /// A Quit in the menu would end this program, and the test with it, as if it passed.
            #[unsafe(method(applicationShouldTerminate:))]
            fn should_terminate(&self, _sender: &NSApplication) -> NSApplicationTerminateReply {
                self.heard("terminate:");
                NSApplicationTerminateReply::TerminateCancel
            }

            #[unsafe(method(applicationWillHide:))]
            fn will_hide(&self, _notification: &AnyObject) {
                self.heard("hide:");
            }
        }
    );

    impl Heard {
        fn new(mtm: MainThreadMarker) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(RefCell::new(Vec::new()));
            // SAFETY: `NSObject`'s `init`.
            unsafe { msg_send![super(this), init] }
        }

        fn heard(&self, action: &'static str) {
            self.ivars().borrow_mut().push(action);
        }

        fn take(&self) -> Vec<&'static str> {
            std::mem::take(&mut *self.ivars().borrow_mut())
        }
    }

    /// The key at `code` on a US keyboard pressed with ⌘ and `flags`, made as the keyboard makes
    /// it: `AppKit` tells ⇧⌘Z from ⌘Z by the key, through the keyboard's layout, which an `NSEvent`
    /// made up from letters lacks. `letter` is what the key types, to say so if this Mac's layout
    /// puts another letter there.
    fn key(letter: &str, code: u16, flags: CGEventFlags) -> Retained<NSEvent> {
        let event = CGEvent::new_keyboard_event(None, code, true).expect("a key event");
        CGEvent::set_flags(Some(&event), flags | CGEventFlags::MaskCommand);
        let event = NSEvent::eventWithCGEvent(&event).expect("a key event");
        let typed = event
            .charactersIgnoringModifiers()
            .map(|typed| typed.to_string().to_lowercase());
        assert_eq!(
            typed.as_deref(),
            Some(letter),
            "this test presses keys where they are on a US keyboard, and this Mac's layout types \
             something else there"
        );
        event
    }

    pub fn run() {
        let mtm = MainThreadMarker::new().expect("a test program's main runs on the main thread");
        let app = NSApplication::sharedApplication(mtm);
        // No Dock icon and no menu bar: the test is never seen.
        app.setActivationPolicy(NSApplicationActivationPolicy::Prohibited);
        let heard = Heard::new(mtm);
        app.setDelegate(Some(ProtocolObject::from_ref(&*heard)));

        let _edit_keys = edit_keys::install().expect("the Edit menu is made");
        let menu = app.mainMenu().expect("the app has a main menu");

        let none = CGEventFlags::empty();
        let shift = CGEventFlags::MaskShift;
        let editing = [
            ("⌘Z", key("z", 6, none), "undo:"),
            ("⇧⌘Z", key("z", 6, shift), "redo:"),
            ("⌘X", key("x", 7, none), "cut:"),
            ("⌘C", key("c", 8, none), "copy:"),
            ("⌘V", key("v", 9, none), "paste:"),
            (
                "⌥⇧⌘V",
                key("v", 9, shift | CGEventFlags::MaskAlternate),
                "pasteAsPlainText:",
            ),
            ("⌘A", key("a", 0, none), "selectAll:"),
        ];
        for (name, event, action) in editing {
            assert!(
                menu.performKeyEquivalent(&event),
                "{name} finds nothing in the main menu"
            );
            assert_eq!(heard.take(), [action], "{name} sends the wrong action");
            println!("{name} sends {action}");
        }

        // The box takes the keyboard while the app in front still looks as if it had it.
        let elsewhere = [
            ("⌘Q", key("q", 12, none)),
            ("⌘W", key("w", 13, none)),
            ("⌘H", key("h", 4, none)),
            ("⌘M", key("m", 46, none)),
        ];
        for (name, event) in elsewhere {
            assert!(
                !menu.performKeyEquivalent(&event),
                "{name} is taken by LoomWatch's menu"
            );
            assert_eq!(heard.take(), Vec::<&str>::new(), "{name} did something");
            println!("{name} finds nothing");
        }
    }
}

#[cfg(target_os = "macos")]
fn main() {
    mac::run();
}

// The editing keys are a Mac menu; elsewhere there is nothing to check.
#[cfg(not(target_os = "macos"))]
fn main() {}
