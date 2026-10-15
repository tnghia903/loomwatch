import { useEffect, useState } from 'react'

/** Where Your agents is: the list, one saved agent, or a new one (from a built-in job, maybe). */
export type AgentsRoute = { kind: 'list' } | { kind: 'agent'; id: string } | { kind: 'new'; from: string | null }

export function parseAgentsRoute(pathname: string, search: string): AgentsRoute {
  const rest = pathname.replace(/^\/agents\/?/, '')
  if (!rest) return { kind: 'list' }
  if (rest === 'new') return { kind: 'new', from: new URLSearchParams(search).get('from') }
  return { kind: 'agent', id: decodeURIComponent(rest.split('/')[0]) }
}

const CHANGED = 'loomwatch:agents-route'

/** Move within Your agents without reloading the page; Back and Forward work as usual. */
export function navigate(to: string, replace = false) {
  if (replace) window.history.replaceState({}, '', to)
  else window.history.pushState({}, '', to)
  window.dispatchEvent(new Event(CHANGED))
}

export function useAgentsRoute(): AgentsRoute {
  const read = () => parseAgentsRoute(window.location.pathname, window.location.search)
  const [route, setRoute] = useState<AgentsRoute>(read)
  useEffect(() => {
    const update = () => setRoute(read())
    window.addEventListener('popstate', update)
    window.addEventListener(CHANGED, update)
    return () => { window.removeEventListener('popstate', update); window.removeEventListener(CHANGED, update) }
  }, [])
  return route
}
