import { useEffect, useRef, useState } from 'react'

import { inputText, isPreset, presetState, readNumber, stillTyping, thousandsWithDots, valuesOf, workOut } from '../../../lib/widgets/calculator'
import type { WidgetInput, WidgetSpec, WidgetState } from '../../../lib/widgets/types'
import { Check, Minus, Plus } from '../../ui/icon'
import { LIVE } from './WidgetChoices'

type Calculator = Extract<WidgetSpec, { kind: 'calculator' }>

/** How long after your last change the calculator keeps its values, so typing a number sends once. */
const KEEP_AFTER_MS = 600

/** The inputs as they are drawn: a number or a switch on its own row, or a group's switches as one
    row of boxes to tap. */
type Row = { kind: 'one'; input: WidgetInput } | { kind: 'group'; name: string; inputs: WidgetInput[] }

function rowsOf(inputs: readonly WidgetInput[]): Row[] {
  const rows: Row[] = []
  for (const input of inputs) {
    const last = rows[rows.length - 1]
    if (input.group && input.on !== undefined && last?.kind === 'group' && last.name === input.group) last.inputs.push(input)
    else if (input.group && input.on !== undefined) rows.push({ kind: 'group', name: input.group, inputs: [input] })
    else rows.push({ kind: 'one', input })
  }
  return rows
}

/**
 * A calculator (ADR 0114): its results first, worked out by LoomWatch from its formulas each time
 * you change an input, each with a line saying why, or the sum when it is plain arithmetic; then its
 * inputs, a group's switches as one row of boxes; then buttons that set a case worth trying. What
 * you set is kept, and the next work reads it with the results. `disabled` while the answer is still
 * being written: it is drawn, and works once the answer is done.
 */
