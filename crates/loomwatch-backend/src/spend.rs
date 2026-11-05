//! What a run may spend (ADR 0068): a spool of money per run, and an optional guard per agent.
//!
//! Every model call `LoomWatch`'s own agent makes is paid from the operator's `OpenRouter` key, and
//! `OpenRouter` reports exactly what each call cost. The run record keeps the sum, for the whole
//! run and for each agent ([`RunSpend`]), behind the run registry's one lock, so every agent of a
//! run — stages, the lead, Team Bus helpers and dispatches, summaries, checkpoints, handovers —
//! draws on the same spool.
//!
//! Before each call an agent looks at the spool ([`check`]). Once the run has used it, the agent
//! does not fail: it waits at a [`SpendStop`] on the run record, the way it waits at a permission
//! card, until the operator adds more or tells the team to finish ([`answer`]). Nothing is in
//! flight while it waits, so the wait costs nothing and has no time limit. A scheduled run has
//! nobody to ask, so it stops at once and keeps its checkpoints.
//!
//! A call's cost is only known after it is made, so the check comes before the call, and the calls
//! under way when the spool runs out, one for each agent at work, can take the run a few cents
//! past it. The figures say so rather than hide it.

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};

use crate::agent::{Room, WebLimits};
use crate::config::{AgentConfig, TeamConfig};

/// The least automatic limit (ADR 0115): what a run of a team whose file names no figure may spend
/// before it has runs to go by, and the floor after. Generous on purpose: the limit is there to
/// catch a run that went wrong, not to stop the work a team usually does.
pub const AUTOMATIC_LEAST_USD: f64 = 5.0;
/// How many times what its runs usually cost a team's automatic limit is.
pub const AUTOMATIC_TIMES: f64 = 2.0;
/// How many of a team's latest runs say what its runs usually cost.
pub const AUTOMATIC_RUNS: usize = 10;
/// The least "Add and carry on" offers.
const MIN_TOP_UP_USD: f64 = 0.10;
/// The most one answer may add, so a slip of the keyboard can't add a fortune.
pub const MAX_TOP_UP_USD: f64 = 1000.0;

/// The `spend:` block, on a team or an agent.
#[derive(Debug, Clone, Copy, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SpendConfig {
    /// The most one run may spend, in dollars.
    pub per_run: Option<f64>,
    /// How much web reading one model call may do. On an agent, each figure it leaves out is the
    /// team's; one the team leaves out too is the built-in default ([`WebLimits::default`]).
    pub web: WebConfig,
}

impl SpendConfig {
    /// The figure, when it is one a run can be held to.
    fn limit(self) -> Option<f64> {
        self.per_run.filter(|usd| usd.is_finite() && *usd > 0.0)
    }
}

/// `spend.web`: what one model call may read from the web. Every figure is optional.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct WebConfig {
    /// How much of one page is read, in tokens (a token is about three quarters of a word).
    pub max_page_tokens: Option<u32>,
    /// Pages read in one model call.
    pub max_pages: Option<u32>,
    /// Searches in one model call.
    pub max_searches: Option<u32>,
    /// Searches and page reads together in one model call.
    pub max_steps: Option<u32>,
}

/// The range each `spend.web` figure may take: what `OpenRouter` accepts (a fetch reads at most 50
/// pages and a request takes at most 30 server-tool steps), and no page so short it says nothing.
const WEB_RANGES: [(&str, u32, u32); 4] = [
    ("maxPageTokens", 500, 100_000),
    ("maxPages", 1, 50),
    ("maxSearches", 1, 25),
    ("maxSteps", 1, 30),
];

impl WebConfig {
    /// This block with what it leaves out taken from `team`'s.
    #[must_use]
    pub fn over(self, team: Self) -> Self {
        Self {
            max_page_tokens: self.max_page_tokens.or(team.max_page_tokens),
            max_pages: self.max_pages.or(team.max_pages),
            max_searches: self.max_searches.or(team.max_searches),
            max_steps: self.max_steps.or(team.max_steps),
        }
    }

    /// The limits a session is held to: each figure given, or the built-in default (a page length;
    /// no count, which leaves the counts to `OpenRouter`).
    #[must_use]
    pub fn limits(self) -> WebLimits {
        let default = WebLimits::default();
        WebLimits {
            page_tokens: self.max_page_tokens.unwrap_or(default.page_tokens),
            pages: self.max_pages.or(default.pages),
            searches: self.max_searches.or(default.searches),
            steps: self.max_steps.or(default.steps),
        }
    }

    /// A figure outside what `OpenRouter` takes, said for the file it is in.
    ///
    /// # Errors
    ///
    /// Names the field, its value and the range.
    pub fn validate(self, whose: &str) -> Result<(), String> {
        let values = [
            self.max_page_tokens,
            self.max_pages,
            self.max_searches,
            self.max_steps,
        ];
        for ((field, least, most), value) in WEB_RANGES.into_iter().zip(values) {
            if let Some(value) = value.filter(|value| !(least..=most).contains(value)) {
                return Err(format!(
                    "{whose} spend.web.{field} is {value}; it must be between {least} and {most}."
                ));
            }
        }
        Ok(())
    }
}

