import { useId } from 'react'
import { Lock } from 'lucide-react'

import { COLOR_HEX, COLOR_NAMES, FIGURE_COLORS, FIGURE_KINDS, FIGURE_NAMES, figureStill, STARTER_KINDS, wornBy, type FigureChoice, type FigureKind } from '../../lib/library/figures'
import { ACCESSORIES, questFor, type Accessory } from '../../lib/quests/catalog'
import { useWardrobe, type Wardrobe } from '../../lib/quests/wardrobe'
import { IN_CHAT } from '../../lib/library/accessorySpots'
import { AccessoryIcon } from './AccessoryArt'

const starter = (kind: FigureKind) => (STARTER_KINDS as readonly string[]).includes(kind)

/**
 * Its figure: which of the crew it is, in what colour, and what it wears from the wardrobe, so you
 * can tell your agents apart at a glance in Your agents. Teams never copy it, so changing it never
 * makes a new version.
 *
 * The wardrobe is shared by every agent (docs/QUESTS.md): an item earned on any run is there for
 * all of them. One not earned yet stays in view as a silhouette with its hint, so the picker is
 * also where you find out what to try next.
 */
export function FigurePicker({ figure, onChange, wardrobe: given }: { figure: FigureChoice; onChange: (figure: FigureChoice) => void; wardrobe?: Wardrobe }) {
  const name = useId()
  const read = useWardrobe()
  const wardrobe = given ?? read.wardrobe
  const has = (item: string) => Boolean(wardrobe[item as keyof Wardrobe])
  const wearing = wornBy(figure)
  const earnedCount = ACCESSORIES.filter(has).length
  const toggle = (item: Accessory) => onChange({ ...figure, wear: wearing.includes(item) ? wearing.filter((worn) => worn !== item) : ACCESSORIES.filter((one) => one === item || wearing.includes(one)) })
  return (
    <fieldset className="figure-picker">
      <legend>Its figure <span className="t-meta">how you tell it apart in Your agents</span></legend>
      <div className="figure-picker-kinds">
        {FIGURE_KINDS.map((kind) => {
          const open = starter(kind) || has(kind) || figure.kind === kind
          const quest = questFor(kind)
          return (
            <label key={kind} className={`figure-picker-kind${open ? '' : ' locked'}`} title={open ? FIGURE_NAMES[kind] : `Locked. ${quest?.hint ?? ''}`}>
              <input type="radio" className="visually-hidden" name={`${name}-kind`} checked={figure.kind === kind} disabled={!open} onChange={() => onChange({ ...figure, kind })} />
              <img src={figureStill({ kind, color: figure.color })} alt="" width={56} height={56} loading="lazy" decoding="async" />
              <span>{FIGURE_NAMES[kind]}{!open && <span className="visually-hidden">, locked: {quest?.hint}</span>}</span>
              {!open && <Lock className="figure-picker-lock" size={11} aria-hidden="true" />}
            </label>
          )
        })}
      </div>
      <div className="figure-picker-colors">
        {FIGURE_COLORS.map((color) => (
          <label key={color} className="figure-picker-color" title={COLOR_NAMES[color]}>
            <input type="radio" className="visually-hidden" name={`${name}-color`} checked={figure.color === color} onChange={() => onChange({ ...figure, color })} />
            <span style={{ background: COLOR_HEX[color] }} aria-hidden="true" />
            <span className="visually-hidden">{COLOR_NAMES[color]}</span>
          </label>
        ))}
      </div>
      <details className="figure-wardrobe">
        <summary className="figure-wardrobe-head">
          <b id={`${name}-wardrobe`}>Wardrobe</b>
          <span className="t-meta">{earnedCount === 0 ? 'Shared by all your agents. Each item is earned by a run that shows one good practice.' : `${earnedCount} of ${ACCESSORIES.length} earned, shared by all your agents`}{wearing.length > 0 ? ` · wearing ${wearing.length}` : ''}</span>
        </summary>
        <ul className="figure-wardrobe-items" role="group" aria-labelledby={`${name}-wardrobe`}>
          {ACCESSORIES.map((item) => {
            const quest = questFor(item)
            if (!quest) return null
            if (!has(item) && !wearing.includes(item)) {
              return (
                <li key={item} className="figure-wardrobe-item locked">
                  <AccessoryIcon item={item} locked />
                  <span><span className="figure-wardrobe-name">{quest.name}<span className="visually-hidden">, locked</span></span><span className="figure-wardrobe-note">Hint: {quest.hint}</span></span>
                </li>
              )
            }
            const on = wearing.includes(item)
            return (
              <li key={item}>
                <button type="button" className="figure-wardrobe-item" aria-pressed={on} onClick={() => toggle(item)} title={`${quest.practice}: ${quest.teach}`}>
                  <AccessoryIcon item={item} />
                  <span><span className="figure-wardrobe-name">{quest.name}</span><span className="figure-wardrobe-note">{on ? 'Wearing' : 'Wear it'} · {quest.practice}{IN_CHAT.has(item) ? '' : ' · not in the chat picture'}</span></span>
                </button>
              </li>
            )
          })}
        </ul>
      </details>
    </fieldset>
  )
}
