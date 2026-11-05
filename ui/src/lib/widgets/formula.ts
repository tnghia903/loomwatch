/**
 * A calculator widget's formulas, and how a number is written (ADR 0114).
 *
 * The agent writes a formula; LoomWatch works it out, in the daemon when the agent shows the widget
 * (`crates/loomwatch-backend/src/widgets/formula.rs`) and here each time the person changes an
 * input. The two must agree to the last digit, so both read every case in
 * `schemas/formula.cases.json`.
 *
 * Numbers, the calculator's inputs and earlier results by id, `+ - * / ( )`, one comparison
 * (`< <= > >= == !=`, giving 1 or 0), and `min max round ceil floor abs if and or not`. A switch is 1
 * when on and 0 when off. Rounding and writing a number read it as written: its shortest decimal
 * form cut to 15 significant digits, halves away from zero.
 */

export const MAX_FORMULA_CHARS = 300
const MAX_DEPTH = 32
const MAX_DIGITS = 15
const SIGNIFICANT = 15
export const MAX_DECIMALS = 6
const WRITTEN_BELOW = 16

export type FormulaErrorKind =
  | 'syntax'
  | 'unknown_name'
  | 'unknown_function'
  | 'arguments'
  | 'divide_by_zero'
  | 'not_finite'
  | 'too_deep'
  | 'too_long'

export class FormulaError extends Error {
  readonly kind: FormulaErrorKind
  constructor(kind: FormulaErrorKind, message: string) {
    super(message)
    this.kind = kind
  }
}

type Compare = '<' | '<=' | '>' | '>=' | '==' | '!='
type FunctionName = 'min' | 'max' | 'round' | 'ceil' | 'floor' | 'abs' | 'if' | 'and' | 'or' | 'not'

type Expr =
  | { kind: 'number'; value: number }
  | { kind: 'name'; name: string }
  | { kind: 'negate'; inner: Expr }
  | { kind: 'binary'; op: '+' | '-' | '*' | '/'; left: Expr; right: Expr }
  | { kind: 'compare'; compare: Compare; left: Expr; right: Expr }
  | { kind: 'call'; fn: FunctionName; args: Expr[] }

const ARITY: Record<FunctionName, [number, number]> = {
  min: [1, Infinity],
  max: [1, Infinity],
  and: [2, Infinity],
  or: [2, Infinity],
  round: [1, 2],
  ceil: [1, 2],
  floor: [1, 2],
  abs: [1, 1],
  not: [1, 1],
  if: [3, 3],
}

export function isFunction(name: string): boolean {
  return Object.hasOwn(ARITY, name)
}

type Token =
  | { kind: 'number'; value: number }
  | { kind: 'name'; name: string }
  | { kind: '+' | '-' | '*' | '/' | '(' | ')' | ',' }
  | { kind: 'compare'; compare: Compare }

const syntax = (message: string) => new FormulaError('syntax', message)
const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9'
const isLetter = (c: string | undefined) => c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_')

function tokens(text: string): Token[] {
  const chars = [...text]
  const out: Token[] = []
  let at = 0
  while (at < chars.length) {
    const c = chars[at]
    if (/\s/u.test(c)) { at += 1; continue }
    if (isDigit(c)) {
      const start = at
      while (isDigit(chars[at])) at += 1
      if (chars[at] === '.') {
        at += 1
        const fraction = at
        while (isDigit(chars[at])) at += 1
        if (at === fraction) throw syntax(`a number can't end with a point, at character ${at}`)
      }
      out.push({ kind: 'number', value: Number(chars.slice(start, at).join('')) })
      continue
    }
    if (isLetter(c)) {
      const start = at
      while (isLetter(chars[at]) || isDigit(chars[at])) at += 1
      out.push({ kind: 'name', name: chars.slice(start, at).join('') })
      continue
    }
    const pair = c + (chars[at + 1] ?? '')
    if (pair === '<=' || pair === '>=' || pair === '==' || pair === '!=') {
      out.push({ kind: 'compare', compare: pair })
      at += 2
      continue
    }
    if (c === '<' || c === '>') { out.push({ kind: 'compare', compare: c }); at += 1; continue }
    if (c === '+' || c === '-' || c === '*' || c === '/' || c === '(' || c === ')' || c === ',') {
      out.push({ kind: c })
      at += 1
      continue
    }
    throw syntax(`"${c}" can't be used in a formula, at character ${at + 1}`)
  }
  return out
}

function describe(token: Token): string {
  switch (token.kind) {
    case 'number': return 'a number'
    case 'name': return `"${token.name}"`
    case ',': return 'a comma'
    case 'compare': return 'a comparison'
    default: return `"${token.kind}"`
  }
}

