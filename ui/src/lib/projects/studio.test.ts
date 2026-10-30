import { describe, expect, it } from 'vitest'

import type { RunRecord } from '../runs/client'
import type { ProjectEntry } from './client'
import { deskItems, otherTeams, rankRooms, roomsOf, seatWords, shownSeats, studioLayout, teamShapeOf, type Room, type TeamShape } from './studio'

const PIPELINE = `schemaVersion: 1
id: gate
name: Research and design
project: sutd
entrypoint: researcher
agents:
  - id: designer
    from: {agent: designer}
  - id: researcher
    from: {agent: researcher}
  - id: review
    kind: operator
    role: Pick one.
edges:
  - {from: researcher, to: review, layer: configured, kind: sequence, ts: "2026-10-28T00:00:00Z"}
  - {from: review, to: designer, layer: configured, kind: sequence, ts: "2026-10-28T00:00:00Z"}
`
const JOBS = [{ id: 'researcher', name: 'Researcher' }, { id: 'designer', name: 'Designer' }, { id: 'writer', name: 'Writer' }]

function run(teamPath: string, extra: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: `run-${Math.random()}`, sessionId: 's', teamPath, prompt: 'p', status: 'running', mode: 'pipeline', entrypoint: 'a', responder: 'a',
    agentIds: [], createdAt: '2026-10-28T09:00:00Z', startedAt: '2026-10-28T09:00:00Z', finishedAt: null, error: null, exitCode: null, eventCount: null, reply: null,
    ...extra,
  } as RunRecord
}

const project = (id: string, teams: string[], extra: Partial<ProjectEntry> = {}): ProjectEntry => ({ id, name: id.toUpperCase(), teams, ...extra })

