// Agents with the model tier that suits them, for measuring the model suggestion
// (modelSuggestion.eval.test.ts). Three sources, kept apart because their labels mean different
// things:
//
// - `example`: the bundled teams in examples/, labelled with the model their author chose. An
//   author may pick for cost as well as fit, so a few labels are a cost choice no reading can match.
// - `renamed`: each built-in job's own instructions under a name that says nothing ("Step 2"),
//   labelled with the job's own tier (roles.ts).
// - `written`: agents written for this set, whose instructions mention other jobs, negate them or
//   name none. Labelled by hand: a judgement, not a measurement.
//
// Every case sits in a team whose answer comes from a Writer, unless it says otherwise, so a
// gatherer can be told apart from the agent that writes the answer.

import { DEFAULT_MODEL, canonicalModel, tierOfModel } from '../ai/modelIds'
import { ROLE_PRESETS } from '../library/roles'
import type { SuggestedAgent } from './agentSetup'
import { pipelineTerminal } from './pipelineOrder'
import { answeringAgent } from '../library/checker'
import type { TeamDocument } from './types'

export type Tier = 'strong' | 'fast' | 'check'
/** The tier `model` is, on whichever source it is paid through. */
export const tierOf = (model: string): Tier | null => tierOfModel(model)

export interface SuggestionCase {
  source: 'example' | 'renamed' | 'written'
  label: string
  agent: SuggestedAgent
  team: { agents: SuggestedAgent[]; responder: string | null }
  want: Tier
}

const WRITER: SuggestedAgent = { id: 'writer', name: 'Writer', role: 'Write the final report from what you are handed, in plain words, with a source for every claim.', model: DEFAULT_MODEL }

/** The bundled teams' agents, each labelled with the model its author chose. */
export function exampleCases(teams: Record<string, TeamDocument>): SuggestionCase[] {
  const cases: SuggestionCase[] = []
  for (const [file, doc] of Object.entries(teams)) {
    // The answer is found along the whole pipeline, your review steps on it too, as the canvas does.
    const terminal = pipelineTerminal(doc.agents.map((agent) => agent.id), (doc.edges ?? []).map((edge) => ({ from: edge.from, to: edge.to })), doc.entrypoint ?? null)
    const responder = doc.responder ?? answeringAgent(terminal, doc.agents)
    const agents = doc.agents.filter((agent) => agent.kind !== 'operator')
    for (const agent of agents) {
      const want = tierOf(canonicalModel(agent.model))
      // The offline demo's agents run no model, so they have no label.
      if (!want) continue
      cases.push({ source: 'example', label: `${file}: ${agent.name}`, agent, team: { agents, responder }, want })
    }
  }
  return cases
}

export const renamedCases: SuggestionCase[] = ROLE_PRESETS.map((preset) => {
  const agent: SuggestedAgent = { id: 'step-2', name: 'Step 2', role: preset.role }
  const want: Tier = preset.tier === 'fast' ? 'fast' : preset.tier === 'check' ? 'check' : 'strong'
  return { source: 'renamed', label: `${preset.label} as “Step 2”`, agent, team: { agents: [agent, WRITER], responder: 'writer' }, want }
})

const written = (name: string, role: string, want: Tier, extra: Partial<SuggestedAgent> = {}): SuggestionCase => {
  const agent: SuggestedAgent = { id: name.toLowerCase().replace(/[^a-z]+/g, '-'), name, role, ...extra }
  return { source: 'written', label: name, agent, team: { agents: [agent, WRITER], responder: 'writer' }, want }
}

export const writtenCases: SuggestionCase[] = [
  written('Scraper', 'Fetch every page listed in the Brief and pull out the price table as CSV. Do not analyse or comment on the numbers; the Writer does that.', 'fast', { allow: { web: true } }),
  written('Data collector', 'Query the sales CSV for the rows that match the filter you are given and return them raw. The Analyst interprets them, not you.', 'fast'),
  written('Triage', 'Read each support ticket and tag it with one of: billing, bug, how-to, other. Do not draft replies. Return one line per ticket: its id and its tag.', 'fast'),
  written('Clipper', 'Search the news for the company named in the request and return every article from the last week with its headline, date and link. Leave the summary to the Writer.', 'fast', { allow: { web: true } }),
  written('Note taker', 'Go through the meeting transcript and list every decision and every action item with its owner, word for word where you can. Do not write the minutes.', 'fast'),
  written('Inbox sorter', 'Sort the emails you are handed into urgent, this week and later, and hand the lists on. Never answer an email yourself.', 'fast'),
  written('Fact checker', 'Verify every claim in the Writer’s draft against its cited sources. List each claim as supported, unsupported or unclear, with the line of the source that decides it.', 'check'),
  written('QA', 'Test the app the Coder built against the request: run it, try each feature, and report what works and what doesn’t as pass or fail with the steps to reproduce. Do not change the code.', 'check', { allow: { commands: true } }),
  written('Second opinion', 'Read the plan you are handed and give a verdict: does it meet the request, yes or no, and the three biggest problems if not. Don’t rewrite it.', 'check'),
  written('Planner', 'Break the request into steps, decide which teammate does each, and hand the steps out. Judge when the work is complete.', 'strong', { allowRecruiting: true }),
  written('Contract reviewer', 'Read the contract clause by clause, flag liability, IP and termination risks, and explain each with the clause number and what to change.', 'strong'),
  written('Translator', 'Translate the finished article into Vietnamese for readers in Ho Chi Minh City. Keep the headings, links and tone; never add or drop a claim.', 'strong'),
  written('Explainer', 'Teach the topic to a twelve-year-old in five short steps, each building on the last, with one everyday example per step.', 'strong'),
  written('Pitch deck maker', 'Turn the research you are handed into a ten-slide pitch: one idea per slide, a headline that says it, and speaker notes.', 'strong'),
  written('Bug fixer', 'Find why the failing test fails, change the code so it passes without breaking the others, and explain the cause in two sentences.', 'strong', { allow: { edits: true, commands: true } }),
  written('Strategist', 'Weigh the three options in the Brief against cost, risk and time, choose one, and say why the other two lost. Do not gather more data.', 'strong'),
]
