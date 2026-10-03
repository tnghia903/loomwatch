import type { AgentConfig, AllowSwitch } from './types'

/**
 * An agent's "Allowed without asking" switches (ADR 0037), in the order a newcomer weighs them:
 * least risk first. `on` and `off` say what the agent can do in each position; `short` is the
 * switch's name where there is room for one word, and is always part of `label`.
 */
export const ALLOW_SWITCHES: readonly { key: AllowSwitch; label: string; short: string; on: string; off: string }[] = [
  { key: 'web', label: 'Search the web', short: 'Web', on: 'It can search and read web pages.', off: 'It works only from what it is given.' },
  { key: 'edits', label: 'Edit files', short: 'Edit files', on: 'It can create and change files in its own folder, never your team files or its app’s settings.', off: 'It can read, but not change, files.' },
  { key: 'commands', label: 'Run commands', short: 'Commands', on: 'It can run commands in a terminal, and a command can do anything you can.', off: 'It cannot run commands.' },
]

/** Apps that act without asking whatever mode they are in, so no switch can hold them back. */
export function actsWithoutAsking(agent: Pick<AgentConfig, 'spawn'>): string | null {
  const command = `${agent.spawn?.cmd ?? ''} ${(agent.spawn?.args ?? []).join(' ')}`
  return /(^|[\s/])opencode(\s|$)/.test(command) ? 'OpenCode' : null
}

/** The switches as one line for the zoomed-in card: "Search the web, edit files" or "Reading only". */
export function allowedSummary(agent: Pick<AgentConfig, 'spawn' | 'allow'>): string {
  const app = actsWithoutAsking(agent)
  if (app) return `Anything: ${app} doesn’t ask`
  const on = ALLOW_SWITCHES.filter(({ key }) => agent.allow?.[key] === true).map(({ label }) => label)
  if (on.length === 0) return 'Reading only'
  return on.map((label, index) => (index === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1))).join(', ')
}
