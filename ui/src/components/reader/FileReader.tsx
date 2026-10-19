import { ExternalLink, FolderOpen, X } from 'lucide-react'
import { createElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import type { ReplyTo } from '../../lib/chat/client'
import { quoteLine } from '../../lib/chat/reply'
import { baseName, extensionOf, fileLabel, fileTitle, formatBytes, withFolderPaths } from '../../lib/files/fileRefs'
import { fileIcon } from '../../lib/files/icons'
import { bubblePlace, findPassage, pageText, passageOf, passageReply, type AskedPassage } from '../../lib/files/passage'
import { canMark, FileOriginContext, rawFileUrl, readerFormat, type FileToRead } from '../../lib/files/reader'
import { useFileActions } from '../../lib/files/useFile'
import { useFileText } from '../../lib/files/useFileText'
import { relativeTime } from '../../lib/format'
import { AvatarFace } from '../agents/AvatarFace'
import { Markdown } from '../ui/Markdown'
import { CodeView, DocumentView, TableView } from './formats'
import { PageFrame, type Marked } from './PageFrame'

export interface FileReaderProps {
  file: FileToRead
  name: (id: string) => string
  hue: (id: string) => number
  /** Ask `agent` about a marked part: put it in the message box with its quote, or send `words` about it at once. */
  onAsk?: (reply: ReplyTo, words: string | undefined, agent: string) => void
  /** The team's agents who can be asked instead of the one who made the file, in the team's order. */
  team?: readonly string[]
  /** Parts of files asked about in this chat; this file's are lit and get a face in the margin. */
  asked?: readonly AskedPassage[]
  /** The part in the message box now, being asked about. */
  asking?: string | null
  /** A face in the margin was pressed: show what came of asking. */
  onShowAsked?: (passage: AskedPassage) => void
}

/** What Explain sends: one press for the commonest question a newcomer has. */
export const EXPLAIN_WORDS = 'Explain this part in plain words.'
/** The tip under a file until the first part is asked about, kept for this browser. */
const HINT_KEY = 'loomwatch.readerHint'
/** How long "Updated" stays lit after the file changed on disk. */
const UPDATED_MS = 2_400
/** The ask bubble's size before it has been measured. */
const BUBBLE_GUESS = { width: 168, height: 40 }
const NO_PASSAGES: readonly AskedPassage[] = []
const NO_TEAM: readonly string[] = []
type Pin = { passage: AskedPassage; top: number }

/**
 * A file an agent made, read inside LoomWatch beside the chat it came from (ADR 0077): a report as a
 * document, a web page as itself, a table as a sheet, code by line, a PDF's or Word file's words.
 *
 * Mark any words and the agent's own face leans in over them: Ask puts them in the message box as a
 * quote, addressed to that agent, and Explain asks for them in plain words at once. A part asked
 * about stays lit in the file, with the agent's face in the margin — press it to see the answer. The
 * file is read again whenever it changes on disk, so a part the agent was asked to change is seen
 * changed.
 */
export function FileReader({ file, name, hue, onAsk, team = NO_TEAM, asked = NO_PASSAGES, asking = null, onShowAsked }: FileReaderProps) {
  const { path, from } = file
  const format = readerFormat(path) ?? 'text'
  const words = format !== 'picture' && format !== 'media'
  const content = useFileText(path, words)
  const text = content.file?.text ?? null
  const [view, setView] = useState<'page' | 'code'>('page')
  const shown = format === 'page' && view === 'code' ? 'code' : format
  const askable = Boolean(onAsk && from && canMark(format))

  const stage = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const page = useRef<HTMLDivElement>(null)
  const bubble = useRef<HTMLDivElement>(null)

  // The words marked now, and where they are on screen.
  const [marked, setMarked] = useState<Marked | null>(null)
  const [cleared, setCleared] = useState(0)
  const dragging = useRef(false)
  const readSelection = useCallback(() => {
    const selection = document.getSelection()
    const element = page.current
    if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !element) { setMarked(null); return }
    const range = selection.getRangeAt(0)
    const passage = element.contains(range.commonAncestorContainer) ? passageOf(selection.toString()) : null
    if (!passage) { setMarked(null); return }
    const box = range.getBoundingClientRect()
    setMarked({ text: passage, rect: { top: box.top, bottom: box.bottom, left: box.left, right: box.right } })
  }, [])
  useEffect(() => {
    if (!askable || shown === 'page') return
    let timer = 0
    const changed = () => {
      window.clearTimeout(timer)
      if (!dragging.current) timer = window.setTimeout(readSelection, 120)
    }
    const down = (event: PointerEvent) => {
      if (bubble.current?.contains(event.target as Node)) return
      dragging.current = true
      setMarked(null)
    }
    const up = () => {
      if (!dragging.current) return
      dragging.current = false
      window.setTimeout(readSelection, 0)
    }
    document.addEventListener('selectionchange', changed)
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('pointerup', up, true)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('selectionchange', changed)
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('pointerup', up, true)
    }
  }, [askable, shown, readSelection])
  useEffect(() => {
    if (!marked) return
    const away = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      document.getSelection()?.removeAllRanges()
      setCleared((count) => count + 1)
      setMarked(null)
    }
    document.addEventListener('keydown', away, true)
    return () => document.removeEventListener('keydown', away, true)
  }, [marked])

  // Who is asked: the agent who made the file, unless another face in the bubble was chosen for
  // these words. Marking other words asks the maker again.
  const [chosen, setChosen] = useState<{ text: string; agent: string } | null>(null)
  const askee = chosen && marked && chosen.text === marked.text && team.includes(chosen.agent) ? chosen.agent : from
  const others = askee ? team.filter((id) => id !== askee) : NO_TEAM

  // Where the bubble sits over the marked words, in the coordinates of the page's stage it floats on.
  const [size, setSize] = useState(BUBBLE_GUESS)
  useLayoutEffect(() => {
    const element = bubble.current
    if (!element) return
    const measured = { width: element.offsetWidth, height: element.offsetHeight }
    if (measured.width && (measured.width !== size.width || measured.height !== size.height)) setSize(measured)
  }, [marked, size, others.length])
  const [place, setPlace] = useState<ReturnType<typeof bubblePlace> | null>(null)
  useLayoutEffect(() => {
    const box = stage.current?.getBoundingClientRect()
    setPlace(marked && box ? bubblePlace(marked.rect, { top: box.top, left: box.left, width: box.width }, { top: 0, left: 0 }, size) : null)
  }, [marked, size])

  const ask = (words?: string) => {
    if (!marked || !from || !askee || !onAsk) return
    const reply = passageReply({ path, runId: file.runId, from }, marked.text)
    flyToMessageBox(bubble.current, marked.text)
    onAsk(reply, words, askee)
    document.getSelection()?.removeAllRanges()
    setCleared((count) => count + 1)
    setMarked(null)
    setHint(false)
    try { window.localStorage.setItem(HINT_KEY, 'seen') } catch { /* The tip shows again next time. */ }
  }

  // The parts asked about: lit in the text, each with the face of the agent asked in the margin.
  const mine = useMemo(() => {
    const byText = new Map<string, AskedPassage>()
    for (const passage of asked) if (passage.file === path) byText.set(passage.text, passage)
    return [...byText.values()]
  }, [asked, path])
  const [focus, setFocus] = useState<string | null>(null)
  const [pins, setPins] = useState<Pin[]>([])
  // The same faces in the same places are no change, so laying them out again settles.
  const placePins = useCallback((next: Pin[]) => setPins((current) => (
    current.length === next.length && current.every((pin, index) => pin.passage === next[index].passage && pin.top === next[index].top) ? current : next
  )), [])
  const [pinsLeft, setPinsLeft] = useState(4)
  const [layout, setLayout] = useState(0)
  useEffect(() => {
    const element = page.current
    if (!element) return
    let pending = 0
    const again = () => { cancelAnimationFrame(pending); pending = requestAnimationFrame(() => setLayout((count) => count + 1)) }
    const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(again)
    resized?.observe(element)
    // Markdown arrives a moment after the page: the parts are found once it has.
    const changed = typeof MutationObserver === 'undefined' ? null : new MutationObserver(again)
    changed?.observe(element, { childList: true, subtree: true, characterData: true })
    return () => { cancelAnimationFrame(pending); resized?.disconnect(); changed?.disconnect() }
  }, [shown, text])
  useLayoutEffect(() => {
    const element = page.current
    const scrolling = scroller.current
    const registry = typeof CSS !== 'undefined' ? (CSS as unknown as { highlights?: Map<string, unknown> }).highlights : undefined
    const lit = (key: string, ranges: Range[]) => {
      if (!registry || typeof Highlight === 'undefined') return
      if (ranges.length) registry.set(key, new Highlight(...ranges))
      else registry.delete(key)
    }
    if (!element || !scrolling || shown === 'page' || !words) { placePins([]); return }
    const text = pageText(element)
    const found = mine.flatMap((passage) => {
      const range = findPassage(text, passage.text)
      return range ? [{ passage, range }] : []
    })
    lit('lw-read-asked', found.map((item) => item.range))
    const askingRange = asking ? findPassage(text, asking) : null
    lit('lw-read-asking', askingRange ? [askingRange] : [])
    const focusRange = focus ? found.find((item) => item.passage.text === focus)?.range ?? null : null
    lit('lw-read-focus', focusRange ? [focusRange] : [])
    const top = scrolling.getBoundingClientRect().top - scrolling.scrollTop
    let last = -Infinity
    placePins(found
      .map((item) => ({ passage: item.passage, top: (item.range.getClientRects()[0] ?? item.range.getBoundingClientRect()).top - top }))
      .sort((a, b) => a.top - b.top)
      .map((pin) => { last = Math.max(pin.top, last + 28); return { ...pin, top: last } }))
    const padding = Number.parseFloat(getComputedStyle(element).paddingLeft) || 0
    setPinsLeft(Math.max(2, element.offsetLeft + padding - 32))
    return () => { lit('lw-read-asked', []); lit('lw-read-asking', []); lit('lw-read-focus', []) }
  }, [mine, asking, focus, layout, shown, words, text, placePins])

  // The tip under a file, until a part of one has been asked about.
  const [hint, setHint] = useState(() => {
    try { return window.localStorage.getItem(HINT_KEY) !== 'seen' } catch { return true }
  })

  // "Updated" lights for a moment each time the file changes on disk while it is open.
  const [updated, setUpdated] = useState(false)
  const [seenChanges, setSeenChanges] = useState(content.changes)
  if (content.changes !== seenChanges) {
    setSeenChanges(content.changes)
    if (content.changes > 0) setUpdated(true)
  }
  useEffect(() => {
    if (!updated) return
    const timer = window.setTimeout(() => setUpdated(false), UPDATED_MS)
    return () => window.clearTimeout(timer)
  }, [updated, content.changes])

  const fileName = content.file?.name ?? baseName(path)
  const actions = useFileActions(path)
  const modifiedAt = content.file?.modifiedAt ?? content.modifiedAt
  const meta = [
    content.file?.extracted ? `Words from a ${fileLabel(path).toLowerCase()}` : fileLabel(path),
    content.file ? formatBytes(content.file.sizeBytes) : null,
    modifiedAt ? `changed ${relativeTime(new Date(modifiedAt))}` : null,
  ].filter(Boolean).join(' · ')
  const origin = useMemo(() => (file.runId && from ? { runId: file.runId, from } : null), [file.runId, from])
  const pageMarks = useMemo(() => ({ asked: mine.map((passage) => passage.text), asking, focus }), [mine, asking, focus])

  let body: ReactNode
  if (content.error) body = <div className="rd-failed" role="alert"><p>{content.error}</p></div>
  else if (format === 'picture') body = <figure className="rd-picture"><img src={`${rawFileUrl(path)}&v=${encodeURIComponent(modifiedAt ?? '')}`} alt={fileTitle(fileName)} /></figure>
  else if (format === 'media') body = /^(mp3|wav|m4a)$/.test(extensionOf(path))
    ? <audio className="rd-media" controls src={rawFileUrl(path)} />
    : <video className="rd-media" controls src={rawFileUrl(path)} />
  else if (text === null) body = <p className="rd-loading" role="status">Reading {fileName}…</p>
  else if (shown === 'page') body = <PageFrame path={path} name={fileName} html={text} marks={pageMarks} onMarked={setMarked} cleared={cleared} />
  else body = (
    <div ref={page} className={`tc-document-page rd-page rd-as-${shown}${shown === 'markdown' ? ' delivery-response' : ''}`}>
      {shown === 'markdown' ? <Markdown>{withFolderPaths(text)}</Markdown>
        : shown === 'table' ? <TableView text={text} path={path} />
          : shown === 'document' ? <DocumentView text={text} />
            : <CodeView text={text} language={shown === 'code' && format === 'page' ? 'html' : extensionOf(path)} />}
    </div>
  )

  return (
    <FileOriginContext.Provider value={origin}>
    <article className={`rd${updated ? ' updated' : ''}`} aria-label={`${fileName}, read here`}>
      <header className="rd-bar">
        <span className="rd-sheet" aria-hidden="true">
          {createElement(fileIcon(content.file?.kind, path), { size: 15 })}
          {extensionOf(path) && <b>{extensionOf(path).toUpperCase()}</b>}
        </span>
        <div className="rd-bar-words">
          <h3 className="rd-title" title={path}>{fileTitle(fileName)}</h3>
          <p className="rd-meta">
            {updated ? <span className="rd-updated" role="status">Updated just now</span> : <span>{meta}</span>}
            {from && <span className="rd-from"><AvatarFace id={from} hue={hue(from)} size={16} fontSize={7} text={initials(name(from))} />{name(from)}</span>}
          </p>
        </div>
        {format === 'page' && (
          <div className="tc-pane-tabs rd-views" role="tablist" aria-label="Show the page as">
            <button type="button" role="tab" aria-selected={view === 'page'} onClick={() => setView('page')}>Page</button>
            <button type="button" role="tab" aria-selected={view === 'code'} onClick={() => setView('code')}>Code</button>
          </div>
        )}
        <span className="rd-acts">
          <button type="button" className="btn btn-icon" onClick={() => void actions.open()} disabled={actions.busy} aria-label={`Open ${fileName} in its own app`} title="Open in its own app"><ExternalLink size={14} aria-hidden="true" /></button>
          <button type="button" className="btn btn-icon" onClick={() => void actions.open(true)} disabled={actions.busy} aria-label={`Show ${fileName} in its folder`} title="Show in folder"><FolderOpen size={14} aria-hidden="true" /></button>
        </span>
        <span className="visually-hidden" role="status">{actions.said}</span>
      </header>
      {(content.file?.extracted || content.file?.truncated) && (
        <p className="rd-note">
          {content.file.extracted
            ? `These are the words of the ${fileLabel(path).toLowerCase()}, as your agents read them, without its layout. Open it in its own app to see it as it looks.`
            : 'Only the start of this file is shown: it is larger than 2 MB. Open it in its own app for the rest.'}
        </p>
      )}
      <div ref={stage} className="rd-stage">
        <div ref={scroller} className={`rd-scroll${shown === 'page' ? ' rd-scroll-frame' : ' tc-document'}`} onScroll={() => { if (marked) readSelection() }}>
          {body}
          {pins.length > 0 && (
            <div className="rd-pins" data-reader-chrome style={{ left: pinsLeft }}>
              {pins.map(({ passage, top }) => (
                <button key={passage.text} type="button" className="rd-pin" style={{ top }}
                  onMouseEnter={() => setFocus(passage.text)} onMouseLeave={() => setFocus(null)} onFocus={() => setFocus(passage.text)} onBlur={() => setFocus(null)}
                  onClick={() => onShowAsked?.(passage)} disabled={!onShowAsked || !passage.runId}
                  aria-label={`You asked ${name(passage.from)} about “${quoteLine(passage.text).slice(0, 60)}”: ${sentence(passage.asked)} Show the answer`}
                  title={`You asked ${name(passage.from)}: ${passage.asked}`}>
                  <AvatarFace id={passage.from} hue={hue(passage.from)} size={22} fontSize={9} text={initials(name(passage.from))} />
                </button>
              ))}
            </div>
          )}
        </div>
        {askable && marked && place && from && askee && (
          <div ref={bubble} className={`rd-ask${place.below ? ' below' : ''}`} style={{ top: place.top, left: place.left }} role="toolbar" aria-label={`Ask ${name(askee)} about the words you marked`} onMouseDown={(event) => event.preventDefault()}>
            <button type="button" className="rd-ask-main" onClick={() => ask()} title={`Ask ${name(askee)} about this`}>
              <AvatarFace key={askee} id={askee} hue={hue(askee)} size={24} fontSize={9} text={initials(name(askee))} className="rd-ask-face" />
              <span>Ask</span>
            </button>
            <button type="button" className="rd-ask-quick" onClick={() => ask(EXPLAIN_WORDS)} title={`${name(askee)} explains it in plain words`}>Explain</button>
            {others.length > 0 && (
              <span className="rd-ask-others" role="group" aria-label="Or ask someone else">
                {others.map((id) => {
                  const words = id === from ? `Ask ${name(id)}, who made this, instead` : `Ask ${name(id)} instead`
                  return (
                    <button key={id} type="button" className="rd-ask-other" onClick={() => setChosen({ text: marked.text, agent: id })} aria-label={words} title={words}>
                      <AvatarFace id={id} hue={hue(id)} size={20} fontSize={8} text={initials(name(id))} />
                    </button>
                  )
                })}
              </span>
            )}
          </div>
        )}
        {askable && hint && !marked && from && text !== null && (
          <p className="rd-hint" data-reader-chrome>
            <AvatarFace id={from} hue={hue(from)} size={20} fontSize={8} text={initials(name(from))} />
            <span><mark>Mark any words</mark> to ask <b>{name(from)}</b> about them</span>
            <button type="button" className="rd-hint-close" onClick={() => { setHint(false); try { window.localStorage.setItem(HINT_KEY, 'seen') } catch { /* Shown again next time. */ } }} aria-label="Hide this tip"><X size={12} aria-hidden="true" /></button>
          </p>
        )}
      </div>
    </article>
    </FileOriginContext.Provider>
  )
}

