import { cleanup, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { isGoldFill } from '../../test/cascade'
import { AttachButton, SendButton } from './BoxButtons'

afterEach(cleanup)

describe('every box’s send (ADR 0101)', () => {
  it('is an icon alone, named for what it does', () => {
    render(<SendButton label="Start" />)
    const send = screen.getByRole('button', { name: 'Start' })
    expect(send).toHaveTextContent('')
    expect(send.querySelector('svg.lw-icon-send')).not.toBeNull()
    expect(send).toHaveAttribute('type', 'submit')
    expect(send.getAttribute('title')).toMatch(/^Start \(/)
  })

  it('is entered, not sent, for a note or a reply', () => {
    render(<SendButton label="Send note" icon="enter" />)
    expect(screen.getByRole('button', { name: 'Send note' }).querySelector('svg.lw-icon-enter')).not.toBeNull()
  })

  it('is gold only where its box is the screen’s main action, and never while it can’t be pressed', () => {
    render(<><SendButton label="Start" primary /><SendButton label="Send" /><SendButton label="Reply" primary disabled /></>)
    expect(isGoldFill(screen.getByRole('button', { name: 'Start' }))).toBe(true)
    expect(isGoldFill(screen.getByRole('button', { name: 'Send' }))).toBe(false)
    expect(isGoldFill(screen.getByRole('button', { name: 'Reply' }))).toBe(false)
  })

  it('stands in every box: Home’s and a room’s, the team chat’s, Ask’s, the first run’s and the notch’s', () => {
    const src = resolve(process.cwd(), 'src')
    for (const file of ['components/studio/WorkBox.tsx', 'components/chat/ChatComposer.tsx', 'components/ask/AskPanel.tsx', 'components/firstrun/FirstRun.tsx', 'island/Island.tsx']) {
      expect(readFileSync(resolve(src, file), 'utf8'), file).toMatch(/<SendButton\b/)
    }
  })
})

it('gives every box the same attach, named for what it adds', () => {
  render(<AttachButton onClick={() => {}} />)
  const attach = screen.getByRole('button', { name: 'Add pictures or files' })
  expect(attach).toHaveAttribute('type', 'button')
  expect(attach.querySelector('svg.lw-icon-attach')).not.toBeNull()
})
