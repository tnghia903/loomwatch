# 0019 — Skills and execution harnesses compose independently

- **Date:** 2026-09-13
- **Status:** Accepted — implemented in `crates/loomwatch-backend/src/workspace.rs` and
  `ui/src/components/Workspace.tsx`
- **Supersedes:** ADR 0012's Claude-only skill-delivery limitation

## Context

The Library scans skills installed by Claude Code, Codex, OpenCode, and the shared Agent Skills
directory. The composer nevertheless refused a Claude-discovered skill wired to a Codex agent.
That coupled the bundle's discovery source to the harness that executes it and defeated the point
of composing a cross-harness team.

The installed Codex app-server confirms that, for a supplied working directory, Codex discovers
`<cwd>/.agents/skills/<name>/SKILL.md` as a repository-scoped skill. Gemini and pi document the
same interoperable project path. Claude Code continues to use its native `.claude/skills` path.

## Decisions

1. **Skill source and execution harness are independent.** Any discovered Agent Skills bundle may
   be wired to any supported harness. The source label remains provenance, not a compatibility
   gate.
2. **LoomWatch adapts the placement, not the skill.** It copies the complete source bundle without
   rewriting it into `.claude/skills` for Claude Code or `.agents/skills` for Codex, Gemini,
   OpenCode, OpenClaw, and pi.
3. **Delivery stays per agent.** The copied bundle lives only in that agent's managed workspace.
   LoomWatch does not install it into another harness's user-level home.
4. **Both managed skill roots are rebuilt on every run.** This removes stale bundles when an agent
   changes harness or a capability is unwired.
5. **Unknown or session-injectable-only harnesses fail before spawn.** LoomWatch will not claim
   delivery until their project-local skill path can be supplied without changing global trust or
   user configuration. Hermes remains in this category because it only loads project skills from
   repositories in its persistent trust list.

## Consequences

- A Claude Code skill can run with a Codex agent, and a Codex skill can run with a Claude Code
  agent, without a duplicate user-level installation.
- Harness-specific instructions inside a bundle are preserved. A syntactically valid Agent Skill
  can therefore be delivered cross-harness even when its own content still depends on tools that
  only one harness exposes; that is a property of the skill, not its discovery source.
