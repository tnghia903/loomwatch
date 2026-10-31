import { Suspense, useEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type ClipboardEvent } from 'react'

import { applyEdits, blockChange, blockShape, type SourceEdit } from '../../lib/files/markdownEdits'
import { ChangedSince, writeFile } from '../../lib/files/reader'
import { EditableMarkdownRenderer } from '../ui/markdownCode'

/** What came of saving a change made in the reader (ADR 0107). */
export type Saving =
  | { state: 'saved'; kept: string }
  | { state: 'failed'; message: string; changed: boolean; undo?: boolean; said?: boolean }

interface DraftProps {
  path: string
  /** The file's words as last read, and their version. */
  text: string
  version: string
  onSaving: (saving: Saving) => void
}

/**
 * The file's words as you change them, and the version on disk they were last read or saved at.
 * The words read again from the file replace them only when they are something else's — an agent
 * wrote the file, or a change was put back — and you are not typing: your own save read back
 * changes nothing on screen.
 */
function useDraft({ path, text, version, onSaving }: DraftProps, typing: () => boolean) {
  const [state, setState] = useState(() => fresh(text, version))
  // The words and version last read, to tell when they change.
  const [read, setRead] = useState({ text, version })
  if (read.text !== text || read.version !== version) {
    setRead({ text, version })
    setState((current) => {
      if (version === current.base.version) return current
      // Your own save, read back.
      if (text === current.draft) return { ...current, base: { text, version } }
      // Something else's: shown now, or once you stop typing.
      return typing() ? { ...current, held: true } : fresh(text, version, current)
    })
  }
  const base = useRef(state.base)
  const draft = useRef(state.draft)
  useEffect(() => {
    base.current = state.base
    draft.current = state.draft
  }, [state.base, state.draft])
  useEffect(() => {
    if (!state.held) return
    // Once focus has gone where it was going, and not into the words.
    const later = () => window.setTimeout(() => { if (!typing()) setState((current) => fresh(read.text, read.version, current)) }, 0)
    document.addEventListener('focusout', later)
    return () => document.removeEventListener('focusout', later)
  }, [state.held, read, typing])

  const queue = useRef<Promise<void>>(Promise.resolve())
  /** Save `words` as the file's, after any save before it, on the version last saved. */
  const save = (words: string) => {
    if (words === draft.current) return
    draft.current = words
    setState((current) => ({ ...current, draft: words }))
    queue.current = queue.current.then(async () => {
      try {
        const written = await writeFile(path, words, base.current.version)
        base.current = { text: words, version: written.version }
        setState((current) => ({ ...current, base: { text: words, version: written.version } }))
        onSaving({ state: 'saved', kept: written.kept })
      } catch (caught: unknown) {
        onSaving({ state: 'failed', message: caught instanceof Error ? caught.message : String(caught), changed: caught instanceof ChangedSince })
        // What is on disk is shown again: yours wasn't saved.
        setState((current) => fresh(current.base.text, current.base.version, current))
      }
    })
  }
  return { shown: state.shown, drawn: state.drawn, save }
}

interface DraftState {
  /** The words drawn, and their version. */
  shown: { text: string; version: string }
  /** The words on disk as last read or saved, and their version: what a save names. */
  base: { text: string; version: string }
  /** The words last given to be saved. */
  draft: string
  /** Something else changed the file while you typed; it is shown once you stop. */
  held: boolean
  /** How often the words were drawn afresh: never updated around what you typed. */
  drawn: number
}

/** The words `text` at `version`, drawn afresh after `before`. */
function fresh(text: string, version: string, before?: DraftState): DraftState {
  return { shown: { text, version }, base: { text, version }, draft: text, held: false, drawn: (before?.drawn ?? 0) + 1 }
}

/**
 * A text, code or data file changed as its words (ADR 0107): the whole file in one box, saved when
 * you leave it or stop typing for a moment.
 */
