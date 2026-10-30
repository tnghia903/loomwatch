import { Check, Plus } from '../ui/icon'
import type { RefObject } from 'react'

import { appendToRole, instructionShape, PART_LABELS, PART_STARTERS, type InstructionPart } from '../../lib/team-file/checkup'

const PARTS: readonly { part: InstructionPart; label: string; missing: string }[] = [
  { part: 'job', label: PART_LABELS.job, missing: 'Say what this agent does, and what it leaves to others.' },
  { part: 'method', label: PART_LABELS.method, missing: 'Start a list of how it should work' },
  { part: 'check', label: PART_LABELS.check, missing: 'Start saying how it checks its work before it replies' },
  { part: 'reply', label: PART_LABELS.reply, missing: 'Start saying what it replies with' },
]

export interface InstructionShapeProps {
  role: string
  /** The agent has a Done when list, which the daemon tells it to check before replying (ADR 0062). */
  checksDoneWhen?: boolean
  readOnly?: boolean
  /** The instructions field, so a started part leaves the caret after it to write on. */
  field: RefObject<HTMLTextAreaElement | null>
  onChange: (role: string) => void
}

/**
 * What these instructions cover, as state under the field: its job, how to work, how it checks its
 * work, what it replies with — the things every built-in job says (ADR 0030, ADR 0062), so a
 * hand-written agent is set up the same way without anyone being told to. A missing part is one
 * click from started.
 */
export function InstructionShape({ role, checksDoneWhen = false, readOnly = false, field, onChange }: InstructionShapeProps) {
  if (!role.trim()) return null
  const shape = { ...instructionShape(role), ...(checksDoneWhen ? { check: true } : {}) }
  const start = (text: string) => {
    const next = appendToRole(role, text)
    onChange(next)
    requestAnimationFrame(() => {
      const input = field.current
      if (!input) return
      input.focus()
      input.setSelectionRange(next.length, next.length)
      input.scrollTop = input.scrollHeight
    })
  }
  return (
    <div className="instruction-shape" role="group" aria-label="What these instructions cover">
      {PARTS.map(({ part, label, missing }) => {
        if (shape[part]) return <span key={part} className="shape-part on"><Check size={11} strokeWidth={3} aria-hidden="true" />{label}</span>
        if (part === 'job' || readOnly) return <span key={part} className="shape-part" title={missing}>{label}</span>
        return (
          <button key={part} type="button" className="shape-part add" title={missing} onClick={() => start(PART_STARTERS[part])}>
            <Plus size={11} strokeWidth={3} aria-hidden="true" />{label}
          </button>
        )
      })}
    </div>
  )
}
