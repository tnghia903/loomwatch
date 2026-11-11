//! A calendar (ADR 0114, amended 11 November): a day, or a few, of the person's calendar, each
//! booking at its time and the free time between them, such as "am I free on Saturday" or a week's
//! plans. `LoomWatch` reads each day and time, puts the bookings in order and works out the free time
//! in the hours shown, and tells the agent, so its words agree with the calendar. The app draws
//! each day as a column of hours (`ui/src/lib/widgets/calendar.ts`). To look at: nothing is kept.

use chrono::{Datelike, NaiveDate};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{Widget, limits, list, optional_text, text};

/// One booking: its day, when it starts and ends in minutes from midnight (none for one that
/// lasts all day), what it is and where.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Booking {
    pub(crate) day: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) start: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) end: Option<String>,
    pub(crate) label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) place: Option<String>,
}

/// The hours of each day it shows and finds free time in, as `HH:MM`: 08:00 to 22:00 unless the
/// agent says, and widened to take in any booking outside them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Hours {
    pub(crate) from: String,
    pub(crate) to: String,
}

/// The day's shown hours when the agent gives none: waking hours.
const DAY_FROM: u16 = 8 * 60;
const DAY_TO: u16 = 22 * 60;
/// Free time shorter than this is not worth saying.
const SHORTEST_FREE: u16 = 30;

/// A day written as `2026-11-14`.
fn date(written: &str) -> Result<NaiveDate, String> {
    NaiveDate::parse_from_str(written.trim(), "%Y-%m-%d")
        .map_err(|_| format!("\"{}\" isn't a day: write it as 2026-11-14", written.trim()))
}

/// A time written as `09:30` or `9:30`, 24-hour, in minutes from midnight; `24:00` is the day's
/// end.
fn minutes(written: &str) -> Option<u16> {
    let (hours, mins) = written.trim().split_once(':')?;
    let digits = |part: &str| part.bytes().all(|byte| byte.is_ascii_digit());
    if !(1..=2).contains(&hours.len()) || mins.len() != 2 || !digits(hours) || !digits(mins) {
        return None;
    }
    let (hours, mins): (u16, u16) = (hours.parse().ok()?, mins.parse().ok()?);
    let at = hours * 60 + mins;
    (mins < 60 && at <= 24 * 60).then_some(at)
}

fn time(value: &Value, field: &str) -> Result<Option<u16>, String> {
    match value.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(written)) => minutes(written).map(Some).ok_or_else(|| {
            format!("{field} \"{written}\" isn't a time: write it as 09:30, 24-hour")
        }),
        Some(_) => Err(format!("{field} is a time such as 09:30")),
    }
}

/// `HH:MM` for minutes from midnight.
pub(crate) fn clock(at: u16) -> String {
    format!("{:02}:{:02}", at / 60, at % 60)
}

pub(crate) fn read(arguments: &Value, title: String) -> Result<Widget, String> {
    let days = list(arguments, "days", limits::DAYS, |entry| match entry {
        Value::String(written) => date(written),
        _ => Err("a day is written as 2026-11-14".to_owned()),
    })?;
    for (at, shown) in days.iter().enumerate() {
        if days[..at].contains(shown) {
            return Err(format!("{shown} is there twice: give each day once"));
        }
    }
    let bookings = match arguments.get("bookings") {
        None | Some(Value::Null) => Vec::new(),
        Some(_) => list(arguments, "bookings", limits::BOOKINGS, |entry| {
            let on = date(&text(entry, "day", 1, 10)?)?;
            if !days.contains(&on) {
                return Err(format!("its day {on} isn't one of days: add it to days"));
            }
            let (start, end) = (time(entry, "start")?, time(entry, "end")?);
            match (start, end) {
                (Some(start), Some(end)) if end <= start => {
                    return Err(format!(
                        "it ends at {} before it starts at {}: give the end after the start, and \
                         split one that runs past midnight into two days",
                        clock(end),
                        clock(start)
                    ));
                }
                (Some(_), None) | (None, Some(_)) => {
                    return Err(
                        "give both its start and its end, or neither for one that lasts all day"
                            .to_owned(),
                    );
                }
                _ => {}
            }
            Ok(Booking {
                day: on.to_string(),
                start: start.map(clock),
                end: end.map(clock),
                label: text(entry, "label", 1, limits::BOOKING_LABEL_CHARS)?,
                place: optional_text(entry, "place", limits::BOOKING_PLACE_CHARS)?,
            })
        })?,
    };
    let hours = match arguments.get("hours") {
        None | Some(Value::Null) => None,
        Some(given) if given.is_object() => {
            let (from, to) = (time(given, "from")?, time(given, "to")?);
            match (from, to) {
                (Some(from), Some(to)) if from < to => Some(Hours {
                    from: clock(from),
                    to: clock(to),
                }),
                (Some(_), Some(_)) => {
                    return Err("hours: from is before to, such as 07:00 to 24:00".to_owned());
                }
                _ => return Err("hours: give from and to, such as 07:00 to 24:00".to_owned()),
            }
        }
        Some(_) => return Err("hours is from and to, such as 07:00 to 24:00".to_owned()),
    };
    let zone = optional_text(arguments, "zone", limits::ZONE_CHARS)?;
    let mut days: Vec<String> = days.iter().map(NaiveDate::to_string).collect();
    days.sort();
    let mut bookings = bookings;
    bookings.sort_by(|a, b| {
        (&a.day, a.start.is_some(), &a.start, &a.end).cmp(&(
            &b.day,
            b.start.is_some(),
            &b.start,
            &b.end,
        ))
    });
    Ok(Widget::Calendar {
        title,
        days,
        bookings,
        hours,
        zone,
    })
}

