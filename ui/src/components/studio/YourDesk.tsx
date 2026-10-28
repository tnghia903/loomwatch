import { useEffect, useRef, useState } from 'react'

import { figureFor, type FigureChoice } from '../../lib/library/figures'
import type { SavedJob } from '../../lib/library/jobs'
import type { DeskItem } from '../../lib/projects/studio'
import { openNeedsYou } from '../../lib/projects/studioUi'
import { FigureStill } from '../agents/FigureStill'

/** How many of those waiting stand at the desk before "+N". */
const STANDING = 3

/**
 * Your desk, first on Home (ADR 0097): whoever waits for you stands here, glowing gold, with what
 * they brought, and one Review goes through them in turn. It is also where you chat with one of
 * your agents outside any project.
 */
export function YourDesk({ items, jobs, chats, figures }: {
  items: readonly DeskItem[]
  jobs: readonly SavedJob[]
  /** Your agents' own chats with something in them, newest first: "Chat, no project". */
  chats: readonly string[]
  figures: ReadonlyMap<string, FigureChoice | undefined>
}) {
  const [choosing, setChoosing] = useState(false)
  const menu = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!choosing) return
    const away = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) setChoosing(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setChoosing(false) }
    window.addEventListener('pointerdown', away)
    window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('pointerdown', away); window.removeEventListener('keydown', escape) }
  }, [choosing])
  const first = items[0]
  const standing = items.slice(0, STANDING)
  const figure = (item: DeskItem) => figureFor(item.seat.agent ?? item.seat.id, item.seat.agent ? figures.get(item.seat.agent) : undefined)
  const chat = chats.map((id) => jobs.find((job) => job.id === id)).find(Boolean)
  return (
    <section className="your-desk" aria-labelledby="your-desk-title">
      <h2 id="your-desk-title">Your desk</h2>
      <div className="desk-waiting">
        {first ? (
          <>
            <span className="desk-crowd" aria-hidden="true">
              {standing.map((item) => (
                <span key={item.key} className="desk-figure" data-glow="waiting"><FigureStill figure={figure(item)} alt="" width={48} height={48} decoding="async" /></span>
              ))}
            </span>
            <span className="desk-says">
              <b>{first.seat.name} {first.says}</b>
              <span className="desk-waiting-line">{first.teamName} · waiting for you{items.length > 1 ? ` · ${items.length - 1} more` : ''}</span>
            </span>
            <button type="button" className="btn btn-primary" onClick={openNeedsYou}>Review</button>
          </>
        ) : (
          <span className="desk-quiet">Nothing is waiting for you.</span>
        )}
      </div>
      <span className="desk-divider" aria-hidden="true" />
      <div className="desk-chat" ref={menu}>
        {chat && (
          <a className="desk-chat-open" href={`/agents/${encodeURIComponent(chat.id)}?view=chat`}>
            <span className="desk-figure" data-glow="ready"><FigureStill figure={figureFor(chat.id, chat.figure)} alt="" width={36} height={36} decoding="async" /></span>
            <span><b>{chat.name}</b><span className="desk-chat-says">Chat, no project</span></span>
          </a>
        )}
        <button type="button" className="btn" aria-expanded={choosing} aria-haspopup="menu" onClick={() => setChoosing((value) => !value)}>Chat with one agent</button>
        {choosing && (
          <div className="desk-chat-menu" role="menu" aria-label="Chat with one agent">
            {jobs.length === 0 && <a role="menuitem" href="/agents/new">Build an agent first</a>}
            {jobs.map((job) => (
              <a key={job.id} role="menuitem" href={`/agents/${encodeURIComponent(job.id)}?view=chat`}>
                <FigureStill figure={figureFor(job.id, job.figure)} headOnly alt="" width={22} height={22} decoding="async" />
                {job.name}
              </a>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
