//! A connected tool's call, said in plain words for the card that asks first (ADR 0040, 0069).
//!
//! The ask used to show the call's arguments as one line of JSON, keys in alphabetical order and
//! times as ISO strings: `{"end":"2026-11-14T16:00:00","start":…,"title":"Upper A"}`. A newcomer
//! can't judge that. Here the same arguments read as "Upper A · Sat 14 Nov, 15:00–16:00 ·
//! Calendar: Home": what the call is about first, then when, then short facts, then long words.
//! What `LoomWatch` knows besides the arguments (the [`Known`] the tool's host gives) makes it
//! plainer: the name an earlier result gave the item an id points to, and an option's own words.
//! Nothing is dropped silently: [`sends`] lists every argument, said the same way, for the card's
//! "Everything it would send".

use chrono::{DateTime, Datelike, NaiveDate, NaiveDateTime, TimeZone};
use serde_json::{Map, Value, json};

/// What a call is about, when its arguments name it: the first of these that holds words.
const LEAD: &[&str] = &[
    "title", "name", "summary", "subject", "query", "question", "text", "message",
];
/// When a call starts and ends, as tools name the pair.
const SPANS: &[(&str, &str)] = &[
    ("start", "end"),
    ("starts_at", "ends_at"),
    ("start_time", "end_time"),
    ("start_date", "end_date"),
    ("startDate", "endDate"),
    ("from", "to"),
];
/// A single time said without its name when it takes the "when" place: what it names is plain.
const PLAIN_TIMES: &[&str] = &[
    "start",
    "starts_at",
    "start_time",
    "start_date",
    "startDate",
    "date",
    "when",
    "at",
    "occurrence",
];
/// The longest one value is said on the line; the rest is under "Everything it would send".
const VALUE_CHARS: usize = 80;
/// A value longer than this goes after the short facts on the line.
const SHORT_CHARS: usize = 40;
/// How many items of a list are named on the line before "and N more".
const LIST_ITEMS: usize = 3;
/// The longest a value is said under "Everything it would send".
const SENT_VALUE_CHARS: usize = 2_000;
/// Past this, the rest of what a call sends isn't listed beside the ask.
const SENT_CHARS: usize = 16_000;

/// What `LoomWatch` knows about a call besides its arguments, from the tool's host
/// (`HostTools::known`), as the request's `rawInput.known` carries it.
#[derive(Debug, Default, Clone, Copy)]
pub(super) struct Known<'a> {
    /// What the item the call's id points to is called, from an earlier result: "Upper A".
    pub about: Option<&'a str>,
    /// An option's own words, by argument: `which` → "This one and every later one".
    pub options: Option<&'a Map<String, Value>>,
}

impl<'a> Known<'a> {
    pub(super) fn of(known: Option<&'a Value>) -> Self {
        Self {
            about: known
                .and_then(|known| known.get("about"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|about| !about.is_empty()),
            options: known
                .and_then(|known| known.get("options"))
                .and_then(Value::as_object),
        }
    }

    fn option(&self, key: &str) -> Option<&'a str> {
        self.options?.get(key)?.as_str()
    }
}

/// `arguments` said plainly, or `None` when it holds nothing to say. Times with an offset are said
/// in `now`'s time zone, the person's; a time without one is said as written. A year is said only
/// when it isn't `now`'s.
pub(super) fn said<Tz: TimeZone>(
    arguments: &Map<String, Value>,
    known: Known<'_>,
    now: &DateTime<Tz>,
) -> Option<String> {
    let order = Order::of(arguments, known, now);
    let mut parts = Vec::new();
    if let Some(about) = known.about {
        parts.push(cut(about, VALUE_CHARS));
    }
    if let Some(key) = order.lead {
        parts.push(cut(
            &words(&arguments[key]).unwrap_or_default(),
            VALUE_CHARS,
        ));
    }
    match order.when {
        Some(When2::Span(start, end)) => {
            if let (Some(from), Some(to)) =
                (when(&arguments[start], now), when(&arguments[end], now))
            {
                parts.push(span(&from, &to, now));
            }
        }
        Some(When2::One(key)) => {
            if let Some(at) = when(&arguments[key], now) {
                let moment = moment(at, now);
                parts.push(if PLAIN_TIMES.contains(&key) {
                    moment
                } else {
                    format!("{}: {moment}", label(key))
                });
            }
        }
        None => {}
    }
    let mut long = Vec::new();
    for key in &order.rest {
        if known.about.is_some() && is_id(key) {
            continue;
        }
        let part = known
            .option(key)
            .map(str::to_owned)
            .or_else(|| line_field(key, &arguments[key.as_str()], now));
        match part {
            Some(part) if part.chars().count() > SHORT_CHARS => long.push(part),
            Some(part) => parts.push(part),
            None => {}
        }
    }
    parts.extend(long);
    (!parts.is_empty()).then(|| parts.join(" · "))
}

