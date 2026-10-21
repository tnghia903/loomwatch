import { ArrowUp } from 'lucide-react'
import { Fragment, useCallback, useEffect, useId, useMemo, useState } from 'react'

import type { AiStatus } from '../../lib/ai/client'
import { sourceMaker } from '../../lib/ai/makers'
import { SOURCE_INFO, connectedSources, sourceOf } from '../../lib/ai/sources'
import { useAiStatus } from '../../lib/ai/useKeyStatus'
import { FIRST_FIGURE, askFirstAgent, firstAgentNow, forMeRequest, keepFirstAgent } from '../../lib/firstrun/firstAgent'
import { EMPTY_ABOUT, aboutFrom, aboutLine, type QuickAbout } from '../../lib/firstrun/quickAbout'
import { markFirstRun } from '../../lib/firstrun/store'
import { plainRunError } from '../../lib/runs/errors'
import { isTerminalRun, type RunRecord } from '../../lib/runs/client'
import { useRunSession } from '../../lib/runs/useRunSession'
import { announceYou, saveYou, toldNothing, useYou } from '../../lib/you/client'
import { FigureStill } from '../agents/FigureStill'
import { ChatGptPlan } from '../connections/ChatGptPlan'
import { ClaudeCredit } from '../connections/ClaudeCredit'
import { OpenRouterKey } from '../connections/OpenRouterKey'
import { QUESTIONS, QuickChoices } from '../you/QuickChoices'
import { MakerMark } from '../models/MakerMark'
import { LoomMark, LoomWordmark } from '../ui/glyphs'
import { Markdown } from '../ui/Markdown'
import { ConnectSheet, type AiOption } from './ConnectSheet'

/** The colour the first run shows a connected AI in: LoomWatch's own indigo, not a brand's. */
const AI_COLOR = '#5867A8'

/**
 * The AIs the first agent can answer with, in the sheet that asks for one (ADR 0073): the plans the
 * person may already pay for, then an OpenRouter key, each with what it costs. Each form says when
 * it connects, and the first run goes on with the Send that asked.
 */
const optionsFor = (status: AiStatus | null, connected: () => void): readonly AiOption[] => [
  ...(status?.chatgpt.available ? [{
    id: 'chatgpt',
    title: 'ChatGPT Plus or Pro',
    cost: 'Uses your plan’s allowance, at no extra charge, until its limit.',
    color: AI_COLOR,
    logo: <MakerMark maker={sourceMaker('chatgpt')} />,
    connect: <ChatGptPlan variant="card" onConnected={connected} />,
  }] : []),
  {
    id: 'anthropic',
    title: 'Claude Max or Team',
    cost: 'Spends your plan’s monthly API credit. Each task has a price.',
    color: AI_COLOR,
    logo: <MakerMark maker={sourceMaker('anthropic')} />,
    connect: <ClaudeCredit variant="card" onConnected={connected} />,
  },
  {
    id: 'openrouter',
    title: 'OpenRouter key',
    cost: 'Pay as you go: add credit at OpenRouter. Most tasks cost a few cents.',
    color: AI_COLOR,
    logo: <MakerMark maker={sourceMaker('openrouter')} />,
    connect: <OpenRouterKey variant="card" onChange={(key) => { if (key.connected) connected() }} />,
  },
]

const EXAMPLES = ['Plan a 30-minute lesson about animals', 'Reply to a customer whose order is late', 'Explain how compound interest works']

interface Turn {
  runId: string
  request: string
  /** Asked again after the person told their agents about themselves. */
  forYou: boolean
}

type Stage = 'asking' | 'offered' | 'telling' | 'redoing' | 'finale'

const message = (failed: unknown) => (failed instanceof Error ? failed.message : String(failed))

/**
 * The first run (ADR 0075): a newcomer makes something before setting anything up. Their first
 * agent asks what to make first, in the crew figure it keeps in My agents. Setup comes only when it is needed: the first Send asks which AI should
 * answer when none is connected, and after the first answer it offers "Tell my agents about me"
 * (About you, ADR 0074), then answers the same request again for them. It ends by keeping the agent
 * in My agents, or going Home. Plain words throughout: no metaphor a newcomer has to decode.
 */
