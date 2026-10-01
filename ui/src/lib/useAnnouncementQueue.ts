import { useCallback, useEffect, useRef, useState } from 'react'

// TNG89 §6.3: a live region is a queue, not a first-match. The first implementation
// resolved a candidate list with `.find(Boolean)`, so at most one message was announced
// per render and the rest were discarded — during a live run, agent status churn (held
// for 3 s at a time) silently preempted save state, the validation blocker and disk
// notices. This hook queues every message and drains it in order.
//
// A screen reader only (re)announces a region when its text changes, so each message is
// held for a beat before the next one lands, and an identical consecutive message is
// marked with a zero-width space so the change is real and still announced.
export function useAnnouncementQueue(holdMs = 1200): [string, (message: string | null | undefined) => void] {
  const [announcement, setAnnouncement] = useState('')
  const spoken = useRef('')
  const pending = useRef<string[]>([])
  const timer = useRef<number | null>(null)
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current) }, [])
  const enqueue = useCallback((message: string | null | undefined) => {
    if (!message) return
    pending.current.push(message)
    if (timer.current !== null) return
    const drain = () => {
      const next = pending.current.shift()
      if (next === undefined) { timer.current = null; return }
      spoken.current = next === spoken.current ? `${next}\u200b` : next
      setAnnouncement(spoken.current)
      timer.current = window.setTimeout(drain, holdMs)
    }
    drain()
  }, [holdMs])
  return [announcement, enqueue]
}