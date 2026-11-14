import { useEffect, useRef, useState } from 'react'

import { CircleCheck } from '../../ui/icon'
import { connectTool, signInToToolAgain, toolNamed, useConnectedTools, type ConnectAnswer, type ConnectedTool } from '../../../lib/tools/client'
import type { KeptWidget, WidgetState } from '../../../lib/widgets/types'
import { useHeldState } from '../../../lib/widgets/useHeldState'
import { ConnectTool } from '../../tools/ConnectTool'
import { ToolIcon } from '../../tools/ToolIcon'
import { LIVE } from './WidgetChoices'

const sameAddress = (one: string, other: string) => one.replace(/\/$/, '').toLowerCase() === other.replace(/\/$/, '').toLowerCase()
const sameName = (one: string, other: string) => one.trim().toLowerCase() === other.trim().toLowerCase()

/** The step a tool still waiting for its sign-in or token is at, so the card opens on it. */
async function stepOf(tool: ConnectedTool): Promise<ConnectAnswer> {
  if (tool.auth === 'signIn') return { tool, needs: 'signIn', url: await signInToToolAgain(tool.id) }
  if (tool.auth === 'token') return { tool, needs: 'token' }
  if (tool.auth === 'onThisMac') return { tool, needs: 'macPermission' }
  if (tool.auth === 'fromPhone') return { tool, needs: 'phoneHealth' }
  return connectTool(tool.url, tool.name)
}

/**
 * A tool the agent suggests connecting (ADR 0126): the tool's own mark and name, what it lets the
 * agent do, and one Connect button. Connect does what Connections does for it (your Mac asks you,
 * its site asks you to sign in, or it takes a token), gives it to the agent that suggested it, and
 * sends “I connected …” to that agent as your reply, so it carries on with it. A step on the way
 * opens under the card, in Connections' own words. Once connected, the card says so, and the
 * agent's next work is told.
 */
export function WidgetConnect({ kept, onChange, onGive, onCarryOn, live, by }: {
  kept: KeptWidget
  onChange: (n: number, state: WidgetState) => Promise<KeptWidget>
  /** Give the tool to the agent that suggested it. Resolves with a few words to add once it is
      connected, such as that Save keeps it. Absent where the chat can't change the agent. */
  onGive?: (tool: string) => Promise<string | void>
  /** Send your reply to the agent that suggested it, starting its work. Absent when it isn't the
      newest answer or something is at work: the agent then has the tool from your next message. */
  onCarryOn?: (label: string) => Promise<boolean> | void
  live: boolean
  /** The agent that suggested it, as the chat names them. */
  by?: string
}) {
  const held = useHeldState(kept, onChange)
  const tools = useConnectedTools()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [steps, setSteps] = useState<ConnectAnswer | null>(null)
  // What connecting it here came to; a card connected before just says it is.
  const [said, setSaid] = useState<string | null>(null)
  // Your reply, sent once the chat has drawn again with the tool given (the draw that shows what
  // was said), so the work it starts is set up with the tool.
  const reply = useRef<{ label: string; failed: string } | null>(null)
  useEffect(() => {
    const sending = reply.current
    if (sending === null || !onCarryOn) return
    reply.current = null
    void Promise.resolve(onCarryOn(sending.label)).then((sent) => { if (sent === false) setSaid(sending.failed) })
  }, [said, onCarryOn])
  if (kept.spec.kind !== 'connect') return null
  const name = kept.spec.title
  const ready = tools.state === 'ready' ? tools : null
  const entry = ready?.catalog.find((item) => sameName(item.name, name))
  const known = ready?.tools.find((tool) => sameName(tool.name, name))
  const connected = held.state !== undefined && 'connected' in held.state
  const agent = by ?? 'The agent'
  // A tool it was given that LoomWatch can't connect by its name: Connections is the way, so the
  // card says so instead of offering a button that can't work.
  const elsewhere = ready !== null && !entry && !known

  async function act(work: () => Promise<void>) {
    setBusy(true); setError('')
    try { await work() } catch (caught) { setError(caught instanceof Error ? caught.message : 'That didn’t work. Try again.') }
    finally { setBusy(false) }
  }

  async function finish(tool: ConnectedTool) {
    setSteps(null)
    if (!onGive) {
      // Connected, but this chat can't give it: nothing to carry on with yet.
      held.keep({ connected: true })
      setSaid(`Connected. This team can’t be changed here, so ${agent} doesn’t have it yet.`)
      tools.refresh()
      return
    }
    const more = await onGive(tool.name)
    held.keep({ connected: true })
    const after = more ? ` ${more}` : ''
    if (onCarryOn) {
      reply.current = { label: `I connected ${tool.name}.`, failed: `Connected. ${agent} has it from your next message.${after}` }
      setSaid(`Connected. ${agent} is carrying on.${after}`)
    } else {
      setSaid(`Connected. ${agent} has it from your next message.${after}`)
    }
    tools.refresh()
  }

  const connect = () => act(async () => {
    if (!ready) throw new Error(tools.state === 'unavailable' ? tools.message : 'LoomWatch is still reading your tools. Try again in a moment.')
    const there = toolNamed(ready.tools, name) ?? (entry ? ready.tools.find((tool) => !tool.pending && sameAddress(tool.url, entry.url)) : undefined)
    if (there) return finish(there)
    const answer = entry ? await connectTool(entry.url, entry.name) : known ? await stepOf(known) : null
    if (!answer) return
    if (answer.needs) setSteps(answer)
    else await finish(answer.tool)
  })

  const onMac = entry?.auth === 'onThisMac' || known?.auth === 'onThisMac'
  return (
    <section className="wg wg-connect" aria-label={`Connect ${name}`}>
      <div className="wg-connect-head">
        <ToolIcon name={name} icon={entry?.icon ?? known?.icon} size={40} />
        <div className="wg-connect-name">
          <p className="wg-title">{name}</p>
          {entry?.does && <p className="wg-connect-does">{entry.does}</p>}
        </div>
      </div>
      {connected
        ? <p className="wg-connect-done" role="status"><CircleCheck size={16} aria-hidden="true" />{said ?? 'Connected.'}</p>
        : elsewhere
          ? <p className="wg-connect-elsewhere">{name} isn’t connected yet. Connect it under Tools in <a className="link" href="/connections">Connections</a>.</p>
          : !steps && <button
              type="button"
              className="btn btn-ring wg-connect-go"
              disabled={busy || live || tools.state === 'loading'}
              title={live ? LIVE : onGive ? `Connects ${name} and gives it to ${agent}. ${agent} asks you before each action.` : undefined}
              onClick={() => void connect()}
            >{busy ? (onMac ? 'Your Mac is asking you…' : 'Connecting…') : 'Connect'}</button>}
      {steps && ready && (
        <ConnectTool
          catalog={ready.catalog}
          connected={ready.tools}
          keptIn={ready.keptIn}
          begun={steps}
          onConnected={(tool) => void act(() => finish(tool))}
          onClose={() => setSteps(null)}
        />
      )}
      {(error || held.error) && <p role="alert" className="wg-connect-error">{error || held.error}</p>}
    </section>
  )
}
