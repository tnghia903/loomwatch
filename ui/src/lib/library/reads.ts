import { notionPageKey } from '../composer-layout/types'
import type { CapabilityRef, NotionPageRef } from '../team-file/types'

/**
 * A folder, file or Notion page one of Your agents reads (backend `jobs::JobRead`): what a team
 * file's knowledge entry holds (ADR 0035, 0050). A folder or file is named by its full path, so
 * every team it joins reads the same one; a file added in Your agents is kept in `.jobs/.files/`.
 */
export interface AgentRead {
  name: string
  path?: string
  notion?: NotionPageRef
}

/** What it reads as a team agent's knowledge entries: what placing it, or its chat, writes. */
export function knowledgeOf(reads: readonly AgentRead[]): CapabilityRef[] {
  return reads.map((read) => ({ kind: 'knowledge' as const, name: read.name, ...(read.notion ? { notion: { page: read.notion.page } } : { path: read.path }) }))
}

/** Which folder, file or page a read or knowledge entry names, whatever it is labelled. */
export function readKey(read: Pick<CapabilityRef, 'path' | 'notion'>): string {
  return read.notion ? `notion:${notionPageKey(read.notion.page)}` : `path:${read.path ?? ''}`
}
