import { CHATGPT_USAGE_PAGE, CLAUDE_BILLING_PAGE } from '../ai/sources'
import { formatCost } from '../watch/usage'
import { type UsageReport, cycleStart, readClaudePlan, spentSince } from './client'

const DAY_MS = 86_400_000

export interface Notice {
  key: string
  text: string
  href: string
  label: string
}

/** What is worth a heads-up from a usage report, now: a plan's limit hit today, credit nearly spent. */
export function usageNotices(report: UsageReport, now: Date, openRouterLeft?: number | null): Notice[] {
  const notices: Notice[] = []
  const plan = report.sources.find((entry) => entry.source === 'chatgpt')
  if (plan?.lastProblem?.kind === 'plan_limit' && now.getTime() - new Date(plan.lastProblem.at).getTime() < DAY_MS) {
    notices.push({ key: 'chatgpt', text: 'LoomWatch hit a usage limit on your ChatGPT plan today.', href: CHATGPT_USAGE_PAGE, label: 'Manage usage' })
  }
  const claude = readClaudePlan()
  if (claude?.monthly) {
    const spent = spentSince(report.days, 'anthropic', cycleStart(now, claude.renewsOn))
    if (spent >= claude.monthly * 0.8) {
      notices.push({ key: 'anthropic', text: `≈ ${formatCost(spent)} of your $${claude.monthly} Claude API credit is used by LoomWatch this month.`, href: CLAUDE_BILLING_PAGE, label: 'See exact balance' })
    }
  }
  if (typeof openRouterLeft === 'number' && openRouterLeft < 1) {
    notices.push({ key: 'openrouter', text: `Your OpenRouter key has ${formatCost(openRouterLeft)} left under its limit.`, href: '/usage', label: 'See usage' })
  }
  return notices
}

