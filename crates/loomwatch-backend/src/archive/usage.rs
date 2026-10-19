//! What the model calls of the last days used, by source, day, team and agent (ADR 0073).
//!
//! Read from `model_calls`, which the database fills from every archived `usage` event, so Ask's
//! calls are counted as well as runs'. Nothing here asks a provider: a `ChatGPT` plan tells an app
//! nothing of its limits, an Anthropic key nothing of its balance. The Usage page says what
//! `LoomWatch` itself sent, and links to each provider for the rest.

use anyhow::{Context, Result};
use serde::Serialize;
use sqlx::Row;

use super::EventArchive;

/// The usage of the last `days` days.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    /// RFC 3339: the start of the window.
    pub since: String,
    pub sources: Vec<SourceUsage>,
    /// One entry per day and source that had calls, oldest first. Days are UTC dates.
    pub days: Vec<DayUsage>,
    /// One entry per team (or Ask), agent and source, the costliest first.
    pub agents: Vec<AgentUsage>,
}

/// One source's calls in the window, with the recent ones that its limits count.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceUsage {
    /// `openrouter`, `chatgpt` or `anthropic`.
    pub source: String,
    pub total: Tally,
    /// The last five hours: a `ChatGPT` Plus plan's short limit counts these.
    pub last_five_hours: Tally,
    /// The last seven days: a `ChatGPT` plan's weekly share counts these.
    pub last_seven_days: Tally,
    /// Days in the window with at least one call.
    pub active_days: u64,
    /// The busiest day's tokens.
    pub peak_day_tokens: u64,
    /// The last time a call through this source stopped at a limit or ran out of credit, if one
    /// did in the window.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_problem: Option<LastProblem>,
}

/// Calls, tokens and dollars.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tally {
    pub calls: u64,
    pub input_tokens: u64,
    pub cached_tokens: u64,
    pub output_tokens: u64,
    /// Dollars, for `OpenRouter` and Anthropic. Always 0 for a `ChatGPT` plan.
    pub cost_usd: f64,
    /// Some of `cost_usd` was worked out from list prices.
    pub cost_estimated: bool,
}

impl Tally {
    /// Every token, read or written.
    #[must_use]
    pub const fn tokens(&self) -> u64 {
        self.input_tokens + self.cached_tokens + self.output_tokens
    }
}

/// A stop the app can show next to a source's usage.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastProblem {
    /// `plan_limit`, `out_of_credits`, `rate_limited`…
    pub kind: String,
    pub at: String,
}

/// One day's calls through one source.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayUsage {
    /// `2026-10-19`.
    pub day: String,
    pub source: String,
    #[serde(flatten)]
    pub tally: Tally,
}

/// One agent's calls through one source.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    /// The team's name when the run recorded it; `None` for Ask and for runs from before names
    /// were kept.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team: Option<String>,
    /// Whether these were Ask's calls.
    pub ask: bool,
    pub agent_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_name: Option<String>,
    pub source: String,
    pub runs: u64,
    #[serde(flatten)]
    pub tally: Tally,
}

/// The sums every query below selects, in this order.
const TALLY: &str = "COUNT(*) AS calls, COALESCE(SUM(input_tokens), 0) AS input_tokens,
     COALESCE(SUM(cached_read_tokens + cached_write_tokens), 0) AS cached_tokens,
     COALESCE(SUM(output_tokens), 0) AS output_tokens, COALESCE(SUM(cost_usd), 0.0) AS cost_usd,
     COALESCE(MAX(cost_estimated), 0) AS cost_estimated";

fn tally(row: &sqlx::sqlite::SqliteRow) -> Result<Tally> {
    let count = |name: &str| -> Result<u64> {
        let value: i64 = row.try_get(name)?;
        Ok(u64::try_from(value).unwrap_or(0))
    };
    let estimated: i64 = row.try_get("cost_estimated")?;
    Ok(Tally {
        calls: count("calls")?,
        input_tokens: count("input_tokens")?,
        cached_tokens: count("cached_tokens")?,
        output_tokens: count("output_tokens")?,
        cost_usd: row.try_get("cost_usd")?,
        cost_estimated: estimated != 0,
    })
}

