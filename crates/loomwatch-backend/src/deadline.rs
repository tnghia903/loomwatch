//! Deadlines by the wall clock, for waits that may outlast a computer's sleep.
//!
//! A tokio timer counts the time the process runs, and on a Mac that stops while the computer
//! sleeps: a wait of twelve hours that started before a night's sleep would still have most of
//! them to go in the morning. A scheduled run that asks the person something waits by the wall
//! clock instead, checking it at least every half minute, so a deadline that passed during sleep
//! is met within one check of waking.

use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};

/// How often a wait looks at the wall clock while its deadline is further away than this.
const CHECK_EVERY: Duration = Duration::from_secs(30);

/// Resolves once the wall clock reaches `deadline`; at once when it already has.
pub(crate) async fn passed(deadline: DateTime<Utc>) {
    loop {
        let Ok(left) = (deadline - Utc::now()).to_std() else {
            return;
        };
        if left.is_zero() {
            return;
        }
        tokio::time::sleep(left.min(CHECK_EVERY)).await;
    }
}

/// [`passed`] for a wait that may have no deadline at all, which then never resolves: a run
/// someone started waits at a spend stop as long as it takes.
pub(crate) async fn passed_if_any(deadline: Option<DateTime<Utc>>) {
    match deadline {
        Some(deadline) => passed(deadline).await,
        None => std::future::pending().await,
    }
}

/// `at` as the run record writes its times: RFC 3339 to the millisecond, in UTC.
#[must_use]
pub(crate) fn stamp(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// A time the run record wrote, read back. `None` for anything that isn't one.
#[must_use]
pub(crate) fn parse(stamped: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(stamped)
        .ok()
        .map(|at| at.with_timezone(&Utc))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_deadline_already_gone_by_resolves_at_once() {
        tokio::time::timeout(
            Duration::from_secs(1),
            passed(Utc::now() - chrono::Duration::hours(3)),
        )
        .await
        .expect("a deadline in the past is already met");
    }

    #[tokio::test]
    async fn a_near_deadline_resolves_once_the_clock_reaches_it() {
        let deadline = Utc::now() + chrono::Duration::milliseconds(120);
        tokio::time::timeout(Duration::from_secs(5), passed(deadline))
            .await
            .expect("met within a few seconds");
        assert!(Utc::now() >= deadline, "not before the deadline");
    }

    #[test]
    fn a_stamped_time_reads_back_as_itself() {
        let at = parse("2026-10-24T08:00:00.250Z").expect("a run record time");
        assert_eq!(stamp(at), "2026-10-24T08:00:00.250Z");
        assert_eq!(parse("tomorrow"), None);
    }
}
