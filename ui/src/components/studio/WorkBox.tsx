import { ArrowUp, Paperclip, X } from 'lucide-react'
import { useRef, useState } from 'react'

import { useChatAttachments } from '../../lib/chat/attachments'
import { sendChatMessage } from '../../lib/chat/client'
import { newStartKey, RunApiError, TEAM_NEEDS_REVIEW, type RunRecord } from '../../lib/runs/client'
import { goToTeam } from '../../lib/team-file/teamPage'
import { teamHref } from '../../lib/team-file/teamHref'

/** A team the box can give work to, under its project on Home. */
export interface BoxTeam {
  path: string
  name: string
  project?: { id: string; name: string }
}

const LAST_KEY = 'loomwatch:work-box-team'

function lastTeam(): string | null {
  try { return window.localStorage.getItem(LAST_KEY) } catch { return null }
}

/**
 * Give a team work from where you are, as its chat's box does (ADR 0097): the words, any files, and
 * Send, which starts the work. With more than one team, "To" picks which, starting on the one you
 * last gave work to. Its Send is the screen's gold fill while nothing waits for you.
 */
export function WorkBox({ teams, primary, onSent }: { teams: readonly BoxTeam[]; primary: boolean; onSent?: (run: RunRecord | null) => void }) {
  const [chosen, setChosen] = useState<string | null>(() => lastTeam())
  const team = teams.find((candidate) => candidate.path === chosen) ?? teams[0] ?? null
  const attachments = useChatAttachments(team?.path ?? '')
  const chooser = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [said, setSaid] = useState<{ ok: boolean; words: string; team: BoxTeam } | null>(null)
  if (!team) return null
  // Under their projects when they have them; a team in none yet goes under "Other teams".
  const grouped = teams.some((candidate) => candidate.project)
  const projects = [...new Map(teams.map((candidate) => [candidate.project?.id ?? '', candidate.project?.name ?? 'Other teams'] as const)).entries()]
  const trimmed = text.trim()
  const choose = (path: string) => {
    setChosen(path)
    try { window.localStorage.setItem(LAST_KEY, path) } catch { /* the choice lasts this visit */ }
  }
  const send = async () => {
    if (!trimmed || sending || attachments.busy) return
    setSending(true)
    setSaid(null)
    try {
      const result = await sendChatMessage({ teamPath: team.path, text: trimmed, to: null, work: true, startKey: newStartKey(), files: attachments.kept })
      setText('')
      attachments.clear()
      setSaid({ ok: true, words: `${team.name} has it.`, team })
      onSent?.(result.run ?? null)
    } catch (caught) {
      // A team file nobody has looked at yet is checked in its chat first (ADR 0048), where the words wait.
      if (caught instanceof RunApiError && caught.code === TEAM_NEEDS_REVIEW) goToTeam(teamHref(team.path, 'chat'))
      else setSaid({ ok: false, words: caught instanceof Error ? caught.message : String(caught), team })
    } finally {
      setSending(false)
    }
  }
  return (
    <form className="work-box" aria-label="Give work" onSubmit={(event) => { event.preventDefault(); void send() }}>
      <div className="work-box-row">
        {teams.length > 1 && (
          <label className="work-box-to">
            <span>To</span>
            <select value={team.path} onChange={(event) => choose(event.target.value)}>
              {grouped
                ? projects.map(([id, name]) => (
                  <optgroup key={id} label={name}>
                    {teams.filter((candidate) => (candidate.project?.id ?? '') === id).map((candidate) => <option key={candidate.path} value={candidate.path}>{candidate.name}</option>)}
                  </optgroup>
                ))
                : teams.map((candidate) => <option key={candidate.path} value={candidate.path}>{candidate.name}</option>)}
            </select>
          </label>
        )}
        <label className="work-box-words">
          <span className="visually-hidden">What should {team.name} do next?</span>
          <input value={text} onChange={(event) => setText(event.target.value)} placeholder={teams.length > 1 ? 'What should they do next?' : `What should ${team.name} do next?`} maxLength={8000} />
        </label>
        <input ref={chooser} type="file" multiple hidden tabIndex={-1} aria-hidden="true" onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ''
          if (files.length > 0) attachments.add(files)
        }} />
        <button type="button" className="iconbtn work-box-attach" onClick={() => chooser.current?.click()} aria-label="Add pictures or files" title="Add pictures or files"><Paperclip size={16} aria-hidden="true" /></button>
        <button type="submit" className={`btn${primary ? ' btn-primary' : ''} work-box-send`} disabled={!trimmed || sending || attachments.busy} title={attachments.busy ? 'Waits for your files' : undefined}>
          <ArrowUp size={15} aria-hidden="true" />{sending ? 'Sending…' : 'Send'}
        </button>
      </div>
      {attachments.items.length > 0 && (
        <ul className="work-box-files" aria-label="Files going with it">
          {attachments.items.map((item) => (
            <li key={item.id} className={item.problem ? 'failed' : undefined} title={item.problem ?? undefined}>
              <span>{item.name}</span>{item.state === 'uploading' && <small>saving…</small>}{item.problem && <small>{item.problem}</small>}
              <button type="button" className="iconbtn" onClick={() => attachments.remove(item.id)} aria-label={`Remove ${item.name}`}><X size={12} aria-hidden="true" /></button>
            </li>
          ))}
        </ul>
      )}
      {said && (
        <p className={`work-box-said${said.ok ? '' : ' alert'}`} role={said.ok ? 'status' : 'alert'}>
          {said.words} <a className="link" href={teamHref(said.team.path, 'chat')}>Open its chat</a>
        </p>
      )}
    </form>
  )
}
