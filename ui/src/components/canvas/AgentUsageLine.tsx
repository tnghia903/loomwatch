import { formatTokens } from '../../lib/format'
import type { AgentUsage } from '../../lib/team-file/runLessons'

/**
 * What this agent used in the team's recent runs, beside the app and model choices that set it,
 * and what it costs before it reads the request. Its own runs, never an estimate.
 */
export function AgentUsageLine({ usage, runs, alone }: { usage: AgentUsage; runs: number; alone: boolean }) {
  const over = runs === 1 ? 'the last run' : `the last ${runs} runs`
  return (
    <div className="agent-usage" title={`Average over ${over}, as its model calls counted it, cached tokens included.`}>
      <span>About {formatTokens(usage.perRun)} tokens a run{alone ? '' : `, ${Math.round(usage.share * 100)}% of the team`}</span>
      {usage.opening !== null && <span>Its app starts at about {formatTokens(usage.opening)} before your request</span>}
    </div>
  )
}
