import { describe, expect, it } from 'vitest'

import { absoluteTeamPath, slugifyTeamName } from '../team-file/useTeamDocument'
import { buildAgentFromSource } from '../library/createAgent'
import { jobIdFor } from '../library/jobs'
import { briefFileNameFor } from '../memory/client'
import { teamPathUnderRoot } from '../team-file/client'
import { chosenIsFile, chosenName } from '../knowledge/chosen'
import { teamFolderOf } from '../team-file/workFolder'
import { shortenDirectory } from '../team-file/problems'
import { filePathFrom } from './fileRefs'
import { baseName, dirName, isAbsolutePath, joinUnderRoot, linkedPath, pathFromFileUrl, relativeUnder, safeFileStem } from './paths'

// The daemon sends `C:\Users\ana\…` on Windows. Every helper that reads a path must read it as the
// same file a Mac path names, or a team saved on Windows reloads from the wrong place.
describe('paths from a Mac and from Windows', () => {
  const macRoot = '/Users/ana/LoomWatch/teams'
  const windowsRoot = 'C:\\Users\\ana\\LoomWatch\\teams'

  it('knows a full path in every spelling', () => {
    for (const path of ['/Users/ana', 'C:\\Users\\ana', 'C:/Users/ana', '\\\\server\\share']) expect(isAbsolutePath(path)).toBe(true)
    for (const path of ['teams/a.yaml', 'a.yaml', '.\\a.yaml', '~/x', 'C:relative']) expect(isAbsolutePath(path)).toBe(false)
  })

  it('names the file and its folder either way', () => {
    expect(baseName('C:\\Users\\ana\\teams\\trip.yaml')).toBe('trip.yaml')
    expect(baseName('/Users/ana/teams/trip.yaml')).toBe('trip.yaml')
    expect(dirName('C:\\Users\\ana\\teams\\trip.yaml')).toBe('C:\\Users\\ana\\teams')
    expect(dirName('/Users/ana/teams/trip.yaml')).toBe('/Users/ana/teams')
    expect(dirName('C:\\trip.yaml')).toBe('C:\\')
    expect(dirName('/trip.yaml')).toBe('/')
  })

  it('puts a team under its root with the root’s own separator, and finds it there again', () => {
    expect(joinUnderRoot(macRoot, 'sub/a.yaml')).toBe('/Users/ana/LoomWatch/teams/sub/a.yaml')
    expect(joinUnderRoot(windowsRoot, 'sub/a.yaml')).toBe('C:\\Users\\ana\\LoomWatch\\teams\\sub\\a.yaml')
    expect(relativeUnder(windowsRoot, 'c:\\users\\ana\\LoomWatch\\teams\\sub\\a.yaml')).toBe('sub/a.yaml')
    expect(relativeUnder(macRoot, '/Users/ana/LoomWatch/teams/sub/a.yaml')).toBe('sub/a.yaml')
    expect(relativeUnder(macRoot, '/users/ana/LoomWatch/teams/a.yaml')).toBeNull()
    expect(relativeUnder(windowsRoot, 'D:\\teams\\a.yaml')).toBeNull()
  })

  it('reloads a Windows team from the path it was saved under, not that path joined to the root again', () => {
    const saved = absoluteTeamPath(windowsRoot, 'sub/a.yaml')
    expect(saved).toBe('C:\\Users\\ana\\LoomWatch\\teams\\sub\\a.yaml')
    expect(absoluteTeamPath(windowsRoot, saved)).toBe(saved)
    expect(absoluteTeamPath(macRoot, 'sub/a.yaml')).toBe('/Users/ana/LoomWatch/teams/sub/a.yaml')
    expect(teamPathUnderRoot(windowsRoot, saved)).toBe('sub/a.yaml')
    expect(teamPathUnderRoot(windowsRoot, 'D:\\elsewhere\\a.yaml')).toBeNull()
  })

  it('reads a linked Windows folder as a folder, named by its last part', () => {
    expect(chosenIsFile('C:\\Users\\ana\\Documents\\Plans')).toBe(false)
    expect(chosenIsFile('C:\\Users\\ana\\Documents\\plan.pdf')).toBe(true)
    expect(chosenIsFile('trip.files/plan.pdf')).toBe(true)
    expect(chosenName('C:\\Users\\ana\\Documents\\Plans\\')).toBe('Plans')
    expect(teamFolderOf('C:\\Users\\ana\\LoomWatch\\teams\\trip.yaml')).toBe('C:\\Users\\ana\\LoomWatch\\teams')
    expect(teamFolderOf('/Users/ana/LoomWatch/teams/trip.yaml')).toBe('/Users/ana/LoomWatch/teams')
  })

  it('opens a file a Windows app names as a file URL or with forward slashes', () => {
    expect(pathFromFileUrl('file:///C:/Users/ana/report%20final.md')).toBe('C:\\Users\\ana\\report final.md')
    expect(pathFromFileUrl('file:///Users/ana/report.md')).toBe('/Users/ana/report.md')
    expect(filePathFrom('file:///C:/Users/ana/report.md')).toBe('C:\\Users\\ana\\report.md')
    expect(filePathFrom('C:/Users/ana/report.md')).toBe('C:/Users/ana/report.md')
  })

  it('finds the picture a report links to beside it, written either way', () => {
    expect(linkedPath('/Users/ana/out/reports/report.md', 'figures/revenue.svg')).toBe('/Users/ana/out/reports/figures/revenue.svg')
    expect(linkedPath('/Users/ana/out/reports/report.md', './figures/my%20chart.png?v=2#top')).toBe('/Users/ana/out/reports/figures/my chart.png')
    expect(linkedPath('/Users/ana/out/reports/report.md', '../shared/../logo.png')).toBe('/Users/ana/out/logo.png')
    expect(linkedPath('C:\\Users\\ana\\out\\report.md', 'figures/revenue.svg')).toBe('C:\\Users\\ana\\out\\figures\\revenue.svg')
    expect(linkedPath('C:\\Users\\ana\\out\\report.md', '..\\logo.png')).toBe('C:\\Users\\ana\\logo.png')
    expect(linkedPath('\\\\server\\share\\report.md', 'chart.png')).toBe('\\\\server\\share\\chart.png')
    expect(linkedPath('reports/report.md', 'figures/revenue.svg')).toBe('reports/figures/revenue.svg')
    // A full path or a file URL names its file wherever the report is.
    expect(linkedPath('/Users/ana/out/report.md', '/Users/ana/charts/a.png')).toBe('/Users/ana/charts/a.png')
    expect(linkedPath('C:\\Users\\ana\\out\\report.md', 'C:/Users/ana/charts/a.png')).toBe('C:/Users/ana/charts/a.png')
    expect(linkedPath('/Users/ana/out/report.md', 'file:///C:/Users/ana/a%20b.png')).toBe('C:\\Users\\ana\\a b.png')
  })

  it('finds no file for a link to the web, to data, to a place in the report, or above the disk', () => {
    for (const link of ['https://example.com/pixel.png', 'HTTP://example.com/a.png', '//example.com/a.png', 'data:image/png;base64,AAAA', 'javascript:alert(1)', '#figure-1', '', '  '])
      expect(linkedPath('/Users/ana/out/report.md', link)).toBeNull()
    expect(linkedPath('/out/report.md', '../../a.png')).toBeNull()
    expect(linkedPath('C:\\out\\report.md', '..\\..\\a.png')).toBeNull()
    expect(linkedPath('\\\\server\\share\\report.md', '../a.png')).toBeNull()
  })

  it('shortens a Windows home folder to ~ as it does a Mac one', () => {
    expect(shortenDirectory('C:\\Users\\ana\\LoomWatch\\teams')).toBe('~\\LoomWatch\\teams')
    expect(shortenDirectory('/Users/ana/LoomWatch/teams')).toBe('~/LoomWatch/teams')
    expect(shortenDirectory('C:\\Users\\ana\\Developer\\clients\\northwind\\automation\\teams')).toBe('~\\…\\automation\\teams')
  })

  // Windows keeps CON, NUL, COM1 and the like for its devices: `con.yaml` cannot be saved there.
  it('never names a file after one of the names Windows keeps for itself', () => {
    for (const name of ['con', 'PRN', 'aux', 'Nul', 'com1', 'COM9', 'lpt1', 'lpt9']) expect(safeFileStem(name)).toBe(`${name}-1`)
    for (const name of ['console', 'com', 'com10', 'lpt0', 'nul-team', 'icon']) expect(safeFileStem(name)).toBe(name)
    expect(slugifyTeamName('Con')).toBe('con-1')
    expect(jobIdFor('NUL')).toBe('nul-1')
    expect(buildAgentFromSource({ group: 'agents', id: 'x', label: 'Aux' }, []).id).toBe('aux-1')
    expect(briefFileNameFor('# COM1\nSerial port notes', [], 'trip.brief')).toBe('trip.brief/com1-1.md')
  })

  it('keeps a team’s file name as short as a job’s', () => {
    const slug = slugifyTeamName(`${'very '.repeat(20)}long team`)
    expect(slug.length).toBeLessThanOrEqual(64)
    expect(slug).toMatch(/^very-very-.*[a-z]$/)
  })
})
