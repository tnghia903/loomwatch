import { describe, expect, it } from 'vitest'

import { ownFolderReason, workFolder } from './workFolder'

describe('workFolder', () => {
  it('reads every spelling of the team file’s own folder as the team’s folder', () => {
    for (const cwd of ['.', './', '', ' . ', undefined]) expect(workFolder(cwd)).toEqual({ kind: 'team' })
  })

  it('names a chosen folder by its last part', () => {
    expect(workFolder('/Users/me/Projects/website/')).toEqual({ kind: 'chosen', name: 'website', path: '/Users/me/Projects/website/' })
    expect(workFolder('./site')).toEqual({ kind: 'chosen', name: 'site', path: './site' })
    expect(workFolder('/')).toEqual({ kind: 'chosen', name: '/', path: '/' })
  })
})

// Mirrors `workspace::materialise` (ADR 0012 decision 4, ADR 0037 decision 6).
describe('ownFolderReason', () => {
  const spawn = (cwd: string) => ({ cmd: 'claude-agent-acp', args: [], env: {}, cwd })

  // ADR 0042: connecting something used to move an agent out of the folder chosen for it, so it
  // silently stopped working on the operator's project.
  it('moves an agent with something connected only out of the team\u2019s folder', () => {
    const design = [{ kind: 'skill' as const, name: 'design' }]
    for (const cwd of ['.', '..']) expect(ownFolderReason({ spawn: spawn(cwd), capabilities: design })).toBe('connected')
    expect(ownFolderReason({ spawn: spawn('/Users/me/site'), capabilities: design })).toBeNull()
    expect(ownFolderReason({ spawn: spawn('/Users/me/site'), capabilities: [{ kind: 'knowledge', name: 'reports', path: '/Users/me/reports' }], allow: { edits: true } })).toBeNull()
  })

  it('moves an editing agent out of any folder that holds the team file', () => {
    for (const cwd of ['.', './', '..', '../..']) expect(ownFolderReason({ spawn: spawn(cwd), allow: { edits: true } })).toBe('edits')
  })

  it('leaves an editing agent in a folder chosen elsewhere, and a reading one where it is', () => {
    expect(ownFolderReason({ spawn: spawn('/Users/me/site'), allow: { edits: true } })).toBeNull()
    expect(ownFolderReason({ spawn: spawn('site'), allow: { edits: true } })).toBeNull()
    expect(ownFolderReason({ spawn: spawn('.'), allow: { web: true, commands: true } })).toBeNull()
  })
})
