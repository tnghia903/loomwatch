// Pre-run check that every agent's app can start (GET /api/commands,
// crates/loomwatch-backend/src/api.rs). A team shared from another computer can name an app this
// one does not have; without this, Build said "Your team is ready" and the run failed at once.
import { useEffect, useMemo, useState } from 'react'

import { daemonFetch } from '../daemonFetch'
import { shortenDirectory } from './problems'
import type { AgentConfig } from './types'

/** backend::CommandStatus: how the daemon judged one `spawn.cmd`, without running it. */
export type CommandStatus = 'found' | 'not_found' | 'outside_path' | 'not_executable' | 'unchecked'

/** backend::CommandCheck. `path` is where it was found, for `found` and `outside_path`. */
export interface CommandCheck {
  cmd: string
  status: CommandStatus
  path?: string
}

/** One agent whose app a run could not start, in the operator's words. */
export interface AppProblem {
  agentId: string
  cmd: string
  status: 'not_found' | 'outside_path' | 'not_executable'
  /** What is wrong, naming the agent and the app: "Helper’s app “acme-agent-cli” isn’t installed on this computer." */
  sentence: string
  /** What to do about it. */
  remedy: string
}

export async function fetchCommandChecks(commands: readonly string[], signal?: AbortSignal): Promise<CommandCheck[]> {
  const query = commands.map((cmd) => `cmd=${encodeURIComponent(cmd)}`).join('&')
  const response = await daemonFetch(`/api/commands?${query}`, signal ? { signal } : undefined)
  if (!response.ok) throw new Error(`Couldn’t check the team’s apps (${response.status}).`)
  return ((await response.json()) as { commands: CommandCheck[] }).commands
}

/**
 * The command the daemon can judge for this agent, or `null`.
 *
 * An agent that sets its own `PATH` in `spawn.env` has none: a run looks its command up on that
 * `PATH`, which the daemon's check does not know, and a guess either way would be a false claim —
 * even when another agent's identical command was judged.
 */
function checkableCommand(agent: AgentConfig): string | null {
  if (agent.kind === 'operator' || !agent.spawn?.cmd || Object.hasOwn(agent.spawn.env ?? {}, 'PATH')) return null
  return agent.spawn.cmd
}

/** The distinct commands worth asking the daemon about, sorted so the list is a stable key. */
export function commandsToCheck(agents: readonly AgentConfig[]): string[] {
  return [...new Set(agents.map(checkableCommand).filter((cmd) => cmd !== null))].sort()
}

/** Every agent whose app the daemon says a run could not start, in canvas order. */
export function appProblemsFor(agents: readonly AgentConfig[], checks: ReadonlyMap<string, CommandCheck>, names: ReadonlyMap<string, string>): AppProblem[] {
  return agents.flatMap((agent): AppProblem[] => {
    const cmd = checkableCommand(agent)
    const check = cmd === null ? undefined : checks.get(cmd)
    if (cmd === null || !check || check.status === 'found' || check.status === 'unchecked') return []
    const name = names.get(agent.id) || agent.name || agent.id
    const app = `“${cmd}”`
    const other = `choose another AI app for ${name}`
    if (check.status === 'outside_path') {
      const folder = check.path?.includes('/') ? shortenDirectory(check.path.slice(0, check.path.lastIndexOf('/'))) : 'a folder of your own'
      return [{ agentId: agent.id, cmd, status: check.status, sentence: `${name}’s app ${app} is installed in ${folder}, but LoomWatch was started without that folder.`, remedy: `Restart LoomWatch from a terminal where ${app} works, or ${other}.` }]
    }
    if (check.status === 'not_executable') {
      return [{ agentId: agent.id, cmd, status: check.status, sentence: `${name}’s app ${app} isn’t a program this computer can start.`, remedy: `Check the file, or ${other}.` }]
    }
    return [{ agentId: agent.id, cmd, status: check.status, sentence: `${name}’s app ${app} isn’t installed on this computer.`, remedy: `Install it, or ${other}.` }]
  })
}

/** One line for the composer and the Build heading: the problem itself, or a count and names. */
export function appProblemSummary(problems: readonly AppProblem[], names: ReadonlyMap<string, string>): string | null {
  if (problems.length === 0) return null
  if (problems.length === 1) return problems[0].sentence
  return `${problems.length} agents’ apps can’t start on this computer: ${problems.map((problem) => names.get(problem.agentId) ?? problem.agentId).join(', ')}.`
}

/**
 * What the daemon said about each of these agents' commands, keyed by command.
 *
 * Asked again when the set of commands changes (debounced, so typing a command in Advanced YAML is
 * not a request per keystroke) and when the window regains focus — the remedy is to install the
 * app, which happens outside LoomWatch. A failed check, including an older daemon without the
 * endpoint, reports nothing: not knowing is not a reason to stop a run.
 */
export function useAppChecks(agents: readonly AgentConfig[]): ReadonlyMap<string, CommandCheck> {
  const key = useMemo(() => commandsToCheck(agents).join('\n'), [agents])
  const [checks, setChecks] = useState<ReadonlyMap<string, CommandCheck>>(() => new Map())
  useEffect(() => {
    if (!key) return
    const controller = new AbortController()
    const check = () => {
      fetchCommandChecks(key.split('\n'), controller.signal)
        .then((results) => setChecks(new Map(results.map((result) => [result.cmd, result]))))
        .catch(() => { /* unknown is reported as nothing wrong; the run's own error still names the app */ })
    }
    const timer = window.setTimeout(check, 250)
    window.addEventListener('focus', check)
    return () => { controller.abort(); window.clearTimeout(timer); window.removeEventListener('focus', check) }
  }, [key])
  return checks
}
