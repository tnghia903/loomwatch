//! Entries an agent logs into Apple Health: a meal, water, a weight (ADR 0123).
//!
//! A Mac has no Health store, so each entry waits in `health_writes` for the iPhone that sends
//! the readings. The phone is woken by a silent push with no words in it ([`Health::take_wakes`]),
//! takes the waiting entries at the door (`GET` [`WRITES_ROUTE`]), saves them in Health under the
//! entry's own id, so saving twice keeps one, and says how it went (`POST` [`WRITES_ROUTE`]`/{id}`).
//! The agent's call waits a short while for that answer and says plainly when the phone hasn't
//! answered yet. A remove takes out only an entry logged here.
use std::time::Duration;

use chrono::{DateTime, FixedOffset, Local, Utc};
use serde_json::{Map, Value, json};
use sqlx::Row as _;

use super::{Health, failed, range, short, text};
use crate::connected_tools::ToolCall;

/// Where the phone takes the entries waiting for it (`GET`) and answers for one (`POST …/{id}`).
pub const WRITES_ROUTE: &str = "/phone/v0/health/writes";
/// How long an agent's call waits for the phone to say it saved the entry.
pub(super) const PHONE_WAIT: Duration = Duration::from_secs(20);
/// How often the call looks while it waits.
const LOOK_EVERY: Duration = Duration::from_millis(400);
/// The most entries one answer lists, to the phone or the agent.
const MAX_LISTED: i64 = 200;

/// The amounts an entry may carry: name, unit, the most one entry may hold, and which kind of
/// entry it belongs to. The phone maps each to its Health type.
const AMOUNTS: &[(&str, &str, f64, &str)] = &[
    ("energy_kcal", "kcal", 20_000.0, "meal"),
    ("protein_g", "g", 2_000.0, "meal"),
    ("carbs_g", "g", 2_000.0, "meal"),
    ("fat_g", "g", 2_000.0, "meal"),
    ("water_ml", "ml", 10_000.0, "water"),
    ("weight_kg", "kg", 500.0, "weight"),
];

/// What an agent's log call asks for: the kind of entry.
fn kind_of(call: &str) -> Option<&'static str> {
    match call {
        "log_meal" => Some("meal"),
        "log_water" => Some("water"),
        "log_weight" => Some("weight"),
        _ => None,
    }
}

fn now_text() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// `at` as given, or now in this computer's time zone. Not more than a day ahead.
fn when(arguments: &Value) -> Result<DateTime<FixedOffset>, String> {
    let at = match text(arguments, "at") {
        Some(given) => DateTime::parse_from_rfc3339(&given).map_err(|_| {
            "`at` should be a time with its offset, like 2026-11-09T12:30:00+07:00.".to_owned()
        })?,
        None => Local::now().fixed_offset(),
    };
    if at.with_timezone(&Utc) > Utc::now() + chrono::Duration::days(1) {
        return Err(
            "`at` is more than a day ahead. Log what happened, when it happened.".to_owned(),
        );
    }
    Ok(at)
}

/// The amounts `kind` takes from `arguments`, each checked, and at least one.
fn amounts(kind: &str, arguments: &Value) -> Result<Map<String, Value>, String> {
    let mut found = Map::new();
    for (name, unit, most, belongs) in AMOUNTS {
        if *belongs != kind {
            continue;
        }
        let Some(given) = arguments.get(*name).filter(|given| !given.is_null()) else {
            continue;
        };
        let Some(value) = given.as_f64().filter(|value| value.is_finite()) else {
            return Err(format!("`{name}` should be a number of {unit}."));
        };
        if value <= 0.0 || value > *most {
            return Err(format!(
                "`{name}` should be more than 0 and at most {most} {unit}."
            ));
        }
        found.insert((*name).to_owned(), json!((value * 10.0).round() / 10.0));
    }
    if found.is_empty() {
        let names: Vec<&str> = AMOUNTS
            .iter()
            .filter(|(.., belongs)| *belongs == kind)
            .map(|(name, ..)| *name)
            .collect();
        return Err(format!("Give at least one of: {}.", names.join(", ")));
    }
    Ok(found)
}

