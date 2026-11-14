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

/** What a comparison's sides are parts of. */
export interface WidgetWhole { label: string; note?: string }

/** One side of a comparison: its name, its figure when the sides share a measure, a few words. */
export interface WidgetSide { label: string; value?: number; note?: string }

/** One fact of a comparison, read across: a value for each side, in their order. */
export interface WidgetRow { label: string; values: string[] }

/** One series of a graph: a value for each of its labels. */
export interface WidgetSeries { label: string; values: number[] }

/** One shape of a picture (ADR 0117), in the picture's units: absolute moves, lines and cubic
    curves only (`M10 20L30 40C…Z`), as the daemon redrew the agent's SVG. Its part from 1; a fill
    is shaded, dark where the agent filled it dark. */
export interface WidgetShape { d: string; part?: number; fill?: 'light' | 'dark'; dashed?: boolean }

/** One numbered part of a picture: a word or two, a sentence or two, and where its number stands. */
export interface WidgetPart { label: string; text: string; at: [number, number] }

/** Words the agent put on its picture (ADR 0117, amended 7 November), set in our type: plain text at
    `at` (its middle down, and across the edge `anchor` names), in a part from 1. */
export interface WidgetLabel { text: string; at: [number, number]; anchor?: 'start' | 'middle' | 'end'; part?: number }

/** One thing the agent drew again at each stage, so the picture plays: at each stage (a part, from
    1), its shapes and labels as indexes into the picture's, drawn the same way in the same order. */
export interface WidgetMove { stages: { part: number; shapes: number[]; labels?: number[] }[] }

/** The one question a picture asks as it first plays, before part `before`; `answer` is the right
    choice's place, from 0. */
export interface WidgetGuess { before: number; question: string; choices: string[]; answer: number }

/** One answer of a finder's question, and where it leads: a later question (`next`) or an outcome,
    each by its number from 1. */
export interface WidgetAnswer { label: string; next?: number; outcome?: number }

/** One question of a finder: its words and the answers you tap. */
export interface WidgetQuestion { text: string; answers: WidgetAnswer[] }

/** Where a finder's path ends: what is true in that case, and what to do. */
export interface WidgetOutcome { label: string; text?: string }

/** One question of a quiz: its choices, the right one's place (from 0), and why it is right. */
export interface WidgetCheck { question: string; choices: string[]; answer: number; why?: string }

/** One named range of a scale, from where it starts to where it ends. */
export interface WidgetRange { label: string; from: number; to: number }

/** One figure placed on a scale, and whose it is. */
export interface WidgetPin { label: string; value: number }

/** One event of a timeline: its date as the daemon keeps it (`1997`, `1997-06`, `1997-06-26`,
    `-500` for 500 BC), what happened or is due, and a few words more. */
export interface WidgetEvent { date: string; label: string; note?: string }

/** What sort of place a map's place is, for its pin's mark. */
export type PlaceCategory = 'food' | 'cafe' | 'bar' | 'shop' | 'hotel' | 'sight' | 'park' | 'transit' | 'other'

/** One place on a map: its name, where the agent found it, and what it found of it: a few words
    on why it suits you, its street address, its rating out of 5, how dear it is (1 to 4) and its
    own website. */
export interface WidgetPlace {
  name: string
  lat: number
  lng: number
  category?: PlaceCategory
  note?: string
  address?: string
  rating?: number
  price?: number
  link?: string
}

/** Where you are or start: a map's distances are from here. */
export interface WidgetStart { name: string; lat: number; lng: number }

/** One booking on a calendar: its day (`2026-11-14`), when it starts and ends (`09:30`, 24-hour;
    neither for one that lasts all day), what it is, and where. */
export interface WidgetBooking { day: string; start?: string; end?: string; label: string; place?: string }

/** The hours of each day a calendar shows and finds free time in, `07:00` to `24:00`. */
export interface WidgetHours { from: string; to: string }

export type WidgetSpec =
  | { kind: 'choices'; title: string; options: WidgetChoice[] }
  | { kind: 'checklist'; title: string; items: WidgetItem[] }
  | { kind: 'calculator'; title: string; inputs: WidgetInput[]; results: WidgetFigure[]; presets?: WidgetPreset[] }
  | { kind: 'steps'; title: string; steps: WidgetStep[]; repeats?: boolean }
  | { kind: 'chart'; title: string; bars: WidgetBar[]; unit?: string; prefix?: string; decimals?: number; counted?: boolean }
  | { kind: 'compare'; title: string; whole?: WidgetWhole; sides: WidgetSide[]; rows?: WidgetRow[]; unit?: string; prefix?: string; decimals?: number; counted?: boolean }
  | { kind: 'marks'; title: string; cells: WidgetCell[]; facts?: string[] }
  | { kind: 'flow'; title: string; boxes: WidgetBox[]; repeats?: boolean }
  | { kind: 'graph'; title: string; style: 'bar' | 'line'; labels: string[]; series: WidgetSeries[]; unit?: string; prefix?: string; decimals?: number }
  | { kind: 'picture'; title: string; width: number; height: number; shapes: WidgetShape[]; parts?: WidgetPart[]; labels?: WidgetLabel[]; moves?: WidgetMove[]; guess?: WidgetGuess; dial?: string }
  | { kind: 'finder'; title: string; questions: WidgetQuestion[]; outcomes: WidgetOutcome[] }
  | { kind: 'quiz'; title: string; checks: WidgetCheck[] }
  | { kind: 'scale'; title: string; ranges: WidgetRange[]; pins: WidgetPin[]; unit?: string; prefix?: string; decimals?: number }
  | { kind: 'timeline'; title: string; events: WidgetEvent[] }
  | { kind: 'map'; title: string; places: WidgetPlace[]; from?: WidgetStart }
  | { kind: 'calendar'; title: string; days: string[]; bookings: WidgetBooking[]; hours?: WidgetHours; zone?: string }
  /** A skill the agent suggested with `suggest_skill` (ADR 0118): its name in words, when to use
      it, and what to do. Nothing is saved until the person saves it. */
  | { kind: 'skill'; title: string; description: string; instructions: string }
  /** A tool the agent suggested connecting with `suggest_tool` (ADR 0126), by the name Connections
      gives it. Nothing is connected until the person taps Connect. */
  | { kind: 'connect'; title: string }
  /** A widget the agent wrote itself (ADR 0125): its markup and script, drawn in a frame that
      reaches nothing, with figures declared as a calculator's that LoomWatch works out. */
  | { kind: 'page'; title: string; why: string; html?: string; script?: string; inputs?: WidgetInput[]; results?: WidgetFigure[]; presets?: WidgetPreset[] }

/** What you made of a widget: a checklist's ticks, a calculator's or a page's values by input id
    (a page's with what it said when it couldn't draw), the answer you took at each of a finder's
    questions from the first (each from 0), the choice you picked for each of a quiz's questions
    (from 0, or null), a suggested skill saved (by its folder name) or left, or a suggested tool
    connected and given to the agent. */
export type WidgetState =
  | { checked: boolean[] }
  | { values: Record<string, number | boolean>; broke?: string }
  | { broke: string }
  | { answers: number[] }
  | { picked: (number | null)[] }
  | { saved: string }
  | { dismissed: true }
  | { connected: true }

/** A widget kept with an answer: its place among the answer's widgets (from 1), the line of the
    answer's words it stands before (none: at the end), and what you last made of it. */
export interface KeptWidget {
  n: number
  line?: number
  spec: WidgetSpec
  state?: WidgetState
  changedAt?: string
}
