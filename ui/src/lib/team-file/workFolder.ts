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
 * Whether the agent's folder holds its team file: the team's own folder (`.`, every template's
 * default), or a relative path made only of `.` and `..`, which always does. Mirrors `holds` in
 * `workspace::materialise`.
 */
export function holdsTeamFile(agent: Pick<AgentConfig, 'spawn'>): boolean {
  const cwd = (agent.spawn?.cwd ?? '').trim()
  return !cwd.startsWith('/') && segments(cwd).every((segment) => segment === '.' || segment === '..')
}

/**
 * Why LoomWatch moves this agent into a folder of its own, whatever `spawn.cwd` says, or null when
 * it works where `cwd` points. Mirrors `workspace::materialise`: only an agent whose folder holds
 * its team file is ever moved (ADR 0042), because that folder is the teams folder. A folder the
 * operator chose is where the agent works however much is connected to it.
 *
 * - Anything connected (ADR 0012 decision 4, ADR 0029): skills and tools are delivered into it.
 * - Allowed to edit (ADR 0037 decision 6): the team files stay out of its reach.
 * - The third, a Brief kept in the app's memory file, is the "Work in this folder" switch's to
 *   explain.
 */
export function ownFolderReason(agent: Pick<AgentConfig, 'capabilities' | 'allow' | 'spawn'>): 'connected' | 'edits' | null {
  if (!holdsTeamFile(agent)) return null
  if ((agent.capabilities ?? []).length > 0) return 'connected'
  if (agent.allow?.edits === true) return 'edits'
  return null
}

/** The folder the team file is saved in, when the path names it: what "the team's folder" is. */
export function teamFolderOf(teamPath: string | null | undefined): string | null {
  const path = (teamPath ?? '').trim()
  if (!path.startsWith('/')) return null
  const folder = path.replace(/\/[^/]*$/, '')
  return folder || '/'
}