/// One row as the agent or the phone reads it.
fn listed(row: &sqlx::sqlite::SqliteRow) -> Value {
    let amounts: Value = serde_json::from_str(&row.get::<String, _>("amounts")).unwrap_or_default();
    json!({
        "id": row.get::<String, _>("id"),
        "action": row.get::<String, _>("action"),
        "kind": row.get::<String, _>("kind"),
        "at": row.get::<String, _>("at"),
        "name": row.get::<Option<String>, _>("name"),
        "amounts": amounts,
        "target": row.get::<Option<String>, _>("target"),
        "state": row.get::<String, _>("state"),
        "said": row.get::<Option<String>, _>("said"),
    })
}

/// What the agent is told about an entry's state.
fn in_words(state: &str, said: Option<&str>) -> String {
    match state {
        "saved" => "Saved in Apple Health on the person's iPhone.".to_owned(),
        "removed" => "Taken out of Apple Health again.".to_owned(),
        "refused" => format!(
            "The iPhone didn't save it: {}",
            said.unwrap_or("it gave no reason.")
        ),
        _ => "Waiting for the person's iPhone. It saves this the next time it wakes or is opened; `logged` shows when it has.".to_owned(),
    }
}

impl Health {
    /// The phones to wake because an entry waits for them. Each is given once.
    pub fn take_wakes(&self) -> Vec<String> {
        let mut wake = self
            .wake
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        wake.drain().collect()
    }

    fn wake(&self, device: &str) {
        let mut wake = self
            .wake
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        wake.insert(device.to_owned());
    }