function arityWords(least: number, most: number): string {
  if (least === most) return `${least}`
  if (most === Infinity) return `${least} or more`
  return `${least} or ${most}`
}

class Parser {
  private at = 0
  private depth = 0
  private readonly list: Token[]
  constructor(list: Token[]) { this.list = list }

  peek(): Token | undefined { return this.list[this.at] }
  private take(): Token | undefined { const token = this.list[this.at]; this.at += 1; return token }

  private deeper() {
    this.depth += 1
    if (this.depth > MAX_DEPTH) throw new FormulaError('too_deep', `the formula nests more than ${MAX_DEPTH} deep: write it more simply`)
  }

  expression(): Expr {
    const left = this.sum()
    const next = this.peek()
    if (next?.kind === 'compare') {
      this.at += 1
      return { kind: 'compare', compare: next.compare, left, right: this.sum() }
    }
    return left
  }

  private sum(): Expr {
    let left = this.product()
    for (;;) {
      const next = this.peek()
      if (next?.kind !== '+' && next?.kind !== '-') return left
      this.at += 1
      left = { kind: 'binary', op: next.kind, left, right: this.product() }
    }
  }

  private product(): Expr {
    let left = this.unary()
    for (;;) {
      const next = this.peek()
      if (next?.kind !== '*' && next?.kind !== '/') return left
      this.at += 1
      left = { kind: 'binary', op: next.kind, left, right: this.unary() }
    }
  }

  private unary(): Expr {
    if (this.peek()?.kind === '-') {
      this.at += 1
      this.deeper()
      const inner = this.unary()
      this.depth -= 1
      return { kind: 'negate', inner }
    }
    return this.atom()
  }

  private atom(): Expr {
    const token = this.take()
    if (!token) throw syntax('the formula ends too soon')
    if (token.kind === 'number') return { kind: 'number', value: token.value }
    if (token.kind === '(') {
      this.deeper()
      const inner = this.expression()
      if (this.take()?.kind !== ')') throw syntax('a bracket is opened and never closed')
      this.depth -= 1
      return inner
    }
    if (token.kind === 'name') {
      if (this.peek()?.kind !== '(') return { kind: 'name', name: token.name }
      this.at += 1
      if (!isFunction(token.name)) {
        throw new FormulaError('unknown_function', `there is no function "${token.name}": use min, max, round, ceil, floor, abs, if, and, or or not`)
      }
      const fn = token.name as FunctionName
      this.deeper()
      const args: Expr[] = []
      if (this.peek()?.kind === ')') {
        this.at += 1
      } else {
        for (;;) {
          args.push(this.expression())
          const next = this.take()
          if (next?.kind === ',') continue
          if (next?.kind === ')') break
          throw syntax(`${fn}( is opened and never closed`)
        }
      }
      this.depth -= 1
      const [least, most] = ARITY[fn]
      if (args.length < least || args.length > most) {
        throw new FormulaError('arguments', `${fn}() takes ${arityWords(least, most)}, not ${args.length}`)
      }
      return { kind: 'call', fn, args }
    }
    throw syntax(`the formula can't have ${describe(token)} there`)
  }
}

/** A formula read once, to be worked out with different values. */
export interface Formula {
  readonly expr: Expr
}

/** Read `text` as a formula. Throws a {@link FormulaError}. */
export function parse(text: string): Formula {
  if ([...text].length > MAX_FORMULA_CHARS) throw new FormulaError('too_long', `a formula is at most ${MAX_FORMULA_CHARS} characters`)
  const list = tokens(text)
  if (list.length === 0) throw syntax('the formula is empty')
  const parser = new Parser(list)
  const expr = parser.expression()
  const left = parser.peek()
  if (left) throw syntax(`the formula can't have ${describe(left)} there`)
  return { expr }
}

/** Every name `formula` reads, in order, each once. */
export function names(formula: Formula): string[] {
  const out: string[] = []
  const walk = (expr: Expr) => {
    switch (expr.kind) {
      case 'number': return
      case 'name': if (!out.includes(expr.name)) out.push(expr.name); return
      case 'negate': walk(expr.inner); return
      case 'binary':
      case 'compare': walk(expr.left); walk(expr.right); return
      case 'call': expr.args.forEach(walk)
    }
  }
  walk(formula.expr)
  return out
}

/** Work `formula` out with `values`. Throws a {@link FormulaError}. */
export function evaluateFormula(formula: Formula, values: Readonly<Record<string, number>>): number {
  return finite(evaluateExpr(formula.expr, values))
}

/** Read and work out `text` with `values`, in one step. Throws a {@link FormulaError}. */
export function evaluate(text: string, values: Readonly<Record<string, number>>): number {
  return evaluateFormula(parse(text), values)
}

