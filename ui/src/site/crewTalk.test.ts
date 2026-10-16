import { describe, expect, it } from 'vitest'

import { glowAt, loopLength, PASS, readTime, REST, talkAt, THINK, WAIT, WAITING_WORDS, type TalkLine } from './crewTalk'

const SCRIPT: TalkLine[] = [
  { by: 5, says: 'Scout, find the sources?', to: 0 },
  { by: 0, says: 'Five found. Writer, over to you.', to: 1 },
  { by: 1, says: 'One claim has no source.', to: 'you' },
]

describe('readTime', () => {
  it('gives a few words enough time, and many words no more than three seconds', () => {
    expect(readTime('Hi')).toBe(1.8)
    expect(readTime('One claim has no source.')).toBeCloseTo(2.7)
    expect(readTime('a b c d e f g h i j k l')).toBe(3)
  })
})

describe('talkAt', () => {
  const first = THINK + readTime(SCRIPT[0].says)

  it('says nothing before it starts, or with no script', () => {
    expect(talkAt(SCRIPT, -1, 2)).toEqual({ speaker: null, to: null, bubble: null, pass: null, waiting: false, done: false })
    expect(talkAt([], 3, 2).bubble).toBeNull()
  })

  it('thinks first, then says its line', () => {
    expect(talkAt(SCRIPT, 0.1, 1)).toMatchObject({ speaker: 5, bubble: { by: 5, says: null, waiting: false }, pass: null })
    expect(talkAt(SCRIPT, THINK + 0.1, 1)).toMatchObject({ speaker: 5, to: 0, bubble: { by: 5, says: 'Scout, find the sources?' }, pass: null })
  })

  it('passes the work along to the next, keeping its words up', () => {
    const state = talkAt(SCRIPT, first + PASS / 2, 1)
    expect(state.pass).toMatchObject({ from: 5, to: 0 })
    expect(state.pass?.at).toBeCloseTo(0.5)
    expect(state.bubble?.says).toBe('Scout, find the sources?')
  })

  it('then the next one thinks', () => {
    expect(talkAt(SCRIPT, first + PASS + 0.1, 1)).toMatchObject({ speaker: 0, bubble: { by: 0, says: null }, pass: null })
  })

  it('hands the last of it to you, and everyone waits', () => {
    const asked = loopLength(SCRIPT) - REST - WAIT
    const state = talkAt(SCRIPT, asked + 0.1, 1)
    expect(state).toMatchObject({ speaker: null, to: 'you', waiting: true, bubble: { by: 1, says: WAITING_WORDS, waiting: true }, pass: null })
  })

  it('rests between loops, starts again, and is done after the last one asks you', () => {
    const loop = loopLength(SCRIPT)
    expect(talkAt(SCRIPT, loop - 1, 2)).toMatchObject({ bubble: null, done: false })
    expect(talkAt(SCRIPT, loop + 0.1, 2)).toMatchObject({ speaker: 5, done: false })
    expect(talkAt(SCRIPT, 2 * loop - REST - 0.1, 2).waiting).toBe(true)
    expect(talkAt(SCRIPT, 2 * loop - REST, 2)).toMatchObject({ bubble: null, done: true })
    expect(talkAt(SCRIPT, 5 * loop, 2).done).toBe(true)
  })
})

describe('glowAt', () => {
  const first = THINK + readTime(SCRIPT[0].says)

  it('has everyone ready before it starts, with no conversation, and once it is done', () => {
    expect(glowAt(talkAt(SCRIPT, -1, 1), 6)).toEqual(Array(6).fill('ready'))
    expect(glowAt(null, 3)).toEqual(['ready', 'ready', 'ready'])
    expect(glowAt(talkAt(SCRIPT, 5 * loopLength(SCRIPT), 1), 6)).toEqual(Array(6).fill('ready'))
  })

  it('has the one thinking, talking or sending the work on working, and only it', () => {
    expect(glowAt(talkAt(SCRIPT, 0.1, 1), 6)).toEqual(['ready', 'ready', 'ready', 'ready', 'ready', 'working'])
    expect(glowAt(talkAt(SCRIPT, THINK + 0.1, 1), 6)[5]).toBe('working')
    expect(glowAt(talkAt(SCRIPT, first + PASS / 2, 1), 6)).toEqual(['ready', 'ready', 'ready', 'ready', 'ready', 'working'])
    expect(glowAt(talkAt(SCRIPT, first + PASS + 0.1, 1), 6)).toEqual(['working', 'ready', 'ready', 'ready', 'ready', 'ready'])
  })

  it('has the one that hands you the work waiting, and the rest ready', () => {
    const asked = loopLength(SCRIPT) - REST - WAIT
    expect(glowAt(talkAt(SCRIPT, asked + 0.1, 1), 6)).toEqual(['ready', 'waiting', 'ready', 'ready', 'ready', 'ready'])
  })
})