    /// The phone that sends the readings: the one that sent last.
    async fn phone(&self) -> Result<String, String> {
        sqlx::query_scalar::<_, String>(
            "SELECT device FROM (
               SELECT device, received_at FROM health_days
               UNION ALL SELECT device, received_at FROM health_events)
             ORDER BY received_at DESC LIMIT 1",
        )
        .fetch_optional(self.db.reader())
        .await
        .map_err(|e| failed(&e))?
        .ok_or_else(|| {
            "No iPhone has sent Health readings to this computer yet, so there's no Health to log into. The person turns on Apple Health in LoomWatch on their iPhone first.".to_owned()
        })
    }

    async fn row(&self, id: &str) -> Result<Option<sqlx::sqlite::SqliteRow>, String> {
        sqlx::query("SELECT * FROM health_writes WHERE id = $1")
            .bind(id)
            .fetch_optional(self.db.reader())
            .await
            .map_err(|e| failed(&e))
    }

    /// Waits up to [`PHONE_WAIT`] for the phone to answer for `id`, then says where it stands.
    async fn answer_for(&self, id: &str) -> Result<Value, String> {
        let started = tokio::time::Instant::now();
        loop {
            let row = self.row(id).await?.ok_or_else(|| {
                "That entry is gone: the phone or the tool was removed.".to_owned()
            })?;
            let state: String = row.get("state");
            if state != "waiting" || started.elapsed() >= self.phone_wait {
                let mut answer = listed(&row);
                answer["inWords"] = json!(in_words(
                    &state,
                    row.get::<Option<String>, _>("said").as_deref()
                ));
                return Ok(answer);
            }
            tokio::time::sleep(LOOK_EVERY).await;
        }
    }

    /// Logs a meal, water or a weight for the phone to save in Health, and waits a while for it.
    pub(super) async fn log(&self, call: &str, arguments: &Value) -> Result<Value, String> {
        let kind = kind_of(call).ok_or_else(|| format!("There's no action called {call} here."))?;
        let at = when(arguments)?;
        let amounts = amounts(kind, arguments)?;
        let name = if kind == "meal" {
            short(text(arguments, "name").as_deref())
        } else {
            None
        };
        let device = self.phone().await?;
        let id = format!("lw-{}", uuid::Uuid::new_v4());
        sqlx::query(
            "INSERT INTO health_writes (id, device, action, kind, at, day, name, amounts, state, asked_at)
             VALUES ($1, $2, 'add', $3, $4, $5, $6, $7, 'waiting', $8)",
        )
        .bind(&id)
        .bind(&device)
        .bind(kind)
        .bind(at.to_rfc3339_opts(chrono::SecondsFormat::Secs, false))
        .bind(at.date_naive().to_string())
        .bind(&name)
        .bind(Value::Object(amounts).to_string())
        .bind(now_text())
        .execute(self.db.writer())
        .await
        .map_err(|e| failed(&e))?;
        self.wake(&device);
        self.answer_for(&id).await
    }

    /// Takes an entry logged here back out of Health.
    pub(super) async fn remove(&self, arguments: &Value) -> Result<Value, String> {
        let target = text(arguments, "id").ok_or("Give `id`: one `logged` lists.")?;
        let row = self
            .row(&target)
            .await?
            .filter(|row| row.get::<String, _>("action") == "add")
            .ok_or("There's no entry logged here with that id. `logged` lists them; only those can be removed.")?;
        let state: String = row.get("state");
        let device: String = row.get("device");
        match state.as_str() {
            "removed" => return Err("That entry was already taken out of Health.".to_owned()),
            "refused" => {
                return Err(
                    "That entry was never saved in Health, so there's nothing to take out."
                        .to_owned(),
                );
            }
            // Not taken yet: the phone never sees it.
            "waiting" => {
                let changed = sqlx::query(
                    "UPDATE health_writes SET state = 'removed', said = 'Removed before the iPhone saved it.', settled_at = $2
                     WHERE id = $1 AND state = 'waiting'",
                )
                .bind(&target)
                .bind(now_text())
                .execute(self.db.writer())
                .await
                .map_err(|e| failed(&e))?;
                if changed.rows_affected() == 1 {
                    return Ok(
                        json!({"id": target, "state": "removed", "inWords": "The iPhone hadn't saved it yet, so it won't be."}),
                    );
                }
            }
            _ => {}
        }
        let id = format!("lw-{}", uuid::Uuid::new_v4());
        sqlx::query(
            "INSERT INTO health_writes (id, device, action, kind, at, day, name, amounts, target, state, asked_at)
             SELECT $1, device, 'remove', kind, at, day, name, amounts, id, 'waiting', $2
             FROM health_writes WHERE id = $3",
        )
        .bind(&id)
        .bind(now_text())
        .bind(&target)
        .execute(self.db.writer())
        .await
        .map_err(|e| failed(&e))?;
        self.wake(&device);
        self.answer_for(&id).await
    }

    /// The entries logged here between two days, newest last, with where each stands.
    pub(super) async fn logged(&self, arguments: &Value) -> Result<Value, String> {
        let (from, to) = range(arguments, false)?;
        let rows = sqlx::query(
            "SELECT * FROM health_writes WHERE action = 'add' AND day BETWEEN $1 AND $2
             ORDER BY at LIMIT $3",
        )
        .bind(&from)
        .bind(&to)
        .bind(MAX_LISTED)
        .fetch_all(self.db.reader())
        .await
        .map_err(|e| failed(&e))?;
        let entries: Vec<Value> = rows
            .iter()
            .map(|row| {
                let mut entry = listed(row);
                if let Some(entry) = entry.as_object_mut() {
                    entry.remove("action");
                    entry.remove("target");
                }
                entry
            })
            .collect();
        Ok(json!({ "from": from, "to": to, "entries": entries }))
    }

    /// The entries waiting for phone `device`, oldest first.
    pub(super) async fn waiting_for(&self, device: &str) -> Result<Vec<Value>, String> {
        let rows = sqlx::query(
            "SELECT * FROM health_writes WHERE device = $1 AND state = 'waiting'
             ORDER BY asked_at, id LIMIT $2",
        )
        .bind(device)
        .bind(MAX_LISTED)
        .fetch_all(self.db.reader())
        .await
        .map_err(|e| failed(&e))?;
        Ok(rows
            .iter()
            .map(|row| {
                let mut entry = listed(row);
                if let Some(entry) = entry.as_object_mut() {
                    entry.remove("state");
                    entry.remove("said");
                }
                entry
            })
            .collect())
    }

    /// Phone `device` says how entry `id` went. Only its own, and only once.
    pub(super) async fn settle(
        &self,
        device: &str,
        id: &str,
        saved: bool,
        said: Option<&str>,
    ) -> Result<bool, String> {
        let mut writing = self.db.writer().begin().await.map_err(|e| failed(&e))?;
        let changed = sqlx::query(
            "UPDATE health_writes SET state = $3, said = $4, settled_at = $5
             WHERE id = $1 AND device = $2 AND state = 'waiting'",
        )
        .bind(id)
        .bind(device)
        .bind(if saved { "saved" } else { "refused" })
        .bind(if saved { None } else { short(said) })
        .bind(now_text())
        .execute(&mut *writing)
        .await
        .map_err(|e| failed(&e))?;
        if changed.rows_affected() == 1 && saved {
            sqlx::query(
                "UPDATE health_writes SET state = 'removed', settled_at = $2
                 WHERE id = (SELECT target FROM health_writes WHERE id = $1 AND action = 'remove')",
            )
            .bind(id)
            .bind(now_text())
            .execute(&mut *writing)
            .await
            .map_err(|e| failed(&e))?;
        }
        writing.commit().await.map_err(|e| failed(&e))?;
        Ok(changed.rows_affected() == 1)
    }
}

