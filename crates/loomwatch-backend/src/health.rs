//! Apple Health readings from a paired iPhone, and the Apple Health tool that reads them (ADR 0121).
//!
//! A Mac has no Health store, so the `LoomWatch` iPhone app reads the kinds the person switched on
//! and sends them through the door ([`ROUTE`]), as one figure a day for each kind, plus each
//! night's sleep and each workout. They are kept in the run history's database. The door answers
//! the route itself, because only the door knows which phone is sending (ADR 0102): a phone can
//! write and forget only its own readings.
//!
//! An agent given the Apple Health tool reads them through its calls, which ask the person first
//! like every connected tool's. Nothing here writes to Health. Removing the tool, or the phone,
//! deletes the readings.
use std::sync::OnceLock;

use axum::Json;
use axum::body::to_bytes;
use axum::extract::Request;
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row as _;

use crate::connected_tools::ToolCall;
use crate::db::Db;

/// Where a phone sends its readings (`PUT`) or takes them back (`DELETE`), at the door.
pub const ROUTE: &str = "/phone/v0/health";
/// What the Apple Health tool keeps as its address in `tools.json`.
pub const URL: &str = "loomwatch:apple-health";
/// The most one batch from the phone may carry.
const MAX_BODY_BYTES: usize = 1024 * 1024;
/// The most rows one batch may carry.
const MAX_ROWS: usize = 5000;
/// The longest stretch one answer covers.
const MAX_DAYS: i64 = 400;
/// The most events one answer lists.
const MAX_EVENTS: i64 = 200;
const MAX_TEXT_CHARS: usize = 200;

/// How a day's figure is made from the phone's samples, and so how days and weeks add up.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Sum {
    /// Added up over the day: steps, energy, minutes.
    Total,
    /// The day's average: heart rate.
    Average,
    /// The day's last reading: weight.
    Last,
}

/// The kinds of daily figure a phone may send: name, unit, how they add up, and words for the
/// agent.
const DAY_KINDS: &[(&str, &str, Sum, &str)] = &[
    ("steps", "count", Sum::Total, "steps walked"),
    ("active_energy", "kcal", Sum::Total, "active energy burned"),
    ("exercise_minutes", "min", Sum::Total, "minutes of exercise"),
    (
        "resting_heart_rate",
        "bpm",
        Sum::Average,
        "resting heart rate",
    ),
    ("heart_rate", "bpm", Sum::Average, "average heart rate"),
    ("hrv", "ms", Sum::Average, "heart rate variability"),
    ("weight", "kg", Sum::Last, "body weight"),
];
/// The kinds of event a phone may send.
const EVENT_KINDS: &[&str] = &["sleep", "workout"];

fn day_kind(kind: &str) -> Option<&'static (&'static str, &'static str, Sum, &'static str)> {
    DAY_KINDS.iter().find(|(name, ..)| *name == kind)
}

