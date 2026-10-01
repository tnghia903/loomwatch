import { knownHarness, type DetectedHarness, type HarnessModel } from './harnesses'
import type { AgentConfig } from './team-file/types'

function sameSpawn(left: AgentConfig['spawn'], right: DetectedHarness['spawn']): boolean {
  return left !== undefined && left.cmd === right.cmd
    && left.args.length === right.args.length
    && left.args.every((arg, index) => arg === right.args[index])
}

export function harnessIdForAgent(agent: AgentConfig, harnesses: readonly DetectedHarness[]): string | null {
  if (agent.kind === 'operator' || !agent.spawn) return null
  const detected = harnesses.find((harness) => sameSpawn(agent.spawn, harness.spawn))
  if (detected) return detected.id

  const { cmd, args } = agent.spawn
  if (cmd === 'loomwatchd' && args[0] === 'harness-client') {
    const harnessIndex = args.indexOf('--harness')
    return harnessIndex >= 0 ? args[harnessIndex + 1] ?? null : null
  }
  if (cmd === 'claude-agent-acp' || (cmd === 'npx' && args.includes('@agentclientprotocol/claude-agent-acp'))) return 'claude'
  if (cmd === 'codex-acp' || (cmd === 'npx' && args.includes('@agentclientprotocol/codex-acp'))) return 'codex'
  if (cmd === 'gemini') return 'gemini'
  if (cmd === 'opencode') return 'opencode'
  if (cmd === 'hermes-acp') return 'hermes'
  return null
}

/**
 * What runs this agent, in words: "Claude", "You (review step)", "Codex (not installed)", or
 * "Custom command: python3". Replaces "Harness not recorded", which was shown for every agent that
 * did not match a detected harness — including the operator's own review step and the offline demo.
 */
export function appLabelForAgent(agent: AgentConfig, harnesses: readonly DetectedHarness[]): string {
  if (agent.kind === 'operator') return 'You (review step)'
  const id = harnessIdForAgent(agent, harnesses)
  if (id) return harnesses.find((harness) => harness.id === id)?.name ?? `${knownHarness(id).name} (not installed)`
  const cmd = agent.spawn?.cmd.split('/').pop()
  return cmd ? `Custom command: ${cmd}` : 'Not set'
}

const THINKING_EFFORTS = new Set(['default', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

export function splitModelSelector(selector: string): { modelId: string; thinkingEffort?: string } {
  const match = /^(.*)\[([^\]]+)\]$/.exec(selector.trim())
  if (!match || !THINKING_EFFORTS.has(match[2])) return { modelId: selector.trim() }
  return { modelId: match[1], thinkingEffort: match[2] }
}

export function modelOptionsForAgent(agent: AgentConfig, agents: readonly AgentConfig[], harnesses: readonly DetectedHarness[], discovered: readonly HarnessModel[] = []): HarnessModel[] {
  const harnessId = harnessIdForAgent(agent, harnesses)
  const usedByHarness = harnessId
    ? agents.filter((candidate) => harnessIdForAgent(candidate, harnesses) === harnessId).map((candidate) => candidate.model)
    : agents.filter((candidate) => candidate.spawn?.cmd === agent.spawn?.cmd).map((candidate) => candidate.model)

  const options = new Map(discovered.map((model) => [model.id, model]))
  for (const selector of [
    ...usedByHarness,
    agent.model,
  ]) {
    const { modelId } = splitModelSelector(selector ?? '')
    if (modelId && !options.has(modelId)) options.set(modelId, { id: modelId, name: modelId, thinkingEfforts: [] })
  }
  return [...options.values()]
}
