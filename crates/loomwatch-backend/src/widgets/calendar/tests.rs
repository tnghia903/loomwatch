use serde_json::json;

use super::super::{Kept, read as read_widget, read_state, showed, shown};
use super::*;

/// A Saturday as an agent read it from the person's calendar: two study blocks.
fn saturday() -> Value {
    json!({
        "kind": "calendar",
        "title": "This Saturday",
        "zone": "Singapore time",
        "days": ["2026-11-14"],
        "hours": {"from": "07:00", "to": "24:00"},
        "bookings": [
            {"day": "2026-11-14", "start": "19:00", "end": "23:00", "label": "Study", "place": "Home"},
            {"day": "2026-11-14", "start": "10:00", "end": "15:00", "label": "Study", "place": "Home"}
        ]
    })
}

#[test]
fn a_calendar_puts_its_bookings_in_order_and_tells_the_agent_its_free_time() {
    let widget = read_widget(&saturday()).expect("a good calendar");
    let Widget::Calendar {
        days,
        bookings,
        hours,
        zone,
        ..
    } = &widget
    else {
        panic!("a calendar");
    };
    assert_eq!(days, &["2026-11-14"]);
    assert_eq!(
        bookings[0].start.as_deref(),
        Some("10:00"),
        "in order of their start"
    );
    assert_eq!(bookings[1].end.as_deref(), Some("23:00"));
    assert_eq!(hours.as_ref().map(|hours| hours.to.as_str()), Some("24:00"));
    assert_eq!(zone.as_deref(), Some("Singapore time"));
    // The agent hears the free time the calendar shows, so its words agree with it.
    assert_eq!(
        shown(&widget, 1)["free"],
        "Sat 14 Nov (07:00–24:00): Study 10:00–15:00, Study 19:00–23:00; free 07:00–10:00, \
         15:00–19:00, 23:00–24:00"
    );
    assert!(
        read_state(&widget, &json!({"checked": []})).is_err(),
        "a calendar keeps nothing"
    );
    let kept = serde_json::to_value(&widget).expect("kept");
    assert_eq!(kept["kind"], "calendar");
    assert_eq!(kept["bookings"][0]["place"], "Home");
    assert_eq!(kept["hours"]["from"], "07:00");
}

#[test]
fn a_free_day_shows_with_nothing_booked_and_waking_hours_unless_told() {
    let widget = read_widget(&json!({
        "kind": "calendar", "title": "This weekend", "days": ["2026-11-15", "2026-11-14"],
        "bookings": [{"day": "2026-11-14", "start": "06:30", "end": "09:00", "label": "Run"}]
    }))
    .expect("a free day is a calendar too");
    let Widget::Calendar { days, .. } = &widget else {
        panic!("a calendar")
    };
    assert_eq!(days, &["2026-11-14", "2026-11-15"], "in day order");
    assert_eq!(
        shown(&widget, 1)["free"],
        "Sat 14 Nov (06:30–22:00): Run 06:30–09:00; free 09:00–22:00. Sun 15 Nov (08:00–22:00): \
         nothing booked; free all of it",
        "waking hours, widened to take in the early run"
    );
}

#[test]
fn a_booking_all_day_leaves_no_free_time_and_short_gaps_are_not_free() {
    let widget = read_widget(&json!({
        "kind": "calendar", "title": "Next week", "days": ["2026-11-16", "2026-11-17"],
        "bookings": [
            {"day": "2026-11-16", "label": "Conference"},
            {"day": "2026-11-17", "start": "08:00", "end": "12:10", "label": "Workshop"},
            {"day": "2026-11-17", "start": "12:30", "end": "22:00", "label": "Visit"}
        ]
    }))
    .expect("a good calendar");
    assert_eq!(
        shown(&widget, 1)["free"],
        "Mon 16 Nov (08:00–22:00): Conference all day; no free time. Tue 17 Nov (08:00–22:00): \
         Workshop 08:00–12:10, Visit 12:30–22:00; no free time"
    );
}

#[test]
fn the_next_run_reads_a_calendars_days() {
    let kept = Kept {
        n: 1,
        line: None,
        spec: read_widget(&saturday()).expect("a good calendar"),
        state: None,
        changed_at: None,
    };
    let said = showed(&[kept]).unwrap();
    assert!(
        said.starts_with("[Under this answer: a calendar \"This Saturday\" (Sat 14 Nov"),
        "{said}"
    );
}

#[test]
fn a_day_or_time_it_cannot_read_is_refused_with_how_to_write_it() {
    let refused = |change: &dyn Fn(&mut Value)| {
        let mut calendar = saturday();
        change(&mut calendar);
        read_widget(&calendar).expect_err("refused")
    };
    let error = refused(&|c| c["days"] = json!(["14/11/2026"]));
    assert!(
        error.contains("isn't a day: write it as 2026-11-14"),
        "{error}"
    );
    let error = refused(&|c| c["bookings"][0]["start"] = json!("7pm"));
    assert!(
        error.contains("isn't a time: write it as 09:30, 24-hour"),
        "{error}"
    );
    let error = refused(&|c| c["bookings"][0]["end"] = json!("18:00"));
    assert!(
        error.contains("ends at 18:00 before it starts at 19:00"),
        "{error}"
    );
    let error = refused(&|c| c["bookings"][0]["day"] = json!("2026-11-15"));
    assert!(error.contains("isn't one of days"), "{error}");
    let error = refused(&|c| {
        c["bookings"][0]
            .as_object_mut()
            .expect("object")
            .remove("end");
    });
    assert!(error.contains("give both its start and its end"), "{error}");
    let error = refused(&|c| c["days"] = json!(["2026-11-14", "2026-11-14"]));
    assert!(error.contains("there twice"), "{error}");
    let error = refused(&|c| c["hours"] = json!({"from": "22:00", "to": "08:00"}));
    assert!(error.contains("from is before to"), "{error}");
    assert_eq!(minutes("9:30"), Some(570));
    assert_eq!(minutes("24:00"), Some(1440));
    assert_eq!(minutes("24:30"), None);
    assert_eq!(minutes("12:60"), None);
}