/// One batch from the phone.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Batch {
    #[serde(default)]
    pub days: Vec<Day>,
    #[serde(default)]
    pub events: Vec<Event>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Day {
    pub kind: String,
    /// `2026-11-07`, in the person's own time zone.
    pub day: String,
    pub value: f64,
    pub unit: String,
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Event {
    pub kind: String,
    /// RFC 3339.
    pub start: String,
    pub end: String,
    #[serde(default)]
    pub value: Option<f64>,
    #[serde(default)]
    pub unit: Option<String>,
    /// A workout's activity, or the stages of a night's sleep, in a few words.
    #[serde(default)]
    pub detail: Option<String>,
}

impl Batch {
    /// What is wrong with it, in words, or nothing.
    fn problem(&self) -> Option<String> {
        if self.days.len() + self.events.len() > MAX_ROWS {
            return Some(format!("Send at most {MAX_ROWS} readings at a time."));
        }
        for day in &self.days {
            let Some((_, unit, ..)) = day_kind(&day.kind) else {
                return Some(format!("{:?} isn't a kind of daily reading.", day.kind));
            };
            if day.unit != *unit {
                return Some(format!(
                    "{} is counted in {unit}, not {}.",
                    day.kind, day.unit
                ));
            }
            if NaiveDate::parse_from_str(&day.day, "%Y-%m-%d").is_err() {
                return Some(format!("{:?} isn't a day like 2026-11-07.", day.day));
            }
            if !day.value.is_finite() || day.value < 0.0 {
                return Some(format!("{} on {} isn't a reading.", day.kind, day.day));
            }
        }
        for event in &self.events {
            if !EVENT_KINDS.contains(&event.kind.as_str()) {
                return Some(format!("{:?} isn't a kind of event.", event.kind));
            }
            let (Ok(start), Ok(end)) = (
                DateTime::parse_from_rfc3339(&event.start),
                DateTime::parse_from_rfc3339(&event.end),
            ) else {
                return Some(format!(
                    "A {} needs a start and an end in RFC 3339.",
                    event.kind
                ));
            };
            if end < start || event.value.is_some_and(|value| !value.is_finite()) {
                return Some(format!(
                    "A {} at {} isn't a reading.",
                    event.kind, event.start
                ));
            }
        }
        None
    }
}

fn short(text: Option<&str>) -> Option<String> {
    text.map(str::trim)
        .filter(|text| !text.is_empty())
        .map(|text| text.chars().take(MAX_TEXT_CHARS).collect())
}

/// The readings, in the run history's database.
#[derive(Clone)]
pub struct Health {
    db: Db,
}

static INSTALLED: OnceLock<Health> = OnceLock::new();

/// Makes `health` the one the door and the Apple Health tool use. Called once, at startup.
pub fn install(health: Health) {
    let _ = INSTALLED.set(health);
}

/// The installed [`Health`], if the daemon set one.
pub(crate) fn installed() -> Option<&'static Health> {
    INSTALLED.get()
}

fn failed(error: &sqlx::Error) -> String {
    format!("the Health readings couldn't be read or kept: {error}")
}

impl Health {
    #[must_use]
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    /// Keep `batch` from phone `device`, replacing what it sent for the same days and starts.
    ///
    /// # Errors
    /// The batch is refused, with why, or the database couldn't keep it.
    pub async fn keep(&self, device: &str, batch: &Batch) -> Result<usize, String> {
        if let Some(problem) = batch.problem() {
            return Err(problem);
        }
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let mut writing = self.db.writer().begin().await.map_err(|e| failed(&e))?;
        for day in &batch.days {
            sqlx::query(
                "INSERT INTO health_days (device, kind, day, value, unit, source, received_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (device, kind, day) DO UPDATE SET
                   value = excluded.value, unit = excluded.unit, source = excluded.source,
                   received_at = excluded.received_at",
            )
            .bind(device)
            .bind(&day.kind)
            .bind(&day.day)
            .bind(day.value)
            .bind(&day.unit)
            .bind(short(day.source.as_deref()))
            .bind(&now)
            .execute(&mut *writing)
            .await
            .map_err(|e| failed(&e))?;
        }
        for event in &batch.events {
            sqlx::query(
                "INSERT INTO health_events (device, kind, start, end, value, unit, detail, received_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (device, kind, start) DO UPDATE SET
                   end = excluded.end, value = excluded.value, unit = excluded.unit,
                   detail = excluded.detail, received_at = excluded.received_at",
            )
            .bind(device)
            .bind(&event.kind)
            .bind(&event.start)
            .bind(&event.end)
            .bind(event.value)
            .bind(short(event.unit.as_deref()))
            .bind(short(event.detail.as_deref()))
            .bind(&now)
            .execute(&mut *writing)
            .await
            .map_err(|e| failed(&e))?;
        }
        writing.commit().await.map_err(|e| failed(&e))?;
        Ok(batch.days.len() + batch.events.len())
    }

    /// Delete phone `device`'s readings, or every phone's.
    ///
    /// # Errors
    /// The database couldn't delete them.
    pub async fn forget(&self, device: Option<&str>) -> Result<(), String> {
        let mut writing = self.db.writer().begin().await.map_err(|e| failed(&e))?;
        for table in ["health_days", "health_events"] {
            sqlx::query(&format!(
                "DELETE FROM {table} WHERE $1 IS NULL OR device = $1"
            ))
            .bind(device)
            .execute(&mut *writing)
            .await
            .map_err(|e| failed(&e))?;
        }
        writing.commit().await.map_err(|e| failed(&e))
    }

