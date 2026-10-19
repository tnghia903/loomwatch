import { describe, expect, it } from 'vitest'

import { DOCUMENT_CHARS, describeDocument, documentSize, isDocument } from './document'

describe('a team’s answer as a message or a document', () => {
  it('keeps a short reply a message, and makes a long or titled one a document', () => {
    expect(isDocument('Done — I tightened the lead.')).toBe(false)
    expect(isDocument('x'.repeat(DOCUMENT_CHARS + 1))).toBe(true)
    expect(isDocument(`# Today’s AI digest\n\n${'A story. '.repeat(35)}`)).toBe(true)
    expect(isDocument(`Here it is.\n\n## Findings\n${'One finding. '.repeat(25)}`)).toBe(true)
    // "# Done" and a line is still a message.
    expect(isDocument('# Done\n\nI updated the file.')).toBe(false)
    // A third-level heading inside a short reply is formatting, not a document.
    expect(isDocument('### Note\nShort.')).toBe(false)
  })

  it('reads its title, opening words and size from its own text', () => {
    const facts = describeDocument('# Today’s AI digest\n\n**Lead:** chipmakers rally on the [export rule](https://example.com).\n\n## Chips\n- Shares up.\n\n| a | b |\n|---|---|\n\n## Models\nAn open model.')
    expect(facts.title).toBe('Today’s AI digest')
    expect(facts.preview).toBe('Lead: chipmakers rally on the export rule. Shares up. An open model.')
    expect(facts.sections).toBe(2)
    expect(documentSize(facts)).toBe(`${facts.words} words · 2 sections`)
  })

  it('opens its preview on its words, without a section heading or a claim mark', () => {
    const facts = describeDocument('# Enterprise RAG: production engineering brief\n\n## Retrieval Architecture\n\n[ Sourced ] Chunk boundaries affect retrieval quality.\n\n- **[Inference]** Rerank a bounded set.')
    expect(facts.preview).toBe('Chunk boundaries affect retrieval quality. Rerank a bounded set.')
    // A placeholder in brackets is the writer's text, not a mark.
    expect(describeDocument('# Letter\n\n[Your name] signs here.').preview).toBe('[Your name] signs here.')
    // Headings alone are still something to show.
    expect(describeDocument('# Plan\n\n## Gather\n## Check').preview).toBe('Gather Check')
  })

  it('takes the first line as the title when there is no heading, and cuts the preview at a word', () => {
    const facts = describeDocument(`Here is the brief you asked for.\n${'The market moved again today. '.repeat(20)}`, 60)
    expect(facts.title).toBe('Here is the brief you asked for.')
    expect(facts.preview).toBe('The market moved again today. The market moved again today…')
    expect(facts.sections).toBe(0)
    expect(documentSize({ words: 1240, sections: 0 })).toBe('1,240 words')
  })

  it('keeps underscores in file names', () => {
    expect(describeDocument('# Files\n\nSaved q3_sales.md and `q3_churn.md`.').preview).toBe('Saved q3_sales.md and q3_churn.md.')
  })
})
