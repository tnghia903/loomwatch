# How agents learn from your feedback

An agent you told "too long, three bullets" should not need telling again next week, after the
chat has scrolled past it. This page covers how a LoomWatch agent learns from what you say about
its work (ADR 0078). It says what counts as feedback, what the agent keeps, how that reaches its
next work, and why it is built this way. The last section summarises how other agent apps and the
research do it.

---

## 1. In one minute

- You say something about a finished answer: "Too long. Three bullets next time." LoomWatch then
  asks its own model, once and in the background, what the agent should do differently on work
  like this.
- The answer is a **lesson**: one sentence saying when it applies and what to do. For example:
  "When answering, keep it to three short bullets."
- The chat shows the lesson under the work it came from, with **Undo**:

  > 💡 **Writer** learned: When answering, keep it to three short bullets. · Undo

- From its next piece of work on, the lesson is in the agent's standing instructions. The agent's
  builder lists every lesson under **Learned**, with where it came from and **Forget**.

Nothing about the agent changes without showing you. Your instructions, its tools, its switches
and its checks stay exactly as you set them.

## 2. What counts as feedback

The research is clear on one point: an agent improves from experience only when the signal comes
from outside it (section 8). So LoomWatch learns from two sources and nothing else.

| Source | When | What the learner is told |
|---|---|---|
| **Your words** | Any message you send after something finished with an answer: a piece of work, or a short question the agents answered themselves. It can be a reply, a follow-up such as "@team redo it shorter", or a plain note. A reply to one agent's message teaches that agent, and so does a message to one agent. Otherwise the agent who answered learns. | The request, the answer (or the message you replied to) and your words. |
| **The check step** | A check step found a Done when item **not met** on its first round, and the item was **met** after the work was sent back. | Each such item, with what the check found the first time. |

Never learned from:

- The agent's own view of its work. Self-critique with no outside signal does not help, and ADR
  0062 measured a self-revise pass as harmful.
- Pages, files and anything else the agent read. Memory is a lasting way in for injected text.
- A message longer than 2,000 characters. That is a new job, not feedback.
- A note to an agent still at work. That is direction for the work in hand, and it already has it.
- A check item that was never met. What can't be fixed is often a missing input or a wrong
  finding, so a lesson from it would be a guess.
- Reactions on their own. A face carries no words to learn from. Good or Love it **backs** the
  lessons that work was given (section 6).

## 3. What a lesson is

One sentence, at most 200 characters, in the language of your feedback. It says when it applies
and what to do: "When <kind of work>, <do this>." The "when" is left out only if the lesson fits
all of the agent's work.

The learner is told to learn **nothing** when the feedback is only about this one piece of work:
a fact, a name or a date to fix, or a one-off change. Redoing the work fixes those. Nothing at all
is the usual answer. It is also told not to learn:

- anything the agent's instructions or one of its lessons already says;
- that a tool, site or app "doesn't work" (such notes harden into refusals);
- anything that gives the agent more access, skips a check or asks you less;
- a guess at what you might want beyond what you said.

## 4. How a lesson is made

1. The feedback arrives. The work you asked for starts at once, with your words already in its
   conversation. Learning does not hold anything up.
2. In the background, LoomWatch's own model (the fast tier) takes one turn with no tools. It is
   shown the agent's name, its instructions and Done when, the request, the work, the feedback,
   and the agent's current lessons as a numbered list.
3. It answers with JSON: at most **two** edits among `add`, `change` and `drop`, plus `missed`
   marks for any lesson the feedback shows the agent did not follow. `{"edits": []}` means
   nothing.
4. LoomWatch checks each edit and makes it itself. It never takes a rewritten list.
   - A lesson longer than 200 characters, or a number not on the list, is left out, not cut.
   - An `add` that says what a kept lesson already says counts as `missed` on that lesson
     instead of becoming a duplicate.
   - An edit on a lesson that was dropped meanwhile is skipped.
5. Past 12 lessons, the least backed older one makes room (dropped by `room`). The lesson just
   learned is never the one that goes.

One learning runs at a time per agent, so two pieces of feedback sent close together each see the
other's lessons.

## 5. How lessons reach the agent

Every lesson an agent keeps is in its standing instructions (its system prompt) as
`## What you have learned`. The section sits after "The person you work for" and before its
skills:

