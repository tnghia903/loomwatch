import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ROLE_PRESETS } from '../../lib/library/roles'
import { instructionShape } from '../../lib/team-file/checkup'
import { AgentUsageLine } from './AgentUsageLine'
import { InstructionShape } from './InstructionShape'

afterEach(cleanup)

describe('instructionShape', () => {
  it('finds every part in every built-in job', () => {
    for (const job of ROLE_PRESETS) expect(instructionShape(job.role), job.id).toEqual({ job: true, method: true, check: true, reply: true })
  })

  it('does not read a check before replying as saying what it replies with', () => {
    const role = 'You write the launch announcement for our app.\n\nBefore you reply, check every date against the release notes.'
    expect(instructionShape(role)).toMatchObject({ method: false, check: true, reply: false })
    expect(instructionShape(`${role}\n\nReply with the post only.`)).toMatchObject({ check: true, reply: true })
  })

  it('does not count a part that was started but not written', () => {
    expect(instructionShape('Write launch copy.')).toEqual({ job: false, method: false, check: false, reply: false })
    expect(instructionShape('You write the launch announcement for our app.\n\nBefore you reply, check ')).toMatchObject({ job: true, check: false })
    expect(instructionShape('You write the launch announcement for our app.\n\nReply with ')).toMatchObject({ job: true, reply: false })
    expect(instructionShape('You write the launch announcement for our app.\n\nHow to work:\n- ')).toMatchObject({ method: false })
    expect(instructionShape('You write the launch announcement for our app.\n\nReply with the post only.')).toMatchObject({ reply: true })
  })
})

describe('InstructionShape', () => {
  it('shows what the instructions cover, and starts a missing part where the operator writes on', () => {
    const onChange = vi.fn()
    render(<InstructionShape role="You write the launch announcement for our app." field={createRef()} onChange={onChange} />)
    expect(screen.getByRole('group', { name: 'What these instructions cover' })).toHaveTextContent('Its jobHow to workHow it checksWhat it replies with')
    expect(screen.queryByRole('button', { name: 'Its job' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'How to work' }))
    expect(onChange).toHaveBeenCalledWith('You write the launch announcement for our app.\n\nHow to work:\n- ')
    fireEvent.click(screen.getByRole('button', { name: 'How it checks' }))
    expect(onChange).toHaveBeenLastCalledWith('You write the launch announcement for our app.\n\nBefore you reply, check ')
  })

  it('says nothing about empty instructions, and changes nothing on a read-only team', () => {
    const { container, rerender } = render(<InstructionShape role="  " field={createRef()} onChange={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<InstructionShape role="Write launch copy." field={createRef()} onChange={vi.fn()} readOnly />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})

describe('AgentUsageLine', () => {
  it('says what the agent used and what its app costs before the request', () => {
    const usage = { id: 'scout', name: 'Scout', perRun: 41_000, share: 0.48, opening: 29_000 }
    const { rerender } = render(<AgentUsageLine usage={usage} runs={3} alone={false} />)
    expect(screen.getByText('About 41k tokens a run, 48% of the team')).toBeInTheDocument()
    expect(screen.getByText('Its app starts at about 29k before your request')).toBeInTheDocument()
    rerender(<AgentUsageLine usage={{ ...usage, opening: null }} runs={1} alone />)
    expect(screen.getByText('About 41k tokens a run')).toBeInTheDocument()
    expect(screen.queryByText(/starts at/)).not.toBeInTheDocument()
  })
})
