//! What the model calls of the last days used, by source, day, team and agent (ADR 0073).
//!
//! Read from `model_calls`, which the database fills from every archived `usage` event, so Ask's
//! calls are counted as well as runs'. Nothing here asks a provider: a `ChatGPT` plan tells an app
//! nothing of its limits, an Anthropic key nothing of its balance. The Usage page says what
//! `LoomWatch` itself sent, and links to each provider for the rest.
//!
//! Every call is one of two kinds (ADR 0106): an agent's work, for a team or in its chat, or
//! `LoomWatch`'s own help: Ask, reading a message, checking an answer against it, learning from
//! feedback, the next steps under the notch's box, choosing an agent's model. Each source's total
//! and each day say how much of it was `LoomWatch`'s own, and its own help is listed by what it
//! did; the agents' list holds only their work.

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
    /// One entry per team, agent and source, the costliest first: the agents' work only.
    pub agents: Vec<AgentUsage>,
    /// `LoomWatch`'s own help, one entry per feature and source, the costliest first.
    pub features: Vec<FeatureUsage>,
}

/// What `LoomWatch` did for the person with a model, besides the agents' work: what [`FEATURE`]
/// names a call by.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureUsage {
    /// `ask`, `reading`, `checking`, `learning`, `next_steps` or `choosing_models`.
    pub feature: String,
    pub source: String,
    #[serde(flatten)]
    pub tally: Tally,
}

/// One source's calls in the window, with the recent ones that its limits count.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceUsage {
    /// `openrouter`, `chatgpt` or `anthropic`.
    pub source: String,
    pub total: Tally,
    /// How much of `total` was `LoomWatch`'s own help; the rest was the agents' work.
    pub loomwatch: Tally,
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
    /// How much of the day's was `LoomWatch`'s own help.
    pub loomwatch: Tally,
}

/// One agent's calls through one source.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    /// The team's name when the run recorded it; `None` for an agent's answer in its chat with no
    /// run, and for runs from before names were kept.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team: Option<String>,
    pub agent_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_name: Option<String>,
    pub source: String,
    pub runs: u64,
    #[serde(flatten)]
    pub tally: Tally,
}

/// Which of `LoomWatch`'s own features a call in `model_calls AS calls` was for, or NULL for an
/// agent's work. `LoomWatch`'s check and the calls it records itself are told by who made them or
/// what they were; Ask, its reader and its learner only when no run has their session, so an agent
/// a team calls "ask" or "reader" is still the team's.
pub(crate) static FEATURE: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
    let alone = "NOT EXISTS (SELECT 1 FROM runs WHERE runs.session_id = calls.session_id)";
    format!(
        "CASE
             WHEN calls.call_kind = '{NEXT_STEPS}' THEN 'next_steps'
             WHEN calls.call_kind = '{CHOOSING_MODELS}' THEN 'choosing_models'
             WHEN calls.agent_id = '{checker}' THEN 'checking'
             WHEN calls.agent_id = '{ask}' AND {alone} THEN 'ask'
             WHEN calls.agent_id = '{reader}' AND {alone} THEN 'reading'
             WHEN calls.agent_id = '{learner}' AND {alone} THEN 'learning'
         END",
        checker = crate::message_done::CHECKER_ID,
        ask = crate::control::AGENT_ID,
        reader = crate::intent::READER_ID,
        learner = crate::lessons::LEARNER_ID,
    )
});

/// What `call_kind` a call `LoomWatch` records itself carries: the next steps under the notch's
/// box, and reading an agent's setup to choose its model.
pub(crate) const NEXT_STEPS: &str = "next_steps";
pub(crate) const CHOOSING_MODELS: &str = "choosing_models";

