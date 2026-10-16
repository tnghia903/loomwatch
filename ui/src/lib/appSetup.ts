// What someone without a working AI app needs to get one: how LoomWatch sets it up, how to sign in,
// and what the app costs. Shown by Home's "Set up an AI app" panel (ADR 0045).
//
// The panel's buttons do the work: Claude and Codex come inside the connector LoomWatch installs
// for them (connectors.rs), and their sign-in and OpenCode's installer are the vendors' own commands,
// run by the daemon (app_setup.rs). The Terminal commands below stay for anyone who prefers them.
//
// Commands are the vendors' own, checked against their install pages on 2026-10-03:
//   Claude Code  https://code.claude.com/docs/en/setup   (native installer → ~/.local/bin/claude)
//   Codex        https://learn.chatgpt.com/docs/codex/cli (standalone installer → ~/.local/bin/codex)
//   OpenCode     https://opencode.ai/docs/                (install script → ~/.opencode/bin/opencode)
// and on Windows on 2026-10-05: Claude's install.ps1 (→ %USERPROFILE%\.local\bin\claude.exe),
// Codex's install.ps1 (→ %LOCALAPPDATA%\Programs\OpenAI\Codex\bin), and OpenCode's npm package
// (→ %APPDATA%\npm), OpenCode's install script being for macOS and Linux only.
// The daemon finds all of these install folders without a restart (api.rs EXTRA_HARNESS_DIRECTORIES).
// The sign-in commands match the daemon's own "isn’t signed in" sentence (api.rs SignInCheck).
import { harnessSaid, type ConnectorStatus, type DetectedHarness, type SetupJob } from './harnesses'
import { isWindows } from './platform'

export interface AppSetupGuide {
  /** The daemon's harness id. */
  id: string
  /** The product name someone would search for. */
  name: string
  /** What it needs from the person, in one or two sentences. */
  account: string
  /** One command for Terminal. */
  install: string
  /** The same for PowerShell on Windows. */
  windowsInstall: string
  /** The command that signs in, or `null` for an app that works without an account. */
  signIn: string | null
  /** For an app that works without an account: the command that adds one, for more models. */
  optionalSignIn?: string
  /** A short label for an app worth pointing out, e.g. that it needs no account. */
  badge?: string
  /** The vendor's own install page, for anyone whose install command fails. */
  docs: string
  /**
   * How the panel's button sets it up: `connector` installs LoomWatch's connector, which carries
   * the app itself; `installer` runs the vendor's own installer.
   */
  setup: 'connector' | 'installer'
  /** About how much the button downloads, once. */
  size: string
}

export const APP_SETUP_GUIDES: readonly AppSetupGuide[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    // Anthropic asks apps built on its Agent SDK, as Claude Code's ACP bridge is, to use API keys.
    account: 'Needs a Claude Pro, Max, Team or Enterprise plan; the free Claude plan doesn’t include it. Or use an Anthropic API key: set ANTHROPIC_API_KEY before starting LoomWatch.',
    install: 'curl -fsSL https://claude.ai/install.sh | bash',
    windowsInstall: 'irm https://claude.ai/install.ps1 | iex',
    signIn: 'claude auth login',
    docs: 'https://code.claude.com/docs/en/setup',
    setup: 'connector',
    size: 'about 300 MB',
  },
  {
    id: 'codex',
    name: 'Codex',
    account: 'Sign in with your ChatGPT account, or use an OpenAI API key.',
    install: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    windowsInstall: 'irm https://chatgpt.com/codex/install.ps1 | iex',
    signIn: 'codex login',
    docs: 'https://learn.chatgpt.com/docs/codex/cli',
    setup: 'connector',
    size: 'about 350 MB',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    account: 'Works right away with free models, no account needed. Free models come and go, and some let their maker learn from what you send, so keep private work for a model you pay for.',
    install: 'curl -fsSL https://opencode.ai/install | bash',
    windowsInstall: 'npm install -g opencode-ai',
    signIn: null,
    optionalSignIn: 'opencode auth login',
    badge: 'No account needed',
    docs: 'https://opencode.ai/docs/',
    setup: 'installer',
    size: 'about 100 MB',
  },
]

/** The command that installs `guide`'s app on this computer. */
export function installCommand(guide: Partial<Pick<AppSetupGuide, 'install' | 'windowsInstall'>>, windows = isWindows()): string | undefined {
  return (windows && guide.windowsInstall) || guide.install
}