/// Everything the call sends, for the card to open, in the line's order: each argument's name,
/// what it says (dates, lists and yes or no in words, groups of fields as their JSON, marked
/// `code`), and the text sent when that reads differently. `None` for no arguments; `cut` when the
/// rest was too long to list.
pub(super) fn sends<Tz: TimeZone>(
    arguments: &Map<String, Value>,
    known: Known<'_>,
    now: &DateTime<Tz>,
) -> Option<Value> {
    if arguments.is_empty() {
        return None;
    }
    let order = Order::of(arguments, known, now);
    let keys = order
        .lead
        .into_iter()
        .chain(match order.when {
            Some(When2::Span(start, end)) => vec![start, end],
            Some(When2::One(key)) => vec![key],
            None => Vec::new(),
        })
        .map(str::to_owned)
        .chain(order.rest.iter().cloned());
    let mut fields = Vec::new();
    let mut total = 0;
    let mut cut_short = false;
    for key in keys {
        let value = &arguments[key.as_str()];
        let raw = match value {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        };
        let (said, code) = if let Some(words) = known.option(&key) {
            (words.to_owned(), false)
        } else {
            listed(value, now)
        };
        let said = cut(&said, SENT_VALUE_CHARS);
        total += said.chars().count() + key.len();
        if total > SENT_CHARS {
            cut_short = true;
            break;
        }
        let mut field = json!({"name": label(&key), "said": said});
        if code {
            field["code"] = json!(true);
        } else if field["said"] != json!(raw) && raw.chars().count() <= SENT_VALUE_CHARS {
            field["sent"] = json!(raw);
        }
        fields.push(field);
    }
    let mut sent = json!({"fields": fields});
    if cut_short {
        sent["cut"] = json!(true);
    }
    Some(sent)
}

/// Which time the line says, by argument.
#[derive(Debug, Clone, Copy)]
enum When2<'a> {
    Span(&'a str, &'a str),
    One(&'a str),
}

/// The arguments in the line's order: what it is about, when, then the rest as sent.
struct Order<'a> {
    lead: Option<&'a str>,
    when: Option<When2<'a>>,
    rest: Vec<String>,
}

impl<'a> Order<'a> {
    fn of<Tz: TimeZone>(
        arguments: &'a Map<String, Value>,
        known: Known<'_>,
        now: &DateTime<Tz>,
    ) -> Self {
        // An item named by what an earlier result called it leads with that name; its own title,
        // if it sends one, is then a change like any other.
        let lead = if known.about.is_some() {
            None
        } else {
            LEAD.iter()
                .copied()
                .find(|key| arguments.get(*key).and_then(words).is_some())
        };
        let span = SPANS.iter().copied().find(|(start, end)| {
            arguments
                .get(*start)
                .and_then(|value| when(value, now))
                .is_some()
                && arguments
                    .get(*end)
                    .and_then(|value| when(value, now))
                    .is_some()
        });
        let when = span
            .map(|(start, end)| When2::Span(start, end))
            .or_else(|| {
                arguments
                    .iter()
                    .find(|(key, value)| known.option(key).is_none() && when(value, now).is_some())
                    .and_then(|(key, _)| {
                        PLAIN_TIMES
                            .iter()
                            .copied()
                            .find(|plain| plain == key)
                            .or_else(|| arguments.keys().map(String::as_str).find(|own| own == key))
                    })
                    .map(When2::One)
            });
        let taken: Vec<&str> = lead
            .into_iter()
            .chain(match when {
                Some(When2::Span(start, end)) => vec![start, end],
                Some(When2::One(key)) => vec![key],
                None => Vec::new(),
            })
            .collect();
        let rest = arguments
            .keys()
            .filter(|key| !taken.contains(&key.as_str()))
            .cloned()
            .collect();
        Self { lead, when, rest }
    }
}

/// A key that names an item by its id: `id`, `event_id`, `parentId`.
fn is_id(key: &str) -> bool {
    key == "id" || key.ends_with("_id") || key.ends_with("Id")
}

/// A string's words on one line, when it has any.
fn words(value: &Value) -> Option<String> {
    let text = value
        .as_str()?
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    (!text.is_empty()).then_some(text)
}

