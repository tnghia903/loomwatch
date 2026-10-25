import { ExternalLink, FolderOpen, X } from 'lucide-react'
import { createElement, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import type { PartAt, ReplyTo } from '../../lib/chat/client'
import type { AgentFacts } from '../../lib/chat/faces'
import { quoteLine } from '../../lib/chat/reply'
import { baseName, extensionOf, fileLabel, fileTitle, formatBytes, withFolderPaths } from '../../lib/files/fileRefs'
import { fileIcon } from '../../lib/files/icons'
import { answerRead, markAnswerRead } from '../../lib/files/answersRead'
import { markParts, type MarkedPart, type PartMarks } from '../../lib/files/partMarks'
import type { PageMark, PagePart } from '../../lib/files/pageFrame'
import { answerPlace, askKey, bubbleAgent, bubbleCardParts, bubbleLabel, bubblePlace, bubbleTitle, fileAsks, findPassage, pageText, partBox, partId, partLines, partLook, partTexts, passageOf, passageReply, wordsLook, wordsOpen, type AskedPassage, type PartLook } from '../../lib/files/passage'
import { partPictureName, pictureInside } from '../../lib/files/parts'
import { figureStill } from '../../lib/library/figures'
import { wearerOf } from '../../lib/chat/helpers'
import { TeamFiguresContext } from '../agents/figureContext'
import { useFigurePictures } from './useFigurePictures'
import { canMark, FileOriginContext, rawFileUrl, readerFormat, type FileToRead } from '../../lib/files/reader'
import { useFileActions } from '../../lib/files/useFile'
import { useFileText } from '../../lib/files/useFileText'
import { relativeTime } from '../../lib/format'
import { AvatarFace } from '../agents/AvatarFace'
import { AgentCardPopup } from '../chat/AgentFace'
import { useAgentCard } from '../../lib/chat/useAgentCard'
import { InlineMarkdown, Markdown } from '../ui/Markdown'
import { plainWords } from '../../lib/chat/findWords'
import { CodeView, DocumentView, TableView } from './formats'
import { PageFrame, type Marked } from './PageFrame'
import { PassageAnswer } from './PassageAnswer'
import { PartBubble } from './PartBubble'
import { PictureView } from './PictureView'

export interface FileReaderProps {
  file: FileToRead
  name: (id: string) => string
  hue: (id: string) => number
  /**
   * Ask `agent` about a marked part: put it in the message box with its quote, or send `words` about
   * it at once. A part that isn't words comes with its `pictures` (ADR 0091), to send with it.
   */
  onAsk?: (reply: ReplyTo, words: string | undefined, agent: string, pictures?: readonly File[]) => void
  /** The team's agents who can be asked instead of the one who made the file, in the team's order. */
  team?: readonly string[]
  /** What an agent on the team is for, so a teammate can be chosen by its job. */
  role?: (id: string) => string
  /** Parts of files asked about in this chat, oldest first; this file's are marked, with a bubble for each agent asked. */
  asked?: readonly AskedPassage[]
  /** The part in the message box now, being asked about. */
  asking?: string | null
  /** Show what came of asking about a part in the chat, where it is kept. */
  onShowAsked?: (passage: AskedPassage) => void
  /** The team's agents as the chat's cards show them: pointing at a bubble opens its agent's card. */
  faces?: readonly AgentFacts[]
}

/** What Explain sends: one press for the commonest question a newcomer has. */
export const EXPLAIN_WORDS = 'Explain this part in plain words.'
/** The tip under a file until the first part is asked about, kept for this browser. */
const HINT_KEY = 'loomwatch.readerHint'
/** The same for a picture, whose gesture is a drag: a person who has marked words has not learnt it. */
const PICTURE_HINT_KEY = 'loomwatch.readerHint.picture'
/** How long "Updated" stays lit after the file changed on disk. */
const UPDATED_MS = 2_400
/** The ask bubble's size before it has been measured. */
const BUBBLE_GUESS = { width: 168, height: 40 }
/** How long a part asked just now sweeps on and pops its bubble, before it is drawn as any other. */
const FRESH_MS = 1_400
/** The answer's size before it has been measured. */
const ANSWER_GUESS = { width: 360, height: 96 }
const NO_PASSAGES: readonly AskedPassage[] = []
const NO_TEAM: readonly string[] = []
const NO_FACES: readonly AgentFacts[] = []
/** Teammates' faces shown in the bubble beside the one asked; past this the rest are a list away. */
const FACES_SHOWN = 3
type Rect = Marked['rect']
/** Where the parts asked about are on screen, the box of the file in view, and the slots their bubbles go in. */
interface Measured { page: boolean; parts: readonly PagePart[]; view: Rect; slots: ReadonlyMap<string, HTMLElement> }
const NO_SLOTS: ReadonlyMap<string, HTMLElement> = new Map()
const sameMeasure = (a: Measured, b: Measured) => a.page === b.page && JSON.stringify([a.parts, a.view]) === JSON.stringify([b.parts, b.view])
  && a.slots.size === b.slots.size && [...a.slots].every(([key, slot]) => b.slots.get(key) === slot)

/**
 * A file an agent made, read inside LoomWatch beside the chat it came from (ADR 0077): a report as a
 * document, a web page as itself, a table as a sheet, code by line, a PDF's or Word file's words.
 *
 * Mark any words and the agent's own face leans in over them: Ask puts them in the message box as a
 * quote, addressed to that agent, and Explain asks for them in plain words at once. The answer opens
 * beside the part as it is sent, and fills in when the agent has answered; Reply under it writes back
 * about the same part, and the answer to that shows under the first. A part asked about stays
 * lit in the file, with the agent's face in the margin: the face, or the lit words, open its answer
 * again. The file is read again whenever it changes on disk, so a part the agent was asked to change
 * is seen changed.
 */
export function FileReader({ file, name, hue, onAsk, team = NO_TEAM, role, asked = NO_PASSAGES, asking = null, onShowAsked, faces = NO_FACES }: FileReaderProps) {
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
    // A web page reports its own marked words; a picture marks a box itself (PictureView).
    if (!askable || shown === 'page' || !words) return
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
  }, [askable, shown, words, readSelection])
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
  // A part that isn't words is let go of as marked words are: by pressing anywhere else. A press on
  // the picture itself marks again there (PictureView).
  const markedAt = Boolean(marked?.at)
  useEffect(() => {
    if (!markedAt) return
    const elsewhere = (event: PointerEvent) => {
      const target = event.target as Node
      if (bubble.current?.contains(target) || page.current?.contains(target)) return
      setMarked(null)
    }
    document.addEventListener('pointerdown', elsewhere, true)
    return () => document.removeEventListener('pointerdown', elsewhere, true)
  }, [markedAt])

  // Who is asked: the agent who made the file, unless another face in the bubble was chosen for
  // this part. Marking another part asks the maker again.
  const markedId = marked ? partId(marked) : null
  const [chosen, setChosen] = useState<{ part: string; agent: string } | null>(null)
  const askee = chosen && chosen.part === markedId && team.includes(chosen.agent) ? chosen.agent : from
  const others = askee ? team.filter((id) => id !== askee) : NO_TEAM
  // A small team shows every face. A big one shows the maker (a press back to the default) and the
  // first of the rest in the team's order; everyone, with what each is for, is a list away.
  const shownFaces = others.length <= FACES_SHOWN + 1 ? others
    : [...others.filter((id) => id === from), ...others.filter((id) => id !== from)].slice(0, FACES_SHOWN)
  const unshown = others.length - shownFaces.length
  const [listFor, setListFor] = useState<string | null>(null)
  const listing = Boolean(markedId !== null && unshown > 0 && listFor === markedId)
  const choose = (agent: string) => {
    if (markedId === null) return
    setChosen({ part: markedId, agent })
    setListFor(null)
  }

  // Where the bubble sits over the marked words, in the coordinates of the page's stage it floats on.
  const [size, setSize] = useState(BUBBLE_GUESS)
  useLayoutEffect(() => {
    const element = bubble.current
    if (!element) return
    const measured = { width: element.offsetWidth, height: element.offsetHeight }
    if (measured.width && (measured.width !== size.width || measured.height !== size.height)) setSize(measured)
  }, [marked, size, others.length, listing])
  const [place, setPlace] = useState<ReturnType<typeof bubblePlace> | null>(null)
  useLayoutEffect(() => {
    const box = stage.current?.getBoundingClientRect()
    setPlace(marked && box ? bubblePlace(marked.rect, { top: box.top, left: box.left, width: box.width }, { top: 0, left: 0 }, size) : null)
  }, [marked, size])
  // Marked from the keyboard (Enter on the picture): the keyboard goes on to Ask, once it is there.
  useEffect(() => {
    if (marked?.at && place && page.current?.contains(document.activeElement)) bubble.current?.querySelector<HTMLButtonElement>('.rd-ask-main')?.focus()
  }, [marked, place])

  // What a part that isn't words is seen as, sent with the question: the picture inside its box.
  const picturesOf = async (at: PartAt): Promise<File[]> => {
    const image = page.current?.querySelector('img')
    const picture = image ? await pictureInside(image, at, partPictureName(baseName(path))) : null
    return picture ? [picture] : []
  }
  const askAbout = (reply: ReplyTo, words: string | undefined, agent: string) => {
    if (!onAsk) return
    if (!reply.at) { onAsk(reply, words, agent); return }
    void picturesOf(reply.at).then((pictures) => onAsk(reply, words, agent, pictures))
  }

  const ask = (words?: string) => {
    if (!marked || !from || !askee || !onAsk) return
    const reply = passageReply({ path, runId: file.runId, from }, marked.text, marked.at)
    flyToMessageBox(bubble.current, marked.text)
    askAbout(reply, words, askee)
    document.getSelection()?.removeAllRanges()
    setCleared((count) => count + 1)
    setMarked(null)
    hideHint()
  }

  // The parts asked about: marked in the text, with a bubble after them for each agent asked, each
  // ask known by its key (`askKey`).
  const mine = useMemo(() => fileAsks(asked, path), [asked, path])

  // The answer to one ask, open beside its part: it opens as you send a question about a part of
  // this file, and again from its bubble or the marked words. It steps aside while other words are marked.
  const [answerFor, setAnswerFor] = useState<string | null>(null)
  const answer = answerFor ? mine.find((passage) => askKey(passage) === answerFor) ?? null : null
  const sending = mine.filter((passage) => passage.answer.state === 'sending').map(askKey)
  const [seenSending, setSeenSending] = useState(sending)
  // Asked while the file is open: the stroke sweeps on and the bubble pops up.
  const [fresh, setFresh] = useState<readonly string[]>([])
  if (sending.join('\n') !== seenSending.join('\n')) {
    setSeenSending(sending)
    const sent = sending.find((key) => !seenSending.includes(key))
    if (sent !== undefined) {
      setAnswerFor(sent)
      setFresh((keys) => [...keys, sent])
    }
  }
  useEffect(() => {
    if (fresh.length === 0) return
    const timer = window.setTimeout(() => setFresh([]), FRESH_MS)
    return () => window.clearTimeout(timer)
  }, [fresh])
  const answerShown = answer && !marked ? answer : null
  const shownKey = answerShown ? askKey(answerShown) : null
  // An answer opened beside its part has been read: its bubble loses its dot, here and next time.
  const shownSaid = answerShown?.answer.state === 'said' ? answerShown : null
  const [readHere, setReadHere] = useState<readonly AskedPassage[]>([])
  if (shownSaid && !readHere.includes(shownSaid)) setReadHere((read) => [...read, shownSaid])
  useEffect(() => {
    if (shownSaid) markAnswerRead(shownSaid)
  }, [shownSaid])
  const isRead = (passage: AskedPassage) => readHere.some((read) => read.messageId === passage.messageId && read.text === passage.text && read.answer === passage.answer) || answerRead(passage)
  // How each ask's bubble looks, from what came of asking.
  const looks = new Map(mine.map((passage) => [askKey(passage), partLook(passage.answer, isRead(passage))]))
  const lookOfAsk = (passage: AskedPassage): PartLook => looks.get(askKey(passage)) ?? 'read'

  // The parts asked about, marked in the file in place: their words wrapped in a marker stroke, and
  // the bubbles of the agents asked in a slot after the last word, so the line makes room for them.
  // The reader marks its own text (lib/files/partMarks.ts); a web page marks itself (pageFrame.ts)
  // and says where its parts are. A part the file no longer has is `missing`.
  // Marked again only when the words change, not when an answer comes in or another agent is asked.
  // A picture's parts are boxes, each known by its id (`partId`); a file of words marks its words.
  const partsKey = (words ? partTexts(mine.filter((passage) => !passage.at)) : partTexts(mine.filter((passage) => passage.at).map((passage) => ({ text: partId(passage) })))).join('\u0000')
  const texts = useMemo(() => (partsKey ? partsKey.split('\u0000') : []), [partsKey])
  const [measured, setMeasured] = useState<Measured | null>(null)
  const takeMeasured = useCallback((next: Measured) => setMeasured((current) => (current && sameMeasure(current, next) ? current : next)), [])
  const takeParts = useCallback((parts: PagePart[], view: Rect) => takeMeasured({ page: true, parts, view, slots: NO_SLOTS }), [takeMeasured])
  // What was measured in the view now on screen: the page's own report, or the text's.
  const onScreen = measured && measured.page === (shown === 'page') ? measured : null
  const [focus, setFocus] = useState<string | null>(null)
  const marks = useRef<PartMarks | null>(null)
  const found = useRef<ReadonlySet<string>>(new Set())
  const changes = useRef<MutationObserver | null>(null)
  const measure = useCallback(() => {
    const element = page.current
    const scrolling = scroller.current
    if (!element || !scrolling) return
    const box = scrolling.getBoundingClientRect()
    // What is in view: the scroller less its scroll bars.
    const view = { top: box.top, left: box.left, right: box.left + (scrolling.clientWidth || box.width), bottom: box.top + (scrolling.clientHeight || box.height) }
    if (!words) {
      // A picture draws its boxes itself (PictureView), each with the slot for its bubbles.
      const boxes = new Map([...element.querySelectorAll<HTMLElement>('.rd-box[data-part]')].map((drawn) => [drawn.dataset.part ?? '', drawn]))
      takeMeasured({
        page: false,
        parts: texts.map((id) => {
          const rect = boxes.get(id)?.getBoundingClientRect()
          return { text: id, rects: rect ? [{ top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }] : [], missing: !rect, as: id, dark: false }
        }),
        view,
        slots: new Map([...boxes].flatMap(([id, drawn]) => { const slot = drawn.querySelector<HTMLElement>('.rd-slot'); return slot ? [[id, slot] as const] : [] })),
      })
      return
    }
    const dark = darkBehind(element)
    const marked = marks.current?.parts ?? new Map<string, MarkedPart>()
    takeMeasured({
      page: false,
      parts: texts.map((text) => ({
        text,
        rects: (marked.get(text)?.marks ?? []).flatMap((mark) => [...mark.getClientRects()].map((rect) => ({ top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }))),
        missing: !found.current.has(text),
        as: marked.get(text)?.key ?? text,
        dark,
      })),
      view,
      slots: new Map([...marked].map(([key, part]) => [key, part.slot])),
    })
  }, [texts, takeMeasured, words])
  // A click on marked words, with nothing marked now, opens an answer to them (`wordsOpen`).
  const openAt = (event: { target: EventTarget }) => {
    if (document.getSelection()?.isCollapsed === false) return
    const mark = event.target instanceof Element ? event.target.closest<HTMLElement>('.rd-mark') : null
    const part = mark?.dataset.part ? marks.current?.parts.get(mark.dataset.part) : undefined
    const opens = part && wordsOpen(mine.filter((passage) => marks.current?.parts.get(passage.text) === part), lookOfAsk)
    if (opens) setAnswerFor(askKey(opens))
  }
  const [layout, setLayout] = useState(0)
  useEffect(() => {
    const element = page.current
    if (!element) return
    let pending = 0
    const again = () => { cancelAnimationFrame(pending); pending = requestAnimationFrame(() => setLayout((count) => count + 1)) }
    const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(again)
    resized?.observe(element)
    // Markdown arrives a moment after the page: the parts are found once it has. A bubble drawn in
    // its slot is no change to the file.
    const inSlot = (node: Node) => Boolean((node instanceof Element ? node : node.parentElement)?.closest('.rd-slot'))
    const changed = typeof MutationObserver === 'undefined' ? null : new MutationObserver((records) => { if (records.some((record) => !inSlot(record.target))) again() })
    changed?.observe(element, { childList: true, subtree: true, characterData: true })
    changes.current = changed
    return () => { cancelAnimationFrame(pending); resized?.disconnect(); changed?.disconnect(); changes.current = null }
  }, [shown, text])
  useLayoutEffect(() => {
    const element = page.current
    const registry = typeof CSS !== 'undefined' ? (CSS as unknown as { highlights?: Map<string, unknown> }).highlights : undefined
    const lit = (key: string, ranges: Range[]) => {
      if (!registry || typeof Highlight === 'undefined') return
      if (ranges.length) registry.set(key, new Highlight(...ranges))
      else registry.delete(key)
    }
    if (shown === 'page' || !element || !words) return
    const texts = partsKey ? partsKey.split('\u0000') : []
    const ranges = texts.flatMap((key) => {
      const range = findPassage(pageText(element), key)
      return range ? [{ key, range }] : []
    })
    found.current = new Set(ranges.map((part) => part.key))
    const marked = markParts(ranges, { mark: 'rd-mark', slot: 'rd-slot' })
    marks.current = marked
    // Our own marks are no change to the file.
    changes.current?.takeRecords()
    measure()
    const askingRange = asking ? findPassage(pageText(element), asking) : null
    lit('lw-read-asking', askingRange ? [askingRange] : [])
    return () => {
      lit('lw-read-asking', [])
      marks.current = null
      marked.undo()
      changes.current?.takeRecords()
    }
  }, [partsKey, asking, layout, shown, words, text, measure])
  // A picture's boxes are measured as they are drawn, and again as the picture is laid out.
  useLayoutEffect(() => {
    if (!words) measure()
  }, [words, layout, measure])

  // How each part's words look, from what came of the asks on them: set on its marks as it changes.
  const dark = onScreen?.parts[0]?.dark ?? false
  const wordsLookOf = (keys: readonly string[]) => {
    const asks = mine.filter((passage) => keys.includes(partId(passage))).map(askKey)
    return `${wordsLook(asks.map((key) => looks.get(key) ?? 'read'))}${dark ? ' on-dark' : ''}${asks.some((key) => fresh.includes(key)) ? ' fresh' : ''}${asks.some((key) => key === shownKey || key === focus) ? ' lit' : ''}`
  }
  useLayoutEffect(() => {
    showLooks(marks.current, wordsLookOf, dark)
    changes.current?.takeRecords()
  })

  const inView = onScreen?.view ?? null
  const openPart = answerShown ? onScreen?.parts.find((part) => part.text === partId(answerShown)) ?? null : null
  const answerLost = Boolean(openPart?.missing)
  // An earlier part shown with the newer one that overlaps it: its answer says which words it is about.
  const answerAbout = answerShown && !answerShown.at && openPart?.as && openPart.as !== answerShown.text ? answerShown.text : null
  const answerPart = useMemo(() => {
    const box = openPart && !openPart.missing ? partBox(partLines(openPart.rects)) : null
    // Out of the view's sight, it has nothing to point at.
    return box && inView && box.bottom > inView.top && box.top < inView.bottom ? box : null
  }, [openPart, inView])

  const card = useRef<HTMLElement>(null)
  const [cardSize, setCardSize] = useState(ANSWER_GUESS)
  const [answerAt, setAnswerAt] = useState<ReturnType<typeof answerPlace>>(null)
  const [answerMax, setAnswerMax] = useState(320)
  useLayoutEffect(() => {
    const element = card.current
    if (!element) return
    const measured = { width: element.offsetWidth, height: element.offsetHeight }
    if (measured.width && (measured.width !== cardSize.width || measured.height !== cardSize.height)) setCardSize(measured)
  }, [answerShown, answerPart, answerAt, cardSize])
  useLayoutEffect(() => {
    const box = stage.current?.getBoundingClientRect()
    if (box) setAnswerMax(Math.round(Math.max(140, Math.min(360, box.height * 0.5))))
    setAnswerAt((current) => {
      const next = !box ? null
        : answerLost ? { top: 12, left: Math.max(8, (box.width - cardSize.width) / 2), above: false, arrow: 0 }
          : answerPart ? answerPlace(answerPart, { top: box.top, left: box.left, width: box.width, height: box.height }, cardSize) : null
      return JSON.stringify(current) === JSON.stringify(next) ? current : next
    })
  }, [answerPart, answerLost, cardSize])
  useEffect(() => {
    if (!answerShown) return
    const away = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const target = event.target as HTMLElement | null
      // Escape in the message box is the message box's.
      if (target?.closest?.('input, textarea, [contenteditable="true"]') && !card.current?.contains(target)) return
      // It closes the answer, and only the answer: not the pane the file is read in too.
      event.preventDefault()
      event.stopPropagation()
      setAnswerFor(null)
    }
    document.addEventListener('keydown', away)
    return () => document.removeEventListener('keydown', away)
  }, [answerShown])
  const toggleAnswer = (key: string) => setAnswerFor((open) => (open === key ? null : key))

  // The card of the agent whose bubble is pointed at, as the chat shows it when its face is: who it
  // is, what it is doing, and what you asked it here.
  const agentCard = useAgentCard()
  const cardId = useId()
  const [cardFor, setCardFor] = useState<string | null>(null)
  const factsOf = (id: string) => faces.find((facts) => facts.id === id) ?? faces.find((facts) => facts.id === wearerOf(id)) ?? null
  const hasCard = (passage: AskedPassage) => Boolean(factsOf(bubbleAgent(passage)))
  const cardAt = (key: string, at: { top: number; bottom: number; left: number } | null, now: boolean) => {
    if (!at) {
      if (now) agentCard.shut()
      else agentCard.close()
      return
    }
    setCardFor(key)
    if (now) agentCard.open(at)
    else agentCard.rest(() => at)
  }
  const cardAsk = agentCard.shown && cardFor ? mine.find((passage) => askKey(passage) === cardFor) ?? null : null
  const cardFacts = cardAsk ? factsOf(bubbleAgent(cardAsk)) : null
  const cardLine = cardAsk ? bubbleCardParts(cardAsk, lookOfAsk(cardAsk), name) : null
  const closeAnswer = () => setAnswerFor(null)
  // The open answer's talk before it: what the same agent was asked about the same words, oldest first.
  const earlierTalk = answerShown ? asked.filter((passage) => passage !== answerShown && passage.file === path && askKey(passage) === shownKey) : NO_PASSAGES
  // Reply under an answer is one more ask about the same part, to the agent that answered, written
  // in the message box as Ask writes it: the agent is handed the part and its file again, and its
  // answer shows here, under the talk before it.
  const replyAbout = (passage: AskedPassage, button: HTMLElement) => {
    if (!from || !onAsk) return
    flyToMessageBox(button, passage.text)
    askAbout(passageReply({ path, runId: file.runId, from }, passage.text, passage.at), undefined, bubbleAgent(passage))
  }

  // The tip under a file, until a part of one has been asked about.
  const hintKey = words ? HINT_KEY : PICTURE_HINT_KEY
  const unseen = useMemo(() => {
    try { return window.localStorage.getItem(hintKey) !== 'seen' } catch { return true }
  }, [hintKey])
  const [hidden, setHidden] = useState<readonly string[]>([])
  const hint = unseen && !hidden.includes(hintKey)
  const hideHint = () => {
    setHidden((keys) => [...keys, hintKey])
    try { window.localStorage.setItem(hintKey, 'seen') } catch { /* The tip shows again next time. */ }
  }

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
  // A web page marks its own parts (lib/files/pageFrame.ts), told how each looks and handed its
  // agent's figure as a picture it can show.
  const figures = useContext(TeamFiguresContext)
  const figureOf = (id: string) => figures.get(id) ?? figures.get(wearerOf(id)) ?? null
  const pictures = useFigurePictures(shown === 'page' ? mine.flatMap((passage) => { const figure = figureOf(bubbleAgent(passage)); return figure ? [figureStill(figure)] : [] }) : [])
  const pageMarksSaid = JSON.stringify({
    parts: mine.filter((passage) => !passage.at).map((passage): PageMark => {
      const key = askKey(passage)
      const by = bubbleAgent(passage)
      const figure = figureOf(by)
      const look = lookOfAsk(passage)
      return {
        key, text: passage.text, look, fresh: fresh.includes(key), lit: key === shownKey || key === focus, open: key === shownKey,
        // With the agent's card to show on hover, the page's own tooltip would cover it.
        label: bubbleLabel(passage, look, name), title: hasCard(passage) ? '' : bubbleTitle(passage, look, name),
        // An agent with a figure shows nothing until its picture is in; one without shows its initials.
        figure: figure ? pictures.get(figureStill(figure)) ?? null : null, initials: figure ? '' : initials(name(by)),
      }
    }),
    asking,
  })
  const pageMarks = useMemo(() => JSON.parse(pageMarksSaid) as { parts: PageMark[]; asking: string | null }, [pageMarksSaid])
  // The marks move with the text: measured again on the next frame after a scroll.
  const scrolled = useRef(0)
  const onScroll = () => {
    if (marked) readSelection()
    if (shown === 'page' || scrolled.current) return
    scrolled.current = requestAnimationFrame(() => { scrolled.current = 0; measure() })
  }

  let body: ReactNode
  if (content.error) body = <div className="rd-failed" role="alert"><p>{content.error}</p></div>
  else if (format === 'picture') body = (
    <div ref={page} className="rd-page rd-as-picture">
      <PictureView src={`${rawFileUrl(path)}&v=${encodeURIComponent(modifiedAt ?? '')}`} alt={fileTitle(fileName)} askable={askable} asking={asking} marking={marked?.at ?? null} onMarked={setMarked}
        boxes={texts.flatMap((id) => { const at = mine.find((passage) => partId(passage) === id)?.at; return at ? [{ id, at, look: wordsLookOf([id]) }] : [] })}
        onOpen={(id) => { const opens = wordsOpen(mine.filter((passage) => partId(passage) === id), lookOfAsk); if (opens) setAnswerFor(askKey(opens)) }} />
    </div>
  )
  else if (format === 'media') body = /^(mp3|wav|m4a)$/.test(extensionOf(path))
    ? <audio className="rd-media" controls src={rawFileUrl(path)} />
    : <video className="rd-media" controls src={rawFileUrl(path)} />
  else if (text === null) body = <p className="rd-loading" role="status">Reading {fileName}…</p>
  else if (shown === 'page') body = <PageFrame path={path} name={fileName} html={text} marks={pageMarks} onMarked={setMarked} onParts={takeParts} onOpen={setAnswerFor} onEscape={closeAnswer} cleared={cleared}
    onHover={(key, at, now) => { const passage = key ? mine.find((item) => askKey(item) === key) : undefined; if (key && passage && hasCard(passage)) cardAt(key, at, now); else cardAt('', null, now) }} />
  else body = (
    // Drawn afresh when the file changes, never updated around the marks in it (lib/files/partMarks.ts).
    <div key={content.changes} ref={page} className={`tc-document-page rd-page rd-as-${shown}${shown === 'markdown' ? ' delivery-response' : ''}`} onClick={openAt}>
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
        <div ref={scroller} className={`rd-scroll${shown === 'page' ? ' rd-scroll-frame' : ' tc-document'}`} onScroll={onScroll}>
          {body}
        </div>
        {[...bubblesIn(onScreen?.slots ?? NO_SLOTS, mine)].map(([slot, asks]) => createPortal(
          asks.map((passage) => {
            const key = askKey(passage)
            return (
              <PartBubble key={key} passage={passage} look={lookOfAsk(passage)} name={name} hue={hue} open={key === shownKey} fresh={fresh.includes(key)}
                lit={key === shownKey || key === focus} onOpen={() => toggleAnswer(key)} onFocus={(on) => setFocus(on ? key : null)}
                onCard={hasCard(passage) ? (at, now) => cardAt(key, at, now) : undefined} cardId={cardAsk && cardFor === key ? cardId : undefined} />
            )
          }),
          slot, slot.dataset.part,
        ))}
        {askable && marked && place && from && askee && (
          <div ref={bubble} className={`rd-ask${place.below ? ' below' : ''}${listing ? ' listing' : ''}`} style={{ top: place.top, left: place.left }} role="toolbar" aria-label={`Ask ${name(askee)} about the ${marked.at ? 'part' : 'words'} you marked`} onMouseDown={(event) => event.preventDefault()}>
            <button type="button" className="rd-ask-main" onClick={() => ask()} title={`Ask ${name(askee)} about this`}>
              <AvatarFace key={askee} id={askee} hue={hue(askee)} size={24} fontSize={9} text={initials(name(askee))} className="rd-ask-face" />
              <span>Ask</span>
            </button>
            <button type="button" className="rd-ask-quick" onClick={() => ask(EXPLAIN_WORDS)} title={`${name(askee)} explains it in plain words`}>Explain</button>
            {others.length > 0 && (
              <span className="rd-ask-others" role="group" aria-label="Or ask someone else">
                {shownFaces.map((id) => {
                  const words = id === from ? `Ask ${name(id)}, who made this, instead` : `Ask ${name(id)} instead`
                  return (
                    <button key={id} type="button" className="rd-ask-other" onClick={() => choose(id)} aria-label={words} title={words}>
                      <AvatarFace id={id} hue={hue(id)} size={20} fontSize={8} text={initials(name(id))} />
                    </button>
                  )
                })}
                {unshown > 0 && (
                  <button type="button" className="rd-ask-more" onClick={() => setListFor(listing ? null : marked.text)} aria-expanded={listing}
                    aria-label={`Everyone on the team: ${unshown} more`} title="Everyone on the team">+{unshown}</button>
                )}
              </span>
            )}
            {listing && (
              <ul className="rd-ask-list" aria-label="Everyone on the team">
                {others.map((id) => {
                  const job = role ? roleLine(role(id)) : ''
                  return (
                    <li key={id}>
                      <button type="button" onClick={() => choose(id)} aria-label={`Ask ${name(id)}${id === from ? ', who made this,' : ''} instead${job ? `: ${plainWords(job)}` : ''}`}>
                        <AvatarFace id={id} hue={hue(id)} size={22} fontSize={8} text={initials(name(id))} />
                        <span className="rd-ask-who"><b>{name(id)}</b>{id === from && <i>made this</i>}</span>
                        {job && <span className="rd-ask-job" title={plainWords(job)}><InlineMarkdown clickable={false}>{job}</InlineMarkdown></span>}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )}
        {cardAsk && cardFacts && agentCard.place && (
          <AgentCardPopup id={cardId} facts={cardFacts} place={agentCard.place} leaving={agentCard.phase === 'leaving'}
            hint={cardLine && (cardLine.said || cardLine.words) ? <p className="tc-agent-card-asked">{cardLine.said}{cardLine.said && cardLine.words ? ' · ' : ''}{cardLine.words && <>You asked: <InlineMarkdown>{cardLine.words}</InlineMarkdown></>}</p> : null} />
        )}
        {answerShown && (answerPart || answerLost) && (
          <PassageAnswer ref={card} passage={answerShown} earlier={earlierTalk} name={name} hue={hue} place={answerAt} gone={answerLost} maxHeight={answerMax} about={answerAbout}
            onClose={() => setAnswerFor(null)} onShowInChat={onShowAsked && (() => onShowAsked(answerShown))}
            onReply={onAsk && from ? (button) => replyAbout(answerShown, button) : undefined} />
        )}
        {askable && hint && !marked && from && (text !== null || !words) && (
          <p className="rd-hint" data-reader-chrome>
            <AvatarFace id={from} hue={hue(from)} size={20} fontSize={8} text={initials(name(from))} />
            {words ? <span><mark>Mark any words</mark> to ask <b>{name(from)}</b> about them</span>
              : <span><mark className="box">Drag over any part</mark> to ask <b>{name(from)}</b> about it</span>}
            <button type="button" className="rd-hint-close" onClick={hideHint} aria-label="Hide this tip"><X size={12} aria-hidden="true" /></button>
          </p>
        )}
      </div>
    </article>
    </FileOriginContext.Provider>
  )
}

/** An agent's job in a line, as the team list shows it: the first line of its role that is not a
 * heading, whole and with its Markdown (its line cuts it), less a heading's, quote's or list's mark. */
function roleLine(role: string): string {
  const lines = role.split('\n').map((part) => part.trim()).filter(Boolean)
  return (lines.find((part) => !part.startsWith('#')) ?? lines[0] ?? '').replace(/^(#{1,6}\s+|>\s*|[-*+]\s+)/, '')
}

/** How each part's words look, on its marks, from the parts marked with them; and its slot's lightness, for its bubbles. */
function showLooks(marked: PartMarks | null, lookOf: (keys: readonly string[]) => string, dark: boolean) {
  const keys = new Map<MarkedPart, string[]>()
  for (const [key, part] of marked?.parts ?? []) keys.set(part, [...(keys.get(part) ?? []), key])
  for (const [part, of] of keys) {
    const look = lookOf(of)
    for (const mark of part.marks) mark.className = `rd-mark ${look}`
    part.slot.className = `rd-slot${dark ? ' on-dark' : ''}`
  }
}

/** The bubbles in each slot: one for each ask about its words, in the order asked. */
function bubblesIn(slots: ReadonlyMap<string, HTMLElement>, asks: readonly AskedPassage[]): Map<HTMLElement, AskedPassage[]> {
  const shown = new Map<HTMLElement, AskedPassage[]>()
  for (const passage of asks) {
    const slot = slots.get(partId(passage))
    if (slot) shown.set(slot, [...(shown.get(slot) ?? []), passage])
  }
  return shown
}

/** Whether the page behind an element is dark: the first background on the way up that is not see-through. */
function darkBehind(element: Element): boolean {
  for (let at: Element | null = element; at; at = at.parentElement) {
    const colour = /rgba?\(([^)]*)\)/.exec(getComputedStyle(at).backgroundColor)
    const [red, green, blue, alpha = 1] = colour ? colour[1].split(',').map(Number.parseFloat) : []
    if (colour && alpha > 0.5) return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255 < 0.45
  }
  return false
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