    /// Whether any phone has sent a reading.
    pub(crate) async fn has_readings(&self) -> bool {
        sqlx::query_scalar::<_, i64>(
            "SELECT (SELECT COUNT(*) FROM health_days) + (SELECT COUNT(*) FROM health_events)",
        )
        .fetch_one(self.db.reader())
        .await
        .is_ok_and(|count| count > 0)
    }

    async fn kinds(&self) -> Result<Value, String> {
        let days = sqlx::query(
            "SELECT kind, MIN(day) AS first, MAX(day) AS last, COUNT(DISTINCT day) AS days
             FROM health_days GROUP BY kind ORDER BY kind",
        )
        .fetch_all(self.db.reader())
        .await
        .map_err(|e| failed(&e))?;
        let events = sqlx::query(
            "SELECT kind, MIN(substr(start, 1, 10)) AS first, MAX(substr(start, 1, 10)) AS last,
                    COUNT(*) AS days
             FROM health_events GROUP BY kind ORDER BY kind",
        )
        .fetch_all(self.db.reader())
        .await
        .map_err(|e| failed(&e))?;
        let listed: Vec<Value> = days
            .iter()
            .chain(events.iter())
            .map(|row| {
                let kind: String = row.get("kind");
                let (unit, means) =
                    day_kind(&kind).map_or(("", ""), |(_, unit, _, means)| (*unit, *means));
                json!({
                    "kind": kind,
                    "means": if means.is_empty() { None } else { Some(means) },
                    "unit": if unit.is_empty() { None } else { Some(unit) },
                    "from": row.get::<String, _>("first"),
                    "to": row.get::<String, _>("last"),
                    "count": row.get::<i64, _>("days"),
                })
            })
            .collect();
        Ok(json!({ "kinds": listed }))
    }

    /// One figure a day for `kind`, from `from` to `to`, or one a week (Monday to Sunday): a
    /// week's total for what adds up, its average for the rest.
    async fn figures(
        &self,
        kind: &str,
        from: &str,
        to: &str,
        weekly: bool,
    ) -> Result<Value, String> {
        let (_, unit, sum, means) = day_kind(kind).ok_or_else(|| unknown_kind(kind))?;
        // More than one phone may send the same day: the larger total, or the average.
        let per_day = match sum {
            Sum::Total => "MAX(value)",
            Sum::Average | Sum::Last => "AVG(value)",
        };
        let days = format!(
            "SELECT day, {per_day} AS value FROM health_days
             WHERE kind = $1 AND day BETWEEN $2 AND $3 GROUP BY day"
        );
        let query = if weekly {
            let per_week = if *sum == Sum::Total {
                "SUM(value)"
            } else {
                "AVG(value)"
            };
            format!(
                "SELECT date(day, '-6 days', 'weekday 1') AS week, {per_week} AS value,
                        COUNT(*) AS days
                 FROM ({days}) GROUP BY week ORDER BY week"
            )
        } else {
            format!("{days} ORDER BY day")
        };
        let rows = sqlx::query(&query)
            .bind(kind)
            .bind(from)
            .bind(to)
            .fetch_all(self.db.reader())
            .await
            .map_err(|e| failed(&e))?;
        let figures: Vec<Value> = rows
            .iter()
            .map(|row| {
                let value = (row.get::<f64, _>("value") * 10.0).round() / 10.0;
                if weekly {
                    json!({
                        "weekOf": row.get::<String, _>("week"),
                        "value": value,
                        "daysWithReadings": row.get::<i64, _>("days"),
                    })
                } else {
                    json!({ "day": row.get::<String, _>("day"), "value": value })
                }
            })
            .collect();
        Ok(json!({
            "kind": kind,
            "means": means,
            "unit": unit,
            "from": from,
            "to": to,
            if weekly { "weeks" } else { "days" }: figures,
        }))
    }

