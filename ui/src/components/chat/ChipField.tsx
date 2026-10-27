import { useCallback, useImperativeHandle, useLayoutEffect, useRef, useState, type ClipboardEvent, type HTMLAttributes, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { createPortal } from 'react-dom'

import { fieldParts, fieldShows, fieldWords, offsetIn, pointAt, type ChipAt, type FieldPart } from '../../lib/chat/chipField'

/** What the chat asks of the box, as it would of a text area. */
export interface ChipFieldHandle {
  readonly value: string
  readonly selectionStart: number
  focus(): void
  setSelectionRange(start: number, end?: number): void
}

interface ChipFieldProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange' | 'onSelect' | 'onKeyDown' | 'onPaste' | 'children' | 'contentEditable' | 'placeholder'> {
  value: string
  /** The agents @mentioned in some words: each is drawn as its chip. */
  chipsIn: (text: string) => readonly ChipAt[]
  /** An agent's chip, as a sent message draws it. */
  chip: (agent: string) => ReactNode
  /**
   * The words now, where the caret is in them, and whether they changed by letters typed at the
   * caret (not a deletion, a paste or an undo). Letters an input method is putting together come
   * once it is done.
   */
  onChange: (value: string, caret: number, typed: boolean) => void
  onSelect?: (caret: number) => void
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
  /** Files pasted: the chat takes them and prevents the paste. Words paste as plain words. */
  onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void
  placeholder?: string
  disabled?: boolean
  ref?: Ref<ChipFieldHandle>
}

interface Snapshot { value: string; start: number; end: number }
interface Host { key: string; element: HTMLSpanElement; agent: string }

// A browser that can't keep a box to plain words (formatting, pasted pages) takes ordinary editing;
// what it adds beyond words is drawn away again.
const EDITABLE = (() => {
  if (typeof document === 'undefined') return 'true'
  try {
    const probe = document.createElement('div')
    probe.contentEditable = 'plaintext-only'
    return probe.contentEditable === 'plaintext-only' ? 'plaintext-only' : 'true'
  } catch {
    return 'true'
  }
})()

// Letters typed in a row undo together, until a space or a pause.
const TYPING_PAUSE_MS = 1000

/**
 * The words you write in a chat, with each agent @mentioned drawn as its chip: the same chip a sent
 * message shows it as, one piece the caret steps over and Backspace takes whole. The words stay
 * plain words, as typed; the chips are only how the box shows them. A name still being typed stays
 * letters until the caret moves on from it, so a slip can be mended a letter at a time.
 */
