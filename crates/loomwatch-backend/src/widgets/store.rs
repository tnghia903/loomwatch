//! The `widgets` table: each succeeded run's answer's widgets, and what the person last made of
//! them (ADR 0114). Written once when the run ends, from its archive; the person's state is
//! changed in place, never appended to the run's events, which are evidence.

use std::collections::BTreeMap;

use serde_json::Value;
use sqlx::Row;

use super::{Kept, Widget};
use crate::db::Db;

/// Keep `widgets` as `run_id`'s answer's, numbered from 1, each with the line of the answer it
/// stands before (`None` at the end). A run's widgets are kept once: a second call changes nothing.
///
/// # Errors
///
/// When the database fails.
pub(crate) async fn keep(
    db: &Db,
    run_id: &str,
    widgets: &[(Widget, Option<u32>)],
) -> Result<(), sqlx::Error> {
    for (at, (widget, line)) in widgets.iter().enumerate() {
        let spec = serde_json::to_string(widget).unwrap_or_else(|_| "{}".to_owned());
        sqlx::query(
            "INSERT OR IGNORE INTO widgets (run_id, n, kind, title, spec, line)
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(run_id)
        .bind(i64::try_from(at + 1).unwrap_or(i64::MAX))
        .bind(widget.kind())
        .bind(widget.title())
        .bind(spec)
        .bind(line.map(i64::from))
        .execute(db.writer())
        .await?;
    }
    Ok(())
}

/// The widgets kept with these runs, in order, by run.
///
/// # Errors
///
/// When the database fails.
pub(crate) async fn of_runs(
    db: &Db,
    run_ids: &[String],
) -> Result<BTreeMap<String, Vec<Kept>>, sqlx::Error> {
    let mut by_run: BTreeMap<String, Vec<Kept>> = BTreeMap::new();
    if run_ids.is_empty() {
        return Ok(by_run);
    }
    let rows = sqlx::query(
        "SELECT run_id, n, line, spec, state, changed_at FROM widgets
         WHERE run_id IN (SELECT value FROM json_each($1))
         ORDER BY run_id, n",
    )
    .bind(crate::db::json_list(run_ids))
    .fetch_all(db.reader())
    .await?;
    for row in &rows {
        if let Some(kept) = decode(row)? {
            by_run.entry(row.try_get("run_id")?).or_default().push(kept);
        }
    }
    Ok(by_run)
}

/// One widget kept with `run_id`.
///
/// # Errors
///
/// When the database fails.
pub(crate) async fn one(db: &Db, run_id: &str, n: u32) -> Result<Option<Kept>, sqlx::Error> {
    let row = sqlx::query(
        "SELECT run_id, n, line, spec, state, changed_at FROM widgets WHERE run_id = $1 AND n = $2",
    )
    .bind(run_id)
    .bind(i64::from(n))
    .fetch_optional(db.reader())
    .await?;
    match row {
        Some(row) => decode(&row),
        None => Ok(None),
    }
}

/// Keep what the person made of one widget, checked beforehand ([`super::read_state`]).
///
/// # Errors
///
/// When the database fails.
pub(crate) async fn set_state(
    db: &Db,
    run_id: &str,
    n: u32,
    state: &Value,
    at: &str,
) -> Result<bool, sqlx::Error> {
    let done =
        sqlx::query("UPDATE widgets SET state = $3, changed_at = $4 WHERE run_id = $1 AND n = $2")
            .bind(run_id)
            .bind(i64::from(n))
            .bind(state.to_string())
            .bind(at)
            .execute(db.writer())
            .await?;
    Ok(done.rows_affected() > 0)
}

/// A row as a kept widget; `None` for one whose spec this version can't read, which is left out
/// rather than failing the page.
fn decode(row: &sqlx::sqlite::SqliteRow) -> Result<Option<Kept>, sqlx::Error> {
    let spec: String = row.try_get("spec")?;
    let Ok(spec) = serde_json::from_str::<Widget>(&spec) else {
        return Ok(None);
    };
    let n: i64 = row.try_get("n")?;
    let line: Option<i64> = row.try_get("line")?;
    let state: Option<String> = row.try_get("state")?;
    Ok(Some(Kept {
        n: u32::try_from(n).unwrap_or_default(),
        line: line.and_then(|line| u32::try_from(line).ok()),
        spec,
        state: state.and_then(|state| serde_json::from_str(&state).ok()),
        changed_at: row.try_get("changed_at")?,
    }))
}
