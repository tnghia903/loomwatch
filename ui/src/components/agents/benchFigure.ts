import { preloadable } from '../../lib/preloadable'

/**
 * The bench (AgentFigure), which brings three.js with it: its own download, fetched as soon as an
 * agent's page opens (main.tsx), so it is in by the time the page draws it.
 */
export const AgentFigure = preloadable(() => import('./AgentFigure').then((module) => module.default))
