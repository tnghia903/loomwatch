import { Check, Plus, X } from 'lucide-react'
import { Fragment, useEffect, useState } from 'react'

import { KIND_LABEL, RELATION, type CapabilityKind } from '../../lib/composer-layout/types'
import { fetchCapabilityDetails, type CapabilityDetails, type DetectedCapability, type SkillRoute } from '../../lib/library/client'
import { EntityGlyph } from '../ui/glyphs'

export interface InspectedCapability {
  item: DetectedCapability
  kind: CapabilityKind
}

interface CapabilityInspectorProps extends InspectedCapability {
  placed: boolean
  connectedAgents: readonly string[]
  /**
   * `harnessId` is the daemon's own id for the agent's harness (`claude`, `codex`, …), which is
   * the key `portability.routes` is stated in. The display `harness` name cannot serve: it is
   * "Harness not detected" when the daemon found nothing on the PATH, and a route keyed on a
   * sentence would silently stop resolving.
   */
  agents?: readonly { id: string; name: string; harness: string; harnessId?: string | null; connected: boolean }[]
  onToggleAgent?: (id: string, connected: boolean) => void
  readOnly?: boolean
  onAdd: () => void
  onReveal: () => void
  onClose: () => void
}

/**
 * What each route means for this connection, in the words the run will bear out (ADR 0021).
 *
 * `native` is not "the instructions are in the prompt" — that is the whole point of the route, and
 * saying otherwise here would promise something the run does not do.
 */
const ROUTE_NOTE: Record<SkillRoute, (harness: string) => string> = {
  native: () => 'native — delivered to this harness’s own skill directory, and the prompt points at it',
  inline: (harness) => `in-prompt, translated for ${harness}`,
  blocked: () => 'blocked — LoomWatch knows no project skill directory for this harness',
}

/** What connecting means for each kind, in the words the run will bear out (ADR 0012, 0029). */
const PICKER_NOTE: Record<CapabilityKind, string> = {
  skill: 'Connect this skill to require it in the next run. Its discovery source can differ from the agent’s harness.',
  knowledge: 'Connect this source to supply its contents to an agent in the next run.',
  tool: 'Connect this tool to give an agent its MCP server in the next run. Its config source can differ from the agent’s harness.',
}

const DELIVERY_NOTE: Record<CapabilityKind, string> = {
  skill: 'Save the team to keep these connections. LoomWatch delivers the bundle to every connected agent and adapts how the prompt introduces it: a harness that cannot be relied on to run the skill as written gets its text inlined with a note mapping what it assumes onto what that agent actually has.',
  knowledge: 'Save the team to keep these connections. Each connected agent gets the contents shown below in its prompt as source material, and the folder’s path. On Claude Code, LoomWatch also grants read access to that folder; other apps apply their own rules.',
  tool: 'Save the team to keep these connections. LoomWatch hands this MCP server to each connected agent’s app when the run starts, using your own server settings. On Claude Code it also allows the server’s tools; other apps apply their own rules. A run fails up front if an app cannot take the server.',
}

/** Plain-words heading for the portability classification. */
const KIND_NOTE: Record<string, string> = {
  artifact: 'Produces a deliverable',
  behavior: 'Governs how the agent works',
  portable: 'Assumes nothing about its harness',
}

