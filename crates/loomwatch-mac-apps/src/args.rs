//! Reading an action's arguments, with errors an agent can fix.

use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, TimeZone as _};
use serde_json::Value;

/// The most items one answer lists, unless the agent asks for fewer.
pub const MAX_ITEMS: usize = 200;

/// The arguments of one action: a JSON object.
pub struct Args<'a>(pub &'a Value);

impl Args<'_> {
    /// `name`, trimmed, if it was given and isn't empty.
    pub fn text(&self, name: &str) -> Option<String> {
        self.0
            .get(name)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    }

    /// `name`, which the action needs.
    pub fn needed(&self, name: &str) -> Result<String, String> {
        self.text(name)
            .ok_or_else(|| format!("Give `{name}`: it is needed for this."))
    }

    pub fn flag(&self, name: &str) -> Option<bool> {
        self.0.get(name).and_then(Value::as_bool)
    }

    /// How many items to list: `limit` if given, at most [`MAX_ITEMS`].
    pub fn limit(&self) -> usize {
        self.0
            .get("limit")
            .and_then(Value::as_u64)
            .and_then(|limit| usize::try_from(limit).ok())
            .filter(|limit| *limit > 0)
            .map_or(MAX_ITEMS, |limit| limit.min(MAX_ITEMS))
    }

    /// `name` as a time, if given: see [`time`].
    pub fn time(&self, name: &str) -> Result<Option<Moment>, String> {
        self.text(name).map(|text| time(&text, name)).transpose()
    }

    /// `name` as a time, which the action needs.
    pub fn needed_time(&self, name: &str) -> Result<Moment, String> {
        time(&self.needed(name)?, name)
    }
}

/// A time an agent gave, and whether it named a day only.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Moment {
    /// Seconds since 1970, as `NSDate` takes them.
    pub seconds: f64,
    pub day_only: bool,
}

/// `2026-11-08`, `2026-11-08T14:00`, `2026-11-08 14:00:00` (this Mac's time zone) or
/// `2026-11-08T14:00:00+07:00`.
pub fn time(text: &str, name: &str) -> Result<Moment, String> {
    let text = text.trim();
    if let Ok(exact) = DateTime::parse_from_rfc3339(text) {
        return Ok(Moment {
            seconds: seconds(exact.timestamp_millis()),
            day_only: false,
        });
    }
    for format in [
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
    ] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(text, format) {
            return local(naive, false, name);
        }
    }
    if let Ok(day) = NaiveDate::parse_from_str(text, "%Y-%m-%d") {
        return local(day.and_hms_opt(0, 0, 0).unwrap_or_default(), true, name);
    }
    Err(format!(
        "`{name}` should be a date or time such as 2026-11-08 or 2026-11-08T14:00, not \"{text}\"."
    ))
}

fn local(naive: NaiveDateTime, day_only: bool, name: &str) -> Result<Moment, String> {
    Local
        .from_local_datetime(&naive)
        .earliest()
        .map(|at| Moment {
            seconds: seconds(at.timestamp_millis()),
            day_only,
        })
        .ok_or_else(|| format!("`{name}` falls in an hour the clocks skip here."))
}

#[allow(clippy::cast_precision_loss)]
fn seconds(millis: i64) -> f64 {
    millis as f64 / 1000.0
}

/// Seconds since 1970 as this Mac's local time, `2026-11-08T14:00:00+07:00`, for answers.
#[must_use]
#[allow(clippy::cast_possible_truncation)]
pub fn shown(seconds: f64) -> String {
    Local
        .timestamp_millis_opt((seconds * 1000.0).round() as i64)
        .single()
        .map_or_else(String::new, |at| {
            at.to_rfc3339_opts(chrono::SecondsFormat::Secs, false)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_the_times_agents_write() {
        let exact = time("2026-11-08T14:00:00+00:00", "from").unwrap();
        assert!((exact.seconds - 1_794_146_400.0).abs() < 0.5);
        assert!(!exact.day_only);
        assert!(time("2026-11-08", "from").unwrap().day_only);
        assert!(time("2026-11-08T14:00", "from").is_ok());
        assert!(time("2026-11-08 14:00", "from").is_ok());
        let said = time("next tuesday", "from").unwrap_err();
        assert!(said.contains("`from`"), "{said}");
    }

    #[test]
    fn limits_answers_and_names_what_is_missing() {
        let given = json!({"limit": 5000, "title": "  "});
        let args = Args(&given);
        assert_eq!(args.limit(), MAX_ITEMS);
        assert_eq!(args.text("title"), None);
        assert!(args.needed("title").unwrap_err().contains("`title`"));
    }
}
