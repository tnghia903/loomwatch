import { useEffect, useRef, useState, type ReactNode } from 'react'

import {
  connectTo, fetchDevices, makeCode, ownLoomWatchAnswers, readShownFrom, reloadWhen, removeDevice, shareOnTailscale, useDevices, switchToThisComputer,
  type CodeMade, type Device, type DeviceKind, type Reach, type ShownFrom,
} from '../../lib/devices/client'
import { SectionHead } from '../ui/SectionHead'

const KIND_WORD: Record<DeviceKind, string> = { phone: 'iPhone', computer: 'Computer' }
const KINDS: readonly DeviceKind[] = ['phone', 'computer']
const OTHER_DEVICE: Record<DeviceKind, string> = { phone: 'your iPhone', computer: 'your other computer' }

/** What the daemon's own-screen check answers with, said as what to do. */
const OWN_SCREEN = 'Open LoomWatch on this computer to connect a device.'

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const clock = (at: string) => new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

const day = (at: string) => new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/**
 * Connections' Your devices section (ADR 0102): the iPhones and computers connected to LoomWatch
 * on this computer, Remove, and connecting one more with a code that works once. Devices reach
 * this computer through the person's own Tailscale, so connecting says what stands in the way,
 * with the one thing to do about it. A computer can also connect here to LoomWatch on another
 * one, and while it does, the section says which and offers the way back.
 */
