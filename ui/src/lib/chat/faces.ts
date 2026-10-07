// An agent's face in the team's chat (ADR 0051): the card it shows on hover, and the @mention it
// puts in the message box when clicked. The chat provides them; outside it an avatar is a picture.
import { createContext, useContext } from 'react'

/** What the card says about one agent: who it is, what it is doing, and what it works with. */
export interface AgentFacts {
  id: string
  name: string
  hue: number
  /** "ready", "working", "waiting for you" or "away", as the team list says it. */
  state: 'idle' | 'working' | 'waiting' | 'away'
  stateWords: string
  /** "Claude", "Codex (not installed)", "Offline demo (no AI)". */
  app: string | null
  model: string | null
  /** Its job, from the team file. */
  role: string | null
  /** Where it stands in a pipeline: step 2 of 5. */
  step: { at: number; of: number } | null
  skills: number
  tools: number
  knowledge: number
}

/** The team's faces in the chat: the card for each, and @mentioning one in the message box. */
export interface AgentFaces {
  facts: (id: string) => AgentFacts | null
  mention: (id: string) => void
}

export const AgentFacesContext = createContext<AgentFaces | null>(null)

/** Whether a face here is the chat's: outside a team's chat an avatar is only a picture. */
export function useAgentFaces(): AgentFaces | null {
  return useContext(AgentFacesContext)
}
