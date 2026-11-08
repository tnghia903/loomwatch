//! Calendar's events and Reminders' reminders, through `EventKit`.
#![allow(unsafe_code)]

use std::sync::mpsc;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2_event_kit::{EKCalendar, EKEntityType, EKEvent, EKEventStore, EKReminder, EKSpan};
use objc2_foundation::{NSArray, NSCalendar, NSCalendarUnit, NSDate, NSDateComponents, NSString};
use serde_json::{Value, json};

use crate::args::{Args, Moment, shown};
use crate::store::{self, ASKING, Kind, said};

/// The longest stretch one search of events covers.
const MAX_DAYS: f64 = 366.0;
const DAY: f64 = 86_400.0;
/// The most of an event's or reminder's notes an answer carries.
const MAX_NOTES_CHARS: usize = 1000;

pub fn events(action: &str, args: &Args) -> Result<Value, String> {
    let store = store::open(Kind::Events)?;
    match action {
        "list_calendars" => Ok(calendars(&store, EKEntityType::Event)),
        "find_events" => find_events(&store, args),
        "add_event" => add_event(&store, args),
        "change_event" => change_event(&store, args),
        "delete_event" => delete_event(&store, args),
        _ => Err(no_action(action)),
    }
}

pub fn reminders(action: &str, args: &Args) -> Result<Value, String> {
    let store = store::open(Kind::Reminders)?;
    match action {
        "list_lists" => Ok(calendars(&store, EKEntityType::Reminder)),
        "find_reminders" => find_reminders(&store, args),
        "add_reminder" => add_reminder(&store, args),
        "change_reminder" => change_reminder(&store, args, None),
        "complete_reminder" => {
            change_reminder(&store, args, Some(args.flag("done").unwrap_or(true)))
        }
        "delete_reminder" => delete_reminder(&store, args),
        _ => Err(no_action(action)),
    }
}

fn no_action(action: &str) -> String {
    format!("There's no action called {action} here.")
}

fn text(string: &NSString) -> String {
    string.to_string()
}

fn cut(text: &str, chars: usize) -> String {
    if text.chars().count() <= chars {
        text.to_owned()
    } else {
        let mut kept: String = text.chars().take(chars).collect();
        kept.push('…');
        kept
    }
}

fn date(moment: Moment) -> Retained<NSDate> {
    NSDate::dateWithTimeIntervalSince1970(moment.seconds)
}

fn calendars(store: &EKEventStore, entity: EKEntityType) -> Value {
    // SAFETY: reading the store on the thread that made it.
    let all = unsafe { store.calendarsForEntityType(entity) };
    let listed: Vec<Value> = all
        .iter()
        .map(|calendar| {
            // SAFETY: as above.
            unsafe {
                json!({
                    "id": text(&calendar.calendarIdentifier()),
                    "name": text(&calendar.title()),
                    "canChange": calendar.allowsContentModifications(),
                })
            }
        })
        .collect();
    json!(listed)
}

/// The calendar (or list) called `wanted`, by name ignoring case, or by id.
fn calendar_named(
    store: &EKEventStore,
    entity: EKEntityType,
    wanted: &str,
) -> Result<Retained<EKCalendar>, String> {
    // SAFETY: reading the store on the thread that made it.
    let all = unsafe { store.calendarsForEntityType(entity) };
    all.iter()
        .find(|calendar| unsafe {
            text(&calendar.title()).eq_ignore_ascii_case(wanted)
                || text(&calendar.calendarIdentifier()) == wanted
        })
        .ok_or_else(|| {
            let names: Vec<String> = all
                .iter()
                .map(|calendar| unsafe { text(&calendar.title()) })
                .collect();
            format!(
                "There's no {wanted:?} here. There are: {}.",
                names.join(", ")
            )
        })
}

