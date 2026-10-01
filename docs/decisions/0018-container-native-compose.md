# 0018 — Container-native Compose runtime

Date: 2026-09-13

## Decision

The default Compose stack runs PostgreSQL and the complete `loomwatchd` application, including its
embedded web UI. The host publishes both ports on loopback only. `loomwatchd` runs as a non-root
user with a read-only root filesystem and explicit mounts for teams, workspaces, capability imports,
and harness state.

Harness discovery describes the available execution backends. A container scans its own `PATH` for
Linux harnesses and, when the authenticated native companion is reachable, merges the companion's
host inventory. A host entry is persisted as `loomwatchd harness-client`, whose stdio is carried to
the selected host ACP adapter. It never reports a mounted macOS or Windows executable as runnable.
Provider authentication stays with the environment that launches that harness.

Capability discovery may use `LOOMWATCH_CAPABILITY_HOME`, independently of the harness process's
`HOME`. Compose points it at a read-only import with the conventional harness directory layout.
This lets an operator expose selected skills and plugin metadata without mounting their complete
home directory or credentials. Wired skill definitions are copied into the managed team workspace
as before.

Teams and their Brief files remain files under the writable teams mount. Context packets, Notebook
entries, checkpoints, run records, and evidence remain in PostgreSQL. Repositories used by agents
must be mounted below `/workspaces`, and team configuration must name container-visible paths.

## Listener trust

Inside a container the daemon must bind `0.0.0.0`, although Compose publishes it as
`127.0.0.1:<port>`. `--allow-container-listener` is the explicit assertion that an outer runtime
enforces that loopback boundary. Without the flag, an archive-backed non-loopback listener remains
refused. The Compose file owns the matching loopback-only port publication and Host allowlist.

## Native companion boundary

The host runner requires a token of at least 16 characters on every connection. A client selects a
harness id from LoomWatch's fixed catalog, never an arbitrary command. The server resolves the
adapter again from its own `PATH`, and it accepts working directories only through explicit
container-to-host root mappings. It does not expose general shell execution, the Docker socket, or
the host home directory.

## Rejected alternatives

- Mounting the host's complete home directory: exposes unrelated credentials and still cannot make
  host-native binaries executable in a Linux container.
- Mounting the Docker socket: gives the application host-equivalent control and is unnecessary.
- Treating a visible host executable as directly available: produces teams that pass discovery and
  fail only after a paid run begins. The native companion is an execution transport, not a mount.

## Consequences

The offline Python harness runs in the base image. Real provider harnesses may be installed and
authenticated in the container runtime or supplied by the separately started native companion.
Compose remains usable without the companion and reports its connection failure rather than
claiming that host harnesses are absent.
