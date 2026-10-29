import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PRESENCE_WORDS } from '../rail/presence'
import { markLabel } from '../story/mark'
import { STATE_WORDS, stateAfterName, stateLabel } from './words'

describe('one word per state', () => {
  it('says work that ended on a problem didn’t finish, and keeps stopped for work you stopped', () => {
    expect(STATE_WORDS.failed).toBe('didn’t finish')
    expect(STATE_WORDS.stopped).toBe('stopped')
    expect(stateLabel('failed')).toBe('Didn’t finish')
    expect(stateAfterName('Writer', 'failed')).toBe('Writer didn’t finish')
    expect(stateAfterName('Writer', 'working')).toBe('Writer is working')
  })

  it('is the word the rail, the marks and the team chat use', () => {
    expect(PRESENCE_WORDS.failed).toBe(STATE_WORDS.failed)
    expect(PRESENCE_WORDS.waiting).toBe(STATE_WORDS.waiting)
    expect(markLabel('failed').toLowerCase()).toBe(STATE_WORDS.failed)
  })

  it('lights every figure with the shared state glows', () => {
    const styles = resolve(process.cwd(), 'src/styles')
    const tokens = readFileSync(resolve(styles, 'tokens.css'), 'utf8')
    for (const state of ['ready', 'working', 'waiting', 'failed', 'stopped']) expect(tokens).toContain(`--glow-${state}:`)
    const direct = readdirSync(styles)
      .filter((name) => name.endsWith('.css') && name !== 'tokens.css')
      .flatMap((name) => readFileSync(resolve(styles, name), 'utf8').split('\n').filter((line) => /--glow:\s*var\(--color-(ok|live|accent|alert|halt)\)/.test(line)).map((line) => `${name}: ${line.trim()}`))
    expect(direct).toEqual([])
  })
})
