import { ChatGptPlan } from './ChatGptPlan'
import { ClaudeCredit } from './ClaudeCredit'
import { OpenRouterKey } from './OpenRouterKey'

/**
 * The three ways agents' models are paid, side by side with the same weight (ADR 0073): the
 * ChatGPT plan, a Claude plan's API credit, and an OpenRouter key. One is enough to start; each
 * model in the picker says which of them pays for it. The ChatGPT card is left out of a copy of
 * LoomWatch that doesn't offer it.
 */
export function Sources({ title = 'How your agents’ models are paid', intro = true }: { title?: string; intro?: boolean }) {
  return (
    <section className="lw-sources" aria-labelledby="lw-sources-title">
      <div className="lw-sources-head">
        <h2 id="lw-sources-title" className="t-title">{title}</h2>
        {intro && <p className="t-body">Connect one or more. Each costs differently, and every model you pick says which one pays for it.</p>}
      </div>
      <div className="lw-sources-grid">
        <ChatGptPlan variant="card" />
        <ClaudeCredit variant="card" />
        <OpenRouterKey variant="source" />
      </div>
    </section>
  )
}
