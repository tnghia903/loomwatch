# LoomWatch Delivery Lane implementation QA

final result: passed

## Evidence and scope

Source: `../docs/design-explorations/2026-09-14-result-led-workspace/04-concept-delivery-lane.png`.
Rendered application: `http://127.0.0.1:4174/?path=loomwatch-market-research.yaml&run=b530dd10-48ca-437f-bd6f-0530a496c8e7`.

The source is a generated example report with a loaded skill. Production captures use the real archived Run 15, whose saved responder is Research and whose old skill capture cannot verify the aliased instruction version. The report, status text, and evidence consequently differ. Comparison evaluates the implemented Delivery Lane hierarchy and interactions rather than claiming identical report content or historical verification.

All following images are under `../docs/design-explorations/2026-09-14-result-led-workspace/implementation-qa/`:

- `01-run-desktop.png`: final Run reader, 1487 × 1058 pixels and CSS viewport, Designer selected, skill filter, dark theme.
- `06-source-comparison.png`: actual source and final render together, 2974 × 1088 including a 30-pixel label strip; no density rescaling.
- `07-capability-comparison.png`: focused capability-region comparison, 1795 × 438; viewed together after the final changes.
- `02-run-mobile.png`, `03-mobile-capabilities.png`: 390 × 844 phone output and capability list. Captured during the draft-connection check; those temporary edits were then discarded.
- `04-run-light.png`: light appearance.
- `05-skill-receipt.png`: failed-read evidence and the report together.
- `08-connect-skill.png`: direct agent skill picker, discovery source and receiving harness visible.
- `09-next-run.png`: no-execution preview and configured stage order.
- `10-whole-team-graph.png`: grouped capability graph with separate owners.

## Findings resolved

- P1: the result shared a canvas with execution topology and appeared as a tiny warning card. Run now has a persistent Markdown reader. Explicit final-answer metadata removes commentary from the canonical response presentation while the trace retains all chunks. Exact turn matching protects the saved result from later helper-question replies.
- P1: a connected skill looked equivalent to a skill used by an agent. Preparation and post-send receipts are now separate; the UI exposes exact source, receiving harness, instruction path/fingerprint, failures, and unverifiable old captures.
- P2: the composer overlapped the workspace hierarchy. Desktop controls now dock beneath the output, with the request on its own row; the measured height keeps report content reachable.
- P2: capability status text was too small and subdued. Increased leaf labels, loading evidence text, state labels, and output body sizes. Final combined and focused screenshots were inspected after this adjustment.
- P2: next-run stages followed file order instead of pipeline order. Preview uses configured pipeline steps; branching teams do not receive invented sequential arrows.
- P2: capability receipts and output expansion could unwind the entire Run view on Escape. Local keyboard handling now closes the disclosure first and returns focus.
- P1: disconnecting the final skill wrote YAML null and invalidated the team. Optional agent fields are now removed; a new regression and browser connect/disconnect check pass.

No remaining P0/P1/P2 findings in the implemented Run/Build and skill-delivery scope.

## Fidelity surfaces

- Typography: existing app sans-serif UI, 16px Markdown body, serif document headings, enlarged proof/status labels, and explicit role truncation. The generated example has richer document headings because its content differs.
- Layout/rhythm: 60/40 desktop split with stable output, a compact stage strip, separate capability relationships, and the existing composer. The result comes first on phones. Desktop and phone screenshots show persistent controls without horizontal page overflow.
- Colors/tokens: existing theme tokens provide dark and light views. Gold identifies selection/actions; green identifies observable success; failure and uncertainty stay distinct. Token colors deliberately follow the production app rather than the generated image's lighting.
- Assets: standard Lucide glyphs, existing local fonts, no generated raster used as functional UI. No product imagery is required by this screen.
- Copy/content: actual saved responder and response; full-skill delivery is described separately from compliance/quality; legacy captures are labeled; no fabricated output title, approval state, or source receipts.

## Validation

- 414 UI tests pass, including canonical-turn matching, required-skill path identity, immutable snapshots, forged metadata rejection, replay cursor behavior, output rendering, graph ownership, copy, keyboard handling, and connection removal.
- 210 backend library tests pass, including an ACP fixture that requires full skill instructions in the sent prompt and a final-answer phase test.
- UI and prototype production builds pass. The backend binary builds with the embedded UI.
- Lint exits successfully with six existing warnings in Workspace/useComposerLayout. The existing large-bundle advisory remains. Browser trace views also emit existing schema-format/React Flow warnings; no new Run-render errors were observed.
- Browser: Run/Build/back-to-same-run; next-run ordering without execution; focused and whole-team graphs; type filters/list; required-skill receipt ownership; output expand/restore; copy success; direct cross-harness checkbox connection and removal; existing Full trace and handoff access; 390px mobile and light appearance.

