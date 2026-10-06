import type { HTMLAttributes, ReactNode } from 'react'

import { useAppear } from '../../lib/chat/appear'

/** A block that rises in when it is news (see `useAppear`), and is simply there otherwise. */
export function Appearing({ className = '', children, ...props }: HTMLAttributes<HTMLDivElement> & { children?: ReactNode }) {
  const appear = useAppear()
  return <div {...props} className={`${className}${appear ? ' tc-appear' : ''}`}>{children}</div>
}

/**
 * Words that change in place — who is working, where a message goes, what became of a note.
 * Keyed by the caller on the words, so each new version mounts and slides in once.
 */
export function Swap({ className = '', children }: { className?: string; children: ReactNode }) {
  const appear = useAppear()
  return <span className={`${className}${appear ? ' tc-swap' : ''}`}>{children}</span>
}
