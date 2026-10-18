import { Check, ExternalLink, KeyRound, LogIn, Plug } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'

import {
  CATALOG_GROUPS, connectTool, fetchTools, keptInWords, onToolsMessage, sendToolToken, signInToToolAgain,
  type CatalogEntry, type ConnectedTool, type KeptIn, type SignInOutcome,
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
}

/**
 * Connecting a tool (ADR 0069): one from the short list, or any by its address. A tool that
 * wants a sign-in sends you to its own site in a new tab, so nothing you were writing here is lost,
 * and this panel carries on when the site sends you back. One that wants a token takes the one you
 * paste. Either way the secret goes to the daemon, which keeps it out of your team files.
 */
export function ConnectTool({ catalog, connected, keptIn, onConnected, onClose, resume }: ConnectToolProps) {
  const ids = useId()
  const [step, setStep] = useState<Step>({ kind: 'pick' })
  const [address, setAddress] = useState('')
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

  const isConnected = (entry: CatalogEntry) => connected.some((tool) => !tool.pending && (tool.url.replace(/\/$/, '') === entry.url.replace(/\/$/, '') || tool.name.toLowerCase() === entry.name.toLowerCase()))

  return (
    <div className="connect-tool" role="group" aria-labelledby={`${ids}-title`}>
      <div className="connect-tool-head">
        <h4 id={`${ids}-title`}>{step.kind === 'pick' ? 'Connect a tool' : step.kind === 'token' ? `${step.tool.name} needs a token` : `Sign in to ${step.tool.name}`}</h4>
        {onClose && <button type="button" className="link" onClick={onClose}>{step.kind === 'pick' ? 'Close' : 'Cancel'}</button>}
      </div>
      {error && <p role="alert" className="inline-error t-meta"><span className="detail">{error}</span></p>}

      {step.kind === 'pick' && <>
        {sections(catalog).map(({ title, entries }) => (
          <div key={title ?? 'all'} className="connect-tool-group">
            {title && <h5>{title}</h5>}
            <ul className="connect-tool-list" aria-label={title ? `${title} tools to connect` : 'Tools to connect'}>
              {entries.map((entry) => {
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
              })}
            </ul>
          </div>
        ))}
        <form className="connect-tool-address" onSubmit={(event) => { event.preventDefault(); const url = address; void act('address', async () => { await begin(url); setAddress('') }) }}>
          <label className="field">
            <span className="t-meta">Or paste a tool’s address</span>
            <input className="input mono" value={address} maxLength={2048} spellCheck={false} autoComplete="off" inputMode="url" placeholder="https://mcp.example.com/mcp" onChange={(event) => setAddress(event.target.value)} />
          </label>
          <button className="btn" disabled={Boolean(busy) || !address.trim()}><Plug size={14} aria-hidden="true" />{busy === 'address' ? 'Connecting…' : 'Connect'}</button>
        </form>
        <p className="t-meta connect-tool-quiet">Services list it as their “MCP server” address; it often ends in /mcp. LoomWatch connects over https only, and nothing is installed on this computer.</p>
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

/** The starter list under its headings, in their order; entries with no group last, under none. */
function sections(catalog: readonly CatalogEntry[]): { title: string | null; entries: CatalogEntry[] }[] {
  const grouped = CATALOG_GROUPS.map(({ group, title }) => ({ title, entries: catalog.filter((entry) => entry.group === group) }))
  const loose = catalog.filter((entry) => !CATALOG_GROUPS.some(({ group }) => group === entry.group))
  return [...grouped, { title: null, entries: loose }].filter((section) => section.entries.length > 0)
}
