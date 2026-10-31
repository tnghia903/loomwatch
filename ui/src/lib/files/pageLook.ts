/**
 * The reader's own colours, for what is drawn around the paper of a deck or a Word document
 * LoomWatch draws (`drawnPage.ts`): the ground the slides or pages lie on, and the words beside
 * them. The frame they are drawn in can't read the app's styles.
 */
export interface PageLook {
  ground: string
  ink: string
  label: string
}

/** The light theme's ground and words (tokens.css), where the reader's own can't be read. */
export const PAPER_LOOK: PageLook = { ground: '#FAF8F3', ink: '#17150F', label: '#56524A' }
/** The dark theme's, likewise. */
export const DARK_LOOK: PageLook = { ground: '#08080A', ink: '#F5F3EE', label: '#A9A59C' }

/** The look given, each colour a colour or else `fallback`'s. */
export function lookOf(look: Partial<PageLook> | null | undefined, fallback: PageLook = PAPER_LOOK): PageLook {
  const pick = (key: keyof PageLook) => cssColour(look?.[key]) || fallback[key]
  return { ground: pick('ground'), ink: pick('ink'), label: pick('label') }
}

/** A colour as the app's styles write one, if it is one: never anything else in a style. */
function cssColour(value: string | null | undefined): string {
  const text = String(value ?? '').trim()
  return /^#[0-9a-f]{3,8}$/i.test(text) || /^(?:rgba?|hsla?|oklch|oklab|lab|lch)\([\d.,\s%/a-z-]+\)$/i.test(text) ? text : ''
}
