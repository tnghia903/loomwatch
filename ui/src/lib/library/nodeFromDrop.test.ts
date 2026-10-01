import { describe, expect, it } from 'vitest'

import type { AgentNode } from './nodeFromDrop'
import { nodeFromDrop } from './nodeFromDrop'
import { DEFAULT_AGENT_ROLE } from './createAgent'
import type { LibrarySource } from './types'

const harnessSource: LibrarySource = {
  group: 'detected',
  id: 'opencode',
  label: 'OpenCode',
  spawn: { cmd: 'opencode', args: ['acp'] },
}

describe('nodeFromDrop', () => {
  it('builds a selected node at the snapped drop position', () => {
    const node = nodeFromDrop(JSON.stringify(harnessSource), { x: 101, y: 43 }, [])
    expect(node).not.toBeNull()
    expect(node?.position).toEqual({ x: 104, y: 40 })
    expect(node?.selected).toBe(true)
    expect(node?.data.agent.name).toBe('OpenCode')
    expect(node?.data.agent.role).toBe(DEFAULT_AGENT_ROLE)
  })

  it('deselects existing nodes are left to the caller (does not mutate input)', () => {
    const existing: AgentNode[] = [
      {
        id: 'opencode',
        type: 'default',
        position: { x: 0, y: 0 },
        selected: true,
        data: {
          label: 'OpenCode',
          agent: {
            id: 'opencode',
            name: 'OpenCode',
            role: '',
            model: '',
            spawn: { cmd: 'opencode', args: ['acp'], env: {}, cwd: '.' },
            allowRecruiting: true,
          },
        },
      },
    ]
    const node = nodeFromDrop(JSON.stringify(harnessSource), { x: 0, y: 0 }, existing)
    expect(node?.id).toBe('opencode-2')
    expect(existing[0].selected).toBe(true)
  })

  it('returns null for a non-Library payload', () => {
    const node = nodeFromDrop('not json', { x: 0, y: 0 }, [])
    expect(node).toBeNull()
  })
})