/// What a run has spent and may spend. On the run record, and stored with it, so a finished run
/// still shows its spool.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSpend {
    /// The team's spool for this run, with whatever the operator added: the team file's figure,
    /// or the automatic limit (ADR 0115). `None` only on runs from before that.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit_usd: Option<f64>,
    /// Every model call of the run, added up.
    #[serde(default)]
    pub spent_usd: f64,
    /// Each agent's share, and its own guard when it has one.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub agents: BTreeMap<String, AgentSpend>,
    /// What the operator added, in order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub added: Vec<TopUp>,
    /// Set once the run may make no more calls at all.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stopped: Option<Stopped>,
    /// The limit is `LoomWatch`'s, from what the team's runs usually cost, because its file names
    /// no figure (ADR 0115). Absent on a limit the team file sets, and on runs from before.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub automatic: bool,
    /// What the team's latest runs that succeeded usually cost (the middle of what they spent),
    /// which an automatic limit is worked out from. Absent before the team has a run that spent
    /// anything.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usual_usd: Option<f64>,
    /// How many runs `usual_usd` is the middle of.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub usual_runs: u32,
}

#[expect(
    clippy::trivially_copy_pass_by_ref,
    reason = "serde's skip_serializing_if passes a reference"
)]
fn is_zero(count: &u32) -> bool {
    *count == 0
}

// The run record compares as `Eq`. Every amount here is a finite number of dollars — `count`
// drops anything else, and `answer` refuses it — so equality is reflexive.
impl Eq for RunSpend {}

/// One agent's spend in a run.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSpend {
    #[serde(default)]
    pub spent_usd: f64,
    /// The agent's own guard for this run, with whatever the operator added.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit_usd: Option<f64>,
    /// The operator stopped this agent at its guard: it makes no more calls this run.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub stopped: bool,
    /// It was stopped there because nobody answered by the stop's deadline, in a routine's run
    /// (ADR 0090), not because the operator chose to.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unanswered: bool,
}

/// Money the operator added at a stop.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopUp {
    /// The agent whose guard grew; absent for the team's spool.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// The limit it was added at.
    pub at_usd: f64,
    pub add_usd: f64,
}

/// Why a run may make no more calls.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stopped {
    /// The operator chose "Finish with what it has".
    Finished,
    /// A routine's run reached its stop's deadline with nobody answering, and finished with what
    /// it had, as "Finish" would have (ADR 0090).
    NoAnswer,
    /// A scheduled run used its spool, with nobody there to add more. Only runs recorded before
    /// ADR 0090 carry it: since then a routine's run asks, like any other.
    NobodyToAsk,
}

/// A spend stop waiting for the operator: the card. Live only, like a permission request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendStop {
    pub id: String,
    /// The agent whose guard was reached; absent when it is the team's spool.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// That agent's name, for the card.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub limit_usd: f64,
    pub spent_usd: f64,
    /// What "Add and carry on" adds.
    pub add_usd: f64,
    /// The limit reached is the team's automatic one (ADR 0115), not a figure the team file sets.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub automatic: bool,
    /// What the team's runs usually cost, at the team's limit, once it has runs to go by (ADR
    /// 0115): the stop says it, so the person can tell this run from the usual, and a figure set
    /// below it from a run that went wrong.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usual_usd: Option<f64>,
    /// How many runs `usual_usd` is the middle of.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub usual_runs: u32,
    pub since: String,
    /// RFC 3339: when the team finishes with what it has if nobody answers, in a run nobody
    /// started by hand (ADR 0090). Absent in a run someone started, which waits as long as it
    /// takes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

// Finite amounts only, as for `RunSpend`.
impl Eq for SpendStop {}

/// The operator's answer at a stop.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SpendDecision {
    /// Add to the spool (or the guard) and carry on.
    Add,
    /// The team finishes with what it has; at an agent's guard, that agent stops.
    Finish,
}

/// How a stop was answered, for the agents waiting at it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SpendAnswer {
    pub decision: SpendDecision,
    /// What was added, for [`SpendDecision::Add`].
    pub add_usd: Option<f64>,
    /// The limit after the answer.
    pub limit_usd: f64,
}

impl RunSpend {
    /// A new run's spool, from its team file: the team's `spend.perRun`, or the automatic limit
    /// when it names none (ADR 0115), and each agent's own guard. Until the run registry has the
    /// team's past runs to go by ([`RunSpend::go_by`]), the automatic limit is the least one.
    #[must_use]
    pub fn for_team(team: &TeamConfig) -> Self {
        let set = team.spend.limit();
        Self {
            limit_usd: set.or(Some(AUTOMATIC_LEAST_USD)),
            automatic: set.is_none(),
            agents: team
                .agents
                .iter()
                .filter_map(|agent| guard(agent).map(|limit| (agent.id.clone(), limit)))
                .map(|(id, limit)| {
                    (
                        id,
                        AgentSpend {
                            limit_usd: Some(limit),
                            ..AgentSpend::default()
                        },
                    )
                })
                .collect(),
            ..Self::default()
        }
    }

