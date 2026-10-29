import { Plus, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { FileReaderContext, type FileToRead } from '../../lib/files/reader'
import { figureFor, type FigureChoice } from '../../lib/library/figures'
import type { SavedJob } from '../../lib/library/jobs'
import { useProjects, type ProjectEntry } from '../../lib/projects/client'
import { finishedToday, lastFinished, madeHere, monthSpend, needsYou, workingNow } from '../../lib/projects/glance'
import { AT_YOUR_DESK, roomsOf, studioLayout, type Room, type Seat } from '../../lib/projects/studio'
import { useTeamShapes } from '../../lib/projects/useTeamShapes'
import { benchChatId } from '../../lib/rail/presence'
import { historyRunUrl } from '../../lib/runs/history'
import type { RunRecord } from '../../lib/runs/client'
import { teamDisplayName, type TeamSummary } from '../../lib/team-file/client'
import { openTeam, useTeamList } from '../../lib/team-file/useTeamList'
import { formatCost } from '../../lib/watch/usage'
import { KnowYou } from '../you/KnowYou'
import { relativeTime } from '../../lib/format'
import { FigureStill } from '../agents/FigureStill'
import { goToRun } from '../agents/route'
import { defaultFigureOf, openNeedsYou, roomHref, tryAgain } from '../../lib/projects/studioUi'
import { GlanceTiles } from './GlanceTiles'
import { PickUp } from './PickUp'
import { ReaderSheet } from './ReaderSheet'
import { RoomCard, RoomWords, ProjectMark } from './RoomCard'
import { SetUpProject, type ProjectStart } from './SetUpProject'
import { WorkBox, type BoxTeam } from './WorkBox'

const VIEW_KEY = 'loomwatch:studio-view'

function readView(): 'rooms' | 'list' {
  try { return window.localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'rooms' } catch { return 'rooms' }
}

/** A team with no project yet stands as a room of its own until the app moves it into one. */
function looseProjects(loose: readonly string[]): ProjectEntry[] {
  return loose.map((path) => ({ id: `team:${path}`, name: path.split(/[\\/]/).pop()?.replace(/\.ya?ml$/i, '') ?? path, teams: [path] }))
}

const PROBLEM_LABEL: Record<NonNullable<TeamSummary['problem']>, string> = {
  unreadable: 'the file has a mistake in it',
  not_a_team: 'not a team file',
}

/** Files in the teams folder that can't be opened as teams, so none goes missing from Home. */
function CantBeOpened({ teams }: { teams: readonly TeamSummary[] }) {
  if (teams.length === 0) return null
  return (
    <ul className="studio-problems" aria-label="Files that can’t be opened">
      {teams.map((team) => (
        <li key={team.path}><button type="button" className="link" onClick={() => openTeam(team.path)}>{teamDisplayName(team)}</button> can’t be opened: {team.problem ? PROBLEM_LABEL[team.problem] : 'not a team file'}</li>
      ))}
    </ul>
  )
}

/** Your agents in no team of any project: they stand under "Not in a project". */
function NotInAProject({ jobs, rooms, used }: { jobs: readonly SavedJob[]; rooms: readonly Room[]; used: ReadonlySet<string> }) {
  const [open, setOpen] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) { setOpen(null); setAdding(false) } }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(null); setAdding(false) } }
    window.addEventListener('pointerdown', away)
    window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('pointerdown', away); window.removeEventListener('keydown', escape) }
  }, [open])
  const idle = jobs.filter((job) => !used.has(job.id))
  const projects = rooms.filter((room) => !room.id.startsWith('team:') && !room.putAway)
  return (
    <section className="not-in-project" aria-labelledby="not-in-project-title">
      <h2 id="not-in-project-title" className="studio-head">Not in a project</h2>
      <div className="idle-agents" ref={box}>
        {idle.map((job) => (
          <span key={job.id} className="idle-agent">
            <button type="button" className="idle-agent-chip" aria-expanded={open === job.id} aria-haspopup="menu" onClick={() => { setOpen(open === job.id ? null : job.id); setAdding(false) }}>
              <FigureStill figure={figureFor(job.id, job.figure)} alt="" width={30} height={30} decoding="async" />
              {job.name}
            </button>
            {open === job.id && (
              <span className="idle-agent-menu" role="menu" aria-label={job.name}>
                {!adding && <a role="menuitem" href={`/agents/${encodeURIComponent(job.id)}?view=chat`}>Chat</a>}
                {!adding && <button type="button" role="menuitem" onClick={() => setAdding(true)} disabled={projects.length === 0} title={projects.length === 0 ? 'Set up a project first' : undefined}>Add to a project</button>}
                {adding && projects.map((room) => (
                  <a key={room.id} role="menuitem" href={`${roomHref(room.id)}?add=${encodeURIComponent(job.id)}`}><ProjectMark id={room.id} mark={room.mark} />{room.name}</a>
                ))}
              </span>
            )}
          </span>
        ))}
        {idle.length === 0 && jobs.length > 0 && <span className="studio-quiet">Every agent works in a project.</span>}
        <a className="link" href={jobs.length > 0 ? '/agents' : '/agents/new'} data-tour="build-agent">{jobs.length > 0 ? `All my agents (${jobs.length})` : 'Build an agent'}</a>
      </div>
      {/* Home's way to About you since the first run took its card (ADR 0075). */}
      <KnowYou />
    </section>
  )
}

