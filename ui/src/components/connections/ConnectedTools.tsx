import { useEffect, useRef, useState } from 'react'

import { NOTION_TOOL_URL, actionCount, checkTool, keptInWords, removeTool, useConnectedTools, type ConnectedTool } from '../../lib/tools/client'
import { ConnectTool } from '../tools/ConnectTool'
import { ToolIcon } from '../tools/ToolIcon'
import { InlineMarkdown } from '../ui/Markdown'
import { NotionAnswers } from './NotionAnswers'

/**
 * `?tool=notion`: where the canvas sends you to connect Notion or choose the page answers go
 * under. Read once; a reload or a bookmark of the address doesn't ask again.
 */
const readAskedTool = () => new URLSearchParams(window.location.search).get('tool')

/**
 * Connections' Tools section (ADR 0069): every tool connected in LoomWatch, what each offers, and
 * connecting, checking, signing in again or removing one. Which agent may use which tool is the
 * agent's own Tools it can use row. Notion's card also says where teams' answers go, since its sign-in
 * sends them and reads the pages agents are given (ADR 0070).
 */
export function ConnectedTools() {
  const tools = useConnectedTools()
  const [connecting, setConnecting] = useState<ConnectedTool | 'new' | null>(null)
  const [start, setStart] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  /** The tool whose Notion page list opens at once: just connected, or asked for by address. */
  const [choosingFor, setChoosingFor] = useState<string | null>(null)
  const [askedAtStart] = useState(readAskedTool)
  const [asked, setAsked] = useState(askedAtStart)
  const notionCard = useRef<HTMLLIElement>(null)

  useEffect(() => {
    if (askedAtStart === null) return
    const url = new URL(window.location.href)
    url.searchParams.delete('tool')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }, [askedAtStart])

  // Sent here for Notion, once the tools are known: its card with the page list open, or
  // connecting it when it isn't yet.
  if (asked === 'notion' && tools.state === 'ready') {
    setAsked(null)
    const notion = tools.tools.find((tool) => tool.notion && !tool.pending)
    if (notion) {
      setChoosingFor(notion.id)
    } else {
      setStart(NOTION_TOOL_URL)
      setConnecting('new')
    }
  }
  useEffect(() => {
    if (choosingFor) notionCard.current?.scrollIntoView?.({ block: 'center' })
  }, [choosingFor])

  async function act(work: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await work() } catch (caught) { setError(caught instanceof Error ? caught.message : 'That didn’t work. Try again.') }
    finally { setBusy(false); tools.refresh() }
  }

  const listed = tools.state === 'ready' ? tools.tools : []
  return (
    <section className="e1 lw-settings-section" aria-labelledby="tools-heading" aria-busy={busy}>
      <h2 id="tools-heading" className="t-title">Tools</h2>
      <p className="t-body lw-settings-quiet">A tool lets your agents use a service, such as Notion or Todoist. Connect it here, then give it to an agent under Tools it can use. The agent asks you before each action it takes there, unless you always allow that action. Notion also lets LoomWatch send your teams’ answers to a page.</p>
      {error && <p role="alert" className="inline-error t-body"><span className="detail">{error}</span></p>}
      {notice && <p role="status" className="lw-notice t-meta">{notice}</p>}
      {tools.state === 'loading' && <p role="status" className="t-meta lw-settings-quiet">Loading tools…</p>}
      {tools.state === 'unavailable' && <p className="t-meta lw-settings-quiet">{tools.message}</p>}
      {listed.length > 0 && <ul className="tools-connected" aria-label="Connected tools">
        {listed.map((tool) => (
          <li key={tool.id} ref={tool.notion ? notionCard : undefined}>
            <div className="tools-connected-head">
              <span className="tools-connected-name"><ToolIcon name={tool.name} icon={tool.icon} size={28} /><b>{tool.name}</b></span>
              <span className="t-meta">{tool.pending ? 'Not finished connecting' : `${actionCount(tool.calls.length)} · ${tool.auth === 'signIn' ? 'signed in' : tool.auth === 'token' ? 'with a token' : 'no sign-in'}`}</span>
            </div>
            <p className="t-meta">{tool.url}</p>
            {tool.problem && <p className="t-meta problem">{tool.problem}</p>}
            {tool.example && !tool.pending && <p className="t-meta">Try asking an agent: “{tool.example}”</p>}
            {tool.calls.length > 0 && <details>
              <summary>What it can do</summary>
              <ul>{tool.calls.map((call) => <li key={call.name}><strong>{call.label}</strong>{call.readOnly ? ' · only reads' : ''}{call.description ? <span className="lw-call-desc"><InlineMarkdown>{call.description}</InlineMarkdown></span> : null}</li>)}</ul>
            </details>}
            {tool.notion && !tool.pending && <NotionAnswers choosing={choosingFor === tool.id} />}
            <div className="lw-settings-actions">
              {tool.pending
                ? <button type="button" className="link" disabled={busy} onClick={() => setConnecting(tool)}>Finish connecting</button>
                : <button type="button" className="link" disabled={busy} onClick={() => void act(async () => { const checked = await checkTool(tool.id); setNotice(`${checked.name} can do ${actionCount(checked.calls.length)}.`) })}>Check again</button>}
              {!tool.pending && tool.auth === 'signIn' && <button type="button" className="link" disabled={busy} onClick={() => setConnecting(tool)}>Sign in again</button>}
              {!tool.pending && tool.auth === 'token' && <button type="button" className="link" disabled={busy} onClick={() => setConnecting(tool)}>Replace its token</button>}
              <button type="button" className="link alert" disabled={busy} onClick={() => void act(async () => {
                await removeTool(tool.id)
                setNotice(tool.notion
                  ? `${tool.name} is removed. Agents given it can’t use it, and LoomWatch can’t send answers to Notion or read pages for agents, until you connect it again.`
                  : `${tool.name} is removed. Agents given it can’t use it until you connect it again.`)
              })}>Remove {tool.name}</button>
            </div>
          </li>
        ))}
      </ul>}
      {tools.state === 'ready' && (connecting
        ? <ConnectTool
            catalog={tools.catalog}
            connected={tools.tools}
            keptIn={tools.keptIn}
            resume={connecting === 'new' ? null : connecting}
            start={connecting === 'new' ? start : null}
            onClose={() => { setConnecting(null); setStart(null) }}
            onConnected={(tool) => {
              setConnecting(null); setStart(null); tools.refresh(); setError('')
              if (tool.notion) {
                setChoosingFor(tool.id)
                setNotice(`${tool.name} is connected. Choose the page your teams’ answers go under, and give it to agents under Tools it can use.`)
              } else {
                setNotice(`${tool.name} is connected. Give it to an agent under Tools it can use.`)
              }
            }}
          />
        : <button type="button" className="btn btn-primary lw-settings-start" onClick={() => setConnecting('new')}>Connect a tool</button>)}
      {tools.state === 'ready' && <p className="t-meta lw-settings-quiet">Sign-ins and tokens are kept in {keptInWords(tools.keptIn)}, outside your team files. Agents never get them: LoomWatch takes each action for them.</p>}
    </section>
  )
}