export function FirstRun({ onLookAround, onDone }: { onLookAround: () => void; onDone: () => void }) {
  const ai = useAiStatus()
  const you = useYou()
  const connected = ai !== null && connectedSources(ai).length > 0
  // How the first agent is paid with what is connected now.
  const using = connected ? SOURCE_INFO[sourceOf(firstAgentNow().model)] : null
  const [text, setText] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [justConnected, setJustConnected] = useState(false)
  const [turns, setTurns] = useState<Turn[]>([])
  const [settled, setSettled] = useState<Record<string, RunRecord['status']>>({})
  const [stage, setStage] = useState<Stage>('asking')
  const [told, setTold] = useState<QuickAbout>(EMPTY_ABOUT)
  const [sending, setSending] = useState(false)
  const [keeping, setKeeping] = useState(false)
  const [error, setError] = useState('')
  const inputId = useId()

  const working = turns.some((turn) => !settled[turn.runId])
  const first = turns.find((turn) => !turn.forYou) ?? null
  const madeForYou = turns.some((turn) => turn.forYou && settled[turn.runId] === 'succeeded')

  const start = useCallback(async (request: string, forYou: boolean) => {
    setSending(true)
    setError('')
    try {
      const run = await askFirstAgent(forYou ? forMeRequest(request) : request)
      setTurns((list) => [...list, { runId: run.runId, request, forYou }])
      if (!forYou) setText('')
    } catch (failed) {
      setError(message(failed))
    } finally {
      setSending(false)
    }
  }, [])

  const send = () => {
    const request = text.trim()
    if (!request || sending || working) return
    if (!connected) { setPending(request); setConnecting(true); return }
    void start(request, false)
  }

  // The sheet's form connected an AI: go on with the Send that asked for it.
  const onConnected = useCallback(() => {
    setConnecting(false)
    setJustConnected(true)
    setPending(null)
    if (pending) void start(pending, false)
  }, [pending, start])
  const options = useMemo(() => optionsFor(ai, onConnected), [ai, onConnected])

  const onSettled = useCallback((turn: Turn, record: RunRecord) => {
    setSettled((was) => (was[turn.runId] === record.status ? was : { ...was, [turn.runId]: record.status }))
    if (record.status !== 'succeeded') return
    if (turn.forYou) setStage('finale')
    // After the first answer, once: the offer, unless they told their agents about themselves already.
    else setStage((now) => (now === 'asking' ? (you && toldNothing(you) ? 'offered' : 'finale') : now))
  }, [you])

  const answerAgain = async () => {
    if (!first) return
    setError('')
    setStage('redoing')
    try {
      const about = [you?.about?.trim(), aboutFrom(told)].filter(Boolean).join('\n')
      const kept = await saveYou({ name: told.name.trim() || you?.name || '', about, skipped: false })
      announceYou(kept)
      await start(first.request, true)
    } catch (failed) {
      setError(message(failed))
      setStage('telling')
    }
  }

  const keep = async () => {
    setKeeping(true)
    setError('')
    try {
      const id = await keepFirstAgent()
      markFirstRun('done')
      window.location.assign(`/agents/${encodeURIComponent(id)}?view=chat`)
    } catch (failed) {
      setError(`Couldn’t keep it: ${message(failed)}`)
      setKeeping(false)
    }
  }

  const home = () => { markFirstRun('done'); onDone() }
  const name = you?.name?.trim() || told.name.trim()
  const say = madeForYou
    ? { head: `Done${name ? `, ${name}` : ''}. That one was made for you.`, sub: 'Every agent you make reads what you told me. Change it any time in About you.' }
    : justConnected
      ? { head: 'Connected.', sub: `I’m answering ${using?.on ?? 'with what you connected'}. Change it any time in Connections.` }
      : { head: 'What shall we make first?', sub: 'Ask for anything. I’ll only stop to ask you something when I need it.' }

  return (
    <div className="lw-home fr" data-first-run style={connected ? { ['--fr-ai' as string]: AI_COLOR } : undefined}>
      <div className="ground" aria-hidden="true" />
      <header className="home-top">
        <span className="home-brand"><LoomMark size={28} /><LoomWordmark height={19} /></span>
        <button type="button" className="link fr-look" onClick={onLookAround}>Just look around</button>
      </header>
      <main className="fr-main">
        <div className="fr-host">
          <span className="fr-figure-tile"><FigureStill figure={FIRST_FIGURE} className="fr-figure" alt="" width={136} height={136} decoding="async" /></span>
          <div className="fr-say" aria-live="polite"><b>{say.head}</b><span>{say.sub}</span></div>
        </div>

        <form className="fr-composer" onSubmit={(event) => { event.preventDefault(); send() }}>
          <label htmlFor={inputId} className="visually-hidden">What shall we make?</label>
          <textarea id={inputId} rows={2} value={text} maxLength={8000} placeholder={turns.length ? 'Ask for something else' : 'For example: plan tomorrow’s lesson about animals'}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send() } }} />
          <div className="fr-composer-bar">
            <span className="fr-who"><i style={connected ? { background: AI_COLOR } : undefined} />Your first agent{using ? ` · ${using.chip}` : ''}</span>
            <button type="submit" className="fr-send" aria-label="Send" disabled={!text.trim() || sending || working}><ArrowUp size={18} aria-hidden="true" /></button>
          </div>
        </form>
        {turns.length === 0 && (
          <div className="fr-examples">
            {EXAMPLES.map((example) => <button key={example} type="button" className="fr-example" onClick={() => setText(example)}>{example}</button>)}
          </div>
        )}
        {error && <p role="alert" className="inline-error t-body fr-error">{error}</p>}

        <div className="fr-convo">
          {turns.map((turn) => (
            <div key={turn.runId} className="fr-turn">
              {turn.forYou
                ? <p className="fr-again">Same request, made for you</p>
                : <p className="fr-request">{turn.request}</p>}
              <FirstAnswer turn={turn} about={turn.forYou ? aboutLine(told) : null} name={name}
                onSettled={onSettled} onRetry={() => void start(turn.request, turn.forYou)} />
            </div>
          ))}

          {stage === 'offered' && (
            <div className="fr-offer">
              <FigureStill figure={FIRST_FIGURE} className="fr-offer-figure" headOnly alt="" width={40} height={40} decoding="async" />
              <div>
                <b>That answer was written for anyone.</b>
                <p>Want answers made for you? Tell me a little about yourself. It takes ten seconds.</p>
                <div className="fr-acts">
                  <button type="button" className="btn btn-primary" onClick={() => { setTold((was) => ({ ...was, name: you?.name ?? was.name })); setStage('telling') }}>Tell my agents about me</button>
                  <button type="button" className="link" onClick={() => setStage('finale')}>Not now</button>
                </div>
              </div>
            </div>
          )}

          {stage === 'telling' && <AboutCard told={told} onChange={setTold} onAnswerAgain={() => void answerAgain()} />}

          {stage === 'finale' && (
            <div className="fr-acts fr-finale">
              <button type="button" className="btn btn-primary" disabled={keeping} onClick={() => void keep()}>{keeping ? 'Keeping it…' : 'Keep this agent'}</button>
              <button type="button" className="btn" onClick={home}>Go to Home</button>
            </div>
          )}
        </div>
      </main>
      {connecting && <ConnectSheet options={options} onClose={() => { setConnecting(false); setPending(null) }} />}
    </div>
  )
}

