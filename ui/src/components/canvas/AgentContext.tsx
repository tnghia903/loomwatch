import { Box, BookOpen, FilePlus2, FolderPlus, Puzzle, Wrench, X } from 'lucide-react'
import { useRef, useState } from 'react'

import { chosenKnowledge } from '../../lib/knowledge/chosen'
import { addTeamFile } from '../../lib/knowledge/client'
import type { AgentPlace } from '../../lib/team-file/agentPlace'
import type { AgentConfig, CapabilityRef } from '../../lib/team-file/types'
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
}

const KIND: Record<CapabilityRef['kind'], { Icon: typeof Puzzle; label: string }> = {
  skill: { Icon: Puzzle, label: 'Skill · its instructions are supplied' },
  knowledge: { Icon: Box, label: 'Knowledge · supplied as source material' },
  tool: { Icon: Wrench, label: 'Tool · available while it works' },
}

/** `report.pdf`, or `report.pdf (2)` when this agent already has knowledge by that name. */
function uniqueLabel(name: string, taken: Set<string>): string {
  let label = name
  for (let counter = 2; taken.has(label); counter += 1) label = `${name} (${counter})`
  taken.add(label)
  return label
}

/**
 * CONTEXT — what one agent is given when it starts: its place in the team, the team Brief, and
 * everything connected to it. It replaced the BEHAVIOUR zone (ADR 0034), whose five switches
 * either repeated the canvas, did nothing in team mode, or asked an operator to choose a
 * delivery channel by its implementation name.
 *
 * The copy keeps docs/TEAM_MEMORY.md's rule: things are *supplied*; the agent is never said to
 * know, remember or have read them.
 */
export function AgentContext({ agent, place, pipeline = false, briefCount = 0, inheritedMemory = [], readOnly = false, onPromoteEntrypoint, onAllowRecruitingChange, onMemoryBriefChange, onRemoveCapability, teamPath, onAddKnowledge }: AgentContextProps) {
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

  return (
    <div className="agent-context">
      {place && (
        <div className="agent-context-place">
          <div className="t-body">{place.summary}</div>
          <div className="t-meta agent-context-note">The agent is told this at the start of every run.</div>
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

      {onMemoryBriefChange && (briefCount > 0
        ? (
          <button type="button" className={`check ${readsBrief ? 'on' : ''}`} disabled={readOnly} onClick={() => onMemoryBriefChange(agent.memory?.brief === false)} aria-pressed={readsBrief}>
            <span className="box"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg></span>
            <span className="txt"><b className="t-body">Team Brief</b><span className="t-meta">{readsBrief ? `${briefCount} ${briefCount === 1 ? 'entry' : 'entries'} supplied at the start of every session` : `Not supplied — ${briefCount} ${briefCount === 1 ? 'entry' : 'entries'} left out`}</span></span>
          </button>
        )
        : <div className="t-meta agent-context-empty">No team Brief yet. Notes you add in Memory are supplied to every agent.</div>)}

      {nothingConnected
        ? <div className="t-meta agent-context-empty">Nothing connected. {canAdd ? 'Add a folder or file below, or drag' : 'Drag'} a skill, knowledge source or tool from the Library onto this agent.</div>
        : (
          <ul className="agent-context-list" aria-label="Connected to this agent">
            {capabilities.map((capability) => {
              const { Icon, label } = chosenKnowledge(capability) ?? KIND[capability.kind]
              return (
                <li key={`${capability.kind}:${capability.name}`} title={capability.path}>
                  <Icon size={14} aria-hidden="true" />
                  <span className="agent-context-name"><b className="t-body">{capability.name}</b><span className="t-meta">{label}</span></span>
                  {onRemoveCapability && !readOnly && (
                    <button type="button" className="iconbtn" aria-label={`Disconnect ${capability.name}`} title="Disconnect" onClick={() => onRemoveCapability(capability)}><X size={13} aria-hidden="true" /></button>
                  )}
                </li>
              )
            })}
            {inheritedMemory.map((name) => (
              <li key={`memory:${name}`}>
                <BookOpen size={14} aria-hidden="true" />
                <span className="agent-context-name"><b className="t-body">{name}</b><span className="t-meta">Memory · supplied from another team</span></span>
              </li>
            ))}
          </ul>
        )}

      {canAdd && (
        <div className="agent-context-add">
          <button type="button" className="link t-meta" onClick={() => setPicking(true)}><FolderPlus size={13} aria-hidden="true" />Add folder…</button>
          <button type="button" className="link t-meta" disabled={!teamPath || adding} onClick={() => fileInput.current?.click()}><FilePlus2 size={13} aria-hidden="true" />{adding ? 'Adding…' : 'Add file…'}</button>
          <input ref={fileInput} type="file" multiple hidden aria-label="Files to add" onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void addFiles(files) }} />
        </div>
      )}
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
