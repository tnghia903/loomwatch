// docs/CANVAS_SPEC.md §9.2: validate against the schema the daemon serves at
// GET /api/config/schema, plus the TEAM_CONFIG.md semantic rules the schema cannot express.
// §5.4 assigns every problem one of two weights — `incomplete` (copper, "unfinished") or
// `error` (red, "wrong") — for the four fields the inspector actually edits.

import type Ajv2020 from 'ajv/dist/2020'
import type { ErrorObject } from 'ajv'

import type { EdgeConfig, TeamDocument } from './types'

export type FieldWeight = 'incomplete' | 'error'

export interface FieldProblem {
  weight: FieldWeight
  message: string
}

export type AgentField = 'name' | 'role' | 'model' | 'cwd'

export type AgentFieldProblems = Partial<Record<AgentField, FieldProblem>>

export interface DocumentProblem {
  message: string
  agentId?: string
  edge?: { from: string; to: string }
  /** Source location for problems that do not have a dedicated canvas control. */
  yamlPath?: (string | number)[]
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
  const yamlPath = schemaErrorPath(error)
  const agentMatch = AGENT_ERROR_PATH.exec(error.instancePath)
  if (agentMatch) {
    const agent = doc.agents?.[Number(agentMatch[1])]
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
    // Other agent-scoped errors (id pattern, spawn.cmd pattern, etc.) have no inspector field
    // today — TNG-55 scoped the inspector to name/role/model/cwd — so surface them as a
    // document problem naming the agent rather than dropping them silently.
    documentProblems.push({ message: describeSchemaError(error, doc), agentId: agent.id, yamlPath })
    return
  }

