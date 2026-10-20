# How agents learn from your feedback

An agent you told "too long, three bullets" should not need telling again next week, after the
chat has scrolled past it. This page covers how a LoomWatch agent learns from what you say about
its work (ADR 0078). It says what counts as feedback, what the agent keeps, how that reaches its
next work, and why it is built this way. Section 9 summarises how other agent apps and the
research do it.

---

## 1. In one minute

- You say something about a finished answer: "Too long. Three bullets next time." LoomWatch then
  asks its own model, once and in the background, what the agent should do differently on work
  like this. It reads what the agent was asked, what it answered, how it went about it (the steps
  from the run's record), and your words.
- You mark an answer **Love it**. The same model is asked what made that answer right, so the
  agent keeps doing it.
- The answer is a **lesson**: one sentence saying when it applies and what to do. For example:
  "When answering, keep it to three short bullets."
- The chat shows the lesson under the work it came from, with **Undo**:

  > 💡 **Writer** learned: When answering, keep it to three short bullets. · Undo

- From its next piece of work on, the lesson is in the agent's standing instructions. The agent's
  builder lists every lesson under **Learned**, with where it came from and **Forget**.
- A lesson about you rather than one job, such as "always write in Vietnamese", also offers
  **Tell all my agents**. Once you say yes, it moves to About you, and every agent follows it
  (section 6).

Nothing about the agent changes without showing you. Your instructions, its tools, its switches
and its checks stay exactly as you set them.

## 2. What counts as feedback

The research is clear on one point: an agent improves from experience only when the signal comes
from outside it (section 9). So LoomWatch learns from these and nothing else. Each is about the
agent's own work: what it was asked, what it answered, and how it went about it.

| Source | When | What the learner is told |
|---|---|---|
| **Your words** | Any message you send after something finished with an answer: a piece of work, or a short question the agents answered themselves. It can be a reply, a follow-up such as "@team redo it shorter", or a plain note. A reply to one agent's message teaches that agent, and so does a message to one agent. Otherwise the agent who answered learns. | The request, the answer (or the message you replied to) and your words. |
| **Your words at a review stop** | Send back with a reason, or Approve with words. The stage whose work the stop reviewed learns. An answer to an agent's question teaches nothing. | The request, the work the stop reviewed, and your words. |
| **Love it** | You put Love it on an answer, or on an agent's own answer to a note. It counts once per answer; Good only backs lessons (section 7). | The request and the answer, and that you loved it. |
| **The check step** | A check step found a Done when item **not met** on its first round, and the item was **met** after the work was sent back. | Each such item, with what the check found the first time. |

With each of these, the learner also reads **how the agent went about the work**, from the run's
record. It sees each tool the agent used, how the call ended (a failure with its first line), and
each permission you refused it. So "those prices are from a blog" can become a how-to, such as
"When looking up prices, read the official sites first", not only a rule about the answer. What a
tool gave back is left out, so a page's words never reach the learner this way.

Never learned from:

- The agent's own view of its work. Self-critique with no outside signal does not help, and ADR
  0062 measured a self-revise pass as harmful.
- Pages, files and anything else the agent read. Memory is a lasting way in for injected text.
- A message longer than 2,000 characters. That is a new job, not feedback.
- A note to an agent still at work. That is direction for the work in hand, and it already has it.
- A check item that was never met. What can't be fixed is often a missing input or a wrong
  finding, so a lesson from it would be a guess.
- A face other than Love it. Good **backs** the lessons that work was given (section 7), and the
  others carry no words to learn from.

## 3. What a lesson is

One sentence, at most 200 characters, in the language of your feedback. It says when it applies
and what to do: "When <kind of work>, <do this>." The "when" is left out only if the lesson fits
all of the agent's work. A lesson can be about the answer ("use a table") or about how to get there
("read the official price list first", "check each source's date before citing it").

After **Love it**, the learner is asked for the one particular choice that made the answer right:
its shape, length or order, what it put in or left out, where it looked. It doesn't name a
general virtue such as "clear" or "helpful". Love it means keep to it, so a shape the request
asked for counts too, for work of that kind. It makes at most one lesson and never changes or
drops another, and it often says nothing: an answer can simply be done well.

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
   shown:
   - the agent's name, its instructions and Done when;
   - the request and the work;
   - how the agent went about it: at most 30 steps from the run's record, the first and the last
     kept;
   - the feedback;
   - the agent's current lessons, as a numbered list.
3. It answers with JSON: at most **two** edits among `add`, `change` and `drop`, plus `missed`
   marks for any lesson the feedback shows the agent did not follow. `{"edits": []}` means
   nothing. An `add` or `change` may say `"aboutYou": true` when the lesson is about you, not the
   work (section 6).
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

## 6. Lessons about you: Tell all my agents

Some feedback is about you, not about one kind of work. In the live check (section 10), four of
the seven lessons were like that, for example "When replying to this person, always write in
Vietnamese." Such a lesson fits every agent you have, so it belongs in About you (ADR 0074), which
every agent reads, rather than in one agent's list.

- **The learner marks it.** It adds `"aboutYou": true` to an `add` or `change` when it is
  something you want from every agent, whatever the job. That is when it follows from who you are
  (the language you read, where you live, the units and money you use), or when you asked for it on
  everything ("always", "never", "every reply"), as with the tone you like. A lesson that fits one
  kind of work stays about the work, even when you said "next time". Only `true` counts; any other
  value leaves the lesson about the work, and the rest of the reply still counts. A lesson changed
  later, by the learner or in your own words, stays about you.
- **The chat and the builder offer one action.** The lesson's line gets **Tell all my agents**.
  Pressing it only asks: "Add to About you, so every agent does this?" with **Add** and
  **Cancel**.
- **Add moves it.** The sentence goes on its own line at the end of About you, with your name and
  everything else kept. If a line of About you already says it, nothing is added. The lesson then
  leaves the agent's list (dropped by `about_you`). The chat line now reads:

  > 💡 **All your agents** know: When replying to this person, always write in Vietnamese. · Undo

  In the builder, the lesson leaves the Learned list, and a line under it says the same, with
  Undo.
- **Undo puts both back.** The lesson returns to the agent's list, and the line it added comes out
  of About you. A line About you already had, or one you changed or took out since, is left as it
  is. If the agent's list is full, the least backed other lesson makes room, as when a lesson is
  learned.
- **Only your click writes About you.** Learning only marks a lesson. About you changes only
  through the two routes behind **Add** and **Undo**, and like the About you page's own Save, they
  accept a request only from LoomWatch's own page. If About you has no room (1,000 characters),
  nothing changes and the chat says so.

## 7. Whose lessons, and how they are kept honest

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
On a lesson moved to About you, Undo moves it back (section 6). Nothing is deleted: dropped and
replaced lessons stay in the table with who dropped them.

## 8. Configuration, storage and API

```yaml
agents:
  - id: writer
    learns: false   # learns nothing and is given none of its lessons; on when absent
```

| Table | Holds |
|---|---|
| `agent_lessons` | id, scope, agent id, text, source (`you`, `check`), `about_you` (the learner found it is about you), feedback (cut to 600 characters), run it came from, state (`active`, `dropped`, `replaced`), `replaces`, `dropped_by` (`you`, `learning`, `room`, `about_you`), `added_to_about_you` (its sentence went into About you, so Undo takes it out), `missed`, times |
| `agent_lesson_uses` | which lessons each run gave which agent, and whether you backed that run's answer |

| Route | Purpose |
|---|---|
| `GET /api/lessons?teamPath=…&agent=…` or `?savedAgent=…` | An agent's kept lessons, whether it learns, and the limit. |
| `POST /api/lessons/undo {teamPath, agent \| savedAgent, id}` | Undo a lesson. |
| `PUT /api/lessons {teamPath, agent \| savedAgent, id, text}` | Put a lesson in your own words. |
| `POST /api/lessons/tell-all {teamPath, agent \| savedAgent, id}` | Tell all my agents: move a lesson about you to About you. Only from LoomWatch's own page (`X-LoomWatch-Request: 1`). |
| `POST /api/lessons/tell-all/undo {teamPath, agent \| savedAgent, id}` | Undo it: the lesson back with its agent, its line out of About you. Same rule. |
| `GET /api/chat` | Each piece of work carries `lessons`: what was learned from feedback on it, and kept or moved to About you. |

The code is in `crates/loomwatch-backend/src/lessons.rs`. The triggers are `learn_from_words` in
`chat.rs` and `learn_from_checks` in `lib.rs`. The section is rendered by `lessons::section`,
called from `agent/prompt.rs`. Tell all my agents is `Lessons::tell_all` and `Lessons::untell`,
writing About you through `You::change` in `you.rs`. The UI is `components/chat/Learned.tsx`,
`components/agents/LearnedBlock.tsx` and `components/you/TellAllAsk.tsx`.

**Cost.** One fast-tier turn per message sent after finished work, and per check step that missed
and then met. That is a few thousand tokens in and a few lines out. The agent's prompt grows by
its lessons, cached. A message that is a new request rather than feedback still costs that one
turn; the learner answers "nothing".

## 9. How other agent apps and the research do it

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

## 10. Does it work?

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

A smaller check of the later additions, the same way:

- **Love it carried over.** The loved answer opened with a "TL;DR:" line and three bullets. A new
  summary in another team then did the same with learning on, but opened with "Summary:" with it
  off. A poem stayed a poem in both. The first try failed because the learner skipped what the
  request had asked for; Love it now counts that too (section 3).
- **Learning from the steps is built and tested, but not shown to help yet.** In three live
  cases (a draft price list beside an approved one, a later price change in "team updates", and a
  newer file in `drafts/` beside `final/`), Sonnet 5.5 read every file and gave the right price
  even with learning off. With no mistake there was no feedback, so there was nothing to learn.
  Expect it to matter on harder, repeated work and on smaller models; it costs nothing when there
  is no feedback.

**Lessons about you.** The same seven corrections and four messages that were not feedback went
through the learner alone, three times each. Four corrections were about you: Vietnamese, metric
and VND, "Always end with a line that starts with 'Next step:'", and no emojis.

| | First wording | Today's wording |
|---|---|---|
| Lessons about you marked | 7 of 12 | 9 of 12 |
| Lessons about the work marked by mistake | 0 of 9 | 0 of 9 |
| Lessons made from messages that were not feedback | 0 of 12 | 0 of 12 |

- The first wording gave only the language and the units as examples, and never marked "Next
  step:". Today's wording marks it every time.
- "No emojis" is still left to the work: it came on a book club welcome, without "always", and the
  learner keeps it to messages for a group. Tell all my agents is then not offered for it.
- The two checks cost $0.16 together.

## 11. What is not built yet

- A switch for learning in the agent's builder. Today it is `learns: false` in the team file, and
  Forget per lesson.
- A team's own agent keeps a separate list in its Chat tab. Its bench team cannot name the team
  agent it stands for. One of My agents has one list everywhere.
- A lesson that keeps proving itself could be offered as an edit to the agent's instructions, for
  you to accept.
- The learner can still leave a lesson about you to the work, when you said it once about one
  piece of work (section 10). It also sometimes writes a lesson about your language in that
  language, rather than in the language of your feedback.
- The learner is not shown About you, so it can learn what About you already says. Tell all my
  agents then adds nothing, and the lesson still leaves the agent's list.
