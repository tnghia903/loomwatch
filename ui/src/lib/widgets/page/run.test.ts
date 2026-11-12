import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { cleanMarkup, drawInto } from './clean'
import { pageRenderer } from './run'

/**
 * The renderer as a page's frame runs it, here in jsdom with no worker: what it draws and binds,
 * and what it asks the chat. In the frame `window.parent` is the chat; here it is this window,
 * whose `postMessage` is caught.
 */

const TOKEN = 'tok'
let sent: Record<string, unknown>[] = []

function start(html: string) {
  // Written as the frame's document writes it (`./document.ts`): no `<` that could end its element.
  const boot = JSON.stringify({ token: TOKEN, html, script: '', worker: '' }).replace(/</gu, '\\u003c')
  document.body.innerHTML = `<div id="lw-root"></div><style id="lw-look"></style><script type="application/json" id="lw-boot">${boot}</script>`
  pageRenderer(cleanMarkup, drawInto)
}

function fromChat(data: Record<string, unknown>, source: MessageEventSource | null = window) {
  window.dispatchEvent(new MessageEvent('message', { data: { lw: TOKEN, ...data }, source }))
}

const values = (over: Record<string, unknown> = {}) => ({
  inputs: { length: 1, moon: false },
  results: { earth: 2.006, long: 0 },
  written: { earth: '2.0 s', long: '0' },
  presets: [{ label: 'A clock, 1 m', on: true }, { label: 'A playground swing, 2.5 m', on: false }],
  declared: [{ id: 'length', label: 'Length', min: 0.2, max: 3, step: 0.1, switch: false }, { id: 'moon', label: 'On the Moon', switch: true }],
  ...over,
})

beforeEach(() => {
  sent = []
  vi.spyOn(window, 'postMessage').mockImplementation((message: unknown) => { sent.push(message as Record<string, unknown>) })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('a page\'s renderer', () => {
  it('says it is ready, then draws the agent\'s markup cleaned and bound to LoomWatch\'s values', () => {
    start('<span data-result="earth"></span><input type="number" data-input="length"><p data-show="long">Long</p><script>bad()</script><a href="https://example.com">a link</a>')
    expect(sent[0]).toEqual({ t: 'ready', lw: TOKEN })
    fromChat({ t: 'init', look: { css: ':root{--ink:#111}', theme: 'dark' }, values: values() })
    const root = document.getElementById('lw-root') as HTMLElement
    expect(root.querySelector('[data-result="earth"]')?.textContent).toBe('2.0 s')
    const field = root.querySelector('input') as HTMLInputElement
    expect(field.value).toBe('1')
    expect(field.getAttribute('min')).toBe('0.2')
    expect(field.getAttribute('aria-label')).toBe('Length')
    expect((root.querySelector('[data-show]') as HTMLElement).hidden).toBe(true)
    expect(root.querySelector('script, a')).toBeNull()
    expect(root.textContent).toContain('a link')
    expect(document.getElementById('lw-look')?.textContent).toBe(':root{--ink:#111}')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('marks the preset set now with a check as well as its state, never by colour alone', () => {
    start('<div data-presets></div>')
    fromChat({ t: 'init', look: { css: '', theme: 'light' }, values: values() })
    const [on, off] = Array.from(document.querySelectorAll('[data-lw-preset]'))
    expect(on.getAttribute('aria-pressed')).toBe('true')
    expect(on.querySelector('svg')).not.toBeNull()
    expect(on.textContent).toBe('A clock, 1 m')
    expect(off.getAttribute('aria-pressed')).toBe('false')
    expect(off.querySelector('svg')).toBeNull()
  })

  it('asks to keep what is set only after a tap or a key', () => {
    start('<input type="number" data-input="length">')
    fromChat({ t: 'init', look: { css: '', theme: 'light' }, values: values() })
    const field = document.querySelector('input') as HTMLInputElement
    field.value = '2'
    field.dispatchEvent(new Event('change', { bubbles: true }))
    expect(sent.at(-1)).toMatchObject({ t: 'set', id: 'length', value: 2, keep: true, gesture: false })
    document.dispatchEvent(new Event('keydown'))
    field.value = '2.5'
    field.dispatchEvent(new Event('change', { bubbles: true }))
    expect(sent.at(-1)).toMatchObject({ t: 'set', id: 'length', value: 2.5, keep: true, gesture: true })
  })

  it('hears only the chat it is in, with its token', () => {
    start('<span data-result="earth"></span>')
    fromChat({ t: 'init', look: { css: '', theme: 'light' }, values: values() }, null)
    window.dispatchEvent(new MessageEvent('message', { data: { lw: 'other', t: 'init', look: { css: '' }, values: values() }, source: window }))
    expect(document.querySelector('[data-result]')).toBeNull()
  })
})