/// The calls that log into Health, made like the reading calls by `call`. Logging and removing
/// change the person's Health, so they aren't marked as reading; a remove can't be undone.
pub(super) fn calls(call: &dyn Fn(&str, &str, &str, Value) -> ToolCall) -> Vec<ToolCall> {
    let writes = |name: &str, title: &str, description: &str, schema: Value| ToolCall {
        read_only: false,
        cant_undo: name == "remove_logged",
        ..call(name, title, description, schema)
    };
    let range = json!({
        "from": {"type": "string", "description": "A day, 2026-10-01. Without it, 30 days before `to`."},
        "to": {"type": "string", "description": "A day. Without it, today."},
    });
    let at = json!({"type": "string", "description": "When, with its offset: 2026-11-09T12:30:00+07:00. Without it, now."});
    let number = |what: &str| json!({"type": "number", "description": what});
    vec![
        writes(
            "log_meal",
            "Log a meal",
            "Saves what the person ate in Apple Health on their iPhone: energy and, when known, protein, carbs and fat. Give at least one amount. Says whether the phone saved it.",
            json!({"type": "object", "properties": {
                "at": at,
                "name": {"type": "string", "description": "What it was, in a few words: Lunch, chicken rice."},
                "energy_kcal": number("Energy in kcal."),
                "protein_g": number("Protein in grams."),
                "carbs_g": number("Carbohydrates in grams."),
                "fat_g": number("Total fat in grams."),
            }}),
        ),
        writes(
            "log_water",
            "Log water",
            "Saves water the person drank in Apple Health on their iPhone. Says whether the phone saved it.",
            json!({"type": "object", "properties": {"at": at, "water_ml": number("Millilitres.")}, "required": ["water_ml"]}),
        ),
        writes(
            "log_weight",
            "Log a weight",
            "Saves the person's body weight in Apple Health on their iPhone. Says whether the phone saved it.",
            json!({"type": "object", "properties": {"at": at, "weight_kg": number("Kilograms.")}, "required": ["weight_kg"]}),
        ),
        call(
            "logged",
            "What was logged",
            "The meals, water and weights logged into Health from here in the days asked about, each with its id and whether the phone has saved it.",
            json!({"type": "object", "properties": range}),
        ),
        writes(
            "remove_logged",
            "Remove a logged entry",
            "Takes an entry logged from here back out of Apple Health, by the id `logged` gives. Only entries logged from here can be removed.",
            json!({"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}),
        ),
    ]
}
