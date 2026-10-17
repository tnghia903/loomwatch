import { currentRun } from './currentRun'
import { keys } from '../platform'

/**
 * The getting-started guide, one card per step, in the order the work is done: build an agent in
 * Your agents, put it in a team and see its workflow, then give the team work in its chat.
 *
 * Steps point at the screen through `data-tour` attributes, never through styling class names,
 * so restyling a panel cannot silently detach the guide from it. An `action` step waits for the
 * operator to do the real thing (build an agent, create the team, run it), and its `done` check reads
 * the page to see that they did; a `next` step only explains what is on screen. A step can also
 * change what it says as the page changes, e.g. from "click New team" to "fill in the dialog".
 */
export type TourStepId =
  | 'welcome' | 'build-agent' | 'agent' | 'try' | 'save' | 'new-team' | 'team-agents' | 'workflow' | 'run-team' | 'ask' | 'watch' | 'review' | 'done'

/**
 * Where a step can be shown: Home, Your agents, or inside a team. When another screen is showing,
 * the guide carries on at the next step for it, or waits for the operator to come back; see
 * `GettingStarted`.
 */
export type TourScreen = 'home' | 'agents' | 'workspace' | 'any'

export type TourSide = 'top' | 'bottom' | 'left' | 'right'

export interface TourContext {
  /** An OpenRouter key is added, so agents can run. */
  keyReady: boolean
  /** The daemon hasn't said yet whether one is. */
  keyLoading: boolean
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

/** An agent's card on the Workflow canvas (React Flow names the node type). */
const AGENT_CARD = '[data-tour="workspace"] .react-flow__node-agent'

function present(selector: string): boolean {
  return document.querySelector(selector) !== null
}

/** How many agents the open team has, as the workspace says, not as many as are drawn yet. */
function agentCount(): number {
  return Number(document.querySelector('[data-tour="workspace"]')?.getAttribute('data-tour-agents') ?? 0)
}

/** Which of the open team's views is showing: `agents`, `workflow` or `chat`. */
function teamView(): string | null {
  return document.querySelector('[data-tour="workspace"]')?.getAttribute('data-tour-view') ?? null
}

export const EXAMPLE_REQUEST = 'Give me three ideas for a weekend project, one sentence each.'

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'welcome',
    screen: 'any',
    view: () => ({
      title: 'Welcome to LoomWatch',
      body: 'LoomWatch puts AI agents to work as a team, on your computer, with your OpenRouter key. This guide takes you the whole way once: build an agent, put it in a team, then give the team work in its chat. You do each step yourself, and it takes about three minutes.',
      advance: 'start',
    }),
  },
  {
    id: 'build-agent',
    screen: 'home',
    // Opening the builder is a new page, Your agents, where the guide carries on by itself.
    view: ({ keyReady, keyLoading }) => !keyLoading && !keyReady
      ? {
          title: 'Add your OpenRouter key first',
          body: 'Agents think with AI models, which LoomWatch reaches through OpenRouter with one key. The card here shows how to make one and paste it in. Then click Build an agent.',
          target: ['[data-tour="key"]'],
          sides: ['bottom', 'top', 'right'],
          advance: 'action',
        }
      : {
          title: 'Build your first agent',
          body: 'An agent is an AI helper with one job, thinking with the AI model you choose for it. Click Build an agent.',
          target: ['[data-tour="build-agent"]'],
          sides: ['bottom', 'right', 'top'],
          advance: 'action',
        },
  },
  {
    id: 'agent',
    screen: 'agents',
    // The list of Your agents has no builder yet: the step first asks for a new agent.
    view: () => present('[data-tour="agent-blocks"]')
      ? {
          title: 'Give it a name and a job',
          body: 'Each block is one of its settings, in plain words: its name, its instructions, its model, its skills, and what it may do without asking. The figure at the bench shows the same things. Type a name, and in Instructions say what it does and what it replies with.',
          target: ['[data-tour="agent-blocks"]'],
          sides: ['left', 'right', 'top', 'bottom'],
          advance: 'next',
          dim: true,
        }
      : {
          title: 'Start a new agent',
          body: 'Press New agent, then pick a job to start from, or Blank to write its instructions yourself.',
          target: ['[data-tour="agent-start"]', '[data-tour="new-agent"]'],
          sides: ['bottom', 'right', 'top'],
          advance: 'action',
        },
  },
  {
    id: 'try',
    screen: 'agents',
    // Its chat is a tab of its page. Once it has answered, the step points at the answer and waits
    // for Next, so the guide never scrolls away from an answer the operator is still reading.
    view: () => present('[data-tour="agent-builder"] [data-tour="output"]')
      ? {
          title: 'Read its answer',
          body: 'This is what it did and what it replied. Not what you wanted? Change it in Build, then ask again here: it always works as it is on screen.',
          target: ['[data-tour="agent-builder"] [data-tour="output"]'],
          sides: ['left', 'top', 'right', 'bottom'],
          advance: 'next',
          dim: true,
        }
      : present('[data-tour="agent-builder"] [data-tour="composer"]')
        ? {
            title: 'Ask it for something',
            body: 'Write a request, the kind a team would hand it, and send it. It works on it here, exactly as it is on screen, saved or not, and no team changes.',
            target: ['[data-tour="agent-builder"] [data-tour="composer"]'],
            sides: ['top', 'left', 'right'],
            advance: 'action',
          }
        : {
            title: 'Chat with it on its own',
            body: 'Open its Chat. You work with it there before any team depends on it, and its figure works at the bench while it does.',
            target: ['[data-tour="agent-tab-chat"]'],
            sides: ['bottom', 'right', 'left'],
            advance: 'action',
          },
  },
  {
    id: 'save',
    screen: 'agents',
    // Going to Your teams is a new page, Home, where the guide carries on by itself.
    view: () => present('[data-tour="agent-builder"][data-tour-saved]')
      ? {
          title: 'Now put it in a team',
          body: 'It is in Your agents now, ready for any team. Go to Your teams to make one.',
          target: ['[data-tour="your-teams"]'],
          sides: ['bottom', 'left'],
          advance: 'action',
        }
      : {
          title: 'Save it to Your agents',
          body: 'Press Save to Your agents. Every team you add it to keeps the version it was given, until you update it there.',
          target: ['[data-tour="save-agent"]'],
          sides: ['bottom', 'left'],
          advance: 'action',
        },
  },
  {
    id: 'new-team',
    screen: 'home',
    // Creating the team opens it, where the guide carries on by itself.
    view: () => present('[data-tour="new-team-dialog"]')
      ? {
          title: 'Start it empty',
          body: 'Type any name, choose Empty team, and press Create team. You choose its agents next.',
          target: ['[data-tour="new-team-dialog"]'],
          sides: ['right', 'left'],
          advance: 'action',
          dim: false,
          keepClear: true,
        }
      : {
          title: 'Put it in a team',
          body: 'A team is the agents that work on your request together, and the order they hand work along. Click New team.',
          target: ['[data-tour="new-team"]'],
          sides: ['bottom', 'right', 'top'],
          advance: 'action',
        },
  },
  {
    id: 'team-agents',
    screen: 'workspace',
    view: () => present('[data-tour="agent-picker"]')
      ? {
          title: 'Add your agent',
          body: 'A team starts on Agents. Press Add beside the agent you built, and it joins the team as the version you saved. More agents join the same way.',
          target: ['[data-tour="agent-picker"]'],
          sides: ['bottom', 'right', 'left'],
          advance: 'action',
        }
      : {
          title: 'Add your agent',
          body: 'This team has no agents yet. Click Agents at the top to add the one you built.',
          target: ['[data-tour="tab-agents"]', '[data-tour="view-tabs"]'],
          sides: ['bottom'],
          advance: 'action',
        },
    done: () => agentCount() > 0,
  },
  {
    id: 'workflow',
    screen: 'workspace',
    view: () => teamView() === 'workflow' && agentCount() > 0
      ? {
          title: 'Connect them in Workflow',
          body: 'Each card is one of the team’s agents, on the model named on it. With more than one, connect the cards so work passes from one to the next, or add a review step that waits for you. One agent needs nothing more.',
          target: [AGENT_CARD],
          sides: ['right', 'bottom', 'left', 'top'],
          advance: 'next',
          dim: true,
        }
      : {
          title: 'Open Workflow',
          body: 'Workflow shows how the team’s agents hand work along. Click Workflow at the top.',
          target: ['[data-tour="tab-workflow"]', '[data-tour="view-tabs"]'],
          sides: ['bottom'],
          advance: 'action',
        },
  },
  {
    id: 'run-team',
    screen: 'workspace',
    view: () => ({
      title: 'Open the team’s chat',
      body: 'Press Run team, or Chat at the top. The team’s chat is where you give it work, watch it work and read its answers.',
      target: ['[data-tour="run-team"]', '[data-tour="tab-chat"]'],
      sides: ['bottom', 'left'],
      advance: 'action',
    }),
    // The view, not the request box: Workflow keeps a box of its own in the page, out of sight.
    done: () => teamView() === 'chat',
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
    id: 'done',
    screen: 'any',
    view: () => ({
      title: 'You’re all set',
      body: `That is the whole loop: build an agent, put it in a team’s workflow, and give the team work in its chat. When a team needs you, for an answer or an approval, it asks in its chat and says so at the top of every screen. To see this guide again, press ${keys('⌘K')} and choose Getting started guide, or use the menu in any team.`,
      advance: 'finish',
    }),
  },
]

export function stepIndex(id: TourStepId): number {
  return TOUR_STEPS.findIndex((step) => step.id === id)
}
