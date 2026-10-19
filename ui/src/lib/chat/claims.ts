/**
 * The marks writers put before a claim — "[Sourced] …", "[Inference] …" — in two kinds: backed by a
 * source, or the writer's own reasoning. Only these words: a paragraph opening with "[Your name]" is
 * a placeholder, not a mark. The answer shows a mark as a small tag (MarkdownRenderer) and a card's
 * preview leaves it out (document.ts); neither shows it as bracketed text.
 */
export const BACKED = ['sourced', 'cited', 'verified', 'confirmed', 'fact']
export const REASONED = ['inference', 'inferred', 'assumption', 'assumed', 'estimate', 'estimated', 'speculation', 'hypothesis', 'opinion', 'unverified']
export const CLAIM_MARK = new RegExp(`^\\s*\\[\\s*(${[...BACKED, ...REASONED].join('|')})\\s*\\]\\s*`, 'i')
