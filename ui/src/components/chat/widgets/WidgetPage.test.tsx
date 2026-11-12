import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { KeptWidget, WidgetState } from '../../../lib/widgets/types'
import { AnswerWidgets } from './AnswerWidgets'
import { DRAFT_EVENT, START_MS } from './WidgetPage'

afterEach(cleanup)

const pendulum: KeptWidget = {
  n: 1,
  spec: {
    kind: 'page',
    title: 'How the length sets a pendulum\'s swing',
    why: 'Two pendulums that swing at the length you set.',
    inputs: [{ id: 'length', label: 'Length', start: 1, min: 0.2, max: 3, unit: 'm' }],
    results: [{ id: 'earth', label: 'One swing on Earth', formula: '2 * pi * sqrt(length / 9.81)', unit: 's', decimals: 1 }],
    presets: [{ label: 'A playground swing', values: { length: 2.5 } }],
    html: '<span data-result="earth"></span><input type="number" data-input="length">',
    script: 'lw.frame((t) => {})',
  },
}

function shown(kept: KeptWidget = pendulum, live = false) {
  const onChange = vi.fn(async (n: number, state: WidgetState) => ({ ...kept, n, state, changedAt: '2026-11-12T10:00:00Z' }))
  render(<AnswerWidgets widgets={[kept]} onChange={onChange} live={live} by="Coby" />)
  const frame = screen.getByTitle(kept.spec.title) as HTMLIFrameElement
  const boot = new DOMParser().parseFromString(frame.getAttribute('srcdoc') ?? '', 'text/html').getElementById('lw-boot')
  const token = (JSON.parse(boot?.textContent ?? '{}') as { token: string }).token
  const posted = vi.spyOn(frame.contentWindow as Window, 'postMessage')
  const fromFrame = (data: Record<string, unknown>, source: MessageEventSource | null = frame.contentWindow) => act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { lw: token, ...data }, source }))
  })
  const sentValues = () => posted.mock.calls.map(([message]) => message as { t: string; values?: { inputs: Record<string, unknown>; written: Record<string, string> } }).filter((message) => message.t === 'values' || message.t === 'init')
  return { frame, token, onChange, posted, fromFrame, sentValues }
}

