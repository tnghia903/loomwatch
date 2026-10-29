import { Check, Plus, X } from '../ui/icon'
import { Fragment, useEffect, useState } from 'react'

import { KIND_LABEL, RELATION, type CapabilityKind } from '../../lib/composer-layout/types'
import { fetchCapabilityDetails, type CapabilityDetails, type DetectedCapability, type SkillRoute } from '../../lib/library/client'
import { notionPageUrl } from '../../lib/notion/connection'
import { EntityGlyph } from '../ui/glyphs'
import { InlineMarkdown } from '../ui/Markdown'

export interface InspectedCapability {
  item: DetectedCapability
  kind: CapabilityKind
}

interface CapabilityInspectorProps extends InspectedCapability {
  placed: boolean
  connectedAgents: readonly string[]
  /** The team's agents, each with the model it runs on, in words. */
  agents?: readonly { id: string; name: string; model: string; connected: boolean }[]
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
const ROUTE_NOTE: Record<SkillRoute, string> = {
  native: 'It is delivered to each connected agent’s skills folder, and its prompt points at it.',
  inline: 'Its text goes into each connected agent’s prompt, with a note mapping what it assumes onto what the agent actually has.',
}

/**
 * What connecting means for each kind, in the words the run will bear out (ADR 0012, 0029).
 * `knowledge` is a folder or file the operator chose (ADR 0042); memory has no picker.
 */
const PICKER_NOTE: Record<CapabilityKind, string> = {
  skill: 'Connect this skill to require it in the next run.',
  tool: 'This tool was set up in an AI app, and LoomWatch doesn’t read AI apps’ settings, so a connected agent is told it isn’t available.',
  knowledge: 'Connect every agent that should read this. They share the one source, and each is told it in its own instructions.',
}

const DELIVERY_NOTE: Record<CapabilityKind, string> = {
  skill: 'Save the team to keep these connections. LoomWatch delivers the skill to every connected agent when the run starts.',
  tool: 'Save the team to keep these connections. Take the tool off the canvas once no agent needs it.',
  knowledge: 'Save the team to keep these connections. Each connected agent may read it wherever that agent works, and never changes it. A run fails up front if it has gone or holds nothing readable.',
}

/** What connecting a Notion page means (ADR 0050). */
const NOTION_DELIVERY_NOTE = 'Save the team to keep these connections. When a run starts, LoomWatch reads the page through your Notion connection and gives its text to each connected agent; no agent gets the connection itself. A run stops before it begins if Notion is not connected or can’t open the page.'

/** Plain-words heading for the portability classification. */
const KIND_NOTE: Record<string, string> = {
  artifact: 'Produces a deliverable',
  behavior: 'Governs how the agent works',
  portable: 'Assumes nothing about where it runs',
}

/** Read-only provenance and planning details for a locally detected capability. */
export function CapabilityInspector({ item, kind, placed, connectedAgents, agents = [], onToggleAgent, readOnly = false, onAdd, onReveal, onClose }: CapabilityInspectorProps) {
  const glyph = kind === 'knowledge' ? 'source' : kind
  const [retry, setRetry] = useState(0)
  const [detailState, setDetailState] = useState<{ id: string; details: CapabilityDetails | null; error: string | null }>({ id: '', details: null, error: null })
  // Skills load their SKILL.md and memory loads what it holds; a tool has nothing to read, and a
  // knowledge card that is not memory names nothing the daemon can read (ADR 0036).
  const readsDetails = kind === 'skill' || (kind === 'knowledge' && Boolean(item.memory))
  // What an agent can be connected to through the team file (ADR 0012, 0029, 0042). Memory is
  // wired through `memory.inherits` on the canvas instead, and knowledge with no path names
  // nothing, so neither has a picker here.
  const chosen = kind === 'knowledge' && Boolean(item.path || item.notion)
  // A Notion page (ADR 0050) is chosen like a file, but it lives in Notion, not at a path.
  const notionPage = kind === 'knowledge' ? item.notion?.page : undefined
  const wireable = kind !== 'knowledge' || chosen
  const noun = kind === 'skill' ? 'skill' : kind === 'tool' ? 'tool' : chosen ? item.source.toLowerCase().replace(/^(added|linked) /, '') : 'source'
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
  return (
    <aside className="panel right top e1 lw-inspector capability-inspector" aria-label={`${KIND_LABEL[kind]} details`} role="region" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
      <div className="inspector-glass" aria-hidden="true" />
      <div className="inspector-scroll">
        <header className="insp-head">
          <span className="node-glyph"><EntityGlyph kind={glyph} size={18} /></span>
          <span className="insp-text">
            <div className="insp-title t-title">{item.name}</div>
            {/* A folder or file card's id is its path again, which Details already shows. */}
            {!chosen && <div className="insp-id t-mono">{item.id}</div>}
            <div className="insp-status t-micro"><i className={item.status === 'Local only' ? 'ready-dot local' : 'ready-dot'} aria-hidden="true" /> {item.status}</div>
          </span>
          <button type="button" className="iconbtn" onClick={onClose} title="Close (Esc)" aria-label="Close capability details"><X size={15} aria-hidden="true" /></button>
        </header>

        <div className="zone">
          <div className="zone-head t-micro">Details</div>
          <p className="capability-description t-body"><InlineMarkdown>{item.detail}</InlineMarkdown></p>
          <dl className="proc-list t-meta capability-facts">
            <dt>Type</dt><dd>{chosen ? item.source : KIND_LABEL[kind]}</dd>
            {notionPage
              ? <><dt>Page</dt><dd><a className="link" href={notionPageUrl(notionPage)} target="_blank" rel="noreferrer">Open in Notion</a></dd></>
              : chosen ? <><dt>Path</dt><dd className="t-mono-sm" title={item.path}>{item.path}</dd></> : <><dt>Source</dt><dd>{item.source}</dd></>}
            <dt>Relation</dt><dd>{RELATION[kind]}{chosen ? ' · read only' : ''}</dd>
          </dl>
        </div>

        {kind === 'skill' && portability && (
          <div className="zone capability-portability">
            <div className="zone-head t-micro">Portability</div>
            <p className="capability-description t-body">{KIND_NOTE[portability.kind] ?? portability.kind}.</p>
            {portability.needs.length === 0 ? (
              <p className="capability-description t-meta">Nothing in its text assumes a facility an agent may lack.</p>
            ) : (
              <>
                <p className="capability-description t-meta">Its instructions assume these. Each line below is the sentence that says so.</p>
                <dl className="proc-list t-meta capability-needs">
                  {portability.needs.map((need) => (
                    <Fragment key={need}>
                      <dt>{need}</dt>
                      <dd><InlineMarkdown>{portability.evidence.find((item) => item.need === need)?.line ?? '—'}</InlineMarkdown></dd>
                    </Fragment>
                  ))}
                </dl>
              </>
            )}
            {portability.route && <p className="capability-description t-meta">{ROUTE_NOTE[portability.route]}</p>}
          </div>
        )}

        {kind === 'knowledge' && !item.memory && !chosen && (
          <div className="zone capability-knowledge-moved">
            <div className="zone-head t-micro">Not delivered</div>
            <p className="capability-description t-meta">Knowledge is now a folder or file you choose, so this card no longer reaches an agent. Use Add folder… or Add file…, connect the new card to the agents that need it, then remove this one.</p>
          </div>
        )}

        {wireable && (
          <div className="zone capability-agent-picker">
            <div className="zone-head t-micro">Use with agents</div>
            <p className="capability-description t-meta">{PICKER_NOTE[kind]}</p>
            {agents.length ? agents.map((agent) => {
              return (
                <label key={agent.id} className="capability-agent-option">
                  <input type="checkbox" aria-label={`Use ${item.name} with ${agent.name} (${agent.model})`} checked={agent.connected} disabled={readOnly || !onToggleAgent} onChange={(event) => onToggleAgent?.(agent.id, event.target.checked)} />
                  <span><strong>{agent.name}</strong><small>{agent.model}</small></span>
                  {agent.connected && <span className="capability-required">{kind === 'skill' ? 'Required' : kind === 'knowledge' ? 'Reads it' : 'Connected'}</span>}
                </label>
              )
            }) : <p className="hint t-meta">Add an agent to your team to connect this {noun}.</p>}
            <p className="hint t-meta">{notionPage ? NOTION_DELIVERY_NOTE : DELIVERY_NOTE[kind]}</p>
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
                  : 'Read locally on demand. A live team’s kept notes are listed in its Memory panel.'}
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
          <span className="hint t-meta">{wireable ? `Placing a card alone delivers nothing. Connect the ${noun} to an agent above or on the canvas.` : item.memory ? 'Connect this memory to an agent, or to the Prompt node for the whole team, on the canvas.' : 'This card delivers nothing, connected or not.'}</span>
        </div>
      </div>
    </aside>
  )
}
