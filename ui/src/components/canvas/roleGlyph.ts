import {
  Circle,
  Compass,
  FlaskConical,
  Hammer,
  PenLine,
  ScanEye,
  Shapes,
  Telescope,
  type IconComponent,
} from '../ui/icon'

// docs/CANVAS_SPEC.md §2.6: "a fixed icon map keyed by a lowercase substring of Agent.role,
// with Circle as the fallback." Order matters — first match wins.
const ROLE_GLYPHS: readonly [substring: string, icon: IconComponent][] = [
  ['research', Telescope],
  ['review', ScanEye],
  ['write', PenLine],
  ['author', PenLine],
  ['test', FlaskConical],
  ['qa', FlaskConical],
  ['build', Hammer],
  ['engineer', Hammer],
  ['plan', Compass],
  ['lead', Compass],
  ['design', Shapes],
]

export function roleGlyph(role: string): IconComponent {
  const lower = role.toLowerCase()
  return ROLE_GLYPHS.find(([substring]) => lower.includes(substring))?.[1] ?? Circle
}
