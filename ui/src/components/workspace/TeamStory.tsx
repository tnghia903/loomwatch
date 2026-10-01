import { CalendarClock, Wand2 } from 'lucide-react'

import { sentenceText, type SentencePart } from '../../lib/story/teamSentence'
import { AgentMark } from '../ui/AgentMark'

interface TeamStoryProps {
  parts: readonly SentencePart[]
  /** Select that agent on the canvas, which also opens its settings. */
  onAgent: (id: string) => void
  onSchedule?: () => void
  /** Apply a repair the sentence offers: add these configured edges. Absent when read-only. */
  onConnect?: (edges: readonly { from: string; to: string }[]) => void
}

/**
 * The team, said as one sentence above the canvas.
 *
 * Every name is a button into that agent's settings, so the sentence is a way to navigate as well
 * as a summary; hovering a name shows the id and model an expert would look for.
 */
export function TeamStory({ parts, onAgent, onSchedule, onConnect }: TeamStoryProps) {
  if (parts.length === 0) return null
  return (
    <section className="team-story" aria-label="Your team in one sentence">
      <span className="team-story-eyebrow">Your team, in one sentence</span>
      <p aria-description={sentenceText(parts)}>
        {parts.map((part, index) => {
          if (part.kind === 'agent') {
            return (
              <button key={index} type="button" className={`story-name ${part.operator ? 'you' : ''}`} aria-label={part.operator ? 'You, the review step' : part.name} title={part.title} onClick={() => onAgent(part.id)}>
                <AgentMark id={part.id} size={14} operator={part.operator} />
                {part.name}
              </button>
            )
          }
          if (part.kind === 'schedule') {
            return onSchedule
              ? <button key={index} type="button" className="story-schedule" aria-label={`${part.text}. Change when this team runs`} title="Change when this team runs" onClick={onSchedule}><CalendarClock size={13} aria-hidden="true" />{part.text}</button>
              : <span key={index} className="story-schedule">{part.text}</span>
          }
          if (part.kind === 'warning') return <span key={index} className="story-warning">{part.text}</span>
          if (part.kind === 'fix') return onConnect ? <button key={index} type="button" className="story-fix" onClick={() => onConnect(part.connect)}><Wand2 size={12} aria-hidden="true" />{part.text}</button> : null
          return <span key={index}>{part.text}</span>
        })}
      </p>
    </section>
  )
}
