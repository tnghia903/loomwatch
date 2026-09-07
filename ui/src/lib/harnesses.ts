// Thin wrapper over GET /api/harnesses (TNG-52, crates/loomwatch-backend/src/api.rs).
// Mirrors backend::DetectedHarness — camelCase over the wire already.

export interface HarnessSpawn {
  cmd: string
  args: string[]
}

export interface DetectedHarness {
  id: string
  name: string
  command: string
  executablePath: string
  spawn: HarnessSpawn
}

export class HarnessesApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export async function fetchHarnesses(): Promise<DetectedHarness[]> {
  const response = await fetch('/api/harnesses')
  if (!response.ok) {
    throw new HarnessesApiError(response.statusText, response.status)
  }
  return (await response.json()) as DetectedHarness[]
}

/**
 * The four first-party harnesses LoomWatch supports (docs/CANVAS_SPEC.md §2.6). The daemon's
 * `GET /api/harnesses` reports only what it *found*, so this is the only vendor knowledge in
 * the client — used solely to diff against detected ids and render the "Not installed"
 * disclosure (§4.2). It changes only when `HARNESSES` in the backend does (§15.3 proposes
 * folding it into the endpoint so the two cannot drift).
 */
export interface KnownHarness {
  id: string
  name: string
  monogram: string
}

export const KNOWN_HARNESSES: readonly KnownHarness[] = [
  { id: 'claude', name: 'Claude', monogram: 'C' },
  { id: 'codex', name: 'Codex', monogram: 'Cx' },
  { id: 'gemini', name: 'Gemini', monogram: 'G' },
  { id: 'opencode', name: 'OpenCode', monogram: 'Oc' },
]

// docs/CANVAS_SPEC.md §2.6's harness table, keyed by the literal `spawn.cmd` each harness
// writes into an agent (crates/loomwatch-backend/src/api.rs HARNESSES). An agent's node
// carries only `spawn`, not the harness `id` it came from, so the monogram is recovered from
// `cmd` rather than threaded through as extra agent state. `·` is the custom-endpoint mark.
const SPAWN_CMD_MONOGRAMS: Readonly<Record<string, string>> = {
  'claude-agent-acp': 'C',
  'codex-acp': 'Cx',
  gemini: 'G',
  opencode: 'Oc',
}

export function monogramForSpawnCmd(cmd: string): string {
  return SPAWN_CMD_MONOGRAMS[cmd] ?? '·'
}
