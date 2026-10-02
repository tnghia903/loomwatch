// ADR 0035: how a knowledge entry the operator chose reads in the Context list.

import { FileText, Folder, type LucideIcon } from 'lucide-react'

import type { CapabilityRef } from '../team-file/types'

/**
 * How a knowledge entry with a `path` reads in the list. Only an added file is written relative to
 * the team file; a linked folder is always a full path, and a full path with an extension is a
 * file someone linked by hand. `null` for anything else, which keeps its kind's own label.
 */
export function chosenKnowledge(capability: CapabilityRef): { Icon: LucideIcon; label: string } | null {
  if (capability.kind !== 'knowledge' || !capability.path) return null
  const relative = !capability.path.startsWith('/') && !capability.path.startsWith('~')
  const file = relative || /\.[A-Za-z0-9]{1,8}$/.test(capability.path.split('/').pop() ?? '')
  return file
    ? { Icon: FileText, label: 'Added file · its text is supplied' }
    : { Icon: Folder, label: 'Linked folder · its files may be opened' }
}
