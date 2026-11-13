import { describe, expect, it } from 'vitest'

import type { CheckExchange, TeamMessage } from './messages'
import { inTalks, TALK_MS, talksAt } from './talk'

/** The spotlight's talks (owner, 2026-11-13): who is talking to whom at a moment of the run. */
const T0 = Date.parse('2026-11-13T09:00:00Z')
const at = (seconds: number) => T0 + seconds * 1000
const iso = (seconds: number) => new Date(at(seconds)).toISOString()
const order = [
  { id: 'researcher', name: 'Researcher', operator: false },
  { id: 'analyst', name: 'Price analyst', operator: false },
  { id: 'writer', name: 'Writer', operator: false },
  { id: 'checker', name: 'Checker', operator: false },
]
let next = 0
const message = (fields: Partial<TeamMessage> & Pick<TeamMessage, 'kind'>, seconds: number): TeamMessage => ({
  id: `m${next++}`, from: null, handedBy: null, to: null, text: 'words', context: null, eventId: 'e', evidenceId: null, seq: 0,
  ts: iso(seconds), offsetMs: seconds * 1000, state: 'delivered', error: null, reply: null, carried: false, ...fields,
}) as TeamMessage
const reply = (from: string, seconds: number, fields: Partial<NonNullable<TeamMessage['reply']>> = {}) => ({ from, text: 'reply', eventId: 'r', seq: 1, ts: iso(seconds), offsetMs: seconds * 1000, sentBackTo: null, ...fields }) as NonNullable<TeamMessage['reply']>
const handover = (from: string, to: string, seconds: number) => message({ kind: 'handover', to, handedBy: { from: [from], via: [] } as unknown as TeamMessage['handedBy'] }, seconds)
const said = (talks: ReturnType<typeof talksAt>) => talks.map((talk) => `${talk.from.join('+')} ${talk.verb} ${talk.to.join('+')}${talk.tail}${talk.word ? ` (${talk.word})` : ''}`)