impl EventArchive {
    /// The usage of the `days` days before `now`.
    ///
    /// # Errors
    ///
    /// When the archive can't be read.
    pub async fn model_usage(
        &self,
        now: chrono::DateTime<chrono::Utc>,
        days: u32,
    ) -> Result<UsageReport> {
        self.flush().await;
        let stamp = |at: chrono::DateTime<chrono::Utc>| {
            at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        };
        let since = stamp(now - chrono::Duration::days(i64::from(days)));
        let mut sources: Vec<SourceUsage> = Vec::new();
        for (source, total) in self.tallies_since(&since).await? {
            sources.push(SourceUsage {
                source,
                total,
                last_five_hours: Tally::default(),
                last_seven_days: Tally::default(),
                active_days: 0,
                peak_day_tokens: 0,
                last_problem: None,
            });
        }
        let recent = self
            .tallies_since(&stamp(now - chrono::Duration::hours(5)))
            .await?;
        let week = self
            .tallies_since(&stamp(now - chrono::Duration::days(7)))
            .await?;
        let days_used = self.days_since(&since).await?;
        let problems = self.problems_since(&since).await?;
        for entry in &mut sources {
            let find = |tallies: &[(String, Tally)]| {
                tallies
                    .iter()
                    .find(|(source, _)| *source == entry.source)
                    .map(|(_, tally)| *tally)
                    .unwrap_or_default()
            };
            entry.last_five_hours = find(&recent);
            entry.last_seven_days = find(&week);
            let mine = days_used.iter().filter(|day| day.source == entry.source);
            entry.active_days = u64::try_from(mine.clone().count()).unwrap_or(u64::MAX);
            entry.peak_day_tokens = mine.map(|day| day.tally.tokens()).max().unwrap_or(0);
            entry.last_problem = problems
                .iter()
                .find(|(source, _)| *source == entry.source)
                .map(|(_, problem)| problem.clone());
        }
        Ok(UsageReport {
            agents: self.agents_since(&since).await?,
            since,
            sources,
            days: days_used,
        })
    }

    /// Each source's calls since `since`.
    async fn tallies_since(&self, since: &str) -> Result<Vec<(String, Tally)>> {
        let rows = sqlx::query(&format!(
            "SELECT source, {TALLY} FROM model_calls WHERE ts >= $1 GROUP BY source"
        ))
        .bind(since)
        .fetch_all(self.db.reader())
        .await
        .context("couldn't read usage")?;
        rows.iter()
            .map(|row| Ok((row.try_get("source")?, tally(row)?)))
            .collect()
    }

    /// Each day's calls through each source since `since`, oldest first.
    async fn days_since(&self, since: &str) -> Result<Vec<DayUsage>> {
        let rows = sqlx::query(&format!(
            "SELECT substr(ts, 1, 10) AS day, source, {TALLY} FROM model_calls WHERE ts >= $1
             GROUP BY day, source ORDER BY day ASC, source ASC"
        ))
        .bind(since)
        .fetch_all(self.db.reader())
        .await
        .context("couldn't read usage by day")?;
        rows.iter()
            .map(|row| {
                Ok(DayUsage {
                    day: row.try_get("day")?,
                    source: row.try_get("source")?,
                    tally: tally(row)?,
                })
            })
            .collect()
    }

