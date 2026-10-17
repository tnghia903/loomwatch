import {
  AudioLines, BookOpenText, CalendarDays, ChartColumn, CircleCheck, Clapperboard, Code, Database, FilePen, FileText, FlaskConical, Globe, Image,
  Info, Languages, Lock, Mail, Megaphone, NotebookPen, OctagonX, Palette, PenLine, Presentation, Receipt, Scale, Sheet, ShieldCheck, Telescope,
  type LucideIcon,
} from 'lucide-react'
import { useState, type CSSProperties, type ReactNode } from 'react'

import { glyphColor, needLabel, RUNTIME_LABEL, topicOf, type Notice, type Publisher, type Runtime, type SkillTopic } from '../../lib/library/skillStore'

const TOPIC_ICON: Record<SkillTopic, LucideIcon> = {
  pdf: FileText,
  doc: FilePen,
  sheet: Sheet,
  slides: Presentation,
  meeting: NotebookPen,
  email: Mail,
  research: Telescope,
  data: ChartColumn,
  marketing: Megaphone,
  design: Palette,
  image: Image,
  video: Clapperboard,
  audio: AudioLines,
  translate: Languages,
  calendar: CalendarDays,
  finance: Receipt,
  legal: Scale,
  security: ShieldCheck,
  database: Database,
  test: FlaskConical,
  code: Code,
  web: Globe,
  writing: PenLine,
}

/** A topic's icon; a skill whose topic can't be told is a book of instructions, which it is. */
export function TopicIcon({ topic, size = 18 }: { topic: SkillTopic | null; size?: number }) {
  const Icon = topic ? TOPIC_ICON[topic] : BookOpenText
  return <Icon size={size} aria-hidden="true" />
}

const GLYPH_ICON_SIZE = { sm: 14, md: 18, lg: 24 }

/**
 * A skill's mark: the icon of what it is about, on that topic's colour, so every PDF skill looks
 * like one at a glance. Skills don't come with logos of their own; this is told from their name
 * and description.
 */
export function Glyph({ name, description = '', size = 'md' }: { name: string; description?: string; size?: 'sm' | 'md' | 'lg' }) {
  const topic = topicOf(name, description)
  return (
    <span className={`lw-skills-glyph ${size}`} style={{ '--glyph': glyphColor(topic ?? name) } as CSSProperties} aria-hidden="true">
      <TopicIcon topic={topic} size={GLYPH_ICON_SIZE[size]} />
    </span>
  )
}

/** "by anthropics", with the publisher's picture when LoomWatch has one. */
export function By({ publisher }: { publisher: Publisher }) {
  const [missing, setMissing] = useState(false)
  return (
    <span className="lw-skills-by">
      {publisher.avatar && !missing && <img src={publisher.avatar} alt="" width={16} height={16} loading="lazy" decoding="async" onError={() => setMissing(true)} />}
      by {publisher.name}
    </span>
  )
}

/** What a skill needs to run and what its instructions assume, as small labels. */
export function NeedTags({ runtimes, needs, hasScripts }: { runtimes: Runtime[]; needs: string[]; hasScripts: boolean }) {
  // "Needs Python" already says it runs scripts; the need of the same name would say it twice.
  const shown = needs.filter((need) => need !== 'scripts' || !hasScripts)
  if (runtimes.length === 0 && shown.length === 0) return null
  return (
    <span className="lw-skills-tags">
      {runtimes.map((runtime) => <span key={runtime} className="lw-skills-tag needs" title={RUNTIME_LABEL[runtime].hint}>{RUNTIME_LABEL[runtime].label}</span>)}
      {shown.map((need) => <span key={need} className="lw-skills-tag">{needLabel(need)}</span>)}
    </span>
  )
}

const NOTICE_ICON = { ok: CircleCheck, note: Info, stop: OctagonX }

/** What to know before adding, one line each, marked fine, worth reading, or in the way. */
export function Notices({ notices }: { notices: Notice[] }) {
  return (
    <ul className="lw-skills-notices" aria-label="What to know">
      {notices.map((notice) => {
        const Icon = NOTICE_ICON[notice.tone]
        return <li key={notice.text} className={notice.tone}><Icon size={15} aria-hidden="true" /><span>{notice.text}</span></li>
      })}
    </ul>
  )
}

/** One row's tick box, in the house `.check` style; its text is the box's name. */
export function Tick({ checked, disabled = false, onToggle, children }: { checked: boolean; disabled?: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} disabled={disabled} className={`check ${checked ? 'on' : ''}`} onClick={onToggle}>
      <span className="box">{checked && <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>}</span>
      <span className="txt">{children}</span>
    </button>
  )
}

/** Why a row can't be ticked, beside its lock. */
export function Locked({ children }: { children: ReactNode }) {
  return <p className="lw-skills-locked"><Lock size={12} aria-hidden="true" />{children}</p>
}