export function ChipField({ value, chipsIn, chip, onChange, onSelect, onKeyDown, onPaste, placeholder, disabled = false, className, ref, ...rest }: ChipFieldProps) {
  const field = useRef<HTMLDivElement>(null)
  const [hosts, setHosts] = useState<readonly Host[]>([])
  const pool = useRef(new Map<string, HTMLSpanElement>())
  // Where the caret is after the letter just typed: a name ending there is still being typed.
  const typing = useRef<number | null>(null)
  const composing = useRef(false)
  // A click puts the caret where it lands; any other way in (a shortcut, the chat) puts it back
  // where it was, as a text area does.
  const pointing = useRef(false)
  const pressed = useRef(false)
  // Words being dragged from the box, so a drop back in it moves them rather than copying.
  const dragged = useRef<{ start: number; end: number } | null>(null)
  const reported = useRef<string | null>(null)
  const shown = useRef<string | null>(null)
  const pending = useRef<{ start: number; end: number } | null>(null)
  const last = useRef({ start: value.length, end: value.length })
  const past = useRef<Snapshot[]>([])
  const future = useRef<Snapshot[]>([])
  const lastTyped = useRef(0)
  const [drawn, redraw] = useState(0)

  const parts = useCallback((text: string): FieldPart[] => fieldParts(text, chipsIn(text).filter((found) => found.end !== typing.current)), [chipsIn])

  const selection = useCallback((): { start: number; end: number } | null => {
    const root = field.current
    const picked = root?.ownerDocument.getSelection()
    if (!root || !picked || picked.rangeCount === 0 || !picked.anchorNode || !root.contains(picked.anchorNode) || !picked.focusNode || !root.contains(picked.focusNode)) return null
    const range = picked.getRangeAt(0)
    return { start: offsetIn(root, range.startContainer, range.startOffset), end: offsetIn(root, range.endContainer, range.endOffset) }
  }, [])

  const place = useCallback((start: number, end = start) => {
    const root = field.current
    const picked = root?.ownerDocument.getSelection()
    if (!root || !picked) return
    const from = pointAt(root, start)
    const to = pointAt(root, end)
    const range = root.ownerDocument.createRange()
    range.setStart(from.node, from.offset)
    range.setEnd(to.node, to.offset)
    picked.removeAllRanges()
    picked.addRange(range)
    last.current = { start, end }
    // Keep the caret in view in a box tall enough to scroll.
    if (root.scrollHeight > root.clientHeight && typeof range.getBoundingClientRect === 'function') {
      const caret = range.getBoundingClientRect()
      const box = root.getBoundingClientRect()
      if (caret.height > 0 && caret.bottom > box.bottom) root.scrollTop += caret.bottom - box.bottom
      else if (caret.height > 0 && caret.top < box.top) root.scrollTop -= box.top - caret.top
    }
  }, [])

  // Draws the words again whenever the box no longer shows them as they are: new words from the
  // chat, a chip to draw or let go, or anything a browser left behind. Never while an input method
  // is putting letters together.
  useLayoutEffect(() => {
    const root = field.current
    if (!root || composing.current) return
    if (value !== shown.current) {
      // Words that came from the chat, not from typing here, such as a name picked: they can be
      // undone, and the caret goes after them unless the chat says where.
      if (shown.current !== null && value !== reported.current) {
        if (value === '') past.current = []
        else past.current.push({ value: shown.current, ...last.current })
        future.current = []
        typing.current = null
        if (!pending.current) last.current = { start: value.length, end: value.length }
      }
      shown.current = value
      reported.current = null
    }
    const wanted = parts(value)
    if (fieldShows(root, wanted, value)) {
      if (pending.current) {
        const { start, end } = pending.current
        pending.current = null
        if (root.ownerDocument.activeElement === root) place(start, end)
        else last.current = { start, end }
      }
      return
    }
    const focused = root.ownerDocument.activeElement === root
    const keep = pending.current ?? (focused ? selection() ?? last.current : last.current)
    pending.current = null
    const used = new Map<string, HTMLSpanElement>()
    const counts = new Map<string, number>()
    const nodes: Node[] = []
    const hostsNow: Host[] = []
    for (const part of wanted) {
      if (part.kind === 'words') {
        nodes.push(root.ownerDocument.createTextNode(part.words))
        continue
      }
      const count = counts.get(part.agent) ?? 0
      counts.set(part.agent, count + 1)
      const key = `${part.agent}#${count}`
      const element = pool.current.get(key) ?? root.ownerDocument.createElement('span')
      element.className = 'tc-chip'
      element.setAttribute('contenteditable', 'false')
      element.dataset.agent = part.agent
      element.dataset.words = part.words
      used.set(key, element)
      nodes.push(element)
      hostsNow.push({ key, element, agent: part.agent })
    }
    // A last empty line takes its room only with a break after it.
    if (value.endsWith('\n')) nodes.push(root.ownerDocument.createElement('br'))
    root.replaceChildren(...nodes)
    pool.current = used
    setHosts((before) => (before.length === hostsNow.length && before.every((host, index) => host.element === hostsNow[index].element && host.agent === hostsNow[index].agent) ? before : hostsNow))
    const start = Math.min(keep.start, value.length)
    const end = Math.min(keep.end, value.length)
    if (focused) place(start, end)
    else last.current = { start, end }
  }, [value, parts, drawn, place, selection])

  const report = useCallback((text: string, start: number, end = start) => {
    reported.current = text
    last.current = { start, end }
    onChange(text, start, false)
  }, [onChange])

  const remember = (snapshot: Snapshot, typed: boolean) => {
    const now = Date.now()
    if (!typed || now - lastTyped.current > TYPING_PAUSE_MS || past.current.length === 0) past.current.push(snapshot)
    lastTyped.current = typed ? now : 0
    future.current = []
  }

  // New words for the box, which undo can take back to `words` with `was` selected.
  const commit = (words: string, was: { start: number; end: number }, next: string, at: number) => {
    remember({ value: words, ...was }, false)
    typing.current = null
    pending.current = { start: at, end: at }
    redraw((count) => count + 1)
    report(next, at)
  }

  // Changes the words as typing would: `insert` in place of what is selected.
  const edit = (insert: string, range?: { start: number; end: number }) => {
    const root = field.current
    if (!root || disabled) return
    const words = fieldWords(root)
    const { start, end } = range ?? selection() ?? last.current
    commit(words, { start, end }, `${words.slice(0, start)}${insert}${words.slice(end)}`, start + insert.length)
  }

  const travel = (from: { current: Snapshot[] }, to: { current: Snapshot[] }) => {
    const root = field.current
    const back = from.current.pop()
    if (!root || !back) return
    const words = fieldWords(root)
    to.current.push({ value: words, ...(selection() ?? last.current) })
    lastTyped.current = 0
    typing.current = null
    pending.current = { start: back.start, end: back.end }
    redraw((count) => count + 1)
    report(back.value, back.start, back.end)
  }

  // Reads the words back after the browser changed them: typing, deleting, a word mended by the
  // spelling check.
  const read = (kind: string) => {
    const root = field.current
    if (!root) return
    const before = shown.current ?? value
    const words = fieldWords(root)
    const at = selection() ?? { start: words.length, end: words.length }
    const typed = /^insert(Text|CompositionText|ReplacementText)$/.test(kind)
    typing.current = typed && at.start === at.end ? at.start : null
    if (words !== before) remember({ value: before, ...last.current }, typed && kind === 'insertText' && !/\s$/.test(words.slice(0, at.start)))
    last.current = at
    // Drawn again if need be: a chip to draw or let go, or whatever the browser left behind.
    redraw((count) => count + 1)
    if (words !== value) {
      reported.current = words
      onChange(words, at.start, typing.current !== null)
    }
  }

  useLayoutEffect(() => {
    const root = field.current
    if (!root) return
    const doc = root.ownerDocument
    const moved = () => {
      const at = selection()
      if (!at) return
      // A caret can't stand inside a chip (Safari puts one there): it goes after it. A click on a
      // chip says which side itself, once the button is up.
      const inChip = (node: Node | null) => Boolean(node && (node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement)?.closest('.tc-chip'))
      const picked = doc.getSelection()
      if (at.start === at.end && !pressed.current && picked && (inChip(picked.anchorNode) || inChip(picked.focusNode))) place(at.start)
      last.current = at
      // The caret moved on from a name being typed: it becomes its chip.
      if (typing.current !== null && (at.start !== at.end || at.start !== typing.current)) {
        typing.current = null
        redraw((count) => count + 1)
      }
      onSelect?.(at.start)
    }
    doc.addEventListener('selectionchange', moved)
    return () => doc.removeEventListener('selectionchange', moved)
  }, [onSelect, selection, place])

  useImperativeHandle(ref, () => ({
    get value() { return field.current ? fieldWords(field.current) : value },
    get selectionStart() { return selection()?.start ?? last.current.start },
    focus() {
      const root = field.current
      if (!root) return
      root.focus({ preventScroll: true })
      const { start, end } = last.current
      place(Math.min(start, value.length), Math.min(end, value.length))
    },
    setSelectionRange(start: number, end = start) {
      const root = field.current
      if (!root) return
      if (fieldWords(root) === value && fieldShows(root, parts(value), value)) place(start, end)
      else pending.current = { start, end }
    },
  }), [value, selection, place, parts])

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event)
    if (event.defaultPrevented || event.nativeEvent.isComposing) return
    const mod = event.metaKey || event.ctrlKey
    if (event.key === 'Enter' && event.shiftKey && !mod && !event.altKey) {
      event.preventDefault()
      edit('\n')
      return
    }
    if (mod && !event.altKey && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      if (event.shiftKey) travel(future, past)
      else travel(past, future)
      return
    }
    if (event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'y') {
      event.preventDefault()
      travel(future, past)
      return
    }
    // A chip goes whole: Backspace just after it, or Delete just before it.
    if ((event.key === 'Backspace' || event.key === 'Delete') && !mod && !event.altKey) {
      const root = field.current
      const at = selection()
      if (!root || !at || at.start !== at.end) return
      const words = fieldWords(root)
      const near = parts(words).find((part) => part.kind === 'chip' && (event.key === 'Backspace' ? part.start + part.words.length === at.start : part.start === at.start))
      if (!near) return
      event.preventDefault()
      edit('', { start: near.start, end: near.start + near.words.length })
    }
  }

  // The browser's own beforeinput, which says what kind of change is coming (React's doesn't).
  const beforeInput = (event: InputEvent) => {
    const kind = event.inputType ?? ''
    if (kind.startsWith('format')) {
      event.preventDefault()
      return
    }
    if (kind === 'insertParagraph' || kind === 'insertLineBreak') {
      event.preventDefault()
      edit('\n')
      return
    }
    if (kind === 'historyUndo' || kind === 'historyRedo') {
      event.preventDefault()
      if (kind === 'historyUndo') travel(past, future)
      else travel(future, past)
      return
    }
    if (kind === 'deleteByDrag') {
      // Words dragged out of the box are copied, not taken; dropped back in it, they move (below).
      event.preventDefault()
      const root = field.current
      const from = event.getTargetRanges?.()[0]
      dragged.current = root && from ? { start: offsetIn(root, from.startContainer, from.startOffset), end: offsetIn(root, from.endContainer, from.endOffset) } : null
      return
    }
    if (kind === 'insertFromDrop') {
      event.preventDefault()
      const root = field.current
      const words = event.dataTransfer?.getData('text/plain') ?? ''
      const target = event.getTargetRanges?.()[0]
      const from = dragged.current
      dragged.current = null
      if (!root || disabled) return
      const at = target ? offsetIn(root, target.startContainer, target.startOffset) : (selection() ?? last.current).start
      if (from && from.end > from.start) {
        // Words moved within the box: they leave where they were, chips and all.
        if (at >= from.start && at <= from.end) return
        const now = fieldWords(root)
        const moved = now.slice(from.start, from.end)
        const rest = `${now.slice(0, from.start)}${now.slice(from.end)}`
        const to = at > from.end ? at - moved.length : at
        commit(now, from, `${rest.slice(0, to)}${moved}${rest.slice(to)}`, to + moved.length)
        return
      }
      if (words) edit(words.replace(/\r\n?/g, '\n'), { start: at, end: at })
    }
  }

  useLayoutEffect(() => {
    const root = field.current
    if (!root) return
    root.addEventListener('beforeinput', beforeInput)
    return () => root.removeEventListener('beforeinput', beforeInput)
  })

  const copy = (event: ClipboardEvent<HTMLDivElement>, cut: boolean) => {
    const root = field.current
    const at = selection()
    if (!root || !at || at.start === at.end) return
    // Chips copy as the words they stand for.
    event.preventDefault()
    event.clipboardData.setData('text/plain', fieldWords(root).slice(at.start, at.end))
    if (cut) edit('', at)
  }

  const paste = (event: ClipboardEvent<HTMLDivElement>) => {
    onPaste?.(event)
    if (event.defaultPrevented) return
    event.preventDefault()
    const words = event.clipboardData.getData('text/plain')
    if (words) edit(words.replace(/\r\n?/g, '\n'))
  }

  return (
    <>
      {/* The words an empty box asks for, kept from screen readers, which hear aria-placeholder. */}
      {value === '' && placeholder && <span className="tc-input-hint" aria-hidden="true">{placeholder}</span>}
      <div
        {...rest}
        ref={field}
        className={className}
        role="textbox"
        aria-multiline="true"
        aria-placeholder={placeholder}
        aria-disabled={disabled || undefined}
        contentEditable={disabled ? 'false' : EDITABLE}
        suppressContentEditableWarning
        spellCheck
        tabIndex={disabled ? undefined : 0}
        onKeyDown={keyDown}
        onInput={(event) => {
          const native = event.nativeEvent as InputEvent
          if (native.isComposing || composing.current) return
          read(native.inputType ?? '')
        }}
        onCompositionStart={() => { composing.current = true }}
        onCompositionEnd={() => {
          composing.current = false
          read('insertCompositionText')
        }}
        onPointerDown={() => {
          pointing.current = true
          pressed.current = true
        }}
        onPointerUp={(event) => {
          pressed.current = false
          const root = field.current
          const host = (event.target as Element).closest?.('.tc-chip')
          if (!root || !host || host.parentNode !== root || !root.ownerDocument.getSelection()?.isCollapsed) return
          // A click on a chip puts the caret on the side of it that was clicked.
          const before = offsetIn(root, root, Array.from(root.childNodes).indexOf(host))
          const box = host.getBoundingClientRect()
          place(event.clientX < box.left + box.width / 2 ? before : before + ((host as HTMLElement).dataset.words ?? '').length)
        }}
        onFocus={() => {
          const clicked = pointing.current
          pointing.current = false
          if (!clicked) place(Math.min(last.current.start, value.length), Math.min(last.current.end, value.length))
        }}
        onBlur={() => {
          pointing.current = false
          pressed.current = false
          if (typing.current === null) return
          typing.current = null
          redraw((count) => count + 1)
        }}
        onCopy={(event) => copy(event, false)}
        onCut={(event) => copy(event, true)}
        onPaste={paste}
        onDragEnd={() => { dragged.current = null }}
        onDragStart={(event) => {
          // A chip is not dragged out of the box on its own; selected words are.
          if ((event.target as HTMLElement).closest?.('.tc-chip') && field.current?.ownerDocument.getSelection()?.isCollapsed) event.preventDefault()
        }}
      />
      {hosts.map((host) => createPortal(chip(host.agent), host.element, host.key))}
    </>
  )
}
