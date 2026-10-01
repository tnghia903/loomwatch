# 0030 — Jobs: well-defined built-ins, and jobs operators save themselves

- **Date:** 2026-10-01
- **Status:** Accepted.
  - Daemon: `crates/loomwatch-backend/src/jobs.rs`, plus `GET /api/jobs` and
    `PUT|DELETE /api/jobs/{id}` in `api.rs`.
  - UI:
    - `ui/src/lib/library/{roles,jobs,types,createAgent}.ts`
    - `ui/src/components/library/ComponentPalette.tsx`
    - `ui/src/components/canvas/{SaveAsJob,BuildInspector}.tsx`
    - `ui/src/lib/story/intent.ts`, plus the ⌘K `add` case in `ui/src/components/Workspace.tsx`
    - `ui/src/lib/team-file/templates.ts`
    - `ui/src/styles/loom.css`
- **Builds on:** ADR 0023 ("Hire by job"). Skills a job carries reach every app through ADR 0031.

## Context

ADR 0023 put seven jobs at the top of the Build palette: Researcher, Writer, Editor, Reviewer, Coder,
Designer and Analyst. A Claude Code session wrote them on 2026-10-01 as a first draft that no one had
reviewed. Each job had one or two sentences of instructions, and they had three problems:

- **Output was undefined.** In a pipeline the next agent receives a reply verbatim under "Results
  from preceding stages" (`lib.rs::compose_prompt`). A Researcher that hands back unstructured prose
  makes the Writer guess where the facts are.
- **They assumed a position in the team.** "Edit what you were handed" has no meaning when the
  Editor is the first agent.
- **They disagreed with the starter templates.** The New team dialog wrote its own, shorter
  Researcher and Writer instructions. A team built from a template and one built by hand got
  different agents under the same name.

Worse, the list was fixed in code. An operator who refined an agent until it worked had no way to
reuse it. They had to copy its YAML block into another team file by hand.

## Decisions

1. **Every built-in job follows one shape.** Each one says three things:
   - **Who the agent is, and what it does not do.** A Researcher does not write the final piece; a
     Reviewer does not rewrite.
   - **How to work.** Concrete rules, such as "open every source before you cite it" and "run the
     project's tests".
   - **What to hand back**, usually a fixed set of Markdown headings, because the next agent reads
     that reply verbatim.

   Each job also says what to do when it is the first step and nothing was handed to it. The
   Researcher says how to proceed when it cannot browse the web. The palette's one-line `does` stays
   at six words or fewer. `jobs.test.ts` holds the shape as a test.

2. **One source for the Researcher and the Writer.** `templates.ts` takes their instructions from
   `ROLE_PRESETS` at call time. It is not read at module load because `roles.ts` imports
   `templates.ts`, and that cycle would read an uninitialised binding. "One assistant" and the review
   stop keep their own text, because neither is a palette job.

3. **Operators save their own jobs from an agent that worked.** "Save as job" in the agent panel
   keeps:
   - the instructions;
   - the app the agent runs on, as the job's first preferred app;
   - the model, but only together with that app, because a model id belongs to one app;
   - the agent's skills;
   - a short "what it does" line, if the operator gives one;
   - an icon guessed from the name.

   It starts from a working agent rather than an empty form, because instructions are refined on the
   canvas after a run shows what was wrong. Saving does not change the team, so it also works while
   the team is read-only.

4. **A job is a file in the teams folder: `<teams root>/.jobs/<id>.yaml`.**
   - **Why there:** it travels with a teams folder that is copied or kept in git, and sharing a job
     means sending one file.
   - **Why hidden:** `GET /api/teams` and the scheduler skip hidden folders, so a job is never listed
     as a team.
   - **Id:** the file name is the job's id, a slug of its name. A team file calls the instructions
     `role`, so the job file also accepts `role` for `instructions`. An agent block copied out of a
     team file is then nearly a job already.
   - **Validation:** unknown keys are refused (`deny_unknown_fields`), so a typo is reported instead
     of being dropped. A file that fails to parse or validate is listed under `problems` with the
     reason. The palette shows it as "Can’t read …" and does not silently omit it.
   - **Links:** links are never followed, whether the `.jobs` folder or a job file.
   - **Writes:** writes are atomic and take the same lock as team writes.

5. **Saving never overwrites silently.** The UI saves with `If-None-Match: *`. A taken name answers
   412, and the panel asks "Replace it?". Plain `PUT` replaces, and editing a job means saving it
   again under the same name. Removing a job takes a second click and moves its file to
   `.jobs/.removed/<time>-<id>.yaml`. Nothing is erased.

6. **A job is a starting point, never a link.** Placing a job copies its fields into the team file.
   Editing or removing the job later changes no team. Placement follows ADR 0023:
   - The job runs on its preferred app if that app is installed; otherwise on the best app the
     computer has.
   - A saved model is applied only on the job's own app.
   - Skills come along, and ADR 0031 delivers them to whichever app the agent runs on.

7. **Your jobs lead the palette once there are any.** Someone who saved a job comes back for it more
   often than for a built-in one. Before any is saved, a one-line hint under "Hire by job" says how
   to save one. The ⌘K command bar adds a saved job by its full name ("add a release notes
   writer"). A saved job named like a built-in one ("Writer") is placed in its stead.

## Consequences

- `LibrarySource` gains `capabilities`, and `buildAgentFromSource` copies it into the new agent. Any
  library row can now bring skills with it.
- A daemon started before this change answers 404 on `/api/jobs`. The palette then shows only
  built-in jobs, and "Save as job" tells the operator to restart the server.
- Not built:
  - Editing a saved job's fields in place (place it, change it, save it under the same name instead).
  - Hiding or reordering built-in jobs.
  - Jobs that carry knowledge sources or tools (ADR 0029 delivers those to agents; jobs keep skills
    only for now).