describe('who is talking to whom', () => {
  it('lights a handover as it passes, and lets it go after a while', () => {
    const messages = [handover('researcher', 'analyst', 10)]
    // In the timeline's words for the same moment; the card adds no word the verb already says.
    expect(said(talksAt(messages, order, at(11)))).toEqual(['researcher hands the work to analyst'])
    expect(talksAt(messages, order, at(10) + TALK_MS + 1)).toEqual([])
    // Not said yet at that moment of a replay.
    expect(talksAt(messages, order, at(9))).toEqual([])
  })

  it('keeps a question lit until it is answered, then lights the answer going back', () => {
    const asked = message({ kind: 'ask', from: 'checker', to: 'researcher', state: 'pending' }, 10)
    // Long after it was asked, the asker is still waiting on the other: still lit.
    expect(said(talksAt([asked], order, at(60)))).toEqual(['checker asks researcher'])
    const answered = { ...asked, state: 'answered' as const, reply: reply('researcher', 70) }
    // Before the answer came, the question; once it has, the answer, the other way.
    expect(said(talksAt([answered], order, at(65)))).toEqual(['checker asks researcher'])
    expect(said(talksAt([answered], order, at(71)))).toEqual(['researcher answers checker'])
    expect(talksAt([answered], order, at(70) + TALK_MS + 1)).toEqual([])
  })

  it('reads one agent handing over to two at once as one talk', () => {
    const talks = talksAt([handover('researcher', 'analyst', 10), handover('researcher', 'writer', 10.5)], order, at(11))
    expect(said(talks)).toEqual(['researcher hands the work to analyst+writer'])
    expect([...inTalks(talks)].sort()).toEqual(['analyst', 'researcher', 'writer'])
    // Apart in time, they are two talks.
    expect(talksAt([handover('researcher', 'analyst', 10), handover('researcher', 'writer', 14)], order, at(15))).toHaveLength(2)
  })

  it('says a send-back as one, in its gold, and the revised work coming back', () => {
    const check: CheckExchange = { round: 1, items: [{ item: 'Battery hours', verdict: 'not_met', evidence: '' }] as CheckExchange['items'], readable: true, sentBack: true, problems: 'No battery hours.' }
    const back = message({ kind: 'check', from: 'checker', to: 'writer', check, state: 'pending' }, 10)
    const [talk] = talksAt([back], order, at(11))
    expect(said([talk])).toEqual(['checker sends the work back to writer'])
    expect(talk.tone).toBe('back')
    const revised = { ...back, state: 'answered' as const, reply: reply('writer', 20) }
    expect(said(talksAt([revised], order, at(21)))).toEqual(['writer sends the revised work to checker'])
    // A check that found everything met is said once, and nothing comes back.
    const met = message({ kind: 'check', from: 'checker', to: 'writer', check: { ...check, sentBack: false, items: [{ item: 'Battery hours', verdict: 'met', evidence: 'yes' }] as CheckExchange['items'] } }, 30)
    const [passed] = talksAt([met], order, at(31))
    expect(said([passed])).toEqual(['checker checks writer’s work (all met)'])
    expect(passed.tone).toBe('ok')
  })

  // Work handed out comes back as done, or with a word for what went wrong, in that word's tone.
  it('says how a task came back, and only that word', () => {
    const task = (fields: Partial<NonNullable<TeamMessage['reply']>>) => message({ kind: 'dispatch', from: 'researcher', to: 'analyst', state: 'answered', reply: reply('analyst', 20, fields) }, 10)
    const back = (fields: Partial<NonNullable<TeamMessage['reply']>>) => talksAt([task(fields)], order, at(21))[0]
    expect(said([back({})])).toEqual(['analyst reports back to researcher (done)'])
    expect(back({ failed: true })).toMatchObject({ word: 'couldn’t finish', tone: 'failed' })
    expect(back({ stopped: true })).toMatchObject({ word: 'stopped', tone: 'halt' })
    expect(said(talksAt([message({ kind: 'dispatch', from: 'researcher', to: 'analyst', state: 'pending' }, 10)], order, at(11)))).toEqual(['researcher gives a task to analyst'])
  })

  it('agrees the verb with who speaks: several, or you', () => {
    const team = [...order, { id: 'review', name: 'You', operator: true }]
    const both = message({ kind: 'handover', to: 'checker', handedBy: { from: ['analyst', 'writer'], via: [] } as unknown as TeamMessage['handedBy'] }, 10)
    expect(said(talksAt([both], team, at(11)))).toEqual(['analyst+writer hand the work to checker'])
    expect(said(talksAt([handover('review', 'writer', 10)], team, at(11)))).toEqual(['review hand the work to writer'])
  })

  it('lights only talk between the team’s stages', () => {
    const messages = [
      // A question for you is answered in the chat, not on the floor.
      message({ kind: 'question', from: 'writer', to: 'operator', state: 'pending' }, 10),
      // One of your other agents brought in for the run has no stage to light.
      message({ kind: 'ask', from: 'writer', to: 'mine+maya', state: 'pending' }, 10),
      // A message the Team Bus refused never reached anyone.
      message({ kind: 'dispatch', from: 'writer', to: 'checker', state: 'failed' }, 10),
    ]
    expect(talksAt(messages, order, at(11))).toEqual([])
    // Nor does the answer that agent sends back: it has no stage to speak from.
    const asked = message({ kind: 'ask', from: 'writer', to: 'mine+maya', state: 'answered', reply: reply('mine+maya', 20) }, 10)
    expect(talksAt([asked], order, at(21))).toEqual([])
  })

  it('names who handed a stage its work from the record, as the chat does', () => {
    const [talk] = talksAt([handover('analyst', 'writer', 10)], order, at(11))
    expect(talk.from).toEqual(['analyst'])
    // Older runs that didn't record it are read from the order of the stages.
    const older = message({ kind: 'handover', to: 'writer' }, 10)
    expect(talksAt([older], order, at(11))[0].from).toEqual(['analyst'])
  })
})
