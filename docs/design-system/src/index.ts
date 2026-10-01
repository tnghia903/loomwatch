// The React half of LoomWatch's design system, as shipped to Claude Design by /design-sync.
// These are the app's own standalone components, re-exported unchanged from ui/src. Everything
// else in the system is the CSS kit (tokens.css + components.css), applied by class name.
// App components that need React Flow or live run state (canvas cards, composer, inspector)
// are deliberately not here; components.css carries their look as classes instead.
export { AgentMark } from '../../../ui/src/components/ui/AgentMark'
export { ChipDot, CoverageGlyph, EntityGlyph, LoomMark, StatusGlyph } from '../../../ui/src/components/ui/glyphs'