export function Devices() {
  const devices = useDevices()
  const [connecting, setConnecting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [connected, setConnected] = useState('')
  const [shownFrom, setShownFrom] = useState<ShownFrom | null>(null)

  useEffect(() => {
    let current = true
    void readShownFrom().then((from) => { if (current) setShownFrom(from) })
    return () => { current = false }
  }, [])

  const remove = async (device: Device) => {
    setBusy(true)
    setError('')
    try {
      await removeDevice(device.id)
      devices.refresh()
    } catch (caught) {
      setError(message(caught))
    } finally {
      setBusy(false)
    }
  }

  const unavailable = devices.state === 'unavailable' && /local origin/i.test(devices.message) ? OWN_SCREEN : devices.state === 'unavailable' ? devices.message : ''

  return (
    <section className="e1 lw-settings-section lw-devices" aria-label="Your devices" aria-busy={busy}>
      <SectionHead
        as="h2"
        className="t-title"
        title="Your devices"
        explain="Use LoomWatch on this computer from your iPhone or another computer, through Tailscale, an app you install on both. Everything stays on this computer, which must be on, with LoomWatch open. Remove disconnects a device at once."
      />
      {shownFrom && <ShownFromLine from={shownFrom} />}
      {error && <p role="alert" className="inline-error t-body"><span className="detail">{error}</span></p>}
      {connected && <p role="status" className="lw-notice t-meta">{connected} is connected.</p>}
      {devices.state === 'loading' && <p role="status" className="t-meta lw-settings-quiet">Loading devices…</p>}
      {unavailable && <p className="t-meta lw-settings-quiet">{unavailable}</p>}
      {devices.state === 'ready' && (devices.devices.length > 0
        ? (
          <ul className="lw-devices-list" aria-label="Connected devices">
            {devices.devices.map((device) => (
              <li key={device.id}>
                <span className="lw-devices-name"><b>{device.name}</b>
                  <span className="t-meta">{[device.name === KIND_WORD[device.kind] ? '' : KIND_WORD[device.kind], device.lastSeen ? `last used ${day(device.lastSeen)}` : ''].filter(Boolean).join(' · ')}</span>
                </span>
                <button type="button" className="link alert" disabled={busy} aria-label={`Remove ${device.name}`} onClick={() => void remove(device)}>Remove</button>
              </li>
            ))}
          </ul>
        )
        : <p className="t-meta lw-settings-quiet">No devices connected.</p>)}
      {devices.state === 'ready' && !devices.doorOpen && (
        <p className="t-meta lw-settings-quiet">
          {devices.doorOff ? 'Connecting other devices is turned off on this computer.' : 'Other devices can’t connect right now. Quit LoomWatch and open it again.'}
        </p>
      )}
      {devices.state === 'ready' && devices.doorOpen && (connecting
        ? (
          <ConnectDevice
            known={devices.devices.map((device) => device.id)}
            onConnected={(name) => { setConnecting(false); setConnected(name); devices.refresh() }}
            onDone={() => { setConnecting(false); devices.refresh() }}
          />
        )
        : <button type="button" className="btn btn-ring lw-settings-start" onClick={() => { setConnected(''); setConnecting(true) }}>Connect a device</button>)}
      {devices.state === 'ready' && !shownFrom && <ConnectToAnother />}
    </section>
  )
}

/** This computer shows LoomWatch on another one: which, and the way back to its own. */
function ShownFromLine({ from }: { from: ShownFrom }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const back = async () => {
    setBusy(true)
    setError('')
    try {
      await switchToThisComputer()
      await reloadWhen(ownLoomWatchAnswers)
    } catch (caught) {
      setError(message(caught))
      setBusy(false)
    }
  }
  return (
    <div className="lw-devices-step">
      <p className="t-body">This computer shows LoomWatch on {from.hostName}.</p>
      {error && <p role="alert" className="inline-error t-body"><span className="detail">{error}</span></p>}
      <button type="button" className="link" disabled={busy} onClick={() => void back()}>
        {busy ? 'Switching to this computer…' : 'Use LoomWatch on this computer instead'}
      </button>
    </div>
  )
}

/** Connecting this computer to LoomWatch on another one, with the link made there. */
function ConnectToAnother() {
  const [open, setOpen] = useState(false)
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [going, setGoing] = useState('')

  const connect = async () => {
    setBusy(true)
    setError('')
    try {
      const to = await connectTo(link)
      setGoing(to.hostName)
      await reloadWhen(async () => (await readShownFrom()) !== null)
    } catch (caught) {
      setError(message(caught))
      setBusy(false)
    }
  }

  if (!open) {
    return <button type="button" className="link lw-devices-other" onClick={() => setOpen(true)}>Connect to another computer</button>
  }
  return (
    <div className="lw-devices-connect">
      <p className="t-body">Paste the link from Your devices on the computer that runs LoomWatch. This computer then shows that one, and runs no agents of its own.</p>
      {error && <p role="alert" className="inline-error t-body"><span className="detail">{error}</span></p>}
      {going
        ? <p role="status" className="t-body">Connecting to {going}…</p>
        : (
          <div className="lw-devices-link-row">
            <input className="input" value={link} placeholder="loomwatch://pair?…" aria-label="Link from the other computer" onChange={(event) => setLink(event.currentTarget.value)} />
            <button type="button" className="btn btn-ring" disabled={busy || link.trim() === ''} onClick={() => void connect()}>{busy ? 'Connecting…' : 'Connect'}</button>
          </div>
        )}
      {!going && <div className="lw-settings-actions"><button type="button" className="link" disabled={busy} onClick={() => setOpen(false)}>Cancel</button></div>}
    </div>
  )
}

/** Choosing an iPhone or a computer, then its code: a QR code for an iPhone, a link for a computer. */
function ConnectDevice({ known, onConnected, onDone }: { known: string[]; onConnected: (name: string) => void; onDone: () => void }) {
  const [kind, setKind] = useState<DeviceKind>('phone')
  /** Bumped for a new code of the same kind: New code, Check again, and once devices are let in. */
  const [round, setRound] = useState(0)
  const [made, setMade] = useState<CodeMade | null>(null)
  const [busy, setBusy] = useState(true)
  const [sharing, setSharing] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const before = useRef(new Set(known))

  // The code for the kind chosen; the press that asked for it has already cleared what was shown.
  useEffect(() => {
    let current = true
    makeCode(kind).then(
      (code) => { if (current) { setMade(code); setBusy(false) } },
      (caught: unknown) => { if (current) { setError(message(caught)); setBusy(false) } },
    )
    return () => { current = false }
  }, [kind, round])

  const ask = (next: DeviceKind) => {
    setBusy(true)
    setError('')
    setCopied(false)
    if (next === kind) setRound((count) => count + 1)
    else setKind(next)
  }

  // While a code is up, watch for the device it brings: the person is looking at their phone.
  const waiting = made?.reach.state === 'ready'
  useEffect(() => {
    if (!waiting) return
    const timer = window.setInterval(() => {
      void fetchDevices().then(({ devices }) => {
        const arrived = devices.find((device) => !before.current.has(device.id))
        if (arrived) onConnected(arrived.name)
      }, () => undefined)
    }, 2000)
    return () => window.clearInterval(timer)
  }, [waiting, onConnected])

  const share = async () => {
    setBusy(true)
    setSharing(true)
    setError('')
    try {
      const reach = await shareOnTailscale()
      setSharing(false)
      if (reach.state === 'ready') {
        ask(kind)
        return
      }
      setMade((current) => (current ? { ...current, reach } : current))
    } catch (caught) {
      setError(message(caught))
      setSharing(false)
    }
    setBusy(false)
  }

  const copy = async (link: string) => {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
    } catch {
      setError('Couldn’t copy. Select the link and copy it.')
    }
  }

  return (
    <div className="lw-devices-connect" aria-busy={busy}>
      <div className="lw-devices-kind" role="group" aria-label="Device to connect">
        {KINDS.map((option) => (
          <button key={option} type="button" aria-pressed={kind === option} disabled={busy && kind !== option} onClick={() => { if (option !== kind) ask(option) }}>
            {KIND_WORD[option]}
          </button>
        ))}
      </div>
      {error && <p role="alert" className="inline-error t-body"><span className="detail">{error}</span></p>}
      {(!made || made.kind !== kind) && busy && <p role="status" className="t-meta lw-settings-quiet">Checking Tailscale…</p>}
      {made && made.kind === kind && (made.reach.state === 'ready'
        ? <Code made={made} copied={copied} busy={busy} onCopy={copy} onAgain={() => ask(kind)} />
        : <InTheWay reach={made.reach} kind={kind} busy={busy} sharing={sharing} onShare={() => void share()} onAgain={() => ask(kind)} />)}
      <div className="lw-settings-actions">
        <button type="button" className="link" onClick={onDone}>Done</button>
      </div>
    </div>
  )
}