  const edgeMatch = EDGE_ERROR_PATH.exec(error.instancePath)
  if (edgeMatch) {
    const edge = doc.edges?.[Number(edgeMatch[1])]
    documentProblems.push({
      message: describeSchemaError(error, doc),
      ...(edge ? { edge: { from: edge.from, to: edge.to } } : {}),
      yamlPath,
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
  // A team with no agents yet has no entrypoint either, and that is the one problem the dedicated
  // entrypoint UX already names ("Add your first agent"). Its empty string also fails the
  // identifier's length and pattern rules — two more rows saying the same thing in schema terms.
  if (error.instancePath === '/entrypoint' && doc.entrypoint === '') {
    return
  }

  documentProblems.push({ message: describeSchemaError(error, doc), yamlPath })
}

function schemaErrorPath(error: ErrorObject): (string | number)[] {
  const parts = error.instancePath
    .split('/')
    .slice(1)
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    .map((part) => /^\d+$/.test(part) ? Number(part) : part)
  if (error.keyword === 'additionalProperties') {
    const property = (error.params as { additionalProperty?: unknown }).additionalProperty
    if (typeof property === 'string') parts.push(property)
  } else if (error.keyword === 'required') {
    const property = (error.params as { missingProperty?: unknown }).missingProperty
    if (typeof property === 'string') parts.push(property)
  }
  return parts
}

/** Plain names for the places a schema error can point at, so nobody has to read a JSON pointer. */
const PLACE_LABELS: Record<string, string> = {
  '': 'The team file',
  '/id': 'The team id',
  '/name': 'The team name',
  '/entrypoint': 'The starting agent',
  '/responder': 'The agent that writes the final answer',
  '/agents': 'The agent list',
  '/edges': 'The connections between steps',
  '/schedule': 'The schedule',
  '/memory': 'Team memory',
  '/guards': 'The delegation limits',
  '/conversation': 'The conversation settings',
}

const SPAWN_LABELS: Record<string, string> = { cmd: 'app command', args: 'app arguments', env: 'environment settings', cwd: 'working folder' }

function describePlace(doc: TeamDocument, instancePath: string): string {
  const agentMatch = AGENT_ERROR_PATH.exec(instancePath)
  if (agentMatch) {
    const agent = doc.agents?.[Number(agentMatch[1])]
    const who = agent?.name || agent?.id || `Agent ${Number(agentMatch[1]) + 1}`
    const rest = agentMatch[2]
    if (!rest) return who
    const [head, sub] = rest.split('/')
    if (head === 'spawn' && sub && SPAWN_LABELS[sub]) return `${who}'s ${SPAWN_LABELS[sub]}`
    return `${who}'s ${head === 'id' ? 'id' : head.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}`
  }
  if (EDGE_ERROR_PATH.test(instancePath)) return 'A connection between steps'
  if (PLACE_LABELS[instancePath]) return PLACE_LABELS[instancePath]
  const top = `/${instancePath.split('/')[1] ?? ''}`
  return PLACE_LABELS[top] ? `${PLACE_LABELS[top]} (${instancePath.split('/').slice(2).join(' › ')})` : `The setting ${instancePath.slice(1).replaceAll('/', ' › ')}`
}

/**
 * One schema failure as a sentence an operator can act on.
 *
 * ajv's own text ("/entrypoint must match pattern \"^[A-Za-z0-9]…\"") is accurate and useless to
 * anyone who has not read the schema, so each keyword the team schema actually uses gets its own
 * wording; anything else falls back to ajv's message, still prefixed with a plain place name.
 */
function describeSchemaError(error: ErrorObject, doc: TeamDocument): string {
  const place = describePlace(doc, error.instancePath)
  const params = error.params as Record<string, unknown>
  switch (error.keyword) {
    case 'minLength':
      return params.limit === 1 ? `${place} can't be empty.` : `${place} must be at least ${String(params.limit)} characters.`
    case 'maxLength':
      return `${place} must be at most ${String(params.limit)} characters.`
    case 'pattern':
      return String(params.pattern).startsWith('^[A-Za-z0-9]')
        ? `${place} can only use letters, numbers, dots, dashes and underscores, and must start with a letter or number.`
        : `${place} isn't in the expected format.`
    case 'required':
      return `${place} is missing “${String(params.missingProperty)}”.`
    case 'additionalProperties':
      return `${place} has a setting LoomWatch doesn't recognise: “${String(params.additionalProperty)}”.`
    case 'type':
      return `${place} should be ${/^[aeiou]/.test(String(params.type)) ? 'an' : 'a'} ${String(params.type)}.`
    case 'const':
      return `${place} must be ${JSON.stringify(params.allowedValue)}.`
    case 'enum':
      return `${place} must be one of: ${(params.allowedValues as unknown[] | undefined)?.map((value) => JSON.stringify(value)).join(', ') ?? 'the allowed values'}.`
    case 'minimum':
      return `${place} must be ${String(params.limit)} or more.`
    case 'maximum':
      return `${place} must be ${String(params.limit)} or less.`
    case 'minItems':
      return `${place} needs at least ${String(params.limit)} item${params.limit === 1 ? '' : 's'}.`
    default:
      return `${place} ${error.message ?? 'is invalid'}.`
  }
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
  documentProblems: DocumentProblem[],
): void {
  // A half-written team may not have its lists yet; the schema errors already say so.
  const agents = Array.isArray(doc.agents) ? doc.agents : []
  const edges = Array.isArray(doc.edges) ? doc.edges : []
  const seenIds = new Set<string>()
  const names = new Map(agents.map((agent) => [agent.id, agent.name?.trim() || agent.id]))
  const named = (id: string) => `“${names.get(id) ?? id}”`
  for (const [agentIndex, agent] of agents.entries()) {
    if (seenIds.has(agent.id)) {
      documentProblems.push({ message: `Two agents use the same id “${agent.id}”. Give one of them a different id.`, agentId: agent.id, yamlPath: ['agents', agentIndex, 'id'] })
    }
    seenIds.add(agent.id)

    if (agent.kind === 'operator') {
      if (agent.id === doc.entrypoint) documentProblems.push({ message: 'Your review step can\'t come first. Start the team with an agent.', agentId: agent.id })
      if (!edges.some((edge) => edge.layer === 'configured')) documentProblems.push({ message: 'Your review step needs agents before and after it. Connect the agents first.', agentId: agent.id })
    }
  }

  // JSON Schema can ensure that an entrypoint looks like an identifier, but only the complete
  // document can tell whether that identifier belongs to one of its agents.
  if (doc.entrypoint && !seenIds.has(doc.entrypoint)) {
    documentProblems.push({
      message: `The starting agent “${doc.entrypoint}” isn't in this team any more. Choose another one.`,
      agentId: doc.entrypoint,
      yamlPath: ['entrypoint'],
    })
  }

  const configured = edges.filter((edge): edge is EdgeConfig => edge.layer === 'configured')
  const seenPairs = new Set<string>()
  for (const edge of configured) {
    if (edge.from === edge.to) {
      documentProblems.push({
        message: `${named(edge.from)} can't hand work to itself.`,
        edge: { from: edge.from, to: edge.to },
        yamlPath: ['edges'],
      })
    }
    const pairKey = `${edge.from}->${edge.to}`
    if (seenPairs.has(pairKey)) {
      documentProblems.push({
        message: `${named(edge.from)} → ${named(edge.to)} is connected twice.`,
        edge: { from: edge.from, to: edge.to },
        yamlPath: ['edges'],
      })
    }
    seenPairs.add(pairKey)
    if (!seenIds.has(edge.from) || !seenIds.has(edge.to)) {
      documentProblems.push({
        message: `A connection points at an agent that was removed (${edge.from} → ${edge.to}).`,
        edge: { from: edge.from, to: edge.to },
        yamlPath: ['edges'],
      })
    }
  }

  const cycle = findCycle(configured)
  if (cycle) {
    documentProblems.push({
      message: `The steps go round in a circle: ${named(cycle.from)} → ${named(cycle.to)} leads back to an earlier step.`,
      edge: cycle,
      yamlPath: ['edges'],
    })
  }

  // Pipeline mode (TEAM_CONFIG.md: a non-empty `edges` array selects it) requires the
  // entrypoint to be a source — no incoming configured edge.
  if (doc.entrypoint && configured.length > 0) {
    const incoming = configured.find((edge) => edge.to === doc.entrypoint)
    if (incoming) {
      documentProblems.push({
        message: `${named(doc.entrypoint)} starts the team, so nothing can hand work to it.`,
        agentId: doc.entrypoint,
        yamlPath: ['entrypoint'],
      })
    }
  }
}

/**
 * Compiles the daemon-served schema once (§9.2: "fetch it once at load; do not bundle a copy
 * into the UI"). The returned function is cheap to call on every edit — ajv's compiled
 * validator is a plain function call, no re-parsing of the schema.
 */
export function compileTeamValidator(schema: object, Ajv: typeof Ajv2020): TeamValidator {
  const ajv = new Ajv({ allErrors: true, strict: false })
  const validate = ajv.compile(schema)

  return (doc: TeamDocument): ValidationResult => {
    const fieldProblemsByAgent = new Map<string, AgentFieldProblems>()
    const documentProblems: DocumentProblem[] = []

    const schemaValid = validate(doc) as boolean
    for (const error of validate.errors ?? []) {
      applySchemaError(doc, error, fieldProblemsByAgent, documentProblems)
    }
    applySemanticRules(doc, documentProblems)

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

/**
 * [`compileTeamValidator`] with ajv loaded on demand. ajv and its URI parser are a fifth of the
 * app's code and only matter once the schema has arrived — which is already asynchronous — so they
 * are kept out of the bundle the first screen waits for.
 */
export async function loadTeamValidator(schema: object): Promise<TeamValidator> {
  const { default: Ajv } = await import('ajv/dist/2020')
  return compileTeamValidator(schema, Ajv)
}