function finite(value: number): number {
  if (!Number.isFinite(value)) throw new FormulaError('not_finite', 'the result is too large to be a number')
  return value
}

const truth = (value: boolean) => (value ? 1 : 0)

function evaluateExpr(expr: Expr, values: Readonly<Record<string, number>>): number {
  switch (expr.kind) {
    case 'number': return expr.value
    case 'name': {
      if (!Object.hasOwn(values, expr.name)) throw new FormulaError('unknown_name', `"${expr.name}" is not one of this calculator's inputs or results`)
      return values[expr.name]
    }
    case 'negate': return -evaluateExpr(expr.inner, values)
    case 'binary': {
      const left = evaluateExpr(expr.left, values)
      const right = evaluateExpr(expr.right, values)
      switch (expr.op) {
        case '+': return finite(left + right)
        case '-': return finite(left - right)
        case '*': return finite(left * right)
        case '/':
          if (right === 0) throw new FormulaError('divide_by_zero', 'the formula divides by zero')
          return finite(left / right)
      }
      break
    }
    case 'compare': {
      const left = evaluateExpr(expr.left, values)
      const right = evaluateExpr(expr.right, values)
      switch (expr.compare) {
        case '<': return truth(left < right)
        case '<=': return truth(left <= right)
        case '>': return truth(left > right)
        case '>=': return truth(left >= right)
        case '==': return truth(left === right)
        case '!=': return truth(left !== right)
      }
      break
    }
    case 'call': return call(expr.fn, expr.args, values)
  }
  throw syntax('the formula can\'t be read')
}

function call(fn: FunctionName, args: Expr[], values: Readonly<Record<string, number>>): number {
  // `if` works out only the branch it takes, so the other may divide by zero.
  if (fn === 'if') return evaluateExpr(args[evaluateExpr(args[0], values) === 0 ? 2 : 1], values)
  const numbers = args.map((arg) => evaluateExpr(arg, values))
  switch (fn) {
    case 'min': return Math.min(...numbers)
    case 'max': return Math.max(...numbers)
    case 'abs': return Math.abs(numbers[0])
    case 'not': return truth(numbers[0] === 0)
    case 'and': return truth(numbers.every((n) => n !== 0))
    case 'or': return truth(numbers.some((n) => n !== 0))
    default: {
      const digits = numbers.length > 1 ? wholeDigits(fn, numbers[1]) : 0
      return finite(Decimal.of(finite(numbers[0])).round(digits, fn === 'round' ? 'round' : fn === 'ceil' ? 'ceil' : 'floor').toNumber())
    }
  }
}

function wholeDigits(fn: FunctionName, digits: number): number {
  if (!Number.isInteger(digits) || Math.abs(digits) > MAX_DIGITS) {
    throw new FormulaError('arguments', `${fn}()'s digits must be a whole number from -15 to 15`)
  }
  return digits
}

type Mode = 'round' | 'ceil' | 'floor'

/** A number as decimal digits: `0.d₁d₂… × 10^exponent`, no leading zero digit; zero has none. */
class Decimal {
  readonly negative: boolean
  readonly digits: number[]
  readonly exponent: number
  constructor(negative: boolean, digits: number[], exponent: number) {
    this.negative = negative
    this.digits = digits
    this.exponent = exponent
  }

  /** `value`'s shortest decimal form, cut to 15 significant digits. */
  static of(value: number): Decimal {
    // Shortest round-trip digits in exponent form, as Rust's `{:e}` writes them.
    const written = value.toExponential()
    const [mantissa, power = '0'] = written.split('e')
    const negative = mantissa.startsWith('-')
    let digits = [...mantissa].filter(isDigit).map(Number)
    while (digits[0] === 0) digits = digits.slice(1)
    let decimal = new Decimal(negative, digits, Number(power) + 1)
    if (decimal.digits.length > SIGNIFICANT) {
      const up = decimal.digits[SIGNIFICANT] >= 5
      decimal = new Decimal(decimal.negative, decimal.digits.slice(0, SIGNIFICANT), decimal.exponent)
      if (up) decimal = decimal.carried()
    }
    return decimal.trimmed()
  }

  /** One added to the last digit. */
  carried(): Decimal {
    const digits = [...this.digits]
    let at = digits.length
    for (;;) {
      if (at === 0) return new Decimal(this.negative, [1, ...digits], this.exponent + 1)
      at -= 1
      if (digits[at] === 9) {
        digits[at] = 0
      } else {
        digits[at] += 1
        return new Decimal(this.negative, digits, this.exponent)
      }
    }
  }

  trimmed(): Decimal {
    let end = this.digits.length
    while (end > 0 && this.digits[end - 1] === 0) end -= 1
    if (end === 0) return new Decimal(false, [], 0)
    return new Decimal(this.negative, this.digits.slice(0, end), this.exponent)
  }

