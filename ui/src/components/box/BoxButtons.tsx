import { keys } from '../../lib/platform'
import { Icon } from '../ui/icon'

/**
 * Every box's send (round 3, ADR 0101): one icon-only button, named for what it does. Work that
 * starts goes with the send arrow; a note or a reply is entered. It is the screen's gold fill only
 * where the box is that screen's main action, and never while it can't be pressed.
 */
export function SendButton({ label, icon = 'send', primary = false, disabled, title, className, onClick }: {
  /** What pressing it does, said to screen readers and in its tooltip: Start, Send, Reply, Send note. */
  label: string
  icon?: 'send' | 'enter'
  primary?: boolean
  disabled?: boolean
  /** Why it waits (files still saving); otherwise its name and key. */
  title?: string
  /** Where its box places it. */
  className?: string
  /** A send that isn't the form's submit. */
  onClick?: () => void
}) {
  return (
    <button
      type={onClick ? 'button' : 'submit'}
      className={['lw-send', primary ? 'primary' : '', className ?? ''].filter(Boolean).join(' ')}
      aria-label={label}
      title={title ?? `${label} (${keys('↵')})`}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon === 'enter' ? 'enter' : 'send'} size={18} />
    </button>
  )
}

/** Every box's attach: the same clip, in the same place before the send. */
export function AttachButton({ onClick, disabled, className }: { onClick: () => void; disabled?: boolean; className?: string }) {
  return (
    <button type="button" className={['lw-attach', className ?? ''].filter(Boolean).join(' ')} disabled={disabled} onClick={onClick} aria-label="Add pictures or files" title="Add pictures or files">
      <Icon name="attach" size={18} />
    </button>
  )
}
