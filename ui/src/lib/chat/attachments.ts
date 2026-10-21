import { useCallback, useEffect, useRef, useState } from 'react'

import { uniqueLabel } from '../composer-layout/types'
import type { AgentConfig, CapabilityRef } from '../team-file/types'
import { uploadChatFile, type ChatFile } from './client'

/**
 * Pictures and files pasted or dropped into a team's chat (ADR 0082). Each one is kept beside the
 * team the moment it is added, while the words are still being typed, so Send never waits on it;
 * the message then names what was kept.
 */

/** The most files one message carries, as the daemon holds it to (`chat_files::MAX_FILES`). */
export const MAX_CHAT_FILES = 10
/** The largest file kept, as the daemon holds it to (`chosen_knowledge::MAX_FILE_BYTES`). */
export const MAX_CHAT_FILE_BYTES = 25 * 1024 * 1024

/** A file in the box, on its way to being kept or kept. */
export interface Attachment {
  id: string
  name: string
  picture: boolean
  /** A picture's preview, from the file itself: no request. Let go with the attachment. */
  preview: string | null
  state: 'uploading' | 'ready' | 'failed'
  /** What the daemon kept, once it has. */
  kept: ChatFile | null
  /** Why it can't be sent, in a few words. */
  problem: string | null
  /** What the daemon said, when it refused it: shown on hover, not on the chip. */
  detail?: string
}

const PICTURE = /\.(png|jpe?g|gif|webp)$/i

/** Whether the box shows `name` as a picture: the kinds every model that sees pictures takes. */
export const isPicture = (name: string) => PICTURE.test(name)

/**
 * The name a pasted file is kept under. A screenshot pasted from the clipboard comes as
 * `image.png` every time, which would be numbered `image (2).png`, `image (3).png`…; it is named
 * for when it was pasted instead. A file copied in Finder keeps its own name.
 */
export function pastedName(file: File, now = new Date()): string {
  if (file.name && !/^image\.\w+$/i.test(file.name)) return file.name
  const extension = /\.(\w+)$/.exec(file.name)?.[1] ?? file.type.split('/')[1] ?? 'png'
  const two = (value: number) => String(value).padStart(2, '0')
  return `Pasted ${two(now.getHours())}.${two(now.getMinutes())}.${two(now.getSeconds())}.${extension}`
}

/** What a drop holds: the files, and the folders by name. Read during the drop, while it can be. */
export function dropped(transfer: DataTransfer): { files: File[]; folders: string[] } {
  const folders: string[] = []
  const files: File[] = []
  const items = Array.from(transfer.items ?? [])
  if (items.length === 0) return { files: Array.from(transfer.files ?? []), folders }
  for (const item of items) {
    if (item.kind !== 'file') continue
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null
    if (entry?.isDirectory) {
      folders.push(entry.name)
      continue
    }
    const file = item.getAsFile()
    if (file) files.push(file)
  }
  return { files, folders }
}

/** Whether a drag carries files from outside the page, rather than something dragged inside it. */
export const carriesFiles = (transfer: DataTransfer | null) => Boolean(transfer && Array.from(transfer.types).includes('Files'))

/**
 * A folder dropped on the chat, once found in the folder picker, as a source for every agent of
 * the team (ADR 0082): each agent's capabilities with the folder added, for the agents that don't
 * have it yet. Review steps are you, and read nothing.
 */
export function withFolderSource(agents: readonly Pick<AgentConfig, 'id' | 'kind' | 'capabilities'>[], folder: { name: string; path: string }): Array<{ id: string; capabilities: CapabilityRef[] }> {
  return agents.flatMap((agent) => {
    const current = agent.capabilities ?? []
    if (agent.kind === 'operator' || current.some((capability) => capability.kind === 'knowledge' && capability.path === folder.path)) return []
    const taken = new Set(current.map((capability) => capability.name))
    return [{ id: agent.id, capabilities: [...current, { kind: 'knowledge' as const, name: uniqueLabel(folder.name, taken), path: folder.path }] }]
  })
}

let next = 0

/** The files in a team's message box, kept as they are added. */
export function useChatAttachments(teamPath: string) {
  const [items, setItems] = useState<Attachment[]>([])
  const live = useRef(new Map<string, { abort: AbortController; preview: string | null }>())

  const letGo = useCallback((id: string) => {
    const held = live.current.get(id)
    if (!held) return
    held.abort.abort()
    if (held.preview) URL.revokeObjectURL(held.preview)
    live.current.delete(id)
  }, [])

  const clear = useCallback(() => {
    for (const id of [...live.current.keys()]) letGo(id)
    setItems([])
  }, [letGo])

  // Another team's box starts empty; leaving lets every preview go.
  useEffect(() => clear, [teamPath, clear])

  const add = useCallback((files: readonly File[], name: (file: File) => string = (file) => file.name) => {
    const room = MAX_CHAT_FILES - live.current.size
    const added = files.map((file, index): [Attachment, File] => {
      const id = `attach-${++next}`
      const named = name(file) || 'file'
      const picture = isPicture(named)
      const problem = index >= room ? `Only ${MAX_CHAT_FILES} files per message. Remove it to send.`
        : file.size > MAX_CHAT_FILE_BYTES ? `Too big (over ${MAX_CHAT_FILE_BYTES / 1024 / 1024} MB). Remove it to send.`
          : null
      const preview = picture && !problem && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : null
      live.current.set(id, { abort: new AbortController(), preview })
      return [{ id, name: named, picture, preview, state: problem ? 'failed' : 'uploading', kept: null, problem }, file]
    })
    setItems((list) => [...list, ...added.map(([attachment]) => attachment)])
    for (const [attachment, file] of added) {
      if (attachment.problem) continue
      const held = live.current.get(attachment.id)
      uploadChatFile(teamPath, file, attachment.name, held?.abort.signal)
        .then((kept) => setItems((list) => list.map((item) => (item.id === attachment.id ? { ...item, state: 'ready', kept, name: kept.name } : item))))
        .catch((caught: unknown) => {
          if (held?.abort.signal.aborted) return
          const detail = caught instanceof Error ? caught.message : String(caught)
          const problem = 'Couldn’t be saved. Remove it and add it again.'
          setItems((list) => list.map((item) => (item.id === attachment.id ? { ...item, state: 'failed', problem, detail } : item)))
        })
    }
  }, [teamPath])

  const remove = useCallback((id: string) => {
    letGo(id)
    setItems((list) => list.filter((item) => item.id !== id))
  }, [letGo])

  /** Put files already kept back in the box: a message that couldn't go, to edit. */
  const restore = useCallback((files: readonly ChatFile[]) => {
    const restored = files.map((kept): Attachment => {
      const id = `attach-${++next}`
      live.current.set(id, { abort: new AbortController(), preview: null })
      return { id, name: kept.name, picture: kept.picture, preview: null, state: 'ready', kept, problem: null }
    })
    setItems((list) => [...list, ...restored])
  }, [])

  return {
    items,
    add,
    remove,
    restore,
    clear,
    /** What the message sends: the files kept so far. */
    kept: items.flatMap((item) => (item.kept ? [item.kept] : [])),
    /** Still being kept: Send waits for it. */
    busy: items.some((item) => item.state === 'uploading'),
  }
}

export type ChatAttachments = ReturnType<typeof useChatAttachments>
