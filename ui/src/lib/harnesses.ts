// Thin wrapper over GET /api/harnesses (TNG-52, crates/loomwatch-backend/src/api.rs).
// Mirrors backend::DetectedHarness — camelCase over the wire already.
import { daemonFetch } from './daemonFetch'

export interface HarnessSpawn {
  cmd: string
  args: string[]
}

export interface DetectedHarness {
  id: string
  name: string
  command: string
  executablePath: string
  acpAvailable?: boolean
  /**
   * Why this harness cannot be run over ACP, written by the daemon. Present exactly when
   * `acpAvailable` is false. The client must print it rather than guess: a harness can be
   * installed and still unrunnable (`pi` ships no ACP bridge at all), which the old
   * client-side "not found on PATH" sentence got wrong.
   */
  unavailableReason?: string
  /**
   * What the daemon saw the last time it asked this harness for its models. Absent until the
   * daemon has tried (and from older daemons): being on PATH is not proof an app can start — it
   * can be signed out or too old for its own service — and the list never spawns one to find out.
   */
  health?: 'ok' | 'error'
  /** Why `health` is `error`, in words the UI prints verbatim. */
  healthReason?: string
  /** The harness's own error behind `healthReason`, for anyone who needs the exact message. */
  healthDetail?: string
  /**
   * What is behind `health: 'error'` when the daemon knows for certain: `signed_out` when the
   * app's own CLI said so (`claude auth status`, `codex login status`). Absent otherwise.
   */
  healthCause?: 'signed_out'
  /**
   * Installed after LoomWatch started, in a folder the PATH that runs start from lacks: listed and
   * checkable, but no run can start it until LoomWatch restarts. Absent otherwise.
   */
  needsRestart?: boolean
  spawn: HarnessSpawn
}

/**
 * True when an app can be offered for new work: it speaks ACP, did not last fail to start, and a
 * run can find it.
 */
export function isHarnessRunnable(harness: DetectedHarness): boolean {
  return harness.acpAvailable !== false && harness.health !== 'error' && !harness.needsRestart
}

/** Why an app cannot be used right now, in plain words, or `null` when nothing is known wrong. */
export function harnessProblem(harness: DetectedHarness): string | null {
  if (harness.acpAvailable === false) return harness.unavailableReason ?? `${harness.spawn.cmd} not found on PATH`
  if (harness.health === 'error') return harness.healthReason ?? `${harness.name}: sign-in or version problem — run "${harness.command}" in Terminal to fix`
  if (harness.needsRestart) return `${harness.name} was installed after LoomWatch started. Restart LoomWatch to use it.`
  return null
}

/**
 * `GET /api/harnesses` — what the daemon found, and where it looked (backend::HarnessReport).
 *
 * `searchedPath` and `knownIds` exist so the Library can tell "nothing is installed" apart from
 * "the daemon's PATH does not include where it is installed" — the same empty list either way.
 */
export interface HarnessReport {
  harnesses: DetectedHarness[]
  searchedPath: string[]
  knownIds: string[]
  runnerError?: string
}

export interface HarnessModels {
  harnessId: string
  models: HarnessModel[]
  currentModelId?: string
  currentThinkingEffort?: string
}

export interface HarnessThinkingEffort {
  id: string
  name: string
  description?: string
}

export interface HarnessModel {
  id: string
  name: string
  description?: string
  thinkingEfforts: HarnessThinkingEffort[]
}

export class HarnessesApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export async function fetchHarnesses(): Promise<HarnessReport> {
  const response = await daemonFetch('/api/harnesses')
  if (!response.ok) {
    throw new HarnessesApiError(response.statusText, response.status)
  }
  return (await response.json()) as HarnessReport
}

export async function fetchHarnessModels(harnessId: string): Promise<HarnessModels> {
  const response = await daemonFetch(`/api/harnesses/${encodeURIComponent(harnessId)}/models`)
  if (!response.ok) {
    let message = response.statusText
    try {
      const body = (await response.json()) as { error?: unknown }
      if (typeof body.error === 'string') message = body.error
    } catch { /* the status text is still useful when the body is not JSON */ }
    throw new HarnessesApiError(message, response.status)
  }
  return (await response.json()) as HarnessModels
}

/**
 * Presentation for each harness the daemon knows how to look for (docs/CANVAS_SPEC.md §2.6).
 *
 * This used to be the client's own copy of the vendor list, and it drifted: the backend catalog
 * grew and this did not. §15.3's fix is now in place — `GET /api/harnesses` reports `knownIds`,
 * so *which* harnesses exist comes from the daemon and this table supplies only a name and a
 * monogram for one. `knownHarness` falls back to the id itself for anything it has not heard of,
 * so a harness added to the backend alone still renders instead of disappearing.
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
  // `Ow` rather than a second `Oc`: OpenClaw and OpenCode are different products and the
  // monogram is the only thing distinguishing their rows at a glance.
  { id: 'openclaw', name: 'OpenClaw', monogram: 'Ow' },
  { id: 'hermes', name: 'Hermes', monogram: 'H' },
  { id: 'pi', name: 'pi', monogram: 'Pi' },
]

/** Name and monogram for a harness id, whether or not this build has heard of it. */
export function knownHarness(id: string): KnownHarness {
  return KNOWN_HARNESSES.find((harness) => harness.id === id) ?? { id, name: id, monogram: '·' }
}

// docs/CANVAS_SPEC.md §2.6's harness table, keyed by the literal `spawn.cmd` each harness
// writes into an agent (crates/loomwatch-backend/src/api.rs HARNESSES). An agent's node
// carries only `spawn`, not the harness `id` it came from, so the monogram is recovered from
// `cmd` rather than threaded through as extra agent state. `·` is the custom-endpoint mark.
const SPAWN_CMD_MONOGRAMS: Readonly<Record<string, string>> = {
  'claude-agent-acp': 'C',
  'codex-acp': 'Cx',
  gemini: 'G',
  opencode: 'Oc',
  openclaw: 'Ow',
  'hermes-acp': 'H',
  pi: 'Pi',
}

export function monogramForSpawnCmd(cmd: string, args: readonly string[] = []): string {
  if (cmd === 'loomwatchd' && args[0] === 'harness-client') {
    const harnessIndex = args.indexOf('--harness')
    if (harnessIndex >= 0 && args[harnessIndex + 1]) return knownHarness(args[harnessIndex + 1]).monogram
  }
  return SPAWN_CMD_MONOGRAMS[cmd] ?? '·'
}