    /// Each team's (or Ask's) agents' calls through each source since `since`, the costliest
    /// first.
    async fn agents_since(&self, since: &str) -> Result<Vec<AgentUsage>> {
        let rows = sqlx::query(&format!(
            "SELECT runs.team_name AS team, calls.agent_id AS agent_id,
                    json_extract(runs.agent_names, '$.\"' || calls.agent_id || '\"') AS agent_name,
                    calls.source AS source, COUNT(DISTINCT calls.session_id) AS runs, {TALLY}
             FROM model_calls AS calls LEFT JOIN runs ON runs.session_id = calls.session_id
             WHERE calls.ts >= $1
             GROUP BY runs.team_name, calls.agent_id, calls.source
             ORDER BY cost_usd DESC, output_tokens DESC"
        ))
        .bind(since)
        .fetch_all(self.db.reader())
        .await
        .context("couldn't read usage by agent")?;
        rows.iter()
            .map(|row| {
                let agent_id: String = row.try_get("agent_id")?;
                let runs: i64 = row.try_get("runs")?;
                Ok(AgentUsage {
                    team: row.try_get("team")?,
                    ask: agent_id == crate::control::AGENT_ID,
                    agent_name: row.try_get("agent_name")?,
                    agent_id,
                    source: row.try_get("source")?,
                    runs: u64::try_from(runs).unwrap_or(0),
                    tally: tally(row)?,
                })
            })
            .collect()
    }

