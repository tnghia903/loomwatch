import { useEffect, useRef, useState } from 'react'

import { figureFor, type FigureChoice } from '../../lib/library/figures'
import type { SavedJob } from '../../lib/library/jobs'
import type { MadeFile } from '../../lib/projects/glance'
import { FigureStill } from '../agents/FigureStill'
import { FileChip } from '../ui/FileChip'

/** How many of the newest files the row shows, and how many chats. */
const FILES = 4
const CHATS = 2

/**
 * Where you left off, on Home (ADR 0097): the newest things your agents made, each one press from
 * being read, your newest chats with one agent, and a way to chat with any of them. Before there is
 * anything to pick up, it is that way alone.
 */
export function PickUp({ files, chats, jobs, figures }: {
  files: readonly MadeFile[]
  /** Your agents' own chats with something in them, newest first. */
  chats: readonly string[]
  jobs: readonly SavedJob[]
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
  const recent = [...new Set(chats)].map((id) => jobs.find((job) => job.id === id)).filter((job): job is SavedJob => Boolean(job)).slice(0, CHATS)
  const anything = files.length > 0 || recent.length > 0
  const row = (
    <div className="pick-up-row" ref={menu}>
      {files.slice(0, FILES).map((file) => <span key={file.path} className="pick-up-file"><FileChip path={file.path} /></span>)}
      {recent.map((job) => (
        // The figure alone, unlit: this row says nothing of whether it is at work.
        <a key={job.id} className="pick-up-chat" href={`/agents/${encodeURIComponent(job.id)}?view=chat`}>
          <FigureStill figure={figureFor(job.id, figures.get(job.id))} alt="" width={30} height={30} decoding="async" />
          <span><b>{job.name}</b><small>Your chat</small></span>
        </a>
      ))}
      <span className="pick-up-choose">
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
      </span>
    </div>
  )
  if (!anything) return <div className="pick-up">{row}</div>
  return (
    <section className="pick-up" aria-labelledby="pick-up-title">
      <h2 id="pick-up-title" className="studio-head">Pick up where you left off</h2>
      {row}
    </section>
  )
}
