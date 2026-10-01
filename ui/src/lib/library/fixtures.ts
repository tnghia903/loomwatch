import type { LibrarySource } from './types'

// Only show configured sources. Mock models and adapters are not runnable presets.
export const ENDPOINT_SOURCES: readonly LibrarySource[] = []
export const OPERATOR_SOURCE: LibrarySource = { group: 'presets', kind: 'operator', id: 'you', label: 'You', role: 'Review the work and say what should happen next.', spawn: { cmd: '', args: [] } }
export const PRESET_SOURCES: readonly LibrarySource[] = []
