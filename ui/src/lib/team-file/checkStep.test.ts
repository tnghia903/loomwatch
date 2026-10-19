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
  it('checks the work, sends a miss back once, and sets an effort only on a model that has one', () => {
    expect(checkStepFields({ thinkingEffort: 'medium' }, job('writer'))).toEqual({ checks: 'writer', sendBackOnce: true, thinkingEffort: 'high' })
    expect(checkStepFields({}, job('coder'))).toEqual({ checks: 'coder', sendBackOnce: true })
  })
})

describe('the Writer job’s sources', () => {
  // Read word for word, "each source link beside its claim" was Not met on a rewrite whose facts all
  // came in the request, and the round it was sent back for could not meet it (quality bench
  // pilot-1, W1). The daemon tells every check step such an item does not apply (lib.rs
  // check_material); the job says so itself, and still holds work whose facts came with links.
  it('asks for a link beside each claim only when the facts came with links', () => {
    const writer = ROLE_PRESETS.find((preset) => preset.id === 'writer')
    expect(writer?.doneWhen).toEqual([
      'Answers what the request asked, in the format and length it named',
      'Uses only facts you were given; if they came with source links, each claim has its link beside it',
    ])
  })

  // Given linked findings and one "some blogs say" with no link, every Writer on the bench's L1
  // probe kept it, ending its paragraph with a link that backs only the rest of the sentence. Told
  // only to drop what "has no source", it took the blogs for the source, or wrote "You may read
  // that…" instead.
  it('leaves out, or says it has no source, a report of what others say', () => {
    const writer = ROLE_PRESETS.find((preset) => preset.id === 'writer')
    expect(writer?.role).toContain(
      '- A report of what others say, such as "some blogs say", has no source unless it links to them: leave it out, or say plainly that it has none. Do not reword it to hide that.',
    )
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
