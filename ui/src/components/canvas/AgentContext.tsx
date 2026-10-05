import { Box, BookOpen, Check, FilePlus2, FolderPlus, Puzzle, ScrollText, Wrench, X } from 'lucide-react'
import { useRef, useState } from 'react'

import { uniqueLabel } from '../../lib/composer-layout/types'
import { chosenKnowledge } from '../../lib/knowledge/chosen'
import { addTeamFile } from '../../lib/knowledge/client'
import type { AgentPlace, PlaceLink } from '../../lib/team-file/agentPlace'
import type { AgentConfig, CapabilityRef } from '../../lib/team-file/types'
import { SectionHead } from '../ui/SectionHead'
import { FolderPicker } from './FolderPicker'

export interface AgentContextProps {
  agent: AgentConfig
  place?: AgentPlace
  pipeline?: boolean
  /** How many Brief entries this team supplies, so the zone never promises what does not exist. */
  briefCount?: number
  /** Other teams' memory and imported packs this agent is supplied, by display name. */
  inheritedMemory?: readonly string[]
  readOnly?: boolean
  onPromoteEntrypoint?: () => void
  onAllowRecruitingChange?: (allow: boolean) => void
  onMemoryBriefChange?: (readsBrief: boolean) => void
  onRemoveCapability?: (capability: CapabilityRef) => void
  /** The open team file, relative to the teams root. An added file is copied beside it, so a team
      that has never been saved cannot take one yet. */
  teamPath?: string | null
  /** Connect knowledge the operator chose (ADR 0035). Called once per pick with everything added,
      so several files added together cannot overwrite each other. */
  onAddKnowledge?: (added: CapabilityRef[]) => void
  /** The heading's look in the panel that shows it. */
  headClassName?: string
}

const KIND: Record<CapabilityRef['kind'], { Icon: typeof Puzzle; label: string }> = {
  skill: { Icon: Puzzle, label: 'Skill · its instructions are supplied' },
  knowledge: { Icon: Box, label: 'Knowledge · supplied as source material' },
  tool: { Icon: Wrench, label: 'Tool · available while it works' },
}

/**
 * CONTEXT — what one agent is given when it starts: its place in the team, the team Brief, and
 * everything connected to it. It replaced the BEHAVIOUR zone (ADR 0034), whose five switches
 * either repeated the canvas, did nothing in team mode, or asked an operator to choose a
 * delivery channel by its implementation name.
 *
 * The copy keeps docs/TEAM_MEMORY.md's rule: things are *supplied*; the agent is never said to
 * know, remember or have read them.
 *
 * It shows state, not prose: a pipeline step is a short thread from who hands it work to who it
 * hands work to, and what it is given is a row of chips, dashed like their cards on the canvas.
 * The sentences that explain all this sit behind the heading's "?".
 */
