import { createContext, type ReactNode } from 'react'

/**
 * A person's own words in the chat, as the Markdown renderer marks them (MarkdownRenderer's `said`):
 * where their @mentions are, and how each is drawn. Its own small module, so the chat can give it
 * without loading the renderer, which is downloaded on its own (markdownCode.ts).
 */

/**
 * Where the @mentions are in some of a person's words: each one's place, its agent if any, and the
 * words around it a line never breaks from (`from`..`until`: a bracket before it, "’s" after it).
 */
export interface SaidMarks {
  find: (text: string) => readonly { start: number; end: number; agent?: string; from?: number; until?: number }[]
}

/** How a mention in a person's words is drawn: given the agent (none for @team) and its words. */
export const SaidMention = createContext<((agent: string | undefined, text: string) => ReactNode) | null>(null)
