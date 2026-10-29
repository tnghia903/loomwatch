/**
 * Sent on `window` when Rename moves a team's file (ADR 0099), so what this browser keeps by the
 * team's path, such as the suggestions hidden for it, follows it to the new one.
 */
export const TEAM_MOVED = 'loomwatch:team-moved'

export interface TeamMoved {
  from: string
  to: string
}
