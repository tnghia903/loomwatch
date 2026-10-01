# Composer spacing and pipeline organization

Verified 2026-09-13 against the current workspace.

## Changes

- Checkpoint, Notebook-review, and Brief-edit notices share a bounded stack above the measured
  composer. Long text and actions wrap; notices scroll when the stack reaches its height limit.
- Organize is available in the canvas controls and command palette, with the existing ⌥⌘L
  shortcut. It lays pipeline stages left to right and reserves a resource lane below each owner.
  Shared resources retain all their connections. Unassigned cards occupy a separate lower row.
- Agent and resource positions persist together in the layout sidecar. The workflow YAML and
  its connections are unchanged. Undo organize restores the previous arrangement.
- Prompt has a real gutter before the starting agent. Resource connectors route outside the
  resource cards. Fit view accounts for the Library, composer, notices, and smaller-screen
  toolbar placement, and refits after viewport changes.
- Organizing does not run agents. Streaming tokens and replay scrubbing do not trigger layout.

## Verification

- Full UI suite: 367 tests in 45 files passed.
- Final focused suite after resize handling: 51 tests passed.
- Production UI build passed; existing large-bundle advisory remains.
- UI lint has no errors and the same six pre-existing warnings.
- `git diff --check` passed.

Browser verification used a temporary server on port 3010, the separate review database, and
an offline three-stage fixture with three resource cards. Writer deliberately exits to reproduce
an unsuccessful run and its checkpoint notice. No model provider was called.

Organize, undo, and reload persistence were exercised. At 1024 × 768, all nine connectors
rendered and no node extended outside the viewport or under the notices. At 375 × 812, the
checkpoint controls wrapped within the screen. The measured gap between the notice stack and
composer was 12 pixels. Temporary viewport overrides were restored.
