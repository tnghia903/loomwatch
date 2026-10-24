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
  /** How long "Sent to <agent>." shows under the message box. */
  sent: 2_500,
  /** How long the words of a sent message are drawn folding into their agent's head: a little longer
      than `island-fold` takes (`--t-spring`, island.css), by which time they are gone. */
  fold: 600,
  /** How long the pointer rests on the pill before its agent's workbench opens: passing over it on
      the way to something else opens nothing. */
  peek: 320,
  /** After a message goes, how long its agent's workbench shows before it tucks away. */
  bench: 3_000,
  /** How long the list stays open after the pointer leaves it. */
  closeList: 700,
  /** After a drag near the island is let go of elsewhere, how long the slot waits for its drop. */
  dropSettle: 1_500,
  /** How often the island reads what the teams are doing. */
  poll: 2_000,
} as const
