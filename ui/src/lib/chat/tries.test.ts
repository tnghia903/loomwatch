import { describe, expect, it } from 'vitest'

import { clockTime } from './format'
import { earlierTries, triedAgain, triesLine, tryingAgain } from './tries'
import type { RunRecord } from '../runs/client'

type Try = Pick<RunRecord, 'runId' | 'trigger' | 'retryOfRunId' | 'createdAt' | 'error' | 'nextTryAt'>

const unreachable = 'pipeline node brief-writer failed: LoomWatch couldn\'t reach ChatGPT: couldn\'t renew the sign-in with ChatGPT'

/** The morning the network was slow to come back: two tries that couldn't reach ChatGPT, then one that ran. */
const first: Try = { runId: 'a', trigger: 'schedule', retryOfRunId: null, createdAt: '2026-10-22T00:03:20Z', error: unreachable }
const second: Try = { runId: 'b', trigger: 'schedule', retryOfRunId: 'a', createdAt: '2026-10-22T00:04:30Z', error: unreachable }
const third: Try = { runId: 'c', trigger: 'schedule', retryOfRunId: 'b', createdAt: '2026-10-22T00:09:30Z', error: null }
const all = new Map([first, second, third].map((run) => [run.runId, run]))

describe('a routine’s tries', () => {
  it('folds every try the schedule made again into the one after it', () => {
    expect([...triedAgain(all.values())].sort()).toEqual(['a', 'b'])
    expect(earlierTries(third, all)).toEqual([first, second])
    expect(earlierTries(second, all)).toEqual([first])
    expect(earlierTries(first, all)).toEqual([])
  })

  it('leaves your own Try again apart: it is yours, not the schedule’s', () => {
    const yours: Try = { ...third, runId: 'd', trigger: 'manual', retryOfRunId: 'c' }
    const runs = new Map([...all, ['d', yours]])
    expect(triedAgain(runs.values()).has('c')).toBe(false)
    expect(earlierTries(yours, runs)).toEqual([])
  })

  it('stops at a try the chat does not have, and never loops', () => {
    expect(earlierTries(third, new Map([['b', second]]))).toEqual([second])
    const loop: Try = { ...first, retryOfRunId: 'b' }
    expect(earlierTries(third, new Map([['a', loop], ['b', second]]))).toEqual([loop, second])
  })

  it('says when it tries again, and what it couldn’t reach when', () => {
    const waiting = { ...second, nextTryAt: '2026-10-22T00:09:30Z' }
    expect(triesLine(waiting, [first])).toBe(`Trying again at ${clockTime('2026-10-22T00:09:30Z')} · couldn’t reach ChatGPT at ${clockTime(first.createdAt)} and ${clockTime(second.createdAt)}`)
    expect(triesLine({ ...first, nextTryAt: '2026-10-22T00:04:20Z' }, [])).toBe(`Trying again at ${clockTime('2026-10-22T00:04:20Z')} · couldn’t reach ChatGPT at ${clockTime(first.createdAt)}`)
  })

  it('says that it tried again, once the try is under way or done: the request above says when', () => {
    expect(triesLine(third, [first, second])).toBe(`Tried again · couldn’t reach ChatGPT at ${clockTime(first.createdAt)} and ${clockTime(second.createdAt)}`)
  })

  it('counts the tries from three on, rather than list every time', () => {
    const fourth: Try = { ...third, runId: 'd', retryOfRunId: 'c', createdAt: '2026-10-22T00:19:30Z' }
    expect(triesLine(fourth, [first, second, { ...third, error: unreachable }])).toBe(`Tried again · couldn’t reach ChatGPT 3 times since ${clockTime(first.createdAt)}`)
    expect(triesLine({ ...third, error: unreachable, nextTryAt: '2026-10-22T00:19:30Z' }, [first, second])).toBe(`Trying again at ${clockTime('2026-10-22T00:19:30Z')} · couldn’t reach ChatGPT 3 times since ${clockTime(first.createdAt)}`)
  })

  it('knows a run the schedule waits to try again from one that stopped', () => {
    expect(tryingAgain({ status: 'failed', nextTryAt: '2026-10-22T00:04:20Z' })).toBe(true)
    expect(tryingAgain({ status: 'failed', nextTryAt: null })).toBe(false)
    expect(tryingAgain({ status: 'failed' })).toBe(false)
  })

  it('says nothing for a run with no tries before it and none to come', () => {
    expect(triesLine(first, [])).toBeNull()
    expect(triesLine({ ...first, nextTryAt: null }, [])).toBeNull()
  })

  it('falls back to "the AI" when the words name no source', () => {
    const quiet = { ...first, error: 'something else' }
    expect(triesLine({ ...third }, [quiet])).toBe(`Tried again · couldn’t reach the AI at ${clockTime(first.createdAt)}`)
  })
})
