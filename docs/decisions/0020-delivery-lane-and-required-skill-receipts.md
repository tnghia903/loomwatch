# 0020 — Delivery Lane and required-skill receipts

- Date: 2026-09-14
- Status: Implemented
- Builds on: [0019](0019-cross-harness-skill-delivery.md)
- Visual direction: [Delivery Lane](../design-explorations/2026-09-14-result-led-workspace/04-concept-delivery-lane.png)

## Problem

The canvas mixed configuration, execution, capability relationships, and the final response. Users could not quickly identify the output, or distinguish a connected skill from instructions actually supplied to an agent. Generic agent-message concatenation also put harness warnings and commentary at the front of the result.

## Run and Build

Run opens a dedicated reading surface with a persistent output column and its composer. The other column contains the request, agent stages, and a focused graph of required skills and recorded calls. Selecting a capability opens receipts without replacing the output. Selected-agent/whole-team scope, graph/list, skill/tool filters, and search keep large runs manageable. Calls are grouped by recorded operation identity; individual failures remain visible.

Build retains the existing editable canvas and local Library. Skill details include direct per-agent checkboxes showing each receiving harness, and maintain the same executable skill connections as canvas wiring. A direct final-response selector exposes the responder without requiring a connection gesture. Preview next run shows configured requirements before execution. Switching back to Run restores the previously opened run for the same team. Full trace preserves the detailed canvas and replay controls.

Straight handoff arrows appear only for linear pipelines. Branching pipelines and self-organizing teams show contributions without inventing a linear dependency chain; Full trace provides their connections. On phones the output appears first, followed by team work, with the existing composer available below.

## Connected skills are required instructions

For each agent, the workspace resolver copies the whole skill bundle into the receiving harness's discovery directory. A skill discovered under Claude Code can be delivered to Codex without installing a duplicate user-level copy. Source and execution harness remain separate fields.

The daemon then reads the copied SKILL.md and inserts its complete text into the opening prompt. Role, task, memory trust boundaries, and existing permission handling are preserved. Relative resource references are anchored to the copied bundle directory. Missing or unreadable instructions, unsupported harness placement, or more than 128 KiB of required instruction bytes for one agent fail preparation before that agent spawns. The instructions are never silently truncated to fit this limit.

This is applied to pipeline agents, self-organizing team agents, and recruited helpers. It does not translate harness-specific commands or grant tool access. A bundle can be successfully delivered while its instructions require tools unavailable in the receiving harness.

## Evidence contract

`prompt_sections` archives an immutable `requiredSkills` snapshot for each agent: skill name, discovery source, original and copied instruction paths, receiving harness, SHA-256 of the exact instruction bytes, and character count. The section itself contains the supplied instructions. An empty list records no requirements; an absent list means a legacy capture.

Only after the ACP session/prompt request is successfully sent does the daemon append `required_skills_supplied`, with the request ID and matching receipts. The projector accepts daemon-origin metadata and matches name, copied path, and fingerprint against preparation. Replay before the send receipt shows preparation, not loading. The receipt appears in provenance as a skill event, not an invented tool call.

The UI distinguishes:

- **Loaded into prompt**: complete instructions were sent in the agent's opening prompt.
- **Read observed**: a successful explicit file read was captured. This is weaker than complete instruction delivery.
- **Read failed**: matching reads failed.
- **Load unverified**: no sufficient receipt exists.
- **Will load**: a requirement in a next-run preview, before execution.

When a recorded resolved path is available, read evidence must match that exact path. Legacy captures can show explicit reads under an exact skill directory name, but cannot prove an aliased directory maps to the configured skill or that the current team matches historical requirements. Directory listings, tool titles, another agent's read, and redacted evidence never verify loading.

The fingerprint covers SKILL.md, not scripts or other files in the bundle. These receipts establish delivery, not model compliance, output correctness, or complete reproducibility. Required-skill validation and human output review remain separate.

## Final answer handling

Codex ACP metadata explicitly identifies commentary and final_answer chunks. The recorder keeps all chunks in the archive but delivers only final-answer text when those phases are available. Generic ACP output without phase metadata retains its existing behavior; there are no keyword-based filters.

Without phases, the delivered reply keeps every message the agent wrote in that turn, including progress notes written between tool calls. Choosing only the last message would be a guess, and it would lose a report the agent wrote before calling a tool to save it. Messages are a blank line apart, and the chunks within one message are joined verbatim. A changed ACP `messageId` marks a new message. A harness that sends no IDs is read at tool, plan and permission activity instead. Joining every chunk verbatim, as the daemon first did, ran separate notes into one line ("…render it.Draft builds…").

For old run rows, the UI matches the entire saved canonical reply to a completed archived turn before using that turn's phase metadata and message boundaries to clean its presentation. It never substitutes a later answer to a helper's question for the saved team response. Persisted historical rows are not rewritten. A follow-up from an old row therefore retains its original archived context.

Markdown output supports headings, tables, links, lists and code, plus copy and Markdown download. Raw HTML is omitted and remote image references are displayed as text. A generated-file gallery, embedded HTML artifact preview, and persistent whole-output approval are future work; the accompanying interaction prototype explores review behavior but does not imply it is implemented in the daemon.

## Validation

Backend tests cover copied instruction bytes, cross-harness placement, unchanged memory boundaries, and an ACP fixture that rejects a prompt unless it includes the required skill. Additional tests verify progress/final separation. UI tests cover immutable snapshots, replay timing, spoofed metadata, exact path identity, failure states, output rendering, navigation, and canonical-turn selection. Browser QA uses real archived run 15 and a copied team directory; no paid agent run was launched.

See [UI QA](../../ui/design-qa.md) and the [interactive prototype](../design-explorations/2026-09-14-result-led-workspace/prototype/README.md).
