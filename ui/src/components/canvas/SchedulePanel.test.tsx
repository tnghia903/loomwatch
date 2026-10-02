import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SchedulePanel } from './SchedulePanel'

afterEach(cleanup)

describe('SchedulePanel', () => {
  it('uses the same glass and scroll shell as the agent inspector', () => {
    const { container } = render(
      <SchedulePanel
        schedule={{ cron: '0 10 * * *', timezone: 'Asia/Singapore', prompt: 'Prepare the digest.' }}
        problems={[]}
        readOnly={false}
        dirty={false}
        canSaveFile
        savedInEditor={false}
        onSave={vi.fn()}
        onSaveFile={vi.fn()}
        onAdvanced={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    const panel = screen.getByRole('region', { name: 'Schedule' })
    expect(panel).toHaveClass('lw-inspector', 'lw-schedule-panel')
    expect(container.querySelector('.inspector-glass')).toBeInTheDocument()
    expect(container.querySelector('.inspector-scroll')).toBeInTheDocument()
    // No routine on disk yet, so there is no live status to show.
    expect(screen.queryByLabelText('Routine status')).not.toBeInTheDocument()
  })

  // The panel is where a routine's live status and "Run now" live since the mode popover went.
  it('shows the saved routine’s status when the daemon reports one', () => {
    render(
      <SchedulePanel
        schedule={{ cron: '0 10 * * *', timezone: 'Asia/Singapore', prompt: 'Prepare the digest.' }}
        problems={[]} readOnly={false} dirty={false} canSaveFile savedInEditor={false}
        onSave={vi.fn()} onSaveFile={vi.fn()} onAdvanced={vi.fn()} onClose={vi.fn()}
        status={<button type="button">Run now</button>}
      />,
    )
    expect(screen.getByLabelText('Routine status')).toContainElement(screen.getByRole('button', { name: 'Run now' }))
  })
})
