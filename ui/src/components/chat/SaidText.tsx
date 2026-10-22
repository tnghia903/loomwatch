import type { ReactNode } from 'react'

import { useChatMentions } from '../../lib/chat/faces'
import { mentionsIn, type Mention } from '../../lib/chat/route'
import { FigureStill } from '../agents/FigureStill'
import { useTeamFigure } from '../agents/figureContext'
import { AgentMark } from '../ui/AgentMark'
import { FoundText } from './FoundText'

/**
 * Your words in the chat, as plain text, with each @mention of a teammate drawn as that agent's
 * chip, as in the team's sentence above the canvas, and @team in bold. A search's words are lit as
 * in `FoundText`. Outside a team's chat the words are only plain text.
 */
export function SaidText({ text }: { text: string }) {
  const mentions = useChatMentions()
  const found = mentions ? mentionsIn(text, mentions.agents) : []
  if (!mentions || found.length === 0) return <FoundText text={text} />
  // A line may break on either side of a chip, so the bracket or quote just before it and the
  // letters just after it ("’s", ",") are kept on its line.
  const lead = (mention: Mention) => (mention.start > 0 && /[([{"'“‘]/.test(text[mention.start - 1]) ? 1 : 0)
  const parts: ReactNode[] = []
  let at = 0
  found.forEach((mention, index) => {
    const target = mention.target
    const agent = target.kind === 'agent' ? mentions.agents.find((member) => member.id === target.agent) : undefined
    if (!agent) {
      if (mention.start > at) parts.push(<FoundText key={`text-${at}`} text={text.slice(at, mention.start)} />)
      parts.push(<span key={`at-${mention.start}`} className="tc-mention-team"><FoundText text={text.slice(mention.start, mention.end)} /></span>)
      at = mention.end
      return
    }
    const from = mention.start - lead(mention)
    const next = found[index + 1]
    const until = Math.min(mention.end + (/^\S*/.exec(text.slice(mention.end))?.[0].length ?? 0), next ? next.start - lead(next) : text.length)
    if (from > at) parts.push(<FoundText key={`text-${at}`} text={text.slice(at, from)} />)
    parts.push(
      <span key={`at-${mention.start}`} className="tc-mention-keep">
        {from < mention.start && <FoundText text={text.slice(from, mention.start)} />}
        <MentionChip id={agent.id} name={agent.name.trim() || agent.id} hue={mentions.hue(agent.id)} />
        {until > mention.end && <FoundText text={text.slice(mention.end, until)} />}
      </span>,
    )
    at = until
  })
  if (at < text.length) parts.push(<FoundText key={`text-${at}`} text={text.slice(at)} />)
  return <>{parts}</>
}

/** An agent @mentioned: its figure's head and its name in its colour, the whole name on hover when cut short. The @ stays in the words, for screen readers. */
function MentionChip({ id, name, hue }: { id: string; name: string; hue: number }) {
  const figure = useTeamFigure(id)
  return (
    <span className={`tc-mention hue-${hue}`} title={name}>
      <span className="tc-mention-face" aria-hidden="true">{figure ? <FigureStill figure={figure} headOnly alt="" draggable={false} /> : <AgentMark id={id} size={14} />}</span>
      <span className="tc-mention-name"><span className="tc-mention-at">@</span><FoundText text={name} /></span>
    </span>
  )
}
