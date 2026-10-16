import { useCallback, useEffect, useState } from 'react'

import { daemonFetch } from '../daemonFetch'
import { servesHtml } from '../library/client'
import { AREAS, isQuestItem, QUESTS, type QuestArea, type QuestItem } from './catalog'

/** One item in the wardrobe (crates/loomwatch-backend/src/wardrobe.rs): when, and the run that earned it. */
export interface EarnedItem {
  at: string
  runId: string
  teamPath?: string
  agentId?: string
}

export type Wardrobe = Partial<Record<QuestItem, EarnedItem>>

/** Fired after an item is earned, so every view of the wardrobe shows it. */
export const WARDROBE_CHANGED_EVENT = 'loomwatch:wardrobe-changed'

function parse(body: unknown): Wardrobe {
  const earned = body && typeof body === 'object' ? (body as { earned?: unknown }).earned : null
  if (!earned || typeof earned !== 'object') return {}
  const out: Wardrobe = {}
  for (const [item, entry] of Object.entries(earned as Record<string, unknown>)) {
    if (!isQuestItem(item) || !entry || typeof entry !== 'object') continue
    const { at, runId, teamPath, agentId } = entry as Record<string, unknown>
    if (typeof at !== 'string' || typeof runId !== 'string') continue
    out[item] = { at, runId, ...(typeof teamPath === 'string' ? { teamPath } : {}), ...(typeof agentId === 'string' ? { agentId } : {}) }
  }
  return out
}

/** What has been earned, or `null` when this daemon predates the wardrobe. */
export async function fetchWardrobe(signal?: AbortSignal): Promise<Wardrobe | null> {
  const response = await daemonFetch('/api/wardrobe', { cache: 'no-store', signal })
  if (response.status === 404 || servesHtml(response)) return null
  if (!response.ok) throw new Error(`The wardrobe could not be read (${response.status}).`)
  return parse(await response.json())
}

/**
 * Put `item` in the wardrobe for the run that earned it. The daemon keeps the first run to earn an
 * item, so this answers with the entry it holds: this run's when it is new, an earlier run's when not.
 */
export async function earnItem(item: QuestItem, earned: { runId: string; teamPath?: string | null; agentId?: string | null }): Promise<EarnedItem | null> {
  const response = await daemonFetch('/api/wardrobe/earned', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ item, runId: earned.runId, teamPath: earned.teamPath ?? null, agentId: earned.agentId ?? null }),
  })
  if (response.status === 404 || servesHtml(response)) return null
  if (!response.ok) throw new Error(`The wardrobe could not be saved (${response.status}).`)
  const entry = parse({ earned: { [item]: await response.json() } })[item] ?? null
  if (response.status === 201) window.dispatchEvent(new Event(WARDROBE_CHANGED_EVENT))
  return entry
}

export interface WardrobeState {
  wardrobe: Wardrobe
  /** False until the first answer, and while the daemon has no wardrobe. */
  loaded: boolean
}

const EMPTY: Wardrobe = {}

/** The wardrobe, read again whenever an item is earned anywhere on the page. */
export function useWardrobe(): WardrobeState {
  const [state, setState] = useState<WardrobeState>({ wardrobe: EMPTY, loaded: false })
  const [generation, setGeneration] = useState(0)
  const reload = useCallback(() => setGeneration((value) => value + 1), [])
  useEffect(() => {
    const controller = new AbortController()
    fetchWardrobe(controller.signal).then(
      (wardrobe) => { if (!controller.signal.aborted) setState({ wardrobe: wardrobe ?? EMPTY, loaded: wardrobe !== null }) },
      () => { /* an unreachable daemon keeps what was read */ },
    )
    return () => controller.abort()
  }, [generation])
  useEffect(() => {
    window.addEventListener(WARDROBE_CHANGED_EVENT, reload)
    return () => window.removeEventListener(WARDROBE_CHANGED_EVENT, reload)
  }, [reload])
  return state
}

export function hasEarned(wardrobe: Wardrobe, item: string): boolean {
  return isQuestItem(item) && Boolean(wardrobe[item])
}

/** The parts the wardrobe holds an item from: Bobbin is earned once it holds all five. */
export function partsDone(wardrobe: Wardrobe): Set<QuestArea> {
  return new Set(AREAS.filter((area) => QUESTS.some((quest) => quest.area === area && wardrobe[quest.item])))
}