fn event_json(event: &EKEvent) -> Value {
    // SAFETY: reading an event on the thread whose store fetched it.
    unsafe {
        json!({
            "id": event.eventIdentifier().map(|id| text(&id)),
            "title": text(&event.title()),
            "start": shown(event.startDate().timeIntervalSince1970()),
            "end": shown(event.endDate().timeIntervalSince1970()),
            "allDay": event.isAllDay(),
            "calendar": event.calendar().map(|calendar| text(&calendar.title())),
            "location": event.location().map(|location| text(&location)),
            "notes": event.notes().map(|notes| cut(&text(&notes), MAX_NOTES_CHARS)),
            "repeats": event.hasRecurrenceRules(),
        })
    }
}

fn find_events(store: &EKEventStore, args: &Args) -> Result<Value, String> {
    let now = NSDate::now().timeIntervalSince1970();
    let from = args.time("from")?.map_or(now, |from| from.seconds);
    let to = args.time("to")?.map_or(from + 7.0 * DAY, |to| {
        if to.day_only {
            to.seconds + DAY
        } else {
            to.seconds
        }
    });
    if to <= from {
        return Err("`to` should come after `from`.".to_owned());
    }
    if to - from > MAX_DAYS * DAY {
        return Err(format!(
            "Look at {MAX_DAYS} days or fewer at a time; split a longer stretch into parts."
        ));
    }
    let within = args
        .text("calendar")
        .map(|name| calendar_named(store, EKEntityType::Event, &name))
        .transpose()?
        .map(|calendar| NSArray::from_retained_slice(&[calendar]));
    let wanted = args.text("text").map(|text| text.to_lowercase());
    let limit = args.limit();
    // SAFETY: a predicate and a fetch on the store's own thread.
    let found = unsafe {
        let predicate = store.predicateForEventsWithStartDate_endDate_calendars(
            &NSDate::dateWithTimeIntervalSince1970(from),
            &NSDate::dateWithTimeIntervalSince1970(to),
            within.as_deref(),
        );
        store.eventsMatchingPredicate(&predicate)
    };
    let mut events: Vec<Retained<EKEvent>> = found.to_vec();
    // SAFETY: reading events on the thread whose store fetched them.
    events.sort_by(|one, other| unsafe {
        one.startDate()
            .timeIntervalSince1970()
            .total_cmp(&other.startDate().timeIntervalSince1970())
    });
    let matching: Vec<Value> = events
        .iter()
        .filter(|event| {
            wanted.as_ref().is_none_or(|wanted| unsafe {
                let mut words = text(&event.title());
                if let Some(location) = event.location() {
                    words.push(' ');
                    words.push_str(&text(&location));
                }
                if let Some(notes) = event.notes() {
                    words.push(' ');
                    words.push_str(&text(&notes));
                }
                words.to_lowercase().contains(wanted.as_str())
            })
        })
        .map(|event| event_json(event))
        .collect();
    let more = matching.len() > limit;
    Ok(json!({
        "from": shown(from),
        "to": shown(to),
        "events": matching.into_iter().take(limit).collect::<Vec<_>>(),
        "more": more,
    }))
}

/// The event `id`, or, for a repeating one, its occurrence that starts at `occurrence` when given.
fn event_named(store: &EKEventStore, args: &Args) -> Result<Retained<EKEvent>, String> {
    let id = args.needed("id")?;
    let missing = || {
        format!(
            "There's no event with id {id}. Find it again with find_events; it may have been deleted."
        )
    };
    let Some(at) = args.time("occurrence")? else {
        // SAFETY: a lookup on the store's own thread.
        return unsafe { store.eventWithIdentifier(&NSString::from_str(&id)) }.ok_or_else(missing);
    };
    // SAFETY: as above.
    let found = unsafe {
        let predicate = store.predicateForEventsWithStartDate_endDate_calendars(
            &NSDate::dateWithTimeIntervalSince1970(at.seconds - 1.0),
            &NSDate::dateWithTimeIntervalSince1970(at.seconds + DAY),
            None,
        );
        store.eventsMatchingPredicate(&predicate)
    };
    found
        .iter()
        .find(|event| unsafe {
            event
                .eventIdentifier()
                .is_some_and(|other| text(&other) == id)
                && (event.startDate().timeIntervalSince1970() - at.seconds).abs() < 1.0
        })
        .ok_or_else(missing)
}

