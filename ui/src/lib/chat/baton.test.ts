import { describe, expect, it } from 'vitest'

import type { TeamMessage } from '../watch/messages'
import { agentResolver, batonOf, batonSettlesAt, batonWords, PASS_BEAT_MS, passesKey, passesOf, type Pass } from './baton'

const names = new Map([['lead', 'Lead'], ['researcher', 'Researcher'], ['writer', 'News Writer'], ['review', 'Your review']])
const operators = new Set(['review'])
const resolve = agentResolver(names, operators)
const name = (id: string) => names.get(id) ?? id

const T0 = Date.parse('2026-10-15T04:00:00.000Z')
const at = (ms: number) => new Date(T0 + ms).toISOString()

let seq = 0
const message = (extra: Partial<TeamMessage> & Pick<TeamMessage, 'kind'>): TeamMessage => {
  seq += 1
  return {
    id: `m${seq}`, from: null, handedBy: null, to: null, text: 'x', context: null, eventId: `e${seq}`, evidenceId: null,
    seq: extra.seq ?? seq, ts: extra.ts ?? at(seq * 1000), offsetMs: 0, state: 'delivered', error: null, reply: null, carried: false, ...extra,
  }
}
const reply = (from: string, seqAt: number, ts: string) => ({ from, text: 'yes', eventId: `r${seqAt}`, seq: seqAt, ts, offsetMs: 0, source: 'open' as const, sentBackTo: null })

describe('agentResolver', () => {
  it('finds an agent by id, then by name, then by either ignoring case, as the Team Bus does', () => {
    expect(resolve('researcher')).toBe('researcher')
    expect(resolve('News Writer')).toBe('writer')
    expect(resolve('news writer')).toBe('writer')
    expect(resolve(' RESEARCHER ')).toBe('researcher')
  })

  it('finds no review step, nobody unknown, and neither of two agents that share a name', () => {
    expect(resolve('review')).toBeNull()
    expect(resolve('operator')).toBeNull()
    expect(resolve('Editor')).toBeNull()
    expect(resolve(null)).toBeNull()
    const twins = agentResolver(new Map([['a', 'Helper'], ['b', 'Helper']]), new Set())
    expect(twins('Helper')).toBeNull()
    expect(twins('a')).toBe('a')
  })
})

describe('passesOf', () => {
  it('reads asks, their answers, sent tasks, handoffs and handovers, oldest first', () => {
    const passes = passesOf([
      message({ kind: 'handover', to: 'writer', handedBy: { from: ['lead', 'researcher'], via: [] }, seq: 2, ts: at(2000) }),
      message({ kind: 'ask', from: 'writer', to: 'Researcher', state: 'answered', seq: 3, ts: at(3000), reply: reply('researcher', 6, at(6000)) }),
      message({ kind: 'dispatch', from: 'writer', to: 'lead', seq: 7, ts: at(7000) }),
      message({ kind: 'handoff', from: 'lead', to: 'writer', seq: 8, ts: at(8000) }),
    ], resolve)
    expect(passes.map((pass) => [pass.kind, pass.agent, pass.from, pass.seq])).toEqual([
      ['handover', 'writer', 'researcher', 2],
      ['ask', 'researcher', 'writer', 3],
      ['answer', 'writer', 'researcher', 6],
      ['dispatch', 'lead', 'writer', 7],
      ['handoff', 'writer', 'lead', 8],
    ])
  })

  it('leaves out carried talk, refused calls, review steps, you, and talk that is not a pass', () => {
    expect(passesOf([
      message({ kind: 'handover', to: 'writer', carried: true }),
      message({ kind: 'ask', from: 'writer', to: 'researcher', state: 'failed' }),
      message({ kind: 'handover', to: 'review', handedBy: { from: ['writer'], via: [] } }),
      message({ kind: 'question', from: 'writer', to: 'operator', state: 'pending' }),
      message({ kind: 'direction', from: 'operator', to: 'writer' }),
      message({ kind: 'note', from: 'operator', to: 'writer' }),
      message({ kind: 'ask', from: 'writer', to: 'Nobody' }),
    ], resolve)).toEqual([])
  })

  it('keys passes by what the header would show, so equal reports do not redraw it', () => {
    const one = passesOf([message({ kind: 'dispatch', from: 'lead', to: 'writer', seq: 40 })], resolve)
    const again = passesOf([message({ kind: 'dispatch', from: 'lead', to: 'writer', seq: 40 })], resolve)
    expect(passesKey(one)).toBe(passesKey(again))
    expect(passesKey(one)).not.toBe(passesKey([]))
  })
})

