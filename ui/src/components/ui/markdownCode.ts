import { preloadable } from '../../lib/preloadable'

/**
 * The Markdown renderer (MarkdownRenderer.tsx), the largest code the app has: its own download,
 * fetched once the app has drawn (main.tsx), so an answer shows formatted at once.
 */
export const MarkdownRenderer = preloadable(() => import('./MarkdownRenderer').then((module) => module.default))

/** The same download's Markdown drawn to be typed into (ADR 0107). */
export const EditableMarkdownRenderer = preloadable(() => import('./MarkdownRenderer').then((module) => module.EditableMarkdown))
