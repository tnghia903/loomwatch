# Self-authorizing assignee pins freeze the resource they pin

Research for TNG-206 (parent: TNG-98, the org restructure that terminated the two agents
below). Written 2026-09-12 against the Paperclip control plane at `$PAPERCLIP_API_URL`,
OpenAPI spec digest fetched the same day from `GET /api/openapi.json`.

The headline is a guard-design finding, not a Paperclip bug report: **a mutation gate that
derives its authority from the field it protects becomes unrecoverable the moment the
principal named in that field stops existing.** LoomWatch's Team Bus (ARCHITECTURE.md §3)
has the same shape available to it, so this is written up as a constraint to design against
rather than an incident to close.

---

## 1. The observed defect

Two company routines carry `assigneeAgentId` pointed at agents that TNG-98 terminated.
`assigneeAgentId` is a hard pin — it never re-routes to a healthy agent — so enabling either
routine fires it at a terminated principal and silently does nothing.

| Routine id | Title | Pinned to | Pin status |
|---|---|---|---|
| `9895e150-954e-4baf-8055-f141723c43b3` | Refresh stale summary slots | `876dde21-caeb-4b62-912c-3eea8799a71d` (Summarizer, `opencode_local`) | `terminated` |
| `bb0b7132-83e2-428e-b7a7-9999cd95fd1a` | Review recent agent trajectories for coaching proposals | `22bfa43f-b3c5-4e49-a6fb-0502754505dc` (Reflection Coach, `claude_local`) | `terminated` |

Both are `status: paused` with `lastTriggeredAt: null`, so there is no live damage — this is
a latent trap, not an outage.

### 1.1 Terminated agents are readable by id but absent from the list

A reusable API fact, because it determines how you audit pins:
`GET /api/companies/{companyId}/agents` returns **only non-terminated** agents (10 rows on
2026-09-12; neither id above appears). `GET /api/agents/{id}` resolves a terminated agent
fine and reports `"status": "terminated"`. So absence from the company list proves nothing —
**confirm every pin with the by-id endpoint.** A pin audit built on the list endpoint reads a
dangling pin as "no pin" and a terminated pin as indistinguishable from a typo'd uuid.

Note also that the routine **list** endpoint
(`GET /api/companies/{companyId}/routines`) does not expand `assignee` — every row returns
`assignee: null` regardless of the pin. Only `GET /api/routines/{id}` expands it. An audit
sweep therefore costs one request per routine; there is no bulk pin view.

---

## 2. Why no agent can repair it

`PATCH /api/routines/{id}` accepts `assigneeAgentId` (`{"type":"string","format":"uuid",
"nullable":true}`) alongside `title`, `status`, `priority`, `variables`, `env`,
`concurrencyPolicy`, `catchUpPolicy`, `activityGatePolicy`, `activityGateScope`,
`description`, `baseRevisionId`, and the four scope ids. No field is required.

Both re-point attempts were refused identically:

```
PATCH /api/routines/9895e150-954e-4baf-8055-f141723c43b3
  {"assigneeAgentId":"b62be493-e2a4-4af2-bb34-c8edf5df94a6"}
→ {"error": "Agents can only manage routines assigned to themselves"}
```

### 2.1 The control that makes this conclusive

An error string alone does not distinguish *"agents may never PATCH routines"* from *"the gate
reads the current assignee."* The distinction decides whether an agent-side repair path
exists at all, so it needs a positive control.

Routine `4b0e28e8-8963-4a08-8f66-2c4b8d6726ef` (*Monthly vendor-receipt digest*) is pinned to
Protocol Researcher — the caller. The same PATCH shape, setting `assigneeAgentId` to the value
it already held (a true no-op), **succeeded**, returning `status: paused` unchanged.

That pins the gate exactly:

> `PATCH /api/routines/{id}` requires `routine.assigneeAgentId == callerAgentId`, evaluated
> against the **pre-write** value.

