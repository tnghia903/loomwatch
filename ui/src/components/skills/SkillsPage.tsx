import { Moon, Sun } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import {
  displayName, errorText, fetchSkills, inspectInstall, installedKeys, publisherOf, removeSkill, resultKey, searchEverywhere, skillCount,
  type FoundSkills, type Publisher, type SearchResult, type SkillRecord, type SkillSource, type SkillsFolder,
} from '../../lib/library/skillStore'
import type { LoomMarkState } from '../../lib/story/loomMark'
import { useTheme } from '../../lib/theme'
import { LoomMark, LoomWordmark } from '../ui/glyphs'
import { AddSheet, type Adding } from './AddSheet'
import { BringInSheet } from './BringInSheet'
import { Finder, Topics } from './Finder'
import { Results, type ResultState } from './Results'
import { Shelf } from './Shelf'
import { Toast } from './Toast'

type Search = { query: string; loading: boolean; found: FoundSkills | null; error: string }
type ToastState = { text: string; action?: string; onAction?: () => void }

const FRESH_FOR = 4000

/**
 * Skills (`/skills`): teach every agent a kind of work. One of the Home pages (Your agents,
 * Quests), so it wears their header and ground around the store (SkillsStore).
 */
export function SkillsPage({ mark }: { mark?: LoomMarkState } = {}) {
  const { resolved, toggle } = useTheme()
  return (
    <div className="lw-home lw-skills">
      <div className="ground" aria-hidden="true" />
      <header className="home-top">
        <a className="home-brand" href="/" aria-label="LoomWatch home"><LoomMark size={28} state={mark} /><LoomWordmark height={19} /></a>
        <span className="home-top-acts">
          <a className="btn" href="/agents">My agents</a>
          <a className="btn lw-skills-teams-link" href="/">Your teams</a>
          <button type="button" className="iconbtn" onClick={toggle} aria-label={resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>{resolved === 'dark' ? <Sun size={15} aria-hidden="true" /> : <Moon size={15} aria-hidden="true" />}</button>
        </span>
      </header>
      <SkillsStore heading="Skills" intro="Skills teach your agents a kind of work, like filling in PDF forms or writing in your house style. Add a skill here and every agent can use it." />
    </div>
  )
}

export interface SkillsStoreProps {
  heading: ReactNode
  /** The line under the heading. */
  intro: ReactNode
  /** A search to start with, as if it had been typed. */
  initialQuery?: string
  /** Skills just added with Add, by name. Not a bring-in's: that can be all of an app's skills. */
  onAdded?: (names: string[]) => void
  /** Each time My skills is read: what the folder holds now (an Undo, a removal). */
  onFolder?: (folder: SkillsFolder) => void
}

/**
 * The store: one search box finds skills on skills.sh and ClawHub at once, or looks inside a
 * pasted link; topics give a start to someone who doesn't know what to search for. Add opens a
 * review that says what to know in plain words before anything is copied. My skills sit beside
 * the search, so an added skill is seen arriving. Skills other apps on this computer already have
 * come in through one button above that list, only when asked.
 *
 * The Skills page shows it under Home's header; the builder opens it over an agent's bench
 * (SkillsMarket), so what was added can be given to that agent on the way back.
 */
export function SkillsStore({ heading, intro, initialQuery = '', onAdded, onFolder }: SkillsStoreProps) {
  const [folder, setFolder] = useState<SkillsFolder | null>(null)
  const [folderError, setFolderError] = useState('')
  const [text, setText] = useState(initialQuery)
  const [search, setSearch] = useState<Search | null>(null)
  const [adding, setAdding] = useState<{ state: Adding; key?: string; publisher?: Publisher } | null>(null)
  const [outcomes, setOutcomes] = useState<Record<string, ResultState>>({})
  const [bringingIn, setBringingIn] = useState(false)
  const [toast, setToast] = useState<(ToastState & { id: number }) | null>(null)
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set())
  // Results a look inside found the license keeps out: the search leaves them out from now on.
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set())
  // Only the newest add's and search's answers count: one closed or replaced since is ignored.
  const addTurn = useRef(0)
  const searchTurn = useRef(0)

  const load = useCallback(async () => {
    try { setFolder(await fetchSkills()); setFolderError('') } catch (caught) { setFolderError(errorText(caught)) }
  }, [])
  useEffect(() => {
    let active = true
    fetchSkills()
      .then((value) => { if (active) setFolder(value) })
      .catch((caught: unknown) => { if (active) setFolderError(errorText(caught)) })
    return () => { active = false }
  }, [])
  // The latest one counts: the folder can be read again after whoever asked has rendered anew.
  const report = useRef(onFolder)
  useEffect(() => { report.current = onFolder })
  useEffect(() => { if (folder) report.current?.(folder) }, [folder])
  useEffect(() => {
    // Once, on opening: the search it was asked to start with.
    if (initialQuery.trim()) void runSearch(initialQuery.trim())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (fresh.size === 0) return
    const timer = setTimeout(() => setFresh(new Set()), FRESH_FOR)
    return () => clearTimeout(timer)
  }, [fresh])
  const toastTurn = useRef(0)
  const say = (next: ToastState) => setToast({ ...next, id: ++toastTurn.current })

  const have = useMemo(() => installedKeys(folder?.skills ?? []), [folder])
  const stateOf = (result: SearchResult): ResultState | null => {
    const key = resultKey(result)
    return outcomes[key] ?? (have.has(key) ? { kind: 'have' } : null)
  }

  async function runSearch(query: string) {
    const turn = ++searchTurn.current
    setText(query)
    setSearch({ query, loading: true, found: null, error: '' })
    try {
      const found = await searchEverywhere(query)
      if (turn === searchTurn.current) setSearch({ query, loading: false, found, error: '' })
    } catch (caught) {
      if (turn === searchTurn.current) setSearch({ query, loading: false, found: null, error: errorText(caught) })
    }
  }

  function openAdd(label: string, ref: string, source?: SkillSource, key?: string, publisher?: Publisher) {
    const turn = ++addTurn.current
    setAdding({ state: { kind: 'loading', label }, key, publisher })
    inspectInstall(ref, source).then((inspection) => {
      if (turn !== addTurn.current) return
      setAdding({ state: { kind: 'ready', inspection }, key, publisher })
      const { candidates } = inspection
      const reasons = candidates.map((candidate) => candidate.reason)
      if (key && candidates.length > 0 && candidates.every((candidate) => candidate.license.restricted)) setGone((current) => new Set(current).add(key))
      else if (key && reasons.length > 0 && reasons.every(Boolean)) setOutcomes((current) => ({ ...current, [key]: { kind: 'blocked', reason: reasons[0] ?? '' } }))
    }).catch((caught: unknown) => {
      if (turn !== addTurn.current) return
      setAdding({ state: { kind: 'failed', label, message: errorText(caught), retry: () => openAdd(label, ref, source, key, publisher) }, key, publisher })
    })
  }
  const closeAdd = () => { addTurn.current += 1; setAdding(null) }

  function added(records: SkillRecord[], replaced: boolean) {
    const key = adding?.key
    closeAdd()
    void load()
    if (key) setOutcomes((current) => ({ ...current, [key]: { kind: 'added' } }))
    setFresh(new Set(records.map((record) => record.name)))
    onAdded?.(records.map((record) => record.name))
    const text = records.length === 1 ? `Added ${displayName(records[0].name)}. Every agent can use it now.` : `Added ${skillCount(records.length)}. Every agent can use them now.`
    // Undo removes what was just added; after a replace that would leave nothing, so it isn't offered.
    say(replaced ? { text } : { text, action: 'Undo', onAction: () => void takeBack(records, key) })
  }
  async function takeBack(records: SkillRecord[], key?: string) {
    try {
      for (const record of records) await removeSkill(record.name)
      say({ text: records.length === 1 ? `Took back ${displayName(records[0].name)}.` : `Took back ${skillCount(records.length)}.` })
      if (key) setOutcomes((current) => Object.fromEntries(Object.entries(current).filter(([other]) => other !== key)))
    } catch (caught) {
      say({ text: errorText(caught) })
    }
    void load()
  }

  return (
    <>
      <main className="home-main lw-skills-main">
        <section className="home-hero lw-skills-hero">
          <h1 className="t-display">{heading}</h1>
          <p>{intro}</p>
        </section>
        <div className="lw-skills-layout">
          <div className="lw-skills-browse">
            <Finder text={text} onText={setText} busy={search?.loading ?? false} onSearch={(query) => void runSearch(query)} onOpenLink={(link) => openAdd(link, link)} />
            {search
              ? <Results query={search.query} results={(search.found?.results ?? []).filter((result) => !gone.has(resultKey(result)))} missed={search.found?.missed ?? []} loading={search.loading} error={search.error}
                stateOf={stateOf} onAdd={(result) => openAdd(displayName(result.name), result.ref, result.source, resultKey(result), publisherOf(result))}
                onClear={() => { searchTurn.current += 1; setSearch(null) }} />
              : <Topics onPick={(query) => void runSearch(query)} />}
          </div>
          <aside className="lw-skills-rail">
            <Shelf folder={folder} error={folderError} fresh={fresh} onRetry={() => void load()} onChanged={() => void load()} onBringIn={() => setBringingIn(true)} />
          </aside>
        </div>
      </main>
      {adding && <AddSheet adding={adding.state} publisher={adding.publisher} onClose={closeAdd} onAdded={added} returnFocus={adding.key ? (gone.has(adding.key) ? 'input[aria-label="Find skills"]' : `[data-result=${JSON.stringify(adding.key)}]`) : undefined} />}
      {bringingIn && <BringInSheet onClose={() => setBringingIn(false)} onChanged={() => void load()} onBroughtIn={(names) => setFresh(new Set(names))} />}
      {toast && <Toast key={toast.id} text={toast.text} action={toast.action} onAction={toast.onAction} onClose={() => setToast(null)} />}
    </>
  )
}