const pass = (kind: Pass['kind'], agent: string, from: string | null, ms: number): Pass => ({ kind, agent, from, seq: ms, ts: at(ms) })

describe('batonOf', () => {
  it('names a fresh pass, then settles to the agent working once it is a moment old', () => {
    const passes = [pass('handover', 'writer', 'researcher', 10_000)]
    expect(batonOf({ passes, working: ['writer'], waitingOn: null, now: T0 + 10_500 })).toEqual({ agent: 'writer', kind: 'handover', from: 'researcher' })
    expect(batonOf({ passes, working: ['writer'], waitingOn: null, now: T0 + 10_000 + PASS_BEAT_MS })).toEqual({ agent: 'writer', kind: 'working', from: null })
  })

  it('holds an open ask while its asker works, though the agent answering is not counted as working', () => {
    const passes = [pass('handover', 'writer', 'researcher', 1000), pass('ask', 'researcher', 'writer', 2000)]
    const later = T0 + 120_000
    expect(batonOf({ passes, working: ['writer'], waitingOn: null, now: later })).toEqual({ agent: 'researcher', kind: 'ask', from: 'writer' })
    // The answer goes back: the pass is to the agent that asked.
    const answered = [...passes, pass('answer', 'writer', 'researcher', 130_000)]
    expect(batonOf({ passes: answered, working: ['writer'], waitingOn: null, now: T0 + 130_100 })).toEqual({ agent: 'writer', kind: 'answer', from: 'researcher' })
  })

  it('falls back to whoever is working when the newest pass ended, the one the work reached last first', () => {
    const passes = [pass('handover', 'writer', 'lead', 1000), pass('dispatch', 'researcher', 'writer', 2000)]
    expect(batonOf({ passes, working: ['lead', 'writer'], waitingOn: null, now: T0 + 2500 })).toEqual({ agent: 'writer', kind: 'working', from: null })
    expect(batonOf({ passes: [], working: ['lead'], waitingOn: null, now: T0 })).toEqual({ agent: 'lead', kind: 'working', from: null })
    // An ask whose asker stopped is not open any more.
    expect(batonOf({ passes: [pass('ask', 'researcher', 'writer', 1000)], working: [], waitingOn: null, now: T0 })).toBeNull()
  })

  it('puts an agent waiting on you before anything else', () => {
    const passes = [pass('ask', 'researcher', 'writer', 1000)]
    expect(batonOf({ passes, working: ['writer'], waitingOn: 'lead', now: T0 })).toEqual({ agent: 'lead', kind: 'you', from: null })
  })

  it('knows when a named pass will settle, and that an open ask or the working words will not by themselves', () => {
    const passes = [pass('handoff', 'writer', 'lead', 5000)]
    const fresh = batonOf({ passes, working: ['writer'], waitingOn: null, now: T0 + 5100 })
    expect(batonSettlesAt(fresh, passes)).toBe(T0 + 5000 + PASS_BEAT_MS)
    expect(batonSettlesAt({ agent: 'writer', kind: 'working', from: null }, passes)).toBeNull()
    const asking = [pass('ask', 'researcher', 'writer', 1000)]
    expect(batonSettlesAt(batonOf({ passes: asking, working: ['writer'], waitingOn: null, now: T0 }), asking)).toBeNull()
    expect(batonSettlesAt(null, passes)).toBeNull()
  })
})

describe('batonWords', () => {
  it('says the pass on the pill, from the agent’s side in the list, and whole for a screen reader', () => {
    expect(batonWords({ agent: 'researcher', kind: 'ask', from: 'writer' }, name)).toEqual({ pill: 'Asking Researcher…', row: 'asked by News Writer', sentence: 'News Writer is asking Researcher' })
    expect(batonWords({ agent: 'writer', kind: 'answer', from: 'researcher' }, name).pill).toBe('Back to News Writer…')
    expect(batonWords({ agent: 'lead', kind: 'dispatch', from: 'writer' }, name).row).toBe('on a task from News Writer')
    expect(batonWords({ agent: 'writer', kind: 'handoff', from: 'lead' }, name).sentence).toBe('Lead handed the work to News Writer')
    expect(batonWords({ agent: 'writer', kind: 'handover', from: null }, name)).toEqual({ pill: 'Passing to News Writer…', row: 'picked up the work', sentence: 'The work passed to News Writer' })
    expect(batonWords({ agent: 'lead', kind: 'you', from: null }, name)).toEqual({ pill: 'Lead needs you', row: 'waiting for you', sentence: 'Lead is waiting for you' })
    expect(batonWords({ agent: 'lead', kind: 'working', from: null }, name).pill).toBe('Lead is working…')
  })
})
