import { useId } from 'react'
import { ArrowRight, Lock } from 'lucide-react'

import { COLOR_HEX, COLOR_NAMES, FIGURE_COLORS, FIGURE_KINDS, FIGURE_NAMES, figureStill, STARTER_KINDS, wornBy, type FigureChoice, type FigureKind } from '../../lib/library/figures'
import { ACCESSORIES, QUESTS, questFor, type Accessory } from '../../lib/quests/catalog'
import { useWardrobe, type Wardrobe } from '../../lib/quests/wardrobe'
import { IN_CHAT } from '../../lib/library/accessorySpots'
import { AccessoryIcon } from './AccessoryArt'

const starter = (kind: FigureKind) => (STARTER_KINDS as readonly string[]).includes(kind)

/**
 * Its figure: which of the crew it is (its shape), in what colour, and which accessories it wears,
 * so you can tell your agents apart at a glance in Your agents. It sits beside the ID card, not on
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
  const earnedAccessories = ACCESSORIES.filter(has).length
  const earnedQuests = QUESTS.filter((quest) => has(quest.item)).length
  const toggle = (item: Accessory) => onChange({ ...figure, wear: wearing.includes(item) ? wearing.filter((worn) => worn !== item) : ACCESSORIES.filter((one) => one === item || wearing.includes(one)) })
  return (
    <section className="agent-section figure-picker" aria-labelledby={`${name}-title`}>
      <header className="figure-picker-head">
        <h2 id={`${name}-title`} className="agent-section-head">Its figure</h2>
        <a className="link figure-picker-quests" href="/quests">Quests · {earnedQuests} of {QUESTS.length} earned<ArrowRight size={13} aria-hidden="true" /></a>
      </header>
      <fieldset className="figure-picker-part">
        <legend>Shape</legend>
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
      </fieldset>
      <fieldset className="figure-picker-part">
        <legend>Color</legend>
        <div className="figure-picker-colors">
          {FIGURE_COLORS.map((color) => (
            <label key={color} className="figure-picker-color" title={COLOR_NAMES[color]}>
              <input type="radio" className="visually-hidden" name={`${name}-color`} checked={figure.color === color} onChange={() => onChange({ ...figure, color })} />
              <span style={{ background: COLOR_HEX[color] }} aria-hidden="true" />
              <span className="visually-hidden">{COLOR_NAMES[color]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="figure-picker-part">
        <div className="figure-picker-part-head">
          <b id={`${name}-accessories`}>Accessories</b>
          <span className="t-meta">{earnedAccessories === 0 ? 'Shared by all your agents. A run that shows one good practice earns each one.' : `${earnedAccessories} of ${ACCESSORIES.length} earned, shared by all your agents`}{wearing.length > 0 ? ` · wearing ${wearing.length}` : ''}</span>
        </div>
        <ul className="figure-wardrobe-items" role="group" aria-labelledby={`${name}-accessories`}>
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
                <button type="button" className="figure-wardrobe-item" aria-pressed={on} onClick={() => toggle(item)} title={quest.why}>
                  <AccessoryIcon item={item} />
                  <span><span className="figure-wardrobe-name">{quest.name}</span><span className="figure-wardrobe-note">{on ? 'Wearing' : 'Wear it'} · {quest.practice}{IN_CHAT.has(item) ? '' : ' · not in the chat picture'}</span></span>
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}
