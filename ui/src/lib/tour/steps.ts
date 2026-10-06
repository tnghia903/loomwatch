import { listNames } from '../format'
import { currentRun } from './currentRun'

/**
 * The getting-started guide, one card per step.
 *
 * Steps point at the screen through `data-tour` attributes, never through styling class names,
 * so restyling a panel cannot silently detach the guide from it. An `action` step waits for the
 * operator to do the real thing (create the team, run it), and its `done` check reads the page
 * to see that they did; a `next` step only explains what is on screen.
 */
export type TourStepId =
  | 'welcome' | 'apps' | 'new-team' | 'create' | 'team' | 'run-team' | 'ask' | 'watch' | 'review' | 'needs-you' | 'build' | 'done'

/** Where a step can be shown. A `home` step shown in a team skips ahead; see `GettingStarted`. */
export type TourScreen = 'home' | 'workspace' | 'any'

export type TourSide = 'top' | 'bottom' | 'left' | 'right'

export interface TourContext {
  /** Names of the AI apps that can run an agent right now. */
  readyApps: readonly string[]
  appsLoading: boolean
}

export interface TourStepView {
  title: string
  body: string
  /** Selectors tried in order; the first that is on screen is highlighted. None: a centred card. */
  target?: readonly string[]
  /** Sides to try for the card, best first. */
  sides?: readonly TourSide[]
  /** How the card moves on: its own button (`next`), or the operator doing something (`action`). */
  advance: 'start' | 'next' | 'action' | 'finish'
  /** Dim everything but the target. Off where the target is a dialog with its own scrim. */
  dim?: boolean
  /** Never let the card cover the target; hide the card rather than overlap it. */
  keepClear?: boolean
  /** A request the operator can drop into the request box with one click. */
  example?: string
}

export interface TourStep {
  id: TourStepId
  screen: TourScreen
  view: (context: TourContext) => TourStepView
  /** For `action` steps: the operator has done it. */
  done?: (progress: { runAtStepStart: string | null }) => boolean
  /** The step to return to when this one's target is gone, e.g. the dialog it explains was closed. */
  whenMissing?: TourStepId
}

/** An agent's card on Build's canvas (React Flow names the node type), or its stage in the Run view. */
const AGENT_CARD = '[data-tour="workspace"] .react-flow__node-agent'
const STAGE_CARD = '[data-tour="stage"]'

function present(selector: string): boolean {
  return document.querySelector(selector) !== null
}

/** How many agents the open team has, as the workspace says, not as many as are drawn yet. */
function agentCount(): number {
  return Number(document.querySelector('[data-tour="workspace"]')?.getAttribute('data-tour-agents') ?? 0)
}

