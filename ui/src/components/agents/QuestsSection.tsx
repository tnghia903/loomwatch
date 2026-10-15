import { Check } from 'lucide-react'

import { figureStill, type FigureKind } from '../../lib/library/figures'
import { AREA_NAMES, isAccessory, QUESTS, type Quest } from '../../lib/quests/catalog'
import { useWardrobe, type EarnedItem, type Wardrobe } from '../../lib/quests/wardrobe'
import { AccessoryIcon } from './AccessoryArt'

function earnedOn(entry: EarnedItem): string {
  const at = new Date(entry.at)
  return Number.isNaN(at.getTime()) ? 'Earned' : `Earned ${at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
}

function QuestArt({ quest, earned }: { quest: Quest; earned: boolean }) {
  return (
    <span className={`quest-art${earned ? '' : ' locked'}`}>
      {isAccessory(quest.item)
        ? <AccessoryIcon item={quest.item} locked={!earned} />
        : <img src={figureStill({ kind: quest.item as FigureKind, color: 'lilac' })} alt="" width={48} height={48} loading="lazy" decoding="async" />}
    </span>
  )
}

/**
 * The quests (docs/QUESTS.md), on Your agents: each teaches one practice of building agents and
 * agent teams. Nothing here is a task to tick: LoomWatch notices the practice in a real run, and
 * that run's receipt says what you did and why it works. This list says what is left to try.
 */
export function QuestsSection({ wardrobe: given }: { wardrobe?: Wardrobe }) {
  const read = useWardrobe()
  const wardrobe = given ?? read.wardrobe
  const done = QUESTS.filter((quest) => wardrobe[quest.item]).length
  return (
    <section className="agents-quests" aria-labelledby="quests-title">
      <div className="home-teams-head">
        <h2 id="quests-title">Quests</h2>
        <span className="t-meta">{done} of {QUESTS.length} earned</span>
      </div>
      <p className="agents-quests-intro">Each quest is one practice for building good agents. You don’t tick anything: when a run shows the practice, its receipt names it, says why it works, and adds an item to the wardrobe every agent shares.</p>
      <ul className="agents-quests-list">
        {QUESTS.map((quest) => {
          const entry = wardrobe[quest.item]
          return (
            <li key={quest.item} className={entry ? 'earned' : ''}>
              <QuestArt quest={quest} earned={Boolean(entry)} />
              <div>
                <p className="agents-quest-name">
                  <b>{quest.practice}</b>
                  <span className="t-meta">{quest.area === 'all' ? 'All five parts' : AREA_NAMES[quest.area]} · {quest.reward === 'figure' ? `the ${quest.name} figure` : quest.name}</span>
                </p>
                <p className="agents-quest-text">{entry ? quest.teach : <>Try this: {quest.hint}</>}</p>
                {quest.source && <a className="link agents-quest-source" href={quest.source.url} target="_blank" rel="noreferrer">From {quest.source.name}</a>}
              </div>
              <span className="agents-quest-state">{entry ? <><Check size={13} aria-hidden="true" />{earnedOn(entry)}</> : 'Not yet'}</span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