    async fn latest(&self, kind: &str) -> Result<Value, String> {
        let (_, unit, _, means) = day_kind(kind).ok_or_else(|| unknown_kind(kind))?;
        let row = sqlx::query(
            "SELECT day, value FROM health_days WHERE kind = $1 ORDER BY day DESC, received_at DESC LIMIT 1",
        )
        .bind(kind)
        .fetch_optional(self.db.reader())
        .await
        .map_err(|e| failed(&e))?;
        Ok(row.map_or_else(
            || json!({ "kind": kind, "latest": null }),
            |row| {
                json!({
                    "kind": kind,
                    "means": means,
                    "unit": unit,
                    "day": row.get::<String, _>("day"),
                    "value": row.get::<f64, _>("value"),
                })
            },
        ))
    }

    async fn events(&self, kind: &str, from: &str, to: &str) -> Result<Value, String> {
        let rows = sqlx::query(
            "SELECT start, end, MAX(value) AS value, MAX(unit) AS unit, MAX(detail) AS detail
             FROM health_events
             WHERE kind = $1 AND substr(start, 1, 10) BETWEEN $2 AND $3
             GROUP BY start, end ORDER BY start LIMIT $4",
        )
        .bind(kind)
        .bind(from)
        .bind(to)
        .bind(MAX_EVENTS + 1)
        .fetch_all(self.db.reader())
        .await
        .map_err(|e| failed(&e))?;
        let more = i64::try_from(rows.len()).unwrap_or(i64::MAX) > MAX_EVENTS;
        let listed: Vec<Value> = rows
            .iter()
            .take(usize::try_from(MAX_EVENTS).unwrap_or(usize::MAX))
            .map(|row| {
                json!({
                    "start": row.get::<String, _>("start"),
                    "end": row.get::<String, _>("end"),
                    "value": row.get::<Option<f64>, _>("value"),
                    "unit": row.get::<Option<String>, _>("unit"),
                    "detail": row.get::<Option<String>, _>("detail"),
                })
            })
            .collect();
        Ok(json!({ "kind": kind, "from": from, "to": to, "events": listed, "more": more }))
    }

    /// The tool's answer to `call` with `arguments`, and whether it failed.
    pub(crate) async fn call(&self, call: &str, arguments: &Value) -> (String, bool) {
        let answer = match call {
            "list_kinds" => self.kinds().await,
            "daily" | "weekly" => {
                match (text(arguments, "kind"), range(arguments, call == "weekly")) {
                    (Some(kind), Ok((from, to))) => {
                        self.figures(&kind, &from, &to, call == "weekly").await
                    }
                    (None, _) => Err("Give `kind`: one list_kinds shows.".to_owned()),
                    (_, Err(said)) => Err(said),
                }
            }
            "latest" => match text(arguments, "kind") {
                Some(kind) => self.latest(&kind).await,
                None => Err("Give `kind`: one list_kinds shows.".to_owned()),
            },
            "sleep" | "workouts" => match range(arguments, false) {
                Ok((from, to)) => {
                    let kind = if call == "sleep" { "sleep" } else { "workout" };
                    self.events(kind, &from, &to).await
                }
                Err(said) => Err(said),
            },
            _ => Err(format!("There's no action called {call} here.")),
        };
        match answer {
            Ok(found) => (found.to_string(), false),
            Err(said) => (said, true),
        }
    }
}

fn unknown_kind(kind: &str) -> String {
    let kinds: Vec<&str> = DAY_KINDS.iter().map(|(name, ..)| *name).collect();
    format!(
        "{kind:?} isn't a kind of daily reading. The kinds are: {}.",
        kinds.join(", ")
    )
}

fn text(arguments: &Value, key: &str) -> Option<String> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// `from` and `to` as days: by default the last 30 days (12 weeks for weekly), at most
/// [`MAX_DAYS`].
fn range(arguments: &Value, weekly: bool) -> Result<(String, String), String> {
    let day = |key: &str| {
        text(arguments, key)
            .map(|given| {
                NaiveDate::parse_from_str(given.get(..10).unwrap_or(&given), "%Y-%m-%d")
                    .map_err(|_| format!("`{key}` should be a day like 2026-11-07."))
            })
            .transpose()
    };
    let today = chrono::Local::now().date_naive();
    let to = day("to")?.unwrap_or(today);
    let from = day("from")?.unwrap_or(to - Duration::days(if weekly { 83 } else { 29 }));
    if to < from {
        return Err("`to` should come after `from`.".to_owned());
    }
    if (to - from).num_days() > MAX_DAYS {
        return Err(format!("Ask about {MAX_DAYS} days or fewer at a time."));
    }
    Ok((from.to_string(), to.to_string()))
}

