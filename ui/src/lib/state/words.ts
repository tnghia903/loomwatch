/**
 * The one set of words for what an agent, a team or a piece of work is doing, used on every screen
 * (round 3: one word per state). The figure's glow says the same thing in colour: green ready, blue
 * working, gold waiting for you, red didn't finish, and grey stopped, which is only ever work you
 * stopped yourself.
 */
export type WorkState = 'ready' | 'working' | 'waiting' | 'failed' | 'stopped'

export const STATE_WORDS: Record<WorkState, string> = {
  ready: 'ready',
  working: 'working',
  waiting: 'waiting for you',
  failed: 'didn’t finish',
  stopped: 'stopped',
}

/** The same word with a capital first letter, for a label that starts a line. */
export function stateLabel(state: WorkState): string {
  const word = STATE_WORDS[state]
  return word.charAt(0).toUpperCase() + word.slice(1)
}

/** "Writer didn’t finish", "Writer is working": the word after a name. */
export function stateAfterName(name: string, state: WorkState): string {
  return state === 'failed' || state === 'stopped' ? `${name} ${STATE_WORDS[state]}` : `${name} is ${STATE_WORDS[state]}`
}
