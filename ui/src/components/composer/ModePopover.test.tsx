import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ScheduleEntry } from '../../lib/runs/client'
import { ModePopover } from './ModePopover'

afterEach(cleanup)

const routine: ScheduleEntry = {
  teamPath: 'daily-news.yaml', teamName: 'Daily news', cron: '0 8 * * *', timezone: 'Asia/Singapore', describe: 'daily at 08:00 Asia/Singapore',
  prompt: 'Prepare the {{weekday}} {{date}} edition.', enabled: true, nextAt: new Date(Date.now() + 5 * 3_600_000).toISOString(),
  lastRunId: 'r1', lastStatus: 'succeeded', lastFiredAt: '2026-09-11T00:00:00Z',
  lastDelivery: { target: 'notion', status: 'failed', url: null, pageId: null, message: 'Notion is not connected.', deliveredAt: '2026-09-11T00:03:00Z' },
  deliver: { notion: { title: 'News — {{date}}' } }, problem: null,
}

function renderPopover(schedule: ScheduleEntry | null, onRunRoutineNow = vi.fn()) {
  render(
    <ModePopover mode="pipeline" steps={[{ id: 'a', step: 1, joinFrom: [] }, { id: 'b', step: 2, joinFrom: ['a'] }]} nodeNames={new Map([['a', 'Collector'], ['b', 'Writer']])} entrypointName="Collector"
      guards={null} budget={null} anomalies={[]} readOnly={false} onUpdateGuards={vi.fn()} onUpdateBudget={vi.fn()} onClose={vi.fn()} schedule={schedule} onRunRoutineNow={onRunRoutineNow} />,
  )
  return onRunRoutineNow
}

describe('ModePopover routine section', () => {
  it('explains the pipeline order and shows no routine section for an unscheduled team', () => {
    renderPopover(null)
    expect(screen.getByText('Collector')).toBeInTheDocument()
    expect(screen.queryByText(/Run routine now/)).not.toBeInTheDocument()
  })

  it('states when the routine runs, where it delivers, its last outcome, and runs it on demand', () => {
    const runNow = renderPopover(routine)
    expect(screen.getByText(/Runs daily at 08:00 Asia\/Singapore/)).toBeInTheDocument()
    expect(screen.getByText(/next in 5h/)).toBeInTheDocument()
    expect(screen.getByText(/Delivers the reply to your Notion destination/)).toBeInTheDocument()
    expect(screen.getByText(/succeeded · Notion failed/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Run routine now' }))
    expect(runNow).toHaveBeenCalledOnce()
  })

  it('surfaces a scheduler problem verbatim', () => {
    renderPopover({ ...routine, nextAt: null, problem: 'previous scheduled run r1 is still running' })
    expect(screen.getByRole('alert')).toHaveTextContent('previous scheduled run r1 is still running')
    expect(screen.getByText(/next not scheduled/)).toBeInTheDocument()
  })
})
