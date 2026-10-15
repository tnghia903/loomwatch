import { useId, type ReactNode } from 'react'

import { HAND_L, HAND_R, ON_HEAD, SPOTS } from '../../lib/library/accessorySpots'
import type { FigureKind } from '../../lib/library/figures'
import { ACCESSORIES, type Accessory } from '../../lib/quests/catalog'

/**
 * The wardrobe's accessories (lib/quests/catalog.ts), drawn flat over a figure's still. Each is
 * drawn around its own origin; lib/library/accessorySpots.ts places it on each figure. The 3D
 * bench wears the same ones as meshes (accessoryMeshes.ts).
 */

function Paints({ id }: { id: string }) {
  return (
    <defs>
      <filter id={`${id}-shadow`} x="-30%" y="-30%" width="160%" height="170%"><feDropShadow dx="0" dy="1.2" stdDeviation="1.1" floodColor="#000" floodOpacity=".22" /></filter>
      <linearGradient id={`${id}-pewter`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#C3C8CE" /><stop offset=".5" stopColor="#8D939A" /><stop offset="1" stopColor="#5F656C" /></linearGradient>
      <radialGradient id={`${id}-glass`} cx=".35" cy=".3" r=".8"><stop offset="0" stopColor="#FFFFFF" stopOpacity=".42" /><stop offset="1" stopColor="#FFFFFF" stopOpacity=".08" /></radialGradient>
      <linearGradient id={`${id}-chalk`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#F6F2FC" /><stop offset="1" stopColor="#CBBFE4" /></linearGradient>
      <linearGradient id={`${id}-silver`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#E1E4E8" /><stop offset="1" stopColor="#8E949B" /></linearGradient>
      <radialGradient id={`${id}-dome`} cx=".4" cy=".3" r=".8"><stop offset="0" stopColor="#A9C6A4" /><stop offset="1" stopColor="#5F7E5A" /></radialGradient>
      <linearGradient id={`${id}-wood`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#D9B68E" /><stop offset="1" stopColor="#A47D55" /></linearGradient>
      <pattern id={`${id}-gingham`} width="5" height="5" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="#EFE6D4" /><rect width="2.5" height="5" fill="#B49B74" fillOpacity=".45" /><rect width="5" height="2.5" fill="#B49B74" fillOpacity=".45" /></pattern>
    </defs>
  )
}

const url = (id: string, paint: string) => `url(#${id}-${paint})`

function Monocle({ id, r = 12, tail = [18, 52] }: { id: string; r?: number; tail?: [number, number] }) {
  const sx = r * 0.5
  const sy = r * 0.866
  const [tx, ty] = tail
  return (
    <g filter={url(id, 'shadow')}>
      <path d={`M${sx} ${sy} C ${sx + 2} ${sy + ty * 0.4}, ${tx - 6} ${ty * 0.6}, ${tx} ${ty}`} fill="none" stroke="#B5A584" strokeWidth="1.3" strokeLinecap="round" />
      <circle r={r} fill={url(id, 'glass')} />
      <circle r={r} fill="none" stroke={url(id, 'pewter')} strokeWidth={r * 0.3} />
      <path d={`M ${-r * 0.55} ${-r * 0.2} A ${r * 0.62} ${r * 0.62} 0 0 1 ${-r * 0.05} ${-r * 0.6}`} fill="none" stroke="#fff" strokeOpacity=".8" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx={sx} cy={sy} r={r * 0.24} fill={url(id, 'pewter')} />
    </g>
  )
}

function Chalk({ id }: { id: string }) {
  return (
    <g filter={url(id, 'shadow')}>
      <path d="M0 -11 L10 7 L-10 7 Z" fill={url(id, 'chalk')} stroke="#DCD3EE" strokeWidth="4" strokeLinejoin="round" />
      <path d="M-8 5.2 L8 5.2" stroke="#fff" strokeOpacity=".8" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M-3.5 -1 L3.5 -1" stroke="#A99CC8" strokeOpacity=".55" strokeWidth=".9" strokeLinecap="round" />
    </g>
  )
}

function Band({ id, l, r, y, sag }: { id: string; l: number; r: number; y: number; sag: number }) {
  const d = `M${l} ${y} Q ${(l + r) / 2} ${y + 2 * sag} ${r} ${y}`
  return (
    <g filter={url(id, 'shadow')}>
      <path d={d} stroke="#C9BDA3" strokeWidth="10.5" fill="none" />
      <path d={d} stroke="#F8F3E7" strokeWidth="8.4" fill="none" />
      <path d={d} transform="translate(0 -2.3)" stroke="#6E6862" strokeWidth="3" strokeDasharray=".8 3.6" fill="none" />
      <path d={d} transform="translate(0 -1.4)" stroke="#6E6862" strokeWidth="4.8" strokeDasharray="1.1 21.9" fill="none" />
      <rect x={l + 1} y={y - 6} width="5" height="12" rx="1.2" fill={url(id, 'pewter')} />
    </g>
  )
}

function Pin({ id }: { id: string }) {
  return (
    <g filter={url(id, 'shadow')}>
      <circle cx="-12" cy="0" r="3.4" fill="none" stroke="#A3A9B0" strokeWidth="1.5" />
      <path d="M-12 -3.4 L 11 -3.4" stroke="#B4BAC1" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M-9.4 2.6 L 10.5 2.6" stroke="#9AA0A7" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M8 -5.6 h7 a2.2 2.2 0 0 1 2.2 2.2 v5.6 a2.2 2.2 0 0 1 -2.2 2.2 h-7 z" fill={url(id, 'silver')} />
    </g>
  )
}

function Patch({ id }: { id: string }) {
  return (
    <g filter={url(id, 'shadow')}>
      <rect x="-11" y="-10" width="22" height="20" rx="2.5" fill={url(id, 'gingham')} />
      <rect x="-8.6" y="-7.6" width="17.2" height="15.2" rx="1.2" fill="none" stroke="#56524A" strokeWidth="1.1" strokeDasharray="2.2 1.9" />
    </g>
  )
}

function Cushion({ id }: { id: string }) {
  return (
    <g filter={url(id, 'shadow')}>
      <rect x="-12" y="3" width="24" height="7" rx="3.5" fill="#56704F" />
      <line x1="-4" y1="-3" x2="-7.5" y2="-14" stroke="#A3A9B0" strokeWidth="1" />
      <line x1="1" y1="-4" x2="1" y2="-16.5" stroke="#A3A9B0" strokeWidth="1" />
      <line x1="5" y1="-3" x2="9.5" y2="-13" stroke="#A3A9B0" strokeWidth="1" />
      <ellipse cx="0" cy="1.5" rx="11" ry="8" fill={url(id, 'dome')} />
      <path d="M-10.6 2.5 Q 0 6.5 10.6 2.5" stroke="#4E6748" strokeWidth="1" fill="none" />
      <circle cx="-7.5" cy="-14" r="2.1" fill="#EFE6D4" /><circle cx="1" cy="-16.5" r="2.1" fill="#BDB0E6" /><circle cx="9.5" cy="-13" r="2.1" fill="#3A372F" />
    </g>
  )
}

function Shuttle({ id }: { id: string }) {
  return (
    <g filter={url(id, 'shadow')}>
      <path d="M6.5 .6 C 14 2.4, 19 6.5, 27 8" stroke="#A796DA" strokeWidth="1.1" fill="none" strokeLinecap="round" />
      <path d="M-24 0 C -15 -8, 15 -8, 24 0 C 15 8, -15 8, -24 0 Z" fill={url(id, 'wood')} />
      <ellipse cx="0" cy="0" rx="9" ry="3.2" fill="#6B5034" />
      <rect x="-6.5" y="-2.4" width="13" height="4.8" rx="2.2" fill="#BDB0E6" />
      <path d="M-17 -3 C -8 -6, 8 -6, 17 -3" stroke="#fff" strokeOpacity=".4" strokeWidth="1.2" fill="none" strokeLinecap="round" />
    </g>
  )
}

/** One accessory where it sits on `kind`. */
function worn(item: Accessory, kind: FigureKind, id: string): ReactNode {
  const spot = SPOTS[kind]
  const at = ([x, y]: [number, number], rotate = 0) => `translate(${x} ${y})${rotate ? ` rotate(${rotate})` : ''}`
  switch (item) {
    case 'band': return <Band id={id} l={spot.band[0]} r={spot.band[1]} y={spot.band[2]} sag={spot.band[3]} />
    case 'chalk': return <g transform={at(spot.ear, 26)}><Chalk id={id} /></g>
    case 'patch': return <g transform={at(spot.cheek, 9)}><Patch id={id} /></g>
    case 'pin': return <g transform={at(spot.side, -58)}><Pin id={id} /></g>
    case 'monocle': return <g transform={at([spot.eye[0], spot.eye[1]])}><Monocle id={id} r={spot.eye[2]} /></g>
    case 'cushion': return <g transform={at(HAND_L)}><Cushion id={id} /></g>
    case 'shuttle': return <g transform={at(HAND_R, -14)}><Shuttle id={id} /></g>
  }
}

/**
 * What `kind` wears, drawn over its still: an SVG the same size as the still, so whatever crops or
 * scales the still (the chat avatar's crop, a card) does the same to this. `headOnly` leaves out
 * what is held in the hands, for the avatar that shows only the head.
 */
export function WornOverlay({ kind, wear, headOnly = false, className }: { kind: FigureKind; wear: readonly Accessory[]; headOnly?: boolean; className?: string }) {
  const id = `acc${useId().replace(/[^\w-]/g, '')}`
  const shown = ACCESSORIES.filter((item) => wear.includes(item) && (!headOnly || ON_HEAD.has(item)))
  if (shown.length === 0) return null
  return (
    <svg className={className ?? 'worn-overlay'} viewBox="0 0 320 320" aria-hidden="true" focusable="false">
      <Paints id={id} />
      {shown.map((item) => <g key={item}>{worn(item, kind, id)}</g>)}
    </svg>
  )
}

const ICON_BOX: Record<Accessory, string> = {
  band: '-24 -14 48 26', chalk: '-15 -15 30 30', patch: '-15 -15 30 30', pin: '-17 -17 34 34',
  monocle: '-17 -17 40 46', cushion: '-17 -21 34 34', shuttle: '-27 -14 56 28',
}

/** One accessory on its own, for the wardrobe and the receipt. */
export function AccessoryIcon({ item, className }: { item: Accessory; className?: string }) {
  const id = `icon${useId().replace(/[^\w-]/g, '')}`
  const art = (() => {
    switch (item) {
      case 'band': return <Band id={id} l={-20} r={20} y={-2} sag={5} />
      case 'chalk': return <g transform="rotate(26)"><Chalk id={id} /></g>
      case 'patch': return <g transform="rotate(9)"><Patch id={id} /></g>
      case 'pin': return <g transform="rotate(-38)"><Pin id={id} /></g>
      case 'monocle': return <Monocle id={id} r={12} tail={[14, 26]} />
      case 'cushion': return <Cushion id={id} />
      case 'shuttle': return <Shuttle id={id} />
    }
  })()
  return (
    <svg className={className ?? 'accessory-icon'} viewBox={ICON_BOX[item]} aria-hidden="true" focusable="false">
      <Paints id={id} />
      {art}
    </svg>
  )
}
