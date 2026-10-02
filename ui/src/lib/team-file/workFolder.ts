import type { AgentConfig } from './types'

/**
 * Where an agent works, in the words the agent panel and the zoomed-in card use (ADR 0039).
 *
 * `spawn.cwd` is relative to the team file unless it is absolute (`resolve_cwd` in the daemon's
 * `lib.rs`); `.` is the team's own folder, every template's default.
 */
export type WorkFolder =
  | { kind: 'team' }
  | { kind: 'chosen'; name: string; path: string }

function segments(cwd: string): string[] {
  return cwd.split(/[\\/]+/).filter((segment) => segment !== '')
}

export function workFolder(cwd: string | undefined): WorkFolder {
  const path = (cwd ?? '').trim()
  const parts = segments(path)
  if (parts.every((segment) => segment === '.') && !path.startsWith('/')) return { kind: 'team' }
  const name = parts.filter((segment) => segment !== '.').at(-1) ?? path
  return { kind: 'chosen', name, path }
}

/**
 * Why LoomWatch moves this agent into a folder of its own, whatever `spawn.cwd` says, or null when
 * it works where `cwd` points. Mirrors `workspace::materialise` for the two cases the panel can
 * see for certain; the third, a Brief kept in the app's memory file, is the "Work in this folder"
 * switch's to explain.
 *
 * - Anything connected (ADR 0012 decision 4, ADR 0029): skills and tools are delivered into it.
 * - Editing beside the team file (ADR 0037 decision 6): a folder that holds the team file, which
 *   a relative path made only of `.` and `..` always does.
 */
export function ownFolderReason(agent: Pick<AgentConfig, 'capabilities' | 'allow' | 'spawn'>): 'connected' | 'edits' | null {
  if ((agent.capabilities ?? []).length > 0) return 'connected'
  const cwd = (agent.spawn?.cwd ?? '').trim()
  const holdsTeamFile = !cwd.startsWith('/') && segments(cwd).every((segment) => segment === '.' || segment === '..')
  if (agent.allow?.edits === true && holdsTeamFile) return 'edits'
  return null
}
