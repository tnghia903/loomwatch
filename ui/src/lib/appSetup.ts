// What someone without a working AI app needs to get one: the vendor's own install command, how to
// sign in, and what the app costs. Shown by Home's "Set up an AI app" panel (ADR 0045).
//
// Commands are the vendors' own, checked against their install pages on 2026-10-03:
//   Claude Code  https://code.claude.com/docs/en/setup   (native installer → ~/.local/bin/claude)
//   Codex        https://learn.chatgpt.com/docs/codex/cli (standalone installer → ~/.local/bin/codex)
//   OpenCode     https://opencode.ai/docs/                (install script → ~/.opencode/bin/opencode)
// The daemon finds all three install folders without a restart (api.rs EXTRA_HARNESS_DIRECTORIES).
// The sign-in commands match the daemon's own "isn’t signed in" sentence (api.rs SignInCheck).
import { harnessSaid, type DetectedHarness } from './harnesses'

export interface AppSetupGuide {
  /** The daemon's harness id. */
  id: string
  /** The product name someone would search for. */
  name: string
  /** What it needs from the person, in one or two sentences. */
  account: string
  /** One command for Terminal. */
  install: string
  /** The command that signs in, or `null` for an app that works without an account. */
  signIn: string | null
  /** For an app that works without an account: the command that adds one, for more models. */
  optionalSignIn?: string
  /** A short label for an app worth pointing out, e.g. that it needs no account. */
  badge?: string
  /** The vendor's own install page, for anyone whose install command fails. */
  docs: string
}

export const APP_SETUP_GUIDES: readonly AppSetupGuide[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    // Anthropic asks apps built on its Agent SDK, as Claude Code's ACP bridge is, to use API keys.
    account: 'Needs a Claude Pro, Max, Team or Enterprise plan; the free Claude plan doesn’t include it. Or use an Anthropic API key: set ANTHROPIC_API_KEY before starting LoomWatch.',
    install: 'curl -fsSL https://claude.ai/install.sh | bash',
    signIn: 'claude auth login',
    docs: 'https://code.claude.com/docs/en/setup',
  },
  {
    id: 'codex',
    name: 'Codex',
    account: 'Sign in with your ChatGPT account, or use an OpenAI API key.',
    install: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    signIn: 'codex login',
    docs: 'https://learn.chatgpt.com/docs/codex/cli',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    account: 'Works right away with free models, no account needed. Free models come and go, and some let their maker learn from what you send, so keep private work for a model you pay for.',
    install: 'curl -fsSL https://opencode.ai/install | bash',
    signIn: null,
    optionalSignIn: 'opencode auth login',
    badge: 'No account needed',
    docs: 'https://opencode.ai/docs/',
  },
]

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
  | { kind: 'ready' }

/** Judge one app from what the daemon reported. */
export function appSetupState(harness: DetectedHarness | undefined, checking: boolean): AppSetupState {
  if (!harness) return { kind: 'missing' }
  if (checking) return { kind: 'checking' }
  if (harness.acpAvailable === false) return { kind: 'no_bridge', reason: harness.unavailableReason ?? `${harness.name} can’t be started by LoomWatch.` }
  if (harness.health === 'error') {
    if (harness.healthCause === 'signed_out') return { kind: 'signed_out', reason: harness.healthReason ?? `${harness.name} isn’t signed in.` }
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
  return [harness.executablePath, harness.spawn.cmd, ...harness.spawn.args].join('\u0000')
}
