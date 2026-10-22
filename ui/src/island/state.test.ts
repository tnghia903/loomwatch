import { describe, expect, it } from 'vitest'

import type { RunRecord } from '../lib/runs/client'
import { answering, at, failed, iso, maya, OUT_OF_CREDITS, permission, pinnedChat, run, said } from './fixtures'
import type { TeamRequest } from '../lib/runs/teamRequests'
import { pinnedNow } from './pinned'
import { initialIsland, islandReducer, viewOf, type IslandAction, type IslandState } from './state'
import { tucked } from './teams'
import { ISLAND_WAITS } from './waits'

function play(steps: [number, IslandAction][], start = initialIsland(at(0), true)): IslandState {
  return steps.reduce((state, [now, action]) => islandReducer(state, { ...action, now }), start)
}

const placed: IslandAction = { type: 'app', message: { kind: 'place', notch: { width: 188, height: 32 }, menuBar: 32 } }
const runs = (...records: RunRecord[]): IslandAction => ({ type: 'runs', records })

describe('the island, moment by moment', () => {
  it('stays hidden until the app says where it is, then rests as the notch', () => {
    expect(viewOf(initialIsland(at(0), true))).toBe('hidden')
    expect(viewOf(play([[at(0), placed], [at(0), runs()]]))).toBe('rest')
  })

  it('pops a start out below the notch, then tucks it into the menu bar', () => {
    const s = play([[at(0), placed], [at(0), runs()], [at(1), runs(run('a', { working: ['researcher'] }))]])
    expect(viewOf(s)).toBe('work')
    expect(viewOf(islandReducer(s, { type: 'tick', now: at(1) + ISLAND_WAITS.start }))).toBe('tucked')
  })

  it('drops a question; answering it drops the next at once', () => {
    const asking = run('a', { permissionRequests: [permission('p1'), permission('p2')] })
    let s = play([[at(0), placed], [at(0), runs()], [at(1), runs(asking)]])
    expect([viewOf(s), s.pop.out?.pop.key]).toEqual(['ask', 'a:permission:p1'])
    s = islandReducer(s, { type: 'answered', ticket: 'a:permission:p1', now: at(1) + 2000 })
    s = islandReducer(s, { type: 'runs', records: [run('a', { permissionRequests: [permission('p2')] })], now: at(1) + 2100 })
    expect([viewOf(s), s.pop.out?.pop.key]).toEqual(['ask', 'a:permission:p2'])
  })

  it('answering one question drops the next at once, even one that already had its turn', () => {
    const asking = run('a', { permissionRequests: [permission('p1'), permission('p2')] })
    let s = play([[at(0), placed], [at(0), runs()], [at(1), runs(asking)]])
    // Both have had their turn and tucked away.
    s = islandReducer(s, { type: 'tick', now: at(1) + ISLAND_WAITS.ask })
    s = islandReducer(s, { type: 'tick', now: at(1) + ISLAND_WAITS.ask + ISLAND_WAITS.between })
    s = islandReducer(s, { type: 'tick', now: at(1) + 2 * ISLAND_WAITS.ask + ISLAND_WAITS.between })
    expect(viewOf(s)).toBe('tucked')
    s = islandReducer(s, { type: 'answered', ticket: 'a:permission:p1', now: at(3) })
    expect([viewOf(s), s.pop.out?.pop.key]).toEqual(['ask', 'a:permission:p2'])
  })

  it('pointing at the island opens the list in place of what was out; it closes once the pointer has left', () => {
    let s = play([[at(0), placed], [at(0), runs()], [at(1), runs(run('a', { permissionRequests: [permission('p1')] }))]])
    s = islandReducer(s, { type: 'pointerOnIsland', over: true, now: at(1) + 500 })
    expect(viewOf(s)).toBe('list')
    expect(s.pop.out).toBeNull()
    // Still on it: the list stays.
    expect(viewOf(islandReducer(s, { type: 'closeList', now: at(2) }))).toBe('list')
    s = islandReducer(s, { type: 'pointerOnIsland', over: false, now: at(2) })
    expect(viewOf(islandReducer(s, { type: 'closeList', now: at(2) }))).toBe('tucked')
  })

  it('a result stays beside the notch until you look at the list, then leaves', () => {
    let s = play([
      [at(0), placed],
      [at(0), runs(run('a', { working: ['writer'] }))],
      [at(5), runs(run('a', { status: 'succeeded', finishedAt: iso(5), reply: 'Five days in Kyoto' }))],
    ])
    expect(viewOf(s)).toBe('done')
    s = islandReducer(s, { type: 'tick', now: at(5) + ISLAND_WAITS.result })
    expect(viewOf(s)).toBe('tucked')
    s = islandReducer(s, { type: 'pointerOnIsland', over: true, now: at(6) })
    s = islandReducer(s, { type: 'pointerOnIsland', over: false, now: at(6) + 100 })
    s = islandReducer(s, { type: 'closeList', now: at(6) + 900 })
    expect(viewOf(s)).toBe('rest')
    // Reading the runs again does not bring it back.
    s = islandReducer(s, { type: 'runs', records: [run('a', { status: 'succeeded', finishedAt: iso(5) })], now: at(7) })
    expect(viewOf(s)).toBe('rest')
  })

  it('hears from the app where the pointer is: the island opens the list, a question stays out while it is on it', () => {
    const asking = run('a', { permissionRequests: [permission('p1')] })
    let s = play([[at(0), placed], [at(0), runs()], [at(1), runs(asking)]])
    // On the question's card (the second area): it stays out past its ten seconds.
    s = islandReducer(s, { type: 'app', message: { kind: 'pointer', over: true, area: 1 }, now: at(1) + 1000 })
    s = islandReducer(s, { type: 'tick', now: at(1) + ISLAND_WAITS.ask * 3 })
    expect(viewOf(s)).toBe('ask')
    // Off everything: a moment more, then it tucks away.
    s = islandReducer(s, { type: 'app', message: { kind: 'pointer', over: false, area: null }, now: at(2) })
    expect(viewOf(islandReducer(s, { type: 'tick', now: at(2) + ISLAND_WAITS.afterPointer }))).toBe('tucked')
    // On the island itself (the first area): the list.
    s = islandReducer(s, { type: 'app', message: { kind: 'pointer', over: true, area: 0 }, now: at(3) })
    expect(viewOf(s)).toBe('list')
    // Off it, as the app says: the list closes.
    s = islandReducer(s, { type: 'app', message: { kind: 'pointer', over: false, area: null }, now: at(3) + 100 })
    expect(viewOf(islandReducer(s, { type: 'closeList', now: at(3) + 800 }))).toBe('tucked')
  })

  it('the list takes the place of a question that is out', () => {
    let s = play([[at(0), placed], [at(0), runs()], [at(1), runs(run('a', { permissionRequests: [permission('p1')] }))]])
    s = islandReducer(s, { type: 'app', message: { kind: 'pointer', over: true, area: 0 }, now: at(1) + 500 })
    expect(viewOf(s)).toBe('list')
    expect(s.pop.out).toBeNull()
  })

  it('a click elsewhere tucks away what is out, once it has been out a moment', () => {
    let s = play([[at(0), placed], [at(0), runs()], [at(1), runs(run('a', { permissionRequests: [permission('p1')] }))]])
    s = islandReducer(s, { type: 'app', message: { kind: 'clickOutside' }, now: at(1) + 300 })
    expect(viewOf(s)).toBe('ask')
    s = islandReducer(s, { type: 'app', message: { kind: 'clickOutside' }, now: at(1) + ISLAND_WAITS.clickGrace })
    expect(viewOf(s)).toBe('tucked')
  })

  it('without a notch, it rests at the middle of the menu bar as at a notch; over a full-screen app, only what drops out shows', () => {
    const noNotch: IslandAction = { type: 'app', message: { kind: 'place', notch: null, menuBar: 24 } }
    expect(viewOf(play([[at(0), noNotch], [at(0), runs()]]))).toBe('rest')
    let s = play([[at(0), noNotch], [at(0), runs()], [at(1), runs(run('a', { working: ['researcher'] }))]])
    expect(viewOf(s)).toBe('work')
    s = islandReducer(s, { type: 'tick', now: at(1) + ISLAND_WAITS.start })
    expect(viewOf(s)).toBe('tucked')
    s = islandReducer(s, { type: 'app', message: { kind: 'fullScreen', on: true }, now: at(2) })
    expect(viewOf(s)).toBe('hidden')
    s = islandReducer(s, { type: 'runs', records: [run('a', { permissionRequests: [permission('p1')] })], now: at(2) })
    expect(viewOf(s)).toBe('ask')
    s = islandReducer(s, { type: 'tick', now: at(2) + ISLAND_WAITS.ask })
    expect(viewOf(s)).toBe('hidden')
  })

  it('keeps the answers in the chat it last knew when they could not be read, beside the runs', () => {
    let s = play([[at(0), placed], [at(0), runs()], [at(1), { type: 'runs', records: [], notes: [answering('m1')] }]])
    expect(s.teams?.map((team) => team.runId)).toEqual(['m1'])
    s = islandReducer(s, { type: 'runs', records: [run('a', { working: ['researcher'] })], notes: null, now: at(1) + 2000 })
    expect(s.teams?.map((team) => team.runId)).toEqual(['a', 'm1'])
  })

  it('an agent that could not answer in the chat slides out as a stop, and leaves once opened', () => {
    let s = play([[at(0), placed], [at(0), runs()], [at(1), { type: 'runs', records: [], notes: [answering('m1')] }]])
    expect(viewOf(s)).toBe('work')
    s = islandReducer(s, { type: 'tick', now: at(1) + ISLAND_WAITS.start })
    const stopped = answering('m1', { answers: { waiting: [], said: [], failed: [failed(OUT_OF_CREDITS)] }, finishedAt: iso(2) })
    s = islandReducer(s, { type: 'runs', records: [], notes: [stopped], now: at(2) })
    expect(viewOf(s)).toBe('fail')
    expect(s.shown?.team).toMatchObject({ runId: 'm1', moment: 'fail', chat: true, result: OUT_OF_CREDITS })
    s = islandReducer(s, { type: 'opened', runId: 'm1', now: at(3) })
    expect(s.teams).toEqual([])
  })

  it('an answer in the chat that was opened leaves; one still being written stays', () => {
    const answered = answering('m1', { answers: { waiting: [], said: [said('Every item keeps one number.')] }, finishedAt: iso(2) })
    let s = play([[at(0), placed], [at(0), runs()], [at(2), { type: 'runs', records: [], notes: [answered, answering('m2', { createdAt: iso(1) })] }]])
    expect(s.teams?.map((team) => [team.runId, team.moment])).toEqual([['m1', 'done'], ['m2', 'work']])
    s = islandReducer(s, { type: 'opened', runId: 'm1', now: at(3) })
    expect(s.teams?.map((team) => [team.runId, team.moment])).toEqual([['m2', 'work']])
  })
})

