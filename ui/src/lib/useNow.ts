import { useSyncExternalStore } from 'react'

// One shared clock for every component that shows a running time. It ticks only while someone is
// subscribed, and a render reads the last tick instead of the system clock, so rendering stays pure.
const TICK_MS = 1000
const listeners = new Set<() => void>()
let now = Date.now()
let timer: ReturnType<typeof setInterval> | undefined

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (timer === undefined) {
    // React reads the time again right after subscribing, so the first frame is not a tick late.
    now = Date.now()
    timer = setInterval(() => {
      now = Date.now()
      for (const notify of listeners) notify()
    }, TICK_MS)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }
}

const stopped = () => () => {}
const read = () => now

/**
 * The current time in epoch milliseconds, updated every second while `running` — a live run's
 * elapsed time keeps counting between events, including while the run waits for the person.
 * While not running it holds the last value it had.
 */
export function useNow(running: boolean): number {
  return useSyncExternalStore(running ? subscribe : stopped, read)
}
