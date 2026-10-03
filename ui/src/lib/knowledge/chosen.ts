// ADR 0035: how a knowledge entry the operator chose reads in the Context list.

import { CircleAlert, FileText, Folder, type LucideIcon } from 'lucide-react'

import type { CapabilityRef } from '../team-file/types'

/**
 * How a knowledge entry reads in the list. Only an added file is written relative to the team
 * file; a linked folder is always a full path, and a full path with an extension is a file someone
 * linked by hand. Knowledge with no path names nothing the daemon can read (ADR 0036), so it says
 * so here rather than failing the run unannounced. `null` for a skill or tool, which keeps its
 * kind's own label.
 */
export function chosenKnowledge(capability: CapabilityRef): { Icon: LucideIcon; label: string } | null {
  if (capability.kind !== 'knowledge') return null
  if (!capability.path) return { Icon: CircleAlert, label: 'No folder or file · disconnect it and add one below' }
  return chosenIsFile(capability.path)
    ? { Icon: FileText, label: 'Added file · read only · its text is supplied' }
    : { Icon: Folder, label: 'Linked folder · read only · its files may be opened' }
}

/** Whether a chosen path is a file rather than a folder, by the rule {@link chosenKnowledge} states. */
export function chosenIsFile(path: string): boolean {
  const relative = !path.startsWith('/') && !path.startsWith('~')
  return relative || /\.[A-Za-z0-9]{1,8}$/.test(path.split('/').pop() ?? '')
}

/** What a folder or file card says it is, under its name (ADR 0042). */
export function chosenSource(path: string): 'Added file' | 'Linked folder' {
  return chosenIsFile(path) ? 'Added file' : 'Linked folder'
}

/** The name a folder or file card shows: the last part of its path. */
export function chosenName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path
}
