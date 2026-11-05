import { daemonFetch } from '../daemonFetch'
import { readRun } from '../runs/client'
import type { KeptWidget, WidgetState } from './types'

/**
 * Keep what you made of widget `n` under run `runId`'s answer (ADR 0114): a checklist's ticks or a
 * calculator's values. The next work's conversation says what changed. Answers with the widget as
 * kept.
 */
export async function changeWidget(teamPath: string, runId: string, n: number, state: WidgetState): Promise<KeptWidget> {
  return keep({ teamPath, runId, n, state })
}

/** The same for widget `n` in `agent`'s answer to message `messageId` in the chat, answered there
    without starting work. */
export async function changeNoteWidget(teamPath: string, messageId: string, agent: string, n: number, state: WidgetState): Promise<KeptWidget> {
  return keep({ teamPath, note: { messageId, agent }, n, state })
}

async function keep(body: object): Promise<KeptWidget> {
  const response = await daemonFetch('/api/chat/widgets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  return readRun<KeptWidget>(response)
}
