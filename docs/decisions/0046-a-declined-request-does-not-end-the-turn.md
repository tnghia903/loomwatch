# 0046 — A declined request does not end the agent's turn

- **Date:** 2026-10-03
- **Status:** Accepted.
  - Daemon: `crates/loomwatch-backend/src/acp.rs`:
    - `client_response`, which ranks the app's rejection options;
    - `prompt_turn` and `prompt_round`, which carry a turn on;
    - `Declined`, `carry_on_request` and `RESUMES_PER_TURN`;
    - `ask_operator`, which now also records `not_asked`.
  - UI:
    - `ui/src/lib/watch/events.ts`: the permission outcome by the kind of the chosen option;
      `turn_resumed` in `projectRun` and `recordedReplyText`; `ProjectedAgent.resumedTurns`.
    - `ui/src/lib/story/receipt.ts`: one aside.
  - Docs: `docs/TEAM_CONFIG.md`, `docs/WATCH.md`, `docs/WEBSOCKET_SCHEMA.md`.
- **Amends:**
  - [ADR 0037](0037-loomwatch-decides-what-agents-may-do.md): which rejection is chosen.
  - [ADR 0040](0040-ask-the-operator-for-permission-mid-run.md): decision 5, so the record now also
    says when nobody was asked.

## Context

The daily tech digest (`examples/usecases/daily-tech-digest.yaml`) ran twice as a routine on
2026-10-03. Its Gatherer runs on Codex (`codex-acp` 2.1.1, Codex 0.159.3) with only the web switched
on. Both times Gatherer tried `curl -sS https://github.blog/...`. Codex asked, and its
`session/request_permission` (run f806a330, seq 499) offered three options:

| optionId | kind | name |
| --- | --- | --- |
| `allow_once` | `allow_once` | Yes, proceed |
| `accept_execpolicy_amendment` | `allow_always` | Yes, and don't ask again for commands that start with `curl -sS` |
| `cancel` | `reject_once` | No, and tell Codex what to do differently |

A routine has nobody to ask, so `LoomWatch` declined. It chose the only `reject_once`, `cancel`.
Codex maps that option to its own `cancel` decision. That aborts the turn and waits for the person
at the keyboard to say what to do instead. The work turn ended `cancelled` with only Gatherer's
narration. The story list survived only because the stage's handover turn asked for it again. The
receipt said "Worth a look: Turn ended: cancelled".

The receipt said nothing about what was declined. `projectRun` marked a permission refused only
when the outcome was `cancelled`. Every real app offers a rejection option, and `LoomWatch` selects
it, so the decline was projected as "succeeded, answered cancel". "Gatherer wasn't allowed to run
commands" never appeared, and neither did its "Allow from now on" (ADR 0037, decision 8).

How each app treats the rejection `LoomWatch` chooses, read from the installed versions:

- **Claude Code** (`claude-agent-acp` 0.85.1) offers `reject` (`reject_once`). It denies that one
  call with `interrupt: false`, and the model reads "User refused permission to run tool" and goes
  on.
- **Gemini CLI** (0.54.4) offers `cancel` (`reject_once`). It returns "Tool … was canceled by the
  user." to the model as the call's result, and the turn goes on.
- **Codex** (`codex-acp` 2.1.1) has two one-time rejections: `decline` ("No, continue without
  running it") and `cancel`. Only `decline` keeps the turn going. Codex lists `decline` only on some
  command prompts. A file change, an MCP tool approval, and the `curl` above get `cancel` alone.
  Choosing an option Codex did not offer, or answering `cancelled`, also becomes `cancel`.

So no answer exists that both declines Codex's request and keeps its turn going.

## Decision

1. **Choose a rejection that keeps the turn going when there is one.** Among the offered
   rejections, a `reject_once` comes first, as before. Among those, one whose id is not `cancel`
   comes first, which is Codex's `decline`. A one-time `cancel` still beats `reject_always`.
   Codex's "block this host in the future" would outlive the run in its settings, as
   `allow_always` would (ADR 0037, decision 5).
2. **When the app ends the turn on a decline anyway, ask it to carry on, in the same session.** A
   `session/prompt` that returns `stopReason: cancelled` after `LoomWatch` declined a request since
   it was sent was cancelled by that decline. `LoomWatch` never cancels a turn it goes on with:
   `session/cancel` is sent only on a timeout, right before the run fails, and Stop aborts the run
   task. `prompt_turn` then sends one more prompt:

   > Your request was declined:
   > - Run command (curl -sS https://github.blog/changelog/feed/): nobody can be asked to allow it
   >   during this run.
   >
   > Declining it also ended your turn, but nobody asked you to stop. Carry on with your task from
   > where you were, without it: don't ask for the same thing again, and use what you are allowed to
   > do instead. Then finish your reply as you would have.

   The reason is one of: nobody can be asked (a routine, an Ask session, the CLI), the person
   running the team said no, or nobody answered in time. The test is on what happened, not on the
   app's name. An app that keeps its turn going never returns `cancelled`, and a turn the app
   cancels for its own reasons, with nothing declined, is left alone.
3. **At most three times per turn.** An agent that keeps asking for what is declined, in an app
   that ends its turn each time, stops there. The turn then ends `cancelled`, as the app said, and
   the receipt still says "Turn ended: cancelled".
4. **It is one turn in the record.**
   - Each cut is a `session_meta` event `turn_resumed`. It records `stopReason: cancelled` and the
     app's `usage`. It also lists what was declined (`title`, `kind`, `detail`, `outcome`). Its
     `raw` is `{source: loomwatch, response}`, where `response` is the app's own `cancelled` reply.
   - The request to carry on follows as an ordinary user message, then one `turn_end`.
   - The reply runs across the cut, as the daemon's `ReplyText` and the UI's `recordedReplyText`
     both read it, so the answer is what the agent finished with.
   - Its tokens count. "Turn ended: cancelled" is not raised for a turn that went on to finish.
5. **The record says what was declined, and why.**
   - `projectRun` reads a decision by the kind of the option chosen. Selecting a `reject_*`
     option is a refusal, so the receipt's "wasn't allowed to run commands" line and its "Allow from
     now on" appear for a real decline.
   - `permission_answered` is now also recorded with `outcome: not_asked` when a routine's run
     declines at once. Before, it was recorded only when someone was, or could have been, asked.
   - When a turn was carried on, the receipt adds an aside that names the app: "Codex ends
     Gatherer's turn when a request is declined, so LoomWatch asked Gatherer to carry on without
     it". It explains the refusal line next to it, so it is not counted as a finding.

## Consequences

- The digest's Gatherer now finishes its work turn without `curl`. It falls back on its web search,
  which the web switch allows.
- A resumed turn costs one more prompt in the same session. The context is already cached, so it is
  cheap next to the turn it saves.
- Runs archived before this change keep their "Turn ended: cancelled". Their declines now read as
  refusals on the receipt.

## Deliberately not done

- **Allowing the request instead.** Turning `allow.commands` on for Gatherer would let `curl`
  through, and "Allow from now on" on the receipt does exactly that. The decline itself was right.
  What was wrong was what it did to the turn.
- **Detecting Codex by name.** Apps are told apart by what they offer and what they do.
  `codex-acp` may offer `decline` more widely in a later version, and the ranking then uses it.
- **Changing Codex's ask-first mode.** Codex's `agent` mode asks less, but what it does not ask
  about runs without `LoomWatch` deciding. `read-only` stays (ADR 0037, decision 2).
- **Live verification against real Codex.** The fake-harness tests replay run f806a330's frames.
  The daemon on :3000 runs an older build. The next scheduled digest after a rebuild is the live
  check.
