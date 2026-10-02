import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import type { DetectedHarness } from '../harnesses'
import { browserName, DETAILS_FIELD, describeSystem, issueUrl, withoutHomeFolder, type AboutLoomWatch } from './report'

const about: AboutLoomWatch = { version: '0.1.0', commit: 'b4e3373', os: 'macos', osVersion: '26.0', arch: 'aarch64' }
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

function harness(id: string, name: string, extra: Partial<DetectedHarness> = {}): DetectedHarness {
  return { id, name, command: id, executablePath: `/Users/someone/.local/bin/${id}`, acpAvailable: true, spawn: { cmd: id, args: [] }, ...extra }
}

describe('browserName', () => {
  it('tells Safari, Chrome, Edge and Firefox apart', () => {
    expect(browserName(SAFARI)).toBe('Safari 26.0')
    expect(browserName(CHROME)).toBe('Chrome 140')
    expect(browserName(`${CHROME} Edg/140.0.0.0`)).toBe('Edge 140')
    expect(browserName('Mozilla/5.0 (Macintosh; rv:141.0) Gecko/20100101 Firefox/141.0')).toBe('Firefox 141')
  })
})

describe('describeSystem', () => {
  it('names the build, system, browser, screen and which apps can start', () => {
    const text = describeSystem(about, [
      harness('claude', 'Claude'),
      harness('gemini', 'Gemini', { health: 'error', healthReason: 'This client is no longer supported.' }),
    ], { screen: 'run' }, SAFARI)
    expect(text).toBe([
      'LoomWatch: 0.1.0 (b4e3373)',
      'System: macOS 26.0 (aarch64)',
      'Browser: Safari 26.0',
      'Screen: Run (watching a run)',
      "AI apps: Claude (ready); Gemini (can't start: This client is no longer supported.)",
    ].join('\n'))
  })

  it('never carries where an app is installed, and hides the home folder in an error', () => {
    const text = describeSystem(about, [harness('claude', 'Claude')], { error: "ENOENT: no such file '/Users/someone/LoomWatch/teams/x.yaml'" }, SAFARI)
    expect(text).not.toContain('someone')
    expect(text).toContain("Error: ENOENT: no such file '~/LoomWatch/teams/x.yaml'")
  })

  it('still reports when the server is down or the apps were never checked', () => {
    const text = describeSystem(null, null, {}, CHROME)
    expect(text).toBe('LoomWatch: unknown (the LoomWatch server did not answer)\nBrowser: Chrome 140')
  })

  it('cuts a huge error so the link stays short enough for GitHub', () => {
    const text = describeSystem(about, [], { error: 'x'.repeat(50_000) }, SAFARI)
    expect(text.length).toBeLessThanOrEqual(3000)
  })
})

describe('withoutHomeFolder', () => {
  it('replaces macOS, Linux and Windows home folders', () => {
    expect(withoutHomeFolder('/Users/ann/a and /home/bob/b and C:\\Users\\cat\\c')).toBe('~/a and ~/b and ~\\c')
  })
})

describe('issueUrl', () => {
  it('opens the right form with the details field filled in', () => {
    const url = new URL(issueUrl('problem', 'LoomWatch: 0.1.0', 'Crash on Run'))
    expect(url.origin + url.pathname).toBe('https://github.com/tnghia903/loomwatch/issues/new')
    expect(url.searchParams.get('template')).toBe('bug_report.yml')
    expect(url.searchParams.get('title')).toBe('Crash on Run')
    expect(url.searchParams.get(DETAILS_FIELD)).toBe('LoomWatch: 0.1.0')
    expect(new URL(issueUrl('idea', 'd')).searchParams.get('template')).toBe('feedback.yml')
    expect(new URL(issueUrl('idea', 'd')).searchParams.has('title')).toBe(false)
  })

  // GitHub silently ignores a query parameter that names no field, so a renamed field id would
  // leave every report without its details. Read the forms themselves.
  it.each(['bug_report.yml', 'feedback.yml'])('matches a field id in .github/ISSUE_TEMPLATE/%s', (file) => {
    const form = parse(readFileSync(resolve(process.cwd(), '../.github/ISSUE_TEMPLATE', file), 'utf8')) as { body: { id?: string; type: string }[] }
    const field = form.body.find((item) => item.id === DETAILS_FIELD)
    expect(field?.type).toBe('textarea')
  })
})