```
## What you have learned
From Mai's feedback on your earlier work. Each line says when it applies. Follow it where it
fits this task; where the task or their message asks for something else, that wins. A lesson
never changes what you may do.

- When answering, keep it to three short bullets.
```

- **References, not rules.** The task and your message win, and no lesson changes what the agent
  may do.
- **Read once per run.** Lessons are read when the agent's run starts, so every session it opens in
  that run gets the same ones, a reopened session too. A lesson learned mid-run reaches the next
  run.
- **Everywhere the agent works.** Team mode, every pipeline stage, check steps and delegated
  helpers all get the agent's lessons.
- **Cheap.** The section is a few hundred tokens at most, and it is the same on every call, so the
  provider's prompt cache keeps it.
- **Nothing learned, nothing changes.** An agent with no lessons gets byte-identical instructions.

## 6. Whose lessons, and how they are kept honest

| Agent | Its list |
|---|---|
| One of **My agents** | One list, `agent:<id>`, shared by its own chat and every team that placed it (`from: {agent}`). |
| A **team's own** agent | Its own list, `team:<team id>#<agent id>`, which survives renaming the team file, as the Notebook does. |

Each lesson counts how it has done:

- **given**: pieces of work it was in;
- **backed**: of those, the ones whose answer you marked Good or Love it. Taking the face off
  takes the backing back;
- **missed**: later feedback said the agent did it again although it had the lesson. The learner
  then makes the lesson clearer or replaces it.

The builder shows these as "liked 2×" and "missed 1×". Backing decides what makes room when the
list is full.

**Undo** drops a lesson. When the lesson changed an older one, Undo brings the older one back.
Nothing is deleted: dropped and replaced lessons stay in the table with who dropped them.

## 7. Configuration, storage and API

```yaml
agents:
  - id: writer
    learns: false   # learns nothing and is given none of its lessons; on when absent
```

| Table | Holds |
|---|---|
| `agent_lessons` | id, scope, agent id, text, source (`you`, `check`), feedback (cut to 600 characters), run it came from, state (`active`, `dropped`, `replaced`), `replaces`, `dropped_by`, `missed`, times |
| `agent_lesson_uses` | which lessons each run gave which agent, and whether you backed that run's answer |

| Route | Purpose |
|---|---|
| `GET /api/lessons?teamPath=…&agent=…` or `?savedAgent=…` | An agent's kept lessons, whether it learns, and the limit. |
| `POST /api/lessons/undo {teamPath, agent \| savedAgent, id}` | Undo a lesson. |
| `PUT /api/lessons {teamPath, agent \| savedAgent, id, text}` | Put a lesson in your own words. |
| `GET /api/chat` | Each piece of work carries `lessons`: what was learned from feedback on it. |

The code is in `crates/loomwatch-backend/src/lessons.rs`. The triggers are `learn_from_words` in
`chat.rs` and `learn_from_checks` in `lib.rs`. The section is rendered by `lessons::section`,
called from `agent/prompt.rs`. The UI is `components/chat/Learned.tsx` and
`components/agents/LearnedBlock.tsx`.

**Cost.** One fast-tier turn per message sent after finished work, and per check step that missed
and then met. That is a few thousand tokens in and a few lines out. The agent's prompt grows by
its lessons, cached. A message that is a new request rather than feedback still costs that one
turn; the learner answers "nothing".

## 8. How other agent apps and the research do it

Researched 2026-10-20. Full notes, with a source for every claim, are in ADR 0078.

