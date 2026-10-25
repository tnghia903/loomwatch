import { quoteLine } from '../chat/reply'
import { stillAnswering, type ChatItem, type ChatMessage, type ChatTarget, type PartAt, type ReplyTo } from '../chat/client'
import type { RunRecord } from '../runs/client'
import { plainRunError } from '../runs/errors'

/**
 * A part of a file marked in the reader and asked about (ADR 0077). It goes to the chat as a reply
 * does: the words you marked are its quote, and the file it is a part of goes with it, so the agent
 * reads the words and knows where they are. Once asked, the part stays marked in the file, with the
 * face of the agent you asked beside it.
 */

/** The most of a marked part that is asked about: a few paragraphs, not the file. */
export const PASSAGE_MAX_CHARS = 4_000

/** The words of a selection as they are asked about: lines kept, blank runs and edges trimmed; `null` for too little to ask about. */
export function passageOf(selected: string): string | null {
  const text = selected
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t ]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if ([...text.replace(/\s/g, '')].length < 2) return null
  const chars = [...text]
  return chars.length > PASSAGE_MAX_CHARS ? `${chars.slice(0, PASSAGE_MAX_CHARS).join('').trimEnd()}…` : text
}

/** A short, stable id for a passage of a file, for the reply's `messageId` (the chat's ids are short). */
export function passageId(path: string, text: string, at?: PartAt): string {
  let hash = 0x811c9dc5
  for (const char of `${path}\n${partId({ text, at })}`) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `passage:${hash.toString(36)}`
}

/** The reply a marked part is asked as: its words, and where it is when it isn't words (ADR 0091). */
export function passageReply(file: { path: string; runId: string | null; from: string }, text: string, at?: PartAt): ReplyTo {
  return { runId: file.runId, messageId: passageId(file.path, text, at), from: file.from, to: null, kind: 'passage', text, file: file.path, ...(at ? { at } : {}) }
}

/** Where a part is, in a few characters that are the same each time: `box:2500,0,5000,5000`. */
export function atKey(at: PartAt): string {
  return `box:${at.x},${at.y},${at.w},${at.h}${at.page ? `@${at.page}` : ''}`
}

/**
 * What tells one part of a file from another: its words, and its place when it isn't words (two
 * boxes on a picture can say the same). For words alone it is the words, so the marks, bubbles and
 * keys of words are what they always were.
 */
export function partId(part: { text: string; at?: PartAt }): string {
  return part.at ? `${part.text}\u0001${atKey(part.at)}` : part.text
}

/**
 * What Reply under an answer writes back about. An answer to a question about a part of a file goes
 * on about the same part, as Reply on its answer in the reader does, so the agent is handed the part
 * and its file again and the next answer joins the talk on the file. Any other answer is quoted.
 */
export function answerReply(asked: ReplyTo | null | undefined, answer: ReplyTo): ReplyTo {
  return asked?.kind === 'passage' && asked.file ? asked : answer
}

/** A part already asked about, as the chat keeps it. */
export interface AskedPassage {
  file: string
  text: string
  /** Where it is, when it isn't words (ADR 0091). */
  at?: PartAt
  /** Who was asked. */
  from: string
  /** What you asked: your message's words. */
  asked: string
  /** The piece of work your message went into or started, when it has one. */
  runId: string | null
  /** Your message, by the chat's id, when the chat has one for it. */
  messageId: string | null
  /** Your message started no work: what came of it is under it in the chat, not in a piece of work. */
  onItsOwn: boolean
  /** What came of asking, for the reader to show beside the part. */
  answer: PassageAnswer
}

