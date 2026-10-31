import { useCallback, useMemo } from 'react'

import { useChatMentions } from '../../lib/chat/faces'
import { mentionsIn, type ChatAgent, type Mention } from '../../lib/chat/route'
import { FigureStill } from '../agents/FigureStill'
import { useTeamFigure } from '../agents/figureContext'
import { AgentMark } from '../ui/AgentMark'
import { Markdown } from '../ui/Markdown'
import { SaidMention, type SaidMarks } from '../ui/saidMention'
import { FoundText } from './FoundText'

const NO_MENTIONS: SaidMarks = { find: () => [] }

/**
 * Your words in the chat, as you typed them: their Markdown shown, a line you broke kept broken,
 * each @mention of a teammate drawn as that agent's chip, as in the team's sentence above the
 * canvas, and @team in bold. A search's words are lit as in `FoundText`. Outside a team's chat an
 * @ is only words.
 */
export function SaidText({ text }: { text: string }) {
  const mentions = useChatMentions()
  return <MentionedText text={text} agents={mentions?.agents ?? null} hue={mentions?.hue ?? null} />
}

/**
 * Words with every @mention of one of `agents` drawn as that agent's chip, and @team in bold: what
 * you said, and what the agents said to each other (ADR 0051, 0092). `null` agents leave an @ as
 * words.
 */
export function MentionedText({ text, agents, hue }: { text: string; agents: readonly ChatAgent[] | null; hue: ((id: string) => number) | null }) {
  const said = useMemo<SaidMarks>(() => (agents ? { find: (words) => keptMentions(words, mentionsIn(words, agents)) } : NO_MENTIONS), [agents])
  const draw = useCallback((id: string | undefined, words: string) => {
    const agent = id ? agents?.find((member) => member.id === id) : undefined
    if (!agent || !hue) return <span className="tc-mention-team"><FoundText text={words} /></span>
    return <MentionChip id={agent.id} name={agent.name.trim() || agent.id} hue={hue(agent.id)} />
  }, [agents, hue])
  return <SaidMention.Provider value={draw}><Markdown said={said}>{text}</Markdown></SaidMention.Provider>
}

/**
 * Each mention in `words`, with the words a line never breaks it from: an agent's chip keeps the
 * bracket or quote just before it and the letters just after it ("’s", ","), never reaching into
 * the next mention's.
 */
function keptMentions(words: string, found: readonly Mention[]) {
  const lead = (mention: Mention) => (mention.start > 0 && /[([{"'“‘]/.test(words[mention.start - 1]) ? 1 : 0)
  return found.map((mention, index) => {
    const agent = mention.target.kind === 'agent' ? mention.target.agent : undefined
    if (!agent) return { start: mention.start, end: mention.end }
    const next = found[index + 1]
    const until = Math.min(mention.end + (/^\S*/.exec(words.slice(mention.end))?.[0].length ?? 0), next ? next.start - lead(next) : words.length)
    return { start: mention.start, end: mention.end, agent, from: mention.start - lead(mention), until }
  })
}

/**
 * An agent mentioned: its figure's head and its name in its colour, the whole name on hover when
 * cut short. The @ stays in the words, for screen readers; `bare` leaves it out, for an agent named
 * in a sentence rather than written to.
 */
export function MentionChip({ id, name, hue, bare = false }: { id: string; name: string; hue: number; bare?: boolean }) {
  const figure = useTeamFigure(id)
  return (
    <span className={`tc-mention hue-${hue}`} title={name}>
      <span className="tc-mention-face" aria-hidden="true">{figure ? <FigureStill figure={figure} headOnly alt="" draggable={false} /> : <AgentMark id={id} size={14} />}</span>
      <span className="tc-mention-name">{!bare && <span className="tc-mention-at">@</span>}<FoundText text={name} /></span>
    </span>
  )
}
