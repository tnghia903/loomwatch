/**
 * The landing page's live figures (site/): the app's own 3D figure code, built for the page by
 * vite.site.config.ts into site's assets/live/live.js, which the page imports when it can draw
 * WebGL. The page keeps still pictures underneath for when it can't.
 *
 * - CrewScene: six figures on the first screen, holding one thread, looking where you point. Given
 *   a script (crewTalk.ts), they pass a job along the thread to each other, and then to you.
 * - CordScene: one more of them, hanging on the theme button's pull cord.
 * - bench(): the agent's bench from Build by hand (WorkbenchScene), driven by the page's agent
 *   builder, and placeFace, which lays the words on its nameplate, job sheet and laptop lid over
 *   them as text. The page draws it further down, so its code is a module of its own, which this
 *   loads when the page asks for it: the first screen doesn't wait to download it.
 * - readModel: each scene's load() takes the model's bytes as well as its URL, so the page fetches
 *   workbench.glb once, alongside this module, for all three.
 */
export { CrewScene, type CrewMember } from './crewScene'
export { CordScene } from './cordScene'
export { readModel } from '../components/agents/workbenchModel'
export const bench = () => import('../components/agents/workbenchScene')
export type { BenchView } from '../components/agents/workbenchScene'
export { markPattern } from '../lib/story/mark'
