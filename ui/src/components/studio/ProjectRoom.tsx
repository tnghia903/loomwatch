import { Folder, MoreHorizontal, Plus, X } from '../ui/icon'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { FileReaderContext, type FileToRead } from '../../lib/files/reader'
import { listNames } from '../../lib/format'
import { figureFor, type FigureChoice } from '../../lib/library/figures'
import { fetchJobs, saveJob, type SavedJob } from '../../lib/library/jobs'
import { addProjectNote, addTeamToProject, NOTE_CHARS, ABOUT_CHARS, projectFile, projectsChanged, saveProject, takeTeamOut, useProjects, type Project, type ProjectEntry } from '../../lib/projects/client'
import { crewOf, doneByOf, lastFinished, madeHere, monthCost, monthSpend, monthSpenders, needsYou, nextWork, workingNow, type MadeFile } from '../../lib/projects/glance'
import { useMonthUsage } from '../../lib/projects/useMonthUsage'
import { approveRun, loadDismissed } from '../../lib/story/useNeedsYou'
import { moveTeam } from '../../lib/projects/move'
import { inOpenedOrder, roomsOf, type RoomTeam, type TeamShape } from '../../lib/projects/studio'
import { useTeamShapes } from '../../lib/projects/useTeamShapes'
import { historyRunUrl } from '../../lib/runs/history'
import { fetchRuns, useSchedules, type RunRecord } from '../../lib/runs/client'
import { fetchTeamFile, fetchTeamsDiscovery, saveTeamFile, teamDisplayName } from '../../lib/team-file/client'
import { TeamFileModel } from '../../lib/team-file/document'
import { teamOfMyAgents } from '../../lib/team-file/myAgents'
import { agentsTeamYaml, uniqueTeamPath } from '../../lib/team-file/templates'
import { teamHref } from '../../lib/team-file/teamHref'
import { hashTeamYaml, teamIdForPath } from '../../lib/team-file/useTeamDocument'
import { useTeamList } from '../../lib/team-file/useTeamList'
import { useTheme } from '../../lib/theme'
import { FigureStill } from '../agents/FigureStill'
import { goToRun } from '../agents/route'
import { FolderPicker } from '../canvas/FolderPicker'
import { DeleteTeamDialog } from '../home/DeleteTeamDialog'
import { NewTeamDialog } from '../home/NewTeamDialog'
import { SectionHead } from '../ui/SectionHead'
import { MARKS, MARK_NAMES, defaultFigureOf, markOf, roomHref } from '../../lib/projects/studioUi'
import { GlanceTiles } from './GlanceTiles'
import { DeleteProjectDialog } from './DeleteProjectDialog'
import { MadeHere } from './MadeHere'
import { CardMenu, TakeOutDialog, TeamPlacesMenu } from './ProjectCardMenu'
import { ReaderSheet } from './ReaderSheet'
import { RoomAsk } from './RoomAsk'
import { ProjectMark } from './RoomCard'
import { TeamGrid } from './TeamGrid'
import { WorkBox } from './WorkBox'

/** How often the room looks at its teams' runs again, so its figures follow the work. */
const RUNS_EVERY_MS = 4000

/** The runs, read again every few seconds, and a way to read them at once; null until the first read. */
function useRuns(): [RunRecord[] | null, () => void] {
  const [runs, setRuns] = useState<RunRecord[] | null>(null)
  const [again, setAgain] = useState(0)
  useEffect(() => {
    let live = true
    const read = () => { void fetchRuns().then((next) => { if (live) setRuns(next) }, () => { if (live) setRuns((last) => last ?? []) }) }
    read()
    const timer = window.setInterval(read, RUNS_EVERY_MS)
    return () => { live = false; window.clearInterval(timer) }
  }, [again])
  return [runs, useCallback(() => setAgain((value) => value + 1), [])]
}

/** Open a run where it was given: its team's chat, at that piece of work. */
const openRun = (run: Pick<RunRecord, 'runId' | 'teamPath'>) => goToRun(historyRunUrl({ id: run.runId, teamPath: run.teamPath }))

