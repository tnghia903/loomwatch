import { createContext, useContext } from 'react'

import { agentFigure, type FigureChoice } from '../../lib/library/figures'
import type { SavedJob } from '../../lib/library/jobs'
import type { AgentConfig } from '../../lib/team-file/types'

/**
 * Your agents, for anything inside a team that draws an agent (the canvas cards, the team sentence,
 * the Agents tab): with them, an agent placed from Your agents wears the figure it wears there.
 */
export const SavedAgentsContext = createContext<readonly SavedJob[]>([])

/** The figure a team's agent wears (lib/library/figures.ts `agentFigure`). */
export function useAgentFigure(agent: Pick<AgentConfig, 'id' | 'from'>): FigureChoice {
  return agentFigure(agent, useContext(SavedAgentsContext))
}

/**
 * Each of the open team's agents, by its id in the team, with the figure it wears: for the places
 * that only know an agent by id (the chat, Details). You, the review step, are not in it.
 */
export const TeamFiguresContext = createContext<ReadonlyMap<string, FigureChoice>>(new Map())

/** The figure the open team's agent `id` wears, or `null` for you or an agent the team doesn't list. */
export function useTeamFigure(id: string): FigureChoice | null {
  return useContext(TeamFiguresContext).get(id) ?? null
}