export function AgentContext({ agent, place, pipeline = false, briefCount = 0, inheritedMemory = [], readOnly = false, onPromoteEntrypoint, onAllowRecruitingChange, onMemoryBriefChange, onRemoveCapability, teamPath, onAddKnowledge, headClassName }: AgentContextProps) {
  const capabilities = agent.capabilities ?? []
  // A team with no Brief supplies nothing, so the switch may not read as "on".
  const readsBrief = agent.memory?.brief !== false && briefCount > 0
  const nothingConnected = capabilities.length === 0 && inheritedMemory.length === 0
  const canAdd = Boolean(onAddKnowledge) && !readOnly
  const [picking, setPicking] = useState(false)
  const [adding, setAdding] = useState(false)
  const [notes, setNotes] = useState<{ text: string; failed: boolean }[]>([])
  const fileInput = useRef<HTMLInputElement>(null)
  const taken = () => new Set(capabilities.filter((capability) => capability.kind === 'knowledge').map((capability) => capability.name))

  const addFiles = async (files: readonly File[]) => {
    if (!teamPath || !onAddKnowledge || files.length === 0) return
    setAdding(true)
    const names = taken()
    const added: CapabilityRef[] = []
    const next: { text: string; failed: boolean }[] = []
    for (const file of files) {
      try {
        const stored = await addTeamFile(teamPath, file)
        added.push({ kind: 'knowledge', name: uniqueLabel(stored.name, names), path: stored.path })
        if (stored.note) next.push({ text: `${stored.name}: ${stored.note}`, failed: false })
      } catch (caught) {
        next.push({ text: `${file.name} was not added: ${caught instanceof Error ? caught.message : String(caught)}`, failed: true })
      }
    }
    if (added.length > 0) onAddKnowledge(added)
    setNotes(next)
    setAdding(false)
  }

  const entries = `${briefCount} ${briefCount === 1 ? 'entry' : 'entries'}`
  const broken = capabilities.filter((capability) => capability.kind === 'knowledge' && !capability.path && !capability.notion)
  return (
    <div className="agent-context">
      <SectionHead title="Context" className={headClassName} explain={<>
        {place && <div>The agent is told its place in the team at the start of every run.</div>}
        <div>{briefCount > 0 ? `The team Brief (${entries}) is supplied at the start of every session. Switch it off to leave this agent out.` : 'No team Brief yet. Notes you add in Memory are supplied to every agent.'}</div>
        <div>Everything given is a card on the canvas. Drag a skill, tool, folder or file from the add panel onto this agent, or draw a line from another agent to a card to share it.</div>
      </>} />
      {place && (
        <div className="agent-context-place">
          <PlaceThread place={place} />
          {place.canStart && onPromoteEntrypoint && !readOnly && (
            <button type="button" className="link t-meta" onClick={onPromoteEntrypoint}>Make this the starting agent</button>
          )}
        </div>
      )}

      {pipeline && onAllowRecruitingChange && (
        <button type="button" className={`check ${agent.allowRecruiting !== false ? 'on' : ''}`} disabled={readOnly} onClick={() => onAllowRecruitingChange(agent.allowRecruiting === false)} aria-pressed={agent.allowRecruiting !== false}>
          <span className="box"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg></span>
          <span className="txt"><b className="t-body">Can bring in helpers</b><span className="t-meta">Can ask agents outside the steps to help with its step. It can always ask the step before it.</span></span>
        </button>
      )}

      <div className="context-given">
        <span className="context-label t-micro">Given</span>
        {onMemoryBriefChange && briefCount > 0 && (
          <button type="button" className={`given-chip toggle ${readsBrief ? 'on' : ''}`} disabled={readOnly} onClick={() => onMemoryBriefChange(agent.memory?.brief === false)} aria-pressed={readsBrief} title={readsBrief ? 'Supplied at the start of every session. Click to leave it out.' : 'Left out. Click to supply it.'}>
            {readsBrief ? <Check size={11} strokeWidth={3} aria-hidden="true" /> : <ScrollText size={12} aria-hidden="true" />}
            <span>Team Brief</span><span className="given-count">{readsBrief ? briefCount : 'left out'}</span>
            <span className="visually-hidden">{readsBrief ? `${entries} supplied at the start of every session` : `not supplied, ${entries} left out`}</span>
          </button>
        )}
        {!nothingConnected && (
          <ul className="given-chips" aria-label="Connected to this agent">
            {capabilities.map((capability) => {
              const { Icon, label } = chosenKnowledge(capability) ?? KIND[capability.kind]
              const missing = capability.kind === 'knowledge' && !capability.path && !capability.notion
              return (
                <li key={`${capability.kind}:${capability.name}`} className={`given-chip ${missing ? 'missing' : ''}`} title={`${capability.name}\n${label}${capability.path ? `\n${capability.path}` : ''}`}>
                  <Icon size={12} aria-hidden="true" />
                  <span className="given-name">{capability.name}</span>
                  <span className="visually-hidden">{label}</span>
                  {onRemoveCapability && !readOnly && (
                    <button type="button" className="given-remove" aria-label={`Disconnect ${capability.name}`} title="Disconnect" onClick={() => onRemoveCapability(capability)}><X size={11} aria-hidden="true" /></button>
                  )}
                </li>
              )
            })}
            {inheritedMemory.map((name) => (
              <li key={`memory:${name}`} className="given-chip" title={`${name}\nMemory · supplied from another team`}>
                <BookOpen size={12} aria-hidden="true" />
                <span className="given-name">{name}</span>
                <span className="visually-hidden">Memory · supplied from another team</span>
              </li>
            ))}
          </ul>
        )}
        {canAdd && (
          <>
            <button type="button" className="given-chip add" aria-label="Add folder…" title="Add a folder" onClick={() => setPicking(true)}><FolderPlus size={12} aria-hidden="true" />Folder</button>
            <button type="button" className="given-chip add" aria-label={adding ? 'Adding…' : 'Add file…'} title="Add a file" disabled={!teamPath || adding} onClick={() => fileInput.current?.click()}><FilePlus2 size={12} aria-hidden="true" />{adding ? 'Adding…' : 'File'}</button>
            <input ref={fileInput} type="file" multiple hidden aria-label="Files to add" onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void addFiles(files) }} />
          </>
        )}
        {!canAdd && nothingConnected && !(onMemoryBriefChange && briefCount > 0) && <span className="given-none t-meta">Nothing yet</span>}
      </div>
      {broken.map((capability) => <div key={capability.name} className="t-meta agent-context-warning">{capability.name} names no folder or file. Disconnect it and add one.</div>)}

      {canAdd && !teamPath && <div className="t-meta agent-context-empty">Save the team to add a file: it is copied next to the team file.</div>}
      {notes.length > 0 && (
        <ul className="agent-context-notes" aria-live="polite">
          {notes.map((note) => <li key={note.text} className={`t-meta ${note.failed ? 'failed' : ''}`} role={note.failed ? 'alert' : undefined}>{note.text}</li>)}
        </ul>
      )}
      {picking && onAddKnowledge && (
        <FolderPicker
          onClose={() => setPicking(false)}
          onChoose={(folder) => {
            setPicking(false)
            if (capabilities.some((capability) => capability.kind === 'knowledge' && capability.path === folder.path)) return
            onAddKnowledge([{ kind: 'knowledge', name: uniqueLabel(folder.name, taken()), path: folder.path }])
          }}
        />
      )}
    </div>
  )
}

