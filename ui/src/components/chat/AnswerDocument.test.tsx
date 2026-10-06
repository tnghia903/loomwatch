import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { AnswerDocument } from './AnswerDocument'

afterEach(cleanup)

describe('a document answer, read beside the chat', () => {
  it('is read in full, as written, and never runs HTML or loads remote images', async () => {
    const { container } = render(<AnswerDocument by="Writer" streaming={false} text={'# Market report\n\n| Finding | Impact |\n|---|---|\n| Clear | Faster |\n\n<script>alert(1)</script>\n\n![tracking](https://example.com/pixel)'} />)
    expect(await screen.findByRole('heading', { name: 'Market report', level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByText('Written by Writer')).toBeInTheDocument()
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('[Image: tracking]')).toBeInTheDocument()
  })

  it('says it is still being written', () => {
    render(<AnswerDocument by="Writer" streaming text="# Draft" />)
    expect(screen.getByText('Writer is writing this')).toBeInTheDocument()
    expect(screen.getByLabelText('Being written')).toBeInTheDocument()
  })
})
