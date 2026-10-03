import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DetectedHarness } from '../../lib/harnesses'
import { AppSetup } from './AppSetup'

const opencode: DetectedHarness = { id: 'opencode', name: 'OpenCode', command: 'opencode', executablePath: '/home/u/.opencode/bin/opencode', acpAvailable: true, spawn: { cmd: 'opencode', args: ['acp'] } }
const claude: DetectedHarness = { id: 'claude', name: 'Claude', command: 'claude', executablePath: '/home/u/.local/bin/claude', acpAvailable: true, spawn: { cmd: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp'] } }
const signedOutReason = 'Claude isn’t signed in. Run "claude auth login" in Terminal, then check again.'

function respond(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
}

/** A daemon whose installed apps, their verdicts and the run PATH a test can change mid-way. */
function fakeDaemon() {
  const daemon = {
    installed: [] as DetectedHarness[],
    /** What a models check records for an app id: `ok`, `signed_out`, `unrecorded`, or an error. */
    verdicts: new Map<string, string>(),
    needsRestart: new Set<string>(),
    modelCalls: [] as string[],
    checked: new Set<string>(),
  }
  const listed = () => daemon.installed.map((installed): DetectedHarness => {
    const harness = daemon.needsRestart.has(installed.id) ? { ...installed, needsRestart: true } : installed
    if (!daemon.checked.has(harness.id)) return harness
    const verdict = daemon.verdicts.get(harness.id) ?? 'ok'
    if (verdict === 'ok') return { ...harness, health: 'ok' }
    if (verdict === 'signed_out') return { ...harness, health: 'error', healthCause: 'signed_out', healthReason: signedOutReason }
    return { ...harness, health: 'error', healthReason: `${harness.name}: sign-in or version problem`, healthDetail: verdict }
  })
  const fetchMock = vi.fn((url: string) => {
    if (url === '/api/harnesses') return respond({ harnesses: listed(), searchedPath: [], knownIds: [] })
    const models = /^\/api\/harnesses\/([^/]+)\/models$/.exec(url)
    if (models) {
      daemon.modelCalls.push(models[1])
      const verdict = daemon.verdicts.get(models[1]) ?? 'ok'
      // A daemon that failed before recording anything, e.g. while it was restarting.
      if (verdict === 'unrecorded') return respond({ error: 'busy' }, 503)
      daemon.checked.add(models[1])
      return verdict === 'ok' ? respond({ harnessId: models[1], models: [] }) : respond({ error: verdict === 'signed_out' ? signedOutReason : verdict }, 502)
    }
    return respond({ error: 'unexpected' }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
  return daemon
}

function renderSetup(harnesses: DetectedHarness[] = []) {
  const props = { onChanged: vi.fn(), onHide: vi.fn() }
  render(<AppSetup harnesses={harnesses} {...props} />)
  return props
}

const card = (name: RegExp) => screen.getByRole('listitem', { name })

beforeEach(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('AppSetup', () => {
  it('walks someone with no AI app through installing one, with each vendor’s own command', () => {
    fakeDaemon()
    renderSetup()
    expect(screen.getByRole('heading', { name: 'Set up an AI app' })).toBeInTheDocument()

    const claudeCard = card(/^Claude Code: Not installed/)
    expect(within(claudeCard).getByText('curl -fsSL https://claude.ai/install.sh | bash')).toBeInTheDocument()
    expect(within(claudeCard).getByText('claude auth login')).toBeInTheDocument()
    expect(within(claudeCard).getByText(/free Claude plan doesn’t include it/)).toBeInTheDocument()
    expect(within(card(/^Codex: Not installed/)).getByText('codex login')).toBeInTheDocument()

    // The one route with no account at all says so, and has no sign-in step.
    const openCodeCard = card(/^OpenCode: Not installed/)
    expect(within(openCodeCard).getByText('No account needed')).toBeInTheDocument()
    expect(within(openCodeCard).getByText(/That’s all/)).toBeInTheDocument()
    expect(within(openCodeCard).getByRole('button', { name: 'Copy curl -fsSL https://opencode.ai/install | bash' })).toBeInTheDocument()
  })

  it('notices an install on its own, checks the app once, and says it is ready', async () => {
    const daemon = fakeDaemon()
    const { onChanged } = renderSetup()
    expect(card(/^OpenCode: Not installed/)).toBeInTheDocument()

    daemon.installed = [opencode]
    fireEvent(window, new Event('focus'))

    await waitFor(() => expect(card(/^OpenCode: Ready/)).toBeInTheDocument())
    expect(daemon.modelCalls).toEqual(['opencode'])
    expect(screen.getByRole('heading', { name: 'Your AI app is ready' })).toBeInTheDocument()
    expect(within(card(/^OpenCode: Ready/)).getByText('opencode auth login')).toBeInTheDocument()
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    // New team, above the panel, is the one way to create a team (ADR 0043).
    expect(screen.getByText(/Press New team to make your first team/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /create a team/i })).toBeNull()

    // Polling goes on, but a checked install is not started again.
    const lists = () => vi.mocked(fetch).mock.calls.filter(([url]) => url === '/api/harnesses').length
    const before = lists()
    fireEvent(window, new Event('focus'))
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(lists()).toBeGreaterThanOrEqual(before + 2))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(daemon.modelCalls).toEqual(['opencode'])
  })

  it('asks again as soon as the tab shows again, after the person was in Terminal', async () => {
    const daemon = fakeDaemon()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    renderSetup()
    daemon.installed = [opencode]
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    fireEvent(document, new Event('visibilitychange'))
    await waitFor(() => expect(card(/^OpenCode: Ready/)).toBeInTheDocument())
  })

  it('asks a signed-out app to sign in, not to install, and checks again when asked', async () => {
    const daemon = fakeDaemon()
    daemon.installed = [claude]
    daemon.verdicts.set('claude', 'signed_out')
    renderSetup([claude])

    const signedOut = await screen.findByRole('listitem', { name: /^Claude Code: Not signed in/ })
    expect(within(signedOut).getByText('claude auth login')).toBeInTheDocument()
    expect(within(signedOut).queryByText(/install\.sh/)).toBeNull()
    // A signed-out first check downloads nothing more; it was one models call.
    expect(daemon.modelCalls).toEqual(['claude'])

    daemon.verdicts.set('claude', 'ok')
    fireEvent.click(within(signedOut).getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(card(/^Claude Code: Ready/)).toBeInTheDocument())
    expect(daemon.modelCalls).toEqual(['claude', 'claude'])
  })

  it('says to restart LoomWatch when a run could not start an app installed after it started', async () => {
    const daemon = fakeDaemon()
    daemon.installed = [opencode]
    daemon.needsRestart.add('opencode')
    renderSetup([opencode])

    const restart = await screen.findByRole('listitem', { name: /^OpenCode: Restart LoomWatch/ })
    expect(restart).toHaveTextContent('was installed after LoomWatch started')
    expect(within(restart).getByText('./loomwatch')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Set up an AI app' })).toBeInTheDocument()
  })

  it('does not start an app whose verdict the daemon already has', async () => {
    const daemon = fakeDaemon()
    daemon.installed = [opencode]
    daemon.checked.add('opencode')
    renderSetup([{ ...opencode, health: 'ok' }])
    expect(card(/^OpenCode: Ready/)).toBeInTheDocument()
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => url === '/api/harnesses')).toBe(true))
    expect(daemon.modelCalls).toEqual([])
  })

  it('checks again when LoomWatch forgets a verdict the panel saw, as after a restart', async () => {
    const daemon = fakeDaemon()
    daemon.installed = [opencode]
    daemon.needsRestart.add('opencode')
    renderSetup([opencode])
    await screen.findByRole('listitem', { name: /^OpenCode: Restart LoomWatch/ })
    expect(daemon.modelCalls).toEqual(['opencode'])

    // The person restarts LoomWatch from a new Terminal: the new daemon has no record, and its
    // PATH has the app.
    daemon.checked.clear()
    daemon.needsRestart.clear()
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(card(/^OpenCode: Ready/)).toBeInTheDocument())
    expect(daemon.modelCalls).toEqual(['opencode', 'opencode'])
  })

  it('does not keep starting an app whose check left no verdict, and leaves the next check to the person', async () => {
    const daemon = fakeDaemon()
    daemon.installed = [opencode]
    daemon.verdicts.set('opencode', 'unrecorded')
    renderSetup([opencode])
    const unchecked = await screen.findByRole('listitem', { name: /^OpenCode: Not checked yet/ })
    const lists = () => vi.mocked(fetch).mock.calls.filter(([url]) => url === '/api/harnesses').length
    const before = lists()
    fireEvent(window, new Event('focus'))
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect(lists()).toBeGreaterThanOrEqual(before + 2))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(daemon.modelCalls).toEqual(['opencode'])

    daemon.verdicts.set('opencode', 'ok')
    fireEvent.click(within(unchecked).getByRole('button', { name: 'Check OpenCode' }))
    await waitFor(() => expect(card(/^OpenCode: Ready/)).toBeInTheDocument())
  })

  it('shows other apps already on this computer, with what went wrong and a way to check again', async () => {
    const daemon = fakeDaemon()
    const gemini: DetectedHarness = { id: 'gemini', name: 'Gemini', command: 'gemini', executablePath: '/usr/bin/gemini', acpAvailable: true, spawn: { cmd: 'gemini', args: ['--acp'] } }
    daemon.installed = [gemini]
    daemon.verdicts.set('gemini', 'This client is no longer supported')
    renderSetup([gemini])

    const failed = await screen.findByRole('listitem', { name: /^Gemini: Can’t start/ })
    expect(within(failed).getByRole('alert')).toHaveTextContent('Gemini: sign-in or version problem')
    expect(within(failed).getByText('This client is no longer supported')).toBeInTheDocument()
    fireEvent.click(within(failed).getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(daemon.modelCalls).toEqual(['gemini', 'gemini']))
  })
})
