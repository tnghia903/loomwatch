import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, Bot, Check, CheckCircle2, ChevronDown, ChevronRight, CircleAlert, CircleDot, Clock3, Code2, Copy, Download, FileText, FolderOpen, GitBranch, Globe2, Layers3, List, LoaderCircle, Maximize2, MessageSquare, Minimize2, Network, Play, Plus, Puzzle, Search, Send, ShieldCheck, Square, Trash2, Wrench, X } from 'lucide-react';
import { CapabilityGraph, CapabilityIcon, StateIcon } from './CapabilityGraph';
import { BuildCanvas } from './BuildCanvas';
import { agentStatus, capabilitiesFor, initialTeam, library, makeRun, reportMarkdown, reportSections, requiredCounts, skillStatus } from './data';

const savedTeamKey = 'loomwatch-delivery-lane-prototype-team';
function readTeam() {
  try {
    const saved = JSON.parse(localStorage.getItem(savedTeamKey));
    if (saved?.agents?.length === 2 && saved.agents.every((agent) => Array.isArray(agent.skills) && agent.skills.every((skill) => library.some((entry) => entry.id === skill)))) return saved;
  } catch { /* Use the example team when storage is unavailable. */ }
  return structuredClone(initialTeam);
}

function Modal({ title, children, onClose, wide = false }) {
  const ref = useRef(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className={`modal ${wide ? 'wide' : ''}`} onCancel={onClose} onClose={onClose} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }} aria-label={title}>
    <header className="modal-head"><h2>{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={19} /></button></header>
    {children}
  </dialog>;
}

function AgentCard({ agent, index, selected, run, build, onSelect, onEvidence }) {
  const state = build ? 'configured' : agentStatus(run, agent.id);
  const skill = agent.skills[0];
  const loading = build ? 'required' : skillStatus(run, agent.id);
  return <article className={`agent-card ${selected ? 'selected' : ''} status-${state}`}>
    <button className="agent-select" onClick={onSelect} aria-pressed={selected} aria-label={`Select ${agent.name}`}>
      <span className="stage-number">{index + 1}</span><span className="agent-heading"><strong>{agent.name}</strong><small>{agent.role}</small></span>
      <span className={`stage-status ${state}`}>
        {state === 'done' ? <CheckCircle2 size={14} /> : state === 'running' ? <LoaderCircle className="spin" size={14} /> : state === 'blocked' ? <CircleAlert size={14} /> : state === 'pending' ? <Clock3 size={14} /> : null}
        {state === 'done' ? 'Done' : state === 'running' ? 'Working' : state === 'blocked' ? 'Blocked' : state === 'pending' ? 'Waiting' : state === 'stopped' ? 'Stopped' : ''}
      </span>
    </button>
    <div className="agent-facts"><div><span>Harness</span><strong><Code2 size={15} />{agent.harness}</strong></div><div><span>{build ? 'Produces' : state === 'done' ? 'Produced' : 'Will produce'}</span><strong>{agent.output}</strong></div></div>
    {skill ? <div className="agent-capabilities"><span className="field-label">Required skills</span><button className={`skill-summary state-${loading}`} onClick={() => { onSelect(); onEvidence(capabilitiesFor(agent, run, build).find((item) => item.id === skill)); }}>
      <StateIcon status={loading} size={15} /><span>{skill}</span><span className="skill-state">{build ? 'Required' : loading === 'loaded' ? 'Loaded' : loading === 'missing' ? 'Not loaded' : 'Waiting'}</span>{agent.skills.length > 1 && <span className="count-badge">+{agent.skills.length - 1}</span>}<ChevronRight size={14} />
    </button></div> : <div className="agent-sources"><span className="field-label">{build ? 'Tools' : 'Sources'}</span><button onClick={() => { onSelect(); onEvidence({ kind: 'sources', owner: agent.id }); }}><FileText size={15} />{build ? `${agent.tools.length} available tools` : state === 'done' ? '5 sources' : 'Awaiting research'}<ChevronRight size={13} /></button></div>}
  </article>;
}

