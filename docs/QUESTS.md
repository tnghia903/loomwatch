# Quests and the wardrobe

LoomWatch notices when one of your real runs shows a good practice of building agents and agent
teams, and rewards it with an accessory or a figure. The reward goes into one wardrobe that every
agent in Your agents can wear.

LoomWatch is a tool for configuring agents, not a course on them. A quest says what to try and,
once, one sentence of why it works. It has no lessons, reading lists or links to learn more.

```
Before   a locked item shows a one-line hint             (the Quests page, and an agent's figure)
During   you try it on work you wanted done anyway       (nothing about the run changes)
After    the receipt says what the run did, and why it   (the run receipt, once, on the run
         works in one sentence                             that earned it)
```

## Rules every quest keeps

- **Every quest notices one practice.** A run shows it or it doesn't; the hint says what to try,
  and the receipt says why it works in one sentence.
- **Only facts LoomWatch records decide.** The run's record and evidence, the team file it ran, and
  the team's earlier runs. Never what an agent said about itself, and never a box someone ticks.
- **A run is judged against the settings it ran with.** A Done when, a folder, a key or a bench link
  added after a run never counts for it.
- **Better work, never more runs.** No quest counts runs: running more only spends tokens.
- **What happened, not what was typed.** A filled-in field earns nothing. A run that shows the
  practice does, so the only way to game a quest is to do the practice.
- **Only a run that finished earns.** A run that failed, was stopped, or finished with gaps earns
  nothing, and neither does a one-agent turn or a follow-up that started part-way.

## The quests

| Item | Part | Practice | Earned when |
|---|---|---|---|
| Tailor’s chalk | Prompt | Clear success criteria | A check step’s first look at an agent’s work gives a verdict on every item of its Done when, every one is Met, and no check sends the work back. What the agent says about its own work never counts. |
| Tailor’s tape | Context | Scoped context | An agent is given at least one folder, and reads from every folder it was given. |
| Safety-pin clip | Harness | Least privilege | A scheduled run never asks for a permission, and every key its agents hold (web, files, commands) was used. |
| Wrist pincushion | Harness | Test before you ship | A team runs an agent from Your agents that had a test bench run that finished before it. |
| Shuttle | Team shape | Orchestrator and workers | One agent asks another over the Team Bus and gets an answer. |
| Button monocle | Checking | Evaluator–optimizer loop | A check step sends work back, and the second pass meets every item it checks. |
| Sewn-on patch | Checking | Learn from failures | Something that went wrong in two or more of the team’s last five runs (a permission asked for, an agent failing, a teammate left idle, a stage asking for more) doesn’t happen in this run. |
| Scissors (a figure) | Team shape | Start simple | The team runs with fewer agents than its last finished run, and uses fewer tokens. |
| Bobbin (a figure) | All five | The whole craft | The wardrobe holds an item from each of the five parts. |

## Where you see them

- **The Quests page** (`/quests`, `ui/src/components/quests/QuestsPage.tsx`) is how you find out
  that runs earn anything at all. It lists every accessory and figure: what you have, when you
  earned it and the run that did, and for each one still locked, what to try and how a run earns
  it. Bobbin shows which of the five parts the wardrobe already holds. A **Quests** pill with the
  count (`QuestsLink`) sits in the top bar of Home and Your agents, and ⌘K has **Quests…**.
- **An agent's figure** (`FigurePicker`) sits beside its ID card in Your agents, not on the
  workbench: the bench is how the agent works, the figure only how it looks. It has three parts
  side by side: **Shape** (the earned figures are locked silhouettes until earned), **Color**, and
  **Accessories**, which lists all seven, earned ones to wear and locked ones with their hint.
- **The receipt** of the run that earned an item, once, with one sentence of why.

## How it works

- **Rules** (`ui/src/lib/quests/rules.ts`) are pure functions over a finished run: its record and
  projection, the agents of the team file it ran, the team's whole-team runs before it (the same
  reduction the checkup's run lessons use), and which saved agents had a test bench run before it.
- **Judging** (`ui/src/components/run/useRunQuests.ts`) happens when a run's receipt is shown and
  its record is complete. A run looked at again later is judged the same way, against the runs
  before it, so runs from before the wardrobe existed can earn their items when their receipts
  are opened.
- **The team file a run ran.** The daemon keeps the revision (the `sha256:` digest) of the team file
  bytes each run executed, as the run record's `teamRevision`. A run is judged only while the team
  file on disk still has that revision, with the agents read from it, never from the editor's
  copy. Once the file has changed, the run is not judged again, and neither is a run recorded
  before the daemon kept the revision. What it earned before stays earned.
- **The wardrobe** is kept by the daemon in `wardrobe.json` in its state folder: what you earned
  belongs to you on this computer, not to a team file you might share. Each item is earned once.
  The first run to earn it keeps it, so that run's receipt is the one that says so.
- **Wearing** is part of a saved agent's figure (`figure.wear` in `.jobs/<agent>.yaml`). Like the
  figure itself, it never makes a new version, and a team never copies it.
- **The accessories are worn, not stuck on.** Each is a 3D object fitted to the figure by casting
  rays onto its body (`accessoryMeshes.ts`): the tailor's tape lies over the shoulders and down the
  chest, the button monocle sits on the eye and is tied to the scarf with plum thread, the chalk is
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

1. Add it to `QUESTS` in `ui/src/lib/quests/catalog.ts`: the practice, a one-line hint, one
   sentence of why it works, and what a run has to show. No links.
2. Write its rule in `rules.ts` from recorded facts only, with a test that fails without it.
3. Add its item to `ACCESSORIES` or `FIGURE_ITEMS` in `crates/loomwatch-backend/src/wardrobe.rs`.
   For an accessory, build it in `accessoryMeshes.ts` and render its layers and icons with
   `scripts/figures` (its README); for a figure, model its head there.