fn span(args: &Args) -> Result<EKSpan, String> {
    match args.text("which").as_deref() {
        None | Some("this") => Ok(EKSpan::ThisEvent),
        Some("future") => Ok(EKSpan::FutureEvents),
        Some(other) => Err(format!(
            "`which` is \"this\" (this one only) or \"future\" (this one and later ones), not {other:?}."
        )),
    }
}

/// Sets what `args` gives on `event`. `fresh`: it is a new event, so it needs a title and a start.
fn fill_event(
    store: &EKEventStore,
    event: &EKEvent,
    args: &Args,
    fresh: bool,
) -> Result<(), String> {
    let title = if fresh {
        Some(args.needed("title")?)
    } else {
        args.text("title")
    };
    let start = if fresh {
        Some(args.needed_time("start")?)
    } else {
        args.time("start")?
    };
    let end = args.time("end")?;
    let all_day = args
        .flag("all_day")
        .or_else(|| start.map(|start| start.day_only && fresh));
    let calendar = args
        .text("calendar")
        .map(|name| calendar_named(store, EKEntityType::Event, &name))
        .transpose()?;
    // SAFETY: changing an event on the thread whose store made or fetched it.
    unsafe {
        if let Some(title) = title {
            event.setTitle(Some(&NSString::from_str(&title)));
        }
        if let Some(all_day) = all_day {
            event.setAllDay(all_day);
        }
        if let Some(start) = start {
            let length =
                event.endDate().timeIntervalSince1970() - event.startDate().timeIntervalSince1970();
            event.setStartDate(Some(&date(start)));
            if end.is_none() {
                let length = if fresh || length <= 0.0 {
                    if event.isAllDay() { DAY } else { 3600.0 }
                } else {
                    length
                };
                event.setEndDate(Some(&NSDate::dateWithTimeIntervalSince1970(
                    start.seconds + length,
                )));
            }
        }
        if let Some(end) = end {
            let seconds = if end.day_only && event.isAllDay() {
                end.seconds + DAY
            } else {
                end.seconds
            };
            event.setEndDate(Some(&NSDate::dateWithTimeIntervalSince1970(seconds)));
        }
        if event.endDate().timeIntervalSince1970() < event.startDate().timeIntervalSince1970() {
            return Err("`end` should come after `start`.".to_owned());
        }
        if let Some(location) = args.text("location") {
            event.setLocation(Some(&NSString::from_str(&location)));
        }
        if let Some(notes) = args.text("notes") {
            event.setNotes(Some(&NSString::from_str(&notes)));
        }
        match calendar {
            Some(calendar) => event.setCalendar(Some(&calendar)),
            None if fresh => {
                let Some(calendar) = store.defaultCalendarForNewEvents() else {
                    return Err(
                        "This Mac has no calendar to add events to. Give `calendar`, from list_calendars."
                            .to_owned(),
                    );
                };
                event.setCalendar(Some(&calendar));
            }
            None => {}
        }
    }
    Ok(())
}

fn add_event(store: &EKEventStore, args: &Args) -> Result<Value, String> {
    // SAFETY: a new event in the store, on its own thread.
    let event = unsafe { EKEvent::eventWithEventStore(store) };
    fill_event(store, &event, args, true)?;
    // SAFETY: as above.
    unsafe { store.saveEvent_span_commit_error(&event, EKSpan::ThisEvent, true) }
        .map_err(|error| format!("Calendar didn't add it: {}", said(&error)))?;
    Ok(json!({ "added": event_json(&event) }))
}

