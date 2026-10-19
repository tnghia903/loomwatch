import { useMemo, useState, type CSSProperties } from 'react'

import { isNumberCell, parseTable, separatorOf } from '../../lib/files/table'

/**
 * How the reader draws a file's text (ADR 0077), one view per kind of file. Each is plain DOM text,
 * so any part of it can be marked, and line numbers and row numbers are drawn by CSS, so they are
 * never part of what is marked.
 */

/** Past this many lines, code waits behind "Show all". */
const LINES_SHOWN = 4_000

/** Code, data and plain text, line by line. Minified JSON is laid out first: one line of it is unreadable. */
export function CodeView({ text, language }: { text: string; language: string }) {
  const [all, setAll] = useState(false)
  const lines = useMemo(() => laidOut(text, language).replace(/\n$/, '').split('\n'), [text, language])
  const shown = all ? lines : lines.slice(0, LINES_SHOWN)
  return (
    <>
      <pre className={`rd-lines lang-${language}`} style={{ '--rd-gutter': `${String(shown.length).length + 1}ch` } as CSSProperties}>
        <code>{shown.map((line, index) => <span key={index} className="rd-line">{line}{'\n'}</span>)}</code>
      </pre>
      {lines.length > shown.length && (
        <button type="button" className="tc-link rd-more" onClick={() => setAll(true)}>Show all {lines.length.toLocaleString('en-US')} lines</button>
      )}
    </>
  )
}

function laidOut(text: string, language: string): string {
  if (language !== 'json') return text
  const trimmed = text.trim()
  if (trimmed.includes('\n') || trimmed.length < 160) return text
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    return text
  }
}

/** A CSV or TSV file as a spreadsheet: its first row as the header, numbers set right. */
export function TableView({ text, path }: { text: string; path: string }) {
  const table = useMemo(() => parseTable(text, separatorOf(path, text)), [text, path])
  if (table.rows.length === 0) return <p className="rd-empty">This table is empty.</p>
  const [head, ...body] = table.rows
  const pad = (cells: string[]) => [...cells, ...Array<string>(Math.max(0, table.columns - cells.length)).fill('')]
  return (
    <div className="rd-table-wrap">
      <table className="rd-table">
        <thead><tr><th className="rd-row-n" aria-hidden="true" />{pad(head).map((cell, index) => <th key={index} scope="col">{cell}</th>)}</tr></thead>
        <tbody>
          {body.map((cells, row) => (
            <tr key={row}>
              <td className="rd-row-n" aria-hidden="true" />
              {pad(cells).map((cell, index) => <td key={index} className={isNumberCell(cell) ? 'num' : undefined}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {table.more && <p className="rd-note">The first {table.rows.length.toLocaleString('en-US')} rows are shown. Open it in its own app for the rest.</p>}
    </div>
  )
}

/**
 * A PDF's, Word, Excel or PowerPoint file's words, as the agents read them: paragraphs as they
 * came, and runs of tab-separated lines (a sheet, a table) as tables.
 */
export function DocumentView({ text }: { text: string }) {
  const blocks = useMemo(() => text.replace(/\r\n?/g, '\n').split(/\n{2,}/).map((block) => block.replace(/^\n+|\n+$/g, '')).filter((block) => block.trim() !== ''), [text])
  return (
    <>
      {blocks.map((block, index) => {
        const lines = block.split('\n')
        if (lines.length > 1 && lines.filter((line) => line.includes('\t')).length >= lines.length - 1) {
          return (
            <div key={index} className="rd-table-wrap">
              <table className="rd-table compact">
                <tbody>{lines.map((line, row) => <tr key={row}>{line.split('\t').map((cell, cellIndex) => <td key={cellIndex} className={isNumberCell(cell) ? 'num' : undefined}>{cell}</td>)}</tr>)}</tbody>
              </table>
            </div>
          )
        }
        // A short line on its own reads as a heading, as a document's title or a slide's does.
        const heading = lines.length === 1 && block.length <= 80 && !/[.:;,]$/.test(block)
        return heading ? <h3 key={index} className="rd-doc-heading">{block}</h3> : <p key={index} className="rd-doc-paragraph">{block}</p>
      })}
    </>
  )
}