  /** Rounded to `places` decimal places (negative: to tens, hundreds…). */
  round(places: number, mode: Mode): Decimal {
    const keep = this.exponent + places
    const tailNonzero = (from: number) => this.digits.slice(from).some((digit) => digit !== 0)
    if (keep <= 0) {
      const up = mode === 'round' ? keep === 0 && (this.digits[0] ?? 0) >= 5
        : mode === 'ceil' ? !this.negative && tailNonzero(0)
        : this.negative && tailNonzero(0)
      return up ? new Decimal(this.negative, [1], 1 - places) : new Decimal(false, [], 0)
    }
    if (keep >= this.digits.length) return this
    const up = mode === 'round' ? this.digits[keep] >= 5
      : mode === 'ceil' ? !this.negative && tailNonzero(keep)
      : this.negative && tailNonzero(keep)
    let out = new Decimal(this.negative, this.digits.slice(0, keep), this.exponent)
    if (up) out = out.carried()
    return out.trimmed()
  }

  toNumber(): number {
    if (this.digits.length === 0) return 0
    return Number(`${this.negative ? '-' : ''}${this.digits.join('')}e${this.exponent - this.digits.length}`)
  }
}

/**
 * `value` written for a person: grouped thousands with commas, a point for decimals, `decimals`
 * places exactly, or when null up to two with trailing zeros left off. Null for a number that can't
 * be written exactly: not finite, or 10¹⁵ and over. Never the browser's locale, so the person reads
 * the figures the agent was given.
 */
export function display(value: number, decimals: number | null = null): string | null {
  if (!Number.isFinite(value)) return null
  const places = Math.min(decimals ?? 2, MAX_DECIMALS)
  const rounded = Decimal.of(value).round(places, 'round')
  if (rounded.exponent >= WRITTEN_BELOW) return null
  const digit = (at: number) => (at >= 0 && at < rounded.digits.length ? String(rounded.digits[at]) : '0')
  let whole = '0'
  if (rounded.exponent > 0) {
    whole = ''
    for (let at = 0; at < rounded.exponent; at += 1) whole += digit(at)
  }
  let fraction = ''
  for (let place = 0; place < places; place += 1) fraction += digit(rounded.exponent + place)
  if (decimals === null) fraction = fraction.replace(/0+$/u, '')
  const sign = rounded.negative && rounded.digits.length > 0 ? '-' : ''
  return `${sign}${grouped(whole)}${fraction ? `.${fraction}` : ''}`
}

function grouped(whole: string): string {
  let out = ''
  for (let at = 0; at < whole.length; at += 1) {
    if (at > 0 && (whole.length - at) % 3 === 0) out += ','
    out += whole[at]
  }
  return out
}

/** `value` grouped like a result, with up to six decimals and no trailing zeros; null when it
    can't be written. */
function plain(value: number): string | null {
  const written = display(value, MAX_DECIMALS)
  if (written === null) return null
  return written.includes('.') ? written.replace(/0+$/u, '').replace(/\.$/u, '') : written
}

const OPERATORS = new Set(['+', '-', '*', '/'])

/**
 * "(2,400,000 + 32 × 60,000) ÷ 32": `text` with each name's value written in, so you can see how a
 * result was worked out. Null for a formula with a function in it, or with no sum in it, where it
 * would read as code rather than arithmetic.
 */
export function workingOf(text: string, values: Readonly<Record<string, number>>): string | null {
  let list: Token[]
  try { list = tokens(text) } catch { return null }
  if (!list.some((token) => OPERATORS.has(token.kind))) return null
  // "(32 > 30) × 50,000" reads as code, not a sum.
  if (list.some((token) => token.kind === 'compare')) return null
  let out = ''
  let previous: Token | null = null
  for (let at = 0; at < list.length; at += 1) {
    const token = list[at]
    if (token.kind === 'name') {
      if (list[at + 1]?.kind === '(' || !Object.hasOwn(values, token.name)) return null
      const written = plain(values[token.name])
      if (written === null) return null
      out += written
    } else if (token.kind === 'number') {
      const written = plain(token.value)
      if (written === null) return null
      out += written
    } else if (token.kind === '-') {
      const unary = previous === null || previous.kind === '(' || previous.kind === ',' || previous.kind === 'compare' || OPERATORS.has(previous.kind)
      out += unary ? '−' : ' − '
    } else if (token.kind === '+') {
      out += ' + '
    } else if (token.kind === '*') {
      out += ' × '
    } else if (token.kind === '/') {
      out += ' ÷ '
    } else if (token.kind === ',') {
      out += ', '
    } else if (token.kind === 'compare') {
      out += ` ${token.compare} `
    } else {
      out += token.kind
    }
    previous = token
  }
  return out
}