/** What was asked, ending as a sentence does: "why?" stays, "explain it" gets its stop. */
function sentence(words: string): string {
  const said = words.trim()
  return /[.!?…]$/.test(said) ? said : `${said}.`
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  return (words.length > 1 ? `${words[0][0]}${words[1][0]}` : name.slice(0, 2)).toUpperCase()
}

/**
 * The marked words fly from the bubble into the message box, so it is plain where the question is
 * now being written. Nothing moves where motion is reduced.
 */
function flyToMessageBox(from: Element | null, text: string) {
  const box = document.querySelector('.tc-composer .tc-box')
  if (!from || !box || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
  const start = from.getBoundingClientRect()
  const end = box.getBoundingClientRect()
  const chip = document.createElement('div')
  if (typeof chip.animate !== 'function') return
  chip.className = 'rd-flight'
  chip.setAttribute('aria-hidden', 'true')
  chip.textContent = quoteLine(text).slice(0, 48)
  chip.style.left = `${start.left}px`
  chip.style.top = `${start.top}px`
  document.body.append(chip)
  const dx = end.left + 18 - start.left
  const dy = end.top + 8 - start.top
  chip.animate([
    { transform: 'translate(0, 0) scale(1)', opacity: 1 },
    { transform: `translate(${dx * 0.45}px, ${dy * 0.45 - 48}px) scale(.94)`, opacity: 1, offset: 0.5 },
    { transform: `translate(${dx}px, ${dy}px) scale(.72)`, opacity: 0 },
  ], { duration: 560, easing: 'cubic-bezier(.3, .7, .2, 1)' }).finished.then(() => chip.remove(), () => chip.remove())
}
