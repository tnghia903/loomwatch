import { useEffect, useState } from 'react'

import { goToTeam } from '../../lib/team-file/teamPage'

/** An agent's page: its workbench, where it is built, or its chat, where you work with it. */
export type AgentView = 'build' | 'chat'

/**
 * Where Your agents is: the list, one saved agent, or a new one (from a built-in job, maybe). `team`
 * is the team the operator came from, so the way back is one click. `run` is a piece of its chat a
 * link opens, with its Details (`historyRunUrl`).
 */
export type AgentsRoute = { kind: 'list' } | { kind: 'agent'; id: string; team: string | null; view: AgentView; run: string | null } | { kind: 'new'; from: string | null; team: string | null; view: AgentView }

export function parseAgentsRoute(pathname: string, search: string): AgentsRoute {
  const rest = pathname.replace(/^\/agents\/?/, '')
  if (!rest) return { kind: 'list' }
  const query = new URLSearchParams(search)
  const view: AgentView = query.get('view') === 'chat' ? 'chat' : 'build'
  if (rest === 'new') return { kind: 'new', from: query.get('from'), team: query.get('team'), view }
  return { kind: 'agent', id: decodeURIComponent(rest.split('/')[0]), team: query.get('team'), view, run: query.get('run') }
}

/** The page's own address with `view` set, keeping everything else it says. */
export function withView(view: AgentView, location: { pathname: string; search: string } = window.location): string {
  const query = new URLSearchParams(location.search)
  if (view === 'chat') query.set('view', 'chat')
  else query.delete('view')
  const rest = query.toString()
  return `${location.pathname}${rest ? `?${rest}` : ''}`
}

const CHANGED = 'loomwatch:agents-route'

/** Move within Your agents without reloading the page; Back and Forward work as usual. */
export function navigate(to: string, replace = false) {
  if (replace) window.history.replaceState({}, '', to)
  else window.history.pushState({}, '', to)
  window.dispatchEvent(new Event(CHANGED))
}

/**
 * Follow a link to a run (`historyRunUrl`): a team's run on its page, in place where it can be; a
 * run of an agent's own chat on that agent's page, in place when it is the agent on screen. Another
 * agent's page loads as a page does, so changes not saved are asked about first.
 */
export function goToRun(href: string) {
  const to = new URL(href, window.location.href)
  if (!to.pathname.startsWith('/agents/')) goToTeam(href)
  else if (to.pathname === window.location.pathname) navigate(`${to.pathname}${to.search}`)
  else window.location.assign(href)
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
