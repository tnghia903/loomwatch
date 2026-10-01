import type { Depth } from './depth'

/**
 * The command bar's two dialects: plain words ("add a reviewer", "zoom out", "looks good") and
 * exact commands ("/add reviewer", "/depth trace", "/approve"). Both resolve to the same intent,
 * which the palette shows as one proposed action before anything happens — a newcomer sees what
 * their sentence will do, and an expert gets a fast, predictable grammar.
 *
 * Deliberately a small grammar rather than a model: it runs offline, instantly, and never guesses
 * at something it cannot show first.
 */
export type Intent =
  | { kind: 'add'; job: string }
  | { kind: 'review-step' }
  | { kind: 'run'; request: string }
  | { kind: 'depth'; depth: Depth }
  | { kind: 'approve' }
  | { kind: 'open'; query: string }

export interface ParsedIntent {
  intent: Intent
  /** True when typed as a /command, so the palette can label the dialect it understood. */
  exact: boolean
}

const ARTICLE = '(?:(?:a|an|another|one|the|some)\\s+)?'

/** Common ways people name a job, mapped to the job ids in lib/library/roles.ts. */
const JOB_WORDS: Record<string, string> = {
  researcher: 'researcher', research: 'researcher', scout: 'researcher',
  writer: 'writer', write: 'writer', author: 'writer', copywriter: 'writer',
  editor: 'editor', edit: 'editor', proofreader: 'editor',
  reviewer: 'reviewer', review: 'reviewer', checker: 'reviewer', critic: 'reviewer', qa: 'reviewer',
  coder: 'coder', developer: 'coder', engineer: 'coder', programmer: 'coder', code: 'coder',
  designer: 'designer', design: 'designer',
  analyst: 'analyst', analyse: 'analyst', analyze: 'analyst', data: 'analyst',
}

function job(word: string): string | null {
  return JOB_WORDS[word.toLowerCase().replace(/s$/, '')] ?? JOB_WORDS[word.toLowerCase()] ?? null
}

export function parseIntent(input: string): ParsedIntent | null {
  const text = input.trim()
  if (!text) return null
  const exact = text.startsWith('/')
  const body = (exact ? text.slice(1) : text).trim()
  const lower = body.toLowerCase().replace(/[.!?]+$/, '')

  // Adding helpers: "/add writer", "add a reviewer", "hire an editor", "I need a coder".
  const add = lower.match(new RegExp(`^(?:add|hire|i need|we need|get me|bring in)\\s+${ARTICLE}([a-z]+)`))
  if (add) {
    if (/^(you|me|approval|review step|review-step|pause|check)/.test(lower.replace(/^(?:add|hire|i need|we need|get me|bring in)\s+(?:a|an|another|the)?\s*/, ''))) return { intent: { kind: 'review-step' }, exact }
    const id = job(add[1])
    if (id) return { intent: { kind: 'add', job: id }, exact }
  }
  if (/^(let me (approve|check|review)|add (a )?review step|pause for me)/.test(lower)) return { intent: { kind: 'review-step' }, exact }

  // Depth: "/depth trace", "zoom out", "big picture", "show me the details".
  const depth = lower.match(/^depth\s+(story|team|trace)$/)
  if (depth) return { intent: { kind: 'depth', depth: depth[1] as Depth }, exact }
  if (/^(zoom out|big picture|story( view)?|overview|simple view)$/.test(lower)) return { intent: { kind: 'depth', depth: 'story' }, exact }
  if (/^(zoom in|details|show (me )?(the )?details|trace( view)?|show ids|expert view)$/.test(lower)) return { intent: { kind: 'depth', depth: 'trace' }, exact }
  if (/^(team view|normal view|cards|reset zoom)$/.test(lower)) return { intent: { kind: 'depth', depth: 'team' }, exact }

  // Approving: "/approve", "approve", "looks good", "lgtm", "ship it".
  if (/^(approve( it| this)?|looks good|lgtm|ship it|go ahead|continue)$/.test(lower)) return { intent: { kind: 'approve' }, exact }

  // Opening a team: "/open daily news", "open the blog team", "go to research".
  const open = body.match(/^(?:open|go to|switch to)\s+(?:the\s+)?(.+?)(?:\s+team)?$/i)
  if (open && open[1].trim()) return { intent: { kind: 'open', query: open[1].trim() }, exact }

  // Running: "/run write a blog post", "run: …", "ask the team to …".
  const run = body.match(/^(?:run|ask the team to|have the team|get the team to)[:\s]+(.+)$/i)
  if (run && run[1].trim()) return { intent: { kind: 'run', request: run[1].trim() }, exact }
  return null
}

/** The best team for a typed name: whole words first, then any substring. */
export function matchTeam<T extends { name: string; path: string }>(query: string, teams: readonly T[]): T | null {
  const needle = query.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim()
  if (!needle) return null
  const words = needle.split(/\s+/)
  const scored = teams.map((team) => {
    const hay = `${team.name} ${team.path}`.toLowerCase()
    const hits = words.filter((word) => hay.includes(word)).length
    return { team, score: hay.includes(needle) ? words.length + 1 : hits }
  }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score)
  return scored[0]?.team ?? null
}