## Limits and follow-up

No paid model run was started for QA. The local application uses a copied team directory and real archived history. Instruction SHA-256 covers SKILL.md only. Model compliance, complete bundle reproducibility, persistent report approval, and rich HTML/file previews are not claimed. The interactive prototype separately explores report review.

Potential P3 work: deeper Build-canvas layout cleanup, splitting the application bundle, and more compact presentation for teams with many stages. Preview servers remain available locally; nothing has been published.

## Prototype composition migration — September 14

Replaced the earlier panel-only treatment with the prototype's shared navigation, Run split view, stage facts, report presentation, and Build heading/library composition. Retained the existing canvas engine and floating glass resource panels. Output placement clears the configured stages; handoff labels and dashed resource links distinguish connection types.

The Workspace, DeliveryLane, and Library suite passed 74 tests. A subsequent focused suite passed 43 tests across review, agent cards, and composer layout, including the additional successful-review test. The production UI build passes. Browser checks used the real application at localhost:3000 and its development preview, with desktop and 390px Run layouts. The narrow navigation overflow was corrected and verified; viewport overrides were reset.

Review is an explicitly session-only acknowledgement and requires complete required-skill evidence plus a finished response. It does not certify model compliance. No paid model execution was started. Tool and knowledge wiring retains the existing product's delivery limitations; this UI migration does not add new backend resource adapters.

## Complete prototype component migration — September 15

Reference: `docs/design-explorations/2026-09-14-result-led-workspace/prototype/src`, served at localhost:4173. Implementation: the real application at localhost:3000, using a copied team directory and actual archived run 15. This supersedes the earlier composition-only pass.

Ported the component palette, compact harness/resource/output inspectors, canvas card anatomy and controls, Run capability graph, handoff dialog, source list, output review, and compact revision composer into the live workspace. Output name/format persist in the sidecar and are included in the next new run's request. Advanced settings, team selection, memory, history, and trace remain accessible. Harness switches preserve skill attachments and require a compatible model choice.

### Comparison record

Desktop source and implementation screenshots were inspected together at 1615 × 964 in both Build and Run modes. Evidence lives in `qa/prototype-parity/`: prototype-build.png, product-build.png, prototype-run.png, product-run.png, product-handoff.png, product-evidence.png. Build positions differ because the product preserves saved arrangements. The test skill was freely dragged below its owner, and remained there after reopening the page. Temporary tool placement was removed.

Fidelity surfaces checked: Inter UI and Instrument Serif document headings; 64px navigation and 115px desktop section header; 60.7/39.3 Run split; palette/card/inspector anatomy; gold selections, dark surface tokens and glass backdrops; Lucide assets; content wrapping, native selection and keyboard dismissal. No raster artwork was needed. Mobile Build was checked at 390 × 844, including expanded/collapsed palette and usable navigation. Temporary viewport overrides were reset.

### Findings and fixes

- P1: Old read-only rule disabled narrow-screen editing. Removed it; document restrictions still apply.
- P2: Mobile workspace menu overlapped Run/Build. Hidden on the narrow layout; heading/actions now have reserved space.
- P2: Handoff dialog inherited reset margins and appeared at the top left. Centered it and verified Escape dismissal and glass backdrop.
- P2: Many real tools made graph labels too small. Graph height now follows its content; the work column scrolls while the output remains visible.
- P2: Removing a resource could bubble selection and leave an orphan inspector. Stop propagation on the remove action.
- P2: Compact composer inherited a large minimum height. Replaced the conflicting layout rules.
- P3: Production-specific inventory search/scan, advanced settings and honest historical evidence copy remain additions to the reference. Historical report text, title, responder and skill failures intentionally come from real records.

### Validation and outcome

The full UI suite passed 417 tests before the final refinements. Subsequent focused suites passed 39 document tests (including the added harness-switch regression) and 62 Workspace/DeliveryLane/Handover tests. The output metadata persistence regression passes. Production TypeScript/Vite build passes. Lint exits successfully with existing hook warnings. Nine backend composer tests and the backend build passed earlier in this migration. No paid model run was started.

Visual QA: passed for the migrated Run/Build component surfaces and tested desktop/mobile states. This is not a claim that historical content matches the prototype's example report or that all backend adapters were expanded. Review remains a session-only acknowledgement; tools and knowledge retain the product's existing delivery semantics. The existing large-bundle advisory remains.
