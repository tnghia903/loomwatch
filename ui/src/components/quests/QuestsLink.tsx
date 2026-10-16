import { Award } from 'lucide-react'

import { QUESTS } from '../../lib/quests/catalog'
import { useWardrobe } from '../../lib/quests/wardrobe'

/**
 * The way to the Quests page from the top bar, with how many are earned: a pill beside Feedback, so
 * someone who never opened an agent's figure still finds out that runs earn accessories and figures.
 */
export function QuestsLink() {
  const { wardrobe, loaded } = useWardrobe()
  const done = QUESTS.filter((quest) => wardrobe[quest.item]).length
  return (
    <a className="home-feedback quests-link" href="/quests" title="Accessories and figures your runs earn">
      <Award size={15} aria-hidden="true" />
      <span className="home-feedback-label">Quests</span>
      {loaded && <span className="quests-link-count" aria-label={`${done} of ${QUESTS.length} earned`}>{done}/{QUESTS.length}</span>}
    </a>
  )
}