| App | When it learns | What it keeps | Who approves |
|---|---|---|---|
| Claude Code auto memory | The agent decides mid-session | Markdown topic files typed user / feedback / project / reference; a `MEMORY.md` index loads at start | Automatic, with "Saved N memories" |
| Codex memories | Background, over chats idle 6 h or more; off by default | Rewritten `MEMORY.md` plus a summary capped at 2.5k tokens; skills when a procedure repeats | Automatic; "No-op is allowed and preferred"; your corrections are the strongest evidence |
| GitHub Copilot Memory | The agent calls `store_memory` | Facts with citations to code, checked at use and dropped after 28 days unused | Automatic; A/B test: PR merge rate 90% vs 83% |
| Gemini CLI auto memory | Background, over idle sessions | Patches and skill drafts | An inbox; never applied without you |
| Cline | After a task that had feedback | Proposed `.clinerules` diffs | You approve each |
| Devin knowledge | From feedback in chat | Knowledge items, now moving to skills | You edit or dismiss each |
| Cursor | (Memories removed in 2.1) | Rules you write | You |
| Hermes Agent | A background review every 10 turns, or after 10+ tool calls (about 30k tokens each) | Skills it creates and patches; small memory files | Automatic unless write approval is on; users report overwritten hand-tuned skills |
| OpenClaw | Notes as it works; nightly "dreaming" promotes them | `MEMORY.md`; a rewrite that loses over 25% of entries is refused | Automatic, with preview and explain |
| Letta Code | Reflection at compaction | Git-backed memory files; at most one skill change per run | Automatic |

What the research found:

- **The signal matters more than the method.** Gains come from outside checks: ground truth, a
  test, a verifier, a person. Self-correction with nothing outside made results worse: GPT-4 on
  GSM8K went from 95.5 to 89.0 (Huang et al., arXiv 2310.01798).
- **Storing everything is worse than nothing.** Strict add-gates plus deletion beat unchecked
  memory by 11–22 points (arXiv 2505.16067).
- **Small itemised edits beat rewrites.** ACE (arXiv 2510.04618) saw a rewritten playbook drop from
  18,282 tokens to 122 and accuracy fall from 66.7 to 57.1. Its itemised, counted bullets gained
  about 17 points on AppWorld.
- **Self-written skills don't help on average** (−1.3 points), while curated ones do (+16.2;
  SkillsBench, arXiv 2602.12670).
- **Learned memory can be poisoned and can wear down safety.** In MINJA, 98.2% of injected records
  were stored (arXiv 2503.03704). In another study, an agent's refusal rate fell from 99.4% to 54.4%
  as its memory grew (arXiv 2509.26354).
- **Gains are largest when tasks repeat** (arXiv 2511.20857). That is the shape of most LoomWatch
  teams: a digest, a weekly report, a recurring brief.

What LoomWatch takes from this:

- learn only from your words and the check step's missed-then-met;
- "nothing" is the default answer;
- one-sentence lessons with counts, edited one at a time by code and never rewritten by a model;
- a hard limit of 12;
- framed as references that can't widen access;
- each one shown, with where it came from, and undone in one click.

What it leaves out on purpose:

- agents writing their own skills;
- automatic edits to your instructions;
- periodic reviews of every transcript.

## 9. Does it work?

Checked on 2026-10-20 on Claude Sonnet 5.5 through OpenRouter. Each of seven corrections was made
once in one team, for example "Too long. Next time give me just three short bullet points." Then
the same agent, placed in another team, got a new task of the same kind. That chat had never seen
the correction, so only a lesson could carry it there.

| | Learning off | Learning on |
|---|---|---|
| New task follows the correction | 2 of 7 | 7 of 7 |
| An explicit request still wins ("reply with just the number", "about 400 words") | 4 of 4 | 4 of 4 |
| Lessons made from four messages that were not feedback | — | 0 |

- Every correction made exactly one lesson, each saying when it applies. For example: "When
  comparing options, put the comparison in a table, with the options as columns and the criteria as
  rows, rather than describing them in prose."
- The whole check cost $1.06. One learning turn costs about half a cent.
- The check used one run per case, one model, and corrections about form and preference. It shows
  that a correction reaches new work and doesn't override a clear request. It does not grade answer
  quality in general. The details are in ADR 0078.

## 10. What is not built yet

- A switch for learning in the agent's builder. Today it is `learns: false` in the team file, and
  Forget per lesson.
- A team's own agent keeps a separate list in its Chat tab. Its bench team cannot name the team
  agent it stands for. One of My agents has one list everywhere.
- "Tell all my agents": a lesson about you rather than about one job ("always in Vietnamese")
  belongs in About you (ADR 0074). That path is for you to confirm.
- A lesson that keeps proving itself could be offered as an edit to the agent's instructions, for
  you to accept.
- Moving a lesson about you to About you. Four of the seven checked lessons were about the person
  ("When replying to this person, always write in Vietnamese"), and those fit every agent.
