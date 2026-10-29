import { ChevronLeft, Folder, MoreHorizontal, Plus, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { figureFor, type FigureChoice } from '../../lib/library/figures'
import { fetchJobs, saveJob, type SavedJob } from '../../lib/library/jobs'
import { addProjectNote, NOTE_CHARS, ABOUT_CHARS, projectsChanged, saveProject, useProjects, type Project, type ProjectEntry } from '../../lib/projects/client'
import { PRESENCE_WORDS } from '../../lib/rail/presence'
import { inOpenedOrder, litAt, roomsOf, type RoomTeam } from '../../lib/projects/studio'
import { useTeamShapes } from '../../lib/projects/useTeamShapes'
import { fetchRuns, type RunRecord } from '../../lib/runs/client'
import { fetchTeamFile, fetchTeamsDiscovery, saveTeamFile } from '../../lib/team-file/client'
import { TeamFileModel } from '../../lib/team-file/document'
import { teamOfMyAgents } from '../../lib/team-file/myAgents'
import { agentsTeamYaml, uniqueTeamPath } from '../../lib/team-file/templates'
import { teamHref } from '../../lib/team-file/teamHref'
import { hashTeamYaml, teamIdForPath } from '../../lib/team-file/useTeamDocument'
import { useTeamList } from '../../lib/team-file/useTeamList'
import { useTheme } from '../../lib/theme'
import { FigureStill } from '../agents/FigureStill'
import { FolderPicker } from '../canvas/FolderPicker'
import { NewTeamDialog } from '../home/NewTeamDialog'
import { SectionHead } from '../ui/SectionHead'
import { MARKS, MARK_NAMES, defaultFigureOf, markOf, roomHref } from '../../lib/projects/studioUi'
import { RoomAsk } from './RoomAsk'
import { ProjectMark } from './RoomCard'
import { TeamDesks } from './TeamDesks'

/** How often the room looks at its teams' runs again, so its figures follow the work. */
const RUNS_EVERY_MS = 4000

/** The runs, read again every few seconds; null until the first read. */
function useRuns(): RunRecord[] | null {
  const [runs, setRuns] = useState<RunRecord[] | null>(null)
  useEffect(() => {
    let live = true
    const read = () => { void fetchRuns().then((next) => { if (live) setRuns(next) }, () => { if (live) setRuns((last) => last ?? []) }) }
    read()
    const timer = window.setInterval(read, RUNS_EVERY_MS)
    return () => { live = false; window.clearInterval(timer) }
  }, [])
  return runs
}

/** What a team in the room is doing, when none of its desks shows it: it stopped, or nobody is at work yet. */
function said(team: RoomTeam): string | null {
  if (team.state === 'ready' || litAt(team)) return null
  return team.state === 'failed' ? 'didn’t finish' : PRESENCE_WORDS[team.state]
}

/** The project without the fields the list adds, as `PUT /api/projects/{id}` takes it. */
function fileOf(project: ProjectEntry): Project {
  const { id: _id, teams: _teams, ...file } = project
  return file
}

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

/** A team moved into another project (ADR 0097, ruling 1): its file names that project, saved as the editor saves it. */
async function moveTeam(path: string, project: string): Promise<void> {
  const file = await fetchTeamFile(path)
  const team = TeamFileModel.parse(file.yaml)
  team.setProject(project)
  await saveTeamFile(path, team.toYaml(), file.revision ?? await hashTeamYaml(file.yaml))
  projectsChanged()
}

/** A team's way into another of your projects, from its row in the room. */
function MoveTeam({ team, projects, onMove }: { team: { path: string; name: string }; projects: readonly ProjectEntry[]; onMove: (to: ProjectEntry) => void }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false) }
    window.addEventListener('pointerdown', away)
    return () => window.removeEventListener('pointerdown', away)
  }, [open])
  if (projects.length === 0) return null
  return (
    <span className="room-team-move" ref={box}>
      <button type="button" className="iconbtn" aria-label={`Move ${team.name} to another project`} title="Move to another project" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((value) => !value)}><MoreHorizontal size={16} aria-hidden="true" /></button>
      {open && (
        <span className="idle-agent-menu" role="menu" aria-label={`Move ${team.name} to`}>
          <span className="room-team-move-head" aria-hidden="true">Move to</span>
          {projects.map((other) => (
            <button key={other.id} type="button" role="menuitem" onClick={() => { setOpen(false); onMove(other) }}>
              <ProjectMark id={other.id} mark={other.mark} />{other.name}
            </button>
          ))}
        </span>
      )}
    </span>
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
        {where && <p className="set-up-hint">It joins the team, whose workflow opens for you to connect it.</p>}
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
 * Inside a project's room (ADR 0097): the wall holds what every agent here knows (its About, its
 * folders and the notes kept), and the floor its teams at their desks, in the order work moves.
 */
