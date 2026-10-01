import { rankHarnesses } from '../team-file/templates'
import type { DetectedHarness } from '../harnesses'
import type { LibrarySource } from './types'

/**
 * Helpers by job, for the Build palette.
 *
 * A newcomer does not know what OpenCode or Hermes is; they know they need a researcher. A job adds
 * an agent that already has useful instructions, on the best app already installed, so the first
 * thing placed on the canvas can run. The app stays an ordinary, editable choice in the agent's
 * settings — a job is a starting point, never a lock.
 */
export type RoleIcon = 'research' | 'write' | 'edit' | 'review' | 'code' | 'design' | 'analyse'

export interface RolePreset {
  id: string
  label: string
  /** What the helper does, in five words or so; shown under the name. */
  does: string
  role: string
  icon: RoleIcon
  /** Harness ids in the order this job prefers them. Anything installed beats nothing. */
  prefers: readonly string[]
}

const WRITING = ['claude', 'codex', 'opencode', 'gemini']
const CODING = ['codex', 'claude', 'opencode', 'gemini']

export const ROLE_PRESETS: readonly RolePreset[] = [
  {
    id: 'researcher', label: 'Researcher', does: 'Finds and reads sources', icon: 'research', prefers: WRITING,
    role: 'Research the request. Find reliable sources, read them, and collect the facts, figures and open questions the next step will need. List every source as a link. Do not write the final piece.',
  },
  {
    id: 'writer', label: 'Writer', does: 'Drafts the finished piece', icon: 'write', prefers: WRITING,
    role: 'Turn what you were handed into the finished piece the request asks for. Keep every fact you were given accurate, write clearly for the intended reader, and reply with the finished result only.',
  },
  {
    id: 'editor', label: 'Editor', does: 'Tightens and corrects a draft', icon: 'edit', prefers: WRITING,
    role: 'Edit what you were handed. Cut what is weak or repeated, fix errors and unclear wording, keep the facts and their sources, and reply with the improved version.',
  },
  {
    id: 'reviewer', label: 'Reviewer', does: 'Checks work against the request', icon: 'review', prefers: CODING,
    role: 'Check the work you were handed against the request. List what is wrong or missing, with the exact place and a fix for each. End with a clear verdict: ready, or needs changes.',
  },
  {
    id: 'coder', label: 'Coder', does: 'Changes code in a folder', icon: 'code', prefers: CODING,
    role: 'Make the code change the request asks for in this folder. Keep the change small, follow the existing style, run the tests if there are any, and reply with what you changed and why.',
  },
  {
    id: 'designer', label: 'Designer', does: 'Makes slides, pages and visuals', icon: 'design', prefers: WRITING,
    role: 'Design what the request asks for: slides, a page or a visual. Decide the structure first, then produce it. Reply with the finished design or the files you created, and one line on each choice you made.',
  },
  {
    id: 'analyst', label: 'Analyst', does: 'Makes sense of data', icon: 'analyse', prefers: CODING,
    role: 'Analyse the data or material you were given. Show the numbers that matter, what they mean, and how sure you are. Reply with a short summary first, then the detail.',
  },
]

/** The app a job should run on: its own preference among the runnable apps, else the best runnable. */
export function harnessForRole(preset: RolePreset, harnesses: readonly DetectedHarness[]): DetectedHarness | null {
  const runnable = rankHarnesses(harnesses)
  for (const id of preset.prefers) {
    const hit = runnable.find((harness) => harness.id === id)
    if (hit) return hit
  }
  return runnable[0] ?? null
}

/** The Library payload that places this job as an agent, or `null` when no app can run it. */
export function roleSource(preset: RolePreset, harnesses: readonly DetectedHarness[]): LibrarySource | null {
  const harness = harnessForRole(preset, harnesses)
  if (!harness) return null
  return { group: 'presets', id: `role-${preset.id}-${harness.id}`, label: preset.label, role: preset.role, spawn: { cmd: harness.spawn.cmd, args: [...harness.spawn.args] } }
}