/** What came of asking about a part, as the reader shows it beside the part. */
export type PassageAnswer =
  /** Your message is on its way. */
  | { state: 'sending' }
  /** The agent is writing its answer in the chat. */
  | { state: 'writing'; by: string }
  /** Your message started work, or went into work under way, and it is not done. */
  | { state: 'working'; by: string }
  /** What came back: the agent's answer in the chat, or the answer of the work. */
  | { state: 'said'; by: string; text: string; at: string | null }
  /** The work stopped before it answered: what went wrong. */
  | { state: 'failed'; by: string; text: string }
  /** Your message did not reach the daemon: the chat has it, with Try again. */
  | { state: 'unsent' }
  /**
   * Nothing came back, and why: you stopped the work, the message was a note for the team's next
   * work, the agent asked had nothing to add, or its answer never came.
   */
  | { state: 'none'; why: 'stopped' | 'note' | 'passed' | 'lost' }

const LIVE_RUN = new Set(['queued', 'starting', 'running'])

/**
 * Every part of a file asked about in a chat, oldest first by when you asked: in messages that
 * started work, in notes sent into it, and in notes on their own. A message still on its way counts
 * too, after them.
 */
export function askedPassages(items: readonly ChatItem[], pending: readonly { text: string; replyTo?: ReplyTo | null; to?: ChatTarget; state?: 'sending' | 'failed' }[] = [], now = Date.now()): AskedPassage[] {
  const found: { at: string; passage: AskedPassage }[] = []
  const add = (message: Pick<ChatMessage, 'text' | 'replyTo'> & { id?: string; agentId?: string | null; createdAt?: string }, runId: string | null, answer: (asked: string) => PassageAnswer, onItsOwn = false) => {
    const reply = message.replyTo
    if (reply?.kind !== 'passage' || !reply.file) return
    // Asked of one agent, it is that agent's face beside the part, whoever made the file.
    const from = message.agentId ?? reply.from
    found.push({ at: message.createdAt ?? '', passage: { file: reply.file, text: reply.text, ...(reply.at ? { at: reply.at } : {}), from, asked: message.text, runId: runId ?? reply.runId, messageId: message.id ?? null, onItsOwn, answer: answer(from) } })
  }
  for (const item of items) {
    if (item.kind === 'note') add(item.message, item.message.runId ?? null, (from) => noteAnswer(item.message, from, now), true)
    else {
      const answer = (from: string) => workAnswer(item.run, from)
      if (item.request) add(item.request, item.run.runId, answer)
      for (const note of item.notes) add(note, item.run.runId, answer)
    }
  }
  // By when each was asked, not where the chat keeps it: a note sent into earlier work is kept
  // with that work, before anything asked since.
  found.sort((a, b) => a.at.localeCompare(b.at))
  for (const message of pending) add({ ...message, agentId: message.to?.kind === 'agent' ? message.to.agent : null }, null, () => (message.state === 'failed' ? { state: 'unsent' } : { state: 'sending' }))
  return found.map((item) => item.passage)
}

/** What tells one ask about a part of a file from another: the part (`partId`) and the agent asked. The same agent asked again about the same part is the same ask, newer. */
export function askKey(passage: Pick<AskedPassage, 'text' | 'from' | 'at'>): string {
  return `${passage.from}\u0000${partId(passage)}`
}

/**
 * The asks a file shows, oldest first: each agent's newest ask about each part of it. Several
 * agents asked about the same words each keep their own bubble there, and their own answer.
 */
export function fileAsks(asked: readonly AskedPassage[], file: string): AskedPassage[] {
  const byKey = new Map<string, AskedPassage>()
  for (const passage of asked) {
    if (passage.file !== file) continue
    const key = askKey(passage)
    byKey.delete(key)
    byKey.set(key, passage)
  }
  return [...byKey.values()]
}

/** The words of the parts to mark, each once, in the order of its newest ask: where two overlap, the newer is marked. The page's script does the same (pageFrame.ts). */
export function partTexts(asks: readonly Pick<AskedPassage, 'text'>[]): string[] {
  const texts: string[] = []
  for (const { text } of asks) {
    const at = texts.indexOf(text)
    if (at >= 0) texts.splice(at, 1)
    texts.push(text)
  }
  return texts
}