export function WidgetCalculator({ spec, state, onShow, onKeep, error, disabled = false }: { spec: Calculator; state?: WidgetState; onShow: (state: WidgetState) => void; onKeep: (state: WidgetState) => void; error: string | null; disabled?: boolean }) {
  const values = valuesOf(spec.inputs, state)
  const switches = new Set(spec.inputs.filter((input) => input.on !== undefined).map((input) => input.id))
  const results = workOut(spec.results, values, switches)
  const changed = state && 'values' in state ? state.values : {}
  // What you are typing in each box, until you leave it: a half-typed number isn't a value yet.
  const [typed, setTyped] = useState<Record<string, string>>({})
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef<WidgetState | null>(null)
  const keepRef = useRef(onKeep)
  useEffect(() => { keepRef.current = onKeep }, [onKeep])
  // Sent before the calculator goes, so a change made just before leaving the chat is kept.
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
    if (latest.current) keepRef.current(latest.current)
  }, [])

  const show = (next: WidgetState, now: boolean) => {
    onShow(next)
    latest.current = next
    if (timer.current) clearTimeout(timer.current)
    const send = () => {
      timer.current = null
      latest.current = null
      onKeep(next)
    }
    if (now) send()
    else timer.current = setTimeout(send, KEEP_AFTER_MS)
  }
  const set = (id: string, value: number | boolean, now = false) => show({ values: { ...changed, [id]: value } }, now)
  const fits = (input: WidgetInput, value: number) => (input.min === undefined || value >= input.min) && (input.max === undefined || value <= input.max)
  const presets = spec.presets ?? []

  const switchRow = (input: WidgetInput) => {
    const on = values[input.id] !== 0
    return (
      <label key={input.id} className="wg-input wg-switch">
        <span className="wg-input-label">{input.label}</span>
        <input type="checkbox" role="switch" className="wg-switch-input" checked={on} disabled={disabled} onChange={(event) => set(input.id, event.target.checked, true)} />
        <span className="wg-switch-track" aria-hidden="true"><i /></span>
      </label>
    )
  }

  const groupRow = (name: string, inputs: readonly WidgetInput[]) => (
    <div key={`group-${inputs[0]?.id ?? name}`} className="wg-input wg-group" role="group" aria-label={name}>
      <span className="wg-input-label">{name}</span>
      <div className="wg-boxes">
        {inputs.map((input) => {
          const on = values[input.id] !== 0
          return (
            <button key={input.id} type="button" className={`wg-box${on ? ' on' : ''}`} aria-pressed={on} disabled={disabled} onClick={() => set(input.id, !on, true)}>
              <span className="wg-box-mark" aria-hidden="true">{on ? <Check size={16} strokeWidth={2.5} /> : <span className="wg-box-empty" />}</span>
              <span className="wg-box-label">{input.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )

  const numberRow = (input: WidgetInput) => {
    const value = values[input.id]
    const text = typed[input.id] ?? inputText(value)
    const read = readNumber(text)
    // Still being typed ('', '-', '12.'): unfinished, not wrong, so never red.
    const invalid = !stillTyping(text) && (read === null || !fits(input, read))
    const note = invalid ? noteFor(input, text, value) : null
    const noteId = `wg-${input.id}-note`
    const stepBy = (sign: number) => {
      const step = input.step ?? 1
      const next = Math.min(input.max ?? Infinity, Math.max(input.min ?? -Infinity, value + sign * step))
      setTyped((current) => without(current, input.id))
      set(input.id, next, true)
    }
    return (
      <div key={input.id} className="wg-input">
        <label className="wg-input-label" htmlFor={`wg-${input.id}`}>{input.label}</label>
        <span className="wg-field">
          {input.step !== undefined && <button type="button" className="iconbtn wg-step-by" aria-label={`Less: ${input.label}`} disabled={disabled || (input.min !== undefined && value <= input.min)} onClick={() => stepBy(-1)}><Minus size={14} aria-hidden="true" /></button>}
          {input.prefix && <span className="wg-unit">{input.prefix}</span>}
          <input
            id={`wg-${input.id}`}
            inputMode="decimal"
            value={text}
            disabled={disabled}
            aria-invalid={invalid || undefined}
            aria-describedby={note ? noteId : undefined}
            onChange={(event) => {
              const written = event.target.value
              setTyped((current) => ({ ...current, [input.id]: written }))
              const number = readNumber(written)
              if (number !== null && fits(input, number)) set(input.id, number)
            }}
            onBlur={() => setTyped((current) => without(current, input.id))}
          />
          {input.unit && <span className="wg-unit">{input.unit}</span>}
          {input.step !== undefined && <button type="button" className="iconbtn wg-step-by" aria-label={`More: ${input.label}`} disabled={disabled || (input.max !== undefined && value >= input.max)} onClick={() => stepBy(1)}><Plus size={14} aria-hidden="true" /></button>}
        </span>
        {note && <span id={noteId} className="wg-input-note">{note}</span>}
      </div>
    )
  }

  return (
    <section className="wg wg-calculator" aria-label={spec.title} title={disabled ? LIVE : undefined}>
      <p className="wg-title">{spec.title}</p>
      <div className="wg-calc">
        <div className="wg-results" aria-live="polite">
          {results.map((result) => (
            <div key={result.label} className="wg-result">
              <span className="wg-result-label">{result.label}</span>
              <span className="wg-result-value">{result.text ?? '—'}</span>
              {result.text === null && <span className="wg-working wg-cant">Can’t be worked out with these numbers. Try changing one.</span>}
              {result.text !== null && (result.note ?? result.working) && <span className="wg-working">{result.note ?? result.working}</span>}
            </div>
          ))}
        </div>
        <div className="wg-inputs">
          {rowsOf(spec.inputs).map((row) => {
            if (row.kind === 'group') return groupRow(row.name, row.inputs)
            return row.input.on !== undefined ? switchRow(row.input) : numberRow(row.input)
          })}
        </div>
      </div>
      {presets.length > 0 && (
        <div className="wg-presets">
          {presets.map((preset) => {
            const current = isPreset(spec.inputs, state, preset.values)
            return (
              <button key={preset.label} type="button" className={`wg-preset${current ? ' on' : ''}`} aria-pressed={current} disabled={disabled} onClick={() => { setTyped({}); show(presetState(preset.values), true) }}>
                {current && <Check size={14} strokeWidth={2.5} aria-hidden="true" />}{preset.label}
              </button>
            )
          })}
        </div>
      )}
      {error && <p className="chat-failed" role="alert">{error}</p>}
    </section>
  )
}

function without(typed: Record<string, string>, id: string): Record<string, string> {
  const rest = { ...typed }
  delete rest[id]
  return rest
}

/** What a number box takes, said when what is typed isn't it, and what the results still use. */
function noteFor(input: WidgetInput, text: string, kept: number): string {
  const still = `Still worked out with ${inputText(kept)}.`
  if (thousandsWithDots(text)) return `Write thousands with a comma, like 60,000. ${still}`
  if (input.min !== undefined && input.max !== undefined) return `A number from ${inputText(input.min)} to ${inputText(input.max)}. ${still}`
  if (input.min !== undefined) return `A number of at least ${inputText(input.min)}. ${still}`
  if (input.max !== undefined) return `A number of at most ${inputText(input.max)}. ${still}`
  return `A number, like 60,000. ${still}`
}
