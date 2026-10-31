import { describe, expect, it } from 'vitest'

import type { RunRecord } from '../runs/client'
import { chatPreview, listTime } from './preview'

const run = (overrides: Partial<RunRecord>): RunRecord => ({
  runId: 'r', sessionId: 'r', teamPath: 'news.yaml', prompt: 'today’s digest', status: 'succeeded', mode: 'pipeline', entrypoint: 'a',
  responder: 'b', agentIds: ['a', 'b'], createdAt: '2026-10-06T02:00:00.000Z', startedAt: '2026-10-06T02:00:00.000Z',
  finishedAt: '2026-10-06T02:04:00.000Z', error: null, exitCode: 0, eventCount: 1, reply: '## Digest\nChips lead.', ...overrides,
})

/** A preview's line as it reads: the app's words, then the request's or answer's. */
const said = (preview: ReturnType<typeof chatPreview>) => (preview ? preview.lead + preview.words : null)

describe('chatPreview', () => {
  it('keeps the words whole, Markdown and all, for the card’s line to cut', () => {
    const long = `Add up the **Q4** sales by region from \`sales.csv\` and ${'say why each one moved '.repeat(6)}`
    expect(chatPreview([run({ status: 'running', finishedAt: null, reply: null, prompt: long })], 'news.yaml')).toMatchObject({ lead: 'Working on: ', words: long.trim() })
  })

  it('says the newest thing in the chat in one line', () => {
    expect(chatPreview([run({})], 'news.yaml')).toEqual({ at: '2026-10-06T02:04:00.000Z', lead: '', words: 'Digest', live: false })
    expect(said(chatPreview([run({ status: 'running', finishedAt: null, reply: null })], 'news.yaml'))).toBe('Working on: today’s digest')
    expect(said(chatPreview([run({ status: 'running', finishedAt: null, waitingOn: { node: 'x', name: 'x', kind: 'question', since: '', question: '', park: 'none', parkNote: '', sendBackAvailable: false } })], 'news.yaml'))).toBe('Waiting for you')
    expect(said(chatPreview([run({ status: 'failed', reply: null })], 'news.yaml'))).toBe('Stopped: today’s digest')
    expect(said(chatPreview([run({ status: 'failed', reply: null, nextTryAt: '2026-10-06T02:05:00.000Z' })], 'news.yaml'))).toBe('Trying again soon: today’s digest')
    expect(chatPreview([run({})], 'other.yaml')).toBeNull()
  })

  it('picks the newest piece, by when it last changed', () => {
    const older = run({ runId: 'old', reply: 'Old answer', finishedAt: '2026-10-05T02:00:00.000Z' })
    const newer = run({ runId: 'new', reply: 'New answer' })
    expect(said(chatPreview([newer, older], 'news.yaml'))).toBe('New answer')
  })
})

describe('listTime', () => {
  const now = Date.parse('2026-10-06T12:00:00')
  it('reads like a chat list: a time today, then Yesterday, a weekday, a date', () => {
    expect(listTime('2026-10-06T09:40:00', now)).toMatch(/09:40|9:40/)
    expect(listTime('2026-10-05T09:40:00', now)).toBe('Yesterday')
    expect(listTime('2026-09-01T09:40:00', now)).toMatch(/1/)
  })
})
