import type { AgentConfig, AllowSwitch } from './types'

/**
 * An agent's "Allowed without asking" switches (ADR 0037), in the order a newcomer weighs them:
 * least risk first. `on` and `off` say what the agent does in each position: off, it still has the
 * tool and asks you first (ADR 0104); `short` is the switch's name where there is room for one
 * word, and is always part of `label`.
 */
export const ALLOW_SWITCHES: readonly { key: AllowSwitch; label: string; short: string; on: string; off: string }[] = [
  { key: 'web', label: 'Search the web', short: 'Web', on: 'It can search and read web pages.', off: 'It asks you before it uses the web. It doesn’t ask to read a link you send it.' },
  { key: 'edits', label: 'Edit files', short: 'Edit files', on: 'It can create and change files in its own folder, never your team files or LoomWatch’s own.', off: 'It asks you before it changes a file.' },
  { key: 'commands', label: 'Run commands', short: 'Commands', on: 'It can run commands in a terminal, and a command can do anything you can.', off: 'It asks you before it runs a command.' },
]

/**
 * The switches as one line for the zoomed-in card: "Search the web, edit files", or, with every
 * switch off, "Reading; asks you for the rest": off asks first, it never means can't (ADR 0104).
 */
export function allowedSummary(agent: Pick<AgentConfig, 'allow'>): string {
  const on = ALLOW_SWITCHES.filter(({ key }) => agent.allow?.[key] === true).map(({ label }) => label)
  if (on.length === 0) return 'Reading; asks you for the rest'
  return on.map((label, index) => (index === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1))).join(', ')
}