describe('writing to the agent pinned to the notch', () => {
  const pinned: IslandAction = { type: 'pinned', pinned: pinnedNow('maya', [maya]) }

  it('keeps the list open wherever the pointer goes, until a click lands elsewhere', () => {
    let s = play([[at(0), placed], [at(0), runs()], [at(0), pinned], [at(1), { type: 'compose', on: true }]])
    expect([viewOf(s), s.composing]).toEqual(['list', true])
    s = islandReducer(s, { type: 'pointerOnIsland', over: false, now: at(1) })
    expect(viewOf(islandReducer(s, { type: 'closeList', now: at(2) }))).toBe('list')
    s = islandReducer(s, { type: 'app', message: { kind: 'clickOutside' }, now: at(2) })
    expect([viewOf(s), s.composing]).toEqual(['rest', false])
  })

  it('opens the list to write when the app’s menu asks, but only to an agent that is pinned', () => {
    expect(viewOf(play([[at(0), placed], [at(0), runs()], [at(0), pinned], [at(1), { type: 'app', message: { kind: 'compose' } }]]))).toBe('list')
    const none = play([[at(0), placed], [at(0), runs()], [at(1), { type: 'app', message: { kind: 'compose' } }], [at(1), { type: 'compose', on: true }]])
    expect([viewOf(none), none.composing]).toEqual(['rest', false])
  })

  it('names its work as the agent, opening its chat, and leaves every team as it was', () => {
    const working = runs(pinnedChat('c1', { working: ['maya'] }), run('r1', { working: ['writer'] }))
    const s = play([[at(0), placed], [at(0), pinned], [at(0), working]])
    const shown = (state: IslandState) => state.teams?.map((team) => [team.teamName, team.link, Boolean(team.pinned)])
    expect(shown(s)).toEqual([['Maya', '/agents/maya?view=chat', true], ['Trip planner', '/?path=trip.yaml&run=r1', false]])
    // Unpinned, its chat is a team like any other again.
    expect(shown(islandReducer(s, { type: 'pinned', pinned: null, now: at(1) }))?.[0]).toEqual(['Maya · chat', '/?path=.jobs%2F.bench%2Fmaya.yaml&run=c1', false])
  })
})

