/**
 * Widgets under an answer (ADR 0114), as the daemon keeps them (`crates/loomwatch-backend/src/
 * widgets/mod.rs`): what the agent showed, checked, and what you last made of it.
 */

export interface WidgetChoice { label: string; detail?: string }
export interface WidgetItem { text: string; note?: string }

/** A calculator's input: a number (`start`) or a switch (`on`). */
export interface WidgetInput {
  id: string
  label: string
  start?: number
  on?: boolean
  unit?: string
  prefix?: string
  min?: number
  max?: number
  step?: number
}

/** A calculator's result: a figure LoomWatch works out from its formula. */
export interface WidgetFigure {
  id: string
  label: string
  formula: string
  unit?: string
  prefix?: string
  decimals?: number
}

export interface WidgetStep { label: string; text: string }

/** One bar of a chart: what it is and its figure, which may be below zero. */
export interface WidgetBar { label: string; value: number; note?: string }

export type WidgetSpec =
  | { kind: 'choices'; title: string; options: WidgetChoice[] }
  | { kind: 'checklist'; title: string; items: WidgetItem[] }
  | { kind: 'calculator'; title: string; inputs: WidgetInput[]; results: WidgetFigure[] }
  | { kind: 'steps'; title: string; steps: WidgetStep[]; repeats?: boolean }
  | { kind: 'chart'; title: string; bars: WidgetBar[]; unit?: string; prefix?: string; decimals?: number }

/** What you made of a widget: a checklist's ticks, or a calculator's values by input id. */
export type WidgetState = { checked: boolean[] } | { values: Record<string, number | boolean> }

/** A widget kept with an answer: its place under it (from 1), and what you last made of it. */
export interface KeptWidget {
  n: number
  spec: WidgetSpec
  state?: WidgetState
  changedAt?: string
}
