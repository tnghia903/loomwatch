//! What a session may spend.
//!
//! Every model call costs money, and its exact cost is only known once it has been made. So a
//! session asks [`Spend`] before each call whether it may make one, and tells it afterwards what
//! the call cost. The daemon's implementation is the run's spool (ADR 0068): it adds up what every
//! agent of the run spent, and once the run has used its spool it keeps the agent waiting until the
//! operator adds more or tells the team to finish.

use super::BoxFuture;
use super::provider::Usage;

/// Whether the next model call may go ahead.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Go {
    Ahead,
    /// No more calls: the turn ends with what the agent has written so far.
    Stop,
}

/// Who decides what a session may spend.
pub trait Spend: Send + Sync {
    /// Asked before every model call. It may wait, for as long as the operator takes to answer: no
    /// call is in flight while it does, so nothing is spent.
    fn before_call(&self) -> BoxFuture<'_, Go>;

    /// Told after every model call what it cost.
    fn spent(&self, usage: &Usage);
}

/// No limit: Ask, one-turn helpers, the tests.
#[derive(Debug, Clone, Copy, Default)]
pub struct Unmetered;

impl Spend for Unmetered {
    fn before_call(&self) -> BoxFuture<'_, Go> {
        Box::pin(async { Go::Ahead })
    }

    fn spent(&self, _usage: &Usage) {}
}
