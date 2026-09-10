# TNG-122 freeform capability composer — focused self-check

Final revision: `8d26cf3`  
Artifact: `docs/mockups/prototype-standalone.html`  
Paperclip attachment: `b7867de1-6277-48cb-82f1-69996ffdf750`  
Primary work product: `5fb9f7ae-1d14-47f3-af4a-fbd36b936059`  
Exact size: **589,144 bytes**  
SHA-256: `6f5b93a1eae70607b4d66b665b00d54c052170e4a222897d5b5ed918ea67112f`

## Result

**PASS** — `node docs/mockups/verify-prototype.mjs`

## Focused checks

- **Freeform placement:** real Library drag/drop places at pointer coordinates; pointer node
  movement re-anchors edges. Keyboard placement uses `Enter`/`Space`, 16 px arrow steps,
  64 px `Shift` + arrow steps, `Enter` commit, and `Esc` cancel/focus return. The 390 px
  layout also supports tap-to-arm/tap-to-commit.
- **Typed graph:** the initial graph visibly demonstrates `starts`, `hands off`, `uses skill`,
  `invokes`, `reads`, and `produces`. Prompt and output remain protected structural anchors.
- **Edge editing:** selection, target reconnection by endpoint drag or keyboard `R`, and
  removal by `Delete`/`Backspace` or the selected-edge control pass. Invalid self, duplicate,
  and direction attempts explain the rule without changing existing work.
- **Capability discovery:** 20 authorized/discoverable resources and 16 usable resources;
  search, type/state filters, collapsed groups, per-group/overall counts, zero-result empties,
  disconnected/not-installed refusal, permission badges, compatibility cues, and a
  privacy-safe hidden count all pass.
- **Planned versus observed:** editable neutral planned wiring remains separate from immutable
  event-projected evidence. The wiring screen automatically projects tool, knowledge-search,
  and repository events; retained trace screens cover commands, searches, files,
  repositories, external sources, skills, and knowledge access without hidden reasoning.
- **State semantics:** blue animation appears only while the lead agent runs. Reduced motion
  uses a static 2 px blue perimeter. Completion freezes, and replay is labelled, inert, and
  cannot mutate planned wiring.
- **Themes and responsive layout:** Quarry Light and Obsidian & Gilt pass at 1600×1000 and
  390×844. Desktop origin nodes clear the Library. At 390 px the bounded Library, connection
  strip, reachable 44 px theme control, tap/keyboard placement, explicit relationship
  sentences, prompt-first/output-last order, and zero horizontal overflow all pass.
- **Offline package:** CSS, JavaScript, and fonts are embedded. Headless Chrome ran with
  external name resolution disabled; the page emitted no runtime exception and requested
  nothing outside `file:` and `data:`.
- **Static checks:** `node --check docs/mockups/prototype.js`,
  `node --check docs/mockups/verify-prototype.mjs`, and `git diff --check` pass.

The artifact remains design-only. Backend/schema assumptions are annotated in
`docs/TNG122_FREEFORM_CAPABILITY_COMPOSER.md`, `docs/UX_REDESIGN.md`, and
`docs/TNG89_INTERACTION.md` §14. No production UI/backend/schema was implemented, and the
frozen WebSocket schema was not changed by TNG-122.
