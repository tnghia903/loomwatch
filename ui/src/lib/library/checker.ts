import type { AgentConfig } from '../team-file/types'

// The Checker job and what makes an agent a check step (ADR 0062). Its own module so the team
// document can recognise a placed Checker without importing the job list, which imports templates,
// which import the team document.

export const CHECKER_ROLE = [
  'You are the team’s checker. Check the work you were handed against what it must satisfy and against the request. Do not rewrite it.',
  '',
  'How to work:',
  '- Check each item on its own. Open every source the work cites. If the work is code, check it the way its project checks code, when you are allowed to.',
  '- Mark an item Met only on evidence you saw yourself: a page you opened, a command and its output, a file and line.',
  '- When you cannot tell, say Not sure rather than guessing.',
  '- Report only gaps in correctness or in what was asked. Taste is not a problem.',
  '- Before you reply, check that every item has a verdict and its evidence.',
  '',
  'Reply with the problems you found, most serious first, then end with this block, one line per item:',
  '## Check',
  '- Met | Not met | Not sure — the item — your evidence',
].join('\n')

export function isCheckerRole(role: string): boolean {
  return role.trim() === CHECKER_ROLE
}

/**
 * The agent whose reply is the team's answer when a pipeline ends on `terminal`: the agent it
 * checks, when it is a check step (the daemon's `responder_id`), else itself.
 */
export function answeringAgent(terminal: string | null, agents: readonly Pick<AgentConfig, 'id' | 'checks'>[]): string | null {
  if (!terminal) return terminal
  return agents.find((agent) => agent.id === terminal)?.checks ?? terminal
}
