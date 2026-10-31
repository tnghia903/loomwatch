import { Check, ExternalLink, KeyRound, Link2, LogIn, Plug, Search } from '../ui/icon'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

import {
  CATALOG_TOPICS, cantConnectYet, connectTool, fetchTools, findTools, isToolAddress, keptInWords, onToolsMessage, sendToolToken, signInToToolAgain,
  type CatalogEntry, type CatalogTopic, type ConnectedTool, type KeptIn, type SignInOutcome,
} from '../../lib/tools/client'
import { ToolIcon } from './ToolIcon'

const OUTCOME_SAID: Record<Exclude<SignInOutcome, 'connected'>, string> = {
  denied: 'You didn’t allow LoomWatch, so nothing was connected.',
  expired: 'That sign-in ended before it finished. Try again.',
  failed: 'The sign-in didn’t finish. Try again.',
}

type Step =
  | { kind: 'pick' }
  | { kind: 'token'; tool: ConnectedTool; help: string | null }
  | { kind: 'signIn'; tool: ConnectedTool; url: string; opened: boolean }

interface ConnectToolProps {
  catalog: readonly CatalogEntry[]
  connected: readonly ConnectedTool[]
  keptIn: KeptIn
  /** It is connected and offers its calls. */
  onConnected: (tool: ConnectedTool) => void
  onClose?: () => void
  /** Pick up a tool already started: one waiting for its sign-in or token, or one to sign in again. */
  resume?: ConnectedTool | null
  /** Start connecting the starter tool at this address straight away, as if it were picked. */
  start?: string | null
}

/**
 * Connecting a tool (ADR 0069): one from the list, or any by its address. The list starts from
 * topics, as the Skills page does, and one box both finds a tool by its words and takes a pasted
 * address, so nobody has to know which they need first. A tool that
 * wants a sign-in sends you to its own site in a new tab, so nothing you were writing here is lost,
 * and this panel carries on when the site sends you back. One that wants a token takes the one you
 * paste. Either way the secret goes to the daemon, which keeps it out of your team files.
 */
