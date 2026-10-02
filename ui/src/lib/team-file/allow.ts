import type { AllowSwitch } from './types'

/**
 * An agent's "Allowed without asking" switches (ADR 0037), in the order a newcomer weighs them:
 * least risk first. `on` and `off` say what the agent can do in each position.
 */
export const ALLOW_SWITCHES: readonly { key: AllowSwitch; label: string; on: string; off: string }[] = [
  { key: 'web', label: 'Search the web', on: 'It can search and read web pages.', off: 'It works only from what it is given.' },
  { key: 'edits', label: 'Edit files', on: 'It can create and change files in its own folder, never your team files or its app’s settings.', off: 'It can read, but not change, files.' },
  { key: 'commands', label: 'Run commands', on: 'It can run commands in a terminal, and a command can do anything you can.', off: 'It cannot run commands.' },
]
