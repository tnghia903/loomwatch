use serde_json::json;

use super::super::{Kept, read as read_widget, read_state, showed, shown};
use super::*;

#[test]
fn a_date_is_a_year_a_month_or_a_day_that_exists() {
    let when = |written: &str| read_date(written).map(When::kept);
    assert_eq!(when("1997"), Ok("1997".to_owned()));
    assert_eq!(when(" 1997-6 "), Ok("1997-06".to_owned()));
    assert_eq!(when("1997-06-26"), Ok("1997-06-26".to_owned()));
    assert_eq!(when("2024-02-29"), Ok("2024-02-29".to_owned()));
    assert_eq!(when("-500"), Ok("-500".to_owned()));
    assert_eq!(when("44"), Ok("44".to_owned()));
    assert!(
        when("2023-02-29")
            .unwrap_err()
            .contains("that month has days 01 to 28")
    );
    assert!(when("1900-02-29").is_err());
    assert!(when("2000-02-29").is_ok());
    assert!(when("1997-13").unwrap_err().contains("a month is 01 to 12"));
    assert!(when("1997-00").unwrap_err().contains("a month is 01 to 12"));
    assert!(
        when("1997-06-00")
            .unwrap_err()
            .contains("that month has days 01 to 30")
    );
    assert!(when("1997-04-31").is_err());
    assert!(when("0").unwrap_err().contains("there is no year 0"));
    assert!(when("-500-03").unwrap_err().contains("without a month"));
    for wrong in [
        "June 1997",
        "1997/06/26",
        "26-06-1997",
        "19970",
        "",
        "1997-06-26-1",
        "1997--06",
    ] {
        assert!(when(wrong).is_err(), "{wrong}");
    }
    assert_eq!(read_date("-500").map(When::said), Ok("500 BC".to_owned()));
}

/// When the Harry Potter books came out, given out of order, one by its day.
fn books() -> Value {
    json!({
        "kind": "timeline",
        "title": "The Harry Potter books",
        "events": [
            {"date": "2000", "label": "Goblet of Fire"},
            {"date": "1997-06-26", "label": "Philosopher's Stone", "note": "In the UK"},
            {"date": "1998", "label": "Chamber of Secrets"},
            {"date": "1997", "label": "Written down"}
        ]
    })
}

#[test]
fn a_timelines_events_are_put_in_date_order_with_their_dates_written_one_way() {
    let widget = read_widget(&books()).expect("a good timeline");
    let Widget::Timeline { events, .. } = &widget else {
        panic!("a timeline");
    };
    assert_eq!(
        events
            .iter()
            .map(|event| (event.date.as_str(), event.label.as_str()))
            .collect::<Vec<_>>(),
        [
            ("1997", "Written down"),
            ("1997-06-26", "Philosopher's Stone"),
            ("1998", "Chamber of Secrets"),
            ("2000", "Goblet of Fire"),
        ]
    );
    // The agent hears them in the order they show, so its words follow it.
    assert_eq!(
        shown(&widget, 2)["order"],
        "1997 Written down; 1997-06-26 Philosopher's Stone; 1998 Chamber of Secrets; 2000 Goblet \
         of Fire"
    );
    assert!(read_state(&widget, &json!({"checked": []})).is_err());
}

#[test]
fn the_next_run_reads_a_long_timeline_short() {
    let events: Vec<Value> = (0..10)
        .map(|at| json!({"date": format!("{}", -550 + at * 100), "label": format!("Event {at}")}))
        .collect();
    let widget =
        read_widget(&json!({"kind": "timeline", "title": "Ten centuries", "events": events}))
            .expect("a good timeline");
    let kept = Kept {
        n: 1,
        line: None,
        spec: widget,
        state: None,
        changed_at: None,
    };
    assert_eq!(
        showed(&[kept]).unwrap(),
        "[Under this answer: a timeline \"Ten centuries\" (550 BC Event 0; 450 BC Event 1; 350 BC \
         Event 2; 250 BC Event 3; 150 BC Event 4; 50 BC Event 5; 50 Event 6; 150 Event 7; and 2 \
         more).]"
    );
}

#[test]
fn events_on_the_same_date_keep_the_order_given() {
    let widget = read_widget(&json!({
        "kind": "timeline", "title": "One busy day",
        "events": [
            {"date": "2026-12-05", "label": "Fly to Tokyo"},
            {"date": "2026-12-01", "label": "Pack"},
            {"date": "2026-12-05", "label": "Check in"},
            {"date": "2026-12-05", "label": "Land at Narita"}
        ]
    }))
    .expect("a good timeline");
    let Widget::Timeline { events, .. } = &widget else {
        panic!("a timeline");
    };
    assert_eq!(
        events
            .iter()
            .map(|event| event.label.as_str())
            .collect::<Vec<_>>(),
        ["Pack", "Fly to Tokyo", "Check in", "Land at Narita"]
    );
}

#[test]
fn a_timeline_with_a_date_it_cant_read_says_which() {
    let mut timeline = books();
    timeline["events"][2]["date"] = json!("Summer 1998");
    let refused = read_widget(&timeline).expect_err("refused");
    assert!(
        refused.starts_with("events 3: date \"Summer 1998\" isn't a date"),
        "{refused}"
    );
}
