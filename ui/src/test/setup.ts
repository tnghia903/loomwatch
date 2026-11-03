import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import { webcrypto } from 'node:crypto'

// `waitFor` and `findBy…` give up after a second by default. Loading a team document (parsing it and
// compiling the schema) takes longer than that on a busy machine or a slow CI runner, and a test
// failed for no reason but load. Waiting longer costs nothing when the thing arrives in time.
configure({ asyncUtilTimeout: 4000 })

// Testing Library unmounts what a test rendered only when Vitest's globals are on, and they aren't.
// A file that forgot left its components mounted, and their timers and fetches ran on past the
// file: one landing after jsdom was gone failed CI with "window is not defined".
afterEach(cleanup)

// jsdom implements Crypto but not SubtleCrypto; production browsers provide it on secure
// origins (including localhost), so tests use Node's standards-compatible implementation.
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })

// Markdown is code-split in the app (components/ui/Markdown.tsx). Tests render the real renderer
// synchronously so assertions about formatted output need no Suspense round trip.
vi.mock('../components/ui/Markdown', async () => {
  const { createElement } = await import('react')
  const { default: Renderer } = await import('../components/ui/MarkdownRenderer')
  return {
    Markdown: Renderer,
    InlineMarkdown: (props: { children: string; clickable?: boolean }) => createElement('span', { className: 'md-inline' }, createElement(Renderer, { ...props, inline: true })),
  }
})