export function TextDraft(props: DraftProps & { name: string; onSelectWords?: (words: string | null, box: DOMRect | null) => void }) {
  const box = useRef<HTMLTextAreaElement>(null)
  const { shown, save } = useDraft(props, () => document.activeElement === box.current)
  // The words as they were when the box was entered, which Esc puts back, without saving.
  const entered = useRef('')
  const cancelled = useRef(false)
  const [words, setWords] = useState(shown.text)
  const [from, setFrom] = useState(shown)
  if (from !== shown) {
    setFrom(shown)
    setWords(shown.text)
  }
  // Saved a moment after typing stops, as well as on leaving.
  useEffect(() => {
    if (words === shown.text) return
    const timer = window.setTimeout(() => save(words), PAUSE_MS)
    return () => window.clearTimeout(timer)
    // `save` is the draft's own, the same for its life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [words])
  // Grows with its words, so the reader scrolls it as it scrolls any file.
  useEffect(() => {
    const element = box.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight}px`
  }, [words])
  return (
    <textarea ref={box} className="rd-draft-text" value={words} spellCheck={false} aria-label={`The words of ${props.name}`}
      onChange={(event) => setWords(event.target.value)}
      onFocus={() => { entered.current = words }}
      onSelect={(event) => {
        if (!props.onSelectWords) return
        const box = event.currentTarget
        const selected = box.value.slice(box.selectionStart, box.selectionEnd)
        props.onSelectWords(selected.trim() ? selected : null, box.getBoundingClientRect())
      }}
      onBlur={() => { if (cancelled.current) cancelled.current = false; else save(words) }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        cancelled.current = true
        setWords(entered.current)
        event.currentTarget.blur()
      }} />
  )
}

/** How long typing stops before a text is saved. */
const PAUSE_MS = 1_200

/**
 * A Markdown file changed where it is drawn (ADR 0107, lib/files/markdownEdits.ts): a paragraph, a
 * heading or a list item is typed into in place, and saved into its own words in the file when you
 * leave it. Enter leaves it; Esc puts it back as it was. Pasted words come as words.
 */
export function MarkdownDraft(props: DraftProps) {
  const page = useRef<HTMLDivElement>(null)
  const typing = () => Boolean(page.current?.contains(document.activeElement) && document.activeElement?.closest('[data-lw-block]'))
  const { shown, drawn, save } = useDraft(props, typing)
  // Each block's shape as it was drawn, to tell what changed in it however often it is entered; its
  // words as they were when it was last entered, for Esc. And the changes made to the words drawn,
  // in their places then, so a later block's place is found in the words saved since.
  const drawnShape = useRef(new WeakMap<Element, string>())
  const entered = useRef(new WeakMap<Element, string>())
  const made = useRef<{ from: string; edits: SourceEdit[] }>({ from: '', edits: [] })

  const blockOf = (target: EventTarget | null) => (target instanceof HTMLElement ? target.closest<HTMLElement>('[data-lw-block]') : null)
  const onFocus = (event: FocusEvent) => {
    const block = blockOf(event.target)
    if (!block) return
    if (!drawnShape.current.has(block)) drawnShape.current.set(block, blockShape(block))
    entered.current.set(block, block.innerHTML)
  }
  const onBlur = (event: FocusEvent) => {
    const block = blockOf(event.target)
    const shape = block ? drawnShape.current.get(block) : undefined
    if (!block || shape === undefined) return
    // Places are in the words drawn; what was changed in them before is kept to find a later place.
    if (made.current.from !== shown.text) made.current = { from: shown.text, edits: [] }
    // What this block says now replaces what it was changed to before.
    const range = /^(\d+)-(\d+)$/.exec(block.dataset.lwBlock ?? '')
    const [start, end] = range ? [Number(range[1]), Number(range[2])] : [0, 0]
    const before = made.current.edits.length
    const others = made.current.edits.filter((edit) => edit.start < start || edit.end > end)
    const edits = blockChange(block, shape, made.current.from) ?? []
    if (!edits.length && others.length === before) return
    made.current.edits = [...others, ...edits]
    save(applyEdits(made.current.from, made.current.edits))
  }
  const onKeyDown = (event: KeyboardEvent) => {
    const block = blockOf(event.target)
    if (!block) return
    if (event.key === 'Enter') {
      event.preventDefault()
      block.blur()
    } else if (event.key === 'Escape') {
      const was = entered.current.get(block)
      if (was !== undefined) block.innerHTML = was
      event.stopPropagation()
      block.blur()
    }
  }
  const onPaste = (event: ClipboardEvent) => {
    if (!blockOf(event.target)) return
    event.preventDefault()
    document.execCommand('insertText', false, event.clipboardData.getData('text/plain').replace(/\s*\n\s*/g, ' '))
  }
  return (
    <div ref={page} className="rd-draft-markdown" onFocus={onFocus} onBlur={onBlur} onKeyDown={onKeyDown} onPaste={onPaste}>
      <Suspense fallback={<div className="markdown-fallback">{shown.text}</div>}>
        {/* Drawn afresh for each version of the words, never updated around what you typed. */}
        <EditableMarkdownRenderer key={drawn} source={shown.text} />
      </Suspense>
    </div>
  )
}