    /// What `agent` may still spend before its next call meets a limit: the least of what the
    /// run's spool and its own guard have left, never below nothing. Nothing left once the run or
    /// the agent was stopped. `None` when neither has a limit.
    #[must_use]
    pub fn left(&self, agent: &str) -> Option<f64> {
        self.room(agent).map(|room| room.left)
    }

    /// What `agent` has left, and of which limit: the run's spool or its own guard, whichever
    /// leaves less. Nothing left once the run or the agent was stopped. `None` with no limit.
    #[must_use]
    pub fn room(&self, agent: &str) -> Option<Room> {
        let mine = self.agents.get(agent);
        let team = self
            .limit_usd
            .map(|limit| (limit - self.spent_usd, limit, false));
        let own = mine.and_then(|mine| {
            mine.limit_usd
                .map(|limit| (limit - mine.spent_usd, limit, true))
        });
        let (left, limit, own) = match (team, own) {
            (Some(team), Some(own)) => {
                if own.0 < team.0 {
                    own
                } else {
                    team
                }
            }
            (one, other) => one.or(other)?,
        };
        let stopped = self.stopped.is_some() || mine.is_some_and(|mine| mine.stopped);
        Some(Room {
            left: if stopped { 0.0 } else { left.max(0.0) },
            limit,
            own,
        })
    }

    /// Takes in what the team's latest runs that succeeded spent: what they usually cost, and from
    /// it, when the limit is automatic, the limit: twice the usual, never below
    /// [`AUTOMATIC_LEAST_USD`]. A limit the team file sets is left as it is.
    pub fn go_by(&mut self, past: &[f64]) {
        self.usual_usd = usual_cost(past);
        self.usual_runs = runs_that_spent(past);
        if self.automatic {
            self.limit_usd = Some(automatic_limit(self.usual_usd));
        }
    }

    /// Adds one call's cost to the run and to `agent`.
    pub fn count(&mut self, agent: &str, usd: f64) {
        if !usd.is_finite() || usd <= 0.0 {
            return;
        }
        self.spent_usd += usd;
        self.agents.entry(agent.to_owned()).or_default().spent_usd += usd;
    }
}

fn guard(agent: &AgentConfig) -> Option<f64> {
    agent.spend.limit()
}

/// What a team's runs usually cost: the middle of what `past` runs spent (the mean of the two
/// middle ones for an even count), counting only runs that spent something. The middle, not the
/// most, so one run that went wrong doesn't raise the next limit.
#[must_use]
pub fn usual_cost(past: &[f64]) -> Option<f64> {
    let mut spent: Vec<f64> = past
        .iter()
        .copied()
        .filter(|usd| usd.is_finite() && *usd > 0.0)
        .collect();
    if spent.is_empty() {
        return None;
    }
    spent.sort_by(f64::total_cmp);
    let middle = spent.len() / 2;
    let usual = if spent.len().is_multiple_of(2) {
        f64::midpoint(spent[middle - 1], spent[middle])
    } else {
        spent[middle]
    };
    Some(micros(usual))
}

/// How many of `past` spent something: the runs [`usual_cost`] is the middle of.
fn runs_that_spent(past: &[f64]) -> u32 {
    let count = past
        .iter()
        .filter(|usd| usd.is_finite() && **usd > 0.0)
        .count();
    u32::try_from(count).unwrap_or(u32::MAX)
}

/// The automatic limit for runs that usually cost `usual`: twice that, up to a whole cent, and
/// never below [`AUTOMATIC_LEAST_USD`].
#[must_use]
pub fn automatic_limit(usual: Option<f64>) -> f64 {
    usual.map_or(AUTOMATIC_LEAST_USD, |usual| {
        cents_up(usual * AUTOMATIC_TIMES).max(AUTOMATIC_LEAST_USD)
    })
}

/// What "Add and carry on" offers at a limit the run has spent `spent` of: what it already went
/// past the limit, then half the limit again (at least ten cents), in whole cents. A call that ran
/// past the limit (a long web search is one call) leaves the run above it, and an offer of half
/// the limit alone could leave the new limit still below what was spent, so the run asked again at
/// once: on 2026-11-04 a $1.00 run that had spent $1.85 took three taps (ADR 0115).
#[must_use]
pub fn top_up_for(limit: f64, spent: f64) -> f64 {
    let over = (spent - limit).max(0.0);
    cents_up(over) + cents((limit / 2.0).max(MIN_TOP_UP_USD))
}

fn cents(usd: f64) -> f64 {
    (usd * 100.0).round() / 100.0
}

/// Up to the next whole cent, so what is added always covers what was spent past the limit.
fn cents_up(usd: f64) -> f64 {
    (micros(usd) * 100.0).ceil() / 100.0
}

/// To the millionth of a dollar, the finest `OpenRouter` prices in, so sums carry no float noise.
fn micros(usd: f64) -> f64 {
    (usd * 1_000_000.0).round() / 1_000_000.0
}

