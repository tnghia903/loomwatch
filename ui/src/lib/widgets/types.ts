/**
 * Widgets in an answer (ADR 0114), as the daemon keeps them (`crates/loomwatch-backend/src/
 * widgets/mod.rs`): what the agent showed, checked, where it stands in the answer, and what you
 * last made of it.
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
  /** Switches next to each other with the same group are one row of boxes to tap. */
  group?: string
}

/** A calculator's result: a figure LoomWatch works out from its formula. */
export interface WidgetFigure {
  id: string
  label: string
  formula: string
  unit?: string
  prefix?: string
  decimals?: number
  /** A short line under it saying why, its formulas in braces: "{found} of 3 found". */
  note?: string
}

/** A calculator's button that sets the inputs it names, and the rest back to their start. */
export interface WidgetPreset { label: string; values: Record<string, number | boolean> }

export interface WidgetStep { label: string; text: string }

/** One bar of a chart: what it is and its figure, which may be below zero. */
export interface WidgetBar { label: string; value: number; note?: string }

/** One thing in a row of marks. */
export interface WidgetCell { label: string; mark: 'yes' | 'no' | 'neither'; note?: string }

/** One box in a flow. */
export interface WidgetBox { label: string; note?: string }

/** One series of a graph: a value for each of its labels. */
export interface WidgetSeries { label: string; values: number[] }

export type WidgetSpec =
  | { kind: 'choices'; title: string; options: WidgetChoice[] }
  | { kind: 'checklist'; title: string; items: WidgetItem[] }
  | { kind: 'calculator'; title: string; inputs: WidgetInput[]; results: WidgetFigure[]; presets?: WidgetPreset[] }
  | { kind: 'steps'; title: string; steps: WidgetStep[]; repeats?: boolean }
  | { kind: 'chart'; title: string; bars: WidgetBar[]; unit?: string; prefix?: string; decimals?: number }
  | { kind: 'marks'; title: string; cells: WidgetCell[]; facts?: string[] }
  | { kind: 'flow'; title: string; boxes: WidgetBox[]; repeats?: boolean }
  | { kind: 'graph'; title: string; style: 'bar' | 'line'; labels: string[]; series: WidgetSeries[]; unit?: string; prefix?: string; decimals?: number }

/** What you made of a widget: a checklist's ticks, or a calculator's values by input id. */
export type WidgetState = { checked: boolean[] } | { values: Record<string, number | boolean> }

/** A widget kept with an answer: its place among the answer's widgets (from 1), the line of the
    answer's words it stands before (none: at the end), and what you last made of it. */
export interface KeptWidget {
  n: number
  line?: number
  spec: WidgetSpec
  state?: WidgetState
  changedAt?: string
}
