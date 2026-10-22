// An agent's face in the team's chat (ADR 0051): the card it shows on hover, the @mention it puts in
// the message box when clicked, and its chip where a message @mentions it. The chat provides them;
// outside it an avatar is a picture.
import { createContext, useContext } from 'react'

import type { ChatAgent } from './route'

/** What the card says about one agent: who it is, what it is doing, and what it works with. */
export interface AgentFacts {
  id: string
  name: string
  hue: number
  /** "ready", "working", "waiting for you", "failed" or "offline", as the team list says it. */
  state: 'idle' | 'working' | 'waiting' | 'failed' | 'away'
  stateWords: string
  /** The model it runs on: "Claude Opus 5.5", "Offline demo (no AI)". */
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

/** Who an @ in the chat can name, and each one's colour, so an @mention in a message shows as its chip. */
export interface ChatMentions {
  agents: readonly ChatAgent[]
  hue: (id: string) => number
}

/** `null` outside a team's chat, and in one agent's own chat, where an @ goes nowhere. */
export const ChatMentionsContext = createContext<ChatMentions | null>(null)

export function useChatMentions(): ChatMentions | null {
  return useContext(ChatMentionsContext)
}