/** Read-only provenance and planning details for a locally detected capability. */
export function CapabilityInspector({ item, kind, placed, connectedAgents, agents = [], onToggleAgent, readOnly = false, onAdd, onReveal, onClose }: CapabilityInspectorProps) {
  const glyph = kind === 'knowledge' ? 'source' : kind
  const [retry, setRetry] = useState(0)
  const [detailState, setDetailState] = useState<{ id: string; details: CapabilityDetails | null; error: string | null }>({ id: '', details: null, error: null })
  // Skills load their SKILL.md and knowledge sources load what they hold; a tool has nothing to read.
  const readsDetails = kind === 'skill' || kind === 'knowledge'
  // What an agent can be connected to through the team file (ADR 0012, 0029). Memory is wired
  // through `memory.inherits` on the canvas instead, so it has no picker here.
  const wireable = kind !== 'knowledge' || !item.memory
  const noun = kind === 'skill' ? 'skill' : kind === 'tool' ? 'tool' : 'source'
  useEffect(() => {
    if (!readsDetails) return
    let cancelled = false
    void fetchCapabilityDetails(item.id).then(
      (details) => { if (!cancelled) setDetailState({ id: item.id, details, error: null }) },
      (error: unknown) => { if (!cancelled) setDetailState({ id: item.id, details: null, error: error instanceof Error ? error.message : String(error) }) },
    )
    return () => { cancelled = true }
  }, [item.id, readsDetails, retry])
  const detailsLoading = readsDetails && detailState.id !== item.id
  const details = detailState.id === item.id ? detailState.details : null
  const detailsError = detailState.id === item.id ? detailState.error : null
  const portability = details?.portability ?? null
  /** The route this skill takes on one agent's harness, or `null` when the daemon cannot say. */
  const routeFor = (harnessId: string | null | undefined): SkillRoute | null =>
    (harnessId && portability?.routes[harnessId]) || null
  // A skill that produces a deliverable, whose own text leans on Claude, wired to an agent that is
  // not Claude — while a Claude agent sits unconnected in the same team. That is the one case
  // worth a nudge, and it is a suggestion rather than a rule: the operator may well want the
  // deliverable produced by the other agent, which is why the skill stays wired either way.
  //
  // `needs` must be non-empty. An artifact skill that assumes nothing works the same everywhere,
  // and suggesting a move for it would be advice with no reason behind it.
  const claudeAgent = agents.find((agent) => agent.harnessId === 'claude')
  const suggestion =
    portability?.kind === 'artifact' &&
    portability.needs.length > 0 &&
    claudeAgent &&
    !claudeAgent.connected &&
    agents.some((agent) => agent.connected && agent.harnessId !== 'claude')
      ? claudeAgent
      : null
  return (
    <aside className="panel right top e1 lw-inspector capability-inspector" aria-label={`${KIND_LABEL[kind]} details`} role="region" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
      <div className="inspector-glass" aria-hidden="true" />
      <div className="inspector-scroll">
        <header className="insp-head">
          <span className="node-glyph"><EntityGlyph kind={glyph} size={18} /></span>
          <span className="insp-text">
            <div className="insp-title t-title">{item.name}</div>
            <div className="insp-id t-mono">{item.id}</div>
            <div className="insp-status t-micro"><i className={item.status === 'Local only' ? 'ready-dot local' : 'ready-dot'} aria-hidden="true" /> {item.status}</div>
          </span>
          <button type="button" className="iconbtn" onClick={onClose} title="Close (Esc)" aria-label="Close capability details"><X size={15} aria-hidden="true" /></button>
        </header>

        <div className="zone">
          <div className="zone-head t-micro">Details</div>
          <p className="capability-description t-body">{item.detail}</p>
          <dl className="proc-list t-meta capability-facts">
            <dt>Type</dt><dd>{KIND_LABEL[kind]}</dd>
            <dt>Source</dt><dd>{item.source}</dd>
            <dt>Relation</dt><dd>{RELATION[kind]}</dd>
          </dl>
        </div>

        {kind === 'skill' && portability && (
          <div className="zone capability-portability">
            <div className="zone-head t-micro">Portability</div>
            <p className="capability-description t-body">{KIND_NOTE[portability.kind] ?? portability.kind}.</p>
            {portability.needs.length === 0 ? (
              <p className="capability-description t-meta">Nothing in its text assumes a facility only one harness has, so every harness gets it the same way.</p>
            ) : (
              <>
                <p className="capability-description t-meta">Its instructions assume these. Each line below is the sentence that says so.</p>
                <dl className="proc-list t-meta capability-needs">
                  {portability.needs.map((need) => (
                    <Fragment key={need}>
                      <dt>{need}</dt>
                      <dd>{portability.evidence.find((item) => item.need === need)?.line ?? '—'}</dd>
                    </Fragment>
                  ))}
                </dl>
              </>
            )}
          </div>
        )}

        {wireable && (
          <div className="zone capability-agent-picker">
            <div className="zone-head t-micro">Use with agents</div>
            <p className="capability-description t-meta">{PICKER_NOTE[kind]}</p>
            {agents.length ? agents.map((agent) => {
              const route = routeFor(agent.harnessId)
              return (
                <label key={agent.id} className="capability-agent-option">
                  <input type="checkbox" aria-label={`Use ${item.name} with ${agent.name} (${agent.harness})`} checked={agent.connected} disabled={readOnly || !onToggleAgent} onChange={(event) => onToggleAgent?.(agent.id, event.target.checked)} />
                  <span><strong>{agent.name}</strong><small>{agent.harness}{route ? ` · ${ROUTE_NOTE[route](agent.harness)}` : ''}</small></span>
                  {agent.connected && <span className="capability-required">{kind === 'skill' ? 'Required' : 'Connected'}</span>}
                </label>
              )
            }) : <p className="hint t-meta">Add an agent to your team to connect this {noun}.</p>}
            {suggestion && (
              <p className="capability-suggestion t-meta">
                <span>This skill produces a deliverable and its own text leans on Claude ({portability?.needs.join(', ')}). {suggestion.name} runs Claude Code, where those assumptions hold.</span>
                <button type="button" className="btn" disabled={readOnly || !onToggleAgent} onClick={() => onToggleAgent?.(suggestion.id, true)}>Connect to {suggestion.name}</button>
              </p>
            )}
            <p className="hint t-meta">{DELIVERY_NOTE[kind]}</p>
          </div>
        )}

        {readsDetails && (
          <div className="zone capability-instructions">
            <div className="zone-head t-micro">{kind === 'skill' ? 'Skill definition' : 'Contents'}</div>
            {detailsLoading && <div className="capability-definition-loading" role="status"><span className="skel-bar" /><span className="skel-bar" /><span className="skel-bar" /><span className="visually-hidden">{kind === 'skill' ? 'Loading skill definition…' : 'Loading contents…'}</span></div>}
            {detailsError && (
              <div className="inline-error" role="alert">
                <span className="msg t-body">{kind === 'skill' ? 'Couldn’t load this skill’s definition.' : 'Couldn’t load what this source holds.'}</span>
                <span className="detail t-meta">{detailsError}</span>
                <span><button type="button" className="btn" onClick={() => { setDetailState({ id: '', details: null, error: null }); setRetry((value) => value + 1) }}>Retry</button></span>
              </div>
            )}
            {details && details.definitions.length === 0 && <p className="capability-description t-meta">{kind === 'skill' ? 'No readable SKILL.md definition was found.' : 'Nothing readable was found for this source.'}</p>}
            {details?.definitions.map((definition) => (
              <section key={`${definition.source}:${definition.path}`} className="capability-definition-source">
                <header><span className="t-body-m">{definition.source}</span><span className="t-mono-sm" title={definition.path}>{definition.path}</span></header>
                <pre className="capability-definition t-mono-sm">{definition.content}</pre>
              </section>
            ))}
            {!detailsLoading && !detailsError && details && (
              <span className="hint t-meta">
                {kind === 'skill'
                  ? `Loaded locally on demand from ${details.definitions.length === 1 ? 'this skill file' : `${details.definitions.length} matching skill files`}.`
                  : item.memory
                    ? 'Read locally on demand. A live team’s kept notes are listed in its Memory panel.'
                    // ADR 0012: a knowledge source that is not memory has no delivery contract yet.
                    // ADR 0029: the snapshot shown here is the one a connected agent's prompt carries.
                    : 'Read locally on demand. An agent connected to this source receives exactly these contents in its opening prompt.'}
              </span>
            )}
          </div>
        )}

        <div className="zone">
          <div className="zone-head t-micro">Canvas</div>
          {placed ? (
            <div className="capability-placement">
              <span className="capability-placement-icon"><Check size={14} aria-hidden="true" /></span>
              <span><b className="t-body-m">Added to this canvas</b><span className="t-meta">{connectedAgents.length > 0 ? `Connected to ${connectedAgents.join(', ')}` : 'Not connected to an agent yet'}</span></span>
            </div>
          ) : (
            <p className="capability-description t-meta">{connectedAgents.length ? `Required by ${connectedAgents.join(', ')}. Add its card to see these connections on the canvas.` : 'Add this capability to express planned access, then connect an agent to it.'}</p>
          )}
          <button type="button" className="btn btn-primary capability-action" disabled={readOnly && !placed} onClick={placed ? onReveal : onAdd}>
            {placed ? 'Show on canvas' : <><Plus size={14} aria-hidden="true" /> Add to canvas</>}
          </button>
          <span className="hint t-meta">{wireable ? `Placing a card alone delivers nothing. Connect the ${noun} to an agent above or on the canvas.` : 'Connect this memory to an agent, or to the Prompt node for the whole team, on the canvas.'}</span>
        </div>
      </div>
    </aside>
  )
}