The consequence is the finding. The only principal authorized to move a pin is the principal
the pin already names. When that principal is terminated:

- it cannot act, so it cannot re-point itself;
- no other agent satisfies the gate, so no other agent can re-point it either.

The routine is frozen for the entire agent population. Authority to repair the pin was
destroyed by the same operation that created the need to repair it.

### 2.2 The built-in-bundle path is closed too

Both routines are `originKind: built_in_agent_bundle`
(`originId: summarizer:refresh-stale-summaries` and
`reflection-coach:recent-agent-reflection`), so the bundle endpoints are the obvious second
route. They are shut:

```
GET /api/companies/{companyId}/built-in-agents/summarizer/status
GET /api/companies/{companyId}/built-in-agents/reflection-coach/status
→ {"error": "Built-in agents are not enabled"}
```

`provision`, `reconcile`, and `reset` sit behind the same company-level switch. Two further
points matter for anyone reaching for them later:

- **They are the wrong repair anyway.** Those endpoints revive the built-in agent; they do not
  re-point the routine at a *different* runner. Using them would resurrect two agents TNG-98
  deliberately terminated — reversing a settled restructure decision, which is not a
  protocol-level call.
- **Re-materialization would not fix the pin.** Each routine's description frontmatter carries
  `assigneeRef: {resourceKind: agent, resourceKey: summarizer}` (resp. `reflection-coach`) —
  keyed by `urlKey`, which still resolves to the *terminated* agent. A bundle re-sync would
  re-derive the same dead pin.

That last point cuts the other way too, and is the one piece of good news: because bundles are
disabled, nothing re-materializes these routines, so a manual `assigneeAgentId` fix will not be
silently reverted by a later sync. The stale `assigneeRef` in the frontmatter is inert **while
the bundle switch stays off** — it is a second, dormant copy of the same dangling pin, and it
should be corrected whenever built-in agents are enabled.

---

## 3. The correct replacement pin

For the record, so the repair does not need re-deriving. Both routines should go to
**Chief Secretary `b62be493-e2a4-4af2-bb34-c8edf5df94a6`** (`running`, `claude_local`), on
three independent grounds:

1. **Org chart** — Chief Secretary was already the `reportsTo` parent of *both* terminated
   agents. Their work falls upward to it by default; no new reporting relationship is invented.
2. **Cost** — `claude_local` is subscription-native, so neither routine incurs OpenRouter
   spend. The `opencode_local` implementers are the metered lane.
3. **Adapter class** — neither routine touches MCP connectors, so the
   `claude_local`-only connector constraint is not binding; `claude_local` is simply the safe
   superset. Verified by scanning both operating-procedure skills
   (`summarize-status` `96a3b245-fb23-4432-b442-a6b1607f9615`, `reflection-coach`
   `ebda7eeb-2165-472b-b984-575b0aba1247`) via
   `GET /api/companies/{companyId}/skills/{skillId}/files` for `mcp`, `MCP`, `connector`,
   `gateway`, `WebFetch`, `WebSearch` — **zero hits in either**. Both skills exist
   company-wide and survived the restructure, so the procedures remain available to a new
   assignee.

### 3.1 One guard does not survive the move

Reflection Coach carried an agent-level permission the replacement does not have:

```json
"permissions": {
  "builtInMutationPolicy": {
    "requiresDisplayedDiff": true,
    "applyInSeparateFollowUpRun": true,
    "requiresAcceptedTaskInteraction": true
  }
}
```

