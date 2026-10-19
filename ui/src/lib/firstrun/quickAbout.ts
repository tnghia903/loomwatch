/**
 * The first run's "Tell my agents about me" (ADR 0075): a name and a few taps a newcomer gives
 * their agents, written as the About you every agent reads (ADR 0074). Each tap becomes one plain
 * sentence, in the person's voice, so the About you page shows them exactly what agents are told.
 */

export const WORK = ['Teaching', 'Small business', 'Studying', 'Writing', 'Something else'] as const
export const LANGUAGE = ['Tiếng Việt', 'English', 'The language I write in'] as const
export const LENGTH = ['Short', 'Just right', 'Detailed'] as const

export interface QuickAbout {
  name: string
  work: (typeof WORK)[number] | null
  /** What they do, in their words, when none of the choices is it. */
  otherWork: string
  language: (typeof LANGUAGE)[number] | null
  length: (typeof LENGTH)[number] | null
}

export const EMPTY_ABOUT: QuickAbout = { name: '', work: null, otherWork: '', language: null, length: null }

const WORK_SAYS: Record<Exclude<(typeof WORK)[number], 'Something else'>, string> = {
  Teaching: 'I’m a teacher.',
  'Small business': 'I run a small business.',
  Studying: 'I’m a student.',
  Writing: 'I write for a living.',
}
const LANGUAGE_SAYS: Record<(typeof LANGUAGE)[number], string> = {
  'Tiếng Việt': 'Answer in Vietnamese.',
  English: 'Answer in English.',
  'The language I write in': 'Answer in the language I write in.',
}
const LENGTH_SAYS: Record<(typeof LENGTH)[number], string | null> = {
  Short: 'Keep answers short.',
  'Just right': null,
  Detailed: 'Give detailed answers.',
}

/** The About you the taps make: one sentence per tap, or nothing when none was given. */
export function aboutFrom(told: QuickAbout): string {
  const other = told.otherWork.trim().replace(/\s+/g, ' ')
  const work = told.work === 'Something else' ? (other ? `I work in ${other.replace(/[.!]+$/, '')}.` : null) : told.work ? WORK_SAYS[told.work] : null
  return [work, told.language && LANGUAGE_SAYS[told.language], told.length && LENGTH_SAYS[told.length]].filter(Boolean).join('\n')
}

/** The taps as one short line under an answer made for the person: "Teaching · Tiếng Việt · Short". */
export function aboutLine(told: QuickAbout): string {
  const work = told.work === 'Something else' ? told.otherWork.trim() : told.work
  return [work, told.language, told.length === 'Just right' ? null : told.length].filter(Boolean).join(' · ')
}