/** Where the chat shows what came of asking (TeamChat's `reveal`): the answer of its work, or your message with the answers under it. */
export function askedInChat(passage: AskedPassage): { runId: string; id: string } | null {
  // Not sent: it waits at the bottom of the chat, with Try again.
  if (passage.answer.state === 'unsent') return { runId: '', id: 'pending' }
  if (passage.answer.state === 'sending') return null
  if (passage.onItsOwn) return passage.messageId ? { runId: '', id: `note:${passage.messageId}` } : null
  return passage.runId ? { runId: passage.runId, id: `answer:${passage.runId}` } : null
}

/** A message that started no work: the asked agent's own answer in the chat, or the first one's when it was asked of everyone. */
function noteAnswer(message: ChatMessage, from: string, now: number): PassageAnswer {
  if (!message.answers) return { state: 'none', why: 'note' }
  const said = message.answers.said.find((answer) => answer.from === from) ?? (message.agentId ? undefined : message.answers.said[0])
  if (said) return { state: 'said', by: said.from, text: said.text, at: said.at }
  const writing = stillAnswering(message, now)
  const by = writing.includes(from) ? from : message.agentId ? null : writing[0]
  if (by) return { state: 'writing', by }
  // Still waited on, but too long ago to be writing: the answer never came.
  return { state: 'none', why: message.answers.waiting.length > 0 ? 'lost' : 'passed' }
}

/** A message that started work or went into it: that work's answer, once it is done. */
function workAnswer(run: RunRecord, from: string): PassageAnswer {
  const by = run.responder || run.onlyAgent || from
  if (LIVE_RUN.has(run.status)) return { state: 'working', by: run.working?.[0] ?? by }
  if (run.status === 'failed') return { state: 'failed', by, text: (run.error ? plainRunError(run.error).split('\n')[0] : '') || 'It stopped before it answered.' }
  if (run.status === 'succeeded' && run.reply?.trim()) return { state: 'said', by, text: run.reply, at: run.finishedAt }
  return { state: 'none', why: run.status === 'cancelled' ? 'stopped' : 'lost' }
}

/**
 * A page's text, read once so that any number of passages can be found in it: every character but
 * whitespace, with the text node and offset it came from. Whitespace is left out on both sides, so
 * a passage is found however the page spaced or broke its lines and wherever a block ended.
 */
export interface PageText {
  chars: string
  nodes: Text[]
  node: Int32Array
  offset: Int32Array
}

export function pageText(root: Node): PageText {
  const doc = root.ownerDocument ?? (root as Document)
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */)
  const nodes: Text[] = []
  let chars = ''
  const node: number[] = []
  const offset: number[] = []
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    const text = current as Text
    // A mark's own controls (the faces in the margin) are not the page.
    if (text.parentElement?.closest('[data-reader-chrome]')) continue
    const index = nodes.push(text) - 1
    const value = text.data
    for (let at = 0; at < value.length; at++) {
      const char = value[at]
      if (/\s/.test(char)) continue
      chars += char
      node.push(index)
      offset.push(at)
    }
  }
  return { chars, nodes, node: Int32Array.from(node), offset: Int32Array.from(offset) }
}

/** Where `passage` is on the page, as a range over its text; `null` when the page no longer says it. */
export function findPassage(page: PageText, passage: string): Range | null {
  let wanted = passage.replace(/…$/, '').replace(/\s/g, '')
  if (!wanted) return null
  let start = page.chars.indexOf(wanted)
  // A long part was cut when it was asked: its start is enough to find it.
  if (start < 0 && wanted.length > 400) {
    wanted = wanted.slice(0, 400)
    start = page.chars.indexOf(wanted)
  }
  if (start < 0) return null
  const end = start + wanted.length - 1
  const first = page.nodes[page.node[start]]
  const last = page.nodes[page.node[end]]
  const range = (first.ownerDocument ?? document).createRange()
  range.setStart(first, page.offset[start])
  range.setEnd(last, page.offset[end] + 1)
  return range
}

