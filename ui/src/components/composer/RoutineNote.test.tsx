import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ScheduleEntry } from '../../lib/runs/client'
import { RoutineNote } from './RoutineNote'

afterEach(cleanup)

const routine: ScheduleEntry = {
  teamPath: 'daily-news.yaml', teamName: 'Daily news', cron: '0 8 * * *', timezone: 'Asia/Singapore', describe: 'daily at 08:00 Asia/Singapore',
  prompt: 'Prepare the {{weekday}} {{date}} edition.', enabled: true, nextAt: new Date(Date.now() + 5 * 3_600_000).toISOString(),
  lastRunId: 'r1', lastStatus: 'succeeded', lastFiredAt: '2026-09-11T00:00:00Z',
  lastDelivery: { target: 'notion', status: 'published', url: null, pageId: null, message: 'Published.', deliveredAt: '2026-09-11T00:03:00Z' },
  deliver: { notion: { title: 'News — {{date}}' } }, problem: null,
}

describe('RoutineNote', () => {
  it('states when the routine runs and where it delivers, and runs it on demand', () => {
    const runNow = vi.fn()
    render(<RoutineNote schedule={routine} onRunNow={runNow} busy={false} />)
    expect(screen.getByText('Routine: daily at 08:00 Asia/Singapore · next in 5h · delivers to Notion')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }))
    expect(runNow).toHaveBeenCalledOnce()
  })

  it('keeps the prompt and the last outcome one hover away', () => {
    render(<RoutineNote schedule={routine} onRunNow={vi.fn()} busy={false} />)
    const summary = screen.getByText(/^Routine:/)
    expect(summary.title).toContain('Each run asks: Prepare the {{weekday}} {{date}} edition.')
    expect(summary.title).toContain('(succeeded)')
  })

  it('says a paused routine is paused and still lets it run once', () => {
    render(<RoutineNote schedule={{ ...routine, enabled: false, nextAt: null, deliver: null }} onRunNow={vi.fn()} busy={false} />)
    expect(screen.getByText('Routine: paused')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run now' })).toBeEnabled()
  })

  it('surfaces a scheduler problem verbatim, ahead of a failed delivery', () => {
    render(<RoutineNote schedule={{
      ...routine, nextAt: null, problem: 'previous scheduled run r1 is still running',
      lastDelivery: { ...routine.lastDelivery!, status: 'failed', message: 'Notion is not connected.' },
    }} onRunNow={vi.fn()} busy={false} />)
    expect(screen.getByRole('alert')).toHaveTextContent('previous scheduled run r1 is still running')
    expect(screen.getByText(/next not scheduled/)).toBeInTheDocument()
  })

  it('says when the last delivery to Notion failed', () => {
    render(<RoutineNote schedule={{ ...routine, lastDelivery: { ...routine.lastDelivery!, status: 'failed', message: 'Notion is not connected.' } }} onRunNow={vi.fn()} busy={false} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Last delivery to Notion failed: Notion is not connected.')
  })

  it('holds the button while a run is starting', () => {
    render(<RoutineNote schedule={routine} onRunNow={vi.fn()} busy />)
    expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled()
  })
})