/// What the next model call of an agent meets.
#[derive(Debug, Clone, PartialEq)]
pub enum Check {
    Ahead,
    /// No more calls for this agent. `first` is set the moment a scheduled run stops, so the stop
    /// is recorded once.
    Stop {
        first: Option<SpendStop>,
    },
    /// Wait for the operator's answer at this stop. `opened` is set for the agent that opened it,
    /// which records it.
    Wait {
        stop: SpendStop,
        opened: bool,
    },
}

/// Looks at the spool before `agent`'s next call, opening a stop on `stops` when one is reached
/// and none is open for it yet. With `can_ask` false it stops instead; every run the registry
/// knows can ask since ADR 0090.
pub fn check(
    spend: &mut RunSpend,
    stops: &mut Vec<SpendStop>,
    agent: &str,
    name: &str,
    can_ask: bool,
    now: &str,
) -> Check {
    if spend.stopped.is_some() {
        return Check::Stop { first: None };
    }
    let mine = spend.agents.get(agent).cloned().unwrap_or_default();
    if mine.stopped {
        return Check::Stop { first: None };
    }
    let reached = match spend.limit_usd {
        Some(limit) if spend.spent_usd >= limit => Some((None, limit, spend.spent_usd)),
        _ => match mine.limit_usd {
            Some(limit) if mine.spent_usd >= limit => {
                Some((Some(agent.to_owned()), limit, mine.spent_usd))
            }
            _ => None,
        },
    };
    let Some((whose, limit, used)) = reached else {
        return Check::Ahead;
    };
    // What the team's runs usually cost goes on the team's stop, not on an agent's own guard.
    let team = whose.is_none();
    let (usual, usual_runs) = if team {
        (spend.usual_usd, spend.usual_runs)
    } else {
        (None, 0)
    };
    let stop = SpendStop {
        id: uuid::Uuid::new_v4().to_string(),
        name: whose.as_ref().map(|_| name.to_owned()),
        agent: whose,
        limit_usd: limit,
        spent_usd: used,
        add_usd: top_up_for(limit, used),
        automatic: team && spend.automatic,
        usual_usd: usual,
        usual_runs,
        since: now.to_owned(),
        expires_at: None,
    };
    if !can_ask {
        spend.stopped = Some(Stopped::NobodyToAsk);
        return Check::Stop { first: Some(stop) };
    }
    if let Some(open) = stops.iter_mut().find(|open| open.agent == stop.agent) {
        // The figure moves while it waits: another agent's call can finish after the stop opened,
        // and the offer follows it so one "Add" still carries on.
        open.spent_usd = used;
        open.add_usd = top_up_for(open.limit_usd, used);
        return Check::Wait {
            stop: open.clone(),
            opened: false,
        };
    }
    stops.push(stop.clone());
    Check::Wait { stop, opened: true }
}

/// Applies the operator's answer to the stop `stop_id`, and takes the stop off `stops`.
///
/// # Errors
///
/// [`AnswerError::NotOpen`] when no such stop is open (already answered, or the run ended), and
/// [`AnswerError::Amount`] when what was to be added is not a sensible sum of money.
pub fn answer(
    spend: &mut RunSpend,
    stops: &mut Vec<SpendStop>,
    stop_id: &str,
    decision: SpendDecision,
    add_usd: Option<f64>,
) -> Result<(SpendStop, SpendAnswer), AnswerError> {
    let index = stops
        .iter()
        .position(|stop| stop.id == stop_id)
        .ok_or(AnswerError::NotOpen)?;
    let stop = stops[index].clone();
    let answer = match decision {
        SpendDecision::Add => {
            let add = cents(add_usd.unwrap_or(stop.add_usd));
            if !add.is_finite() || add <= 0.0 || add > MAX_TOP_UP_USD {
                return Err(AnswerError::Amount);
            }
            let limit = match &stop.agent {
                None => spend.limit_usd.get_or_insert(stop.limit_usd),
                Some(agent) => spend
                    .agents
                    .entry(agent.clone())
                    .or_default()
                    .limit_usd
                    .get_or_insert(stop.limit_usd),
            };
            let at = *limit;
            // Not rounded to cents: a limit below a cent plus what was added is still that sum.
            *limit = micros(at + add);
            let limit_usd = *limit;
            spend.added.push(TopUp {
                agent: stop.agent.clone(),
                at_usd: at,
                add_usd: add,
            });
            SpendAnswer {
                decision,
                add_usd: Some(add),
                limit_usd,
            }
        }
        SpendDecision::Finish => {
            match &stop.agent {
                None => spend.stopped = Some(Stopped::Finished),
                Some(agent) => spend.agents.entry(agent.clone()).or_default().stopped = true,
            }
            SpendAnswer {
                decision,
                add_usd: None,
                limit_usd: stop.limit_usd,
            }
        }
    };
    stops.remove(index);
    Ok((stop, answer))
}