export const EXAMPLE_REQUEST = 'Give me three ideas for a weekend project, one sentence each.'

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'welcome',
    screen: 'any',
    view: () => ({
      title: 'Welcome to LoomWatch',
      body: 'LoomWatch runs a team of AI agents on your computer, using the AI apps you already have, and each team has its own chat where you work with it. This guide walks you through your first team and its first answer. You do each step yourself, and it takes about three minutes.',
      advance: 'start',
    }),
  },
  {
    id: 'apps',
    screen: 'home',
    view: ({ readyApps, appsLoading }) => ({
      title: 'Your AI apps',
      body: appsLoading
        ? 'LoomWatch is looking for the AI apps on this computer. Your agents run inside them, signed in as you.'
        : readyApps.length > 0
          ? `LoomWatch found ${listNames(readyApps)}. Your agents run inside these apps, signed in as you, so there is nothing new to set up.`
          : 'No AI app is ready yet. Set up an AI app shows how to install one and sign in. It notices on its own when the app is ready. You can keep going with the guide meanwhile.',
      // The setup panel when it is open; the footer's app status otherwise.
      target: ['[data-tour="app-setup"]', '[data-tour="apps"]'],
      sides: ['top'],
      advance: 'next',
      dim: true,
    }),
  },
  {
    id: 'new-team',
    screen: 'home',
    view: () => ({
      title: 'Create your first team',
      body: 'A team is one or more AI agents that work on your request together. Click New team to make one.',
      target: ['[data-tour="new-team"]'],
      sides: ['bottom', 'right', 'top'],
      advance: 'action',
    }),
    done: () => present('[data-tour="new-team-dialog"]'),
  },
  {
    id: 'create',
    screen: 'home',
    view: () => ({
      title: 'Name it and pick a start',
      body: 'Type any name, keep One assistant selected, and press Create team. You can add more agents later.',
      target: ['[data-tour="new-team-dialog"]'],
      sides: ['right', 'left'],
      advance: 'action',
      dim: false,
      keepClear: true,
    }),
    whenMissing: 'new-team',
  },
  {
    id: 'team',
    screen: 'workspace',
    // An empty team (the "Empty team" start) has no card to explain yet, so the step first asks for
    // one; the explanation takes its place as soon as a card is on the canvas. The guide can also be
    // reopened from the Run view, where the agents are stages instead of canvas cards.
    view: () => agentCount() > 0
      ? {
          title: 'This is your team',
          body: 'Each card is an agent: an AI helper with one job. It works in the AI app named on the card. To change its instructions or model, click its card in Build.',
          target: [AGENT_CARD, STAGE_CARD],
          sides: ['right', 'bottom', 'left', 'top'],
          advance: 'next',
          dim: true,
        }
      : {
          title: 'Add your first agent',
          body: 'Your team is empty. In Build, pick a job from the list on the left, like Researcher, to add an agent to it.',
          target: ['[data-tour="palette"]', '[data-tour="view-tabs"]'],
          sides: ['right', 'bottom'],
          advance: 'action',
        },
  },
  {
    id: 'run-team',
    screen: 'workspace',
    view: () => ({
      title: 'Open the team’s chat',
      body: 'Press Run team. The team’s chat is where you tell it what to do, watch it work and read its answers.',
      target: ['[data-tour="run-team"]', '[data-tour="view-tabs"]'],
      sides: ['bottom', 'left'],
      advance: 'action',
    }),
    done: () => present('[data-tour="composer"]'),
  },
  {
    id: 'ask',
    screen: 'workspace',
    view: () => ({
      title: 'Ask in plain words',
      body: 'Write @team and what you want done, then press Enter. Only an @ starts work, and the line above the box says where your message will go before you send it. Not sure what to ask? Use the example below, then press Enter.',
      target: ['[data-tour="composer"]'],
      sides: ['top', 'left'],
      advance: 'action',
      example: EXAMPLE_REQUEST,
    }),
    // A run that started since this step began: reopening an earlier run does not count.
    done: ({ runAtStepStart }) => {
      const run = currentRun()
      return run !== null && run !== runAtStepStart
    },
    whenMissing: 'run-team',
  },
  {
    id: 'watch',
    screen: 'workspace',
    view: () => ({
      title: 'Watch it work',
      body: 'The chat says who is working, and what the agents tell each other shows up here as they say it. Write while an agent works, and your note joins its next turn; Send now stops its current step first. Details opens the full record beside the chat.',
      target: ['[data-tour="stages"]'],
      sides: ['bottom', 'right', 'top'],
      advance: 'next',
      dim: true,
    }),
  },
  {
    id: 'review',
    screen: 'workspace',
    view: () => ({
      title: 'Read the answer',
      body: 'The answer arrives here, with a check of its record, Copy and Share under it. To change it, write @ and an agent’s name with what should change. Only that agent works again, and it is given the conversation so far.',
      target: ['[data-tour="output"]'],
      sides: ['left', 'bottom'],
      advance: 'next',
      dim: true,
    }),
  },
  {
    id: 'needs-you',
    screen: 'workspace',
    view: () => ({
      title: 'When a team needs you',
      body: 'Some teams stop to ask you a question or to wait for your approval. You answer on the message that asks, in the chat. It also shows up here, from any team and on every screen.',
      target: ['[data-tour="workspace"] [data-tour="needs-you"]'],
      sides: ['bottom', 'left'],
      advance: 'next',
      dim: true,
    }),
  },
  {
    id: 'build',
    screen: 'workspace',
    view: () => ({
      title: 'Change the team any time',
      body: 'Switch to Build to add agents from the list on the left, connect cards so work passes from one to the next, or add a review step that waits for you. Save, then come back to Chat.',
      target: ['[data-tour="view-tabs"]'],
      sides: ['bottom'],
      advance: 'next',
      dim: true,
    }),
  },
  {
    id: 'done',
    screen: 'any',
    view: () => ({
      title: 'You’re all set',
      body: 'That is the whole loop: build a team, talk to it in its chat, and review what comes back. The chat keeps it all, so later work picks up from there. To see this guide again, press ⌘K and choose Getting started guide, or use the menu in any team.',
      advance: 'finish',
    }),
  },
]

export function stepIndex(id: TourStepId): number {
  return TOUR_STEPS.findIndex((step) => step.id === id)
}

/** The first step shown inside a team: where a guide begun on Home continues once a team opens. */
export const FIRST_WORKSPACE_STEP: TourStepId = 'team'