/** One answer from the first agent: a bar that fills while it is written, then the answer. */
function FirstAnswer({ turn, about, name, onSettled, onRetry }: { turn: Turn; about: string | null; name: string; onSettled: (turn: Turn, record: RunRecord) => void; onRetry: () => void }) {
  const session = useRunSession(turn.runId, null)
  const record = session.record
  const done = Boolean(record && isTerminalRun(record.status))
  const responder = session.projection.agents.find((agent) => agent.id === record?.responder)
  const text = done ? record?.reply ?? '' : responder?.reply ?? ''
  const status = record?.status
  // Said once the run ends; saying it again is harmless, as the same status changes nothing.
  useEffect(() => {
    if (record && status && isTerminalRun(status)) onSettled(turn, record)
  }, [record, status, turn, onSettled])

  if (record && done && status !== 'succeeded') {
    const why = record.error?.split('\n')[0]?.trim()
    return (
      <div className="fr-answer stopped" role="alert">
        <p>{why ? plainRunError(why) : 'Your agent stopped before it had an answer.'}</p>
        <button type="button" className="btn" onClick={onRetry}>Try again</button>
      </div>
    )
  }
  return (
    <article className="fr-answer" aria-busy={!done}>
      <div className={`fr-bar${done ? ' done' : ''}`} aria-hidden="true">{Array.from({ length: 9 }, (_, index) => <i key={index} style={{ animationDelay: `${index * 60}ms` }} />)}</div>
      <p className="fr-answer-meta">{turn.forYou
        ? <>Your first agent <span className="fr-for">made for {name || 'you'}</span>{about ? ` ${about}` : ''}</>
        : 'Your first agent'}</p>
      {text ? <div className="fr-answer-text"><Markdown>{text}</Markdown></div> : <p className="fr-writing"><span aria-hidden="true" />Writing your answer…</p>}
    </article>
  )
}

/** "Tell my agents about me": a name and a few taps, written into About you. */
function AboutCard({ told, onChange, onAnswerAgain }: { told: QuickAbout; onChange: (next: QuickAbout) => void; onAnswerAgain: () => void }) {
  const nameId = useId()
  const otherId = useId()
  const empty = !told.name.trim() && !aboutFrom(told)
  return (
    <section className="fr-about" aria-labelledby={`${nameId}-title`}>
      <h3 id={`${nameId}-title`} className="fr-about-head">About you</h3>
      <div className="fr-about-body">
        <div className="fr-about-field">
          <label className="t-meta" htmlFor={nameId}>What should I call you?</label>
          <input id={nameId} className="input" autoComplete="given-name" maxLength={60} placeholder="Your name" value={told.name} onChange={(event) => onChange({ ...told, name: event.target.value })} />
        </div>
        {QUESTIONS.map(({ field, label }) => (
          <Fragment key={field}>
            <QuickChoices field={field} label={label} picked={told[field]} onPick={(choice) => onChange({ ...told, [field]: choice })} />
            {field === 'work' && told.work === 'Something else' && (
              <div className="fr-about-field">
                <label className="t-meta" htmlFor={otherId}>In a few words</label>
                <input id={otherId} className="input" maxLength={120} placeholder="For example: coffee farming" value={told.otherWork} onChange={(event) => onChange({ ...told, otherWork: event.target.value })} />
              </div>
            )}
          </Fragment>
        ))}
        <div className="fr-about-foot">
          <small className="t-meta">Every agent you make reads this. Kept on this computer, and sent to your AI with each task.</small>
          <button type="button" className="btn btn-primary" disabled={empty} onClick={onAnswerAgain}>Answer that again</button>
        </div>
      </div>
    </section>
  )
}
