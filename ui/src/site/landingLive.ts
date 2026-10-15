/**
 * The landing page's live figures (site/): the app's own 3D figure code, built for the page by
 * vite.site.config.ts into site's assets/live/live.js, which the page imports when it can draw
 * WebGL. The page keeps still pictures underneath for when it can't.
 *
 * - CrewScene: six figures on the first screen, holding one thread, looking where you point.
 * - CordScene: one more of them, hanging on the theme button's pull cord.
 * - WorkbenchScene: the agent's bench from Build by hand, driven by the page's agent builder, and
 *   placeFace, which lays the words on its nameplate, job sheet and laptop lid over them as text.
 */
export { CrewScene, type CrewMember } from './crewScene'
export { CordScene } from './cordScene'
export { placeFace, WorkbenchScene, type BenchView } from '../components/agents/workbenchScene'
export { markPattern } from '../lib/story/mark'
