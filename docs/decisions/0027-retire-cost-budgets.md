# 0027 — Retire dollar budgets

- **Date:** 2026-10-01
- **Status:** Accepted — daemon `crates/loomwatch-backend/src/{config,team_bus}.rs`, schema
  `schemas/team.schema.yaml` (`$defs/RetiredBudget`), UI `ui/src/**`
- **Reverses:** the budget-admission half of [ADR 0002](0002-team-bus-mcp-delegation-and-execution-modes.md)
  (TEAM_CONFIG `budget.limitUsd` / `warnAtPercent`, the "budget exhausted" Team Bus refusals and
  the `budget_warning` usage event)

## Context

Every harness agent had to declare `budget.limitUsd`. The Team Bus summed `costUsd` from `usage`
and `turn_end` events and refused a delegation once an agent or the team passed its limit. The
canvas showed each agent's spend against its limit, and the run strip showed total spend.

The operator runs teams on Claude and Codex **subscriptions**, where a dollar figure measures
nothing they pay. The local archive (2026-10-01, 15 runs) showed it was not working either:

- `claude-agent-acp` reports cost as `usage_update.cost: {amount, currency}`, and the amount is a
  running total for the session. LoomWatch read `costUsd`, which only the offline test harness
  emits, so none of Claude's 54 nonzero cost reports was ever counted. The spend chip, the budget
  meters, the warnings and the refusals never fired on a real run.
- `codex-acp` and Hermes report no cost at all, only tokens and context fill.
- Even Claude's figure is the API-equivalent price, not money a subscriber is charged.

## Decision

Remove the feature end to end instead of repairing it:

- The daemon no longer parses, tracks or enforces budgets. `guard_delegation` checks only depth,
  cycles and the target's existence. The fan-out cap is separate and unchanged. The bus writes no
  `budget_warning` events.
- The UI drops the budget field, spend meters, the spend chip, the receipt's budget check, the
  team budget control and the default `$5` on new agents.
- `budget` stays **accepted and ignored** at team and agent level, including on an operator node,
  where the loader used to refuse it. The schema keeps it as `$defs/RetiredBudget`
  (`deprecated: true`, any shape), so existing team files load, validate and run unchanged.
  Writers must not add it.
- Harness `usage` and `turn_end` payloads are still archived verbatim as evidence. The schema keeps
  the retired `budget_warning` shape valid, so runs archived before this change still replay.

## Consequences

- Nothing in LoomWatch limits what a delegation loop spends now. Depth, cycle and fan-out guards
  still bound runaway delegation, but the only spend ceilings left are the provider's own.
- If spend control returns, it should measure what subscribers actually run out of:
  `claude-agent-acp` reports 5-hour and 7-day window use in `usage_update._meta._claude/rateLimit`,
  and Codex writes its weekly `rate_limits` to `~/.codex/sessions/**/rollout-*.jsonl`. A
  pay-per-use dollar meter would need `cost.amount` read as a running total, not summed.
