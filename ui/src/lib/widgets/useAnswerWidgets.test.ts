import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RunEvent } from '../watch/events'
import type { KeptWidget, WidgetSpec } from './types'
import { useAnswerWidgets } from './useAnswerWidgets'

afterEach(() => vi.useRealTimers())

const list: WidgetSpec = { kind: 'checklist', title: 'Before Wednesday', items: [{ text: 'Print 32 copies' }] }
const event = (seq: number, kind: RunEvent['kind'], payload: Record<string, unknown>): RunEvent => ({ id: `e${seq}`, sessionId: 'run', agentId: 'writer', seq, ts: '2026-11-05T10:00:00Z', kind, payload })
const events = [
  event(1, 'tool_call', { callId: 'a', name: 'show_widget', rawInput: list }),
  event(2, 'tool_update', { callId: 'a', status: 'completed', rawOutput: { place: '{{widget 1}}' } }),
]
type Props = { answer: string; finished: boolean; kept: KeptWidget[] | null }

describe('useAnswerWidgets', () => {
  it('places widgets as the answer is written, holds them when it is done, then shows the kept ones', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook((props: Props) => useAnswerWidgets({ ...props, events, responder: 'writer' }), {
      initialProps: { answer: 'Do these first:\n\n{{widget 1}}\n\nThen', finished: false, kept: null } as Props,
    })
    expect(result.current).toEqual({ words: 'Do these first:\n\nThen', widgets: [{ n: 1, line: 2, spec: list }], live: true })

    // Done, with the words kept and the chat not yet bringing the widget: it stays where it was.
    rerender({ answer: 'Do these first:\n\nThen', finished: true, kept: [] })
    expect(result.current.widgets).toEqual([{ n: 1, line: 2, spec: list }])
    expect(result.current.live).toBe(true)
    act(() => { vi.advanceTimersByTime(3900) })
    expect(result.current.widgets).toHaveLength(1)

    const kept: KeptWidget[] = [{ n: 1, line: 2, spec: list, state: { checked: [true] } }]
    rerender({ answer: 'Do these first:\n\nThen', finished: true, kept })
    expect(result.current).toEqual({ words: 'Do these first:\n\nThen', widgets: kept, live: false })
  })

  it('stops holding them when none are kept', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook((props: Props) => useAnswerWidgets({ ...props, events, responder: 'writer' }), {
      initialProps: { answer: 'Look:\n{{widget 1}}', finished: false, kept: null } as Props,
    })
    rerender({ answer: 'Look:', finished: true, kept: [] })
    expect(result.current.widgets).toHaveLength(1)
    act(() => { vi.advanceTimersByTime(4000) })
    expect(result.current).toEqual({ words: 'Look:', widgets: [], live: false })
  })

  it('shows none for work that didn’t succeed', () => {
    const { result, rerender } = renderHook((props: Props) => useAnswerWidgets({ ...props, events, responder: 'writer' }), {
      initialProps: { answer: 'Look:\n{{widget 1}}', finished: false, kept: null } as Props,
    })
    rerender({ answer: 'Look:', finished: true, kept: null })
    expect(result.current).toEqual({ words: 'Look:', widgets: [], live: false })
  })
})
