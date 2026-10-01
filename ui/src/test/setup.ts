import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'
import { webcrypto } from 'node:crypto'

// jsdom implements Crypto but not SubtleCrypto; production browsers provide it on secure
// origins (including localhost), so tests use Node's standards-compatible implementation.
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })

// Markdown is code-split in the app (components/ui/Markdown.tsx). Tests render the real renderer
// synchronously so assertions about formatted output need no Suspense round trip.
vi.mock('../components/ui/Markdown', async () => {
  const renderer = await import('../components/ui/MarkdownRenderer')
  return { Markdown: renderer.default }
})
