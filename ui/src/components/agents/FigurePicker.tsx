import { useId } from 'react'
import { ArrowRight, Lock } from '../ui/icon'

import { colorSwatch, COLOR_NAMES, FIGURE_COLORS, FIGURE_KINDS, FIGURE_NAMES, figureStill, STARTER_COLORS, wornBy, type FigureChoice, type FigureColor } from '../../lib/library/figures'
import { ACCESSORIES, GARMENTS, isGarment, QUESTS, questFor, type Accessory } from '../../lib/quests/catalog'
import { useWardrobe, type Wardrobe } from '../../lib/quests/wardrobe'
import { IN_CHAT } from '../../lib/library/accessorySpots'
import { AccessoryIcon } from './AccessoryArt'

const starter = (color: FigureColor) => (STARTER_COLORS as readonly string[]).includes(color)
const TRIMMINGS = ACCESSORIES.filter((item) => !isGarment(item))

/**
 * Its figure: which of the crew it is (its shape), in what colour, what it wears (one set of
 * clothes, and any accessories), so you can tell your agents apart at a glance in Your agents. It sits beside the ID card, not on
 * the workbench: the bench is where the agent is built, and its figure is only how it looks. Teams
 * never copy it, so changing it never makes a new version.
 *
 * The accessories come from one wardrobe shared by every agent (docs/QUESTS.md): an item earned on
 * any run is there for all of them. One not earned yet stays in view as a silhouette with its hint,
 * and the Quests page lists every item and how it is earned.
 */
export function FigurePicker({ figure, onChange, wardrobe: given }: { figure: FigureChoice; onChange: (figure: FigureChoice) => void; wardrobe?: Wardrobe }) {
  const name = useId()
  const read = useWardrobe()
  const wardrobe = given ?? read.wardrobe
  const has = (item: string) => Boolean(wardrobe[item as keyof Wardrobe])
  const wearing = wornBy(figure)
  const earnedClothes = GARMENTS.filter(has).length
  const earnedAccessories = TRIMMINGS.filter(has).length
  const earnedQuests = QUESTS.filter((quest) => has(quest.item)).length
  // Clothes are worn one at a time: putting one on takes off the other.
  const toggle = (item: Accessory) => {
    if (wearing.includes(item)) return onChange({ ...figure, wear: wearing.filter((worn) => worn !== item) })
    const kept = wearing.filter((worn) => !(isGarment(item) && isGarment(worn)))
    onChange({ ...figure, wear: ACCESSORIES.filter((one) => one === item || kept.includes(one)) })
  }
  const wardrobeItems = (items: readonly Accessory[]) => items.map((item) => {
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
        <button type="button" className="figure-wardrobe-item" aria-pressed={on} onClick={() => toggle(item)} title={quest.why}>
          <AccessoryIcon item={item} />
          <span><span className="figure-wardrobe-name">{quest.name}</span><span className="figure-wardrobe-note">{on ? 'Wearing' : 'Wear it'} · {quest.practice}{IN_CHAT.has(item) ? '' : ' · not in the chat picture'}</span></span>
        </button>
      </li>
    )
  })
  return (
    <section className="agent-section figure-picker" aria-labelledby={`${name}-title`}>
      <header className="figure-picker-head">
        <h2 id={`${name}-title`} className="agent-section-head">Its figure</h2>
        <a className="link figure-picker-quests" href="/quests">Quests · {earnedQuests} of {QUESTS.length} earned<ArrowRight size={13} aria-hidden="true" /></a>
      </header>
      <fieldset className="figure-picker-part">
        <legend>Shape</legend>
        <div className="figure-picker-kinds">
          {FIGURE_KINDS.map((kind) => (
            <label key={kind} className="figure-picker-kind" title={FIGURE_NAMES[kind]}>
              <input type="radio" className="visually-hidden" name={`${name}-kind`} checked={figure.kind === kind} onChange={() => onChange({ ...figure, kind })} />
              <img src={figureStill({ kind, color: figure.color })} alt="" width={56} height={56} loading="lazy" decoding="async" />
              <span>{FIGURE_NAMES[kind]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="figure-picker-part">
        <legend>Color</legend>
        <div className="figure-picker-colors">
          {FIGURE_COLORS.map((color) => {
            // Plum and sunset are earned on quests; once earned, any build can be one.
            const open = starter(color) || has(color) || figure.color === color
            const quest = questFor(color)
            return (
              <label key={color} className={`figure-picker-color${open ? '' : ' locked'}`} title={open ? COLOR_NAMES[color] : `Locked. ${quest?.hint ?? ''}`}>
                <input type="radio" className="visually-hidden" name={`${name}-color`} checked={figure.color === color} disabled={!open} onChange={() => onChange({ ...figure, color })} />
                <span style={{ background: colorSwatch(color) }} aria-hidden="true" />
                <span className="visually-hidden">{COLOR_NAMES[color]}{!open && <>, locked: {quest?.hint}</>}</span>
                {!open && <Lock className="figure-picker-lock" size={11} aria-hidden="true" />}
              </label>
            )
          })}
        </div>
      </fieldset>
      <div className="figure-picker-part">
        <div className="figure-picker-part-head">
          <b id={`${name}-clothes`}>Clothes</b>
          <span className="t-meta">{earnedClothes === 0 ? 'One at a time. A run that shows one good practice earns each one.' : `${earnedClothes} of ${GARMENTS.length} earned, one at a time`}</span>
        </div>
        <ul className="figure-wardrobe-items" role="group" aria-labelledby={`${name}-clothes`}>
          {wardrobeItems(GARMENTS)}
        </ul>
      </div>
      <div className="figure-picker-part">
        <div className="figure-picker-part-head">
          <b id={`${name}-accessories`}>Accessories</b>
          <span className="t-meta">{earnedAccessories === 0 ? 'Shared by all your agents. A run that shows one good practice earns each one.' : `${earnedAccessories} of ${TRIMMINGS.length} earned, shared by all your agents`}{wearing.length > 0 ? ` · wearing ${wearing.length}` : ''}</span>
        </div>
        <ul className="figure-wardrobe-items" role="group" aria-labelledby={`${name}-accessories`}>
          {wardrobeItems(TRIMMINGS)}
        </ul>
      </div>
    </section>
  )
}
