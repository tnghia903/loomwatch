import type { AskedPassage } from './passage'

/**
 * Which answers to parts of files you have read, kept in this browser: an answer waits for you,
 * with a gold dot on the agent's bubble, until you open it beside its part. Answers given before
 * this browser first kept any count as read, so a file opened for the first time is not full of
 * dots for answers you read in the chat long ago.
 */
const KEY = 'loomwatch.readerAnswers'
/** The most answers remembered; the oldest go first. */
const MOST = 400

interface Kept { since: string; read: string[] }

// Read once per page: asked on every frame the marks move.
let cached: Kept | null = null

function kept(): Kept {
  if (cached) return cached
  try {
    const parsed = JSON.parse(window.localStorage.getItem(KEY) ?? 'null') as Partial<Kept> | null
    if (parsed && typeof parsed.since === 'string' && Array.isArray(parsed.read)) {
      cached = { since: parsed.since, read: parsed.read.filter((id): id is string => typeof id === 'string') }
      return cached
    }
  } catch { /* Nothing kept, or not readable here: start again. */ }
  const fresh = { since: new Date().toISOString(), read: [] }
  keep(fresh)
  return fresh
}

function keep(value: Kept) {
  cached = value
  try { window.localStorage.setItem(KEY, JSON.stringify(value)) } catch { /* Kept for this page only. */ }
}

/** What identifies an answer: your message, and when the answer came. */
function answerKey(passage: AskedPassage): string | null {
  return passage.answer.state === 'said' && passage.messageId ? `${passage.messageId}@${passage.answer.at ?? ''}` : null
}

export function answerRead(passage: AskedPassage): boolean {
  // Counting starts at the first part looked at, answered or not: an answer that comes after it is news.
  const { since, read } = kept()
  const key = answerKey(passage)
  if (!key || passage.answer.state !== 'said') return true
  // An answer whose time is not known cannot be news.
  const at = Date.parse(passage.answer.at ?? '')
  return !Number.isFinite(at) || at < Date.parse(since) || read.includes(key)
}

/** Forgets what was read here, for tests. */
export function forgetAnswersRead() {
  cached = null
}

export function markAnswerRead(passage: AskedPassage) {
  const key = answerKey(passage)
  if (!key) return
  const value = kept()
  if (value.read.includes(key)) return
  keep({ since: value.since, read: [...value.read, key].slice(-MOST) })
}
