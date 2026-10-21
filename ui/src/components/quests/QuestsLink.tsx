import { QUESTS } from '../../lib/quests/catalog'
import { useWardrobe } from '../../lib/quests/wardrobe'

/**
 * The way to the Quests page from Home's top bar, with how many are earned: a pill beside Skills,
 * so someone who never opened an agent's figure still finds out that runs earn accessories and figures.
 */
export function QuestsLink() {
  const { wardrobe, loaded } = useWardrobe()
  const done = QUESTS.filter((quest) => wardrobe[quest.item]).length
  return (
    <a className="home-pill quests-link" href="/quests" title="Accessories and figures your runs earn">
      Quests{' '}
      {loaded && <span className="quests-link-count" aria-label={`${done} of ${QUESTS.length} earned`}>{done}/{QUESTS.length}</span>}
    </a>
  )
}