fn change_event(store: &EKEventStore, args: &Args) -> Result<Value, String> {
    let event = event_named(store, args)?;
    fill_event(store, &event, args, false)?;
    let span = span(args)?;
    // SAFETY: saving an event the store fetched, on its own thread.
    unsafe { store.saveEvent_span_commit_error(&event, span, true) }
        .map_err(|error| format!("Calendar didn't change it: {}", said(&error)))?;
    Ok(json!({ "changed": event_json(&event) }))
}

fn delete_event(store: &EKEventStore, args: &Args) -> Result<Value, String> {
    let event = event_named(store, args)?;
    let gone = event_json(&event);
    let span = span(args)?;
    // SAFETY: as above.
    unsafe { store.removeEvent_span_commit_error(&event, span, true) }
        .map_err(|error| format!("Calendar didn't delete it: {}", said(&error)))?;
    Ok(json!({ "deleted": gone }))
}

fn components(moment: Moment) -> Retained<NSDateComponents> {
    let mut units = NSCalendarUnit::Year | NSCalendarUnit::Month | NSCalendarUnit::Day;
    if !moment.day_only {
        units |= NSCalendarUnit::Hour | NSCalendarUnit::Minute;
    }
    NSCalendar::currentCalendar().components_fromDate(units, &date(moment))
}

fn reminder_json(reminder: &EKReminder) -> Value {
    // SAFETY: reading a reminder on the thread whose store fetched it.
    unsafe {
        let due = reminder
            .dueDateComponents()
            .and_then(|due| NSCalendar::currentCalendar().dateFromComponents(&due))
            .map(|due| shown(due.timeIntervalSince1970()));
        json!({
            "id": text(&reminder.calendarItemIdentifier()),
            "title": text(&reminder.title()),
            "done": reminder.isCompleted(),
            "due": due,
            "list": reminder.calendar().map(|list| text(&list.title())),
            "notes": reminder.notes().map(|notes| cut(&text(&notes), MAX_NOTES_CHARS)),
            "priority": reminder.priority(),
        })
    }
}

fn find_reminders(store: &EKEventStore, args: &Args) -> Result<Value, String> {
    let within = args
        .text("list")
        .map(|name| calendar_named(store, EKEntityType::Reminder, &name))
        .transpose()?
        .map(|list| NSArray::from_retained_slice(&[list]));
    let done = args.flag("done").unwrap_or(false);
    let due_before = args.time("due_before")?;
    let wanted = args.text("text").map(|text| text.to_lowercase());
    let limit = args.limit();
    // SAFETY: a predicate on the store's own thread.
    let predicate = unsafe {
        if done {
            store.predicateForCompletedRemindersWithCompletionDateStarting_ending_calendars(
                None,
                None,
                within.as_deref(),
            )
        } else {
            store.predicateForIncompleteRemindersWithDueDateStarting_ending_calendars(
                None,
                due_before.map(date).as_deref(),
                within.as_deref(),
            )
        }
    };
    let (tell, answer) = mpsc::channel();
    let fetched = RcBlock::new(move |found: *mut NSArray<EKReminder>| {
        // SAFETY: EventKit hands over an array it keeps alive for the call, or nil.
        let listed: Vec<Value> = unsafe { found.as_ref() }
            .map(|found| {
                found
                    .iter()
                    .map(|reminder| reminder_json(&reminder))
                    .collect()
            })
            .unwrap_or_default();
        let _ = tell.send(listed);
    });
    // SAFETY: the block lives until this function ends, past the answer or the wait.
    let _fetch = unsafe { store.fetchRemindersMatchingPredicate_completion(&predicate, &fetched) };
    let mut found = answer
        .recv_timeout(ASKING)
        .map_err(|_| "Reminders didn't answer in time. Try again.".to_owned())?;
    if let Some(wanted) = wanted {
        found.retain(|reminder| {
            ["title", "notes"].iter().any(|field| {
                reminder[*field]
                    .as_str()
                    .is_some_and(|text| text.to_lowercase().contains(&wanted))
            })
        });
    }
    let more = found.len() > limit;
    found.truncate(limit);
    Ok(json!({ "reminders": found, "more": more }))
}