function Evidence({ item, agent, run, build, onBack, onRemove, onRepair }) {
  const heading = useRef(null);
  useEffect(() => { heading.current?.focus(); }, [item.id]);
  const isSkill = item.kind === 'skill';
  const loaded = item.status === 'loaded';
  const missing = item.status === 'missing';
  return <section className="evidence-sheet" aria-label={`${item.name} evidence`}>
    <div className="evidence-title"><button className="back-button" onClick={onBack}><ArrowLeft size={15} />Graph</button><span className="eyebrow">{build ? 'Skill configuration' : 'Example evidence'}</span></div>
    <div className="evidence-identity"><span className="large-icon"><CapabilityIcon item={item} size={22} /></span><div><h3 ref={heading} tabIndex={-1}>{item.name}</h3><p>{isSkill ? `Source: ${item.origin} · Execution: ${agent.harness}` : `${agent.name} · ${item.label}`}</p></div><span className={`status-label state-${item.status}`}><StateIcon status={item.status} />{item.label}</span></div>
    {isSkill ? <>
      <div className="receipt-steps">
        <div><CheckCircle2 size={16} className="success" /><span><strong>Bundle selected</strong><small>{item.name} · v{item.version} · {item.hash}</small></span></div>
        <div>{build ? <Clock3 size={16} /> : <CheckCircle2 size={16} className="success" />}<span><strong>{build ? 'Prepared when the run starts' : 'Prepared for this agent'}</strong><small>{agent.harness === 'Claude Code' ? '.claude' : '.agents'}/skills/{item.name}/SKILL.md</small></span></div>
        <div>{loaded ? <CheckCircle2 size={16} className="success" /> : missing ? <CircleAlert size={16} className="danger" /> : <Clock3 size={16} className="muted" />}<span><strong>{loaded ? 'Instructions loaded successfully' : missing ? 'Required instructions did not load' : 'Activation required before work'}</strong><small>{loaded ? `Run ${run.id} · ${agent.name} · successful read at +1m 12s` : missing ? 'The skill file read failed. This stage is blocked.' : 'Availability alone does not satisfy this requirement.'}</small></span></div>
      </div>
      <div className="evidence-note"><ShieldCheck size={16} /><p>{build ? 'This skill is required. The agent must load its instructions before working.' : loaded ? 'Loading is recorded. Following the instructions is checked separately in the output review.' : 'The required skill stays visible until its loading requirement is satisfied.'}</p></div>
      {build && <button className="text-button danger" onClick={() => onRemove(item.id)}><Trash2 size={14} />Remove from this agent</button>}
      {missing && <button className="button primary small" onClick={onRepair}>Inspect in Build<ArrowRight size={14} /></button>}
    </> : <>
      <p className="tool-description">{item.description}</p>
      <div className="tool-events">{item.count ? item.calls.map((call, index) => <div key={call}><CheckCircle2 className="success" size={15} /><span>{call}</span><small>#{index + 1}</small></div>) : <div><Clock3 size={16} /><span>Available to this agent. No calls recorded{build ? ' before execution' : ''}.</span></div>}</div>
      <div className="evidence-note"><CircleDot size={15} /><p>These calls belong to {agent.name}. They are not attributed to a skill without supporting evidence.</p></div>
    </>}
  </section>;
}

function SkillLibrary({ agent, onAttach, onClose }) {
  const [query, setQuery] = useState('');
  const matches = library.filter((item) => `${item.name} ${item.origin} ${item.description}`.toLowerCase().includes(query.toLowerCase()));
  return <Modal title="Add a required skill" onClose={onClose} wide>
    <div className="library-intro"><p>Choose a skill for <strong>{agent.name}</strong>, running in <strong>{agent.harness}</strong>.</p><span className="example-badge">Example local library</span></div>
    <label className="search-field"><Search size={17} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a skill by name or source…" aria-label="Search skills" /></label>
    <div className="library-list">{matches.map((item) => <article className="library-skill" key={item.id}><span className="large-icon"><Puzzle size={22} /></span><div><h3>{item.name}<span>v{item.version}</span></h3><p>{item.description}</p><small>Found in {item.origin} · {item.resources}</small><small>Needs: {item.dependencies}</small></div><button className={`button ${agent.skills.includes(item.id) ? 'attached' : 'secondary'} small`} disabled={agent.skills.includes(item.id)} onClick={() => onAttach(item.id)}>{agent.skills.includes(item.id) ? <><Check size={14} />Attached</> : <><Plus size={14} />Attach</>}</button></article>)}</div>
    {!matches.length && <p className="empty-text">No matching skills. Try another name or source.</p>}
    <div className="modal-footnote">The skill’s source is independent of the harness that runs it.</div>
  </Modal>;
}

export function App() {
  const [mode, setMode] = useState('run');
  const [team, setTeam] = useState(readTeam);
  const [saved, setSaved] = useState(true);
  const [run, setRun] = useState(() => makeRun());
  const [selected, setSelected] = useState('designer');
  const [filter, setFilter] = useState('all');
  const [scope, setScope] = useState('selected');
  const [graphView, setGraphView] = useState('graph');
  const [evidence, setEvidence] = useState(null);
  const [modal, setModal] = useState(null);
  const [menu, setMenu] = useState(false);
  const [expandedOutput, setExpandedOutput] = useState(false);
  const [revision, setRevision] = useState('');
  const [reviewChecked, setReviewChecked] = useState(false);
  const [toast, setToast] = useState('');
  const timers = useRef([]);
  const menuRef = useRef(null);
  const graphRef = useRef(null);
  const build = mode === 'build';
  const activeTeam = build ? team : run.team;
  const agent = activeTeam.agents.find((item) => item.id === selected) || activeTeam.agents[1];
  const counts = requiredCounts(run);
  const busy = ['researching', 'designing'].includes(run.phase);
  const blocked = run.phase === 'blocked';
  const stopped = run.phase === 'stopped';
  const agentCaps = capabilitiesFor(agent, run, build);
  const evidenceAgent = activeTeam.agents.find((item) => item.id === evidence?.owner) || agent;
  const evidenceItem = evidence ? capabilitiesFor(evidenceAgent, run, build).find((item) => item.id === evidence.id && item.kind === evidence.kind) : null;
  const graphAgents = scope === 'team' ? activeTeam.agents : [agent];
  const visibleCaps = graphAgents.flatMap((entry) => capabilitiesFor(entry, run, build)).filter((item) => filter === 'all' || item.kind === filter);

  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(''), 4000); return () => clearTimeout(id); }, [toast]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  useEffect(() => {
    if (!menu) return;
    const close = (event) => { if (!menuRef.current?.contains(event.target)) setMenu(false); };
    const escape = (event) => { if (event.key === 'Escape') setMenu(false); };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, [menu]);

  const inspect = useCallback((item) => {
    if (item.kind === 'sources') { setModal('sources'); return; }
    setEvidence(item);
    setTimeout(() => graphRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 0);
  }, []);

  function changeMode(next) { setMode(next); setEvidence(null); setExpandedOutput(false); setModal(null); }
  function changeAgent(id) { setSelected(id); setEvidence(null); }
  function updateAgent(key, value) { setTeam((current) => ({ ...current, agents: current.agents.map((item) => item.id === selected ? { ...item, [key]: value } : item) })); setSaved(false); }
  function attachSkill(id) { updateAgent('skills', [...agent.skills, id]); setModal(null); setFilter('all'); setEvidence(null); setToast(`${id} is now required for ${agent.name}.`); }
  function removeSkill(id) { setTeam((current) => ({ ...current, agents: current.agents.map((entry) => entry.id === evidenceAgent.id ? { ...entry, skills: entry.skills.filter((skill) => skill !== id) } : entry) })); setSaved(false); setEvidence(null); }
  function saveTeam() { try { localStorage.setItem(savedTeamKey, JSON.stringify(team)); setSaved(true); setToast('Team saved in this browser.'); } catch { setToast('Browser storage is unavailable. Your changes remain in this session.'); } }
  function stopDemo() { timers.current.forEach(clearTimeout); timers.current = []; setRun((current) => ({ ...current, stoppedDuring: current.phase, phase: 'stopped' })); setToast('Example run stopped.'); }
  function startDemo(sourceTeam = team, requestedRevision = '') {
    timers.current.forEach(clearTimeout);
    const next = makeRun(run.id + 1, 'live', sourceTeam, requestedRevision);
    setRun(next); setMode('run'); setEvidence(null); setMenu(false); setModal(null); setReviewChecked(false); setRevision(''); setSelected('researcher');
    setToast('Playing an example run. No agents are being started.');
    timers.current = [
      setTimeout(() => { setRun((current) => ({ ...current, phase: 'designing' })); setSelected('designer'); }, 2200),
      setTimeout(() => { setRun((current) => ({ ...current, phase: 'finished', scenario: 'complete' })); setToast(requestedRevision ? 'Revision brief recorded. The example report is unchanged.' : 'Example run finished. The report is ready for review.'); }, 5000),
    ];
  }
  function chooseExample(scenario) {
    timers.current.forEach(clearTimeout); setMenu(false); setEvidence(null); setReviewChecked(false); setModal(null); setExpandedOutput(false);
    if (scenario === 'live') { startDemo(initialTeam); return; }
    setRun(makeRun(scenario === 'missing' ? 14 : 15, scenario)); setSelected('designer');
  }
  function openReview() { setReviewChecked(false); setModal('review'); }
  async function copyReport() { try { await navigator.clipboard.writeText(reportMarkdown(run)); setToast('Report copied.'); } catch { setToast('Clipboard access is unavailable. Use Download instead.'); } }
  function downloadReport() { const url = URL.createObjectURL(new Blob([reportMarkdown(run)], { type: 'text/markdown' })); const link = document.createElement('a'); link.href = url; link.download = `loomwatch-example-report-run-${run.id}.md`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand-group"><span className="brand">LoomWatch</span><span className="brand-slash">/</span><span className="team-name">{activeTeam.name}</span></div>
      <nav className="mode-switch" aria-label="Workspace mode"><button className={build ? '' : 'active'} onClick={() => changeMode('run')} aria-pressed={!build}><Play size={15} fill={!build ? 'currentColor' : 'none'} />Run</button><button className={build ? 'active' : ''} onClick={() => changeMode('build')} aria-pressed={build}><Wrench size={15} />Build</button></nav>
      <div className="topbar-right"><span className="prototype-label"><span className="subtle-dot" />Interactive prototype</span><span className="avatar" aria-label="LoomWatch workspace">LW</span></div>
    </header>

    <main className={`workspace ${build ? 'build-workspace' : ''} ${expandedOutput ? 'output-expanded' : ''}`}>
      <section className="work-pane" aria-label={build ? 'Team builder' : 'Run workflow'}>
        <div className="run-head">
          <div className="run-heading-row"><h1>{build ? 'Team setup' : `Run ${run.id}`}</h1>{build ? <span className="meta-state">{saved ? 'Saved team' : 'Unsaved changes'}</span> : <><span className={`execution-state ${blocked ? 'danger' : busy ? 'live' : stopped ? 'muted' : 'success'}`}>{busy ? <LoaderCircle size={17} className="spin" /> : blocked ? <CircleAlert size={17} /> : stopped ? <Square size={14} /> : <CheckCircle2 size={17} />}{busy ? 'Running' : blocked ? 'Execution blocked' : stopped ? 'Stopped' : 'Execution finished'}</span><span className="divider" /><span className={`review-state ${run.reviewed ? 'success' : ''}`}><CircleDot size={15} />{blocked ? 'Required skill missing' : busy ? 'Output in progress' : stopped ? 'Output not produced' : run.reviewed ? 'Reviewed by you' : 'Review pending'}</span></>}</div>
          <p>{build ? 'Drag components onto the canvas, arrange them, then connect the team.' : run.revision ? 'Follow-up to the previous report.' : run.team.request}</p>
          <div className="run-head-actions">{build ? <><button className="button secondary small" onClick={saveTeam} disabled={saved}>Save</button><button className="button primary" onClick={() => startDemo(team)}><Play size={15} />Run team</button></> : busy ? <button className="button secondary" onClick={stopDemo}><Square size={14} />Stop run</button> : blocked ? <button className="button primary" onClick={() => { setEvidence(agentCaps.find((item) => item.status === 'missing')); graphRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }}>Inspect skill<ArrowRight size={16} /></button> : stopped ? <button className="button primary" onClick={() => startDemo(run.team)}><Play size={15} />Try again</button> : <button className="button primary" onClick={openReview}>{run.reviewed ? 'View review' : 'Review output'}<ArrowRight size={17} /></button>}</div>
        </div>

        {build ? <BuildCanvas team={team} onTeamChange={setTeam} onDirty={() => setSaved(false)} onNotice={setToast} /> : <div className="work-scroll">
          <div className="request-block"><div className="request-label-row"><span className="eyebrow">{build ? 'Team request' : 'Request'}</span>{!build && <div className="example-picker" ref={menuRef}><button className="text-button" onClick={() => setMenu(!menu)} aria-expanded={menu} aria-haspopup="menu">Example run<ChevronDown size={13} /></button>{menu && <div className="example-menu" role="menu"><span className="eyebrow">Explore the states</span><button role="menuitem" onClick={() => chooseExample('complete')}><CheckCircle2 size={16} /><span>Skills loaded<small>Run 15 · review pending</small></span></button><button role="menuitem" onClick={() => chooseExample('missing')}><CircleAlert size={16} /><span>Required skill missing<small>Run 14 · stage blocked</small></span></button><button role="menuitem" onClick={() => chooseExample('live')}><Play size={15} /><span>Watch a live example<small>Simulated 5-second run</small></span></button></div>}</div>}</div>
            {build ? <textarea className="request-input" aria-label="Team request" value={team.request} onChange={(event) => { setTeam({ ...team, request: event.target.value }); setSaved(false); }} /> : <p>{run.team.request}</p>}
          </div>

          <div className="lane-section"><div className="section-label"><span>{build ? 'Planned workflow' : 'Team handoff'}</span><span className="quiet-caption">2 stages · 1 deliverable</span></div>
            <div className="agent-lane">
              <AgentCard agent={activeTeam.agents[0]} index={0} run={run} build={build} selected={selected === 'researcher'} onSelect={() => changeAgent('researcher')} onEvidence={inspect} />
              <button className="handoff" disabled={!build && (run.phase === 'researching' || (run.phase === 'stopped' && run.stoppedDuring !== 'designing'))} onClick={() => setModal('handoff')} aria-label="Inspect research brief handoff"><span>Research brief</span><ArrowRight size={64} strokeWidth={1} /><span className="handoff-small">View handoff</span></button>
              <AgentCard agent={activeTeam.agents[1]} index={1} run={run} build={build} selected={selected === 'designer'} onSelect={() => changeAgent('designer')} onEvidence={inspect} />
            </div>
          </div>

          {build && <section className="agent-editor"><div className="section-label"><h2>{agent.name}</h2><span className="quiet-caption">Changes apply to the next run</span></div><div className="form-grid"><label>Role<input value={agent.role} onChange={(event) => updateAgent('role', event.target.value)} /></label><label>Execution harness<select value={agent.harness} onChange={(event) => updateAgent('harness', event.target.value)}><option>Codex</option><option>Claude Code</option><option>OpenCode</option></select></label><label className="wide-field">Contribution<input value={agent.output} onChange={(event) => updateAgent('output', event.target.value)} /></label></div></section>}

          <section ref={graphRef} className="graph-section" aria-label="Skills and tools">
            <div className="graph-heading"><div><h2>{scope === 'team' ? 'Team capabilities' : `${agent.name} details`}</h2><p>{build ? 'Attach required skills independently of their source.' : 'Skills loaded and tools called by this agent.'}</p></div>{build ? <button className="button secondary small" onClick={() => setModal('library')}><Plus size={14} />Add skill</button> : <span className={`loaded-summary ${counts.loaded < counts.total ? 'attention' : ''}`}><Puzzle size={14} />{counts.loaded}/{counts.total} required loaded</span>}</div>
            <div className="graph-toolbar"><div className="filter-tabs" aria-label="Capability type">{[['all', 'All'], ['skill', 'Skills'], ['tool', 'Tools']].map(([id, title]) => <button key={id} className={filter === id ? 'active' : ''} onClick={() => { setFilter(id); setEvidence(null); }} aria-pressed={filter === id}>{title}</button>)}</div><div className="graph-options"><label className="sr-only" htmlFor="graph-scope">Graph scope</label><select id="graph-scope" value={scope} onChange={(event) => { setScope(event.target.value); setEvidence(null); }}><option value="selected">Selected agent</option><option value="team">Whole team</option></select><div className="view-switch"><button className={graphView === 'graph' ? 'active' : ''} aria-label="Graph view" aria-pressed={graphView === 'graph'} onClick={() => { setGraphView('graph'); setEvidence(null); }}><Network size={16} /></button><button className={graphView === 'list' ? 'active' : ''} aria-label="List view" aria-pressed={graphView === 'list'} onClick={() => { setGraphView('list'); setEvidence(null); }}><List size={16} /></button></div></div></div>
            {evidenceItem ? <Evidence item={evidenceItem} agent={evidenceAgent} run={run} build={build} onBack={() => setEvidence(null)} onRemove={removeSkill} onRepair={() => changeMode('build')} /> : graphView === 'graph' ? <CapabilityGraph agents={graphAgents} run={run} filter={filter} build={build} onInspect={inspect} /> : <div className="capability-list">{visibleCaps.length ? visibleCaps.map((item) => <button key={`${item.owner}:${item.id}`} onClick={() => inspect(item)}><CapabilityIcon item={item} /><span><strong>{item.name}{item.kind === 'skill' && <span className="required-mini">Required</span>}</strong><small>{activeTeam.agents.find((entry) => entry.id === item.owner)?.name}{item.kind === 'skill' ? ` · from ${item.origin}` : ''}</small></span><span className={`status-label state-${item.status}`}><StateIcon status={item.status} />{item.label}</span><ChevronRight size={15} /></button>) : <div className="graph-empty"><Puzzle size={22} /><strong>No skills attached</strong><p>Use Build to add a required skill.</p></div>}</div>}
            {!evidenceItem && <div className="graph-footer"><span><CircleDot size={12} />{build ? 'Connections describe the next run' : 'Select a capability to inspect its evidence'}</span><span>{build ? 'Required ≠ loaded' : 'Example event data'}</span></div>}
          </section>
          <div className="workspace-footnote"><ShieldCheck size={13} />{build ? 'Skill source and execution harness are independent.' : 'Loading evidence and output quality are checked separately.'}</div>
        </div>}
      </section>

      <aside className="output-pane" aria-label={build ? 'Expected output' : 'Team output'}>
        <header className="output-header"><div className="output-kicker"><span className="eyebrow"><FileText size={17} />{build ? 'Expected output' : 'Team output'}</span><div className="output-actions">{!build && !busy && !blocked && !stopped && <><button className="icon-button" title="Copy report" aria-label="Copy report" onClick={copyReport}><Copy size={15} /></button><button className="icon-button" title="Download report" aria-label="Download report" onClick={downloadReport}><Download size={16} /></button></>}<button className="icon-button" title={expandedOutput ? 'Restore split view' : 'Expand output'} aria-label={expandedOutput ? 'Restore split view' : 'Expand output'} onClick={() => setExpandedOutput(!expandedOutput)}>{expandedOutput ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button></div></div><div className="output-title-row"><h2>{activeTeam.output}</h2><span className={`output-badge ${run.reviewed && !build ? 'ready' : ''}`}>{build ? 'Planned' : blocked ? 'Missing' : busy || stopped ? 'Pending' : run.reviewed ? 'Reviewed' : 'Draft'}</span></div><p>{build ? 'What the team should deliver' : busy || blocked || stopped ? 'Assigned to Report Designer' : 'Produced by Report Designer'}</p></header>
        {build ? <div className="output-content build-output"><span className="large-icon"><FileText size={25} /></span><h3>Start with the result.</h3><p>A clear deliverable gives every agent a shared destination.</p><div className="output-form"><label>Deliverable name<input value={team.output} onChange={(event) => { setTeam({ ...team, output: event.target.value }); setSaved(false); }} /></label><label>Format<select value={team.format} onChange={(event) => { setTeam({ ...team, format: event.target.value }); setSaved(false); }}><option>Markdown report</option><option disabled>HTML dashboard · coming later</option><option disabled>Document and supporting files · coming later</option></select></label></div><div className="requirements-block"><h4>Before this output is ready</h4><div><ShieldCheck size={18} /><span><strong>All required skills must load</strong><small>Missing activation blocks the responsible stage.</small></span><Check size={17} /></div><div><FileText size={18} /><span><strong>The deliverable must exist</strong><small>Status messages are kept in activity.</small></span><Check size={17} /></div><div><CheckCircle2 size={18} /><span><strong>Review the example report</strong><small>This example includes an output review.</small></span><Check size={17} /></div></div><div className="build-note"><GitBranch size={17} /><p>The selected run keeps its original team and skill requirements. Your changes apply to the next run.</p></div></div> : blocked || stopped ? <div className="output-content output-empty"><span className="empty-output-icon">{blocked ? <CircleAlert size={30} /> : <Square size={25} />}</span><span className="eyebrow">{blocked ? 'Required skill missing' : 'Run stopped'}</span><h3>Report not produced</h3><p>{blocked ? 'Report Designer could not load claude-design. The stage stopped before producing the final report.' : run.stoppedDuring === 'designing' ? 'The run stopped before Report Designer finished. Your research brief is still available.' : 'The run stopped during research, before a brief was produced.'}</p>{(blocked || run.stoppedDuring === 'designing') && <button className="button secondary" onClick={() => setModal('handoff')}><FileText size={16} />Open research brief</button>}{blocked && <button className="text-button gold" onClick={() => { setSelected('designer'); inspect(capabilitiesFor(run.team.agents[1], run).find((item) => item.kind === 'skill')); }}>Inspect skill evidence<ArrowRight size={14} /></button>}</div> : busy ? <div className="output-content output-empty"><LoaderCircle size={30} className="spin gold" /><span className="eyebrow">{run.phase === 'researching' ? 'Researching' : 'Preparing the report'}</span><h3>Your team is at work.</h3><p>{run.phase === 'researching' ? 'Researcher is preparing the brief that Report Designer will use.' : 'Report Designer loaded its required skills and is preparing the final deliverable.'}</p><div className="progress-steps"><span className="active" /><span className={run.phase === 'designing' ? 'active' : ''} /></div><small>This is a simulated run.</small></div> : <div className="output-content"><article className="report"><h3>Make agent teamwork<br className="wide-break" /> understandable</h3><p className="report-intro">LoomWatch helps teams build, run, and inspect multi-agent work, with the result and its evidence in view.</p>{reportSections.map((section) => <section key={section.title}><h4>{section.title}</h4><p>{section.body}</p></section>)}{run.revision && <section className="revision-note"><span className="eyebrow">Revision brief recorded</span><p>{run.revision}</p><small>The prototype records your request; the example report has not been regenerated.</small></section>}<footer><FileText size={13} /><span>Example report · {run.team.format}</span>{run.reviewed && <span className="success"><Check size={13} />Reviewed</span>}</footer></article></div>}
        {!build && <form className="revision-composer" onSubmit={(event) => { event.preventDefault(); if (revision.trim() && !busy && !blocked && !stopped) startDemo(run.team, revision.trim()); }}><MessageSquare size={18} /><label className="sr-only" htmlFor="revision">Request a revision to this report</label><input id="revision" placeholder={blocked ? 'Resolve the missing skill to continue' : 'What should change?'} value={revision} onChange={(event) => setRevision(event.target.value)} disabled={busy || blocked || stopped} /><button aria-label="Request revision" title="Request revision" disabled={!revision.trim() || busy || blocked || stopped}><ArrowRight size={19} /></button></form>}
        {build && <div className="output-bottom-note"><Puzzle size={14} />{team.agents.reduce((total, item) => total + item.skills.length, 0)} required skills across this team</div>}
      </aside>
    </main>

    {modal === 'library' && <SkillLibrary agent={agent} onAttach={attachSkill} onClose={() => setModal(null)} />}
    {modal === 'review' && <Modal title={run.reviewed ? 'Output review' : 'Review team output'} onClose={() => setModal(null)}><div className="review-modal"><div className="review-document"><FileText size={25} /><div><strong>{run.team.output}</strong><small>Run {run.id} · Report Designer</small></div><span className="output-badge">{run.reviewed ? 'Reviewed' : 'Draft'}</span></div><div className="review-check"><CheckCircle2 size={18} className="success" /><span><strong>{counts.loaded} of {counts.total} required skills loaded</strong><small>The receipt establishes instruction loading, not output quality.</small></span></div><div className="review-check"><CheckCircle2 size={18} className="success" /><span><strong>Example report is available</strong><small>You can read, copy, or download the report.</small></span></div>{run.reviewed ? <div className="reviewed-message"><ShieldCheck size={22} /><div><strong>Reviewed by you</strong><p>This marks your review of this example output.</p></div></div> : <><label className="review-checkbox"><input type="checkbox" checked={reviewChecked} onChange={(event) => setReviewChecked(event.target.checked)} /><span>I have reviewed the report and its supporting evidence.</span></label><div className="modal-actions"><button className="button secondary" onClick={() => setModal(null)}>Keep reading</button><button className="button primary" disabled={!reviewChecked || counts.loaded !== counts.total} onClick={() => { setRun({ ...run, reviewed: true }); setModal(null); setToast('Example output marked as reviewed by you.'); }}><Check size={16} />Mark reviewed</button></div></>}</div></Modal>}
    {modal === 'handoff' && <Modal title="Research brief handoff" onClose={() => setModal(null)} wide><div className="handoff-modal"><div className="handoff-route"><span><Bot size={17} />Researcher</span><ArrowRight size={24} /><span><Bot size={17} />Report Designer</span></div><p className="handoff-context">{build ? 'The next stage will receive this contribution and the team request.' : 'The input passed to Report Designer in this example.'}</p><div className="brief-document"><span className="eyebrow"><FileText size={15} />research-brief.md · Example artifact</span><h3>Make the work easier to follow.</h3><p>Investigate how teams understand the output of multi-agent workflows, verify skill usage, and reuse skills across execution harnesses.</p><h4>Directions to explore</h4><ul><li>Make the final deliverable immediately identifiable.</li><li>Show which required skills loaded for each agent.</li><li>Keep tool activity attached to the responsible agent.</li><li>Allow local skills to travel between harnesses.</li></ul><h4>Handoff to Report Designer</h4><p>Use this brief to prepare a concise market-opportunity report. Load the required claude-design skill before starting. Distinguish observations from assumptions.</p></div></div></Modal>}
    {modal === 'sources' && <Modal title="Researcher’s sources" onClose={() => setModal(null)}><div className="sources-list"><p>Example input sources used to illustrate the workflow.</p>{['Project README', 'Agent workflow notes', 'Skill portability notes', 'User interview outline', 'Research brief'].map((source, index) => <div key={source}><FileText size={18} /><span>{source}</span><span className="quiet-caption">Source {index + 1}</span></div>)}</div></Modal>}
    <div className={`toast ${toast ? 'visible' : ''}`} role="status" aria-live="polite">{toast && <><CheckCircle2 size={17} />{toast}</>}</div>
  </div>;
}
