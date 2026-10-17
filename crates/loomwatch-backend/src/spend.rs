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

use crate::config::{AgentConfig, TeamConfig};

/// What a new team, and every starter team, is written with: one run may spend $1.00. A team file
/// that says nothing has no limit (the owner's ruling on ADR 0068), so a team made before spend
/// limits runs as it did.
pub const DEFAULT_PER_RUN_USD: f64 = 1.0;
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
}

impl SpendConfig {
    /// The figure, when it is one a run can be held to.
    fn limit(self) -> Option<f64> {
        self.per_run.filter(|usd| usd.is_finite() && *usd > 0.0)
    }
}

/// What a run has spent and may spend. On the run record, and stored with it, so a finished run
/// still shows its spool.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSpend {
    /// The team's spool for this run, with whatever the operator added. `None`: no limit.
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
    /// A scheduled run used its spool, with nobody there to add more.
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
    pub since: String,
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
    /// A new run's spool, from its team file: the team's `spend.perRun` (no limit when it says
    /// nothing), and each agent's own guard. Spend is counted either way.
    #[must_use]
    pub fn for_team(team: &TeamConfig) -> Self {
        Self {
            limit_usd: team.spend.limit(),
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

/// What "Add and carry on" offers at a limit: half of it, at least ten cents, in whole cents.
#[must_use]
pub fn top_up_for(limit: f64) -> f64 {
    cents((limit / 2.0).max(MIN_TOP_UP_USD))
}

fn cents(usd: f64) -> f64 {
    (usd * 100.0).round() / 100.0
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
/// and none is open for it yet. `can_ask` is false for a scheduled run: it stops instead.
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
    let stop = SpendStop {
        id: uuid::Uuid::new_v4().to_string(),
        name: whose.as_ref().map(|_| name.to_owned()),
        agent: whose,
        limit_usd: limit,
        spent_usd: used,
        add_usd: top_up_for(limit),
        since: now.to_owned(),
    };
    if !can_ask {
        spend.stopped = Some(Stopped::NobodyToAsk);
        return Check::Stop { first: Some(stop) };
    }
    if let Some(open) = stops.iter_mut().find(|open| open.agent == stop.agent) {
        // The figure moves while it waits: another agent's call can finish after the stop opened.
        open.spent_usd = used;
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
        assert!(approx(stop.add_usd, 0.10));
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
        assert!(approx(stop.add_usd, 0.5));
        let (_, answered) =
            answer(&mut spend, &mut stops, &stop.id, SpendDecision::Add, None).expect("open");
        assert!(approx(answered.limit_usd, 1.5));
        assert_eq!(spend.limit_usd, Some(1.5));
        assert!(stops.is_empty());
        assert_eq!(
            spend.added,
            vec![TopUp {
                agent: None,
                at_usd: 1.0,
                add_usd: 0.5
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
        assert!(approx(stop.add_usd, 0.15));
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
        assert!(approx(answered.limit_usd, 0.103), "{answered:?}");
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
        assert!(approx(top_up_for(1.0), 0.5));
        assert!(approx(top_up_for(0.3), 0.15));
        assert!(approx(top_up_for(0.05), 0.10));
        assert!(approx(top_up_for(0.333), 0.17));
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
    fn nothing_is_counted_for_a_call_that_cost_nothing() {
        let mut spend = spool(1.0);
        spend.count("a", 0.0);
        spend.count("a", f64::NAN);
        assert!(spend.agents.is_empty());
        assert!(approx(spend.spent_usd, 0.0));
    }
}
