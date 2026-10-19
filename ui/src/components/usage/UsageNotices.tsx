import { useEffect, useState } from 'react'

import { useAiStatus } from '../../lib/ai/useKeyStatus'
import { type UsageReport, fetchUsage } from '../../lib/usage/client'
import { usageNotices } from '../../lib/usage/notices'

/** Home's heads-up about usage, when there is one. Nothing shows while all is well. */
export function UsageNotices() {
  const ai = useAiStatus()
  const [report, setReport] = useState<UsageReport | null>(null)
  const [now] = useState(() => new Date())
  const connected = Boolean(ai && (ai.openrouter.connected || ai.anthropic.connected || ai.chatgpt.connected))
  useEffect(() => {
    if (!connected) return
    let current = true
    // Only an answer shaped like a report is read: anything else gives no notice.
    fetchUsage(31).then((value) => { if (current && Array.isArray(value?.sources) && Array.isArray(value?.days)) setReport(value) }).catch(() => { /* no notice */ })
    return () => { current = false }
  }, [connected])
  if (!report) return null
  const notices = usageNotices(report, now, ai?.openrouter.limitRemaining)
  if (notices.length === 0) return null
  return (
    <ul className="usage-notices" aria-label="Usage">
      {notices.map((notice) => (
        <li key={notice.key} className="e1 t-meta">
          <span>{notice.text}</span>
          <a className="link" href={notice.href} {...(notice.href.startsWith('http') ? { target: '_blank', rel: 'noreferrer' } : {})}>{notice.label}</a>
        </li>
      ))}
    </ul>
  )
}
