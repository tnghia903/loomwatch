# Prototype Instructions

## User-selected direction

- Use option 3 at `../04-concept-delivery-lane.png` as the visual target.
- Keep equally prominent Run and Build views and a fixed output pane.
- Show skills and tools as a graph with explicit relationship labels and visible missing required skills. Keep handoff arrows separate from capability associations.
- Skill source and execution harness are independent: a Claude Code skill can attach to Codex.
- Build is a free-form wiring canvas. Harnesses, skills, tools, and knowledge sources can be dragged from a component library, moved freely, and connected with explicit relationship labels.
- Keep the Build canvas visually focused. Represent the deliverable as an output node in Build; keep the fixed output reading pane in Run.
- This prototype uses labeled example data. Do not imply that it scanned local skills, started real agents, or verified real skill use.

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.
