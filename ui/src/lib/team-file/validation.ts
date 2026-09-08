// docs/CANVAS_SPEC.md §9.2: validate against the schema the daemon serves at
// GET /api/config/schema, plus the TEAM_CONFIG.md semantic rules the schema cannot express.
// §5.4 assigns every problem one of two weights — `incomplete` (copper, "unfinished") or
// `error` (red, "wrong") — for the five fields the inspector actually edits.

import Ajv2020 from 'ajv/dist/2020'
import type { ErrorObject } from 'ajv'

import type { EdgeConfig, TeamDocument } from './types'

export type FieldWeight = 'incomplete' | 'error'

export interface FieldProblem {
  weight: FieldWeight
  message: string
}

export type AgentField = 'name' | 'role' | 'model' | 'cwd' | 'limitUsd'

export type AgentFieldProblems = Partial<Record<AgentField, FieldProblem>>

export interface DocumentProblem {
  message: string
  agentId?: string
  edge?: { from: string; to: string }
}

export interface ValidationResult {
  valid: boolean
  fieldProblemsByAgent: Map<string, AgentFieldProblems>
  documentProblems: DocumentProblem[]
}

export type TeamValidator = (doc: TeamDocument) => ValidationResult

const AGENT_ERROR_PATH = /^\/agents\/(\d+)(?:\/(.+))?$/
const EDGE_ERROR_PATH = /^\/edges\/(\d+)(?:\/(.+))?$/
const AGENT_TEXT_FIELDS = new Set<AgentField>(['name', 'role', 'model'])

function setFieldProblem(
  byAgent: Map<string, AgentFieldProblems>,
  agentId: string,
  field: AgentField,
  problem: FieldProblem,
): void {
  const fields = byAgent.get(agentId) ?? {}
  // `error` always wins: a field that is both empty-by-schema and semantically wrong (which
  // cannot happen for the same rule, but can across two different rules) should show as wrong.
  if (fields[field]?.weight === 'error') {
    return
  }
  fields[field] = problem
  byAgent.set(agentId, fields)
}

/** ajv errors for the five inspector-editable fields. Everything else is a document problem. */
function applySchemaError(
  doc: TeamDocument,
  error: ErrorObject,
  fieldProblemsByAgent: Map<string, AgentFieldProblems>,
  documentProblems: DocumentProblem[],
): void {
  const agentMatch = AGENT_ERROR_PATH.exec(error.instancePath)
  if (agentMatch) {
    const agent = doc.agents[Number(agentMatch[1])]
    if (!agent) {
      return
    }
    const subPath = agentMatch[2]
    if (subPath && AGENT_TEXT_FIELDS.has(subPath as AgentField)) {
      // minLength: 1 is the only constraint on name/role/model, so the only way to fail it
      // is an empty string — which is exactly what "incomplete" means (§5.4).
      setFieldProblem(fieldProblemsByAgent, agent.id, subPath as AgentField, {
        weight: 'incomplete',
        message: 'Required',
      })
      return
    }
    if (subPath === 'spawn/cwd') {
      setFieldProblem(fieldProblemsByAgent, agent.id, 'cwd', { weight: 'incomplete', message: 'Required' })
      return
    }
    // budget.limitUsd is handled entirely by applySemanticRules — TEAM_CONFIG.md calls out
    // finiteness as a rule the schema cannot express, and folding minimum/type in there too
    // avoids two disagreeing messages for the same field.
    if (subPath === 'budget/limitUsd') {
      return
    }
    // Other agent-scoped errors (id pattern, spawn.cmd pattern, etc.) have no inspector field
    // today — TNG-55 scoped the inspector to name/role/model/cwd/budget — so surface them as a
    // document problem naming the agent rather than dropping them silently.
    documentProblems.push({ message: describeSchemaError(error), agentId: agent.id })
    return
  }

  const edgeMatch = EDGE_ERROR_PATH.exec(error.instancePath)
  if (edgeMatch) {
    const edge = doc.edges[Number(edgeMatch[1])]
    documentProblems.push({
      message: describeSchemaError(error),
      ...(edge ? { edge: { from: edge.from, to: edge.to } } : {}),
    })
    return
  }

  // Top-level `entrypoint` missing and `agents` empty already have dedicated UX with one-click
  // promotion candidates (useTeamDocument's `entrypointProblem`, §5.4/§10.2) — don't duplicate.
  if (error.instancePath === '' && error.keyword === 'required') {
    const missing = (error.params as { missingProperty?: string }).missingProperty
    if (missing === 'entrypoint' || missing === 'agents') {
      return
    }
  }
  if (error.instancePath === '/agents' && error.keyword === 'minItems') {
    return
  }

  documentProblems.push({ message: describeSchemaError(error) })
}

