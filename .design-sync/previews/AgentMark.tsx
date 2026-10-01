import type { ReactNode } from 'react'
import { AgentMark } from '@loomwatch/design-system'

function Themes({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
      {(['dark', 'light'] as const).map((theme) => (
        <div key={theme} data-theme={theme} style={{ padding: 20, borderRadius: 14, border: '1px solid var(--color-hairline)' }}>{children}</div>
      ))}
    </div>
  )
}

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 6, minWidth: 64 }}>
      {children}
      <span className="t-mono-sm" style={{ color: 'var(--color-ink-3)', textAlign: 'center' }}>{label}</span>
    </span>
  )
}

const TEAM = [['news-collector', 'News Collector'], ['news-editor', 'News Editor'], ['digest-writer', 'Digest Writer'], ['market-researcher', 'Researcher']] as const

export function OneWeavePerAgent() {
  return (
    <Themes>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
        {TEAM.map(([id, name]) => <Labelled key={id} label={name}><AgentMark id={id} name={name} size={34} /></Labelled>)}
        <Labelled label="You (review)"><AgentMark id="review" name="You" operator size={34} /></Labelled>
      </div>
    </Themes>
  )
}

const STATES = [
  ['turn', 'not started'], ['starting', 'starting'], ['thinking', 'thinking'], ['working', 'using a tool'],
  ['writing', 'writing'], ['waiting', 'waits on you'], ['done', 'done'], ['failed', 'failed'], ['stopped', 'stopped'],
] as const

export function RunStates() {
  return (
    <Themes>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, max-content)', gap: '14px 18px' }}>
        {STATES.map(([state, label]) => (
          <Labelled key={state} label={label}><AgentMark id="digest-writer" name="Digest Writer" state={state} animate={false} size={30} /></Labelled>
        ))}
      </div>
    </Themes>
  )
}

export function InTheTeamSentence() {
  return (
    <Themes>
      <div className="team-story">
        <span className="eyebrow">Your team, in one sentence</span>
        <p>
          When you ask, <span className="story-name"><AgentMark id="news-collector" name="News Collector" size={16} />News Collector</span> collects
          what is needed, then <span className="story-name you"><AgentMark id="review" operator size={16} />You</span> approve, and
          finally <span className="story-name"><AgentMark id="digest-writer" name="Digest Writer" size={16} />Digest Writer</span> writes the answer.
        </p>
      </div>
    </Themes>
  )
}
