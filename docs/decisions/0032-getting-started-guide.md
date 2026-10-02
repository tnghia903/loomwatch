# 0032 — A getting-started guide that waits for the operator to act

- **Date:** 2026-10-02
- **Status:** Accepted. UI: `ui/src/lib/tour/{steps,store,place}.ts`,
  `ui/src/components/tour/GettingStarted.tsx`, `ui/src/styles/tour.css`, mounted in `ui/src/App.tsx`.
  The screens it points at carry `data-tour` names (Home, New team dialog, Build heading, palette,
  workspace, Run view stages and output, composer, needs-you tray). Reopened from the workspace menu,
  ⌘K ("Getting started guide") and Home's "New here? Take the 3-minute guide".

## Context

Home says what LoomWatch is for in three words (Build, Ask, Review), and a template gets a newcomer
to a runnable team in one dialog (ADR 0022). Nothing then says where to type the request, what the
stages mean while a run works, where the answer appears, or that a paused team shows up in the
needs-you tray. Those were the questions a first-time user had to answer by exploring.

## Decision

A guide of one small card at a time, each pointing at the part of the screen it explains:

| # | Step | Moves on when |
|---|---|---|
| – | Welcome | Start the guide |
| 1 | Your AI apps (Home footer) | Next |
| 2 | Create your first team (New team) | the New team dialog opens |
| 3 | Name it and pick a start (beside the dialog) | a team opens; back to 2 if the dialog closes |
| 4 | This is your team (first agent card or Run stage); "Add your first agent" for an empty team | Next |
| 5 | Open the Run view (Run team) | the Run view's stages are on screen |
| 6 | Ask in plain words (request box, with a one-click example) | a run **new since this step began** starts |
| 7 | Watch it work (stages) | Next |
| 8 | Read the result (team output) | Next |
| 9 | When a team needs you (needs-you tray) | Next |
| 10 | Change the team any time (Run / Build) | Next |
| – | You're all set | Finish |

- **The operator does the real thing.** Action steps have no Next button, only "Waiting for you"
  and "Skip this step"; the guide reads the page to see the action happen. The example request is
  put in the box (`loomwatch:compose`), never sent: pressing Enter stays the operator's.
- **It never blocks the page.** The layer takes no clicks except on the card. An explaining step dims
  the rest of the screen; an action step only rings its target, so the page stays readable while the
  operator acts. The card takes focus only on the welcome and closing cards.
- **It reads the page, it is not told.** Steps name targets by `data-tour`, never by styling class,
  so a restyle cannot detach the guide silently. The workspace publishes its agent count
  (`data-tour-agents`), so a canvas still drawing is not mistaken for an empty team.
- **Progress survives the reload a new team causes** (`localStorage`, key `loomwatch:tour`). A Home
  step shown inside a team skips ahead to step 4; a team step shown on Home becomes "Pick up where
  you left off" in the corner. If storage refuses writes, the guide still works for that page.
- **Offered once, to someone who has never run a team.** The teams folder cannot tell: `./loomwatch`
  creates it with the offline demo team in it. `GET /api/runs` (reloaded from Postgres at startup)
  can. If runs cannot be read, an empty teams folder is the fallback signal. Closing or finishing the
  guide is remembered; it is never offered again on its own.

## Consequences

- A newcomer's first run uses a real AI app and a real (small) request, on their own subscription.
  The offline demo team remains the way to try a review stop without one (README, "Try your first run").
- A step whose target is off screen scrolls it into view once, instantly: a smooth scroll does not
  advance in a tab that is not painting, which left the card pointing below the fold.
- Renaming a `data-tour` value breaks the step that uses it; `GettingStarted.test.tsx` drives each
  step against a stand-in page, so the names are part of a tested contract.
- Without a database, run history is empty after every daemon restart, so a returning user who never
  closed the guide would be offered it once more.
