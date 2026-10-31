import { ArrowRight, Check, Lock } from '../ui/icon'

import { figureStill, type FigureKind } from '../../lib/library/figures'
import { AREA_NAMES, AREAS, isAccessory, isGarment, QUESTS, type Quest } from '../../lib/quests/catalog'
import { partsDone, useWardrobe, type EarnedItem, type Wardrobe } from '../../lib/quests/wardrobe'
import { historyRunUrl } from '../../lib/runs/history'
import { AccessoryIcon } from '../agents/AccessoryArt'
import { SectionHead } from '../ui/SectionHead'

function earnedDate(entry: EarnedItem): string {
  const at = new Date(entry.at)
  return Number.isNaN(at.getTime()) ? 'Earned' : `Earned ${at.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`
}

/**
 * Quests (`/quests`): every set of clothes, accessory and figure your runs can earn, what you have, and what is left.
 * It is where you find out that LoomWatch has quests at all. Like the rest of the app it configures
 * rather than teaches (docs/QUESTS.md): each quest says what to try and how a run earns it, and once
 * earned, why the practice works in one sentence. Nothing here is a task to tick.
 */
export function QuestsPage({ wardrobe: given }: { wardrobe?: Wardrobe } = {}) {
  const read = useWardrobe()
  const wardrobe = given ?? read.wardrobe
  const done = QUESTS.filter((quest) => wardrobe[quest.item]).length
  const clothes = QUESTS.filter((quest) => quest.reward === 'accessory' && isGarment(quest.item))
  const accessories = QUESTS.filter((quest) => quest.reward === 'accessory' && !isGarment(quest.item))
  const figures = QUESTS.filter((quest) => quest.reward === 'figure')
  return (
    <div className="lw-home lw-quests">
      <div className="ground" aria-hidden="true" />
      <main className="home-main quests-main">
        <section className="home-hero quests-hero">
          <SectionHead page as="h1" className="t-display" title="Quests" explain={<>
            <p>Your runs earn clothes, accessories and figures for your agents. Each quest is one good practice: try it on work you wanted done anyway, and the receipt of the run that shows it says what it earned. Everything goes into one wardrobe all your agents share.</p>
            <p>Only a run that finishes can earn, judged by what LoomWatch recorded, never by what an agent says about itself. Running more earns nothing.</p>
          </>} />
          <div className="quests-progress" role="group" aria-label="Your progress">
            <span className="quests-progress-count"><b>{done}</b> of {QUESTS.length} earned</span>
            <span className="quests-progress-pips" aria-hidden="true">{QUESTS.map((quest) => <i key={quest.item} className={wardrobe[quest.item] ? 'on' : ''} />)}</span>
          </div>
        </section>

        <QuestGroup id="quests-clothes" title="Clothes" says="Any of your agents can wear one set at a time" quests={clothes} wardrobe={wardrobe} />
        <QuestGroup id="quests-accessories" title="Accessories" says="Any of your agents can wear them" quests={accessories} wardrobe={wardrobe} />
        <QuestGroup id="quests-figures" title="Figures" says="Any of your agents can be one" quests={figures} wardrobe={wardrobe} />

        <p className="quests-wear">
          Put on what you’ve earned in an agent’s figure, beside its ID card in My agents.
          <a className="link" href="/agents">Open My agents<ArrowRight size={14} aria-hidden="true" /></a>
        </p>
      </main>
    </div>
  )
}

function QuestGroup({ id, title, says, quests, wardrobe }: { id: string; title: string; says: string; quests: readonly Quest[]; wardrobe: Wardrobe }) {
  return (
    <section className="home-teams" aria-labelledby={id}>
      <div className="home-teams-head"><h2 id={id}>{title}<span className="home-section-says">{says}</span></h2></div>
      <ul className="quests-grid">
        {quests.map((quest) => <QuestCard key={quest.item} quest={quest} entry={wardrobe[quest.item]} wardrobe={wardrobe} />)}
      </ul>
    </section>
  )
}

function QuestCard({ quest, entry, wardrobe }: { quest: Quest; entry: EarnedItem | undefined; wardrobe: Wardrobe }) {
  const earned = Boolean(entry)
  const parts = quest.area === 'all' ? partsDone(wardrobe) : null
  return (
    <li className={`quest-card${earned ? ' earned' : ''}`}>
      <span className={`quest-art ${quest.reward}${earned ? '' : ' locked'}`}>
        {isAccessory(quest.item)
          ? <AccessoryIcon item={quest.item} locked={!earned} />
          : <img src={figureStill({ kind: quest.item as FigureKind, color: 'lilac' })} alt="" width={64} height={64} loading="lazy" decoding="async" />}
      </span>
      <div className="quest-body">
        <p className="quest-name">
          <b>{quest.name}</b>
          <span className="quest-state">{earned ? <><Check size={12} aria-hidden="true" />{earnedDate(entry as EarnedItem)}</> : <><Lock size={11} aria-hidden="true" />Not yet</>}</span>
        </p>
        <p className="quest-practice">{quest.area === 'all' ? 'All five parts' : AREA_NAMES[quest.area]} · {quest.practice}</p>
        {earned
          ? <p className="quest-text">{quest.why}</p>
          : <p className="quest-text"><span className="quest-label">Try</span>{quest.hint}</p>}
        {!earned && <p className="quest-when"><span className="quest-label">Earned when</span>{quest.earnedWhen}</p>}
        {parts && !earned && (
          <ul className="quest-parts" aria-label={`${parts.size} of ${AREAS.length} parts so far`}>
            {AREAS.map((area) => <li key={area} className={parts.has(area) ? 'on' : ''}>{parts.has(area) && <Check size={11} aria-hidden="true" />}{AREA_NAMES[area]}</li>)}
          </ul>
        )}
        {entry?.teamPath && <a className="link quest-run" href={historyRunUrl({ id: entry.runId, teamPath: entry.teamPath })}>See the run that earned it<ArrowRight size={12} aria-hidden="true" /></a>}
      </div>
    </li>
  )
}