/// What an agent's next model call meets, as the run registry answers it.
#[derive(Debug)]
pub enum Gate {
    Ahead,
    /// No more calls. `first` is the stop a scheduled run just reached, to be recorded once.
    Stop {
        first: Option<SpendStop>,
    },
    /// Wait at `stop` until `answer` holds the operator's answer, or closes because the run ended.
    /// `opened` is set for the agent that opened the stop, which records it and its answer.
    Wait {
        stop: SpendStop,
        opened: bool,
        answer: tokio::sync::watch::Receiver<Option<SpendAnswer>>,
    },
}

/// Why an answer at a stop was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnswerError {
    NotOpen,
    Amount,
}

/// The run stopped at its spool: the operator finished it there, or a scheduled run had nobody to
/// ask. The run's whole task ends with this; the run registry decides what the run became.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SpendStopped {
    pub cause: Stopped,
    pub limit_usd: f64,
}

impl SpendStopped {
    /// The spool a run stopped at, when that is what `error` comes down to.
    #[must_use]
    pub fn of(error: &anyhow::Error) -> Option<Self> {
        error
            .chain()
            .find_map(|cause| cause.downcast_ref::<Self>())
            .copied()
    }
}

impl fmt::Display for SpendStopped {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let limit = usd(self.limit_usd);
        match self.cause {
            Stopped::Finished => write!(
                formatter,
                "The team used its {limit} for this run, and you finished it there."
            ),
            Stopped::NoAnswer => write!(
                formatter,
                "The team used its {limit} for this run. Nobody answered in time, so it finished \
                 there."
            ),
            Stopped::NobodyToAsk => write!(
                formatter,
                "The team used its {limit} for this run. Nobody was there to add more, so it \
                 stopped. Each agent's checkpoint is kept, so you can carry on from where it \
                 stopped."
            ),
        }
    }
}

impl std::error::Error for SpendStopped {}

