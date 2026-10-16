import { describe, expect, it } from 'vitest'

import type { PermissionRequest } from '../runs/client'
import { askedKey, figureMood, partOfNode, reactionsBetween, WORKING_WINDOW_MS, type FigureLook } from './figure'

const ask = (sw: PermissionRequest['switch']): PermissionRequest => ({ id: 'p1', agent: 'a', name: 'A', title: 'Web search', kind: 'fetch', switch: sw, since: '', expiresAt: '' })

describe('what each part of the workbench stands for', () => {
  it('finds the part from the node or its nearest named ancestor', () => {
    expect(partOfNode(['nameplate_face', 'nameplate', 'bench', 'scene'])).toBe('name')
    expect(partOfNode(['laptop_face', 'laptop_lid', 'laptop', 'bench', 'scene'])).toBe('app')
    expect(partOfNode(['laptop_keys', 'laptop', 'bench'])).toBe('app')
    expect(partOfNode(['job_sheet', 'job', 'bench', 'scene'])).toBe('job')
    expect(partOfNode(['job_stand', 'bench', 'scene'])).toBe('job')
    expect(partOfNode(['card_2_face', 'card_2', 'pegboard', 'scene'])).toBe('skills')
    expect(partOfNode(['key_web_tag', 'key_web', 'hook_web', 'hooks', 'pegboard'])).toBe('keys')
    expect(partOfNode(['hooks_bar', 'hooks', 'pegboard'])).toBe('keys')
    // The drawer is made on the page, not in the model: its front, its box and what is filed in it.
    expect(partOfNode(['reads_1_folder', 'reads_1', 'reads_drawer', 'reads'])).toBe('reads')
    expect(partOfNode(['reads_pull', 'reads_drawer', 'reads'])).toBe('reads')
    expect(partOfNode(['reads_mouth', 'reads'])).toBe('reads')
    // So is the tool drawer, and the wrenches in it.
    expect(partOfNode(['tools_2_steel', 'tools_2_wrench', 'tools_2', 'tools_drawer', 'tools'])).toBe('tools')
    expect(partOfNode(['tools_front', 'tools_drawer', 'tools'])).toBe('tools')
    expect(partOfNode(['dish_bowl', 'dish', 'bench'])).toBe('keys')
    expect(partOfNode(['envelope_seal', 'envelope', 'tray', 'bench'])).toBe('reply')
  })

  it('takes the whole figure for the model', () => {
    expect(partOfNode(['yarn_eye_l_mesh', 'yarn_eye_l', 'yarn_face', 'head_yarn', 'head', 'neck', 'body', 'figure'])).toBe('mind')
    expect(partOfNode(['pincushion_pin_1_head', 'pincushion_pin_1', 'head_pincushion', 'head', 'neck', 'body', 'figure'])).toBe('mind')
    expect(partOfNode(['scarf', 'neck', 'body', 'figure', 'scene'])).toBe('mind')
    expect(partOfNode(['hand_l_mitten', 'hand_l', 'arm_l', 'body', 'figure'])).toBe('mind')
  })

  it('lets the bare bench and pegboard stand for nothing', () => {
    expect(partOfNode(['bench_body', 'bench', 'scene'])).toBeNull()
    expect(partOfNode(['pegboard_panel', 'pegboard', 'scene'])).toBeNull()
  })

  it('does not take one name for the start of another', () => {
    expect(partOfNode(['keyboard'])).toBeNull()
    expect(partOfNode(['benchmark'])).toBeNull()
    expect(partOfNode(['laptops'])).toBeNull()
  })
})

describe('the figure’s mood comes from the run record only', () => {
  const now = 100_000
  it('is still with no run', () => {
    expect(figureMood(null, null, now)).toBe('still')
  })

  it('works while the record moves, and only rests when it goes quiet: it does not guess at thinking', () => {
    const running = { status: 'running' as const }
    expect(figureMood(running, now - 500, now)).toBe('working')
    expect(figureMood(running, now - WORKING_WINDOW_MS - 1, now)).toBe('quiet')
    expect(figureMood(running, null, now)).toBe('quiet')
  })

  it('asks when it waits on you, for a permission or an answer', () => {
    expect(figureMood({ status: 'running', permissionRequests: [ask('web')] }, now, now)).toBe('asking')
    expect(figureMood({ status: 'running', waitingOn: { kind: 'question', node: 'a', question: 'Which?' } as never }, now, now)).toBe('asking')
  })

  it('settles the way the run ended', () => {
    expect(figureMood({ status: 'queued' }, null, now)).toBe('starting')
    expect(figureMood({ status: 'succeeded' }, null, now)).toBe('done')
    expect(figureMood({ status: 'failed' }, null, now)).toBe('failed')
    expect(figureMood({ status: 'cancelled' }, null, now)).toBe('stopped')
  })

  it('names the key it asks for, when a switch would cover the request', () => {
    expect(askedKey({ permissionRequests: [ask(null), ask('commands')] })).toBe('commands')
    expect(askedKey({ permissionRequests: [ask(null)] })).toBeNull()
    expect(askedKey(null)).toBeNull()
  })
})

describe('what the figure reacts to', () => {
  const look: FigureLook = { name: 'Reader', instructions: 'Read.', app: 'claude', model: 'sonnet', skills: ['summarize'], allow: { web: false, edits: false, commands: false } }

  it('reacts once to each thing that changed', () => {
    expect(reactionsBetween(look, look)).toEqual([])
    expect(reactionsBetween(look, { ...look, name: 'Reader 2', model: 'opus' })).toEqual([{ kind: 'renamed' }, { kind: 'rethought' }])
    expect(reactionsBetween(look, { ...look, app: 'codex', model: '' })).toEqual([{ kind: 'rebenched' }, { kind: 'rethought' }])
    expect(reactionsBetween(look, { ...look, instructions: 'Read twice.' })).toEqual([{ kind: 'reread' }])
  })

  it('pins a card for an added skill and takes one down for a removed one', () => {
    expect(reactionsBetween(look, { ...look, skills: ['summarize', 'pdf'] })).toEqual([{ kind: 'pinned', skill: 'pdf' }])
    expect(reactionsBetween(look, { ...look, skills: [] })).toEqual([{ kind: 'unpinned', skill: 'summarize' }])
  })

  it('hangs a key on its hook when you hand it over, and puts it in your dish when you take it back', () => {
    expect(reactionsBetween(look, { ...look, allow: { ...look.allow, web: true } })).toEqual([{ kind: 'key', key: 'web', given: true }])
    expect(reactionsBetween({ ...look, allow: { ...look.allow, edits: true } }, look)).toEqual([{ kind: 'key', key: 'edits', given: false }])
  })
})
