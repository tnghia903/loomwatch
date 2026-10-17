import { Link2, Search } from 'lucide-react'

import { looksLikeLink, SKILL_TOPICS } from '../../lib/library/skillStore'
import { TopicIcon } from './SkillTags'

/**
 * The one way in: words search skills.sh and ClawHub together, and a pasted link (GitHub,
 * skills.sh, ClawHub) is looked inside straight away. Nobody has to know which site a skill is on.
 */
export function Finder({ text, onText, busy, onSearch, onOpenLink }: {
  text: string
  onText: (value: string) => void
  busy: boolean
  onSearch: (query: string) => void
  onOpenLink: (link: string) => void
}) {
  const link = looksLikeLink(text)
  const submit = () => {
    const value = text.trim()
    if (!value) return
    if (link) onOpenLink(value)
    else onSearch(value)
  }
  return (
    <div className="lw-skills-finder">
      <form role="search" className="lw-skills-search" onSubmit={(event) => { event.preventDefault(); submit() }}>
        {link ? <Link2 size={18} aria-hidden="true" /> : <Search size={18} aria-hidden="true" />}
        <input
          type="search"
          aria-label="Find skills"
          value={text}
          maxLength={500}
          spellCheck={false}
          autoComplete="off"
          placeholder="What should your agents learn?"
          onChange={(event) => onText(event.target.value)}
        />
        <button className="btn btn-primary" disabled={busy || !text.trim()}>{link ? 'Look inside' : 'Search'}</button>
      </form>
      <p className="lw-skills-hint">{link
        ? 'That’s a link. LoomWatch will download it and show you what’s inside before anything is added.'
        : 'Searches skills.sh and ClawHub, where people share skills. You can also paste a link from GitHub.'}</p>
    </div>
  )
}

/** Where to start when you don't know what to search for. */
export function Topics({ onPick }: { onPick: (query: string) => void }) {
  return (
    <section className="lw-skills-topics" aria-labelledby="skills-topics-heading">
      <h2 id="skills-topics-heading" className="lw-skills-label">Start with a topic</h2>
      <ul>
        {SKILL_TOPICS.map((topic) => (
          <li key={topic.query}><button type="button" className="lw-skills-topic" onClick={() => onPick(topic.query)}><TopicIcon topic={topic.topic} /><span>{topic.label}</span></button></li>
        ))}
      </ul>
    </section>
  )
}