Routine `bb0b7132…` mutates agent instructions and skills, and those three constraints are
what kept it proposal-only. Re-pointing it to an agent without
`permissions.builtInMutationPolicy` **moves the routine out from under its enforcement** and
leaves only the prose restatement in the routine description ("Proposal-only…", "requires an
accepted `request_confirmation`") — prompt-level, not server-enforced.

This is the same failure ARCHITECTURE.md §3 names when it insists guards are "enforced in the
bus, never in prompts". Whoever enables `bb0b7132…` must either grant the replacement assignee
an equivalent `builtInMutationPolicy` or accept that the proposal-only boundary is advisory.

---

## 4. Sibling defect the TNG-206 census missed

Auditing all six company routines by id turned up a second, distinct instance of the same
class. TNG-206 enumerated only the two `terminated` pins:

| Routine id | Title | Pinned to | Pin status |
|---|---|---|---|
| `c7c6685a-3c4d-4020-aaff-b98320f744f2` | Weekly scheduling digest | `cc0d98cc-d4a0-4730-aff0-1e8b73545a2a` (Backend Implementer) | **`error`** |
| `f02ca6d0-ff7d-4047-9c13-4b3bf6392922` | Weekly self-learning review | `cc0d98cc-d4a0-4730-aff0-1e8b73545a2a` (Backend Implementer) | **`error`** |

`error` is not `terminated`, so a sweep grepping for termination misses these — but TNG-206's
own acceptance bar is that a pin "resolves to a `running`/`idle` agent", and `error` fails it.
Whether an `error` agent can still satisfy the PATCH gate (and so repair itself) was **not**
tested; it is a different question from the terminated case and should not be assumed either
way.

The remaining two routines are healthy: `4b0e28e8…` (pinned to Protocol Researcher, `running`)
and `7aecfeb2…` (already `archived`, same pin).

**Audit rule:** the predicate for a dangling pin is `status NOT IN (running, idle)`, not
`status == terminated`.

---

## 5. What this means for the Team Bus (ARCHITECTURE.md §3)

LoomWatch's guards are depth cap, fan-out cap, cycle detection, and budget admission — all
bus-enforced. None of them is self-authorizing today, and this finding is the argument for
keeping it that way as the canvas gains persistent, agent-targeted configuration.

The transferable rule:

> Never let the authority to edit a binding be derived solely from the binding's own target.
> Mutation rights belong to a role that outlives the bound principal — the owner, the parent in
> the org chart, or the human operator.

Three places LoomWatch could reproduce the defect, each worth a deliberate decision before it
ships:

1. **Persisted canvas edges.** A configured `dispatch` edge stores a target agent id. If edge
   edits are ever authorized as "only the target may rewire its own inbound edges", deleting a
   node strands every edge into it — uneditable and undeletable. Edge mutation should be
   authorized by team-file ownership, which is what `schemas/team.schema.yaml` already implies.
2. **Budget caps keyed to an agent id.** A per-agent threshold that only that agent may raise
   becomes unraisable once the agent errors out — and because budget admission *refuses new
   delegations*, a frozen cap fails closed and silently starves delegation. Prefer team-level
   admission with per-agent overrides the team owner can edit.
3. **`handoff` and the successor chain.** §3 already records that `handoff` cannot cancel the
   caller's turn because ACP provides no cancellation hook. If a handoff record is later made
   mutable only by the named successor, a successor that never starts leaves the record
   unresolvable. The caller or the bus should retain authority over it.

The cheap structural check, applicable to any new guard: **ask what happens to this record when
the principal it names is terminated.** If the answer is "nobody can change it", the guard has a
self-lock and the authority needs to move up a level.

---

## 6. Disposition

The repair identified in §3 is **not performable by any agent** (§2). It needs a user-level
actor — tnghia — to issue, for each of the two routines in §1:

```
PATCH /api/routines/{id}   {"assigneeAgentId": "b62be493-e2a4-4af2-bb34-c8edf5df94a6"}
```

Both must stay `paused`; enabling them is a separate decision, and for `bb0b7132…` it is gated
on the `builtInMutationPolicy` question in §3.1. Verify with `GET /api/routines/{id}` and
confirm the new pin with `GET /api/agents/{id}` — not by its absence from the company list
(§1.1).
