# Quests and the wardrobe

Quests teach how to build good agents and agent teams, using your own runs. Each quest is one
practice from the field. LoomWatch notices it when a real run shows it, and the run's receipt
explains what you just did. The reward is an accessory or a figure, and it goes into one wardrobe
that every agent in Your agents can wear.

```
Before   a locked item shows a one-line hint           (the wardrobe, the Quests list)
During   you try it on work you wanted done anyway     (nothing about the run changes)
After    the receipt names the practice, says why it   (the run receipt, once, on the run
         works, and links to where it comes from         that earned it)
```

## Rules every quest keeps

- **Every quest teaches one practice.** It names the practice and links to its source. A quest
  that teaches nothing is not made, however good its item looks.
- **Only facts LoomWatch records decide.** The run's record and evidence, the team file it ran, and
  the team's earlier runs. Never what an agent said about itself, and never a box someone ticks.
- **Better work, never more runs.** No quest counts runs: running more only spends tokens.
- **What happened, not what was typed.** A filled-in field earns nothing. A run that shows the
  practice does, so the only way to game a quest is to do the practice.
- **Only a run that finished earns.** A run that failed, was stopped, or finished with gaps earns
  nothing, and neither does a one-agent turn or a follow-up that started part-way.

## The quests

| Item | Part | Practice | Earned when | Source |
|---|---|---|---|---|
| Tailor’s chalk | Prompt | Clear success criteria | An agent with a Done when replies with nothing under “Not met”, and no check step had to send its work back. | [Claude docs: Define your success criteria](https://platform.claude.com/docs/en/test-and-evaluate/define-success) |
| Tailor’s tape | Context | Scoped context | An agent is given at least one folder, and reads from every folder it was given. | [Anthropic: Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) |
| Safety-pin clip | Harness | Least privilege | A scheduled run never asks for a permission, and every key its agents hold (web, files, commands) was used. | [OWASP Top 10 for LLM apps: Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/) |
| Wrist pincushion | Harness | Test before you ship | A team runs an agent from Your agents that had a test bench run that finished before it. | [Anthropic: Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) |
| Shuttle | Team shape | Orchestrator and workers | One agent asks another over the Team Bus and gets an answer. | [Anthropic: Building effective agents](https://www.anthropic.com/research/building-effective-agents) |
| Button monocle | Checking | Evaluator–optimizer loop | A check step sends work back, and the second pass meets every item it checks. | [Anthropic: Building effective agents](https://www.anthropic.com/research/building-effective-agents) |
| Sewn-on patch | Checking | Learn from failures | Something that went wrong in two or more of the team’s last five runs (a permission asked for, an agent failing, a teammate left idle, a stage asking for more) doesn’t happen in this run. | [Anthropic: Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) |
| Scissors (a figure) | Team shape | Start simple | The team runs with fewer agents than its last finished run, and uses fewer tokens. | [Anthropic: Building effective agents](https://www.anthropic.com/research/building-effective-agents) |
| Bobbin (a figure) | All five | The whole craft | The wardrobe holds an item from each of the five parts. | — |

The summaries in the app are LoomWatch’s own words, not quotes from the sources.

## How it works

- **Rules** (`ui/src/lib/quests/rules.ts`) are pure functions over a finished run: its record and
  projection, the team file's agents, the team's whole-team runs before it (the same reduction the
  checkup's run lessons use), and which saved agents had a test bench run before it.
- **Judging** (`ui/src/components/run/useRunQuests.ts`) happens when a run's receipt is shown and
  its record is complete. A run looked at again later is judged the same way, against the runs
  before it, so runs from before the wardrobe existed can earn their items when their receipts
  are opened.
- **The wardrobe** is kept by the daemon in `wardrobe.json` in its state folder: what you earned
  belongs to you on this computer, not to a team file you might share. Each item is earned once.
  The first run to earn it keeps it, so that run's receipt is the one that says so.
- **Wearing** is part of a saved agent's figure (`figure.wear` in `.jobs/<agent>.yaml`). Like the
  figure itself, it never makes a new version, and a team never copies it.
- **The accessories are worn, not stuck on.** Each is a 3D object fitted to the figure by casting
  rays onto its body (`accessoryMeshes.ts`): the tailor's tape lies over the shoulders and down the
  chest, the button monocle sits on the eye and is tied to the scarf with red thread, the chalk is
  tucked behind an ear and has drawn a cut line on the tummy, the patch is sewn onto the tummy's
  curve, a safety pin fastens the scarf, the pincushion is strapped round a wrist, and a shuttle is
  pushed through the top of the head as needles are stuck in a ball of yarn. The 3D bench wears
  them. The pictures stack one layer per accessory over the still (`ui/public/agent/wear`),
  rendered from the same objects with the figure hiding what is behind it and catching its
  shadow, so pictures and bench agree. Only the face-high ones show in the chat avatar.
- **The earned figures** are heads in `ui/public/agent/workbench.glb` (`head_scissors`,
  `head_bobbin`) with stills in `ui/public/agent/figures/`. An agent nobody dressed is only ever
  given one of the six starter figures, so it keeps the figure it had.

| Route | What it does |
|---|---|
| `GET /api/wardrobe` | What has been earned: `{ earned: { <item>: { at, runId, teamPath?, agentId? } } }`. |
| `POST /api/wardrobe/earned` | `{ item, runId, teamPath?, agentId? }`. `201` with the entry when it is new, `200` with the entry already held when a run earned it before. |

Both answer only this computer and this app's own pages, like the run evidence they are earned from.

## Adding a quest

1. Add it to `QUESTS` in `ui/src/lib/quests/catalog.ts`: the practice, a hint, why it works, what a
   run has to show, and a source you have read.
2. Write its rule in `rules.ts` from recorded facts only, with a test that fails without it.
3. Add its item to `ACCESSORIES` or `FIGURE_ITEMS` in `crates/loomwatch-backend/src/wardrobe.rs`.
   For an accessory, build it in `accessoryMeshes.ts` and render its layers and icons with
   `scripts/figures` (its README); for a figure, model its head there.
