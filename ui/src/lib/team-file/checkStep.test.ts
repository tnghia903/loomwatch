import { describe, expect, it } from 'vitest'

import { CHECKER_ROLE, isCheckerRole } from '../library/checker'
import { ROLE_PRESETS } from '../library/roles'
import { CHECK_EFFORT, CHECK_EFFORT_DEFAULT, checkEffort, checkedWork, checkStepFields } from './checkStep'

const job = (id: string) => {
  const preset = ROLE_PRESETS.find((candidate) => candidate.id === id)
  if (!preset) throw new Error(id)
  return { id, name: preset.label, role: preset.role }
}

describe('checkEffort', () => {
  // Quality first: every kind of work is checked at high until the quality benchmark shows a
  // cheaper row still finds what high finds. One table, so that is a one-row change.
  it('checks every kind of work at high, from one table keyed by the job', () => {
    for (const preset of ROLE_PRESETS) expect([preset.id, checkEffort(job(preset.id))]).toEqual([preset.id, 'high'])
    expect(Object.keys(CHECK_EFFORT).sort()).toEqual(ROLE_PRESETS.filter((preset) => preset.effort).map((preset) => preset.id).sort())
    expect(checkEffort({ name: 'Summary', role: 'Sum up the emails.' })).toBe(CHECK_EFFORT_DEFAULT)
    expect(CHECK_EFFORT_DEFAULT).toBe('high')
  })

  it('reads the kind of work from the job, else from what the agent may do', () => {
    expect(['writer', 'coder', 'analyst', 'researcher'].map((id) => checkedWork(job(id)))).toEqual(['writer', 'coder', 'analyst', 'researcher'])
    expect(checkedWork({ name: 'Fixer', role: 'Make the failing build pass.', allow: { commands: true } })).toBe('coder')
    expect(checkedWork({ name: 'Summary', role: 'Sum up the emails.' })).toBeNull()
  })
})

describe('checkStepFields', () => {
  it('checks the work, sends a miss back up to twice then asks you, and sets an effort only on a model that has one', () => {
    expect(checkStepFields({ thinkingEffort: 'medium' }, job('writer'))).toEqual({ checks: 'writer', sendBack: { rounds: 2, whenStillNotMet: 'ask' }, thinkingEffort: 'high' })
    expect(checkStepFields({}, job('coder'))).toEqual({ checks: 'coder', sendBack: { rounds: 2, whenStillNotMet: 'ask' } })
  })
})

describe('isCheckerRole', () => {
  // A Checker placed before its instructions changed is still a Checker.
  it('knows the Checker job’s instructions, old and new', () => {
    expect(isCheckerRole(CHECKER_ROLE)).toBe(true)
    expect(isCheckerRole(`${CHECKER_ROLE}\n`)).toBe(true)
    expect(isCheckerRole([
      'You are the team’s checker. Check the work you were handed against what it must satisfy and against the request. Do not rewrite it.',
      '',
      'How to work:',
      '- Check each item on its own. Open every source the work cites. If the work is code, check it the way its project checks code, when you are allowed to.',
      '- Mark an item Met only on evidence you saw yourself: a page you opened, a command and its output, a file and line.',
      '- When you cannot tell, say Not sure rather than guessing.',
      '- Report only gaps in correctness or in what was asked. Taste is not a problem.',
      '- Before you reply, check that every item has a verdict and its evidence.',
      '',
      'Reply with the problems you found, most serious first, then end with this block, one line per item:',
      '## Check',
      '- Met | Not met | Not sure — the item — your evidence',
    ].join('\n'))).toBe(true)
    expect(isCheckerRole('Check the draft.')).toBe(false)
  })

  // The daemon reads numbered lines and holds a checker to every problem it lists (lib.rs read_checks).
  it('asks for numbered check lines, every problem among them, and few sources opened', () => {
    expect(CHECKER_ROLE).toContain('1. Met | Not met | Not sure — the item — your evidence')
    expect(CHECKER_ROLE).toContain('every problem you found is a Not met line')
    expect(CHECKER_ROLE).toContain('check for yourself every claim you cannot trace there and every claim the work rests on')
    expect(CHECKER_ROLE).not.toContain('at most')
    expect(CHECKER_ROLE).not.toContain('Open every source the work cites')
  })
})
