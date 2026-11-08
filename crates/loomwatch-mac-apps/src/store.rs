//! `EventKit`'s store, and asking macOS for Calendar or Reminders.
#![allow(unsafe_code)]

use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::Bool;
use objc2_event_kit::{EKAuthorizationStatus, EKEntityType, EKEventStore};
use objc2_foundation::NSError;

/// How long macOS's question may wait for the person.
pub const ASKING: Duration = Duration::from_secs(180);

#[derive(Debug, Clone, Copy)]
pub enum Kind {
    Events,
    Reminders,
}

impl Kind {
    const fn entity(self) -> EKEntityType {
        match self {
            Self::Events => EKEntityType::Event,
            Self::Reminders => EKEntityType::Reminder,
        }
    }

    const fn app(self) -> &'static str {
        match self {
            Self::Events => "Calendars",
            Self::Reminders => "Reminders",
        }
    }
}

fn granted(kind: Kind) -> Option<bool> {
    // SAFETY: a class method that only reads the saved answer.
    let status = unsafe { EKEventStore::authorizationStatusForEntityType(kind.entity()) };
    if status == EKAuthorizationStatus::FullAccess {
        Some(true)
    } else if status == EKAuthorizationStatus::NotDetermined {
        None
    } else {
        Some(false)
    }
}

/// Whether `LoomWatch` may have `kind`, asking the person first if macOS never has.
pub fn access(kind: Kind) -> bool {
    if let Some(known) = granted(kind) {
        return known;
    }
    // SAFETY: a new store, used on this thread only.
    let store = unsafe { EKEventStore::new() };
    let (tell, answer) = mpsc::channel();
    let done = RcBlock::new(move |granted: Bool, _error: *mut NSError| {
        let _ = tell.send(granted.as_bool());
    });
    // SAFETY: the block lives until the end of this function, past the answer or the wait.
    unsafe {
        match kind {
            Kind::Events => {
                store.requestFullAccessToEventsWithCompletion(RcBlock::as_ptr(&done));
            }
            Kind::Reminders => {
                store.requestFullAccessToRemindersWithCompletion(RcBlock::as_ptr(&done));
            }
        }
    }
    answer.recv_timeout(ASKING).unwrap_or(false)
}

/// A store with `kind` in it, or what the person does to allow it.
pub fn open(kind: Kind) -> Result<Retained<EKEventStore>, String> {
    if granted(kind) == Some(true) {
        // SAFETY: a new store, used on this thread only.
        Ok(unsafe { EKEventStore::new() })
    } else {
        Err(format!(
            "macOS hasn't let LoomWatch see {}. The person can allow it in System Settings → \
             Privacy & Security → {} → LoomWatch, with Full Access.",
            kind.app().to_lowercase(),
            kind.app()
        ))
    }
}

/// An `NSError` in words.
pub fn said(error: &NSError) -> String {
    error.localizedDescription().to_string()
}