fn cut(text: &str, most: usize) -> String {
    if text.chars().count() > most {
        format!("{}…", text.chars().take(most).collect::<String>())
    } else {
        text.to_owned()
    }
}

/// A date, or a date and a time, as a call names one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum When {
    Day(NaiveDate),
    At(NaiveDateTime),
}

impl When {
    fn day(self) -> NaiveDate {
        match self {
            Self::Day(day) => day,
            Self::At(at) => at.date(),
        }
    }
}

fn when<Tz: TimeZone>(value: &Value, now: &DateTime<Tz>) -> Option<When> {
    let text = value.as_str()?.trim();
    if let Ok(at) = DateTime::parse_from_rfc3339(text) {
        return Some(When::At(at.with_timezone(&now.timezone()).naive_local()));
    }
    for format in [
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
    ] {
        if let Ok(at) = NaiveDateTime::parse_from_str(text, format) {
            return Some(When::At(at));
        }
    }
    NaiveDate::parse_from_str(text, "%Y-%m-%d")
        .ok()
        .map(When::Day)
}

/// "Sat 14 Nov", with its year when that isn't this year's.
fn day<Tz: TimeZone>(day: NaiveDate, now: &DateTime<Tz>) -> String {
    if day.year() == now.year() {
        day.format("%a %-d %b").to_string()
    } else {
        day.format("%a %-d %b %Y").to_string()
    }
}

/// "Sat 14 Nov, 15:00", or "Sat 14 Nov" for a whole day.
fn moment<Tz: TimeZone>(at: When, now: &DateTime<Tz>) -> String {
    match at {
        When::Day(on) => day(on, now),
        When::At(at) => format!("{}, {}", day(at.date(), now), at.format("%H:%M")),
    }
}

/// "Sat 14 Nov, 15:00–16:00" on one day; "Sat 14 Nov – Mon 16 Nov" or with times across days.
fn span<Tz: TimeZone>(from: &When, to: &When, now: &DateTime<Tz>) -> String {
    match (from, to) {
        (When::At(start), When::At(end)) if start.date() == end.date() => format!(
            "{}, {}–{}",
            day(start.date(), now),
            start.format("%H:%M"),
            end.format("%H:%M")
        ),
        (When::Day(start), When::Day(end)) if start == end => day(*start, now),
        _ if from.day() == to.day() => moment(*from, now),
        _ => format!("{} – {}", moment(*from, now), moment(*to, now)),
    }
}

/// "Calendar", "All day", "Due date", "Parent ID": a key as words, camel case split.
pub(super) fn label(key: &str) -> String {
    let mut spaced = String::new();
    let mut before: Option<char> = None;
    for c in key.chars() {
        if c == '_' || c == '-' {
            spaced.push(' ');
        } else {
            if c.is_uppercase() && before.is_some_and(char::is_lowercase) {
                spaced.push(' ');
            }
            spaced.push(c);
        }
        before = Some(c);
    }
    let words: Vec<String> = spaced
        .split_whitespace()
        .enumerate()
        .map(|(at, word)| {
            if word.eq_ignore_ascii_case("id") {
                "ID".to_owned()
            } else if at == 0 {
                let mut chars = word.chars();
                chars.next().map_or_else(String::new, |first| {
                    first
                        .to_uppercase()
                        .chain(chars.flat_map(char::to_lowercase))
                        .collect()
                })
            } else {
                word.to_lowercase()
            }
        })
        .collect();
    words.join(" ")
}

/// The words of a list's plain items, or `None` when it holds none.
fn items(list: &[Value]) -> Option<Vec<String>> {
    let named: Vec<String> = list
        .iter()
        .filter_map(|item| match item {
            Value::String(_) => words(item),
            Value::Number(number) => Some(number.to_string()),
            Value::Bool(on) => Some(if *on { "yes" } else { "no" }.to_owned()),
            _ => None,
        })
        .collect();
    (!named.is_empty() && named.len() == list.len()).then_some(named)
}

