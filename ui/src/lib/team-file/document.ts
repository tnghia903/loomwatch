import { type Document, isMap, isScalar, isSeq, parseDocument, stringify } from 'yaml'

import type { AgentConfig, BriefEntryConfig, DeliverConfig, EdgeConfig, ScheduleConfig, TeamDocument } from './types'

/** The document could not be parsed as YAML, or does not shape up as a team file. */
export class TeamFileParseError extends Error {
  /** `yaml` when the text is not YAML at all; `shape` when it is YAML but not a team. */
  readonly kind: 'yaml' | 'shape'

  constructor(message: string, kind: 'yaml' | 'shape' = 'yaml') {
    super(message)
    this.kind = kind
  }
}

const TEAM_KEYS = ['schemaVersion', 'agents', 'entrypoint'] as const

/**
 * Refuses YAML that parses but is not a team: a stray `docker-compose.yml` or a notes file in the
 * teams folder. Everything downstream reads `agents` as a list, so letting such a file through
 * made the editor crash instead of saying what was wrong with it. A half-written team (a
 * `schemaVersion` and no agents yet) still opens, so its problems can be shown and fixed.
 */
function assertTeamShape(doc: Document): void {
  const root = doc.contents
  if (root === null || (isScalar(root) && (root.value === null || root.value === ''))) {
    throw new TeamFileParseError('The file is empty, so there is no team in it.', 'shape')
  }
  if (!isMap(root) || !TEAM_KEYS.some((key) => root.has(key))) {
    throw new TeamFileParseError('It doesn’t describe a team. A team file lists its agents under “agents:”.', 'shape')
  }
  const agents = root.get('agents', true)
  if (agents !== undefined && !isSeq(agents)) {
    throw new TeamFileParseError('Its “agents:” entry isn’t a list, so the agents can’t be read.', 'shape')
  }
  const edges = root.get('edges', true)
  if (edges !== undefined && !isSeq(edges)) {
    throw new TeamFileParseError('Its “edges:” entry isn’t a list, so the connections between agents can’t be read.', 'shape')
  }
}

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
    assertTeamShape(doc)
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
    const snapshot = this.doc.toJS({ mapAsMap: false }) as TeamDocument
    if (Array.isArray(snapshot?.agents)) snapshot.agents = snapshot.agents.map((agent) => agent.kind === 'operator' ? { ...agent, name: agent.name || 'You' } : agent)
    return snapshot
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

  setResponder(agentId: string): void {
    this.doc.set('responder', agentId)
  }

  clearResponder(): void {
    this.doc.delete('responder')
  }

  /** Unset `entrypoint` (§5.4: deleting it with 2+ agents left picks no automatic survivor). */
  clearEntrypoint(): void {
    this.doc.delete('entrypoint')
  }

  setSchedule(schedule: ScheduleConfig): void {
    this.doc.set('schedule', this.doc.createNode(schedule))
  }

  /** Remove the `schedule` block: the team runs only when someone asks it to. */
  clearSchedule(): void {
    this.doc.delete('schedule')
  }

  /** Set the team-wide `deliver` block, or remove it with `null` (ADR 0038). */
  setDeliver(deliver: DeliverConfig | null): void {
    if (deliver) this.doc.set('deliver', this.doc.createNode(deliver))
    else this.doc.delete('deliver')
  }

  /**
   * Add one Brief entry to `memory.brief`, creating the block if the team has none.
   *
   * The Markdown file itself is written by `PUT /api/memory/file`; this is the other half, and it
   * goes through the document like every other executable change so the operator saves it
   * explicitly and sees it in the YAML preview. Adding the same path twice is refused rather than
   * silently duplicated — two identical entries would be supplied twice and charged twice against
   * the packet budget.
   */
  addBriefEntry(entry: BriefEntryConfig): void {
    const existing = this.doc.get('memory')
    if (!isMap(existing)) {
      this.doc.set('memory', this.doc.createNode({ brief: [entry] }))
      return
    }
    const brief = existing.get('brief')
    if (!isSeq(brief)) {
      existing.set('brief', this.doc.createNode([entry]))
      return
    }
    if (brief.items.some((item) => isMap(item) && item.get('path') === entry.path)) {
      throw new TeamFileParseError(`the Brief already includes ${entry.path}`)
    }
    brief.add(this.doc.createNode(entry))
  }

  /**
   * Add one `memory.inherits` entry, or narrow an existing one to `appliesTo`.
   *
   * This is executable configuration in ADR 0012's sense — it changes what the daemon sends — so
   * it lives in the team file and goes through the document model like every other such change.
   * The card's *position* stays in the layout sidecar.
   *
   * `appliesTo: undefined` means the whole team, and that is written as the **absence** of the
   * key rather than as a list of every agent id: a team that later gains an agent should supply
   * the inherited memory to it too, which a frozen list would silently stop doing.
   */
  addMemoryInherit(entry: { team?: string; pack?: string; appliesTo?: string[] }): void {
    if ((entry.team === undefined) === (entry.pack === undefined)) {
      throw new TeamFileParseError('an inherits entry names exactly one of a team or a pack')
    }
    const existing = this.doc.get('memory')
    if (!isMap(existing)) {
      this.doc.set('memory', this.doc.createNode({ inherits: [entry] }))
      return
    }
    const inherits = existing.get('inherits')
    if (!isSeq(inherits)) {
      existing.set('inherits', this.doc.createNode([entry]))
      return
    }
    const found = inherits.items.find((item) => isMap(item) && matchesInherit(item, entry))
    if (!isMap(found)) {
      inherits.add(this.doc.createNode(entry))
      return
    }
    if (entry.appliesTo === undefined) {
      found.delete('appliesTo')
      return
    }
    found.set('appliesTo', this.doc.createNode(entry.appliesTo))
  }

  /** Drop one `memory.inherits` entry, leaving the origin team and any pack folder alone. */
  removeMemoryInherit(key: { team?: string; pack?: string }): void {
    const memory = this.doc.get('memory')
    if (!isMap(memory)) return
    const inherits = memory.get('inherits')
    if (!isSeq(inherits)) return
    const index = inherits.items.findIndex((item) => isMap(item) && matchesInherit(item, key))
    if (index < 0) return
    inherits.delete(index)
    if (inherits.items.length === 0) memory.delete('inherits')
  }

  /**
   * Stop supplying one inherited Brief entry, by adding its path to the entry's `exclude`.
   *
   * The only control a borrowing team has over another team's Brief: it cannot edit the file —
   * that belongs to the origin team — so declining one entry is the whole of it. Excluding the
   * same path twice is a no-op rather than a duplicate.
   */
  excludeInheritedBrief(key: { team?: string; pack?: string }, path: string): void {
    const memory = this.doc.get('memory')
    if (!isMap(memory)) throw new TeamFileParseError('this team inherits nothing')
    const inherits = memory.get('inherits')
    if (!isSeq(inherits)) throw new TeamFileParseError('this team inherits nothing')
    const found = inherits.items.find((item) => isMap(item) && matchesInherit(item, key))
    if (!isMap(found)) {
      throw new TeamFileParseError(`this team does not inherit from ${key.team ?? key.pack ?? 'that source'}`)
    }
    const exclude = found.get('exclude')
    if (!isSeq(exclude)) {
      found.set('exclude', this.doc.createNode([path]))
      return
    }
    if (exclude.items.some((item) => (isScalar(item) ? item.value === path : item === path))) return
    exclude.add(path)
  }

  /** Remove a Brief entry by path. The Markdown file on disk is left alone. */
  removeBriefEntry(path: string): void {
    const memory = this.doc.get('memory')
    if (!isMap(memory)) return
    const brief = memory.get('brief')
    if (!isSeq(brief)) return
    const index = brief.items.findIndex((item) => isMap(item) && item.get('path') === path)
    if (index < 0) return
    brief.delete(index)
  }

  /**
   * Set or clear one key of an agent's per-agent `memory:` override.
   *
   * The Inspector's Behaviour zone writes `memory.brief` (does this agent read the Brief at all)
   * and `memory.deliverAs` (harness-native file in the managed workspace, or packet only so the
   * agent keeps its declared `cwd`). Keys are written one at a time rather than as a replacement
   * map so a sibling key — and any comment the operator left on it — survives the edit, and the
   * block is removed entirely when its last key is cleared rather than left as an empty mapping.
   */
  setAgentMemory(agentId: string, field: 'brief' | 'deliverAs', value: boolean | 'native-file' | 'packet-only' | undefined): void {
    const index = this.requireAgentIndex(agentId)
    const agent = this.doc.getIn(['agents', index])
    if (!isMap(agent)) {
      throw new TeamFileParseError(`agent ${agentId} is not a mapping`)
    }
    const existing = agent.get('memory')
    if (value === undefined) {
      if (!isMap(existing)) return
      existing.delete(field)
      if (existing.items.length === 0) agent.delete('memory')
      return
    }
    if (!isMap(existing)) {
      agent.set('memory', this.doc.createNode({ [field]: value }))
      return
    }
    existing.set(field, value)
  }

  /** Set one field on an existing agent, e.g. `setAgentField('reviewer', 'model', 'x')`. */
  setAgentField<K extends keyof AgentConfig>(agentId: string, field: K, value: AgentConfig[K]): void {
    const index = this.requireAgentIndex(agentId)
    // Optional fields must be removed, not serialized as YAML null. In particular, removing
    // an agent's final required skill must leave a valid team that can run without that skill.
    if (value === undefined) this.doc.deleteIn(['agents', index, field])
    else this.doc.setIn(['agents', index, field], value)
  }

  addAgent(agent: AgentConfig): void {
    const agents = this.ensureSeq('agents')
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
    const edges = this.ensureSeq('edges')
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

  /**
   * The list to add to, created when the key is absent. The daemon defaults a missing `edges` to
   * none, and `parse` admits a half-written team with no `agents` yet, so the first connection or
   * agent in such a file has nowhere to go until this writes the key. A key that is present but not
   * a list was already refused by `parse`.
   */
  private ensureSeq(key: 'agents' | 'edges') {
    if (!this.doc.has(key)) this.doc.set(key, this.doc.createNode([]))
    return this.requireSeq(key)
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

/**
 * Whether one `memory.inherits` item is the entry a key names.
 *
 * Matched on `team` or `pack` and never on position: the operator reorders the list, and an index
 * would make "exclude this inherited entry" act on whichever source happened to be second.
 */
function matchesInherit(item: unknown, key: { team?: string; pack?: string }): boolean {
  if (!isMap(item)) return false
  if (key.team !== undefined) return item.get('team') === key.team
  if (key.pack !== undefined) return item.get('pack') === key.pack
  return false
}
