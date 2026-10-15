/**
 * The landing page's live figures (site/): the app's own 3D figure code, built for the page by
 * vite.site.config.ts into site's assets/live/live.js, which the page imports when it can draw
 * WebGL. The page keeps still pictures underneath for when it can't.
 *
 * - CrewScene: six figures on the first screen, holding one thread, looking where you point.
 * - WorkbenchScene: the agent's bench from Build by hand, driven by the page's agent builder.
 */
export { CrewScene, type CrewMember } from './crewScene'
export { WorkbenchScene, type BenchView } from '../components/agents/workbenchScene'
export { markPattern } from '../lib/story/mark'
