-- The widgets under a run's answer (ADR 0114): choices, a checklist, a calculator or steps the
-- agent showed with the Team Bus's `show_widget`, worked out from the run's archive once it
-- succeeds, numbered from 1 in the order shown. `spec` is the widget as LoomWatch checked it
-- (JSON). `state` is what the person last made of it (a checklist's ticks, a calculator's values;
-- JSON), changed in place, and `changed_at` when; both NULL until they change something. The next
-- run's conversation says what changed (crates/loomwatch-backend/src/widgets/mod.rs).
CREATE TABLE widgets (
    run_id     TEXT NOT NULL,
    n          INTEGER NOT NULL,
    kind       TEXT NOT NULL,
    title      TEXT NOT NULL,
    spec       TEXT NOT NULL,
    state      TEXT,
    changed_at TEXT,
    PRIMARY KEY (run_id, n)
);
