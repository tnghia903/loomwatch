import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { skillName } from './skillName'

type Case = { title: string; name: string }

const { cases } = JSON.parse(readFileSync(resolve(process.cwd(), '../schemas/skill-name.cases.json'), 'utf8')) as { cases: Case[] }

describe('skillName', () => {
  it('names a new skill as the daemon does', () => {
    expect(cases.length).toBeGreaterThanOrEqual(10)
    for (const { title, name } of cases) expect(skillName(title), JSON.stringify(title)).toBe(name)
  })

  it('leaves a name it made as it is', () => {
    for (const { name } of cases) expect(skillName(name)).toBe(name)
  })
})