/// Dollars as the operator reads them: `$1.00`, `$0.12`, and under a dollar to three figures, so
/// `$0.012` and `$0.003` never read as `$0.01` or `$0.00`. The app writes them the same way
/// (`ui/src/lib/runs/spend.ts`, `dollars`).
#[must_use]
pub fn usd(amount: f64) -> String {
    if amount.is_nan() || amount <= 0.0 {
        return "$0.00".to_owned();
    }
    if amount >= 1.0 {
        return format!("${amount:.2}");
    }
    // Under a dollar `log10` is negative, so this is at least 3; it never wraps or loses a sign.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let places = (2 - amount.log10().floor() as i32).clamp(2, 6) as usize;
    let text = format!("{amount:.places$}");
    // Trailing zeros go, down to two places.
    let (whole, fraction) = text.split_once('.').unwrap_or((&text, ""));
    let kept = fraction.trim_end_matches('0');
    format!("${whole}.{kept:0<2}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The team schema states the same ranges and defaults the daemon holds a team file to, so the
    /// editor and the daemon agree on what a valid `spend.web` is.
    #[test]
    fn the_schema_states_the_web_limits_the_daemon_holds() {
        let schema: serde_json::Value =
            serde_yaml::from_str(crate::api::TEAM_SCHEMA).expect("schema");
        let fields = &schema["$defs"]["WebLimits"]["properties"];
        let default = WebLimits::default();
        let defaults = [
            Some(default.page_tokens),
            default.pages,
            default.searches,
            default.steps,
        ];
        for ((field, least, most), default) in WEB_RANGES.into_iter().zip(defaults) {
            let field = &fields[field];
            assert_eq!(field["minimum"], least, "{field}");
            assert_eq!(field["maximum"], most, "{field}");
            // A count with no default is left to OpenRouter, and the schema says no default.
            assert_eq!(
                field.get("default").and_then(serde_json::Value::as_u64),
                default.map(u64::from),
                "{field}"
            );
        }
        assert_eq!(
            schema["$defs"]["Spend"]["properties"]["web"]["$ref"],
            "#/$defs/WebLimits"
        );
    }

    fn spool(limit: f64) -> RunSpend {
        RunSpend {
            limit_usd: Some(limit),
            ..RunSpend::default()
        }
    }

    fn approx(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn a_run_goes_ahead_until_it_has_used_its_spool() {
        let mut spend = spool(0.05);
        let mut stops = Vec::new();
        spend.count("a", 0.03);
        assert_eq!(
            check(&mut spend, &mut stops, "a", "A", true, "now"),
            Check::Ahead
        );
        spend.count("b", 0.025);
        let Check::Wait { stop, opened } = check(&mut spend, &mut stops, "a", "A", true, "now")
        else {
            panic!("the spool is used up");
        };
        assert!(opened);
        assert_eq!(stop.agent, None);
        assert!(approx(stop.spent_usd, 0.055));
        // The half cent past the limit, as a whole cent, then the least offer.
        assert!(approx(stop.add_usd, 0.11));
        // A second agent reaching it waits at the same stop rather than opening another.
        let Check::Wait { stop: same, opened } =
            check(&mut spend, &mut stops, "b", "B", true, "now")
        else {
            panic!("still used up");
        };
        assert!(!opened);
        assert_eq!(same.id, stop.id);
        assert_eq!(stops.len(), 1);
    }

    #[test]
    fn adding_grows_the_spool_for_this_run_and_lets_the_agents_carry_on() {
        let mut spend = spool(1.0);
        let mut stops = Vec::new();
        spend.count("a", 1.03);
        let Check::Wait { stop, .. } = check(&mut spend, &mut stops, "a", "A", true, "now") else {
            panic!("over the spool");
        };
        assert!(approx(stop.add_usd, 0.53), "{stop:?}");
        let (_, answered) =
            answer(&mut spend, &mut stops, &stop.id, SpendDecision::Add, None).expect("open");
        assert!(approx(answered.limit_usd, 1.53));
        assert_eq!(spend.limit_usd, Some(1.53));
        assert!(stops.is_empty());
        assert_eq!(
            spend.added,
            vec![TopUp {
                agent: None,
                at_usd: 1.0,
                add_usd: 0.53
            }]
        );
        assert_eq!(
            check(&mut spend, &mut stops, "a", "A", true, "now"),
            Check::Ahead
        );
        // Answered once: a second answer finds nothing open.
        assert_eq!(
            answer(&mut spend, &mut stops, &stop.id, SpendDecision::Add, None).unwrap_err(),
            AnswerError::NotOpen
        );
    }

    #[test]
    fn finishing_stops_every_agent_of_the_run() {
        let mut spend = spool(0.1);
        let mut stops = Vec::new();
        spend.count("a", 0.2);
        let Check::Wait { stop, .. } = check(&mut spend, &mut stops, "a", "A", true, "now") else {
            panic!("over the spool");
        };
        answer(
            &mut spend,
            &mut stops,
            &stop.id,
            SpendDecision::Finish,
            None,
        )
        .expect("open");
        assert_eq!(spend.stopped, Some(Stopped::Finished));
        for agent in ["a", "b"] {
            assert_eq!(
                check(&mut spend, &mut stops, agent, agent, true, "now"),
                Check::Stop { first: None }
            );
        }
    }

    #[test]
    fn a_scheduled_run_stops_at_its_spool_and_says_so_once() {
        let mut spend = spool(0.1);
        let mut stops = Vec::new();
        spend.count("a", 0.1);
        let Check::Stop { first: Some(stop) } =
            check(&mut spend, &mut stops, "a", "A", false, "now")
        else {
            panic!("a routine stops");
        };
        assert!(approx(stop.limit_usd, 0.1));
        assert_eq!(spend.stopped, Some(Stopped::NobodyToAsk));
        assert!(stops.is_empty(), "nobody is asked");
        assert_eq!(
            check(&mut spend, &mut stops, "b", "B", false, "now"),
            Check::Stop { first: None }
        );
    }

    #[test]
    fn an_agents_guard_stops_only_that_agent() {
        let mut spend = spool(1.0);
        spend.agents.insert(
            "r".into(),
            AgentSpend {
                limit_usd: Some(0.3),
                ..AgentSpend::default()
            },
        );
        let mut stops = Vec::new();
        spend.count("r", 0.31);
        let Check::Wait { stop, .. } = check(&mut spend, &mut stops, "r", "Researcher", true, "n")
        else {
            panic!("over its guard");
        };
        assert_eq!(stop.agent.as_deref(), Some("r"));
        assert_eq!(stop.name.as_deref(), Some("Researcher"));
        assert!(approx(stop.add_usd, 0.16));
        assert_eq!(
            check(&mut spend, &mut stops, "w", "Writer", true, "n"),
            Check::Ahead,
            "the rest of the team carries on"
        );
        let (_, answered) = answer(
            &mut spend,
            &mut stops,
            &stop.id,
            SpendDecision::Add,
            Some(0.2),
        )
        .expect("open");
        assert!(approx(answered.limit_usd, 0.5));
        assert_eq!(spend.limit_usd, Some(1.0), "the team's spool is unchanged");
        spend.count("r", 0.2);
        let Check::Wait { stop, .. } = check(&mut spend, &mut stops, "r", "Researcher", true, "n")
        else {
            panic!("over its guard again");
        };
        answer(
            &mut spend,
            &mut stops,
            &stop.id,
            SpendDecision::Finish,
            None,
        )
        .expect("open");
        assert_eq!(
            check(&mut spend, &mut stops, "r", "Researcher", true, "n"),
            Check::Stop { first: None }
        );
        assert_eq!(
            check(&mut spend, &mut stops, "w", "Writer", true, "n"),
            Check::Ahead
        );
        assert_eq!(spend.stopped, None);
    }

    #[test]
    fn a_limit_below_a_cent_grows_by_exactly_what_was_added() {
        let mut spend = spool(0.003);
        let mut stops = Vec::new();
        spend.count("a", 0.00316);
        let Check::Wait { stop, .. } = check(&mut spend, &mut stops, "a", "A", true, "now") else {
            panic!("over the spool");
        };
        let (_, answered) =
            answer(&mut spend, &mut stops, &stop.id, SpendDecision::Add, None).expect("open");
        assert!(approx(answered.limit_usd, 0.113), "{answered:?}");
    }

    #[test]
    fn an_answer_adds_a_sensible_sum_or_nothing() {
        let mut spend = spool(1.0);
        let mut stops = Vec::new();
        spend.count("a", 1.0);
        let Check::Wait { stop, .. } = check(&mut spend, &mut stops, "a", "A", true, "now") else {
            panic!("over the spool");
        };
        for bad in [0.0, -1.0, f64::NAN, MAX_TOP_UP_USD + 1.0] {
            assert_eq!(
                answer(
                    &mut spend,
                    &mut stops,
                    &stop.id,
                    SpendDecision::Add,
                    Some(bad)
                )
                .unwrap_err(),
                AnswerError::Amount
            );
        }
        assert_eq!(stops.len(), 1, "a refused answer leaves the stop open");
    }

    #[test]
    fn the_offer_is_half_the_limit_in_whole_cents_and_at_least_ten() {
        assert!(approx(top_up_for(1.0, 1.0), 0.5));
        assert!(approx(top_up_for(0.3, 0.3), 0.15));
        assert!(approx(top_up_for(0.05, 0.05), 0.10));
        assert!(approx(top_up_for(0.333, 0.333), 0.17));
    }

    #[test]
    fn the_offer_covers_what_one_call_spent_past_the_limit() {
        // The news brief of 2026-11-04: $1.85 spent of $1.00.
        assert!(approx(top_up_for(1.0, 1.852_507_6), 1.36));
        // A thousandth of a cent over still adds a whole cent.
        assert!(approx(top_up_for(1.0, 1.000_01), 0.51));
    }

    /// ADR 0115: a run one call took far past its limit carries on after one "Add", where the old
    /// offer of half the limit opened a second stop at once.
    #[test]
    fn one_add_carries_on_a_run_that_went_far_past_its_limit() {
        let mut spend = spool(1.0);
        let mut stops = Vec::new();
        spend.count("researcher", 2.570_472_2);
        let Check::Wait { stop, .. } = check(
            &mut spend,
            &mut stops,
            "researcher",
            "Researcher",
            true,
            "now",
        ) else {
            panic!("over the spool");
        };
        answer(&mut spend, &mut stops, &stop.id, SpendDecision::Add, None).expect("open");
        assert_eq!(
            check(
                &mut spend,
                &mut stops,
                "researcher",
                "Researcher",
                true,
                "now"
            ),
            Check::Ahead,
            "{spend:?}"
        );
    }

    #[test]
    fn the_offer_at_an_open_stop_follows_what_is_spent_while_it_waits() {
        let mut spend = spool(1.0);
        let mut stops = Vec::new();
        spend.count("a", 1.1);
        let Check::Wait { stop, .. } = check(&mut spend, &mut stops, "a", "A", true, "now") else {
            panic!("over the spool");
        };
        assert!(approx(stop.add_usd, 0.6));
        // Another agent's call lands after the stop opened.
        spend.count("b", 0.4);
        let Check::Wait { stop, .. } = check(&mut spend, &mut stops, "b", "B", true, "now") else {
            panic!("still over");
        };
        assert!(approx(stop.add_usd, 1.0), "{stop:?}");
        answer(&mut spend, &mut stops, &stop.id, SpendDecision::Add, None).expect("open");
        assert_eq!(
            check(&mut spend, &mut stops, "a", "A", true, "now"),
            Check::Ahead
        );
    }

    #[test]
    fn dollars_read_as_written_cents_from_a_dollar_three_figures_below() {
        assert_eq!(usd(1.0), "$1.00");
        assert_eq!(usd(12.345), "$12.35");
        assert_eq!(usd(0.5), "$0.50");
        assert_eq!(usd(0.12), "$0.12");
        assert_eq!(usd(0.012), "$0.012");
        assert_eq!(usd(0.123_456), "$0.123");
        assert_eq!(usd(0.003), "$0.003");
        assert_eq!(usd(0.000_479), "$0.000479");
        assert_eq!(usd(0.0), "$0.00");
    }

    #[test]
    fn what_is_left_is_the_least_of_the_run_and_the_agents_guard() {
        assert_eq!(
            RunSpend::default().left("a"),
            None,
            "no limit, nothing to say"
        );
        let mut spend = spool(1.0);
        spend.count("a", 0.25);
        assert!(approx(spend.left("a").unwrap(), 0.75));
        spend.agents.get_mut("a").unwrap().limit_usd = Some(0.3);
        assert!(
            approx(spend.left("a").unwrap(), 0.05),
            "its own guard is nearer"
        );
        assert!(
            approx(spend.left("b").unwrap(), 0.75),
            "another agent has the run's"
        );
        spend.count("a", 0.1);
        assert!(approx(spend.left("a").unwrap(), 0.0), "never below nothing");
        let mut finished = spool(1.0);
        finished.stopped = Some(Stopped::Finished);
        assert_eq!(finished.left("a"), Some(0.0));
    }

    #[test]
    fn what_runs_usually_cost_is_the_middle_of_what_they_spent() {
        assert_eq!(usual_cost(&[]), None);
        assert_eq!(
            usual_cost(&[0.0, f64::NAN]),
            None,
            "runs that spent nothing say nothing"
        );
        assert!(approx(usual_cost(&[2.27, 2.26, 2.26]).unwrap(), 2.26));
        assert!(approx(usual_cost(&[1.0, 3.0]).unwrap(), 2.0));
        // One run that went wrong doesn't move it.
        assert!(approx(usual_cost(&[2.2, 2.3, 40.0]).unwrap(), 2.3));
    }

    #[test]
    fn the_automatic_limit_is_twice_the_usual_and_never_below_the_least() {
        assert!(approx(automatic_limit(None), AUTOMATIC_LEAST_USD));
        assert!(approx(automatic_limit(Some(0.12)), AUTOMATIC_LEAST_USD));
        // The news brief: about $2.27 a run.
        assert!(approx(automatic_limit(Some(2.27)), 5.0));
        assert!(
            approx(automatic_limit(Some(4.001)), 8.01),
            "up to a whole cent"
        );
    }

    /// ADR 0115: a team whose file names no figure gets `LoomWatch`'s limit, worked out from its
    /// runs; one whose file sets a figure keeps it.
    #[test]
    fn a_team_that_names_no_figure_gets_the_automatic_limit() {
        let silent = TeamConfig::parse(
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    model: m\n",
        )
        .unwrap();
        let mut spool = RunSpend::for_team(&silent);
        assert!(spool.automatic);
        assert_eq!(spool.limit_usd, Some(AUTOMATIC_LEAST_USD));
        spool.go_by(&[3.1, 2.9, 3.0]);
        assert_eq!(spool.usual_usd, Some(3.0));
        assert_eq!(spool.limit_usd, Some(6.0));

        let set = TeamConfig::parse(
            "schemaVersion: 1\nentrypoint: a\nspend:\n  perRun: 1\nagents:\n  - id: a\n    model: m\n",
        )
        .unwrap();
        let mut spool = RunSpend::for_team(&set);
        spool.go_by(&[3.1, 2.9, 3.0]);
        assert!(!spool.automatic);
        assert_eq!(spool.limit_usd, Some(1.0), "the team's own figure stays");
        assert_eq!(
            spool.usual_usd,
            Some(3.0),
            "what its runs usually cost is known beside it"
        );
    }

    /// ADR 0115: the team's stop says whether its limit is automatic and what its runs usually
    /// cost, from how many runs, so a run that went wrong can be told from a figure set below the
    /// usual. An agent's own guard says neither.
    #[test]
    fn a_teams_stop_says_what_its_runs_usually_cost() {
        let mut spend = RunSpend {
            automatic: true,
            ..spool(5.0)
        };
        spend.go_by(&[2.26, 2.27, 2.26]);
        spend.count("researcher", 5.2);
        let mut stops = Vec::new();
        let Check::Wait { stop, .. } = check(&mut spend, &mut stops, "researcher", "R", true, "n")
        else {
            panic!("over the automatic limit");
        };
        assert!(stop.automatic);
        assert_eq!(stop.usual_usd, Some(2.26));
        assert_eq!(stop.usual_runs, 3);

        // The news brief's $1.00, written before ADR 0115, below what its runs cost.
        let mut set = spool(1.0);
        set.go_by(&[2.26, 2.27]);
        set.count("researcher", 1.2);
        let mut stops = Vec::new();
        let Check::Wait { stop, .. } = check(&mut set, &mut stops, "researcher", "R", true, "n")
        else {
            panic!("over the team's own figure");
        };
        assert!(!stop.automatic);
        assert_eq!(set.limit_usd, Some(1.0), "the team's figure stays");
        assert_eq!(stop.usual_usd, Some(2.265));
        assert_eq!(stop.usual_runs, 2);

        // An agent's own guard, reached before the run's limit.
        let mut guarded = RunSpend {
            automatic: true,
            ..spool(5.0)
        };
        guarded.go_by(&[2.26]);
        guarded.agents.insert(
            "researcher".into(),
            AgentSpend {
                limit_usd: Some(0.3),
                ..AgentSpend::default()
            },
        );
        guarded.count("researcher", 0.31);
        let mut stops = Vec::new();
        let Check::Wait { stop, .. } =
            check(&mut guarded, &mut stops, "researcher", "R", true, "n")
        else {
            panic!("over its own guard");
        };
        assert_eq!(stop.agent.as_deref(), Some("researcher"));
        assert!(!stop.automatic);
        assert_eq!(stop.usual_usd, None);
        assert_eq!(stop.usual_runs, 0);
    }

    #[test]
    fn nothing_is_counted_for_a_call_that_cost_nothing() {
        let mut spend = spool(1.0);
        spend.count("a", 0.0);
        spend.count("a", f64::NAN);
        assert!(spend.agents.is_empty());
        assert!(approx(spend.spent_usd, 0.0));
    }
}
