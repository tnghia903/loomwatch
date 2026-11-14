import type { SendsList } from '../../lib/runs/client'

/**
 * Everything a connected tool's call would send (ADR 0040), one tap away under the plain line the
 * ask leads with: that line says what it is about and when, and leaves out groups of fields and
 * the rest of long words, so what is allowed is never only what the line shows. The daemon says
 * each field the way the line does, in the line's order (`permissions/plain.rs`); the text sent,
 * when it reads differently, is in the value's tooltip.
 */
export function PermissionSends({ sends }: { sends?: SendsList | null }) {
  if (!sends || sends.fields.length === 0) return null
  return (
    <details className="permission-sends">
      <summary>Everything it would send</summary>
      <dl className="selectable" tabIndex={0} aria-label="Everything it would send">
        {sends.fields.map((field, at) => (
          <div key={`${at}:${field.name}`}>
            <dt>{field.name}</dt>
            <dd className={field.code ? 'mono' : undefined} title={field.sent}>{field.said}</dd>
          </div>
        ))}
      </dl>
      {sends.cut && <p className="permission-sends-cut">The rest is too long to show here.</p>}
    </details>
  )
}
