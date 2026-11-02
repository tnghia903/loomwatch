import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { AttentionAlerts } from './AttentionAlerts'

afterEach(cleanup)

const LIMIT = 'LoomWatch has reached a usage limit on your ChatGPT plan: the plan\'s own limit, or the share you allowed LoomWatch. See it under Manage usage in ChatGPT\'s settings.'

// Run 03f7b0dd: LoomWatch's own check stopped at a ChatGPT plan's limit. It is on no team file, so
// its alert is named as the chat names it, not by its id.
describe('an alert from an agent the team file doesn’t list', () => {
  it('names LoomWatch’s own check LoomWatch, and a helper after its agent', () => {
    render(
      <AttentionAlerts
        alerts={[{ id: 'a1', seq: 1, agentId: 'loomwatch:check', message: LIMIT }, { id: 'a2', seq: 2, agentId: 'writer~2', message: 'It stopped.' }]}
        nodeNames={new Map([['writer', 'Writer']])}
        canFix={() => false} onFix={() => {}} onReveal={() => {}} onDismiss={() => {}}
      />,
    )
    const names = screen.getAllByText((_, element) => element?.tagName === 'B').map((element) => element.textContent)
    expect(names).toEqual(['LoomWatch', 'Writer’s helper 2'])
    expect(screen.queryByText(/loomwatch:check/)).toBeNull()
  })
})
