// Talking to the box's agent: ⌃⌥Space held, the Mac app listens and turns what is said into words
// (crates/loomwatch-app/src/listen.rs), and they write themselves into the box. Let go, they wait
// there to be read, put right and sent like anything typed.
import type { CantListen } from './bridge'

/** Why talking did not work: what the app says, or that a hold ended with nothing heard. */
export type TalkProblem = CantListen | 'nothing'

/** What was written before talking, and what was heard, as one message. */
export function withHeard(before: string, heard: string): string {
  const said = heard.trim()
  if (!said) return before
  const kept = before.trimEnd()
  return kept ? `${kept} ${said}` : said
}

/** Why talking did not work, in words; whether it failed, which the line marks, rather than only
    needing another try; and the part of System Settings that puts it right, when there is one. */
export function talkProblem(why: TalkProblem): { text: string; failed: boolean; pane: 'microphone' | 'speech' | null } {
  switch (why) {
    case 'microphone':
      return { text: 'The microphone is off for LoomWatch. Turn it on, then hold ⌃⌥Space again.', failed: true, pane: 'microphone' }
    case 'speech':
      return { text: 'Speech Recognition is off for LoomWatch. Turn it on, then hold ⌃⌥Space again.', failed: true, pane: 'speech' }
    case 'asked':
      return { text: 'Allow LoomWatch when macOS asks, then hold ⌃⌥Space again.', failed: false, pane: null }
    case 'unavailable':
      return { text: 'Your Mac can’t turn speech into words right now. Type instead, or try again later.', failed: true, pane: null }
    case 'noMicrophone':
      return { text: 'LoomWatch can’t find a microphone. Plug one in, or type instead.', failed: true, pane: null }
    case 'longest':
      return { text: 'Listening stops after about a minute. Let go, then hold ⌃⌥Space again to go on.', failed: false, pane: null }
    case 'nothing':
      return { text: 'Nothing was heard. Hold ⌃⌥Space while you speak, or type instead.', failed: false, pane: null }
  }
}

/**
 * How loud the app hears, outside React: it says so a dozen times a second while it listens, and
 * only the bars that draw it read it, so the rest of the island isn't drawn again each time.
 */
export function loudness() {
  let level = 0
  const heard = new Set<() => void>()
  return {
    get: () => level,
    set(next: number) {
      const clamped = Number.isFinite(next) ? Math.min(1, Math.max(0, next)) : 0
      if (clamped === level) return
      level = clamped
      for (const tell of heard) tell()
    },
    subscribe(tell: () => void) {
      heard.add(tell)
      return () => { heard.delete(tell) }
    },
  }
}

export type Loudness = ReturnType<typeof loudness>