/** Where one app stands, from first install to ready, as the panel tells it. */
export type AppSetupState =
  | { kind: 'missing' }
  | { kind: 'checking' }
  /** On this computer, not yet checked. Brief: the panel checks it as soon as it appears. */
  | { kind: 'found' }
  | { kind: 'no_bridge'; reason: string }
  | { kind: 'signed_out'; reason: string }
  /** Set up in a way no other app can use until it has an API key (Gemini CLI), said by the daemon. */
  | { kind: 'needs_key'; reason: string }
  | { kind: 'failed'; reason: string; detail?: string }
  /**
   * Works, but the running LoomWatch cannot start it: it was installed after LoomWatch started,
   * and runs start apps from the PATH LoomWatch started with (the daemon's `needsRestart`).
   */
  | { kind: 'restart' }
  /** LoomWatch is installing the app's connector (once); `step` says what it is doing. */
  | { kind: 'preparing'; step: string }
  | { kind: 'connector_failed'; reason: string }
  /** The vendor's installer is running. */
  | { kind: 'installing' }
  /** The app's own sign-in is waiting for the person in the browser. */
  | { kind: 'signing_in'; url?: string; needsCode: boolean }
  /** A sign-in or install the panel started failed; `retry` is what the button does again. */
  | { kind: 'setup_failed'; reason: string; retry: 'sign_in' | 'install' }
  | { kind: 'ready' }

/** What the daemon reports beside an app: its connector, and a sign-in or install the panel started. */
export interface AppSetupExtras {
  /** For an app not on this computer yet; a listed app carries its own. */
  connector?: ConnectorStatus
  job?: SetupJob
}

/** Judge one app from what the daemon reported. */
export function appSetupState(harness: DetectedHarness | undefined, checking: boolean, { connector: unlisted, job }: AppSetupExtras = {}): AppSetupState {
  if (!harness) {
    if (job?.kind === 'install' && job.state === 'running') return { kind: 'installing' }
    if (job?.kind === 'install' && job.state === 'failed') return { kind: 'setup_failed', reason: job.reason ?? 'The installer stopped.', retry: 'install' }
    if (unlisted?.state === 'preparing') return { kind: 'preparing', step: unlisted.step }
    if (unlisted?.state === 'failed') return { kind: 'connector_failed', reason: unlisted.reason }
    return { kind: 'missing' }
  }
  if (checking) return { kind: 'checking' }
  if (harness.acpAvailable === false) return { kind: 'no_bridge', reason: harness.unavailableReason ?? `${harness.name} can’t be started by LoomWatch.` }
  // An app already checked through npx works while its connector installs in the background.
  const connector = harness.connector
  if (connector && connector.state !== 'ready' && harness.health !== 'ok') {
    if (connector.state === 'failed') return { kind: 'connector_failed', reason: connector.reason }
    return { kind: 'preparing', step: connector.state === 'preparing' ? connector.step : 'Waiting to start' }
  }
  if (harness.health === 'error') {
    if (harness.healthCause === 'signed_out') {
      if (job?.kind === 'sign_in' && job.state === 'running') return { kind: 'signing_in', ...(job.url ? { url: job.url } : {}), needsCode: job.needsCode === true }
      if (job?.kind === 'sign_in' && job.state === 'failed') return { kind: 'setup_failed', reason: job.reason ?? 'The sign-in stopped.', retry: 'sign_in' }
      return { kind: 'signed_out', reason: harness.healthReason ?? `${harness.name} isn’t signed in.` }
    }
    if (harness.healthCause === 'needs_api_key') return { kind: 'needs_key', reason: harness.healthReason ?? `${harness.name} needs an API key to work with other apps.` }
    return { kind: 'failed', reason: harness.healthReason ?? `${harness.name} couldn’t start.`, ...(harness.healthDetail ? { detail: harnessSaid(harness.healthDetail) } : {}) }
  }
  if (harness.health !== 'ok') return { kind: 'found' }
  if (harness.needsRestart) return { kind: 'restart' }
  return { kind: 'ready' }
}

/**
 * What an app check is about: the exact executable and the command a run starts. A reinstall or a
 * new bridge is a different app to check, as the daemon's health record also says (api.rs
 * apply_harness_health).
 */
export function checkSignature(harness: DetectedHarness): string {
  return [harness.executablePath, harness.connector?.state ?? '', harness.spawn.cmd, ...harness.spawn.args].join('\u0000')
}