/// What the Apple Health tool offers: reading only.
pub(crate) fn calls() -> Vec<ToolCall> {
    let range = json!({
        "from": {"type": "string", "description": "A day, 2026-10-01. Without it, 30 days before `to` (12 weeks for weekly)."},
        "to": {"type": "string", "description": "A day. Without it, today."},
    });
    let with_kind = |extra: &Value| {
        let mut properties = json!({"kind": {"type": "string", "description": "steps, active_energy, exercise_minutes, resting_heart_rate, heart_rate, hrv or weight"}});
        if let (Some(all), Some(more)) = (properties.as_object_mut(), extra.as_object()) {
            all.extend(more.clone());
        }
        json!({"type": "object", "properties": properties, "required": ["kind"]})
    };
    let call = |name: &str, title: &str, description: &str, schema: Value| ToolCall {
        name: name.to_owned(),
        title: Some(title.to_owned()),
        description: description.to_owned(),
        input_schema: schema,
        read_only: true,
        cant_undo: false,
    };
    vec![
        call(
            "list_kinds",
            "List what's there",
            "Which kinds of reading the person's iPhone has sent, and from which day to which.",
            json!({"type": "object", "properties": {}}),
        ),
        call(
            "daily",
            "Day by day",
            "One figure a day for a kind: the day's total for steps, energy and exercise, its average for heart rate, its last weight.",
            with_kind(&range),
        ),
        call(
            "weekly",
            "Week by week",
            "One figure a week (Monday to Sunday) for a kind: the week's total for what adds up, its average for the rest.",
            with_kind(&range),
        ),
        call(
            "latest",
            "Latest reading",
            "The most recent day's figure for a kind.",
            with_kind(&json!({})),
        ),
        call(
            "sleep",
            "Sleep",
            "Each night's sleep that started in the days asked about: when it began and ended.",
            json!({"type": "object", "properties": range}),
        ),
        call(
            "workouts",
            "Workouts",
            "Each workout that started in the days asked about: its activity, when, and the energy burned when known.",
            json!({"type": "object", "properties": range}),
        ),
    ]
}

/// `PUT` (readings) or `DELETE` (forget them) [`ROUTE`] from phone `device`, which the door let
/// in.
pub async fn route(health: Option<&Health>, device: &str, request: Request) -> Response {
    let problem =
        |status: StatusCode, said: &str| (status, Json(json!({ "error": said }))).into_response();
    let Some(health) = health else {
        return problem(
            StatusCode::SERVICE_UNAVAILABLE,
            "This computer can't keep Health readings right now.",
        );
    };
    match *request.method() {
        Method::PUT => {
            let Ok(body) = to_bytes(request.into_body(), MAX_BODY_BYTES).await else {
                return problem(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Send at most 1 MB at a time.",
                );
            };
            let Ok(batch) = serde_json::from_slice::<Batch>(&body) else {
                return problem(
                    StatusCode::BAD_REQUEST,
                    "Those aren't Health readings this computer can keep.",
                );
            };
            match health.keep(device, &batch).await {
                Ok(kept) => Json(json!({ "kept": kept })).into_response(),
                Err(said) if batch.problem().is_some() => problem(StatusCode::BAD_REQUEST, &said),
                Err(said) => problem(StatusCode::INTERNAL_SERVER_ERROR, &said),
            }
        }
        Method::DELETE => match health.forget(Some(device)).await {
            Ok(()) => Json(json!({ "forgotten": true })).into_response(),
            Err(said) => problem(StatusCode::INTERNAL_SERVER_ERROR, &said),
        },
        _ => problem(StatusCode::METHOD_NOT_ALLOWED, "Use PUT or DELETE."),
    }
}

#[cfg(test)]
mod tests;