/** Where the ask bubble sits: above the marked words, centred on them, inside the page; below them at the top of the view. */
export function bubblePlace(
  marked: { top: number; bottom: number; left: number; right: number },
  view: { top: number; left: number; width: number },
  scroll: { top: number; left: number },
  size: { width: number; height: number },
  gap = 10,
): { top: number; left: number; below: boolean } {
  const centre = (marked.left + marked.right) / 2 - view.left + scroll.left
  const half = size.width / 2
  const left = Math.max(half + 8, Math.min(view.width - half - 8, centre))
  const above = marked.top - view.top - size.height - gap
  const below = above < 4
  const top = (below ? marked.bottom - view.top + gap : marked.top - view.top - size.height - gap) + scroll.top
  return { top, left, below }
}

/**
 * Where an answer sits beside the part it answers, in the view's own coordinates: under the part,
 * centred on it, inside the view; over it when there is more room there. `arrow` is how far into
 * the answer its point is, so it still points at the part when the answer is held inside the view.
 * `null` while the part is scrolled out of sight.
 */
export function answerPlace(
  part: { top: number; bottom: number; left: number; right: number },
  view: { top: number; left: number; width: number; height: number },
  size: { width: number; height: number },
  gap = 10,
): { top: number; left: number; above: boolean; arrow: number } | null {
  if (part.bottom < view.top || part.top > view.top + view.height) return null
  const edge = 8
  const centre = (part.left + part.right) / 2 - view.left
  const left = Math.max(edge, Math.min(view.width - size.width - edge, centre - size.width / 2))
  const below = view.top + view.height - part.bottom - gap
  const over = part.top - view.top - gap
  const above = below < size.height && over > below
  const top = above ? part.top - view.top - gap - size.height : part.bottom - view.top + gap
  return {
    top: Math.max(edge, Math.min(view.height - size.height - edge, top)),
    left,
    above,
    arrow: Math.max(18, Math.min(size.width - 18, centre - left)),
  }
}

type Box = { top: number; bottom: number; left: number; right: number }

/**
 * A part's lines on screen, one box each, top to bottom: the boxes a range gives for each piece of
 * text it spans, joined where they sit on the same line. Empty boxes (a line break, an empty
 * element) are left out.
 */
export function partLines(rects: readonly Box[]): Box[] {
  const lines: Box[] = []
  for (const rect of [...rects].filter((box) => box.right - box.left > 0.5 && box.bottom - box.top > 0.5).sort((a, b) => a.top - b.top || a.left - b.left)) {
    const middle = (rect.top + rect.bottom) / 2
    const line = lines.find((box) => middle > box.top && middle < box.bottom)
    if (line) {
      line.top = Math.min(line.top, rect.top)
      line.bottom = Math.max(line.bottom, rect.bottom)
      line.left = Math.min(line.left, rect.left)
      line.right = Math.max(line.right, rect.right)
    } else lines.push({ ...rect })
  }
  return lines
}

/** The box round all of a part's lines: what its answer points at. */
export function partBox(lines: readonly Box[]): Box | null {
  if (lines.length === 0) return null
  return {
    top: Math.min(...lines.map((line) => line.top)),
    bottom: Math.max(...lines.map((line) => line.bottom)),
    left: Math.min(...lines.map((line) => line.left)),
    right: Math.max(...lines.map((line) => line.right)),
  }
}

/** How a part asked about looks, from what came of asking and whether you have read its answer. */
export type PartLook = 'busy' | 'waiting' | 'read' | 'failed'

export function partLook(answer: PassageAnswer, read: boolean): PartLook {
  if (answer.state === 'sending' || answer.state === 'writing' || answer.state === 'working') return 'busy'
  if (answer.state === 'failed' || answer.state === 'unsent') return 'failed'
  return answer.state === 'said' && !read ? 'waiting' : 'read'
}