export function ProjectRoom({ id }: { id: string }) {
  useTheme()
  const { list, error, reload } = useProjects()
  const { root, shapes, jobs } = useTeamShapes(list)
  const runs = useRuns()
  // Where teams are and were: a new team never takes the place of a deleted one, whose history it would inherit.
  const { teams: listed, trashed } = useTeamList()
  const [noting, setNoting] = useState(false)
  const [note, setNote] = useState('')
  const [picking, setPicking] = useState(false)
  const [menu, setMenu] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [newTeam, setNewTeam] = useState(false)
  const [adding, setAdding] = useState<string | null | false>(() => new URLSearchParams(window.location.search).get('add') ?? false)
  const [problem, setProblem] = useState<string | null>(null)
  const [moved, setMoved] = useState<{ team: string; to: ProjectEntry } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const project = list?.projects.find((candidate) => candidate.id === id) ?? null
  const figures = useMemo(() => new Map<string, FigureChoice | undefined>(jobs.map((job) => [job.id, job.figure])), [jobs])
  const figureOf = useMemo(() => defaultFigureOf(figures), [figures])
  const room = useMemo(() => (project && shapes ? roomsOf([project], shapes, runs ?? [], root)[0] : null), [project, shapes, runs, root])
  // The order the teams stood in once the runs were read, kept while you are here: the room puts
  // the team waiting for you first, but a team that starts work never slides under your pointer.
  const [opened, setOpened] = useState<string[] | null>(null)
  useEffect(() => { if (room && runs && !opened) setOpened(room.teams.map((team) => team.path)) }, [room, runs, opened])

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
      await saveProject(project.id, { ...fileOf(project), ...change })
      reload()
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      setProblem(message)
      throw caught
    }
  }

  if (error) return <main className="project-room"><p role="alert" className="home-empty alert">Couldn’t open the project. {error}</p></main>
  if (!list) return <main className="project-room"><p role="status" className="home-empty">Opening the project…</p></main>
  if (!project) return <main className="project-room"><p role="alert" className="home-empty">There is no project “{id}”. <a className="link" href="/">Back to Home</a></p></main>

  const teams = (room?.teams ?? []).map((team) => ({ path: team.path, name: team.name }))
  return (
    <div className="project-room-page" data-tour="room">
      <header className="room-top">
        <a className="room-home" href="/"><ChevronLeft size={14} aria-hidden="true" />Home</a>
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
            </div>
          )}
        </div>
      </header>

      <main className="project-room">
        {problem && <p role="alert" className="home-empty alert">{problem}</p>}
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

        <section className="room-floor" aria-labelledby="room-floor-title">
          <h2 id="room-floor-title" className="studio-head">Teams</h2>
          {inOpenedOrder(room?.teams ?? [], opened).map((team) => (
            <div key={team.path} className="room-team">
              {/* When no desk shows what the team is doing (it stopped, or nobody is at work yet), its name says it. */}
              <a className="room-team-name" href={teamHref(team.path, 'chat')}>
                <b>{team.name}</b>
                {said(team) && <>{' '}<span className={`room-state ${team.state}`}>{said(team)}</span></>}
                {team.schedule && <>{' '}<span>{said(team) ? `· ${team.schedule}` : team.schedule}</span></>}
              </a>
              <MoveTeam
                team={team}
                projects={list.projects.filter((other) => other.id !== project.id)}
                onMove={(to) => {
                  setProblem(null)
                  moveTeam(team.path, to.id).then(() => { setMoved({ team: team.name, to }); reload() }, (caught: unknown) => setProblem(`Couldn’t move ${team.name}. ${caught instanceof Error ? caught.message : String(caught)}`))
                }}
              />
              <TeamDesks team={team} figureOf={figureOf} size={56} all />
            </div>
          ))}
          {moved && <p role="status" className="studio-quiet">{moved.team} works in <a className="link" href={roomHref(moved.to.id)}>{moved.to.name}</a> now.</p>}
          {room && room.teams.length === 0 && <p className="studio-quiet">No team works here yet.</p>}
          <span className="room-floor-acts">
            <button type="button" className="btn" onClick={() => setAdding(null)}>Add an agent</button>
            <button type="button" className="btn" data-tour="new-team" onClick={() => setNewTeam(true)}>New team</button>
          </span>
        </section>
      </main>

      {picking && (
        <FolderPicker
          title="Add a folder to the project"
          note="Every agent in the project may read what is in it, without asking. It is linked, not copied."
          onChoose={(folder) => { setPicking(false); void keep({ folders: [...(project.folders ?? []), { name: folder.name, path: folder.path }] }).catch(() => {}) }}
          onClose={() => setPicking(false)}
        />
      )}
      {adding !== false && <AddAnAgent jobs={jobs} project={project} teams={teams} initial={adding} onClose={() => { setAdding(false); reload() }} />}
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
