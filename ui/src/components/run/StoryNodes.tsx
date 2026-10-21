import type { NodeProps } from '@xyflow/react'

import { CardPorts } from '../canvas/CardPorts'

import type { PromptNode } from '../../lib/runs/graph'
import { EntityGlyph } from '../ui/glyphs'
import { useCanvasActions } from '../canvas/CanvasActionsContext'

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

// TNG89 §12.2 / §15.2.2: the Prompt is the Workflow canvas's first node. It is the composer's
// draft: the text mirrors in as the operator types and a click focuses the composer, so there is
// one editor seen in two places and never two editors.
export function PromptNodeCard({ data }: NodeProps<PromptNode>) {
  const { focusComposer } = useCanvasActions()
  return (
    <button
      type="button"
      className={cx('rt story-prompt story-draft nodrag', !data.text && 'empty')}
      aria-label="Prompt, your draft. Click to focus the composer."
      onClick={() => focusComposer?.()}
    >
      <span className="rt-head t-micro">
        <EntityGlyph kind="prompt" /> Prompt · your draft
        <span className="spacer" />
        <span className="t-meta prompt-draft-hint">Click to type</span>
      </span>
      <span className={cx('rt-body t-body', !data.text && 'empty')}>{data.text || 'Your prompt appears here as you type it in the composer.'}</span>
      <CardPorts input={false} />
    </button>
  )
}