const capitalised = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
const names = (links: readonly PlaceLink[]) => {
  const all = links.map((link) => link.name)
  return all.length <= 1 ? all.join('') : `${all.slice(0, -1).join(', ')} and ${all[all.length - 1]}`
}

/**
 * Where the agent sits, drawn as a short vertical thread: who hands it work, this step, who it
 * hands work to. You (your request, your review) wear the dashed ring the operator wears on the
 * canvas. Outside a pipeline's steps there is no chain to draw, so it stays a sentence.
 */
function PlaceThread({ place }: { place: AgentPlace }) {
  const flow = place.flow
  if (!flow) return <div className="t-body agent-context-place-text">{place.summary}</div>
  const from = flow.from.length > 0 ? flow.from : [{ name: 'your request', you: true }]
  const knots: { key: string; text: string; kind: 'you' | 'agent' | 'self' | 'output' }[] = [
    { key: 'from', text: capitalised(names(from)), kind: from.every((link) => link.you) ? 'you' : 'agent' },
    { key: 'self', text: `Step ${flow.step} of ${flow.of}`, kind: 'self' },
  ]
  if (flow.to.length > 0) knots.push({ key: 'to', text: capitalised(names(flow.to)), kind: flow.to.every((link) => link.you) ? 'you' : 'agent' })
  else if (place.final) knots.push({ key: 'to', text: 'The team’s output', kind: 'output' })
  return (
    <>
      <span className="visually-hidden">{place.summary}</span>
      <ol className="place-thread" aria-hidden="true">
        {knots.map((knot) => <li key={knot.key} className={`knot ${knot.kind}`}><i />{knot.text}</li>)}
      </ol>
    </>
  )
}
