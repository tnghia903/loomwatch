# 0001 — Postgres event archive; Dockerized dev toolchain

- **Date:** 2026-09-06
- **Status:** Accepted
- **Decided by:** Operator — explicit decision, not agent-initiated (recorded in TNG-31)
- **Reverses:** ARCHITECTURE.md §2 "Event archive — SQLite (WAL)" (rev 0.2)

## Context

ARCHITECTURE.md §2 specified SQLite (WAL) as the event archive; TNG-25/26/28 built and
hardened that archive around the frozen `RunEvent` contract. On 2026-09-06 the operator
decided to change the storage engine underneath that contract and to stop requiring a
host-installed Rust toolchain.

## Decision

1. **Postgres is the production event archive, replacing SQLite (WAL).** The frozen
   `RunEvent` schema carries over unchanged — same `kind` enum, same `payload`/`raw`
   JSON columns, same `UNIQUE(session_id, seq)` ordering guarantee. §7 freezes the
   event schema, not the engine under it: this is a storage-backend swap, not a schema
   change.
2. **Docker Compose provides the Rust dev toolchain and Postgres — nothing else.**
   `docker compose run --rm dev cargo …` replaces installing rustup on the host as the
   supported development workflow. `loomwatchd` still runs natively as a local process
   at use-time; the backend itself is not containerized.

## Consequences

- Prior SQLite work is not wasted: the `RunEvent` schema and archive contract hardened
  in TNG-25/26/28 carry over unchanged.
- Storage moves to versioned migrations, replacing the inline `CREATE TABLE` in
  `archive.rs`; archive tests run against real Postgres instead of in-memory SQLite.
- README's "Local-first" claim carries a caveat: everything still runs on the user's
  machine, but a running Postgres instance (`docker compose up postgres`) is required.
- ARCHITECTURE.md §2, README.md, and docs/TEAM_CONFIG.md are updated under TNG-31 to
  describe Postgres rather than SQLite.
- Implementation vehicle chosen by the Rust Systems Engineer in TNG-31: `sqlx`
  (postgres + tokio runtime, with `migrate` for the versioned migrations) — the natural
  fit given the crate already depends on tokio.