/// The hours shown on `day`: the agent's, or waking hours, widened to take in its bookings.
pub(crate) fn shown(day: &str, bookings: &[Booking], hours: Option<&Hours>) -> (u16, u16) {
    let (mut from, mut to) = hours.map_or((DAY_FROM, DAY_TO), |hours| {
        (
            minutes(&hours.from).unwrap_or(DAY_FROM),
            minutes(&hours.to).unwrap_or(DAY_TO),
        )
    });
    for (start, end) in timed(day, bookings) {
        from = from.min(start);
        to = to.max(end);
    }
    (from, to)
}

/// `day`'s timed bookings, as minutes from midnight.
fn timed<'a>(day: &'a str, bookings: &'a [Booking]) -> impl Iterator<Item = (u16, u16)> + 'a {
    bookings
        .iter()
        .filter(move |booking| booking.day == day)
        .filter_map(|booking| {
            Some((
                minutes(booking.start.as_deref()?)?,
                minutes(booking.end.as_deref()?)?,
            ))
        })
}

/// `day`'s free time in its shown hours, each at least half an hour: none on a day booked all
/// day.
pub(crate) fn free(day: &str, bookings: &[Booking], hours: Option<&Hours>) -> Vec<(u16, u16)> {
    if bookings
        .iter()
        .any(|booking| booking.day == day && booking.start.is_none())
    {
        return Vec::new();
    }
    let (from, to) = shown(day, bookings, hours);
    let mut busy: Vec<(u16, u16)> = timed(day, bookings).collect();
    busy.sort_unstable();
    let mut gaps = Vec::new();
    let mut at = from;
    for (start, end) in busy {
        if start > at && start - at >= SHORTEST_FREE {
            gaps.push((at, start));
        }
        at = at.max(end);
    }
    if to > at && to - at >= SHORTEST_FREE {
        gaps.push((at, to));
    }
    gaps
}

/// A day as the person reads it: `Sat 14 Nov`.
pub(crate) fn said(day: &str) -> String {
    NaiveDate::parse_from_str(day, "%Y-%m-%d").map_or_else(
        |_| day.to_owned(),
        |date| {
            const WEEKDAYS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
            const MONTHS: [&str; 12] = [
                "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
            ];
            format!(
                "{} {} {}",
                WEEKDAYS[date.weekday().num_days_from_monday() as usize],
                date.day(),
                MONTHS[date.month0() as usize]
            )
        },
    )
}

/// What the agent is told of the calendar it showed, so its words agree with it: each day's
/// bookings and its free time in the hours shown, "Sat 14 Nov (08:00–23:00): Study @ Home
/// 10:00–15:00, Study @ Home 19:00–23:00; free 08:00–10:00, 15:00–19:00".
pub(crate) fn line(days: &[String], bookings: &[Booking], hours: Option<&Hours>) -> String {
    days.iter()
        .map(|day| {
            let (from, to) = shown(day, bookings, hours);
            let booked: Vec<String> = bookings
                .iter()
                .filter(|booking| &booking.day == day)
                .map(|booking| match (&booking.start, &booking.end) {
                    (Some(start), Some(end)) => format!("{} {start}–{end}", booking.label),
                    _ => format!("{} all day", booking.label),
                })
                .collect();
            let free: Vec<String> = free(day, bookings, hours)
                .into_iter()
                .map(|(start, end)| format!("{}–{}", clock(start), clock(end)))
                .collect();
            let free = if free.is_empty() {
                "no free time".to_owned()
            } else if booked.is_empty() {
                "free all of it".to_owned()
            } else {
                format!("free {}", free.join(", "))
            };
            let booked = if booked.is_empty() {
                "nothing booked".to_owned()
            } else {
                booked.join(", ")
            };
            format!(
                "{} ({}–{}): {booked}; {free}",
                said(day),
                clock(from),
                clock(to)
            )
        })
        .collect::<Vec<_>>()
        .join(". ")
}

#[cfg(test)]
mod tests;
