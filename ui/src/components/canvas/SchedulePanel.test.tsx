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
  })
})