const WORDS_LOOKS: readonly PartLook[] = ['busy', 'waiting', 'failed', 'read']

/** How marked words look with several asks on them: at work while any is, else waiting while any answer waits, else stopped, else read. The page's script does the same. */
export function wordsLook(looks: readonly PartLook[]): PartLook {
  return WORDS_LOOKS.find((look) => looks.includes(look)) ?? 'read'
}

/** The ask a press on marked words opens: the newest whose answer waits for you, else the newest. The page's script does the same. */
export function wordsOpen<T>(asks: readonly T[], look: (ask: T) => PartLook): T | undefined {
  return asks.findLast((ask) => look(ask) === 'waiting') ?? asks.at(-1)
}

/** Who a part's bubble shows: the agent answering, or the one asked while nobody is yet. */
export function bubbleAgent(passage: AskedPassage): string {
  return 'by' in passage.answer ? passage.answer.by : passage.from
}

/** A part's words as a label quotes them: its first line, cut with an ellipsis past `most` characters. */
export function partQuote(text: string, most = 60): string {
  const line = quoteLine(text)
  return `“${line.length > most ? `${line.slice(0, most - 1).trimEnd()}…` : line}”`
}

function quoted(passage: AskedPassage, most = 60): string {
  return partQuote(passage.text, most)
}

/** What a part's bubble says to a screen reader: its state; being a button that opens says the rest. */
export function bubbleLabel(passage: AskedPassage, look: PartLook, name: (id: string) => string): string {
  const who = name(bubbleAgent(passage))
  const about = quoted(passage)
  if (passage.answer.state === 'unsent') return `Your question about ${about} wasn't sent`
  if (look === 'busy') return `${who} is answering your question about ${about}`
  if (look === 'waiting') return `New answer from ${who} about ${about}`
  if (look === 'failed') return `${who} stopped before answering about ${about}`
  if (passage.answer.state === 'none') return `No answer from ${who} about ${about}`
  return `${who}'s answer about ${about}`
}

/** What a part's bubble says on hover: your words, after what the bubble's look means. */
export function bubbleTitle(passage: AskedPassage, look: PartLook, name: (id: string) => string): string {
  const words = yourWords(passage.asked, name(passage.from))
  const state = passage.answer.state
  const said = state === 'unsent' ? 'Not sent'
    : state === 'sending' ? 'Sending your question'
      : state === 'writing' || state === 'working' ? `${name(bubbleAgent(passage))} ${state === 'writing' ? 'is writing' : 'is working'}`
        : look === 'waiting' ? 'New answer'
          : look === 'failed' ? 'Stopped' : ''
  return [said, words].filter(Boolean).join(' · ')
}

/** What a bubble's agent card says under who the agent is: what came of asking, and what you asked. */
export function bubbleCardLine(passage: AskedPassage, look: PartLook, name: (id: string) => string): string {
  const { said, words } = bubbleCardParts(passage, look, name)
  return [said, words && `You asked: ${words}`].filter(Boolean).join(' · ')
}

/** [`bubbleCardLine`] in its parts: the app's words, and yours, shown with their Markdown. */
export function bubbleCardParts(passage: AskedPassage, look: PartLook, name: (id: string) => string): { said: string; words: string } {
  const words = yourWords(passage.asked, name(passage.from))
  const state = passage.answer.state
  const said = state === 'unsent' ? 'Not sent'
    : state === 'sending' ? 'Sending your question'
      : state === 'writing' ? 'Writing its answer'
        : state === 'working' ? 'Working on it'
          : look === 'waiting' ? 'New answer'
            : look === 'failed' ? 'Stopped' : ''
  return { said, words }
}

/** Your words without the @ they were sent with: "@Writer why?" is "why?". */
export function yourWords(asked: string, agent: string): string {
  const text = asked.trim()
  for (const address of [`@${agent}`, '@team']) {
    if (text.toLowerCase().startsWith(address.toLowerCase())) return text.slice(address.length).trim()
  }
  return text
}
