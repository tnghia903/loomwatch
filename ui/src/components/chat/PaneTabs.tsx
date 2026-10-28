import { X } from 'lucide-react'
import { createElement, Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'

import { paneTabId, type MadeTab, type PaneTab } from '../../lib/chat/paneTabs'
import { fileIcon } from '../../lib/files/icons'
import { AvatarFace } from '../agents/AvatarFace'

/** A file's name with its extension apart, so a narrowed tab still says what kind of file it is. */
function nameParts(label: string): [string, string] {
  const dot = label.lastIndexOf('.')
  return dot > 0 && label.length - dot <= 6 ? [label.slice(0, dot), label.slice(dot)] : [label, '']
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  return (words.length > 1 ? `${words[0][0]}${words[1][0]}` : name.slice(0, 2)).toUpperCase()
}

/**
 * The pane's tabs: what the agents said to each other on the piece (`replies`, in a team's chat),
 * and its record; its long answer as the chat shows a message, by the figure and name of who gave
 * it, shaped as a bubble and set apart; then each file it made, by its own name and the mark of its
 * kind. Each made tab has its own close. When they outgrow the pane the made tabs scroll under the
 * piece's own two, which stay put; the side with more fades, and the one on screen is kept in view.
 */
export function PaneTabs({ tabs, shown, replies = false, hue, onShow, onClose }: { tabs: readonly MadeTab[]; shown: PaneTab; replies?: boolean; hue: (id: string) => number; onShow: (tab: PaneTab) => void; onClose: (made: MadeTab) => void }) {
  const list = useRef<HTMLDivElement>(null)
  const shownId = paneTabId(tabs, shown)
  const [more, setMore] = useState<{ before: boolean; after: boolean; pin: number }>({ before: false, after: false, pin: 0 })
  const measure = useCallback(() => {
    const strip = list.current
    if (!strip) return
    // Where Details ends, from the strip's outer edge, where its fade is measured from.
    const details = strip.querySelector<HTMLElement>('#tc-pane-details')
    const pin = details ? Math.round(details.getBoundingClientRect().right - strip.getBoundingClientRect().left) : 0
    const next = { before: strip.scrollLeft > 1, after: strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1, pin }
    setMore((now) => (now.before === next.before && now.after === next.after && now.pin === next.pin ? now : next))
  }, [])
  useLayoutEffect(() => {
    const strip = list.current
    if (!strip) return
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const resized = new ResizeObserver(measure)
    resized.observe(strip)
    return () => resized.disconnect()
  }, [measure, tabs.length])
  useEffect(() => {
    const strip = list.current
    const button = strip?.querySelector<HTMLElement>(`#${shownId}`)
    const tab = button?.closest<HTMLElement>('.tc-pane-file')
    if (!strip || !tab) return
    // Only the strip scrolls: scrollIntoView would move the pane and the page with it. A tab is
    // brought clear of Details, which stays over the strip's start, and of the strip's own padding.
    const pad = parseFloat(getComputedStyle(strip).paddingLeft) || 0
    const start = tab.offsetLeft - more.pin - pad
    const end = tab.offsetLeft + tab.offsetWidth + pad
    if (start < strip.scrollLeft) strip.scrollLeft = Math.max(0, start)
    else if (end > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = end - strip.clientWidth
    measure()
  }, [shownId, more.pin, measure])
  const fade = [more.before && 'before', more.after && 'after'].filter(Boolean).join(' ') || undefined
  return (
    // A mouse wheel turns the strip too, as a trackpad's sideways swipe does.
    <div className="tc-pane-tabs" role="tablist" aria-label="Show" ref={list} data-more={fade} style={{ '--tc-pane-pin': `${more.pin}px` } as CSSProperties}
      onScroll={measure} onWheel={(event) => { if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) event.currentTarget.scrollLeft += event.deltaY }}>
      <span className="tc-pane-own">
        {replies && <button type="button" role="tab" id="tc-pane-replies" aria-selected={shown === 'replies'} aria-controls="tc-pane-body" onClick={() => onShow('replies')}>Replies</button>}
        <button type="button" role="tab" id="tc-pane-details" aria-selected={shown === 'details'} aria-controls="tc-pane-body" onClick={() => onShow('details')}>Details</button>
      </span>
      {tabs.map((made, at) => {
        const [stem, extension] = made.file ? nameParts(made.label) : [made.label, '']
        const said = made.file ? made.label : `${made.label}’s answer`
        return (
          <Fragment key={made.tab}>
            <span className={`tc-pane-file${made.file ? '' : ' said'}${shown === made.tab ? ' shown' : ''}`}>
              <button type="button" role="tab" id={`tc-pane-made-${at}`} className={made.by ? `hue-${hue(made.by)}` : undefined} aria-selected={shown === made.tab} aria-controls="tc-pane-body" onClick={() => onShow(made.tab)} aria-label={made.file ? undefined : said} title={made.file ? made.hint : `${said}\n${made.hint}`}>
                {made.file
                  ? createElement(fileIcon(made.kind, made.file.path), { size: 13, 'aria-hidden': true })
                  : made.by && <AvatarFace id={made.by} hue={hue(made.by)} size={22} fontSize={9} text={initials(made.label)} className="tc-pane-face" />}
                <span className="tc-pane-label"><span className="tc-pane-name">{stem}</span>{extension && <span className="tc-pane-ext">{extension}</span>}</span>
              </button>
              <button type="button" className="tc-pane-file-close" onClick={() => onClose(made)} aria-label={`Close ${said}`} title={`Close ${said}`}><X size={11} aria-hidden="true" /></button>
            </span>
            {!made.file && at < tabs.length - 1 && <i className="tc-pane-split" aria-hidden="true" />}
          </Fragment>
        )
      })}
    </div>
  )
}