/// One more argument on the line: "Calendar: Home", "All day", "Done: no", "Due: Sat 14 Nov",
/// "Labels: bug, ui and 2 more", "Phones: 2", "Assignee: Lan". Nothing for what is empty.
fn line_field<Tz: TimeZone>(key: &str, value: &Value, now: &DateTime<Tz>) -> Option<String> {
    let name = label(key);
    if name.is_empty() {
        return None;
    }
    match value {
        Value::Bool(true) => Some(name),
        // A no can be the change itself, such as marking a reminder not done.
        Value::Bool(false) => Some(format!("{name}: no")),
        Value::Number(number) => Some(format!("{name}: {number}")),
        Value::String(_) => {
            let said = when(value, now).map_or_else(
                || words(value).map(|text| cut(&text, VALUE_CHARS)),
                |at| Some(moment(at, now)),
            )?;
            Some(format!("{name}: {said}"))
        }
        Value::Array(list) if list.is_empty() => None,
        Value::Array(list) => Some(match items(list) {
            Some(named) => {
                let shown = named
                    .iter()
                    .take(LIST_ITEMS)
                    .map(|item| cut(item, VALUE_CHARS))
                    .collect::<Vec<_>>()
                    .join(", ");
                let more = named.len().saturating_sub(LIST_ITEMS);
                if more > 0 {
                    format!("{name}: {shown} and {more} more")
                } else {
                    format!("{name}: {shown}")
                }
            }
            // Groups of fields, such as a contact's phones: how many, each under the card's list.
            None => format!("{name}: {}", list.len()),
        }),
        Value::Object(fields) if fields.is_empty() => None,
        Value::Object(fields) => Some(
            LEAD.iter()
                .find_map(|lead| fields.get(*lead).and_then(words))
                .map_or_else(
                    || format!("{name}: …"),
                    |lead| format!("{name}: {}", cut(&lead, VALUE_CHARS)),
                ),
        ),
        Value::Null => None,
    }
}

/// What one argument says under "Everything it would send", and whether that is its JSON.
fn listed<Tz: TimeZone>(value: &Value, now: &DateTime<Tz>) -> (String, bool) {
    match value {
        Value::String(text) => (
            when(value, now).map_or_else(|| text.clone(), |at| moment(at, now)),
            false,
        ),
        Value::Bool(on) => ((if *on { "Yes" } else { "No" }).to_owned(), false),
        Value::Number(number) => (number.to_string(), false),
        Value::Null => ("Nothing".to_owned(), false),
        Value::Array(list) => match items(list) {
            Some(named) => (named.join(", "), false),
            None if list.is_empty() => ("Nothing".to_owned(), false),
            None => (
                serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string()),
                true,
            ),
        },
        Value::Object(_) => (
            serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string()),
            true,
        ),
    }
}

#[cfg(test)]
mod tests {
    use chrono::FixedOffset;

    use super::*;

    /// Saturday 14 November 2026, 10:00 in Hanoi.
    fn now() -> DateTime<FixedOffset> {
        DateTime::parse_from_rfc3339("2026-11-14T10:00:00+07:00").expect("now")
    }

    fn said_of(arguments: &Value) -> Option<String> {
        said(
            arguments.as_object().expect("an object"),
            Known::default(),
            &now(),
        )
    }

    #[test]
    fn an_event_reads_as_what_and_when_not_as_json() {
        assert_eq!(
            said_of(&json!({
                "end": "2026-11-14T16:00:00",
                "start": "2026-11-14T15:00:00",
                "title": "Upper A, session 1 of 16",
                "calendar": "Home",
                "notes": "Bench, rows, curls. Warm up for ten minutes first, then stretch.",
                "location": "Gym",
            }))
            .as_deref(),
            Some(
                "Upper A, session 1 of 16 · Sat 14 Nov, 15:00–16:00 · Calendar: Home · \
                 Location: Gym · Notes: Bench, rows, curls. Warm up for ten minutes first, then \
                 stretch."
            )
        );
        // A lone start takes the place of when, short facts before long words, whatever their names.
        assert_eq!(
            said_of(&json!({"title": "Upper A", "start": "2026-11-14T15:00:00", "agenda": "x".repeat(50), "calendar": "Home"}))
                .as_deref(),
            Some(format!("Upper A · Sat 14 Nov, 15:00 · Calendar: Home · Agenda: {}", "x".repeat(50)).as_str())
        );
    }

    #[test]
    fn times_are_said_in_the_persons_zone_and_the_year_only_when_another() {
        // 08:00 UTC is 15:00 in Hanoi.
        assert_eq!(
            said_of(&json!({"title": "Call", "start": "2026-11-16T08:00:00Z", "end": "2026-11-16T08:30:00Z"}))
                .as_deref(),
            Some("Call · Mon 16 Nov, 15:00–15:30")
        );
        assert_eq!(
            said_of(&json!({"title": "Trip", "start": "2027-01-02", "end": "2027-01-05"}))
                .as_deref(),
            Some("Trip · Sat 2 Jan 2027 – Tue 5 Jan 2027")
        );
        assert_eq!(
            said_of(&json!({"title": "Holiday", "start": "2026-12-25", "end": "2026-12-25", "all_day": true}))
                .as_deref(),
            Some("Holiday · Fri 25 Dec · All day")
        );
        // A time with its own name keeps it, and a no is said.
        assert_eq!(
            said_of(&json!({"title": "Buy oat milk", "due": "2026-11-15T09:00", "done": false}))
                .as_deref(),
            Some("Buy oat milk · Due: Sun 15 Nov, 09:00 · Done: no")
        );
    }