function describeSchemaError(error: ErrorObject): string {
  const path = error.instancePath === '' ? '(document)' : error.instancePath
  return `${path} ${error.message ?? 'is invalid'}`
}

interface EdgeEndpoints {
  from: string
  to: string
}

/** DFS cycle detection over the whole configured-edge set (edgeRules.ts only checks one add). */
function findCycle(edges: readonly EdgeEndpoints[]): EdgeEndpoints | null {
  const successors = new Map<string, string[]>()
  for (const edge of edges) {
    const list = successors.get(edge.from) ?? []
    list.push(edge.to)
    successors.set(edge.from, list)
  }

  const state = new Map<string, 'visiting' | 'done'>()
  let found: EdgeEndpoints | null = null

  function visit(node: string): void {
    if (found || state.get(node) === 'done') {
      return
    }
    state.set(node, 'visiting')
    for (const next of successors.get(node) ?? []) {
      if (found) {
        return
      }
      if (state.get(next) === 'visiting') {
        found = { from: node, to: next }
        return
      }
      if (state.get(next) !== 'done') {
        visit(next)
      }
    }
    state.set(node, 'done')
  }

  for (const node of successors.keys()) {
    if (found) {
      break
    }
    if (state.get(node) !== 'done') {
      visit(node)
    }
  }
  return found
}

/**
 * TEAM_CONFIG.md's "Semantic rules" section, minus entrypoint-names-an-agent (dedicated UX
 * above) and the edge-draw refusals already enforced proactively by edgeRules.ts. Still checked
 * here in full because a file can arrive already broken — loaded from disk after a hand edit,
 * or (§9.3) changed underneath an open session — and §9.2 gates *save*, not just drawing.
 */
function applySemanticRules(
  doc: TeamDocument,
  fieldProblemsByAgent: Map<string, AgentFieldProblems>,
  documentProblems: DocumentProblem[],
): void {
  const seenIds = new Set<string>()
  for (const agent of doc.agents) {
    if (seenIds.has(agent.id)) {
      documentProblems.push({ message: `Duplicate agent id \`${agent.id}\`.`, agentId: agent.id })
    }
    seenIds.add(agent.id)

    const limit = agent.budget.limitUsd
    if (!Number.isFinite(limit)) {
      setFieldProblem(fieldProblemsByAgent, agent.id, 'limitUsd', {
        weight: 'error',
        message: 'Budget must be a finite number.',
      })
    } else if (limit < 0) {
      setFieldProblem(fieldProblemsByAgent, agent.id, 'limitUsd', {
        weight: 'error',
        message: 'Budget must be zero or greater.',
      })
    }
  }

  // JSON Schema can ensure that an entrypoint looks like an identifier, but only the complete
  // document can tell whether that identifier belongs to one of its agents.
  if (doc.entrypoint && !seenIds.has(doc.entrypoint)) {
    documentProblems.push({
      message: `Entrypoint \`${doc.entrypoint}\` does not name an agent in this team.`,
      agentId: doc.entrypoint,
    })
  }

  // The same `Budget` definition is used at team and agent scope. The inspector owns agent
  // budgets, while the mode controls own the team budget, so leave a team-level failure as a
  // document problem instead of incorrectly attaching it to an agent field.
  if (doc.budget) {
    const limit = doc.budget.limitUsd
    if (!Number.isFinite(limit)) {
      documentProblems.push({ message: 'Team budget must be a finite number.' })
    } else if (limit < 0) {
      documentProblems.push({ message: 'Team budget must be zero or greater.' })
    }
  }

  const configured = doc.edges.filter((edge): edge is EdgeConfig => edge.layer === 'configured')
  const seenPairs = new Set<string>()
  for (const edge of configured) {
    if (edge.from === edge.to) {
      documentProblems.push({
        message: `\`${edge.from}\` can't follow itself.`,
        edge: { from: edge.from, to: edge.to },
      })
    }
    const pairKey = `${edge.from}->${edge.to}`
    if (seenPairs.has(pairKey)) {
      documentProblems.push({
        message: `Duplicate edge \`${edge.from} → ${edge.to}\`.`,
        edge: { from: edge.from, to: edge.to },
      })
    }
    seenPairs.add(pairKey)
    if (!seenIds.has(edge.from) || !seenIds.has(edge.to)) {
      documentProblems.push({
        message: `Edge \`${edge.from} → ${edge.to}\` names an agent that no longer exists.`,
        edge: { from: edge.from, to: edge.to },
      })
    }
  }

  const cycle = findCycle(configured)
  if (cycle) {
    documentProblems.push({
      message: `Pipeline has a loop: \`${cycle.from} → ${cycle.to}\` closes a cycle.`,
      edge: cycle,
    })
  }

  // Pipeline mode (TEAM_CONFIG.md: a non-empty `edges` array selects it) requires the
  // entrypoint to be a source — no incoming configured edge.
  if (doc.entrypoint && configured.length > 0) {
    const incoming = configured.find((edge) => edge.to === doc.entrypoint)
    if (incoming) {
      documentProblems.push({
        message: `\`${doc.entrypoint}\` is the entrypoint, so it can't have an incoming step.`,
        agentId: doc.entrypoint,
      })
    }
  }
}