/** The About on the wall: a paper note, written in place. */
function About({ project, onSave }: { project: ProjectEntry; onSave: (about: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(project.about ?? '')
  const [error, setError] = useState<string | null>(null)
  if (editing) {
    return (
      <form className="wall-paper about editing" onSubmit={(event) => { event.preventDefault(); void onSave(text).then(() => setEditing(false), (caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught))) }}>
        <label><span className="wall-paper-head">About</span>
          <textarea autoFocus value={text} maxLength={ABOUT_CHARS} rows={6} placeholder="What it is, who it is for, and what you have decided so far." onChange={(event) => setText(event.target.value)} />
        </label>
        {error && <p role="alert" className="wall-error">{error}</p>}
        <span className="wall-paper-acts"><button type="button" className="btn" onClick={() => { setText(project.about ?? ''); setEditing(false) }}>Cancel</button><button type="submit" className="btn">Save</button></span>
      </form>
    )
  }
  return (
    <button type="button" className="wall-paper about" onClick={() => setEditing(true)} aria-label="About. Change it">
      <span className="wall-paper-head">About</span>
      <span className="wall-paper-text">{project.about?.trim() || 'Say what this project is, who it is for, and what you have decided.'}</span>
    </button>
  )
}

/**
 * A team you have, put into this project as well (ADR 0103): one line per team, with where it works
 * now. A team in no project moves in; one in another project gets a place of its own here.
 */
function AddATeam({ here, shapes, projects, onAdd }: { here: string; shapes: readonly TeamShape[]; projects: readonly ProjectEntry[]; onAdd: (team: TeamShape, alone: boolean) => void }) {
  const groups = new Map<string, TeamShape[]>()
  for (const shape of shapes) groups.set(shape.shares ?? `path:${shape.path}`, [...(groups.get(shape.shares ?? `path:${shape.path}`) ?? []), shape])
  const teams = [...groups.values()]
    .filter((places) => !places.some((place) => place.project === here))
    .map((places) => {
      const first = places.find((place) => place.project) ?? places[0]
      const where = places.flatMap((place) => projects.find((project) => project.id === place.project)?.name ?? [])
      return { first, where, alone: where.length === 0 }
    })
    .sort((a, b) => a.first.name.localeCompare(b.first.name))
  if (teams.length === 0) return null
  return (
    <CardMenu label="Add a team" title={null} face={<>Add a team</>} className="add-a-team">
      {(pick) => teams.map(({ first, where, alone }) => (
        <button key={first.path} type="button" role="menuitem" onClick={pick(() => onAdd(first, alone))}>
          <span className="add-a-team-name">{first.name}<small>{alone ? 'In no project' : `In ${listNames(where)}`}</small></span>
        </button>
      ))}
    </CardMenu>
  )
}

/** Add an agent from My agents: to a team of its own in this project, or to one of its teams. */
function AddAnAgent({ jobs, project, teams, initial, onClose }: { jobs: readonly SavedJob[]; project: ProjectEntry; teams: readonly { path: string; name: string }[]; initial: string | null; onClose: () => void }) {
  const [agent, setAgent] = useState<string | null>(initial)
  const [where, setWhere] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const chosen = jobs.find((job) => job.id === agent) ?? null
  const add = async () => {
    if (!chosen || busy) return
    setBusy(true)
    setError(null)
    if (where) {
      // One of the project's teams: it joins the team's file, and its workflow opens, where you
      // connect it in the order work moves.
      try {
        const file = await fetchTeamFile(where)
        const team = TeamFileModel.parse(file.yaml)
        const taken = (team.snapshot().agents ?? []).map((agent) => agent.id)
        const mine = (await fetchJobs())?.jobs ?? []
        const [joining] = TeamFileModel.parse(await teamOfMyAgents(agentsTeamYaml([chosen], chosen.name, 'joining'), mine, saveJob)).snapshot().agents
        let id = joining.id
        for (let counter = 2; taken.includes(id); counter += 1) id = `${joining.id}-${counter}`
        team.addAgent({ ...joining, id })
        await saveTeamFile(where, team.toYaml(), file.revision ?? await hashTeamYaml(file.yaml))
        window.location.assign(teamHref(where, 'workflow'))
      } catch (caught) {
        setBusy(false)
        setError(caught instanceof Error ? caught.message : String(caught))
      }
      return
    }
    try {
      const discovery = await fetchTeamsDiscovery()
      const path = uniqueTeamPath(chosen.name, discovery.files)
      const written = agentsTeamYaml([chosen], chosen.name, teamIdForPath(path))
      const mine = (await fetchJobs())?.jobs ?? []
      const model = TeamFileModel.parse(await teamOfMyAgents(written, mine, saveJob))
      model.setProject(project.id)
      await saveTeamFile(path, model.toYaml(), null)
      projectsChanged()
      onClose()
    } catch (caught) {
      setBusy(false)
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }
  return (
    <div className="set-up-backdrop" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
      <section className="set-up-card dialog add-agent" role="dialog" aria-modal="true" aria-labelledby="add-agent-title" onKeyDown={(event) => { if (event.key === 'Escape' && !busy) onClose() }}>
        <button type="button" className="iconbtn set-up-close" aria-label="Close" onClick={onClose}><X size={15} aria-hidden="true" /></button>
        <h2 id="add-agent-title">Add an agent</h2>
        <div className="add-agent-pick" role="radiogroup" aria-label="Which agent">
          {jobs.length === 0 && <a className="link" href="/agents/new">Build an agent first</a>}
          {jobs.map((job) => (
            <label key={job.id} className={`add-agent-option${agent === job.id ? ' on' : ''}`}>
              <input type="radio" name="agent" checked={agent === job.id} onChange={() => setAgent(job.id)} />
              <FigureStill figure={figureFor(job.id, job.figure)} alt="" width={26} height={34} decoding="async" />
              {job.name}
            </label>
          ))}
        </div>
        <label className="add-agent-where">
          <span>It joins</span>
          <select value={where} onChange={(event) => setWhere(event.target.value)}>
            <option value="">A team of its own, in this project</option>
            {teams.map((team) => <option key={team.path} value={team.path}>{team.name}</option>)}
          </select>
        </label>
        {where && <p className="set-up-hint">It joins the team, whose Team tab opens for you to connect it.</p>}
        {error && <p role="alert" className="wall-error">{error}</p>}
        <span className="wall-paper-acts">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={() => void add()} disabled={!chosen || busy}>{busy ? 'Adding…' : 'Add'}</button>
        </span>
      </section>
    </div>
  )
}

/**
 * Inside a project's room (ADR 0097), at a glance: what needs you, who is working, what comes next
 * and what this month cost; a box to give a team work; the teams at their desks, in the order work
 * moves, each with the newest thing it made; and everything made here. Beside them, the wall holds
 * what every agent here knows (its About, its folders and the notes kept).
 */
export function ProjectRoom({ id }: { id: string }) {
  useTheme()
  const { list, error, reload } = useProjects()
  const { root, shapes, jobs } = useTeamShapes(list)
  const [runs, readRuns] = useRuns()
  const { entries: schedules, error: scheduleError } = useSchedules()
  const [reading, setReading] = useState<FileToRead | null>(null)
  const read = useCallback((file: FileToRead) => setReading(file), [])
  // Where teams are and were: a new team never takes the place of a deleted one, whose history it would inherit.
  const { teams: listed, trashed } = useTeamList()
  const [noting, setNoting] = useState(false)
  const [note, setNote] = useState('')
  const [picking, setPicking] = useState(false)
  const [menu, setMenu] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [newTeam, setNewTeam] = useState(false)
  const [adding, setAdding] = useState<string | null | false>(() => new URLSearchParams(window.location.search).get('add') ?? false)
  const [problem, setProblem] = useState<string | null>(null)
  // What a change to one of its teams did, said under them (ADR 0103).
  const [said, setSaid] = useState<ReactNode>(null)
  const [takingOut, setTakingOut] = useState<RoomTeam | null>(null)
  const [deletingTeam, setDeletingTeam] = useState<RoomTeam | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const project = list?.projects.find((candidate) => candidate.id === id) ?? null
  const figures = useMemo(() => new Map<string, FigureChoice | undefined>(jobs.map((job) => [job.id, job.figure])), [jobs])
  const figureOf = useMemo(() => defaultFigureOf(figures), [figures])
  const room = useMemo(() => (project && shapes && list ? roomsOf([project], shapes, runs ?? [], root, list.projects)[0] : null), [project, shapes, runs, root, list])
  // A team's places in other projects (ADR 0103): Delete team deletes it there too.
  const othersOf = (team: RoomTeam) => {
    const shares = shapes?.find((shape) => shape.path === team.path)?.shares
    if (!shares || !shapes || !list) return []
    return shapes.filter((shape) => shape.shares === shares && shape.path !== team.path).map((shape) => ({ path: shape.path, project: list.projects.find((other) => other.id === shape.project)?.name ?? 'Not in a project' }))
  }
  // The order the teams stood in once the runs were read, kept while you are here: the room puts
  // the team waiting for you first, but a team that starts work never slides under your pointer.
  const [opened, setOpened] = useState<string[] | null>(null)
  if (room && runs && !opened) setOpened(room.teams.map((team) => team.path))

  useEffect(() => { if (project) document.title = `${project.name} · LoomWatch` }, [project])
  useEffect(() => {
    if (!menu) return
    const away = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(false) }
    window.addEventListener('pointerdown', away)
    return () => window.removeEventListener('pointerdown', away)
  }, [menu])

  const keep = async (change: Partial<Project>) => {
    if (!project) return
    setProblem(null)
    try {
      await saveProject(project.id, { ...projectFile(project), ...change })
      reload()
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      setProblem(message)
      throw caught
    }
  }

  // At a glance, kept to this project's teams.
  const scope = project?.teams ?? null
  const shown = useMemo(() => shapes ?? [], [shapes])
  const all = useMemo(() => runs ?? [], [runs])
  // By the bell's rules, the failures dismissed there left out (read again with each poll of the runs).
  const needs = useMemo(() => (scope ? needsYou(all, shown, root, scope, loadDismissed()) : []), [all, shown, root, scope])
  const usage = useMonthUsage()
  const working = useMemo(() => (scope ? workingNow(all, shown, root, scope) : []), [all, shown, root, scope])
  const made = useMemo(() => (scope ? madeHere(all, root, scope) : []), [all, root, scope])
  const newest = useMemo(() => {
    const first = new Map<string, MadeFile>()
    for (const file of made) if (!first.has(file.team)) first.set(file.team, file)
    return first
  }, [made])
  const names = useMemo(() => new Map(shown.flatMap((shape) => shape.seats.map((seat) => [seat.id, seat.name] as const))), [shown])
  const nameOf = useCallback((agent: string) => names.get(agent) ?? agent, [names])

  // Where to ask about a file read here: the chat of the work that made it. A file opened from a
  // chip comes with no run, so the run is the one that made it.
  const chatOf = (file: FileToRead) => {
    const maker = made.find((candidate) => candidate.path === file.path) ?? all.find((candidate) => candidate.runId === file.runId)
    return maker ? historyRunUrl({ id: maker.runId, teamPath: maker.teamPath }) : null
  }

  if (error) return <main className="project-room"><p role="alert" className="home-empty alert">Couldn’t open the project. {error}</p></main>
  if (!list) return <main className="project-room"><p role="status" className="home-empty">Opening the project…</p></main>
  if (!project) return <main className="project-room"><p role="alert" className="home-empty">There is no project “{id}”. <a className="link" href="/">Back to Home</a></p></main>

  const teams = (room?.teams ?? []).map((team) => ({ path: team.path, name: team.name }))
  return (
    <div className="project-room-page" data-tour="room">
      <header className="room-top">
        <ProjectMark id={project.id} mark={project.mark} />
        {renaming ? (
          <form className="room-rename" onSubmit={(event) => { event.preventDefault(); const name = new FormData(event.currentTarget).get('name'); void keep({ name: String(name ?? '') }).then(() => setRenaming(false), () => {}) }}>
            <input name="name" autoFocus defaultValue={project.name} maxLength={80} aria-label="Project name" />
            <button type="submit" className="btn">Save</button>
            <button type="button" className="btn" onClick={() => setRenaming(false)}>Cancel</button>
          </form>
        ) : <h1>{project.name}</h1>}
        {project.putAway && <span className="room-badge">Hidden from Home</span>}
        <RoomAsk project={project.id} name={project.name} />
        <div className="room-menu" ref={menuRef}>
          <button type="button" className="iconbtn" aria-label="Project settings" aria-expanded={menu} aria-haspopup="menu" onClick={() => setMenu((value) => !value)}><MoreHorizontal size={16} aria-hidden="true" /></button>
          {menu && (
            <div className="idle-agent-menu room-menu-list" role="menu" aria-label="Project settings">
              <button type="button" role="menuitem" onClick={() => { setMenu(false); setRenaming(true) }}>Rename</button>
              <span className="room-marks" role="group" aria-label="Colour">
                {MARKS.map((mark) => (
                  <button key={mark} type="button" role="menuitemradio" aria-checked={markOf(project.id, project.mark) === mark} aria-label={MARK_NAMES[mark]} title={MARK_NAMES[mark]} onClick={() => { setMenu(false); void keep({ mark }).catch(() => {}) }}>
                    <span className="project-mark" data-mark={mark} style={{ width: 16, height: 16 }} aria-hidden="true" />
                  </button>
                ))}
              </span>
              <button type="button" role="menuitem" onClick={() => { setMenu(false); void keep({ putAway: !project.putAway }).catch(() => {}) }}>{project.putAway ? 'Show on Home' : 'Hide from Home'}</button>
              <span className="menu-rule" role="separator" />
              <button type="button" role="menuitem" className="menu-alert" onClick={() => { setMenu(false); setDeleting(true) }}>Delete project…</button>
            </div>
          )}
        </div>
      </header>

      <FileReaderContext.Provider value={read}>
      <main className="project-room">
        {problem && <p role="alert" className="home-empty alert">{problem}</p>}
        {/* Only once the teams, the runs and the schedules are read: a count or "nothing" said too
            early is wrong, and the box beside them would jump down as they came. */}
        {shapes && runs && (schedules || scheduleError) && (
          <>
            <GlanceTiles
              needs={needs}
              last={lastFinished(all, root, scope)}
              working={working}
              crew={crewOf(room?.teams ?? [])}
              next={nextWork(schedules ?? [], root, scope)}
              spend={monthSpend(all, root, scope)}
              cost={monthCost(usage, teams.map((team) => team.name))}
              spenders={monthSpenders(usage, teams.map((team) => team.name), shown, jobs)}
              doneBy={doneByOf(shown, root)}
              figureOf={figureOf}
              onApprove={(item) => approveRun(item.runId).then((done) => { if (done) readRuns(); else openRun(item); return done })}
              onReview={openRun}
              onOpenRun={openRun}
            />
            {teams.length > 0 && <WorkBox teams={teams} primary={needs.length === 0} onSent={readRuns} />}
          </>
        )}

        <div className="room-body">
        <div className="room-main">
        <section className="room-floor" aria-labelledby="room-floor-title">
          <div className="room-floor-head">
            <h2 id="room-floor-title" className="studio-head">{teams.length > 1 ? `Teams · ${teams.length}` : 'Team'}</h2>
            <span className="room-floor-acts">
              <button type="button" className="btn" onClick={() => setAdding(null)}>Add an agent</button>
              {shapes && (
                <AddATeam
                  here={project.id}
                  shapes={shapes}
                  projects={list.projects}
                  onAdd={(team, alone) => {
                    setProblem(null)
                    setSaid(null)
                    ;(alone ? moveTeam(team.path, project.id) : addTeamToProject(team.path, project.id).then(() => undefined)).then(
                      () => { setSaid(alone ? <>{team.name} works here now.</> : <>{team.name} works here too, with a chat and work of its own.{team.schedule ? ' It has no schedule here yet.' : ''}</>); reload() },
                      (caught: unknown) => setProblem(`Couldn’t add ${team.name}. ${caught instanceof Error ? caught.message : String(caught)}`),
                    )
                  }}
                />
              )}
              <button type="button" className="btn" data-tour="new-team" onClick={() => setNewTeam(true)}>New team</button>
            </span>
          </div>
          <TeamGrid
            teams={inOpenedOrder(room?.teams ?? [], opened)}
            figureOf={figureOf}
            newest={newest}
            menu={(team) => (
              <TeamPlacesMenu
                name={team.name}
                here={project.name}
                projects={list.projects.filter((other) => other.id !== project.id && !(team.alsoIn ?? []).some((also) => also.id === other.id))}
                onAdd={(to) => {
                  const target = list.projects.find((other) => other.id === to)
                  setProblem(null)
                  setSaid(null)
                  addTeamToProject(team.path, to).then(
                    // Its schedule is each project's own: the new place starts without one.
                    () => { if (target) setSaid(<>{team.name} works in <a className="link" href={roomHref(target.id)}>{target.name}</a> too, with a chat and work of its own there.{team.schedule ? ' It has no schedule there yet.' : ''}</>); reload() },
                    (caught: unknown) => setProblem(`Couldn’t add ${team.name} to ${target?.name ?? 'that project'}. ${caught instanceof Error ? caught.message : String(caught)}`),
                  )
                }}
                onTakeOut={() => {
                  // In other projects too, it loses its work here: asked first. Alone, it only moves.
                  if (team.alsoIn?.length) { setTakingOut(team); return }
                  setProblem(null)
                  setSaid(null)
                  takeTeamOut(team.path).then(
                    () => { setSaid(<>{team.name} is in no project now. It waits on <a className="link" href="/">Home</a>, under Not in a project.</>); reload() },
                    (caught: unknown) => setProblem(`Couldn’t take ${team.name} out. ${caught instanceof Error ? caught.message : String(caught)}`),
                  )
                }}
                onDelete={() => setDeletingTeam(team)}
              />
            )}
          />
          {said && <p role="status" className="studio-quiet">{said}</p>}
          {room && room.teams.length === 0 && <p className="studio-quiet">No team works here yet.</p>}
        </section>
        <MadeHere files={made} teams={teams} />
        </div>

        <aside className="room-side">
        <section className="room-wall" aria-labelledby="room-wall-title">
          <div className="room-wall-head">
            <SectionHead as="h2" title="What agents here know" className="studio-head" explain="Every agent in this project reads these. They stay in this project." />
            <span className="room-wall-acts">
              <button type="button" className="btn" onClick={() => setPicking(true)}><Folder size={14} aria-hidden="true" />Add a folder</button>
              <button type="button" className="btn" onClick={() => setNoting(true)}><Plus size={14} aria-hidden="true" />Add a note</button>
            </span>
          </div>
          <span id="room-wall-title" className="visually-hidden">What agents here know</span>
          <div className="room-wall-board">
            <About project={project} onSave={(about) => keep({ about })} />
            {(project.folders ?? []).map((folder) => (
              <span key={folder.path} className="wall-folder" title={folder.path}>
                <Folder size={16} aria-hidden="true" />
                <span>{folder.name}</span>
                <button type="button" className="iconbtn" aria-label={`Remove ${folder.name}`} onClick={() => void keep({ folders: (project.folders ?? []).filter((other) => other.path !== folder.path) }).catch(() => {})}><X size={13} aria-hidden="true" /></button>
              </span>
            ))}
            {(project.notes ?? []).map((kept, index) => (
              <span key={`${index}:${kept.text}`} className="wall-paper note">
                <span className="wall-paper-text">{kept.text}</span>
                {kept.by && <span className="wall-paper-by">From {kept.by}</span>}
                <button type="button" className="iconbtn" aria-label={`Remove “${kept.text}”`} onClick={() => void keep({ notes: (project.notes ?? []).filter((_, at) => at !== index) }).catch(() => {})}><X size={13} aria-hidden="true" /></button>
              </span>
            ))}
            {noting && (
              <form className="wall-paper note editing" onSubmit={(event) => { event.preventDefault(); if (!note.trim()) return; void addProjectNote(project.id, note.trim()).then(() => { setNote(''); setNoting(false); reload() }, (caught: unknown) => setProblem(caught instanceof Error ? caught.message : String(caught))) }}>
                <label><span className="visually-hidden">A note every agent here reads</span>
                  <textarea autoFocus value={note} maxLength={NOTE_CHARS} rows={3} placeholder="A decision, a name, a rule." onChange={(event) => setNote(event.target.value)} />
                </label>
                <span className="wall-paper-acts"><button type="button" className="btn" onClick={() => { setNote(''); setNoting(false) }}>Cancel</button><button type="submit" className="btn" disabled={!note.trim()}>Save</button></span>
              </form>
            )}
          </div>
        </section>
        </aside>
        </div>
      </main>
      </FileReaderContext.Provider>
      {reading && <ReaderSheet file={reading} name={nameOf} chat={chatOf(reading)} onClose={() => setReading(null)} />}

      {picking && (
        <FolderPicker
          title="Add a folder to the project"
          note="Every agent in the project may read what is in it, without asking. It is linked, not copied."
          onChoose={(folder) => { setPicking(false); void keep({ folders: [...(project.folders ?? []), { name: folder.name, path: folder.path }] }).catch(() => {}) }}
          onClose={() => setPicking(false)}
        />
      )}
      {adding !== false && <AddAnAgent jobs={jobs} project={project} teams={teams} initial={adding} onClose={() => { setAdding(false); reload() }} />}
      {/* Every team it has, named, even before the room has read them all. */}
      {deleting && <DeleteProjectDialog project={project} teams={project.teams.filter((path) => !room?.teams.find((team) => team.path === path)?.alsoIn?.length).map((path) => teams.find((team) => team.path === path)?.name ?? (listed ?? []).find((team) => team.path === path)?.name ?? teamDisplayName({ path }))} working={(room?.teams ?? []).flatMap((team) => (team.alsoIn?.length ? [{ name: team.name, in: team.alsoIn.map((other) => other.name) }] : []))} onDeleted={() => window.location.assign('/')} onClose={() => setDeleting(false)} />}
      {takingOut && (
        <TakeOutDialog
          name={takingOut.name}
          here={project.name}
          others={(takingOut.alsoIn ?? []).map((other) => other.name)}
          onTakeOut={() => takeTeamOut(takingOut.path).then(() => {
            setSaid(<>{takingOut.name} is out of {project.name}. It still works in {listNames((takingOut.alsoIn ?? []).map((other) => other.name))}.</>)
            setTakingOut(null)
            reload()
          })}
          onClose={() => setTakingOut(null)}
        />
      )}
      {deletingTeam && (
        <DeleteTeamDialog
          path={deletingTeam.path}
          name={deletingTeam.name}
          places={othersOf(deletingTeam).length > 0 ? { here: project.name, others: othersOf(deletingTeam) } : undefined}
          onTakeOut={() => takeTeamOut(deletingTeam.path).then(() => {
            setSaid(<>{deletingTeam.name} is out of {project.name}. It still works in {listNames(othersOf(deletingTeam).map((other) => other.project))}.</>)
            setDeletingTeam(null)
            reload()
          })}
          onDeleted={() => { setDeletingTeam(null); projectsChanged(); reload() }}
          onClose={() => setDeletingTeam(null)}
        />
      )}
      {newTeam && (
        <NewTeamDialog
          existingPaths={[...(listed ?? []).map((team) => team.path), ...trashed]}
          project={project.id}
          onCreated={(path) => window.location.assign(teamHref(path, 'workflow'))}
          onClose={() => setNewTeam(false)}
        />
      )}
    </div>
  )
}
