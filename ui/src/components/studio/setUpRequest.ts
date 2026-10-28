import type { ProjectStart } from './SetUpProject'

/**
 * What Set up project asks of Ask (ADR 0097): set up a project from the person's words, with the
 * folder they chose, and show the team before anything runs. Ask's rules read the first line.
 */
export function setUpRequest(start: ProjectStart): string {
  const folder = start.folder ? `\n\nIts files are in this folder: ${start.folder.path}` : ''
  return `Set up a project for this: ${start.words}${folder}`
}