export function ConnectTool({ catalog, connected, keptIn, onConnected, onClose, resume, start }: ConnectToolProps) {
  const ids = useId()
  const [step, setStep] = useState<Step>({ kind: 'pick' })
  const [text, setText] = useState('')
  const [topic, setTopic] = useState<CatalogTopic | null>(null)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const waiting = step.kind === 'signIn' ? step.tool.id : null
  const done = useRef(onConnected)
  done.current = onConnected

  async function act(label: string, work: () => Promise<void>) {
    if (busy) return
    setBusy(label); setError('')
    try { await work() } catch (caught) { setError(caught instanceof Error ? caught.message : 'That didn’t work. Try again.') }
    finally { setBusy(null) }
  }

  async function begin(url: string, name?: string) {
    const answer = await connectTool(url, name)
    if (answer.needs === 'signIn' && answer.url) setStep({ kind: 'signIn', tool: answer.tool, url: answer.url, opened: false })
    else if (answer.needs === 'token') setStep({ kind: 'token', tool: answer.tool, help: answer.tool.tokenHelp ?? catalog.find((entry) => entry.url === url)?.tokenHelp ?? null })
    else onConnected(answer.tool)
  }

  // A tool started before: carry on where it was.
  const resumed = useRef<string | null>(null)
  useEffect(() => {
    if (!resume || resumed.current === resume.id) return
    resumed.current = resume.id
    if (resume.auth === 'token') {
      setStep({ kind: 'token', tool: resume, help: resume.tokenHelp })
    } else if (resume.auth === 'signIn') {
      void act('sign-in', async () => setStep({ kind: 'signIn', tool: resume, url: await signInToToolAgain(resume.id), opened: false }))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- once per tool picked up
  }, [resume])

  // A starter tool asked for by name elsewhere (Connections' `?tool=notion`): as if it were picked.
  const started = useRef<string | null>(null)
  useEffect(() => {
    if (!start || started.current === start) return
    started.current = start
    const entry = catalog.find((item) => item.url === start)
    if (entry && !isConnected(entry)) void act(entry.name, () => begin(entry.url, entry.name))
  // eslint-disable-next-line react-hooks/exhaustive-deps -- once per address asked for
  }, [start])

  // Waiting on a sign-in in another tab: its landing page says how it went, and a look now and
  // then catches one finished where that message can't reach (another browser window).
  useEffect(() => {
    if (!waiting) return
    let current = true
    const settle = async () => {
      const { tools } = await fetchTools()
      const tool = tools.find((item) => item.id === waiting)
      if (current && tool && !tool.pending && !tool.problem) { current = false; done.current(tool) }
    }
    const stop = onToolsMessage((message) => {
      if (message.tool !== waiting || !message.outcome) return
      if (message.outcome === 'connected') void settle().catch(() => {})
      else setError(OUTCOME_SAID[message.outcome])
    })
    const timer = window.setInterval(() => { void settle().catch(() => {}) }, 3000)
    return () => { current = false; stop(); window.clearInterval(timer) }
  }, [waiting])

  const address = isToolAddress(text)
  const words = address ? '' : text.trim()
  const topics = CATALOG_TOPICS.filter((item) => catalog.some((entry) => entry.topic === item.topic))
  const card = (entry: CatalogEntry) => {
    const already = isConnected(entry)
    return (
      <li key={entry.url}>
        <button type="button" disabled={Boolean(busy) || already} title={entry.example ? `Try asking: ${entry.example}` : undefined} onClick={() => void act(entry.name, () => begin(entry.url, entry.name))}>
          <span className="connect-tool-name"><ToolIcon name={entry.name} icon={entry.icon} size={24} /><b>{entry.name}</b></span>
          <span>{entry.does}</span>
          <em>{already ? <><Check size={12} aria-hidden="true" /> Connected</> : busy === entry.name ? 'Connecting…' : entry.auth === 'signIn' ? 'Sign in' : entry.auth === 'token' ? 'Paste a token' : 'No sign-in needed'}</em>
        </button>
      </li>
    )
  }

  const isConnected = (entry: CatalogEntry) => connected.some((tool) => !tool.pending && (tool.url.replace(/\/$/, '') === entry.url.replace(/\/$/, '') || tool.name.toLowerCase() === entry.name.toLowerCase()))

  return (
    <div className="connect-tool" role="group" aria-labelledby={`${ids}-title`}>
      <div className="connect-tool-head">
        <h4 id={`${ids}-title`}>{step.kind === 'pick' ? 'Connect a tool' : step.kind === 'token' ? `${step.tool.name} needs a token` : `Sign in to ${step.tool.name}`}</h4>
        {onClose && <button type="button" className="link" onClick={onClose}>{step.kind === 'pick' ? 'Close' : 'Cancel'}</button>}
      </div>
      {error && <p role="alert" className="inline-error t-meta"><span className="detail">{error}</span></p>}

      {step.kind === 'pick' && <>
        <form role="search" className="connect-tool-find" onSubmit={(event) => {
          event.preventDefault()
          if (!address) return
          const url = text.trim()
          void act('address', async () => { await begin(url); setText('') })
        }}>
          <label className="connect-tool-find-box">
            {address ? <Link2 size={16} aria-hidden="true" /> : <Search size={16} aria-hidden="true" />}
            <input
              className="input"
              type="search"
              aria-label="Find a tool or paste its address"
              placeholder="Find a tool, or paste its address"
              value={text}
              maxLength={2048}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => { setText(event.target.value); if (event.target.value.trim()) setTopic(null) }}
            />
          </label>
          {address && <button className="btn btn-ring" disabled={Boolean(busy)}><Plug size={14} aria-hidden="true" />{busy === 'address' ? 'Connecting…' : 'Connect'}</button>}
        </form>
        {address
          ? <p className="t-meta connect-tool-quiet">Nothing is installed on this computer.</p>
          : <>
            {topics.length > 0 && <div className="connect-tool-topics" role="group" aria-label="Topics">
              <button type="button" aria-pressed={!topic && !words} onClick={() => { setTopic(null); setText('') }}>All</button>
              {topics.map((item) => (
                <button key={item.topic} type="button" aria-pressed={topic === item.topic} onClick={() => { setTopic(topic === item.topic ? null : item.topic); setText('') }}>{item.label}</button>
              ))}
            </div>}
            {words
              ? <Found catalog={catalog} words={words} card={card} />
              : sections(catalog, topic).map(({ title, entries }) => (
                <div key={title ?? 'all'} className="connect-tool-group">
                  {title && !topic && <h5>{title}</h5>}
                  <ul className="connect-tool-list" aria-label={title ? `${title} tools to connect` : 'Tools to connect'}>{entries.map(card)}</ul>
                </div>
              ))}
            {!(words && cantConnectYet(words)) && <p className="t-meta connect-tool-quiet">Not here? Find its “MCP server” address on the service’s own site, often ending in /mcp, and paste it above.</p>}
          </>}
      </>}

      {step.kind === 'signIn' && <>
        <p className="t-body">{step.opened
          ? <>Finish signing in on {step.tool.name}’s site, in the tab that opened. This panel carries on by itself when you’re done.</>
          : <>{step.tool.name} asks you to sign in and allow LoomWatch. It opens in a new tab, so nothing here is lost.</>}</p>
        <a className={`btn${step.opened ? '' : ' btn-primary'} connect-tool-start`} href={step.url} target="_blank" rel="noopener noreferrer" onClick={() => { setError(''); setStep({ ...step, opened: true }) }}>
          {step.opened ? <><ExternalLink size={14} aria-hidden="true" />Open the sign-in again</> : <><LogIn size={14} aria-hidden="true" />Sign in to {step.tool.name}</>}
        </a>
        <p className="t-meta connect-tool-quiet">Because it sends you back to this computer, a site may ask you to confirm you trust the address first. LoomWatch keeps the sign-in in {keptInWords(keptIn)}, outside your team files.</p>
      </>}

      {step.kind === 'token' && <form className="field" onSubmit={(event) => {
        event.preventDefault()
        const submitted = token
        const tool = step.tool
        setToken('')
        void act('token', async () => onConnected(await sendToolToken(tool.id, submitted)))
      }}>
        <p className="t-body">{step.tool.name} doesn’t offer a sign-in LoomWatch can use, so it takes a token you make on its site.{step.help && <> <a className="link" href={step.help} target="_blank" rel="noopener noreferrer">Make a token on {step.tool.name} <ExternalLink size={12} aria-hidden="true" /></a></>}</p>
        <label className="t-meta" htmlFor={`${ids}-token`}>{step.tool.name} token</label>
        <input id={`${ids}-token`} type="password" autoComplete="off" spellCheck={false} value={token} maxLength={8192} onChange={(event) => setToken(event.target.value)} className="input mono" />
        <span className="hint t-meta">Kept in {keptInWords(keptIn)}, outside your team files. LoomWatch never shows it again.</span>
        <button disabled={Boolean(busy) || !token.trim()} className="btn btn-primary connect-tool-start"><KeyRound size={14} aria-hidden="true" />{busy === 'token' ? 'Checking…' : 'Connect'}</button>
      </form>}
    </div>
  )
}