    /// The last limit or credit stop of each source since `since`.
    async fn problems_since(&self, since: &str) -> Result<Vec<(String, LastProblem)>> {
        let rows = sqlx::query(
            "SELECT json_extract(payload, '$.problem.source') AS source,
                    json_extract(payload, '$.problem.kind') AS kind, MAX(ts) AS at
             FROM run_events
             WHERE kind = 'session_meta' AND ts >= $1
               AND json_extract(payload, '$.problem.kind')
                   IN ('plan_limit', 'out_of_credits', 'rate_limited', 'plan_not_eligible')
             GROUP BY source",
        )
        .bind(since)
        .fetch_all(self.db.reader())
        .await
        .context("couldn't read usage limits")?;
        let mut problems = Vec::new();
        for row in &rows {
            let source: Option<String> = row.try_get("source")?;
            if let Some(source) = source {
                problems.push((
                    source,
                    LastProblem {
                        kind: row.try_get("kind")?,
                        at: row.try_get("at")?,
                    },
                ));
            }
        }
        Ok(problems)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use crate::db::Db;
    use crate::{EventKind, RunEvent};

    use super::*;

    fn event(
        id: &str,
        session: &str,
        agent: &str,
        ts: &str,
        kind: EventKind,
        payload: Value,
    ) -> RunEvent {
        RunEvent {
            id: id.into(),
            session_id: session.into(),
            agent_id: agent.into(),
            seq: id
                .rsplit(':')
                .next()
                .and_then(|seq| seq.parse().ok())
                .unwrap_or(0),
            ts: ts.into(),
            kind,
            payload,
            raw: None,
        }
    }

    fn call(model: &str, input: u64, output: u64, cost: f64, paid_by: Option<&str>) -> Value {
        let mut call = json!({
            "kind": "work", "turn": "work", "model": model, "inputTokens": input,
            "cachedReadTokens": 0, "cachedWriteTokens": 0, "outputTokens": output,
            "reasoningTokens": 0, "costUsd": cost, "webSearches": 0, "webFetches": 0,
        });
        if let Some(source) = paid_by {
            call["paidBy"] = json!(source);
            if source == "anthropic" {
                call["costEstimated"] = json!(true);
            }
        }
        json!({"sessionUpdate": "usage_update", "used": 1, "cost": {"amount": cost, "currency": "USD"},
               "_meta": {"loomwatch": {"call": call}}})
    }

    /// Calls through each source, one outside the window, an older usage shape, and a limit hit.
    fn archived() -> Vec<RunEvent> {
        vec![
            event(
                "r:0",
                "r",
                "writer",
                "2026-10-19T10:00:00.000Z",
                EventKind::Usage,
                call("chatgpt:gpt-6.1-sol", 100, 20, 0.0, Some("chatgpt")),
            ),
            event(
                "r:1",
                "r",
                "writer",
                "2026-10-15T10:00:00.000Z",
                EventKind::Usage,
                call("chatgpt:gpt-6.1-sol", 300, 30, 0.0, Some("chatgpt")),
            ),
            event(
                "r:2",
                "r",
                "checker",
                "2026-10-19T11:00:00.000Z",
                EventKind::Usage,
                call(
                    "anthropic:claude-opus-5-5",
                    1000,
                    100,
                    0.25,
                    Some("anthropic"),
                ),
            ),
            event(
                "a:0",
                "a",
                crate::control::AGENT_ID,
                "2026-10-18T09:00:00.000Z",
                EventKind::Usage,
                call("anthropic/claude-opus-5.5", 50, 5, 0.01, None),
            ),
            // Outside the window.
            event(
                "r:3",
                "r",
                "writer",
                "2026-08-01T10:00:00.000Z",
                EventKind::Usage,
                call("chatgpt:gpt-6.1-sol", 999, 999, 0.0, Some("chatgpt")),
            ),
            // A usage update without a call record (an older shape) is not a call.
            event(
                "r:4",
                "r",
                "writer",
                "2026-10-19T10:30:00.000Z",
                EventKind::Usage,
                json!({"sessionUpdate": "usage_update", "used": 1}),
            ),
            event(
                "r:5",
                "r",
                "writer",
                "2026-10-19T11:30:00.000Z",
                EventKind::SessionMeta,
                json!({"phase": "turn_failed", "reason": "app_error", "message": "limit",
                     "problem": {"kind": "plan_limit", "source": "chatgpt", "url": "https://chatgpt.com/settings/usage"}}),
            ),
        ]
    }

    /// Every archived call lands in the ledger by itself, and the report sums it by source, day
    /// and agent, with the recent windows a plan's limits count and the last limit hit.
    #[tokio::test]
    async fn usage_is_summed_by_source_day_and_agent() -> Result<()> {
        let archive = EventArchive::new(Db::temp().await);
        let now: chrono::DateTime<chrono::Utc> = "2026-10-19T12:00:00Z".parse()?;
        let events = archived();
        for event in &events {
            archive.append(event).await?;
        }
        let report = archive.model_usage(now, 30).await?;
        let source = |name: &str| {
            report
                .sources
                .iter()
                .find(|entry| entry.source == name)
                .unwrap()
        };

        let plan = source("chatgpt");
        assert_eq!((plan.total.calls, plan.total.tokens()), (2, 450));
        assert_eq!(plan.last_five_hours.calls, 1);
        assert_eq!(plan.last_seven_days.calls, 2);
        assert_eq!((plan.active_days, plan.peak_day_tokens), (2, 330));
        assert!(plan.total.cost_usd.abs() < 1e-9);
        assert_eq!(
            plan.last_problem
                .as_ref()
                .map(|problem| problem.kind.as_str()),
            Some("plan_limit")
        );

        let claude = source("anthropic");
        assert!((claude.total.cost_usd - 0.25).abs() < 1e-9 && claude.total.cost_estimated);
        let openrouter = source("openrouter");
        assert_eq!(openrouter.total.calls, 1);
        assert!(!openrouter.total.cost_estimated && openrouter.last_problem.is_none());

        assert_eq!(
            report.days.first().map(|day| day.day.as_str()),
            Some("2026-10-15")
        );
        assert!(
            report
                .agents
                .iter()
                .any(|agent| agent.ask && agent.source == "openrouter")
        );
        let checker = report
            .agents
            .iter()
            .find(|agent| agent.agent_id == "checker")
            .unwrap();
        assert_eq!((checker.source.as_str(), checker.runs), ("anthropic", 1));
        // The costliest first.
        assert_eq!(report.agents[0].agent_id, "checker");
        Ok(())
    }
}
