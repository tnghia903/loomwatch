# LoomWatch

A local-first canvas for composing and watching multi-vendor autonomous agent teams.

You drag agents onto a canvas from a panel of whatever harnesses are installed on your
machine, wire them up (or don't), give the team a goal, and watch the work happen as a
live graph — nodes are agents, edges are the delegations between them.

`loomwatchd` runs your teams as local child processes and archives every event to
Postgres. Phase 04 shipped the canvas as a web UI the daemon serves — open it
in a browser (or install it as a PWA). No Electron, no native app to build; the daemon
is a single static Rust binary. The UI is designed to be eye-catching and minimal — the
canvas is the product, the chrome gets out of the way.

## The problem it solves

Once you hand a team of agents the wheel and walk away, there is no good way to see what
they actually did. Existing platforms surface coarse summaries — an activity feed of
"comment added", "issue updated" — which tells you nothing about the order of execution or
what any agent actually said. LoomWatch records the full trace and renders it as structure
you can scrub through.

## Core design decisions

- **Vendor-neutral.** Every agent is a local child process speaking
  [ACP](https://agentclientprotocol.com) over stdio. Claude, Codex, Gemini each have a
  first-party adapter; `opencode acp` reaches everything else (DeepSeek, Kimi, GLM, Qwen…).
  No vendor SDK appears anywhere in the system.
- **We never touch API keys.** Each harness owns its own credentials through its own auth.
- **Delegation is a protocol, not prose.** Agents delegate by calling structured tools on a
  Team Bus MCP server hosted by the backend, which is what makes the observed graph a
  byproduct of execution rather than a parse of transcripts.
- **Two execution modes.** Draw edges between agents and that subgraph runs as a
  deterministic pipeline DAG. Leave them unconnected and the entrypoint agent decides at
  runtime whether it needs a team at all, then self-organizes.
- **Config is version-controlled YAML.** The canvas is a visual editor over files on disk,
  not an opaque store.
- **Local-first.** Agent execution and data stay on the user's machine and require no
  public endpoint. The UI is a web page `loomwatchd` serves — reachable from any device
  that can reach the daemon (LAN, Tailscale, an SSH tunnel). LoomWatch does require a
  running local Postgres service; Docker Compose provisions it for development.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full specification.

## Stack

| Layer | Technology |
|---|---|
| Agents | Local processes speaking ACP over stdio |
| Backend | Rust `loomwatchd` — ACP client, process supervisor, Team Bus MCP server, Postgres, WebSocket, UI host |
| Client | React + Vite + React Flow web UI, served by `loomwatchd`, PWA-installable |
| Team config | Version-controlled YAML |

## Status

Phase 04 (Canvas) shipped 2026-09-07. `loomwatchd serve` hosts the single-page web UI,
including the agent Library panel (TNG-54), the node/edge canvas (TNG-55), the inspector
and YAML round-trip (TNG-53), and the daemon's config API (TNG-52). See
[docs/CANVAS_SPEC.md](docs/CANVAS_SPEC.md) for the full interaction and visual
specification.

Phase 03 Team Bus + execution modes (shipped prior). The backend hosts an authenticated
Team Bus MCP server (`roster`/`dispatch`/`ask`/`handoff`/`report`/`escalate`), enforces
the delegation guards — depth, fan-out, cycles, budget admission — server-side, and runs
edge-drawn teams as deterministic pipeline DAGs (dataflow following the drawn edges)
or edge-free teams as self-organizing. Every event, delegations included, archives
through the frozen `RunEvent` contract. See
[docs/ACP_SPINE.md](docs/ACP_SPINE.md) for the Phase 02 protocol sequence and
[docs/WEBSOCKET_SCHEMA.md](docs/WEBSOCKET_SCHEMA.md) for the frozen WebSocket message
schema.

## Repository layout

| Path | Purpose |
|---|---|
| `crates/loomwatch-backend` | Rust backend binary (`loomwatchd`) |
| `schemas/team.schema.yaml` | YAML/JSON Schema contract for teams and runtime records |
| `examples/` | Version-controlled team examples |
| `docs/` | Architecture and contract documentation |
| `ui/` | Web UI — React + Vite + React Flow, served by `loomwatchd` |

## Development

Only Docker is required on the host. Copy the environment template, then edit `.env` and
replace `POSTGRES_PASSWORD` with a local password before starting Postgres for the first
time. Run the Rust commands inside the pinned development image:

```sh
cp .env.example .env
# Edit .env and set POSTGRES_PASSWORD before continuing.
docker compose up -d postgres
docker compose run --rm dev cargo check --workspace
docker compose run --rm dev cargo test --workspace --all-targets
docker compose run --rm dev cargo clippy --workspace --all-targets -- -D warnings
docker compose run --rm dev cargo fmt --all -- --check
```

Postgres applies these credentials only when it initializes the data volume. If you change
them later, run `docker compose down -v` before starting Postgres again; this deletes the
local development database and recreates it with the new credentials.

The `dev` service installs the exact toolchain from `rust-toolchain.toml`; it is only a
build and test environment. The Compose file deliberately has no backend service: packaged
`loomwatchd` binaries run natively on macOS and connect to the local Postgres port. Team files
use schema version `1`; start with [`examples/research-team.yaml`](examples/research-team.yaml)
and see [`docs/TEAM_CONFIG.md`](docs/TEAM_CONFIG.md) for semantic validation rules.

## Using the UI

Build the UI assets and start the daemon:

```sh
cd ui && npm install && npm run build && cd ..
cargo build --release
./target/release/loomwatchd serve
```

The daemon prints the listening address (default `http://127.0.0.1:3000`). Open it in a
browser. To load a specific team file, append `?path=`:

```
http://127.0.0.1:3000/?path=/absolute/path/to/team.yaml
```

`?path=` is the only way to open a team file today — a teams-directory listing and
create endpoint (`GET /api/teams`) is deferred (see
[docs/CANVAS_SPEC.md §15.4](docs/CANVAS_SPEC.md#15-open-decisions--operator--backend)).
Without `?path=` the canvas opens in an empty state with no file to save to; the `New team`
entry point in the UI is visible but cannot write to disk until the directory endpoint ships.
The UI saves back via `PUT /api/team?path=...`, so once a file is opened it can be saved.