/**
 * Home is a studio of rooms (ADR 0097). Your desk comes first, with whoever waits for you; then each
 * project as a room, its agents at their desks in team order, waiting rooms first; then your agents
 * in no project. With no project yet it asks what you are working on.
 */
export function Studio({ runs, onSetUp, setUpUnavailable, asking = false }: {
  runs: readonly RunRecord[]
  onSetUp: (start: ProjectStart) => void
  setUpUnavailable: string | null
  /** Ask's panel is open: Set up project says Ask is already at work beside it. */
  asking?: boolean
}) {
  const { list, error, reload } = useProjects()
  const { teams: summaries } = useTeamList()
  const problems = (summaries ?? []).filter((team) => team.problem)
  const { root, shapes, jobs } = useTeamShapes(list)
  const [view, setView] = useState<'rooms' | 'list'>(readView)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [showPutAway, setShowPutAway] = useState(false)
  const figures = useMemo(() => new Map<string, FigureChoice | undefined>(jobs.map((job) => [job.id, job.figure])), [jobs])
  const figureOf = useMemo(() => defaultFigureOf(figures), [figures])
  const rooms = useMemo(
    () => (list && shapes ? roomsOf([...list.projects, ...looseProjects(list.loose)], shapes, runs, root) : null),
    [list, shapes, runs, root],
  )
  const teamShapes = useMemo(() => shapes ?? [], [shapes])
  // At a glance, across every project: what needs you, who works, what finished today, this month.
  const needs = useMemo(() => needsYou(runs, teamShapes, root), [runs, teamShapes, root])
  const working = useMemo(() => workingNow(runs, teamShapes, root), [runs, teamShapes, root])
  const made = useMemo(() => madeHere(runs, root), [runs, root])
  const [reading, setReading] = useState<FileToRead | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const read = useCallback((file: FileToRead) => setReading(file), [])
  const names = useMemo(() => new Map(teamShapes.flatMap((shape) => shape.seats.map((seat) => [seat.id, seat.name] as const))), [teamShapes])
  const nameOf = useCallback((agent: string) => names.get(agent) ?? agent, [names])
  // Your agents' own chats, newest first.
  const chats = useMemo(() => [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((run) => benchChatId(run.teamPath)).filter((id): id is string => Boolean(id)), [runs])
  const used = useMemo(() => new Set((shapes ?? []).flatMap((shape) => shape.seats.flatMap((seat) => (seat.agent ? [seat.agent] : [])))), [shapes])
  // Every team the box can give work to, under its project.
  const boxTeams = useMemo((): BoxTeam[] => (rooms ?? []).filter((room) => !room.putAway).flatMap((room) => room.teams.map((team) => ({
    path: team.path,
    name: team.name,
    ...(room.id.startsWith('team:') ? {} : { project: { id: room.id, name: room.name } }),
  }))), [rooms])

  // ⌘N and the palette's New team reach Home through this event: a new team starts as a project.
  useEffect(() => {
    const open = () => setCreating(true)
    window.addEventListener('loomwatch:new-project', open)
    return () => window.removeEventListener('loomwatch:new-project', open)
  }, [])

  const choose = (next: 'rooms' | 'list') => {
    setView(next)
    try { window.localStorage.setItem(VIEW_KEY, next) } catch { /* the choice lasts this visit */ }
  }
  const openRoom = (room: Room) => {
    if (room.id.startsWith('team:')) openTeam(room.id.slice('team:'.length))
    else window.location.assign(roomHref(room.id))
  }
  // An agent at your desk is faint in its rooms; pressing it there goes to Your desk.
  const onAway = (seat: Seat) => {
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (seat.away === AT_YOUR_DESK) document.getElementById('your-desk')?.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'center' })
  }
  const openRun = (run: Pick<RunRecord, 'runId' | 'teamPath'>) => goToRun(historyRunUrl({ id: run.runId, teamPath: run.teamPath }))

  if (error) return <p role="alert" className="home-empty alert">Couldn’t list your projects. {error} <button type="button" className="link" onClick={reload}>Try again</button></p>
  if (!rooms) return <p role="status" className="home-empty">Loading your projects…</p>

  const setUp = (start: ProjectStart) => { setCreating(false); onSetUp(start) }
  const pickUp = <PickUp files={made} chats={chats} jobs={jobs} figures={figures} />
  const reader = reading && <ReaderSheet file={reading} name={nameOf} onClose={() => setReading(null)} />
  if (rooms.length === 0) {
    return (
      <FileReaderContext.Provider value={read}>
      <div className="studio studio-empty">
        <SetUpProject onSetUp={setUp} unavailable={setUpUnavailable} asking={asking} />
        {pickUp}
        <CantBeOpened teams={problems} />
        <NotInAProject jobs={jobs} rooms={rooms} used={used} />
      </div>
      {reader}
      </FileReaderContext.Provider>
    )
  }

  const needle = query.trim().toLowerCase()
  const found = needle ? rooms.filter((room) => room.name.toLowerCase().includes(needle)) : rooms
  const { open, quiet, putAway } = studioLayout(found)
  const shown = showPutAway ? [...open, ...quiet, ...putAway] : [...open, ...quiet]
  // What each room shows of its own: the newest thing made there, and what this month cost.
  const roomFacts = (room: Room) => {
    const scope = room.teams.map((team) => team.path)
    const spend = monthSpend(runs, root, scope)
    return {
      newest: madeHere(runs, root, scope, 1)[0]?.path ?? null,
      spend: spend.runs > 0 ? `${spend.atLeast ? 'at least ' : ''}${formatCost(spend.usd)} this month` : null,
    }
  }
  return (
    <FileReaderContext.Provider value={read}>
    <div className="studio">
      <div id="your-desk" className="studio-desk">
        <GlanceTiles
          label="Your desk"
          needs={needs}
          last={lastFinished(runs, root)}
          working={working}
          finishedToday={finishedToday(runs, root)}
          spend={monthSpend(runs, root)}
          figureOf={figureOf}
          // Home's Review opens the bell's tray, where each thing waiting is answered in turn (ADR 0043).
          onReview={openNeedsYou}
          onTryAgain={(item) => { setProblem(null); tryAgain(item).catch((caught: unknown) => setProblem(caught instanceof Error ? caught.message : String(caught))) }}
          onOpenLast={openRun}
          onOpenWork={openRun}
          onMore={openNeedsYou}
        />
        {problem && <p role="alert" className="home-empty alert">{problem}</p>}
        {boxTeams.length > 0 && <WorkBox teams={boxTeams} primary={needs.length === 0} />}
      </div>
      {pickUp}
      <section className="studio-projects" aria-labelledby="studio-projects-title" data-tour="projects">
        <div className="studio-projects-head">
          <h2 id="studio-projects-title" className="studio-head">Projects</h2>
          {rooms.length > 6 && (
            <label className="home-filter"><Search size={14} aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a project" aria-label="Find a project" /></label>
          )}
          <span className="studio-view" role="group" aria-label="Show projects as">
            <button type="button" aria-pressed={view === 'rooms'} onClick={() => choose('rooms')}>Rooms</button>
            <button type="button" aria-pressed={view === 'list'} onClick={() => choose('list')}>List</button>
          </span>
        </div>
        {view === 'rooms' ? (
          <div className="room-grid">
            {open.map((room) => <RoomCard key={room.id} room={room} figureOf={figureOf} onOpen={() => openRoom(room)} onAway={onAway} {...roomFacts(room)} />)}
            {quiet.map((room) => (
              <button key={room.id} type="button" className="room-tile" onClick={() => openRoom(room)}>
                <span className="room-tile-name"><ProjectMark id={room.id} mark={room.mark} />{room.name}</span>
                <span className="room-tile-when">{room.line !== 'Ready' ? room.line : room.lastWorked ? `Worked ${relativeTime(new Date(room.lastWorked))}` : 'Not working now'}</span>
              </button>
            ))}
            {putAway.length > 0 && (
              <div className="room-tile put-away">
                <button type="button" className="room-tile-name" aria-expanded={showPutAway} onClick={() => setShowPutAway((value) => !value)}>{putAway.length} hidden from Home</button>
                {showPutAway && putAway.map((room) => (
                  <button key={room.id} type="button" className="link room-tile-when" onClick={() => openRoom(room)}>{room.name}</button>
                ))}
              </div>
            )}
            <button type="button" className="room-new" onClick={() => setCreating(true)}><Plus size={20} aria-hidden="true" />New project</button>
          </div>
        ) : (
          <ul className="room-list" aria-label="Projects">
            {shown.map((room) => (
              <li key={room.id}>
                <button type="button" onClick={() => openRoom(room)}>
                  <span className="room-tile-name"><ProjectMark id={room.id} mark={room.mark} />{room.name}</span>
                  <span className={`room-line ${room.state}`}><RoomWords room={room} count={false} /></span>
                  <span className="room-list-teams">{room.teams.map((team) => team.name).join(', ') || 'No team yet'}</span>
                </button>
              </li>
            ))}
            {putAway.length > 0 && !showPutAway && <li><button type="button" className="link" onClick={() => setShowPutAway(true)}>{putAway.length} hidden from Home</button></li>}
            <li><button type="button" className="btn" onClick={() => setCreating(true)}><Plus size={14} aria-hidden="true" />New project</button></li>
          </ul>
        )}
        {needle && found.length === 0 && <p className="home-empty">No project matches “{query}”.</p>}
        <CantBeOpened teams={problems} />
      </section>
      <NotInAProject jobs={jobs} rooms={rooms} used={used} />
      {creating && <SetUpProject onSetUp={setUp} unavailable={setUpUnavailable} asking={asking} onClose={() => setCreating(false)} />}
    </div>
    {reader}
    </FileReaderContext.Provider>
  )
}
