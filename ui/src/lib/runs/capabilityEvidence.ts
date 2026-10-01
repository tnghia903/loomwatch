import type { AgentConfig } from '../team-file/types'
import type { Evidence, RequiredSkillReceipt } from '../watch/events'

export interface RunCapability {
  id: string
  name: string
  kind: 'skill' | 'tool'
  required: boolean
  state: 'loaded' | 'read' | 'failed' | 'unverified' | 'observed'
  label: string
  evidence: Evidence[]
  receipt?: RequiredSkillReceipt
}

/** Only explicit file paths on read operations establish a skill read. A title mentioning a
 * skill, a directory listing, a failed read, or another agent's activity never verifies it.
 * Reading instructions is observable; following every instruction is a separate review. */
function isSkillRead(
  item: Evidence,
  name: string,
  resolvedPath?: string,
): boolean {
  if (item.capture !== 'recorded') return false
  const read = item.toolKind === 'read' || item.relation === 'read file'
  if (!read) return false
  const input =
    item.rawInput && typeof item.rawInput === 'object'
      ? (item.rawInput as Record<string, unknown>)
      : {}
  const paths = [
    ...item.locations.map((location) => location.path),
    ...['path', 'file_path', 'filePath'].flatMap((key) =>
      typeof input[key] === 'string' ? [input[key] as string] : [],
    ),
  ]
  return paths.some((path) => {
    if (resolvedPath)
      return path.replaceAll('\\', '/') === resolvedPath.replaceAll('\\', '/')
    const parts = path.replaceAll('\\', '/').split('/').filter(Boolean)
    return parts.at(-1) === 'SKILL.md' && parts.at(-2) === name
  })
}

export function capabilityEvidence(
  agent: AgentConfig,
  evidence: readonly Evidence[],
  snapshot?: RequiredSkillReceipt[],
): RunCapability[] {
  const owned = evidence.filter((item) => item.agentId === agent.id)
  const skills: RunCapability[] = (snapshot ?? agent.capabilities ?? []).map(
    (skill) => {
      const receipt = snapshot?.find((item) => item.name === skill.name)
      const receipts = owned.filter(
        (item) =>
          isSkillRead(item, skill.name, receipt?.path) ||
          (item.relation === 'loaded into prompt' &&
            item.name === skill.name &&
            item.capture === 'recorded'),
      )
      const succeeded = receipts.some((item) => item.status === 'succeeded')
      const failed = receipts.some(
        (item) => item.status === 'failed' || item.status === 'rejected',
      )
      // `opened` outranks `supplied`: the daemon recorded the agent's own stream reading the
      // delivered file, which is the one state that is evidence of use rather than of delivery
      // (`docs/RUN_PROVENANCE_CONTRACT.md` §12, ADR 0021). It is checked first for that reason,
      // not because it happens later.
      const opened = receipt?.state === 'opened'
      return {
        id: `skill:${skill.name}`,
        name: skill.name,
        kind: 'skill',
        required: true,
        state: opened
          ? 'read'
          : receipt?.state === 'supplied'
            ? 'loaded'
            : succeeded
              ? 'read'
              : failed
                ? 'failed'
                : 'unverified',
        label: opened
          ? 'Delivered → opened'
          : receipt?.state === 'supplied'
            ? routeLabel(receipt.route)
            : succeeded
              ? 'Read observed'
              : failed
                ? 'Read failed'
                : 'Load unverified',
        evidence: receipts,
        receipt,
      }
    },
  )
  const groups = new Map<string, Evidence[]>()
  for (const item of owned) {
    if (item.relation === 'loaded into prompt') continue
    if (!item.callId || ['delegation', 'permission'].includes(item.kind))
      continue
    // Keep the actual recorded tool title. Group exact identities, never infer that the skill
    // caused a nearby call, and never hide a failed call inside a success count.
    const key = observedToolName(item)
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  return [
    ...skills,
    ...Array.from(groups, ([id, items]): RunCapability => ({
      id: `tool:${id}`,
      name: id,
      kind: 'tool',
      required: false,
      state: items.some((item) => ['failed', 'rejected'].includes(item.status))
        ? 'failed'
        : 'observed',
      label: `${items.length} ${items.length === 1 ? 'call' : 'calls'}${items.some((item) => ['failed', 'rejected'].includes(item.status)) ? ' · includes failure' : items.every((item) => item.status === 'succeeded') ? ' · succeeded' : ' · in progress'}`,
      evidence: items,
    })),
  ]
}

/**
 * What "supplied" means for a skill, which now depends on the route it took (ADR 0021).
 *
 * The `native` route deliberately does not put the skill's text in the prompt — saying "loaded
 * into prompt" for it would claim something the daemon did not do. A run archived before routes
 * existed carries no route and keeps the original wording.
 */
function routeLabel(route: RequiredSkillReceipt['route']): string {
  if (route === 'native') return 'Delivered, pointer in prompt'
  if (route === 'inline') return 'Loaded into prompt, translated'
  return 'Loaded into prompt'
}

/** Group by recorded operation identity, keeping command text and paths in the receipt. */
function observedToolName(item: Evidence): string {
  const named = item.events
    .map((event) => event.payload.name)
    .find((name) => typeof name === 'string')
  if (typeof named === 'string' && /^(mcp[._]|functions[.])/.test(named))
    return named.replace(/^mcp[._]+/, '').replace(/__/g, ' · ')
  if (/^mcp[.]/.test(item.name))
    return item.name
      .replace(/^mcp[.]/, '')
      .replace('loomwatch-team-bus.', 'Team bus · ')
  const names: Record<string, string> = {
    read: 'Read file',
    edit: 'Edit files',
    delete: 'Delete file',
    move: 'Move file',
    search: 'Search',
    execute: 'Run command',
    fetch: 'Fetch source',
    switch_mode: 'Change mode',
    other: 'Other tool',
  }
  return (
    names[item.toolKind ?? ''] ??
    (
      {
        command: 'Run command',
        file: 'File access',
        search: 'Search',
        skill: 'Read skill',
      } as Record<string, string>
    )[item.kind] ??
    item.name
  )
}