fn reminder_named(store: &EKEventStore, args: &Args) -> Result<Retained<EKReminder>, String> {
    let id = args.needed("id")?;
    // SAFETY: a lookup on the store's own thread.
    unsafe { store.calendarItemWithIdentifier(&NSString::from_str(&id)) }
        .and_then(|item| item.downcast::<EKReminder>().ok())
        .ok_or_else(|| {
            format!("There's no reminder with id {id}. Find it again with find_reminders; it may have been deleted.")
        })
}

fn fill_reminder(
    store: &EKEventStore,
    reminder: &EKReminder,
    args: &Args,
    fresh: bool,
) -> Result<(), String> {
    let title = if fresh {
        Some(args.needed("title")?)
    } else {
        args.text("title")
    };
    let due = args.time("due")?;
    let list = args
        .text("list")
        .map(|name| calendar_named(store, EKEntityType::Reminder, &name))
        .transpose()?;
    // SAFETY: changing a reminder on the thread whose store made or fetched it.
    unsafe {
        if let Some(title) = title {
            reminder.setTitle(Some(&NSString::from_str(&title)));
        }
        if let Some(due) = due {
            reminder.setDueDateComponents(Some(&components(due)));
        }
        if let Some(notes) = args.text("notes") {
            reminder.setNotes(Some(&NSString::from_str(&notes)));
        }
        if let Some(priority) = args.0.get("priority").and_then(Value::as_u64) {
            reminder.setPriority(usize::try_from(priority.min(9)).unwrap_or(0));
        }
        match list {
            Some(list) => reminder.setCalendar(Some(&list)),
            None if fresh => {
                let Some(list) = store.defaultCalendarForNewReminders() else {
                    return Err(
                        "This Mac has no list to add reminders to. Give `list`, from list_lists."
                            .to_owned(),
                    );
                };
                reminder.setCalendar(Some(&list));
            }
            None => {}
        }
    }
    Ok(())
}

fn add_reminder(store: &EKEventStore, args: &Args) -> Result<Value, String> {
    // SAFETY: a new reminder in the store, on its own thread.
    let reminder = unsafe { EKReminder::reminderWithEventStore(store) };
    fill_reminder(store, &reminder, args, true)?;
    // SAFETY: as above.
    unsafe { store.saveReminder_commit_error(&reminder, true) }
        .map_err(|error| format!("Reminders didn't add it: {}", said(&error)))?;
    Ok(json!({ "added": reminder_json(&reminder) }))
}

fn change_reminder(store: &EKEventStore, args: &Args, done: Option<bool>) -> Result<Value, String> {
    let reminder = reminder_named(store, args)?;
    if done.is_none() {
        fill_reminder(store, &reminder, args, false)?;
    }
    // SAFETY: changing and saving a reminder the store fetched, on its own thread.
    unsafe {
        if let Some(done) = done {
            reminder.setCompleted(done);
        }
        store.saveReminder_commit_error(&reminder, true)
    }
    .map_err(|error| format!("Reminders didn't change it: {}", said(&error)))?;
    Ok(json!({ "changed": reminder_json(&reminder) }))
}

fn delete_reminder(store: &EKEventStore, args: &Args) -> Result<Value, String> {
    let reminder = reminder_named(store, args)?;
    let gone = reminder_json(&reminder);
    // SAFETY: as above.
    unsafe { store.removeReminder_commit_error(&reminder, true) }
        .map_err(|error| format!("Reminders didn't delete it: {}", said(&error)))?;
    Ok(json!({ "deleted": gone }))
}