    #[test]
    fn the_rest_is_said_briefly_and_groups_are_counted() {
        assert_eq!(
            said_of(&json!({
                "team": "ENG",
                "title": "Fix login",
                "priority": 2,
                "labels": ["bug", "ui", "login", "urgent"],
                "description": "x".repeat(200),
                "assignee": {"name": "Lan"},
                "dueDate": "2026-11-20",
            }))
            .as_deref(),
            Some(
                format!(
                    "Fix login · Due date: Fri 20 Nov · Assignee: Lan · Labels: bug, ui, login and 1 \
                     more · Priority: 2 · Team: ENG · Description: {}…",
                    "x".repeat(VALUE_CHARS)
                )
                .as_str()
            )
        );
        assert_eq!(
            said_of(&json!({"givenName": "An", "familyName": "Tran", "phones": [{"label": "mobile", "number": "1"}, {"number": "2"}]}))
                .as_deref(),
            Some("Family name: Tran · Given name: An · Phones: 2")
        );
        assert_eq!(said_of(&json!({"id": "e1"})).as_deref(), Some("ID: e1"));
        assert_eq!(said_of(&json!({})), None);
        assert_eq!(said_of(&json!({"note": "  ", "tags": []})), None);
        assert_eq!(label("parentId"), "Parent ID");
        assert_eq!(label("start_time"), "Start time");
    }

    #[test]
    fn what_loomwatch_knows_names_the_item_and_its_options() {
        let options = json!({"which": "This one and every later one"});
        let known = Known {
            about: Some("Upper A, session 1 of 16"),
            options: options.as_object(),
        };
        let deleting =
            json!({"id": "8F1A-…:0400", "occurrence": "2026-11-14T15:00:00", "which": "future"});
        assert_eq!(
            said(deleting.as_object().expect("object"), known, &now()).as_deref(),
            Some("Upper A, session 1 of 16 · Sat 14 Nov, 15:00 · This one and every later one")
        );
        let sent = sends(deleting.as_object().expect("object"), known, &now()).expect("listed");
        assert_eq!(
            sent["fields"],
            json!([
                {"name": "Occurrence", "said": "Sat 14 Nov, 15:00", "sent": "2026-11-14T15:00:00"},
                {"name": "ID", "said": "8F1A-…:0400"},
                {"name": "Which", "said": "This one and every later one", "sent": "future"},
            ])
        );
    }

    #[test]
    fn everything_it_would_send_is_listed_in_words_in_the_lines_order() {
        let arguments = json!({
            "title": "Fix login",
            "end": "2026-11-16T08:30:00Z",
            "start": "2026-11-16T08:00:00Z",
            "done": false,
            "labels": ["bug", "ui"],
            "assignee": {"id": "u1"},
        });
        let sent = sends(
            arguments.as_object().expect("object"),
            Known::default(),
            &now(),
        )
        .expect("listed");
        assert_eq!(
            sent,
            json!({"fields": [
                {"name": "Title", "said": "Fix login"},
                {"name": "Start", "said": "Mon 16 Nov, 15:00", "sent": "2026-11-16T08:00:00Z"},
                {"name": "End", "said": "Mon 16 Nov, 15:30", "sent": "2026-11-16T08:30:00Z"},
                {"name": "Assignee", "said": "{\n  \"id\": \"u1\"\n}", "code": true},
                {"name": "Done", "said": "No", "sent": "false"},
                {"name": "Labels", "said": "bug, ui", "sent": "[\"bug\",\"ui\"]"},
            ]})
        );
        assert_eq!(sends(&Map::new(), Known::default(), &now()), None);
        let long = "y".repeat(SENT_VALUE_CHARS + 10);
        let huge: Map<String, Value> = (0..20)
            .map(|n| (format!("k{n:02}"), json!(long.clone())))
            .collect();
        let sent = sends(&huge, Known::default(), &now()).expect("what fits");
        assert_eq!(sent["cut"], true);
        let fields = sent["fields"].as_array().expect("fields");
        assert!(!fields.is_empty() && fields.len() < 20, "{}", fields.len());
        assert_eq!(
            fields[0]["said"].as_str().expect("words").chars().count(),
            SENT_VALUE_CHARS + 1
        );
    }
}
