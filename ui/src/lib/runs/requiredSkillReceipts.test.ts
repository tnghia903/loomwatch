import { describe, expect, it } from 'vitest'
import { projectRun, type RunEvent } from '../watch/events'
import { capabilityEvidence } from './capabilityEvidence'
const skill = {
  name: 'claude-design',
  source: 'Claude Code',
  sourcePath: '/home/.claude/skills/claude-design--abc/SKILL.md',
  path: '/work/.agents/skills/claude-design--abc/SKILL.md',
  sha256: 'a'.repeat(64),
  chars: 200,
}
const event = (
  seq: number,
  payload: RunEvent['payload'],
  trusted = true,
): RunEvent => ({
  id: `e${seq}`,
  sessionId: 'r',
  agentId: 'designer',
  seq,
  ts: `2026-09-14T10:00:0${seq}Z`,
  kind: 'session_meta',
  payload,
  raw: trusted ? { source: 'loomwatch' } : { method: 'session/update' },
})
const prepared = event(1, {
  phase: 'prompt_sections',
  sections: [],
  requiredSkills: [skill],
})
const supplied = event(2, {
  phase: 'required_skills_supplied',
  skills: [skill],
})
describe('required skill delivery receipts', () => {
  it('keeps preparation distinct from sending at the replay cursor', () => {
    const before = projectRun([prepared, supplied], 1).agents[0]
    expect(before.requiredSkills?.[0].state).toBe('prepared')
    const after = projectRun([prepared, supplied], 2).agents[0]
    expect(after.requiredSkills?.[0].state).toBe('supplied')
    expect(
      capabilityEvidence(
        { id: 'designer', name: 'Designer', role: 'Design' },
        [],
        after.requiredSkills,
      )[0],
    ).toMatchObject({
      name: 'claude-design',
      state: 'loaded',
      label: 'Loaded into prompt',
    })
  })
  it('includes a sent skill in provenance without counting it as a tool call', () => {
    const run = projectRun([prepared, supplied])
    expect(run.evidence[0]).toMatchObject({
      kind: 'skill',
      relation: 'loaded into prompt',
      capture: 'recorded',
      status: 'succeeded',
    })
    expect(run.coverage.skills.observed).toBe(1)
    const items = capabilityEvidence(
      { id: 'designer', name: 'Designer', role: 'Design' },
      run.evidence,
      run.agents[0].requiredSkills,
    )
    expect(items).toHaveLength(1)
    expect(items[0].evidence).toHaveLength(1)
  })

  it('rejects a receipt with a different version fingerprint', () => {
    const projected = projectRun([
      prepared,
      event(2, {
        phase: 'required_skills_supplied',
        skills: [{ ...skill, sha256: 'b'.repeat(64) }],
      }),
    ]).agents[0]
    expect(projected.requiredSkills?.[0].state).toBe('prepared')
  })
  it('does not treat a harness-authored metadata claim as a delivery receipt', () => {
    const projected = projectRun([
      prepared,
      event(2, { phase: 'required_skills_supplied', skills: [skill] }, false),
    ]).agents[0]
    expect(projected.requiredSkills?.[0].state).toBe('prepared')
  })
  it('uses the archived requirements even when Build has changed', () => {
    const projected = projectRun([prepared, supplied]).agents[0]
    const items = capabilityEvidence(
      {
        id: 'designer',
        name: 'Designer',
        role: 'Design',
        capabilities: [{ name: 'different-skill', kind: 'skill' }],
      },
      [],
      projected.requiredSkills,
    )
    expect(items.map((item) => item.name)).toEqual(['claude-design'])
  })
  /**
   * Delivery was already provable; opening was not. `docs/RUN_PROVENANCE_CONTRACT.md` §12 is
   * explicit that "prompt/filesystem presence is not use", so the run UI must not read a supplied
   * receipt as a read one — only the daemon's recorded `skill_opened` says that.
   */
  it('raises a supplied skill to opened only when the daemon recorded the agent reading it', () => {
    const opened = event(3, {
      phase: 'skill_opened',
      skill: 'claude-design',
      path: skill.path,
      sha256: skill.sha256,
      toolCallId: 'call-7',
    })
    const before = projectRun([prepared, supplied], 2).agents[0]
    expect(before.requiredSkills?.[0].state).toBe('supplied')
    const after = projectRun([prepared, supplied, opened]).agents[0]
    expect(after.requiredSkills?.[0].state).toBe('opened')
    expect(
      capabilityEvidence({ id: 'designer', name: 'Designer', role: 'Design' }, [], after.requiredSkills)[0],
    ).toMatchObject({ name: 'claude-design', label: 'Delivered → opened' })
    // An open of some other skill, or of a different revision of this one, is not this skill's.
    for (const wrong of [{ skill: 'other-skill' }, { sha256: 'c'.repeat(64) }]) {
      const mismatched = projectRun([
        prepared,
        supplied,
        event(3, { phase: 'skill_opened', skill: 'claude-design', path: skill.path, sha256: skill.sha256, ...wrong }),
      ]).agents[0]
      expect(mismatched.requiredSkills?.[0].state).toBe('supplied')
    }
  })

  /**
   * The route decides what "supplied" even means. A `native` route deliberately keeps the skill's
   * text out of the prompt, so reporting "loaded into prompt" for it would be a false claim about
   * what the daemon sent.
   */
  it('describes a supplied skill by the route it actually took', () => {
    const routed = (route: 'native' | 'inline') =>
      capabilityEvidence(
        { id: 'designer', name: 'Designer', role: 'Design' },
        [],
        projectRun([
          event(1, { phase: 'prompt_sections', sections: [], requiredSkills: [{ ...skill, route }] }),
          event(2, { phase: 'required_skills_supplied', skills: [{ ...skill, route }] }),
        ]).agents[0].requiredSkills,
      )[0].label
    expect(routed('native')).toBe('Delivered, pointer in prompt')
    expect(routed('inline')).toBe('Loaded into prompt, translated')
  })

  /** The agent's own words about what it skipped. A claim the UI shows, never evidence. */
  it('keeps the agent’s self-report off the evidence list', () => {
    const run = projectRun([
      prepared,
      supplied,
      event(3, { phase: 'skill_self_report', text: '## What I could not follow\n- the bundled script', chars: 47 }),
    ])
    expect(run.agents[0].skillSelfReport).toContain('could not follow')
    expect(run.evidence.some((item) => item.name.includes('could not follow'))).toBe(false)
    expect(run.coverage.skills.observed).toBe(1)
  })

  it('distinguishes old captures from a recorded empty requirement list', () => {
    expect(
      projectRun([event(1, { phase: 'prompt_sections', sections: [] })])
        .agents[0].requiredSkills,
    ).toBeUndefined()
    expect(
      projectRun([
        event(1, {
          phase: 'prompt_sections',
          sections: [],
          requiredSkills: [],
        }),
      ]).agents[0].requiredSkills,
    ).toEqual([])
  })
})