/**
 * Compiles the daemon-served schema once (§9.2: "fetch it once at load; do not bundle a copy
 * into the UI"). The returned function is cheap to call on every edit — ajv's compiled
 * validator is a plain function call, no re-parsing of the schema.
 */
export function compileTeamValidator(schema: object): TeamValidator {
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  const validate = ajv.compile(schema)

  return (doc: TeamDocument): ValidationResult => {
    const fieldProblemsByAgent = new Map<string, AgentFieldProblems>()
    const documentProblems: DocumentProblem[] = []

    const schemaValid = validate(doc) as boolean
    for (const error of validate.errors ?? []) {
      applySchemaError(doc, error, fieldProblemsByAgent, documentProblems)
    }
    applySemanticRules(doc, fieldProblemsByAgent, documentProblems)

    const hasFieldErrors = Array.from(fieldProblemsByAgent.values()).some(
      (fields) => Object.keys(fields).length > 0,
    )
    return {
      valid: schemaValid && !hasFieldErrors && documentProblems.length === 0,
      fieldProblemsByAgent,
      documentProblems,
    }
  }
}

/**
 * §5.4's reveal rule: `incomplete` is never punishing so it always shows; `error` is suppressed
 * until the field has been left at least once (blur) or a save was attempted, so a field never
 * flashes red mid-keystroke. An `incomplete` field still showing after an attempted save is
 * promoted to `error` — "still incomplete after a save attempt" in the spec's own words.
 */
export function displayFieldProblems(
  fieldProblemsByAgent: Map<string, AgentFieldProblems>,
  touchedFields: ReadonlySet<string>,
  attemptedSave: boolean,
): Map<string, AgentFieldProblems> {
  const display = new Map<string, AgentFieldProblems>()
  for (const [agentId, fields] of fieldProblemsByAgent) {
    const shown: AgentFieldProblems = {}
    for (const field of Object.keys(fields) as AgentField[]) {
      const problem = fields[field]
      if (!problem) {
        continue
      }
      if (problem.weight === 'incomplete') {
        shown[field] = attemptedSave ? { weight: 'error', message: problem.message } : problem
        continue
      }
      if (attemptedSave || touchedFields.has(`${agentId}:${field}`)) {
        shown[field] = problem
      }
    }
    if (Object.keys(shown).length > 0) {
      display.set(agentId, shown)
    }
  }
  return display
}
