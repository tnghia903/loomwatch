# Skill routing

How a wired Agent Skill actually reaches an agent, and how the run says whether the agent used it.

The decision is [ADR 0021](decisions/0021-skill-routing-by-portability.md), which amends the last
consequence of [ADR 0019](decisions/0019-cross-harness-skill-delivery.md) and leaves its five
decisions untouched. This file is the companion: what shipped, where it lives, what gates it, and
how to test it by hand.

**[Implementation status](#implementation-status) is at the bottom and is kept current.** Read it
before trusting any sentence here as a description of the tree.

---

## 1. The problem

`LoomWatch` guaranteed **delivery** — right bytes, right path, sha256 receipt — and ADR 0019
explicitly disclaimed **behavioural fidelity**. Three things followed from that.

The whole `SKILL.md`, YAML frontmatter included, was pasted into the opening prompt of every run
and every pipeline stage for every wired skill, regardless of the receiving harness. On Claude Code
the skill was double-exposed: once in the prompt, once at `.claude/skills` where Claude Code
already looks. The median installed skill is about 6k characters; 27 of them are over 20k.

A quarter of the library carries execution-level assumptions, and they fail silently off Claude.
Measured live against this machine's installed corpus through the daemon's own classifier (326
skills, including plugin payloads): 51.8% carry at least one execution-level marker — 29% shell out
to a bundled script, 21% reference a slash command, 17% assume subagents, 4% name a Claude tool —
and 35% name a Claude-only product surface.

And nothing in the run record could tell degradation from success. `grep -rn used_skill crates
ui/src` returned nothing. The archive proved delivery and proved a prompt was sent, which
`RUN_PROVENANCE_CONTRACT.md` §12 says is explicitly *not* use.

## 2. Three routes

Decided once per (skill, agent) pair in `workspace::materialise`, from the skill's own text and the
receiving harness, so the prompt, the archive and the inspector cannot disagree.

| Route | When | What the agent receives |
|---|---|---|
| `native` | the harness is Claude Code, or the skill has no execution-level coupling and is not behaviour-governing | bundle copied to the harness's own skill directory; in the prompt, the skill's `description` and "before you start, read `<dir>/SKILL.md` in full" |
| `inline` | execution-level coupling on a non-Claude harness, or a behaviour-governing skill on one | bundle copied **and** the frontmatter-stripped body in the prompt, then a translation note as its own `skill_translation` section |
| `blocked` | no project skill directory `LoomWatch` can write (Hermes, unknown) | the run is refused before spawn — unchanged from ADR 0019 decision 5 |

Frontmatter never reaches a model on any route. The file on disk keeps it, byte for byte, and
`sha256` still fingerprints the delivered file; `bodySha256` covers the strippable body.

On the live corpus this routes 188 of 326 skills (57.7%) `inline` for a Codex agent and 138 (42.3%)
`native`. A skill on Claude Code is always `native`.

## 3. The translation note

A mapping, never a rewrite. `skill_routing::translation_note` is a pure function; it quotes nothing
from the skill and stays around a thousand characters.

It advertises a Team Bus tool **only** when that agent will actually be offered it, read off
`team_bus::tool_definitions` and `team_bus::refuse_by_mode`:

- `dispatch` / `handoff` — team mode only.
- `ask` — both modes, but pipeline mode refuses it to an agent with `allowRecruiting: false`
  unless the target is a live predecessor, which a note written before the run cannot promise.
- `ask_user` — both modes.
- A harness `ARCHITECTURE.md` does not record as advertising HTTP MCP (OpenClaw, pi) is promised
  nothing and told "you have no way to delegate here; do the steps yourself, in sequence."

It tells the truth about bundled scripts: `LoomWatch` refuses every `session/request_permission`
(`acp.rs::build_client_response`), so the note says a script may simply not run and asks the agent
to do the step by hand and say so. It does not promise a permission channel this phase does not
build.

Every note ends with: *"List, at the end of your reply, every required-skill instruction you could
not follow and why."*

## 4. Evidence: delivered → opened

| Record | Phase | What it proves |
|---|---|---|
| preparation | `prompt_sections` `requiredSkills` | what `LoomWatch` wrote into the workspace, with route, kind, needs and both fingerprints |
| send | `required_skills_supplied` | the opening prompt carrying it was sent |
| **open** | `skill_opened` | the agent's own stream read the delivered `SKILL.md`, or Claude Code's `Skill` tool named it |
| self-report | `skill_self_report` | what the agent *says* it could not follow — **a claim, never provenance** (CONTRACT §8.2) |

Only a path under a managed root counts. A read of the operator's own installed copy under `$HOME`
is real bytes but not this run's, and a title merely mentioning a skill is not a read. One record
per skill per session: a tool call and its update are one open.

---

## Implementation status

Kept current. Last updated 2026-09-20 (skill routing phase 1:
[ADR 0021](decisions/0021-skill-routing-by-portability.md)).

### Built and gated

| Piece | Where | Gate |
|---|---|---|
| `SkillNeed`, `SkillKind`, `SkillRoute`, `PortabilityEvidence`; `analyse` over a `SKILL.md` | `skill_routing.rs` | `skill_routing::tests::*` (20 tests) |
| **Frontmatter split off; the file on disk untouched; an unterminated `---` is not frontmatter** | `skill_routing::split_frontmatter` | `frontmatter_is_split_off_and_the_file_is_left_alone`, `a_document_without_frontmatter_keeps_all_of_its_text_as_body` |
| Conservative detection: a bare English word, an absolute path, a citation of a command, and "artifact" in its ordinary sense are **not** coupling | `skill_routing::matches` | `prose_that_merely_mentions_a_harness_is_not_execution_coupling`, `slash_commands_and_scripts_survive_the_markdown_they_are_written_in` (both halves) |
| The route rule: a harness with no skill folder gets everything `inline` (ADR 0031; `blocked` is no longer produced), Claude Code is `native` for everything | `skill_routing::route` | `a_harness_with_no_skill_directory_gets_every_skill_inline`, `workspace::an_app_with_no_skill_folder_gets_the_skill_in_its_prompt_instead_of_a_refusal` (**counterfactual verified**), `a_coupled_skill_is_inline_off_claude_and_native_on_it`, `a_behaviour_governing_skill_is_inline_off_claude_even_without_execution_coupling`, `an_uncoupled_skill_is_native_everywhere_it_can_be_delivered` |
| **One list of skill folders for detection and delivery; Hermes, OpenClaw, Gemini, pi and the project read; trash, staging and catalogs skipped** (ADR 0031) | `capabilities::skill_roots`, `find_skill_files` | `lists_skills_from_every_app_and_the_project_the_teams_live_in`, `lists_plugin_skills_from_both_harnesses_and_keeps_same_named_ones_apart` (**counterfactual verified**) |
| **Multi-line frontmatter values read whole** | `skill_routing::frontmatter_field` | `a_multi_line_description_is_read_whole`, `a_multi_line_description_reaches_the_library_whole` |
| **A delivered copy is named for the skill; wiring is case-insensitive; a skill wired twice is delivered once** | `workspace::copy_skill`, `materialise` | `a_skill_is_delivered_under_its_own_name_and_matched_whatever_its_case` |
| Bus affordances read off the bus, not guessed; a harness with no HTTP MCP is promised nothing | `skill_routing::bus_tools`, `Harness::advertises_http_mcp` | `team_mode_offers_every_delegation_tool_and_pipeline_mode_withdraws_two`, `a_harness_without_http_mcp_is_promised_no_bus_tools_at_all` |
| Translation note: one mapping line per detected need, truthful about scripts, ends with the self-report request, ≤ ~1.5k chars | `skill_routing::translation_note` | `the_note_names_ask_only_when_this_agent_may_actually_call_it`, `the_note_tells_the_truth_about_bundled_scripts`, `the_note_maps_named_tools_and_routes_the_operator_question_to_the_bus`, `the_note_names_which_referenced_skills_are_connected_and_which_are_not`, `every_need_gets_a_mapping_and_the_note_stays_short` |
| **The router, on `PreparedSkill`: route, kind, needs, description, `bodySha256`; `sha256` still over the delivered file** | `workspace.rs::prepare_skill` | `no_route_puts_a_skills_yaml_frontmatter_in_front_of_the_model` (**counterfactual verified**) |
| **A coupled skill on a Codex agent is `inline` with a note that promises only what the agent has** | `workspace.rs::materialise`, `prepare_skill` | `a_coupled_skill_on_codex_is_inlined_with_a_note_that_only_promises_tools_it_has` (**counterfactual verified**) |
| **The same skill on a Claude agent is `native`, with a pointer and no note** | `workspace.rs::prepare_skill`, `memory.rs` | `the_same_skill_on_a_claude_agent_is_native_with_a_pointer_instead_of_its_text` (**counterfactual verified**) |
| Sibling skills resolved against the agent's own `capabilities`, not against the machine | `workspace.rs::resolve_siblings` | asserted inside the note tests |
| `PromptSectionKind::SkillTranslation`; per-route prompt composition; the 128 KiB cap and the byte-for-byte guarantee kept | `memory.rs::with_required_skills` | `lib::tests::a_team_without_memory_gets_exactly_the_prompt_it_got_before`, `required_skill_instructions_preserve_the_prompt_and_memory_boundary` |
| Bus surface threaded from the caller, not invented by `materialise` | `lib.rs::materialise_for`, `team_bus.rs::run_agent_inner` | compiled; exercised by every workspace test |
| **`skill_opened` archived from a read of a managed copy or Claude Code's `Skill` tool, once per skill** | `acp.rs::note_open_if_delivered`, `opened_skill` | `a_read_of_the_delivered_skill_is_archived_as_an_open`, `only_a_managed_copy_of_this_skill_counts_as_opening_it`, `claude_codes_skill_tool_names_the_skill_it_invoked` |
| `skill_self_report` archived from the reply, under its own phase | `acp.rs::note_self_report`, `skill_routing::self_report` | `the_agents_account_of_what_it_skipped_is_archived_as_a_self_report` |
| **The counterfactual for both lanes: delivery with no read archives neither record** | as above | `a_delivered_skill_the_agent_never_opened_archives_no_open_and_no_self_report` |
| `portability` on `GET /api/capabilities/{id}`: kind, needs, evidence lines, and the route on every known harness | `capabilities.rs::SkillPortabilityReport` | verified live against the running daemon over all 326 installed skills |
| `skill_translation` section kind and the `opened` receipt state in the client | `ui/src/lib/watch/events.ts` | `requiredSkillReceipts.test.ts` "raises a supplied skill to opened only when the daemon recorded the agent reading it" (**counterfactual verified**) |
| Route-accurate wording: a `native` route is never reported as "loaded into prompt" | `ui/src/lib/runs/capabilityEvidence.ts` | `requiredSkillReceipts.test.ts` "describes a supplied skill by the route it actually took" |
| Self-report kept off the evidence list | `events.ts`, `DeliveryLane.tsx` | `requiredSkillReceipts.test.ts` "keeps the agent's self-report off the evidence list" |
| Run UI: `n/n opened` per stage, route sentence, opened/not-recorded, the archived note, the self-report | `ui/src/components/run/DeliveryLane.tsx` | `DeliveryLane.test.tsx` "shows the route, whether the skill was opened…" and "says plainly that an unopened skill was delivered and not opened" |
| Inspector: Portability zone with evidence lines, the route per agent, the Claude-agent suggestion; **the passive disclaimer replaced** | `ui/src/components/canvas/CapabilityInspector.tsx` | `CapabilityInspector.test.tsx` "names what a skill assumes…", "offers the Claude agent already in the team…", "does not suggest a Claude agent for a skill that assumes nothing" |

### Not built, and why

| Not built | Why |
|---|---|
| `sidecar` route (run the skill in a helper on its own harness) | Phase 3. Deliberately **not** in `SkillRoute`: an unimplemented variant is a route the router can never return and the UI has to render anyway. |
| Operator override of `kind` on a team file's `CapabilityRef` | The brief allowed it *if the schema change was small*. It is not: `kind` on that object already means the capability's type (`kind: skill`), so a second `kind` is impossible and any other spelling is a different contract from the one proposed. The heuristic ships alone; `schemas/team.schema.yaml` and `tests/team_schema.rs` are untouched. |
| Per-harness permission plumbing for bundled scripts | Out of scope by the brief. The note tells the truth instead: `LoomWatch` refuses every permission request, so a script may not run. |
| A `used_skill` provenance **edge** in the trace graph | `skill_opened` is the recorded evidence CONTRACT §8.2 requires before such an edge can exist. Projecting it into `TraceEdge.kind: used_skill` is a separate change to the provenance projector. |
| `sourcePath`-based open detection | A read of the operator's installed copy is real bytes but not this run's. Only managed roots count. |

---

## Manual test script

Everything below runs against `teams/loomwatch-market-research.yaml`, the live cross-harness case:
the Claude-sourced skill `claude-design` wired onto the `codex-acp` agent **Report Dashboard
Design**, with the Claude agent **Research** as the entrypoint.

### 0. Start

```sh
cd ~/Developer/loomwatch
set -a; . ./.env; set +a
export DATABASE_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_PORT}/${POSTGRES_DB}"
~/.cargo/bin/cargo run -p loomwatch-backend --bin loomwatchd -- \
  serve --teams-root teams --listen 127.0.0.1:3000
```

The daemon serves the UI it was **built** with, so for UI changes run the dev server beside it:

```sh
npm --prefix ui run dev      # http://localhost:5173, proxies /api to 127.0.0.1:3000
```

Open <http://localhost:5173> → **or open an existing team** → type
`loomwatch-market-research.yaml` → **Open**.

### 1. `claude-design` on the Codex agent — route, needs, suggestion

Click the **claude-design** card on the canvas, then **Details & connections**.

Expect, in order down the panel:

- **Portability** → "Produces a deliverable." (kind `artifact`)
- Two needs with the line from the skill that produced each:
  - `Claude surfaces` → *"…check for other web-design skills like `popular-web-designs`…"*
  - `other skills` → the same line
- **Use with agents**:
  - **Report Dashboard Design** — *Codex · native — delivered to this harness's own skill
    directory, and the prompt points at it* · **Required**
  - **Research** — *Claude · native — …*
- The suggestion, because the skill is `artifact`-kind, leans on Claude, and is wired to a
  non-Claude agent while a Claude agent sits unconnected:
  > This skill produces a deliverable and its own text leans on Claude (Claude surfaces, other
  > skills). Research runs Claude Code, where those assumptions hold.

  with a **Connect to Research** button. Clicking it wires the skill to Research and the suggestion
  disappears. **Do not save** unless you want the change kept.
- The last line of the zone is the replacement for the old disclaimer — it now names what
  `LoomWatch` actually does per harness.

`claude-design` routes `native` on Codex because it is genuinely portable: it names Claude's hosted
helpers only in a "do not use these" list and tells the agent to use whatever its environment has.
That is the correct answer, and it is the case that proves the classifier is not simply inlining
everything Claude-flavoured.

### 2. A skill that really is coupled — the `inline` route

In the Library search box type `design-md`, click its **+** to place it, then click the card →
**Details & connections**.

Expect:

- **Portability** → "Produces a deliverable.", needs `scripts` and `Claude surfaces`, with the
  evidence line `npx -y @google/design.md lint DESIGN.md`.
- **Report Dashboard Design** — *Codex · **in-prompt, translated for Codex***
- **Research** — *Claude · native — …*

Tick **Report Dashboard Design** to wire it, and **Save**.

### 3. Run it, and read the evidence

Press **Run team** with any prompt (for example *"Draft the market report and design a one-page
summary."*). When it finishes:

- Each stage card shows **`n/n opened`**, not "loaded" — the count of skills the agent's own stream
  shows it opening.
- Click a skill in **Skills and tools** to open its receipt. You get:
  - **Route** — the sentence for that route, plus the needs that produced it.
  - **Opened by the agent** — *"Yes — its own stream shows it reading the delivered file"*, or
    *"Not recorded. Delivery is not use…"*.
  - **Instruction file**, **Instructions fingerprint**, and **Read the N characters that were
    supplied** (which re-reads the prepared copy and compares it against the run's fingerprint).
  - **What LoomWatch told this agent about running it here** — the archived translation note,
    verbatim, for an `inline` route.
  - **What the agent said it could not follow** — its own account, labelled as a claim.

The delivered bundle and the note also exist outside the UI:

```sh
# the delivered copy, rebuilt every run
ls teams/.loomwatch/loomwatch-market-research/codex/.agents/skills/

# the note as it was actually sent, from the archive
~/.cargo/bin/cargo run -p loomwatch-backend --bin loomwatchd -- \
  show --session <runId> | python3 -c '
import sys, json
for line in sys.stdin:
    e = json.loads(line)
    p = e.get("payload", {})
    if p.get("phase") == "prompt_sections":
        for s in p.get("sections", []):
            if s["kind"] == "skill_translation":
                print(s["heading"]); print(s["text"])
    if p.get("phase") in ("skill_opened", "skill_self_report"):
        print(e["agentId"], json.dumps(p)[:300])
'
```

### 4. The Claude-agent `native` case

Tick **Research** for `claude-design` (or use the suggestion button in step 1), **Save**, and run
again. In Research's receipt:

- **Route** → *"Native — the bundle sits in this harness's own skill directory and the prompt
  points at it."*
- **What LoomWatch told this agent about running it here** is **absent** — there is nothing to
  translate on the harness the skill was written for.
- The opening prompt's `## Required skill: claude-design` section is a short paragraph — the
  skill's description plus "read `<dir>/SKILL.md` in full" — instead of 25k characters of skill
  text. The bundle is at
  `teams/.loomwatch/loomwatch-market-research/codex-2/.claude/skills/claude-design/SKILL.md`,
  which is where Claude Code looks anyway.

### What to watch for

- **`Not recorded` is not `not opened`.** A harness that reports opaque tool input will never
  produce a `skill_opened`. Per CONTRACT §12 that is `unavailable`, and the panel says so.
- The classification is a heuristic over prose and will be wrong sometimes. That is why every need
  carries the line that produced it — if a line looks like a false positive, the classification is
  wrong and nothing else is: `LoomWatch` never rewrote the skill.

---

## Gates

Run from the repository root with `DATABASE_URL` exported as in step 0. `cargo` is not on `PATH` in
non-interactive shells, so use `~/.cargo/bin/cargo`.

| Command | Result (2026-09-20) |
|---|---|
| `~/.cargo/bin/cargo test -p loomwatch-backend` | `ok. 241 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out` (was 213 before this work) |
| `~/.cargo/bin/cargo test --test team_schema` | `ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out` |
| `~/.cargo/bin/cargo clippy -p loomwatch-backend -- -D warnings` | `Finished dev profile` — clean. Also clean with `--all-targets`. |
| `~/.cargo/bin/cargo fmt --check` | One diff, **pre-existing and out of scope**: `crates/loomwatch-backend/src/api.rs:1466`, an uncommitted line from other in-flight work (it is a `+` line in the working-tree diff and absent from `HEAD`). Every file this work touched is formatted. |
| `pnpm exec tsc -b` (in `ui/`) | clean, no output |
| `pnpm exec vitest run` (in `ui/`) | `Test Files 49 passed (49)`, `Tests 454 passed (454)` (was 446) |
| `pnpm exec oxlint` (in `ui/`) | exit 0, 7 warnings — all pre-existing in `Workspace.tsx` and `useComposerLayout.ts`, none at a line this work changed |

### Counterfactual proofs

Each change was reverted on its own, the suite re-run, and then restored; the restored tree is
byte-identical to the one that ships.

| Reverted | Command | Result |
|---|---|---|
| `prepare_skill` stops stripping frontmatter (`body = text.clone()`) | `cargo test -p loomwatch-backend no_route_puts` | `FAILED. 0 passed; 1 failed` — `no_route_puts_a_skills_yaml_frontmatter_in_front_of_the_model` panicked printing the whole manifest |
| `bus_tools` advertises `ask` regardless of `allowRecruiting` | `cargo test -p loomwatch-backend` | `FAILED. 238 passed; 3 failed` — `a_coupled_skill_on_codex_is_inlined_with_a_note_that_only_promises_tools_it_has`, `the_note_names_ask_only_when_this_agent_may_actually_call_it`, `team_mode_offers_every_delegation_tool_and_pipeline_mode_withdraws_two` |
| `route` no longer short-circuits Claude Code to `native` | `cargo test -p loomwatch-backend` | `FAILED. 238 passed; 3 failed` — `the_same_skill_on_a_claude_agent_is_native_with_a_pointer_instead_of_its_text`, `a_coupled_skill_is_inline_off_claude_and_native_on_it`, `no_route_puts_a_skills_yaml_frontmatter_in_front_of_the_model` |
| `events.ts` stops projecting `skill_opened` | `vitest run requiredSkillReceipts DeliveryLane` | `Tests 2 failed | 19 passed` — `expected 'supplied' to be 'opened'`, and the Delivery Lane receipt test |

Two further counterfactuals are permanent tests rather than one-off reverts, because the failure
they guard against is a detector that fires on nothing:
`a_delivered_skill_the_agent_never_opened_archives_no_open_and_no_self_report` (same delivery, no
read, no phrase → neither record) and the negative half of
`slash_commands_and_scripts_survive_the_markdown_they_are_written_in` (a citation of a command is
not an instruction to run one).