describe('the studio (ADR 0097)', () => {
  it('stands a team’s desks in the order work moves, with a desk where you check', () => {
    const shape = teamShapeOf('sutd/gate.yaml', PIPELINE, JOBS) as TeamShape
    expect(shape.project).toBe('sutd')
    expect(shape.seats.map((seat) => [seat.kind, seat.name])).toEqual([['agent', 'Researcher'], ['you', 'You check'], ['agent', 'Designer']])
    expect(teamShapeOf('x.yaml', 'not: [a team')).toBeNull()
    const lead = teamShapeOf('lead.yaml', 'schemaVersion: 1\nname: Desk\nentrypoint: lead\nschedule: {cron: "0 8 * * *"}\nagents:\n  - {id: helper, name: Helper}\n  - {id: lead, name: Lead}\nedges: []\n') as TeamShape
    expect(lead.seats.map((seat) => seat.name)).toEqual(['Lead', 'Helper'])
    expect(lead.schedule).toMatch(/^Every day at 8/)
    // A paused routine doesn't run, so it isn't said, and its team doesn't stand up for it.
    expect((teamShapeOf('p.yaml', 'schemaVersion: 1\nname: Desk\nentrypoint: lead\nschedule: {cron: "0 8 * * *", enabled: false}\nagents:\n  - {id: lead, name: Lead}\nedges: []\n') as TeamShape).schedule).toBeNull()
  })

  it('draws an agent where it is now: lit at its desk where it waits for you or works, faint elsewhere', () => {
    const gate = teamShapeOf('gate.yaml', PIPELINE, JOBS) as TeamShape
    const brief: TeamShape = { path: 'brief.yaml', name: 'Market brief', project: 'market', seats: [{ kind: 'agent', id: 'w', name: 'Writer', agent: 'writer' }, { kind: 'agent', id: 'r', name: 'Researcher', agent: 'researcher' }], schedule: null }
    const runs = [
      run('gate.yaml', { waitingOn: { node: 'review', name: 'You', kind: 'review_stop', since: 'x', question: 'Pick', handoverFrom: 'researcher', park: 'none', parkNote: '', sendBackAvailable: true } }),
      run('brief.yaml', { working: ['w'] }),
    ]
    const [sutd, market] = roomsOf([project('sutd', ['gate.yaml']), project('market', ['brief.yaml'])], [gate, brief], runs, null)
    expect(sutd.state).toBe('waiting')
    expect(sutd.line).toBe('Researcher is waiting for you')
    // Waiting for you, it stands lit at its own desk, as the tiles above say it waits.
    expect(sutd.teams[0].seats[0]).toMatchObject({ name: 'Researcher', state: 'waiting', away: null })
    expect(seatWords(sutd.teams[0].seats[0])).toBe('Researcher is waiting for you')
    expect(market.state).toBe('working')
    expect(market.line).toBe('Writer is working')
    // The Researcher waits for you in Research and design, so its desk in Market brief is faint, saying where.
    expect(market.teams[0].seats[1]).toMatchObject({ name: 'Researcher', away: 'in Research and design' })
    // Waiting here and working there at once, it is lit in both, each where it is busy.
    const both = roomsOf([project('sutd', ['gate.yaml']), project('market', ['brief.yaml'])], [gate, brief], [...runs, run('brief.yaml', { working: ['r'] })], null)
    expect(both[0].teams[0].seats[0]).toMatchObject({ name: 'Researcher', state: 'waiting', away: null })
    expect(both[1].teams[0].seats[1]).toMatchObject({ name: 'Researcher', state: 'working', away: null })
  })

  it('names the team an agent works in when it is elsewhere, and draws it in each room it works in', () => {
    const one: TeamShape = { path: 'a.yaml', name: 'Alpha', project: 'a', seats: [{ kind: 'agent', id: 'w', name: 'Writer', agent: 'writer' }], schedule: null }
    const two: TeamShape = { path: 'b.yaml', name: 'Beta', project: 'b', seats: [{ kind: 'agent', id: 'w', name: 'Writer', agent: 'writer' }], schedule: null }
    const three: TeamShape = { path: 'c.yaml', name: 'Gamma', project: 'c', seats: [{ kind: 'agent', id: 'w', name: 'Writer', agent: 'writer' }], schedule: null }
    const rooms = roomsOf([project('a', ['a.yaml']), project('b', ['b.yaml']), project('c', ['c.yaml'])], [one, two, three], [run('a.yaml', { working: ['w'] }), run('b.yaml', { working: ['w'] })], null)
    expect(rooms.map((room) => room.teams[0].seats[0].away)).toEqual([null, null, 'in Alpha'])
    expect(rooms.map((room) => room.state)).toEqual(['working', 'working', 'ready'])
  })

  // ADR 0103: a team set up once works in several projects, each place a file of its own.
  it('says which other projects a team works in, by name, and not the one it is in nor a place in none', () => {
    const here = teamShapeOf('gate.yaml', PIPELINE.replace('id: gate\n', 'id: gate\nshares: gate\n'), JOBS) as TeamShape
    const there = teamShapeOf('gate-thesis.yaml', PIPELINE.replace('id: gate\n', 'id: gate-thesis\nshares: gate\n').replace('project: sutd', 'project: thesis'), JOBS) as TeamShape
    const loose = teamShapeOf('gate-2.yaml', PIPELINE.replace('id: gate\n', 'id: gate-2\nshares: gate\n').replace('project: sutd\n', ''), JOBS) as TeamShape
    const other = teamShapeOf('blog.yaml', PIPELINE.replace('id: gate\n', 'id: blog\nshares: blog\n').replace('project: sutd', 'project: thesis'), JOBS) as TeamShape
    expect(here.shares).toBe('gate')
    const [sutd] = roomsOf([project('sutd', ['gate.yaml'])], [here, there, loose, other], [], null, [project('sutd', []), project('thesis', [])])
    expect(sutd.teams[0].alsoIn).toEqual([{ id: 'thesis', name: 'THESIS' }])
    // A team in one project says nothing more.
    const [alone] = roomsOf([project('thesis', ['blog.yaml'])], [here, there, loose, other], [], null)
    expect(alone.teams[0].alsoIn).toBeUndefined()
  })

  it('says when a quiet room runs, and that a stopped team stopped', () => {
    const scheduled: TeamShape = { path: 's.yaml', name: 'News', project: 'n', seats: [], schedule: 'Every day at 8:00 AM' }
    const broken: TeamShape = { path: 'f.yaml', name: 'Blog', project: 'b', seats: [], schedule: null }
    const [news, blog, empty] = roomsOf([project('n', ['s.yaml']), project('b', ['f.yaml']), project('e', [])], [scheduled, broken], [run('f.yaml', { status: 'failed', finishedAt: '2026-10-28T10:00:00Z' })], null)
    expect(news.line).toBe('Runs every day at 8:00 AM')
    expect(blog.state).toBe('failed')
    expect(blog.line).toBe('Blog didn’t finish')
    expect(empty.line).toBe('No team yet')
  })

  it('puts a room’s team waiting for you first, then working, then the next to run, and names the others at work', () => {
    const gate = teamShapeOf('gate.yaml', PIPELINE, JOBS) as TeamShape
    const pages: TeamShape = { path: 'pages.yaml', name: 'Product pages', project: 'shop', seats: [{ kind: 'agent', id: 'w', name: 'Writer', agent: 'writer' }], schedule: null }
    const weekly: TeamShape = { path: 'weekly.yaml', name: 'Weekly report', project: 'shop', seats: [{ kind: 'agent', id: 'c', name: 'Checker', agent: 'checker' }], schedule: 'Every Monday at 9:00 AM' }
    const plain: TeamShape = { path: 'plain.yaml', name: 'Plain', project: 'shop', seats: [], schedule: null }
    const runs = [
      run('pages.yaml', { working: ['w'] }),
      run('gate.yaml', { waitingOn: { node: 'review', name: 'You', kind: 'review_stop', since: 'x', question: 'Pick', handoverFrom: 'researcher', park: 'none', parkNote: '', sendBackAvailable: true } }),
    ]
    // Listed in the project in another order: the room still leads with what needs you.
    const [shop] = roomsOf([project('shop', ['plain.yaml', 'weekly.yaml', 'pages.yaml', 'gate.yaml'])], [gate, pages, weekly, plain], runs, null)
    expect(shop.teams.map((team) => team.name)).toEqual(['Research and design', 'Product pages', 'Weekly report', 'Plain'])
    expect(shop.line).toBe('Researcher is waiting for you')
    expect(otherTeams(shop)).toEqual({ named: [{ path: 'pages.yaml', name: 'Product pages', state: 'working', words: 'is working' }], more: 2, moreQuiet: true })

    // Quiet, the team that runs on a schedule leads, and the line says when it runs.
    const [quiet] = roomsOf([project('shop', ['plain.yaml', 'weekly.yaml'])], [weekly, plain], [], null)
    expect(quiet.teams.map((team) => team.name)).toEqual(['Weekly report', 'Plain'])
    expect(quiet.line).toBe('Runs every Monday at 9:00 AM')
    expect(otherTeams(quiet)).toEqual({ named: [], more: 1, moreQuiet: true })
  })

  it('shows, of two teams at work, the one with someone at a desk doing it', () => {
    const lead: TeamShape = { path: 'a.yaml', name: 'Alpha', project: 'p', seats: [{ kind: 'agent', id: 'x', name: 'Xavier', agent: 'x' }], schedule: null }
    const other: TeamShape = { path: 'b.yaml', name: 'Beta', project: 'p', seats: [{ kind: 'agent', id: 'y', name: 'Yara', agent: 'y' }], schedule: null }
    // Alpha's run is under way with no one at work yet; Beta's Yara works. The card shows Yara at it.
    const [room] = roomsOf([project('p', ['a.yaml', 'b.yaml'])], [lead, other], [run('a.yaml'), run('b.yaml', { working: ['y'] })], null)
    expect(room.teams.map((team) => team.name)).toEqual(['Beta', 'Alpha'])
    expect(room.line).toBe('Yara is working')
    expect(otherTeams(room).named.map((team) => `${team.name} ${team.words}`)).toEqual(['Alpha is working'])
  })

  it('puts rooms waiting for you first, then working, then the rest, newest work first', () => {
    const room = (id: string, state: Room['state'], lastWorked: string | null = null): Room => ({ id, name: id, putAway: false, teams: [], state, line: '', lastWorked })
    expect(rankRooms([room('a', 'ready', '2026-10-01'), room('b', 'working'), room('c', 'ready', '2026-10-20'), room('d', 'waiting')]).map((r) => r.id)).toEqual(['d', 'b', 'c', 'a'])
  })

  it('folds quiet projects into tiles once there are many, and keeps the put-away ones apart', () => {
    const room = (id: string, state: Room['state'], putAway = false): Room => ({ id, name: id, putAway, teams: [], state, line: '', lastWorked: null })
    const few = studioLayout([room('a', 'ready'), room('b', 'working'), room('z', 'ready', true)])
    expect(few.open.map((r) => r.id)).toEqual(['b', 'a'])
    expect(few.putAway.map((r) => r.id)).toEqual(['z'])
    const many = studioLayout(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => room(id, id === 'g' ? 'waiting' : 'ready')))
    expect(many.open.map((r) => r.id)).toEqual(['g'])
    expect(many.quiet).toHaveLength(6)
  })

  it('puts at Your desk whoever waits for you, with what they brought, oldest first', () => {
    const gate = teamShapeOf('gate.yaml', PIPELINE, JOBS) as TeamShape
    const items = deskItems([
      run('gate.yaml', { waitingOn: { node: 'review', name: 'You', kind: 'review_stop', since: '2026-10-28T10:00:00Z', question: 'Pick', handoverFrom: 'researcher', park: 'none', parkNote: '', sendBackAvailable: true } }),
      run('gate.yaml', { permissionRequests: [{ id: 'p1', agent: 'designer', name: 'Designer', title: 'Bash', kind: 'execute', since: '2026-10-28T09:00:00Z' } as never] }),
      run('gate.yaml', { status: 'succeeded', waitingOn: { node: 'review', name: 'You', kind: 'review_stop', since: 'x', question: 'old', handoverFrom: 'researcher', park: 'none', parkNote: '', sendBackAvailable: false } }),
    ], [gate], null)
    expect(items.map((item) => [item.seat.name, item.says, item.teamName])).toEqual([
      ['Designer', 'asks you before it goes on', 'Research and design'],
      ['Researcher', 'brought work for you to check', 'Research and design'],
    ])
    expect(items[1].seat.agent).toBe('researcher')
  })

  it('shows four desks, then how many more', () => {
    const seats = Array.from({ length: 6 }, (_, index) => ({ kind: 'agent' as const, id: `${index}`, name: `${index}`, state: 'ready' as const, away: null }))
    expect(shownSeats(seats)).toMatchObject({ more: 2 })
    expect(shownSeats(seats).shown).toHaveLength(4)
  })
})