/// A call `LoomWatch` made for itself outside any session's events, to count with the rest.
pub(crate) struct OwnCall<'a> {
    /// The session the Usage page names it by: an agent's run's, or the feature's own.
    pub(crate) session: &'a str,
    pub(crate) agent: &'a str,
    pub(crate) kind: &'a str,
    pub(crate) source: &'a str,
    pub(crate) model: &'a str,
    pub(crate) usage: &'a crate::agent::Usage,
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
        let own = self.own_tallies_since(&since).await?;
        let mut sources: Vec<SourceUsage> = Vec::new();
        for (source, total) in self.tallies_since(&since).await? {
            let loomwatch = own
                .iter()
                .find(|(own_source, _)| *own_source == source)
                .map(|(_, tally)| *tally)
                .unwrap_or_default();
            sources.push(SourceUsage {
                source,
                total,
                loomwatch,
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
            features: self.features_since(&since).await?,
            since,
            sources,
            days: days_used,
        })
    }

    /// Count a call `LoomWatch` made for itself, as the Usage page reads every call.
    ///
    /// # Errors
    ///
    /// When the archive can't be written.
    pub(crate) async fn count_call(&self, call: &OwnCall<'_>) -> Result<()> {
        let usage = call.usage;
        let count = |tokens: u64| i64::try_from(tokens).unwrap_or(i64::MAX);
        sqlx::query(
            "INSERT OR IGNORE INTO model_calls (
                 event_id, session_id, agent_id, ts, source, model, call_kind, input_tokens,
                 cached_read_tokens, cached_write_tokens, output_tokens, reasoning_tokens, cost_usd,
                 cost_estimated)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)",
        )
        .bind(format!("{}-{}", call.kind, uuid::Uuid::new_v4()))
        .bind(call.session)
        .bind(call.agent)
        .bind(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .bind(call.source)
        .bind(call.model)
        .bind(call.kind)
        .bind(count(usage.input_tokens))
        .bind(count(usage.cached_read_tokens))
        .bind(count(usage.cached_write_tokens))
        .bind(count(usage.output_tokens))
        .bind(count(usage.reasoning_tokens))
        .bind(usage.cost_usd.max(0.0))
        .bind(usage.cost_estimated)
        .execute(self.db.writer())
        .await
        .context("couldn't count a call")?;
        Ok(())
    }

    /// Each source's calls since `since` that were `LoomWatch`'s own help.
    async fn own_tallies_since(&self, since: &str) -> Result<Vec<(String, Tally)>> {
        let rows = sqlx::query(&format!(
            "SELECT source, {TALLY} FROM model_calls AS calls
             WHERE ts >= $1 AND ({feature}) IS NOT NULL GROUP BY source",
            feature = *FEATURE
        ))
        .bind(since)
        .fetch_all(self.db.reader())
        .await
        .context("couldn't read LoomWatch's own usage")?;
        rows.iter()
            .map(|row| Ok((row.try_get("source")?, tally(row)?)))
            .collect()
    }

    /// `LoomWatch`'s own help since `since`, by feature and source, the costliest first.
    async fn features_since(&self, since: &str) -> Result<Vec<FeatureUsage>> {
        let rows = sqlx::query(&format!(
            "SELECT ({feature}) AS feature, source, {TALLY} FROM model_calls AS calls
             WHERE ts >= $1 AND ({feature}) IS NOT NULL
             GROUP BY feature, source ORDER BY cost_usd DESC, output_tokens DESC",
            feature = *FEATURE
        ))
        .bind(since)
        .fetch_all(self.db.reader())
        .await
        .context("couldn't read LoomWatch's own usage")?;
        rows.iter()
            .map(|row| {
                Ok(FeatureUsage {
                    feature: row.try_get("feature")?,
                    source: row.try_get("source")?,
                    tally: tally(row)?,
                })
            })
            .collect()
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

    /// Each day's calls through each source since `since`, oldest first, with `LoomWatch`'s own
    /// share of each.
    async fn days_since(&self, since: &str) -> Result<Vec<DayUsage>> {
        let rows = sqlx::query(&format!(
            "SELECT substr(ts, 1, 10) AS day, source, {TALLY} FROM model_calls WHERE ts >= $1
             GROUP BY day, source ORDER BY day ASC, source ASC"
        ))
        .bind(since)
        .fetch_all(self.db.reader())
        .await
        .context("couldn't read usage by day")?;
        let own_rows = sqlx::query(&format!(
            "SELECT substr(ts, 1, 10) AS day, source, {TALLY} FROM model_calls AS calls
             WHERE ts >= $1 AND ({feature}) IS NOT NULL GROUP BY day, source",
            feature = *FEATURE
        ))
        .bind(since)
        .fetch_all(self.db.reader())
        .await
        .context("couldn't read LoomWatch's own usage by day")?;
        let mut own = Vec::with_capacity(own_rows.len());
        for row in &own_rows {
            own.push((
                row.try_get::<String, _>("day")?,
                row.try_get::<String, _>("source")?,
                tally(row)?,
            ));
        }
        rows.iter()
            .map(|row| {
                let day: String = row.try_get("day")?;
                let source: String = row.try_get("source")?;
                let loomwatch = own
                    .iter()
                    .find(|(own_day, own_source, _)| *own_day == day && *own_source == source)
                    .map(|(_, _, tally)| *tally)
                    .unwrap_or_default();
                Ok(DayUsage {
                    day,
                    source,
                    tally: tally(row)?,
                    loomwatch,
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
             WHERE calls.ts >= $1 AND ({feature}) IS NULL
             GROUP BY runs.team_name, calls.agent_id, calls.source
             ORDER BY cost_usd DESC, output_tokens DESC",
            feature = *FEATURE
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
        // Ask is LoomWatch's own help, not an agent's work.
        assert!(
            report
                .features
                .iter()
                .any(|feature| feature.feature == "ask" && feature.source == "openrouter")
        );
        assert!(
            report
                .agents
                .iter()
                .all(|agent| agent.agent_id != crate::control::AGENT_ID)
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

    /// Each call is either an agent's work or `LoomWatch`'s own help, told apart by who made it,
    /// what it was, and whether a run has its session: an agent a team calls "reader" or "ask" is
    /// the team's.
    #[tokio::test]
    async fn loomwatchs_own_help_is_told_from_the_agents_work() -> Result<()> {
        let archive = EventArchive::new(Db::temp().await);
        let now: chrono::DateTime<chrono::Utc> = "2026-10-19T12:00:00Z".parse()?;
        sqlx::query(
            "INSERT INTO runs (run_id, session_id, team_path, team_key, prompt, status, mode,
                               entrypoint, responder, created_at, trigger, team_name)
             VALUES ('t', 't', 'news.yaml', 'news', 'Today''s news', 'succeeded', 'team', 'reader',
                     'reader', '2026-10-19T09:00:00Z', 'manual', 'News brief')",
        )
        .execute(archive.db().writer())
        .await?;
        let at = "2026-10-19T10:00:00.000Z";
        let openrouter = |cost| call("anthropic/claude-sonnet-5.5", 100, 10, cost, None);
        for (id, session, agent, cost) in [
            // Work: a team's writer, and the team's own agents called "reader" and "ask".
            ("w:0", "t", "writer", 0.40),
            ("w:1", "t", "reader", 0.20),
            ("w:2", "t", "ask", 0.10),
            // LoomWatch's own: Ask, reading a message, learning, and its check.
            ("o:0", "ask-1", crate::control::AGENT_ID, 0.05),
            ("o:1", "chat-reader-1", crate::intent::READER_ID, 0.01),
            ("o:2", "learner-1", crate::lessons::LEARNER_ID, 0.02),
            ("o:3", "t", crate::message_done::CHECKER_ID, 0.03),
        ] {
            archive
                .append(&event(
                    id,
                    session,
                    agent,
                    at,
                    EventKind::Usage,
                    openrouter(cost),
                ))
                .await?;
        }
        // And the calls LoomWatch counts itself: next steps after the team's answer, on the
        // team's own session, and choosing a model.
        let usage = |cost| crate::agent::Usage {
            input_tokens: 50,
            output_tokens: 5,
            cost_usd: cost,
            ..crate::agent::Usage::default()
        };
        for (session, agent, kind, cost) in [
            ("t", "writer", NEXT_STEPS, 0.004),
            (CHOOSING_MODELS, CHOOSING_MODELS, CHOOSING_MODELS, 0.000_02),
        ] {
            archive
                .count_call(&OwnCall {
                    session,
                    agent,
                    kind,
                    source: "openrouter",
                    model: "anthropic/claude-haiku-5.5",
                    usage: &usage(cost),
                })
                .await?;
        }
        let report = archive
            .model_usage(now + chrono::Duration::days(1), 30)
            .await?;

        let work: Vec<(&str, Option<&str>)> = report
            .agents
            .iter()
            .map(|agent| (agent.agent_id.as_str(), agent.team.as_deref()))
            .collect();
        assert_eq!(
            work,
            [
                ("writer", Some("News brief")),
                ("reader", Some("News brief")),
                ("ask", Some("News brief"))
            ]
        );
        let own: Vec<&str> = report
            .features
            .iter()
            .map(|feature| feature.feature.as_str())
            .collect();
        assert_eq!(
            own,
            [
                "ask",
                "checking",
                "learning",
                "reading",
                "next_steps",
                "choosing_models"
            ]
        );
        let source = &report.sources[0];
        assert_eq!((source.total.calls, source.loomwatch.calls), (9, 6));
        assert!((source.loomwatch.cost_usd - 0.114_02).abs() < 1e-9);
        assert!((source.total.cost_usd - 0.814_02).abs() < 1e-9);
        // Each day says its own share too: the counted calls fall on the day they were made.
        let own_by_day: f64 = report.days.iter().map(|day| day.loomwatch.cost_usd).sum();
        assert!((own_by_day - 0.114_02).abs() < 1e-9);
        Ok(())
    }
}
