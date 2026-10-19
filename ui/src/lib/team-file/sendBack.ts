// A check step's `sendBack` (ADR 0062), as the editor reads and writes it. Its own module so the
// check step's setup and the checkup can both use it without importing each other.

import type { AgentConfig, SendBack } from './types'

/** How many times a check step may send the work back, and what it does after. */
export interface SendBackSetting {
  rounds: 1 | 2 | 3
  whenStillNotMet: 'answer' | 'ask'
}

/** The most rounds a check step may send the work back for: each one helps less than the last. */
export const SEND_BACK_ROUNDS = [1, 2, 3] as const

/**
 * What a new check step is set to (the daemon's `SendBack::NEW`, which Ask's teams get too): the
 * work goes back up to twice, then the person decides, rather than see work that missed its checks.
 */
export const NEW_SEND_BACK: SendBackSetting = { rounds: 2, whenStillNotMet: 'ask' }

/** A check step's send-back as the daemon reads it, `sendBackOnce: true` as one round; `null`: off. */
export function sendBackOf(agent: Pick<AgentConfig, 'sendBack' | 'sendBackOnce'>): SendBackSetting | null {
  if (agent.sendBack) {
    const rounds = Math.min(3, Math.max(1, Math.round(agent.sendBack.rounds ?? 1))) as SendBackSetting['rounds']
    return { rounds, whenStillNotMet: agent.sendBack.whenStillNotMet === 'ask' ? 'ask' : 'answer' }
  }
  return agent.sendBackOnce ? { rounds: 1, whenStillNotMet: 'answer' } : null
}

/** The fields that write `setting`: `sendBack`, with the older `sendBackOnce` taken out. */
export function sendBackFields(setting: SendBackSetting | null): Pick<AgentConfig, 'sendBack' | 'sendBackOnce'> {
  const sendBack: SendBack | undefined = setting ? { rounds: setting.rounds, whenStillNotMet: setting.whenStillNotMet } : undefined
  return { sendBack, sendBackOnce: undefined }
}
