import '@testing-library/jest-dom/vitest'
import { webcrypto } from 'node:crypto'

// jsdom implements Crypto but not SubtleCrypto; production browsers provide it on secure
// origins (including localhost), so tests use Node's standards-compatible implementation.
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
