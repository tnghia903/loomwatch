import { toldNothing, useYou } from '../../lib/you/client'

/**
 * What every agent is told about the person (ADR 0074), with the way to change it: one quiet line
 * wherever agents are listed (Home's My agents row, the My agents page).
 */
export function KnowYou() {
  const you = useYou()
  if (!you) return null
  const name = you.name?.trim()
  return (
    <p className="t-meta agents-know-you">
      {toldNothing(you)
        ? <>Your agents don’t know you yet. <a className="link" href="/you">Tell them about you</a></>
        : <>{name ? <>Your agents know you as <strong>{name}</strong>.</> : 'Your agents know about you.'} <a className="link" href="/you">Edit</a></>}
    </p>
  )
}
