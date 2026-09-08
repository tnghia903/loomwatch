import { type Document, isMap, isSeq, parseDocument, stringify } from 'yaml'

import type { AgentConfig, BudgetConfig, EdgeConfig, GuardsConfig, TeamDocument } from './types'

/** The document could not be parsed as YAML, or does not shape up as a team file. */
export class TeamFileParseError extends Error {}

// Wraps a CST-preserving yaml.Document, not a plain object, so untouched fields keep
// their original formatting, comments, and key order across a load/edit/save cycle.
export class TeamFileModel {
  private readonly doc: Document

  private constructor(doc: Document) {
    this.doc = doc
  }

  static parse(source: string): TeamFileModel {
    const doc = parseDocument(source, { merge: false })
    if (doc.errors.length > 0) {
      throw new TeamFileParseError(doc.errors.map((error) => error.message).join('; '))
    }
    return new TeamFileModel(doc)
  }

  /** §10.2: creates an in-memory, intentionally incomplete document; it is not written until
   * its first agent makes it schema-valid. */
  static create(id: string, name: string): TeamFileModel {
    return TeamFileModel.parse(
      stringify(
        { schemaVersion: 1, id, name, entrypoint: '', agents: [], edges: [] },
        { lineWidth: 0 },
      ),
    )
  }

  /** A plain-JS snapshot for rendering. Mutating the result does not affect the document. */
  snapshot(): TeamDocument {
    return this.doc.toJS({ mapAsMap: false }) as TeamDocument
  }

  /** Serialize back to YAML text. Untouched nodes keep their original formatting. */
  toYaml(): string {
    return this.doc.toString({ lineWidth: 0 })
  }

  setName(name: string): void {
    this.doc.set('name', name)
  }

  setEntrypoint(agentId: string): void {
    this.doc.set('entrypoint', agentId)
  }

  /** Unset `entrypoint` (§5.4: deleting it with 2+ agents left picks no automatic survivor). */
  clearEntrypoint(): void {
    this.doc.delete('entrypoint')
  }

  setTeamBudget(budget: BudgetConfig | undefined): void {
    if (budget === undefined) {
      this.doc.delete('budget')
      return
    }
    this.doc.set('budget', this.doc.createNode(budget))
  }

  setGuards(guards: GuardsConfig | undefined): void {
    if (guards === undefined) {
      this.doc.delete('guards')
      return
    }
    this.doc.set('guards', this.doc.createNode(guards))
  }

  /** Set one field on an existing agent, e.g. `setAgentField('reviewer', 'model', 'x')`. */
  setAgentField<K extends keyof AgentConfig>(agentId: string, field: K, value: AgentConfig[K]): void {
    const index = this.requireAgentIndex(agentId)
    this.doc.setIn(['agents', index, field], value)
  }

  addAgent(agent: AgentConfig): void {
    const agents = this.requireSeq('agents')
    if (agents.items.some((item) => isMap(item) && item.get('id') === agent.id)) {
      throw new TeamFileParseError(`agent id ${agent.id} already exists`)
    }
    agents.add(this.doc.createNode(agent))
  }

  removeAgent(agentId: string): void {
    const index = this.requireAgentIndex(agentId)
    this.doc.deleteIn(['agents', index])
  }

  addEdge(edge: EdgeConfig): void {
    const edges = this.requireSeq('edges')
    edges.add(this.doc.createNode(edge))
  }

  removeEdge(from: string, to: string): void {
    const edges = this.requireSeq('edges')
    const index = edges.items.findIndex(
      (item) => isMap(item) && item.get('from') === from && item.get('to') === to,
    )
    if (index === -1) {
      throw new TeamFileParseError(`edge ${from} -> ${to} does not exist`)
    }
    this.doc.deleteIn(['edges', index])
  }

  private requireSeq(key: 'agents' | 'edges') {
    const node = this.doc.get(key, true)
    if (!isSeq(node)) {
      throw new TeamFileParseError(`team document has no ${key} sequence`)
    }
    return node
  }

  private requireAgentIndex(agentId: string): number {
    const agents = this.requireSeq('agents')
    const index = agents.items.findIndex((item) => isMap(item) && item.get('id') === agentId)
    if (index === -1) {
      throw new TeamFileParseError(`agent ${agentId} does not exist`)
    }
    return index
  }
}
