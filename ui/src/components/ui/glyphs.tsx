import type { CSSProperties } from 'react'

import { LOOM_MARK_SAYS, loomMarkPose, usePrefersReducedMotion, type LoomMarkState } from '../../lib/story/loomMark'
import type { AgentStatus } from '../../lib/team-file/types'

// DESIGN_LANGUAGE §12: shape is the primary channel; colour and motion are second and
// third. One renderer shared by nodes, the inspector, evidence cards and the run node.
const STATUS_BODY: Record<AgentStatus, { colour: string; body: React.ReactNode }> = {
  idle: { colour: 'var(--color-ink-3)', body: <circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.5" /> },
  starting: {
    colour: 'var(--color-live)',
    body: <>
      <circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.5" opacity=".35" />
      <path className="status-arc" d="M6 1.6A4.4 4.4 0 0 1 10.4 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>,
  },
  running: {
    colour: 'var(--color-live)',
    body: <>
      <circle className="status-halo" cx="6" cy="6" r="5.4" fill="currentColor" opacity=".18" />
      <circle cx="6" cy="6" r="3.4" fill="currentColor" />
    </>,
  },
  waiting: { colour: 'var(--color-halt)', body: <path d="M6 1.4 10.6 6 6 10.6 1.4 6z" fill="none" stroke="currentColor" strokeWidth="1.5" /> },
  succeeded: {
    colour: 'var(--color-ok)',
    body: <>
      <circle cx="6" cy="6" r="5.4" fill="currentColor" />
      <path d="M3.6 6.2 5.3 7.9 8.5 4.3" fill="none" stroke="var(--color-ground)" strokeWidth="1.6" strokeLinecap="round" />
    </>,
  },
  failed: {
    colour: 'var(--color-alert)',
    body: <>
      <circle cx="6" cy="6" r="5.4" fill="currentColor" />
      <path d="M4 4l4 4M8 4l-4 4" fill="none" stroke="var(--color-ground)" strokeWidth="1.6" strokeLinecap="round" />
    </>,
  },
  stopped: { colour: 'var(--color-halt)', body: <rect x="2.2" y="2.2" width="7.6" height="7.6" rx="1.2" fill="currentColor" /> },
  unavailable: { colour: 'color-mix(in srgb, var(--color-ink-3) 40%, transparent)', body: <circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 2" /> },
}

export function StatusGlyph({ status, size = 12, title, style }: { status: AgentStatus; size?: number; title?: string; style?: CSSProperties }) {
  const entry = STATUS_BODY[status] ?? STATUS_BODY.idle
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" style={{ color: entry.colour, flex: 'none', ...style }} aria-hidden={title ? undefined : 'true'} role={title ? 'img' : undefined} aria-label={title}>
      {entry.body}
    </svg>
  )
}

// UX_REDESIGN §9.1: nine document states; the shape changes with the state, so the chip
// survives greyscale.
export type ChipState = 'clean' | 'dirty' | 'saving' | 'saved' | 'failed' | 'incomplete' | 'invalid' | 'readonly' | 'new'
const CHIP_BODY: Record<ChipState, { colour: string; body: React.ReactNode }> = {
  clean: { colour: 'var(--color-ink-3)', body: <circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.5" /> },
  dirty: { colour: 'var(--color-accent)', body: <path d="M6 1.4 10.6 6 6 10.6 1.4 6z" fill="currentColor" /> },
  saving: {
    colour: 'var(--color-accent)',
    body: <>
      <circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.5" opacity=".35" />
      <path className="status-arc" d="M6 1.6A4.4 4.4 0 0 1 10.4 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>,
  },
  saved: {
    colour: 'var(--color-ok)',
    body: <>
      <circle cx="6" cy="6" r="5.4" fill="currentColor" />
      <path d="M3.6 6.2 5.3 7.9 8.5 4.3" fill="none" stroke="var(--color-ground)" strokeWidth="1.6" strokeLinecap="round" />
    </>,
  },
  failed: { colour: 'var(--color-alert)', body: <path d="M2.4 2.4l7.2 7.2M9.6 2.4 2.4 9.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /> },
  incomplete: { colour: 'var(--color-accent)', body: <path d="M6 1.4 10.6 6 6 10.6 1.4 6z" fill="currentColor" /> },
  invalid: { colour: 'var(--color-alert)', body: <circle cx="6" cy="6" r="5.2" fill="currentColor" /> },
  readonly: {
    colour: 'var(--color-halt)',
    body: <>
      <rect x="2.4" y="5.2" width="7.2" height="5" rx="1.2" fill="currentColor" />
      <path d="M4.2 5.2V4a1.8 1.8 0 0 1 3.6 0v1.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </>,
  },
  new: { colour: 'var(--color-accent)', body: <path d="M6 1.4 10.6 6 6 10.6 1.4 6z" fill="none" stroke="currentColor" strokeWidth="1.5" /> },
}

export function ChipDot({ state, size = 12 }: { state: ChipState; size?: number }) {
  const entry = CHIP_BODY[state] ?? CHIP_BODY.clean
  return <svg className="dot" width={size} height={size} viewBox="0 0 12 12" style={{ color: entry.colour }} aria-hidden="true">{entry.body}</svg>
}

// RUN_PROVENANCE_CONTRACT §8.1: the trace entity kinds.
export type EntityKind = 'prompt' | 'response' | 'agent' | 'reasoning' | 'skill' | 'tool' | 'command' | 'source' | 'file' | 'search' | 'delegation' | 'permission' | 'plan' | 'run'
const ENTITY_BODY: Record<EntityKind, React.ReactNode> = {
  prompt: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  response: <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z" /><path d="M14 2v5h6" /></>,
  agent: <circle cx="12" cy="12" r="9" />,
  reasoning: <path d="M12 4a4 4 0 0 0-4 4 3 3 0 0 0-1 5.8V17a3 3 0 0 0 5 2 3 3 0 0 0 5-2v-3.2A3 3 0 0 0 16 8a4 4 0 0 0-4-4z" />,
  skill: <path d="M9 3h6v3a2 2 0 0 0 2 2h3v6h-3a2 2 0 0 0-2 2v3H9v-3a2 2 0 0 0-2-2H4V8h3a2 2 0 0 0 2-2z" />,
  tool: <><path d="M14.7 6.3a4 4 0 0 1 5 5L11 20a3 3 0 0 1-4-4z" /><path d="M15 7l2 2" /></>,
  command: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 9l3 3-3 3M13 15h4" /></>,
  source: <><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" /></>,
  file: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h6" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4.3-4.3" /></>,
  delegation: <><path d="M5 12h9" /><path d="m11 8 4 4-4 4" /><circle cx="18.5" cy="12" r="2.5" /></>,
  permission: <><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>,
  plan: <><path d="M9 6h11M9 12h11M9 18h11" /><path d="m3 6 1 1 2-2M3 12l1 1 2-2M3 18l1 1 2-2" /></>,
  run: <path d="M7 4l12 8-12 8z" />,
}

export function EntityGlyph({ kind, size = 14, style }: { kind: EntityKind; size?: number; style?: CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none', ...style }}>
      {ENTITY_BODY[kind] ?? ENTITY_BODY.agent}
    </svg>
  )
}

/**
 * LoomWatch's mark: the face every crew figure wears, two warp-thread eyes and a gold weft stitch for
 * a mouth, sewn onto a dark tile with a gold running stitch (docs/assets/brand). At 40 px and below it
 * draws mark-small.svg, whose face is bigger and whose stitch is coarser, so both still read. The
 * tile stays dark in both themes, like an app icon.
 *
 * Given a `state` (from useNeedsYou), the face says what the app is doing, the way the crew's
 * figures do (lib/story/loomMark.ts): still when ready, glancing with a blue glow while a team
 * works, a small gold "o" and a gold glow when something needs you, one blink when a run is done.
 * Its accessible name stays the link's; only the tooltip says the state.
 */
export function LoomMark({ size = 28, state = 'ready' }: { size?: number; state?: LoomMarkState }) {
  const pose = loomMarkPose(state, { reducedMotion: usePrefersReducedMotion() })
  const says = LOOM_MARK_SAYS[state]
  const small = size <= 40
  return (
    <svg
      className="fr-mark lw-mark" width={size} height={size} viewBox="0 0 512 512" aria-hidden="true" style={{ flex: 'none' }}
      data-state={state} data-mouth={pose.mouth} data-glow={pose.glow}
      data-glance={pose.glance || undefined} data-blink={pose.blink || undefined} data-breathe={pose.breathe || undefined}
    >
      {says && <title>{says}</title>}
      <rect width="512" height="512" rx="112" fill="#08080A" />
      {small
        ? <path d="M256 40H384A88 88 0 0 1 472 128V384A88 88 0 0 1 384 472H128A88 88 0 0 1 40 384V128A88 88 0 0 1 128 40Z" fill="none" stroke="#D8A93C" strokeWidth="26" strokeLinecap="round" strokeDasharray="49.28 49.28" strokeDashoffset="24.64" />
        : <path d="M256 44H382A86 86 0 0 1 468 130V382A86 86 0 0 1 382 468H130A86 86 0 0 1 44 382V130A86 86 0 0 1 130 44Z" fill="none" stroke="#D8A93C" strokeWidth="10" strokeLinecap="round" strokeDasharray="16.26 22.45" strokeDashoffset="8.13" />}
      <g className="lw-mark-face">
        {small ? <>
          <g className="lw-mark-eyes">
            <rect x="152" y="146" width="70" height="150" rx="35" fill="#F5F3EE" />
            <rect x="290" y="146" width="70" height="150" rx="35" fill="#F5F3EE" />
          </g>
          <path className="lw-mark-stitch" d="M222 354Q256 382 290 354" fill="none" stroke="#E9C46A" strokeWidth="40" strokeLinecap="round" />
          <circle className="lw-mark-o" cx="256" cy="362" r="26" fill="none" stroke="#E9C46A" strokeWidth="30" />
        </> : <>
          <g className="lw-mark-eyes">
            <rect x="170" y="170" width="52" height="112" rx="26" fill="#F5F3EE" />
            <rect x="290" y="170" width="52" height="112" rx="26" fill="#F5F3EE" />
          </g>
          <path className="lw-mark-stitch" d="M230 330Q256 352 282 330" fill="none" stroke="#E9C46A" strokeWidth="28" strokeLinecap="round" />
          <circle className="lw-mark-o" cx="256" cy="340" r="17" fill="none" stroke="#E9C46A" strokeWidth="24" />
        </>}
      </g>
    </svg>
  )
}

/**
 * LoomWatch's face alone, in the text colour: the eyes and stitch of its mark with no tile and no
 * ring. Where LoomWatch itself speaks in the chat it wears this (ADR 0098), as every agent there is
 * its figure alone, and gold stays for what needs you. It never moves.
 */
export function LoomFace({ size = 28 }: { size?: number }) {
  return (
    <svg className="lw-face" width={size} height={size} viewBox="116 120 280 280" aria-hidden="true" style={{ flex: 'none' }}>
      <rect x="152" y="146" width="70" height="150" rx="35" fill="currentColor" />
      <rect x="290" y="146" width="70" height="150" rx="35" fill="currentColor" />
      <path d="M222 354Q256 382 290 354" fill="none" stroke="currentColor" strokeWidth="40" strokeLinecap="round" />
    </svg>
  )
}

/**
 * The name, drawn with the mark's thread: lowercase round-capped strokes in the text colour, and the
 * t's crossbar in gold, the weft again (docs/assets/brand/wordmark-*.svg). Below 32 px the thread is a
 * little heavier so it does not go thin.
 */
export function LoomWordmark({ height = 20 }: { height?: number }) {
  const stroke = height < 32 ? 12 : 11
  const width = Math.round((height * (489 + stroke)) / (80 + stroke) * 10) / 10
  return (
    <svg className="lw-wordmark" width={width} height={height} viewBox={`${-stroke / 2} ${20 - stroke / 2} ${489 + stroke} ${80 + stroke}`} fill="none" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" role="img" aria-label="LoomWatch" style={{ flex: 'none' }}>
      <path stroke="currentColor" d="M0 20V100M13 75a25 25 0 1 0 50 0a25 25 0 1 0-50 0M74 75a25 25 0 1 0 50 0a25 25 0 1 0-50 0M138 50V100M138 67a16 16 0 0 1 32 0V100M170 67a16 16 0 0 1 32 0V100M215 50L231 100L247 56L263 100L279 50M291 75a25 25 0 1 0 50 0a25 25 0 1 0-50 0M341 50V100M361 28V86q0 14 14 14M430.73 56.42A25 25 0 1 0 430.73 93.58M449 20V100M449 70a20 20 0 0 1 40 0V100" />
      <path style={{ stroke: 'var(--color-accent)' }} d="M351 50H375" />
    </svg>
  )
}

/** Coverage level glyphs (CONTRACT §12): shape + colour + word, never colour alone. */
export type Coverage = 'complete' | 'partial' | 'unavailable'
export function CoverageGlyph({ level }: { level: Coverage }) {
  const colour = level === 'complete' ? 'var(--color-ok)' : level === 'partial' ? 'var(--color-accent)' : 'var(--color-ink-3)'
  return (
    <svg className="cov" width="10" height="10" viewBox="0 0 10 10" style={{ color: colour, flex: 'none' }} aria-hidden="true">
      {level === 'complete' && <circle cx="5" cy="5" r="4.5" fill="currentColor" />}
      {level === 'partial' && <><circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M5 1a4 4 0 0 1 0 8z" fill="currentColor" /></>}
      {level === 'unavailable' && <circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 2" />}
    </svg>
  )
}
