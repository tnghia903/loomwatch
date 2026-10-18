import { useState } from 'react'

/**
 * A tool's own icon, which LoomWatch fetches from the tool's site and keeps (`icons.rs`), on a
 * white tile so a dark logo reads in the dark theme too. A tool with no icon to give, or one that
 * doesn't load, shows its first letter instead. Decorative: the tool's name is always beside it.
 */
export function ToolIcon({ name, icon, size = 28 }: { name: string; icon?: string | null; size?: number }) {
  // The address that failed, so a tool whose icon later changes tries again.
  const [failed, setFailed] = useState<string | null>(null)
  const shown = icon && failed !== icon ? icon : null
  return (
    <span className={`tool-icon${shown ? '' : ' letter'}`} style={{ width: size, height: size }} aria-hidden="true">
      {shown
        ? <img src={shown} alt="" loading="lazy" decoding="async" onError={() => setFailed(shown)} />
        : <b style={{ fontSize: Math.round(size * 0.46) }}>{name.trim().charAt(0).toUpperCase() || '?'}</b>}
    </span>
  )
}
