import type { InstructionUpdate } from './useInstructionUpdates'

export interface InstructionUpdateBarProps {
  entries: readonly InstructionUpdate[]
  names: ReadonlyMap<string, string>
  readOnly?: boolean
  /** Open this agent's panel, where the change is shown word by word. */
  onReview: (agentId: string) => void
  onKeepAll: () => void
  /** Have the Ask app rewrite them; absent when no app can. */
  onRewrite?: () => void
  /** The Ask app's name, so the button says whose turn it spends. */
  rewriteWith?: string | null
}

/**
 * Over the canvas, when instructions still name something the person removed, and while and after
 * the Ask app rewrites them (ADR 0059). Rewriting is offered, not done: it is a turn of the
 * person's app. A change is shown, and kept or put back, in each agent's panel.
 */
export function InstructionUpdateBar({ entries, names, readOnly = false, onReview, onKeepAll, onRewrite, rewriteWith }: InstructionUpdateBarProps) {
  if (entries.length === 0) return null
  const sources = [...new Map(entries.map((entry) => [entry.source.cardId, entry.source])).values()]
  const what = sources.length === 1 ? <>the {sources[0].kind} <b className="instructions-source">“{sources[0].name}”</b></> : 'what you removed'
  const whose = (some: readonly InstructionUpdate[]) => some.length === 1
    ? `${names.get(some[0].agentId) ?? some[0].agentId}'s instructions`
    : `the instructions of ${some.length} agents`
  const working = entries.filter((entry) => entry.state === 'working')
  const updated = entries.filter((entry) => entry.state === 'updated')
  const naming = entries.filter((entry) => entry.state === 'stale' || entry.state === 'failed')
  if (working.length > 0) {
    return <p className="instruction-update-bar" role="status"><span>Rewriting {whose(working)} without {what}, which you removed…</span></p>
  }
  if (updated.length > 0) {
    return <div className="instruction-update-bar" role="status">
      <span>Updated {whose(updated)} because you removed {what}.</span>
      <button type="button" className="btn btn-primary" onClick={() => onReview(updated[0].agentId)}>Review</button>
      {!readOnly && <button type="button" className="btn" onClick={onKeepAll}>Keep all</button>}
    </div>
  }
  const error = naming.find((entry) => entry.state === 'failed')?.error
  return <div className={error ? 'instruction-update-bar failed' : 'instruction-update-bar'} role="status">
    <span>{whose(naming).replace(/^./, (first) => first.toUpperCase())} still name {what}, which you removed.{error ? ` ${error}` : ''}</span>
    <button type="button" className="btn" onClick={() => onReview(naming[0].agentId)}>Review</button>
    {!readOnly && onRewrite && <button type="button" className="btn btn-primary" onClick={onRewrite}>{error ? 'Try again' : rewriteWith ? `Rewrite with ${rewriteWith}` : 'Rewrite them'}</button>}
  </div>
}
