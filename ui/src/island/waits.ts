/**
 * How long each moment stays out below the notch before the island tucks away (ADR 0083), in
 * milliseconds. One place, so they can be tuned once people have tried the island.
 */
export const ISLAND_WAITS = {
  /** A team starts, or hands its work to the next agent. */
  start: 4_000,
  /** A question, a permission, a review or a spend stop. */
  ask: 10_000,
  /** A finished or stopped run's result. */
  result: 6_000,
  /** After the pointer leaves something that was held out. */
  afterPointer: 1_500,
  /** A click elsewhere this soon after something pops out does not tuck it away: the click was
      already on its way, not an answer to it. */
  clickGrace: 1_500,
  /** Between one pop-out tucking away and the next dropping. */
  between: 600,
  /** How often a waiting question's figure bounces while the island is tucked away. */
  nudge: 5 * 60_000,
  /** How long an answer's "Allowed once." shows before its card goes. */
  said: 1_200,
  /** How long the list stays open after the pointer leaves it. */
  closeList: 700,
  /** How often the island reads what the teams are doing. */
  poll: 2_000,
} as const
