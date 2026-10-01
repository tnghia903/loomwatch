export const library = [
  { id: 'claude-design', name: 'claude-design', origin: 'Claude Code', description: 'Design clear, considered interfaces and reports.', version: '1.2', hash: 'example:7e2a81', resources: 'SKILL.md · 2 references', dependencies: 'Browser, Read file' },
  { id: 'source-check', name: 'source-check', origin: 'Shared skills', description: 'Check sources and distinguish facts from assumptions.', version: '1.0', hash: 'example:2a849c', resources: 'SKILL.md · 1 reference', dependencies: 'Web search' },
  { id: 'report-writing', name: 'report-writing', origin: 'Codex', description: 'Turn research into a structured, readable report.', version: '2.0', hash: 'example:119bd3', resources: 'SKILL.md · 1 template', dependencies: 'Read file' },
];

export const initialTeam = {
  name: 'Market research', output: 'Market research report', format: 'Markdown report',
  request: 'Research the market opportunity for LoomWatch.',
  agents: [
    { id: 'researcher', name: 'Researcher', role: 'Market researcher', harness: 'Codex', output: 'Research brief', skills: [], tools: ['web', 'files'] },
    { id: 'designer', name: 'Report Designer', role: 'Report writer and designer', harness: 'Codex', output: 'Market research report', skills: ['claude-design'], tools: ['browser', 'files'] },
  ],
};

export const toolCatalog = {
  web: { name: 'Web search', count: 5, verb: 'Search', description: 'Searched for agent workflows and user research.', calls: ['Agent workflow observability', 'Cross-harness skill portability', 'How teams review agent outputs', 'Multi-agent workflow interfaces', 'Agent skills specification'] },
  browser: { name: 'Browser', count: 2, verb: 'Browser', description: 'Opened references used while preparing the report.', calls: ['Open research reference', 'Inspect report preview'] },
  files: { name: 'Read file', count: 3, verb: 'File', description: 'Read the input brief and supporting project context.', calls: ['Read research-brief.md', 'Read project context', 'Read report guidelines'] },
};

export function makeRun(id = 15, scenario = 'complete', team = initialTeam, revision = '') {
  return { id, scenario, team: structuredClone(team), reviewed: false, revision, phase: scenario === 'live' ? 'researching' : scenario === 'missing' ? 'blocked' : 'finished' };
}

export function skillStatus(run, agentId) {
  if (run.scenario === 'missing' && agentId === 'designer') return 'missing';
  if (run.phase === 'researching' && agentId === 'designer') return 'pending';
  if (run.phase === 'stopped') return agentId === 'designer' && run.stoppedDuring !== 'designing' ? 'pending' : 'loaded';
  return 'loaded';
}

export function agentStatus(run, agentId) {
  if (run.phase === 'stopped') return agentId === 'researcher' && run.stoppedDuring === 'designing' ? 'done' : agentId === 'designer' && run.stoppedDuring === 'researching' ? 'pending' : 'stopped';
  if (run.phase === 'researching') return agentId === 'researcher' ? 'running' : 'pending';
  if (run.phase === 'designing') return agentId === 'researcher' ? 'done' : 'running';
  if (run.phase === 'blocked' && agentId === 'designer') return 'blocked';
  return 'done';
}

export function capabilitiesFor(agent, run, build = false) {
  const status = build ? 'required' : skillStatus(run, agent.id);
  const blocked = !build && ['pending', 'running', 'blocked', 'stopped'].includes(agentStatus(run, agent.id));
  return [
    ...agent.skills.map((id) => ({ ...library.find((skill) => skill.id === id), owner: agent.id, kind: 'skill', status, label: status === 'loaded' ? 'Loaded' : status === 'missing' ? 'Not loaded' : status === 'required' ? 'Required' : 'Waiting' })),
    ...agent.tools.map((id) => ({ id, ...toolCatalog[id], owner: agent.id, kind: 'tool', status: build || blocked ? 'available' : 'called', count: build || blocked ? 0 : toolCatalog[id].count, label: build || blocked ? 'Available' : `${toolCatalog[id].count} calls · succeeded` })),
  ];
}

export function requiredCounts(run) {
  return run.team.agents.reduce((counts, agent) => ({
    total: counts.total + agent.skills.length,
    loaded: counts.loaded + (skillStatus(run, agent.id) === 'loaded' ? agent.skills.length : 0),
  }), { total: 0, loaded: 0 });
}

export const reportSections = [
  { title: 'Opportunity', body: 'Teams are exploring multi-agent workflows, but it’s often hard to see what was actually done, which skills were used, and how to trust the result. There is an opportunity for a tool that makes agent teamwork transparent and easy to review.' },
  { title: 'Who it helps', body: 'Product teams, engineering teams, and domain experts who rely on agents to get real work done. They need to follow each agent’s contribution, verify required skills, and understand the final output.' },
  { title: 'Next experiment', body: 'Test whether users can easily find the final result and the required skill evidence for each agent. Ask new users to review a run and observe where they hesitate. Use their feedback to make the experience clearer.' },
];

export function reportMarkdown(run) {
  return `# ${run.team.output}\n\nExample report from the LoomWatch UX prototype.\n\n# Make agent teamwork understandable\n\nLoomWatch helps teams build, run, and inspect multi-agent work.\n\n${reportSections.map((section) => `## ${section.title}\n\n${section.body}`).join('\n\n')}${run.revision ? `\n\n## Revision brief\n\n${run.revision}\n\nThis prototype records the requested revision; it does not generate a new report.` : ''}`;
}
