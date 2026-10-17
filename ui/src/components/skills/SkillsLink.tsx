import { GraduationCap } from 'lucide-react'

/**
 * The way to the Skills page from the top bar, a pill beside Quests: where a newcomer adds what
 * their agents know how to do, or brings in what their other apps already have.
 */
export function SkillsLink() {
  return (
    <a className="home-feedback" href="/skills" title="Teach your agents a kind of work">
      <GraduationCap size={15} aria-hidden="true" />
      <span className="home-feedback-label">Skills</span>
    </a>
  )
}
