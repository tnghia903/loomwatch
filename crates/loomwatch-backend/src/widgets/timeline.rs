//! A timeline (ADR 0114, amended 8 November): events on their dates, such as a history or a plan
//! with deadlines. `LoomWatch` reads each date, puts the events in date order and writes each date
//! one way (`1997`, `1997-06`, `1997-06-26`, `-500` for 500 BC), and the app spaces them by the time
//! between them and says how long each gap is (`ui/src/lib/widgets/timeline.ts`). To look at:
//! nothing is kept.

use std::fmt::Write as _;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{Widget, limits, list, optional_text, text};

/// One event: its date as `LoomWatch` writes it, what happened or is due, and a few words more.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Event {
    pub(crate) date: String,
    pub(crate) label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) note: Option<String>,
}

/// A date read: a year, below zero before year 1, and its month and day when it has them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct When {
    pub(crate) year: i32,
    pub(crate) month: Option<u8>,
    pub(crate) day: Option<u8>,
}

impl When {
    /// As `LoomWatch` keeps it: `1997`, `1997-06`, `1997-06-26` or `-500`.
    fn kept(self) -> String {
        match (self.month, self.day) {
            (Some(month), Some(day)) => format!("{}-{month:02}-{day:02}", self.year),
            (Some(month), None) => format!("{}-{month:02}", self.year),
            _ => self.year.to_string(),
        }
    }

    /// As the agent reads it in a line: `1997-06-26`, or `500 BC` for a year before year 1.
    pub(crate) fn said(self) -> String {
        if self.year < 0 {
            format!("{} BC", self.year.unsigned_abs())
        } else {
            self.kept()
        }
    }
}

fn leap(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in(year: i32, month: u8) -> u8 {
    match month {
        2 if leap(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// A date as the agent wrote it, read: `1997`, `1997-06`, `1997-06-26` (a month or day of one
/// digit too), or a year below zero for one before year 1, `-500` for 500 BC.
///
/// # Errors
///
/// Anything else, a year 0, a month or day that doesn't exist, or a month on a year before year 1.
pub(crate) fn read_date(written: &str) -> Result<When, String> {
    let shape = || {
        format!(
            "date \"{written}\" isn't a date: give a year such as 1997, a month such as 1997-06, \
             a day such as 1997-06-26, or a year below zero before year 1, such as -500 for \
             500 BC"
        )
    };
    let written = written.trim();
    let (before, rest) = match written.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, written),
    };
    let mut parts = rest.split('-');
    let year = parts.next().unwrap_or_default();
    let digits = |part: &str, most: usize| {
        !part.is_empty() && part.len() <= most && part.bytes().all(|byte| byte.is_ascii_digit())
    };
    if !digits(year, if before { 5 } else { 4 }) {
        return Err(shape());
    }
    let year: i32 = year.parse().map_err(|_| shape())?;
    if year == 0 {
        return Err("there is no year 0: 1 BC is -1, and AD 1 is 1".to_owned());
    }
    let year = if before { -year } else { year };
    let month = parts.next();
    let day = parts.next();
    if parts.next().is_some() {
        return Err(shape());
    }
    if before && month.is_some() {
        return Err(format!(
            "date \"{written}\": a year before year 1 is given on its own, without a month"
        ));
    }
    let month = match month {
        None => None,
        Some(month) if digits(month, 2) => {
            let month: u8 = month.parse().map_err(|_| shape())?;
            if !(1..=12).contains(&month) {
                return Err(format!("date \"{written}\": a month is 01 to 12"));
            }
            Some(month)
        }
        Some(_) => return Err(shape()),
    };
    let day = match (day, month) {
        (None, _) => None,
        (Some(day), Some(month)) if digits(day, 2) => {
            let day: u8 = day.parse().map_err(|_| shape())?;
            let most = days_in(year, month);
            if day == 0 || day > most {
                return Err(format!(
                    "date \"{written}\": that month has days 01 to {most}"
                ));
            }
            Some(day)
        }
        _ => return Err(shape()),
    };
    Ok(When { year, month, day })
}

/// A timeline, read and checked, its events in date order (those on the same date as given).
pub(crate) fn read(arguments: &Value, title: String) -> Result<Widget, String> {
    let mut events = list(arguments, "events", limits::EVENTS, |event| {
        let date = event
            .get("date")
            .and_then(Value::as_str)
            .ok_or("date is missing: give it as text, such as 1997 or 1997-06-26")?;
        let when = read_date(date)?;
        Ok((
            when,
            Event {
                date: when.kept(),
                label: text(event, "label", 1, limits::EVENT_LABEL_CHARS)?,
                note: optional_text(event, "note", limits::EVENT_NOTE_CHARS)?,
            },
        ))
    })?;
    // A year on its own stands at its start, before the months of that year.
    events.sort_by_key(|(when, _)| (when.year, when.month.unwrap_or(0), when.day.unwrap_or(0)));
    Ok(Widget::Timeline {
        title,
        events: events.into_iter().map(|(_, event)| event).collect(),
    })
}

/// "1997 Philosopher's Stone; 1998 Chamber of Secrets; and 5 more": a timeline's events in a line,
/// at most [`LINE_EVENTS`] before "and N more".
pub(crate) fn line(events: &[Event]) -> String {
    let mut line = events
        .iter()
        .take(LINE_EVENTS)
        .map(|event| {
            let date = read_date(&event.date).map_or_else(|_| event.date.clone(), When::said);
            format!("{date} {}", event.label)
        })
        .collect::<Vec<_>>()
        .join("; ");
    let more = events.len().saturating_sub(LINE_EVENTS);
    if more > 0 {
        let _ = write!(line, "; and {more} more");
    }
    line
}

/// How many events the next run reads in a timeline's line.
const LINE_EVENTS: usize = 8;

#[cfg(test)]
mod tests;
