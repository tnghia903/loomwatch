import type { RunEvent } from '../watch/events'
import type { KeptWidget, WidgetSpec } from './types'

/**
 * Where an answer's widgets stand (ADR 0114). The agent writes a place line, `{{widget N}}`, where
 * its widget N belongs. When the answer is kept the daemon takes the lines out and keeps the line
 * of the words each widget stands before (`crates/loomwatch-backend/src/widgets/mod.rs` `place`);
 * while the answer is still being written the app does the same here, so a widget stands where it
 * will stay. Both read `schemas/widget-place.cases.json`.
 */

/** The number in a place line, read loosely (`{{ Widget 3 }}`), when `text` is one. */
function placeOf(text: string): number | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{{') || !trimmed.endsWith('}}') || trimmed.length < 4) return null
  const inside = trimmed.slice(2, -2).trim()
  const match = /^(\S+)\s+(\S+)$/u.exec(inside.replace(/\s+/gu, ' '))
  if (!match || match[1].toLowerCase() !== 'widget' || !/^\+?\d+$/u.test(match[2])) return null
  return Number(match[2])
}

/** `line` with every place line inside it taken out, and whether any was. */
function withoutPlaces(line: string): [string, boolean] {
  let out = ''
  let rest = line
  let found = false
  for (;;) {
    const open = rest.indexOf('{{')
    if (open === -1) break
    const end = rest.indexOf('}}', open)
    if (end === -1) break
    const close = end + 2
    out += rest.slice(0, open)
    const taken = placeOf(rest.slice(open, close)) !== null
    if (taken) found = true
    else out += rest.slice(open, close)
    rest = rest.slice(close)
    // "First {{widget 2}} words." reads "First words.", not with two spaces.
    if (taken && out.endsWith(' ') && rest.startsWith(' ')) rest = rest.slice(1)
  }
  return [out + rest, found]
}

/**
 * `reply` with every place line taken out, and for each of `places` (a widget's place number, or
 * null), the line of what is left that it stands before: null for one the words didn't place.
 */
export function place(reply: string, places: readonly (number | null)[]): { words: string; lines: (number | null)[] } {
  const lines: string[] = []
  const at: (number | null)[] = places.map(() => null)
  let fence: string | null = null
  let afterPlace = false
  for (const line of reply.split('\n')) {
    const trimmed = line.trimStart()
    const wasAfter = afterPlace
    afterPlace = false
    if (wasAfter && fence === null && trimmed === '' && (lines.length === 0 || lines[lines.length - 1].trim() === '')) continue
    const marker = ['```', '~~~'].find((one) => trimmed.startsWith(one))
    if (fence !== null) {
      if (trimmed.startsWith(fence)) fence = null
      lines.push(line)
      continue
    }
    if (marker) {
      fence = marker
      lines.push(line)
      continue
    }
    const number = placeOf(line)
    if (number !== null) {
      const index = places.findIndex((one, which) => one === number && at[which] === null)
      if (index !== -1) at[index] = lines.length
      afterPlace = true
      continue
    }
    const [rest, found] = withoutPlaces(line)
    lines.push(found ? rest.trimEnd() : rest)
  }
  let lead = 0
  while (lead < lines.length && lines[lead].trim() === '') lead += 1
  lines.splice(0, lead)
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  return { words: lines.join('\n'), lines: at.map((line) => (line === null ? null : Math.min(Math.max(0, line - lead), lines.length))) }
}

/** Words being written may end part way into a place line ("…\n{{wid"): not words yet. */
export function withoutPartPlace(streamed: string): string {
  const open = streamed.lastIndexOf('{{')
  if (open === -1 || streamed.indexOf('}}', open) !== -1) return streamed
  return /^\{\{\s*(w(i(d(g(e(t(\s+\d*\}?)?)?)?)?)?)?)?$/iu.test(streamed.slice(open)) ? streamed.slice(0, open) : streamed
}

/** Words to show where widgets aren't drawn (a long answer's pane, Details, a replay): any place
    line taken out, written or still being written. Words with none are kept exactly. */
export function wordsOf(text: string): string {
  return text.includes('{{') ? place(withoutPartPlace(text), []).words : text
}

/** A piece of an answer's words and the widgets that follow it. */
export interface AnswerPart {
  text: string
  widgets: KeptWidget[]
}

/**
 * The answer's words cut at the lines its widgets stand before, each piece followed by its
 * widgets; `end` are the widgets after the last words, those the words didn't place first, in
 * order.
 */
export function partsOf(words: string, widgets: readonly KeptWidget[]): { parts: AnswerPart[]; end: KeptWidget[] } {
  const lines = words.split('\n')
  const placed = widgets.filter((kept) => kept.line !== undefined && kept.line < lines.length).sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || a.n - b.n)
  const end = widgets.filter((kept) => kept.line === undefined).concat(widgets.filter((kept) => kept.line !== undefined && kept.line >= lines.length))
  const parts: AnswerPart[] = []
  let from = 0
  for (const kept of placed) {
    const line = kept.line ?? 0
    const last = parts[parts.length - 1]
    if (last && line === from) {
      last.widgets.push(kept)
      continue
    }
    parts.push({ text: lines.slice(from, line).join('\n'), widgets: [kept] })
    from = line
  }
  parts.push({ text: lines.slice(from).join('\n'), widgets: [] })
  return { parts, end }
}

/**
 * The widgets `responder` has shown so far in work still going, by place number: each
 * `show_widget` call the bus answered with a place line, as the agent gave it. The daemon checked
 * them before answering; they are kept, from the archive, once the work is done.
 */
export function shownSoFar(events: readonly RunEvent[], responder: string | null | undefined): Map<number, WidgetSpec> {
  const shown = new Map<number, WidgetSpec>()
  if (!responder) return shown
  const asked = new Map<string, WidgetSpec>()
  for (const event of events) {
    if (event.agentId !== responder) continue
    const payload = event.payload
    if (event.kind === 'tool_call' && payload.name === 'show_widget' && typeof payload.callId === 'string' && isSpec(payload.rawInput)) {
      asked.set(payload.callId, payload.rawInput)
    } else if (event.kind === 'tool_update' && payload.status === 'completed' && typeof payload.callId === 'string') {
      const spec = asked.get(payload.callId)
      const output = payload.rawOutput
      const line = output && typeof output === 'object' && 'place' in output && typeof output.place === 'string' ? placeOf(output.place) : null
      if (spec && line !== null) shown.set(line, spec)
    }
  }
  return shown
}

function isSpec(value: unknown): value is WidgetSpec {
  return typeof value === 'object' && value !== null && typeof (value as { kind?: unknown }).kind === 'string' && typeof (value as { title?: unknown }).title === 'string'
}

/**
 * Words being written and the widgets they have placed so far, standing where they will stay: a
 * widget shows once its place line is written. `n` is its place number until it is kept.
 */
export function placedSoFar(streamed: string, shown: ReadonlyMap<number, WidgetSpec>): { words: string; widgets: KeptWidget[] } {
  const text = withoutPartPlace(streamed)
  if (!text.includes('{{')) return { words: text, widgets: [] }
  const places = [...shown.keys()]
  const { words, lines } = place(text, places)
  const widgets: KeptWidget[] = []
  places.forEach((n, at) => {
    const line = lines[at]
    const spec = shown.get(n)
    if (line !== null && line !== undefined && spec) widgets.push({ n, line, spec })
  })
  return { words, widgets }
}