/**
 * What the words typed find, in one list. A popular service that can't be connected yet says so
 * and why, so nobody goes looking for an address that doesn't exist.
 */
function Found({ catalog, words, card }: { catalog: readonly CatalogEntry[]; words: string; card: (entry: CatalogEntry) => ReactNode }) {
  const found = findTools(catalog, words)
  const notYet = cantConnectYet(words)
  return <>
    {notYet && <p role="status" className="t-body connect-tool-none">{notYet.name} can’t be connected yet: {notYet.why}</p>}
    {!notYet && found.length === 0 && <p role="status" className="t-body connect-tool-none">No tool here matches “{words}”. Try other words, or pick a topic.</p>}
    {found.length > 0 && <ul className="connect-tool-list" aria-label={`Tools that match ${words}`}>{found.map(card)}</ul>}
  </>
}

/**
 * The list under its topics, in their order, or one topic's alone; entries with no topic last,
 * under none.
 */
function sections(catalog: readonly CatalogEntry[], only: CatalogTopic | null): { title: string | null; entries: CatalogEntry[] }[] {
  const topics = CATALOG_TOPICS.filter(({ topic }) => !only || topic === only)
  const sorted = topics.map(({ topic, label }) => ({ title: label, entries: catalog.filter((entry) => entry.topic === topic) }))
  const loose = only ? [] : catalog.filter((entry) => !CATALOG_TOPICS.some(({ topic }) => topic === entry.topic))
  return [...sorted, { title: null, entries: loose }].filter((section) => section.entries.length > 0)
}