describe('a page in an answer', () => {
  it('runs in a frame that may only run scripts, under who drew it', () => {
    const { frame } = shown()
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.getAttribute('srcdoc')).toContain("connect-src 'none'")
    expect(screen.getByText('Drawn by Coby')).toBeTruthy()
  })

  it('hears only its own frame, with its own token', () => {
    const { frame, token, fromFrame } = shown()
    fromFrame({ t: 'height', px: 300 }, window)
    expect(frame.style.height).toBe('120px')
    act(() => window.dispatchEvent(new MessageEvent('message', { data: { lw: 'not-' + token, t: 'height', px: 300 }, source: frame.contentWindow })))
    expect(frame.style.height).toBe('120px')
    fromFrame({ t: 'height', px: 300 })
    expect(frame.style.height).toBe('300px')
    fromFrame({ t: 'height', px: 5000 })
    expect(frame.style.height).toBe('640px')
  })

  it('sends the page LoomWatch\'s figures when it is ready, and again when an input changes', async () => {
    const { fromFrame, sentValues } = shown()
    fromFrame({ t: 'ready' })
    await waitFor(() => expect(sentValues().find((message) => message.t === 'init')?.values?.written.earth).toBe('2.0 s'))
    fromFrame({ t: 'set', id: 'length', value: 2.5, keep: false, gesture: false })
    expect(sentValues().at(-1)?.values?.written.earth).toBe('3.2 s')
  })

  it('keeps what the person set only when they set it, and refuses what the page didn\'t declare', () => {
    const { fromFrame, onChange, sentValues } = shown()
    fromFrame({ t: 'ready' })
    fromFrame({ t: 'set', id: 'mass', value: 2, keep: true, gesture: true })
    fromFrame({ t: 'set', id: 'length', value: 9, keep: true, gesture: true })
    fromFrame({ t: 'set', id: 'length', value: '2', keep: true, gesture: true })
    expect(onChange).not.toHaveBeenCalled()
    expect(sentValues().at(-1)?.values?.inputs.length).toBe(1)
    fromFrame({ t: 'set', id: 'length', value: 2, keep: true, gesture: false })
    expect(onChange).not.toHaveBeenCalled()
    fromFrame({ t: 'set', id: 'length', value: 2.5, keep: true, gesture: true })
    expect(onChange).toHaveBeenCalledWith(1, { values: { length: 2.5 } })
  })

  it('keeps nothing while the answer is still written', () => {
    const { fromFrame, onChange } = shown(pendulum, true)
    fromFrame({ t: 'set', id: 'length', value: 2.5, keep: true, gesture: true })
    fromFrame({ t: 'preset', at: 0, gesture: true })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('sets a preset\'s inputs when the person taps it', () => {
    const { fromFrame, onChange } = shown()
    fromFrame({ t: 'preset', at: 0, gesture: true })
    expect(onChange).toHaveBeenCalledWith(1, { values: { length: 2.5 } })
    fromFrame({ t: 'preset', at: 7, gesture: true })
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('puts a page\'s words in the message box through the chat, and sends nothing itself', () => {
    const { fromFrame } = shown()
    const heard = vi.fn()
    document.addEventListener(DRAFT_EVENT, heard)
    fromFrame({ t: 'draft', text: 'Why doesn\'t a heavier weight swing faster?' })
    fromFrame({ t: 'draft', text: '   ' })
    document.removeEventListener(DRAFT_EVENT, heard)
    expect(heard).toHaveBeenCalledTimes(1)
    expect((heard.mock.calls[0][0] as CustomEvent<{ text: string; by: string }>).detail).toEqual({ text: 'Why doesn\'t a heavier weight swing faster?', by: 'Coby' })
  })

  it('says it didn\'t work when its frame never starts', () => {
    vi.useFakeTimers()
    try {
      const { fromFrame, onChange } = shown()
      act(() => { vi.advanceTimersByTime(START_MS - 100) })
      expect(screen.queryByText(/This drawing didn’t work/u)).toBeNull()
      act(() => { vi.advanceTimersByTime(200) })
      expect(screen.getByText(/This drawing didn’t work/u)).toBeTruthy()
      expect(onChange).toHaveBeenCalledWith(1, { broke: 'it never started' })
      fromFrame({ t: 'ready' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits no longer once its frame has started', () => {
    vi.useFakeTimers()
    try {
      const { fromFrame } = shown()
      fromFrame({ t: 'ready' })
      act(() => { vi.advanceTimersByTime(START_MS * 2) })
      expect(screen.queryByText(/This drawing didn’t work/u)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives the page the chat\'s own fonts, written in as data, in the chat\'s colour scheme', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([119, 79, 70, 50]))))
    try {
      const { frame, fromFrame, posted } = shown()
      expect(frame.getAttribute('srcdoc')).toMatch(/<meta name="color-scheme" content="(light|dark)">/u)
      fromFrame({ t: 'ready' })
      await waitFor(() => expect(posted.mock.calls.some(([message]) => (message as { t: string }).t === 'init')).toBe(true))
      const init = posted.mock.calls.map(([message]) => message as { t: string; look: { css: string } }).find((message) => message.t === 'init')
      expect(init?.look.css).toContain("@font-face{font-family:'Fraunces'")
      expect(init?.look.css).toContain('src:url(data:font/woff2;base64,d09GMg==)')
      expect(init?.look.css).not.toMatch(/url\((?!data:)/u)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('names no one when it doesn\'t know who drew it', () => {
    const onChange = vi.fn(async () => pendulum)
    render(<AnswerWidgets widgets={[pendulum]} onChange={onChange} />)
    expect(screen.queryByText(/Drawn by/u)).toBeNull()
  })

  it('shows Pause while it moves, and says so in its place when it breaks', () => {
    const { fromFrame, onChange } = shown()
    fromFrame({ t: 'moving', on: true })
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy()
    fromFrame({ t: 'broke', why: 'ReferenceError: ctx is not defined (line 3)' })
    expect(screen.getByText('This drawing didn’t work. The words still answer it; reply if you want Coby to try again.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull()
    expect(onChange).toHaveBeenCalledWith(1, { broke: 'ReferenceError: ctx is not defined (line 3)' })
  })
})
