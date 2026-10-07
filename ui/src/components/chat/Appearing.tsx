import type { HTMLAttributes, ReactNode } from 'react'

import { useAppear } from '../../lib/chat/appear'
import { useRevealOnArrival } from '../../lib/chat/follow'

/**
 * A block that rises in when it is news (see `useAppear`), and is simply there otherwise. `reveal`:
 * it waits on you, so the chat shows it as it arrives (lib/chat/follow.ts).
 */
export function Appearing({ className = '', children, reveal = false, ...props }: HTMLAttributes<HTMLDivElement> & { children?: ReactNode; reveal?: boolean }) {
  const appear = useAppear()
  const element = useRevealOnArrival<HTMLDivElement>(reveal)
  return <div ref={element} {...props} className={`${className}${appear ? ' tc-appear' : ''}`}>{children}</div>
}

/**
 * Words that change in place — who is working, where a message goes, what became of a note.
 * Keyed by the caller on the words, so each new version mounts and slides in once.
 */
export function Swap({ className = '', children }: { className?: string; children: ReactNode }) {
  const appear = useAppear()
  return <span className={`${className}${appear ? ' tc-swap' : ''}`}>{children}</span>
}
