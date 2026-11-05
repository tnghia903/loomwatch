//! Whether an agent sees its run's money (ADR 0115).
//!
//! Every agent of a run draws on one spool ([`crate::spend`]). Without this, an agent doesn't know
//! the spool is there: it works as it would with no limit and is stopped when the money is used,
//! often after the work and before the answer. Research on agents that search found that more
//! budget alone doesn't help unless the agent can see it, and that an agent shown what is left
//! after each step spends it better (the "Budget Tracker", arXiv 2511.17006). So with the switch
//! on, an agent of a metered run is told, once in its prompt, that the run has a limit and how to
//! plan for it, and after the task and each step's results, in one bracketed line, what is left.
//!
//! The switch is [`DEFAULT`], off until the quality bench shows the agents' answers are no worse
//! with it at a generous limit (the owner's rule: no cut that could lower quality before the bench
//! shows it doesn't). `LOOMWATCH_SPEND_AWARE=on` turns it on for a daemon, for the bench.

use std::sync::OnceLock;

use crate::agent::Room;
use crate::prompt_blocks::Block;
use crate::spend::usd;

/// Whether agents see their run's money unless the setting says otherwise. One line to change
/// once the bench has spoken.
pub const DEFAULT: bool = false;
/// The environment setting that overrides [`DEFAULT`]: `on` or `off`.
pub const SETTING: &str = "LOOMWATCH_SPEND_AWARE";

/// `## Money for this run`.
pub const HEADING: &str = "## Money for this run";

/// How an agent plans for the run's money: fixed words, so they stay in the cached prompt.
pub(crate) const SECTION: Block = Block::new(
    "spend.section",
    "Every agent in this run draws on the same money, and the run has a limit. A line in [brackets] \
     after the task and after each step's results says how much is left. Plan the work to fit it: \
     with plenty left, work as you normally would and give your best answer; when little is left, \
     finish with what you have rather than start something new. If agents work after you in this \
     run, leave them enough for their part.",
);
/// What is left, after the task and each step's results.
pub(crate) const LINE: Block =
    Block::new("spend.line", "Money for this run: {left} left of {limit}.");
/// What is left, when the agent's own limit in the run is nearer than the run's.
pub(crate) const LINE_OWN: Block = Block::new(
    "spend.line_own",
    "Your own limit in this run: {left} left of {limit}.",
);
/// What the step before cost, so the agent can tell how many more fit.
pub(crate) const LINE_STEP: Block = Block::new("spend.line_step", "Your last step cost {step}.");
/// Said once what is left is at most [`LOW_SHARE`] of the limit.
pub(crate) const LINE_LOW: Block = Block::new(
    "spend.line_low",
    "Little is left: finish with what you have.",
);

/// The share of the limit at or under which the line says little is left.
pub const LOW_SHARE: f64 = 0.2;

/// Whether agents of a metered run see its money: [`SETTING`], else [`DEFAULT`].
#[must_use]
pub fn on() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    #[cfg(test)]
    if let Some(on) = SCOPED.with(std::cell::Cell::get) {
        return on;
    }
    *ON.get_or_init(
        || match std::env::var(SETTING).ok().as_deref().map(str::trim) {
            Some("on") => true,
            Some("off") => false,
            _ => DEFAULT,
        },
    )
}

/// The line after the task (no step yet) and after each step's results: what is left of the
/// limit, what the last step cost, and when little is left, that it is time to finish.
#[must_use]
pub fn line(room: Room, last_step: Option<f64>) -> String {
    let Room { left, limit, own } = room;
    let left = left.max(0.0);
    let figures = [("left", usd(left)), ("limit", usd(limit))];
    let figures: Vec<(&str, &str)> = figures
        .iter()
        .map(|(name, value)| (*name, value.as_str()))
        .collect();
    let mut words = vec![if own { LINE_OWN } else { LINE }.fill(&figures)];
    if let Some(step) = last_step.filter(|step| step.is_finite() && *step > 0.0) {
        words.push(LINE_STEP.fill(&[("step", &usd(step))]));
    }
    if left <= limit * LOW_SHARE {
        words.push(LINE_LOW.text().to_owned());
    }
    format!("[{}]", words.join(" "))
}

#[cfg(test)]
thread_local! {
    static SCOPED: std::cell::Cell<Option<bool>> = const { std::cell::Cell::new(None) };
}

/// Holds the switch at a value for this test's thread until dropped.
#[cfg(test)]
pub(crate) struct Scoped(Option<bool>);

#[cfg(test)]
pub(crate) fn scoped(on: bool) -> Scoped {
    Scoped(SCOPED.with(|cell| cell.replace(Some(on))))
}

#[cfg(test)]
impl Drop for Scoped {
    fn drop(&mut self) {
        SCOPED.with(|cell| cell.set(self.0));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_line_says_what_is_left_what_the_step_cost_and_when_to_finish() {
        assert_eq!(
            line(
                Room {
                    left: 5.0,
                    limit: 5.0,
                    own: false
                },
                None
            ),
            "[Money for this run: $5.00 left of $5.00.]"
        );
        assert_eq!(
            line(
                Room {
                    left: 3.12,
                    limit: 5.0,
                    own: false
                },
                Some(0.09)
            ),
            "[Money for this run: $3.12 left of $5.00. Your last step cost $0.09.]"
        );
        assert_eq!(
            line(
                Room {
                    left: 0.62,
                    limit: 5.0,
                    own: false
                },
                Some(0.4)
            ),
            "[Money for this run: $0.62 left of $5.00. Your last step cost $0.40. Little is left: \
             finish with what you have.]"
        );
        assert_eq!(
            line(
                Room {
                    left: -0.3,
                    limit: 1.0,
                    own: false
                },
                Some(0.0)
            ),
            "[Money for this run: $0.00 left of $1.00. Little is left: finish with what you have.]",
            "never below nothing, and a step that cost nothing isn't named"
        );
        assert_eq!(
            line(
                Room {
                    left: 0.2,
                    limit: 0.3,
                    own: true
                },
                None
            ),
            "[Your own limit in this run: $0.20 left of $0.30.]",
            "an agent's own limit isn't the run's money"
        );
    }
}
