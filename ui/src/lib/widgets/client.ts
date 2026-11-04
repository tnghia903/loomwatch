import { daemonFetch } from '../daemonFetch'
import { readRun } from '../runs/client'
import type { KeptWidget, WidgetState } from './types'

/**
 * Keep what you made of widget `n` under run `runId`'s answer (ADR 0114): a checklist's ticks or a
 * calculator's values. The next work's conversation says what changed. Answers with the widget as
 * kept.
 */
export async function changeWidget(teamPath: string, runId: string, n: number, state: WidgetState): Promise<KeptWidget> {
  const response = await daemonFetch('/api/chat/widgets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamPath, runId, n, state }),
    cache: 'no-store',
  })
  return readRun<KeptWidget>(response)
}
