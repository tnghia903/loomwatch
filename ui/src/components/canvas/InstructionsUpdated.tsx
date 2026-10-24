import { sentencesNaming } from '../../lib/team-file/mentions'
import type { AgentConfig } from '../../lib/team-file/types'
import { wordDiff } from '../../lib/wordDiff'
import { InlineMarkdown } from '../ui/Markdown'
import type { InstructionUpdate } from '../workspace/useInstructionUpdates'

export interface InstructionsUpdatedProps {
  update: InstructionUpdate
  /** The agent as it is now: the person may have edited the instructions since. */
  agent: Pick<AgentConfig, 'role' | 'capabilities'>
  readOnly?: boolean
  onKeep: () => void
  onPutBack: () => void
}

/**
 * Under an agent's instructions: what LoomWatch changed in them when the person removed a source
 * they named (ADR 0059), word by word, until the person keeps it or puts the old ones back.
 */
export function InstructionsUpdated({ update, agent, readOnly = false, onKeep, onPutBack }: InstructionsUpdatedProps) {
  const what = <>the {update.source.kind} <b className="instructions-source">“{update.source.name}”</b></>
  if (update.state === 'working') {
    return <p className="instructions-updated" role="status">Rewriting these instructions without {what}, which you removed…</p>
  }
  if (update.state === 'failed' || update.state === 'stale') {
    const sentences = sentencesNaming(agent, update.source)
    return <section className={update.state === 'failed' ? 'instructions-updated failed' : 'instructions-updated'} aria-label="Instructions that still name what you removed">
      <p>These instructions still name {what}, which you removed.{update.error ? ` ${update.error}` : ''}</p>
      {sentences.length > 0 && <ul>{sentences.map((sentence) => <li key={sentence}><InlineMarkdown>{sentence}</InlineMarkdown></li>)}</ul>}
      {!readOnly && <div className="instructions-updated-actions"><button type="button" className="btn" onClick={onKeep}>Keep as is</button></div>}
    </section>
  }
  return <section className="instructions-updated" aria-label="What LoomWatch changed in these instructions">
    <p>Updated because you removed {what}. Taken out <del>like this</del>, put in <ins>like this</ins>:</p>
    <p className="instructions-diff">{wordDiff(update.before, agent.role).map((part, index) =>
      part.kind === 'removed' ? <del key={index}>{part.text}</del> : part.kind === 'added' ? <ins key={index}>{part.text}</ins> : <span key={index}>{part.text}</span>)}</p>
    {!readOnly && <div className="instructions-updated-actions">
      <button type="button" className="btn btn-primary" onClick={onKeep}>Keep</button>
      <button type="button" className="btn" onClick={onPutBack}>Put back the old instructions</button>
    </div>}
  </section>
}
