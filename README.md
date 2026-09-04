# LoomWatch

A native macOS canvas for composing and watching multi-vendor autonomous agent teams.

You drag agents onto a canvas from a panel of whatever harnesses are installed on your
machine, wire them up (or don't), give the team a goal, and watch the work happen as a
live graph — nodes are agents, edges are the delegations between them.

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
- **Local-first.** No cloud dependency for execution, no public endpoint required.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full specification.

## Stack

| Layer | Technology |
|---|---|
| Agents | Local processes speaking ACP over stdio |
| Backend | Rust — ACP client, process supervisor, Team Bus MCP server, SQLite, WebSocket |
| App | Swift 6.3 / SwiftUI, Canvas rendering, MenuBarExtra, UserNotifications |
| Team config | Version-controlled YAML |

## Status

Pre-implementation. The architecture is settled; nothing is built yet.