function Code({ made, copied, busy, onCopy, onAgain }: {
  made: CodeMade
  copied: boolean
  busy: boolean
  onCopy: (link: string) => void
  onAgain: () => void
}) {
  const until = (
    <p className="t-meta lw-settings-quiet">
      Works once, until {clock(made.expiresAt)}.{' '}
      <button type="button" className="link" disabled={busy} onClick={onAgain}>New code</button>
    </p>
  )
  if (made.kind === 'phone' && made.qr) {
    return (
      <figure className="lw-devices-qr">
        <svg viewBox={`0 0 ${made.qr.size} ${made.qr.size}`} role="img" aria-label="Code for your iPhone’s camera" shapeRendering="crispEdges">
          <rect className="paper" width={made.qr.size} height={made.qr.size} />
          <path className="ink" d={made.qr.path} />
        </svg>
        <figcaption className="t-body">Point your iPhone’s camera at this code and open it in the LoomWatch app.</figcaption>
        <p className="t-meta lw-settings-quiet">Your iPhone needs the LoomWatch app and Tailscale, signed in to the same account as this computer.</p>
        {until}
      </figure>
    )
  }
  return (
    <div className="lw-devices-link">
      <p className="t-body">Send this link to your other computer. There, open LoomWatch, choose Connect to another computer under Your devices, and paste it.</p>
      <div className="lw-devices-link-row">
        <input className="input" readOnly value={made.link ?? ''} aria-label="Link for your other computer" onFocus={(event) => event.currentTarget.select()} />
        <button type="button" className="btn btn-ring" disabled={!made.link} onClick={() => made.link && onCopy(made.link)}>{copied ? 'Copied' : 'Copy link'}</button>
      </div>
      <p className="t-meta lw-settings-quiet">Your other computer needs LoomWatch and Tailscale, signed in to the same account as this one.</p>
      {until}
    </div>
  )
}

/** What stops devices reaching this computer, with the one thing to do about it. */
function InTheWay({ reach, kind, busy, sharing, onShare, onAgain }: {
  reach: Reach
  kind: DeviceKind
  busy: boolean
  sharing: boolean
  onShare: () => void
  onAgain: () => void
}) {
  const again = <button type="button" className="link" disabled={busy} onClick={onAgain}>Check again</button>
  const step = (line: string, actions: ReactNode, detail?: string) => (
    <div className="lw-devices-step">
      <p className="t-body">{line}</p>
      {detail && <p className="t-meta lw-settings-quiet">{detail}</p>}
      <div className="lw-settings-actions">{actions}</div>
    </div>
  )
  switch (reach.state) {
    case 'notShared':
      return step(
        'Let the devices on your Tailscale account reach LoomWatch here. No one else can.',
        <button type="button" className="btn btn-ring" disabled={busy} onClick={onShare}>{sharing ? 'Letting your devices in…' : 'Let my devices in'}</button>,
      )
    case 'noTailscale':
      return step(
        `Install Tailscale, an app that links your own devices, on this computer and on ${OTHER_DEVICE[kind]}. Sign in to both with the same account, such as your Google or Apple account.`,
        <><a className="btn btn-ring" href="https://tailscale.com/download" target="_blank" rel="noreferrer">Get Tailscale</a>{again}</>,
      )
    case 'tailscaleOff':
      return step('Open Tailscale on this computer and turn it on.', again)
    case 'signedOut':
      return reach.url
        ? step('Sign in to Tailscale on this computer.', <><a className="btn btn-ring" href={reach.url} target="_blank" rel="noreferrer">Sign in</a>{again}</>)
        : step('Open Tailscale on this computer and sign in.', again)
    case 'needsOk':
      return step(
        'Tailscale needs your OK, once. Allow it on the page that opens, then come back and press Try again.',
        <><a className="btn btn-ring" href={reach.url} target="_blank" rel="noreferrer">Allow it</a><button type="button" className="link" disabled={busy} onClick={onShare}>{sharing ? 'Trying…' : 'Try again'}</button></>,
      )
    case 'portsTaken':
      return step('Tailscale on this computer already shares three other things, so LoomWatch has no room. Stop one in Tailscale, then check again.', again, 'LoomWatch can use ports 443, 8443 and 10000.')
    case 'failed':
      return step('Tailscale couldn’t let your devices in. Quit Tailscale, open it again, then press Check again.', again, `Tailscale said: ${reach.message}`)
    case 'ready':
      return null
  }
}
