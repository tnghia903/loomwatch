import type { AutoRan } from './events'

/**
 * What Auto mode let the agents do in your place while a piece of work runs (ADR 0061, ADR 0109),
 * in one line: the latest thing, and how many. Said once rather than once per command.
 */
export function autoLine(autoRan: readonly AutoRan[], name: (id: string) => string): string | null {
  const last = autoRan.at(-1)
  if (!last) return null
  const what = last.detail ?? last.title
  if (autoRan.length === 1) return `Auto mode let ${name(last.agentId)} ${last.kind === 'edit' ? 'change' : 'run'} ${what}`
  const edits = autoRan.filter((ran) => ran.kind === 'edit').length
  const done = edits === 0 ? `ran ${autoRan.length} commands`
    : edits === autoRan.length ? `let ${autoRan.length} files change`
      : `went ahead ${autoRan.length} times`
  return `Auto mode ${done} without asking you · latest ${what}`
}
