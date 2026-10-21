import type { ChatItem, ChatMessage, ChatTarget, ReplyTo } from '../chat/client'

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
export function passageId(path: string, text: string): string {
  let hash = 0x811c9dc5
  for (const char of `${path}\n${text}`) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `passage:${hash.toString(36)}`
}

/** The reply a marked part is asked as. */
export function passageReply(file: { path: string; runId: string | null; from: string }, text: string): ReplyTo {
  return { runId: file.runId, messageId: passageId(file.path, text), from: file.from, to: null, kind: 'passage', text, file: file.path }
}

/** A part already asked about, as the chat keeps it. */
export interface AskedPassage {
  file: string
  text: string
  /** Who was asked. */
  from: string
  /** What you asked: your message's words. */
  asked: string
  /** The piece of work your message went into or started, when it has one. */
  runId: string | null
  /** Your message, by the chat's id, when the chat has one for it. */
  messageId: string | null
}

/**
 * Every part of a file asked about in a chat, oldest first: in messages that started work, in
 * notes sent into it, and in notes on their own. A message still on its way counts too.
 */
export function askedPassages(items: readonly ChatItem[], pending: readonly { text: string; replyTo?: ReplyTo | null; to?: ChatTarget }[] = []): AskedPassage[] {
  const found: AskedPassage[] = []
  const add = (message: Pick<ChatMessage, 'text' | 'replyTo'> & { id?: string; agentId?: string | null }, runId: string | null) => {
    const reply = message.replyTo
    if (reply?.kind !== 'passage' || !reply.file) return
    // Asked of one agent, it is that agent's face beside the part, whoever made the file.
    found.push({ file: reply.file, text: reply.text, from: message.agentId ?? reply.from, asked: message.text, runId: runId ?? reply.runId, messageId: message.id ?? null })
  }
  // The chat holds its items newest first.
  for (const item of [...items].reverse()) {
    if (item.kind === 'note') add(item.message, item.message.runId ?? null)
    else {
      if (item.request) add(item.request, item.run.runId)
      for (const note of item.notes) add(note, item.run.runId)
    }
  }
  for (const message of pending) add({ ...message, agentId: message.to?.kind === 'agent' ? message.to.agent : null }, null)
  return found
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