describe('the pinned agent’s slot, crew and requests for your teams', () => {
  const pinned: IslandAction = { type: 'pinned', pinned: pinnedNow('maya', [maya]) }
  const pdf = new File(['%PDF'], 'Lease 2027.pdf', { type: 'application/pdf' })
  const request = (changes: Partial<TeamRequest> = {}): TeamRequest => ({
    id: 'tr1',
    askedBy: { runId: 'c1', agent: 'maya', chatPath: '.jobs/.bench/maya.yaml' },
    team: { path: 'trip.yaml', name: 'Trip planner' },
    request: 'Plan three gentle days in Đà Lạt',
    status: 'waiting',
    runId: null,
    problem: null,
    createdAt: iso(1),
    finishedAt: null,
    ...changes,
  })

  it('opens as a slot while something is dragged near, over whatever was out, only with an agent pinned', () => {
    const near: IslandAction = { type: 'app', message: { kind: 'drag', near: true } }
    expect(viewOf(play([[at(0), placed], [at(0), runs()], [at(1), near]]))).toBe('rest')
    let s = play([[at(0), placed], [at(0), pinned], [at(0), runs()], [at(1), runs(run('a', { permissionRequests: [permission('p1')] }))]])
    expect(viewOf(s)).toBe('ask')
    s = islandReducer(s, { ...near, now: at(1) + 500 })
    expect(viewOf(s)).toBe('slot')
    s = islandReducer(s, { type: 'app', message: { kind: 'drag', near: false }, now: at(1) + 900 })
    expect(viewOf(s)).not.toBe('slot')
  })

  it('stays open for a drop that comes after the button is up: the drag’s own events close it', () => {
    let s = play([[at(0), placed], [at(0), pinned], [at(0), runs()], [at(1), { type: 'app', message: { kind: 'drag', near: true } }], [at(1), { type: 'dragOver', over: true }]])
    s = islandReducer(s, { type: 'app', message: { kind: 'drag', near: false }, now: at(1) + 100 })
    expect(viewOf(s)).toBe('slot')
    s = islandReducer(s, { type: 'drop', intake: { files: [pdf], link: null, text: null }, now: at(1) + 200 })
    expect(viewOf(s)).toBe('list')
  })

  it('keeps what was dropped in the box, open to write, until it goes with a message', () => {
    let s = play([[at(0), placed], [at(0), pinned], [at(0), runs()], [at(1), { type: 'dragOver', over: true }]])
    expect(viewOf(s)).toBe('slot')
    s = islandReducer(s, { type: 'drop', intake: { files: [pdf], link: null, text: null }, now: at(1) + 100 })
    expect([viewOf(s), s.composing, s.intake?.files[0]?.name, s.dragOver]).toEqual(['list', true, 'Lease 2027.pdf', false])
    s = islandReducer(s, { type: 'intakeDone', now: at(2) })
    expect(s.intake).toBeNull()
  })

  it('asks you to start one of your teams on the gold line, as a question, and counts it', () => {
    const s = play([[at(0), placed], [at(0), pinned], [at(0), runs()], [at(1), { type: 'runs', records: [], requests: [request()] }]])
    expect([viewOf(s), s.pop.out?.pop.key]).toEqual(['ask', 'team:tr1'])
    expect(s.teams?.[0]).toMatchObject({ pinned: true, moment: 'ask', teamName: 'Maya' })
    expect(tucked(s.teams ?? []).asks).toBe(1)
  })

  it('shows the team it started as its crew, hides what it said meanwhile, and gives you its answer, not the crew’s', () => {
    const asked = pinnedChat('c1', { status: 'succeeded', working: [], reply: 'I asked Trip planner.', finishedAt: iso(2) })
    const started = request({ status: 'started', runId: 'crew1' })
    let s = play([[at(0), placed], [at(0), pinned], [at(0), runs()], [at(3), { type: 'runs', records: [asked, run('crew1', { working: ['researcher'] })], requests: [started] }]])
    expect(s.teams?.map((team) => [team.runId, team.crewFor ?? null])).toEqual([['crew1', 'Maya']])
    // The crew finished: its answer goes to Maya, who starts a new turn; only hers comes to you.
    s = islandReducer(s, { type: 'runs', records: [asked, run('crew1', { status: 'succeeded', reply: 'Day 1…', finishedAt: iso(4) }), pinnedChat('c2', { working: ['maya'], startedAt: iso(4) })], requests: [request({ status: 'done', runId: 'crew1', finishedAt: iso(4) })], now: at(4) })
    expect(s.teams?.map((team) => team.runId)).toEqual(['c2'])
    // A crew that stopped stays, as a stop.
    s = islandReducer(s, { type: 'runs', records: [asked, run('crew1', { status: 'failed', error: 'boom', finishedAt: iso(5) })], requests: [request({ status: 'failed', runId: 'crew1', finishedAt: iso(5) })], now: at(5) })
    expect(s.teams?.map((team) => [team.runId, team.moment])).toEqual([['crew1', 'fail']])
  })

  it('says why a team you pressed Start on could not start, as a stop, until you look', () => {
    const refused = request({ status: 'failed', problem: 'Open Trip planner in LoomWatch and press Run once: it changed outside LoomWatch.', finishedAt: iso(2) })
    let s = play([[at(0), placed], [at(0), pinned], [at(0), runs()], [at(2), { type: 'runs', records: [], requests: [refused] }]])
    expect(s.teams?.map((team) => [team.teamName, team.moment, team.result, team.link])).toEqual([['Trip planner', 'fail', 'Open Trip planner in LoomWatch and press Run once: it changed outside LoomWatch.', '/?path=trip.yaml']])
    expect([viewOf(s), s.pop.out?.pop.kind]).toEqual(['fail', 'fail'])
    s = islandReducer(s, { type: 'opened', runId: 'team-request:tr1', now: at(3) })
    expect(s.teams).toEqual([])
  })
})

