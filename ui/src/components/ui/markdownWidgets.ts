import { createContext, type ReactNode } from 'react'

import type { WidgetPlace } from '../../lib/widgets/inMarkdown'

/**
 * The widgets a long answer's Markdown holds (ADR 0114), each at the line its words placed it
 * (MarkdownRenderer puts them in). Apart from how each is drawn, so drawing one again (a tick kept)
 * never reads the words again. Its own small module, so a screen can give them without loading the
 * renderer (markdownCode.ts).
 */
export const MarkdownWidgetPlaces = createContext<readonly WidgetPlace[] | null>(null)

/** Draws widget `n` where MarkdownRenderer put it. */
export const MarkdownWidgetDraw = createContext<((n: number) => ReactNode) | null>(null)
