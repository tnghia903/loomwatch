/**
 * The crew's conversation on the landing page's first screen: a short, scripted hand-off that
 * acts out what LoomWatch does. One of the crew thinks, says a few words, and passes the work
 * along the gold thread to the next; the last hands it to you, and everyone waits for your OK.
 *
 * A pure function of time, so the scene can pause it (the pointer on a figure, the page scrolled
 * away, the Pause button) and pick it up again exactly where it was.
 */

/** One line: who says it (an index into the crew), what it says, and who gets the work next. */
export interface TalkLine {
  by: number
  says: string
  to: number | 'you'
}

export interface TalkState {
  /** The one thinking or talking, or null. */
  speaker: number | null
  /** Who it is talking to. */
  to: number | 'you' | null
  /** Its bubble: `says` is null while it thinks; `waiting` is the work waiting for your OK. */
  bubble: { by: number; says: string | null; waiting: boolean } | null
  /** The work on its way along the thread from one to the next, `at` from 0 to 1. */
  pass: { from: number; to: number; at: number } | null
  /** The work is handed to you: everyone looks out at you. */
  waiting: boolean
  /** Every loop has played. */
  done: boolean
}

/** In seconds. */
export const THINK = 0.7
export const PASS = 1.1
export const WAIT = 3.4
export const REST = 4.5
export const WAITING_WORDS = 'Waiting for you'

const IDLE: TalkState = { speaker: null, to: null, bubble: null, pass: null, waiting: false, done: false }

/** Long enough to read a few words at an easy pace, never so long that it drags. */
export function readTime(says: string): number {
  const words = says.trim().split(/\s+/).filter(Boolean).length
  return Math.min(3, Math.max(1.8, 1.2 + 0.3 * words))
}

function lineLength(line: TalkLine): number {
  return THINK + readTime(line.says) + (line.to === 'you' ? WAIT : PASS)
}

/** One time through the script, with the pause before it starts again. */
export function loopLength(script: readonly TalkLine[]): number {
  return script.reduce((sum, line) => sum + lineLength(line), 0) + REST
}

/** Where the conversation is `t` seconds in; before 0 it hasn't started. */
export function talkAt(script: readonly TalkLine[], t: number, loops: number): TalkState {
  if (script.length === 0 || t < 0) return IDLE
  const loop = loopLength(script)
  // The last loop ends when you are asked, not after its rest.
  if (t >= loops * loop - REST) return { ...IDLE, done: true }
  let at = t % loop
  for (const line of script) {
    const read = readTime(line.says)
    const talking = { ...IDLE, speaker: line.by, to: line.to }
    if (at < THINK) return { ...talking, bubble: { by: line.by, says: null, waiting: false } }
    at -= THINK
    if (at < read) return { ...talking, bubble: { by: line.by, says: line.says, waiting: false } }
    at -= read
    if (line.to === 'you') {
      if (at < WAIT) return { ...IDLE, to: 'you', bubble: { by: line.by, says: WAITING_WORDS, waiting: true }, waiting: true }
      at -= WAIT
    } else {
      // Its words stay up while the work travels, so you can see who sent it.
      if (at < PASS) return { ...talking, bubble: { by: line.by, says: line.says, waiting: false }, pass: { from: line.by, to: line.to, at: at / PASS } }
      at -= PASS
    }
  }
  return IDLE
}
