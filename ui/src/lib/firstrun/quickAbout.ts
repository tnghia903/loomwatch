/**
 * "Tell my agents about me", on the first run (ADR 0075) and the About you page: a name and a few
 * taps a person gives their agents, written as the About you every agent reads (ADR 0074). Each
 * tap becomes one plain sentence, in the person's voice, so the About you page shows them exactly
 * what agents are told.
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

export type QuickField = 'work' | 'language' | 'length'
export type QuickChoice<F extends QuickField> = NonNullable<QuickAbout[F]>

/** What the About you text says for one of the questions, and where it says it. */
interface Said<F extends QuickField> { choice: QuickChoice<F>; at: number; length: number; otherWork?: string }

// To the end of its line, where a tap writes it: their words may hold a full stop ("TP. HCM").
const OTHER_WORK = /I work in (.+)\.[ \t]*$/m

/**
 * Which choice an About you text says for `field`, read back from the sentence the tap wrote. On
 * the About you page the text is what agents are told, so the choices show what it says: change a
 * sentence by hand and its choice follows.
 */
export function saidIn<F extends QuickField>(text: string, field: F): Said<F> | null {
  const says: Record<string, string | null> = field === 'work' ? WORK_SAYS : field === 'language' ? LANGUAGE_SAYS : LENGTH_SAYS
  let found: Said<F> | null = null
  for (const [choice, sentence] of Object.entries(says)) {
    const at = sentence ? text.indexOf(sentence) : -1
    if (sentence && at >= 0 && (!found || at < found.at)) found = { choice: choice as QuickChoice<F>, at, length: sentence.length }
  }
  const other = field === 'work' ? OTHER_WORK.exec(text) : null
  if (other && (!found || other.index < found.at)) found = { choice: 'Something else' as QuickChoice<F>, at: other.index, length: other[0].length, otherWork: other[1] }
  return found
}

/** `text` without the sentence at `said`, and the line or space it took. */
function cut(text: string, said: { at: number; length: number }): string {
  const before = text.slice(0, said.at)
  const after = text.slice(said.at + said.length)
  const lineStart = before === '' || before.endsWith('\n')
  const lineEnd = after === '' || after.startsWith('\n')
  if (lineStart && lineEnd) return after === '' ? before.replace(/\n$/, '') : before + after.slice(1)
  if (lineStart) return before + after.replace(/^[ \t]+/, '')
  if (lineEnd) return before.replace(/[ \t]+$/, '') + after
  return `${before.replace(/[ \t]+$/, '')} ${after.replace(/^[ \t]+/, '')}`
}

/**
 * `text` with `field` answered `choice`: the sentence it said before is replaced where it was, or
 * the new one goes on a line of its own at the end. No choice, or one that says nothing (Just
 * right, or Something else before its words), takes the old sentence out.
 */
export function withChoice<F extends QuickField>(text: string, field: F, choice: QuickChoice<F> | null, otherWork = ''): string {
  const sentence = choice ? aboutFrom({ ...EMPTY_ABOUT, otherWork, [field]: choice } as QuickAbout) : ''
  const said = saidIn(text, field)
  if (said && sentence) return text.slice(0, said.at) + sentence + text.slice(said.at + said.length)
  const kept = said ? cut(text, said) : text
  if (!sentence) return kept
  return kept.trim() ? `${kept.replace(/\s+$/, '')}\n${sentence}` : sentence
}

/** The taps as one short line under an answer made for the person: "Teaching · Tiếng Việt · Short". */
export function aboutLine(told: QuickAbout): string {
  const work = told.work === 'Something else' ? told.otherWork.trim() : told.work
  return [work, told.language, told.length === 'Just right' ? null : told.length].filter(Boolean).join(' · ')
}
