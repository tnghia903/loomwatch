//! A calculator widget's formulas, and how a number is written (ADR 0114).
//!
//! The agent writes a formula; `LoomWatch` works it out, here when the agent shows the widget and in
//! the app (`ui/src/lib/widgets/formula.ts`) each time the person changes an input. The two must
//! agree to the last digit, so both read every case in `schemas/formula.cases.json`.
//!
//! The language is small on purpose: numbers, the calculator's inputs and earlier results by id,
//! `+ - * / ( )`, one comparison (`< <= > >= == !=`, giving 1 or 0), and the functions `min`,
//! `max`, `round`, `ceil`, `floor`, `abs`, `if`, `and`, `or` and `not`. A switch is 1 when on and 0
//! when off. There are no other names, no loops and no way out of the calculator.
//!
//! Rounding, and writing a number, read it as written: its shortest decimal form, cut to 15
//! significant digits, as a spreadsheet does, so `round(2.345, 2)` is 2.35 and not the 2.34 its
//! binary value would give. Halves round away from zero.

use std::collections::BTreeMap;

/// The longest formula, in characters.
pub(crate) const MAX_FORMULA_CHARS: usize = 300;
/// How deep brackets, signs and calls may nest.
const MAX_DEPTH: usize = 32;
/// The furthest `round`, `ceil` and `floor` may round, either side of the decimal point.
const MAX_DIGITS: f64 = 15.0;
/// Significant digits a number is read with before it is rounded or written.
const SIGNIFICANT: usize = 15;
/// The most decimals a number is written with.
pub(crate) const MAX_DECIMALS: u8 = 6;
/// A number this large or larger is not written: past 15 digits it would not be exact.
const WRITTEN_BELOW: i32 = 16;

/// What went wrong, as the code `schemas/formula.cases.json` names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ErrorKind {
    Syntax,
    UnknownName,
    UnknownFunction,
    Arguments,
    DivideByZero,
    NotFinite,
    TooDeep,
    TooLong,
}

impl ErrorKind {
    /// The code the shared cases name it by.
    #[cfg(test)]
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::Syntax => "syntax",
            Self::UnknownName => "unknown_name",
            Self::UnknownFunction => "unknown_function",
            Self::Arguments => "arguments",
            Self::DivideByZero => "divide_by_zero",
            Self::NotFinite => "not_finite",
            Self::TooDeep => "too_deep",
            Self::TooLong => "too_long",
        }
    }
}

/// A formula that can't be read or worked out, with what to change, for the agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FormulaError {
    pub(crate) kind: ErrorKind,
    pub(crate) message: String,
}

impl FormulaError {
    fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for FormulaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Op {
    Add,
    Subtract,
    Multiply,
    Divide,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Compare {
    Less,
    AtMost,
    Greater,
    AtLeast,
    Equal,
    NotEqual,
}

#[derive(Debug, Clone, PartialEq)]
enum Expr {
    Number(f64),
    Name(String),
    Negate(Box<Expr>),
    Binary(Op, Box<Expr>, Box<Expr>),
    Compare(Compare, Box<Expr>, Box<Expr>),
    Call(Function, Vec<Expr>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Function {
    Min,
    Max,
    Round,
    Ceil,
    Floor,
    Abs,
    If,
    And,
    Or,
    Not,
}

impl Function {
    fn named(name: &str) -> Option<Self> {
        Some(match name {
            "min" => Self::Min,
            "max" => Self::Max,
            "round" => Self::Round,
            "ceil" => Self::Ceil,
            "floor" => Self::Floor,
            "abs" => Self::Abs,
            "if" => Self::If,
            "and" => Self::And,
            "or" => Self::Or,
            "not" => Self::Not,
            _ => return None,
        })
    }

    /// How many arguments it takes, at least and at most.
    fn arity(self) -> (usize, usize) {
        match self {
            Self::Min | Self::Max => (1, usize::MAX),
            Self::And | Self::Or => (2, usize::MAX),
            Self::Round | Self::Ceil | Self::Floor => (1, 2),
            Self::Abs | Self::Not => (1, 1),
            Self::If => (3, 3),
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Min => "min",
            Self::Max => "max",
            Self::Round => "round",
            Self::Ceil => "ceil",
            Self::Floor => "floor",
            Self::Abs => "abs",
            Self::If => "if",
            Self::And => "and",
            Self::Or => "or",
            Self::Not => "not",
        }
    }
}

/// Whether `name` is one of the functions, which an input or a result may not be called.
pub(crate) fn is_function(name: &str) -> bool {
    Function::named(name).is_some()
}

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Number(f64),
    Name(String),
    Plus,
    Minus,
    Star,
    Slash,
    Open,
    Close,
    Comma,
    Compare(Compare),
}

fn tokens(text: &str) -> Result<Vec<Token>, FormulaError> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut at = 0;
    while at < chars.len() {
        let c = chars[at];
        if c.is_whitespace() {
            at += 1;
            continue;
        }
        if c.is_ascii_digit() {
            let start = at;
            while at < chars.len() && chars[at].is_ascii_digit() {
                at += 1;
            }
            if at < chars.len() && chars[at] == '.' {
                at += 1;
                let fraction = at;
                while at < chars.len() && chars[at].is_ascii_digit() {
                    at += 1;
                }
                if at == fraction {
                    return Err(syntax(&format!(
                        "a number can't end with a point, at character {at}"
                    )));
                }
            }
            let written: String = chars[start..at].iter().collect();
            let value: f64 = written
                .parse()
                .map_err(|_| syntax(&format!("\"{written}\" is not a number")))?;
            out.push(Token::Number(value));
            continue;
        }
        if c.is_ascii_alphabetic() || c == '_' {
            let start = at;
            while at < chars.len() && (chars[at].is_ascii_alphanumeric() || chars[at] == '_') {
                at += 1;
            }
            out.push(Token::Name(chars[start..at].iter().collect()));
            continue;
        }
        let next = chars.get(at + 1).copied();
        let (token, width) = match (c, next) {
            ('<', Some('=')) => (Token::Compare(Compare::AtMost), 2),
            ('>', Some('=')) => (Token::Compare(Compare::AtLeast), 2),
            ('=', Some('=')) => (Token::Compare(Compare::Equal), 2),
            ('!', Some('=')) => (Token::Compare(Compare::NotEqual), 2),
            ('<', _) => (Token::Compare(Compare::Less), 1),
            ('>', _) => (Token::Compare(Compare::Greater), 1),
            ('+', _) => (Token::Plus, 1),
            ('-', _) => (Token::Minus, 1),
            ('*', _) => (Token::Star, 1),
            ('/', _) => (Token::Slash, 1),
            ('(', _) => (Token::Open, 1),
            (')', _) => (Token::Close, 1),
            (',', _) => (Token::Comma, 1),
            _ => {
                return Err(syntax(&format!(
                    "\"{c}\" can't be used in a formula, at character {}",
                    at + 1
                )));
            }
        };
        out.push(token);
        at += width;
    }
    Ok(out)
}

fn syntax(message: &str) -> FormulaError {
    FormulaError::new(ErrorKind::Syntax, message)
}

struct Parser {
    tokens: Vec<Token>,
    at: usize,
    depth: usize,
}

impl Parser {
    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.at)
    }

    fn take(&mut self) -> Option<Token> {
        let token = self.tokens.get(self.at).cloned();
        self.at += 1;
        token
    }

    fn deeper(&mut self) -> Result<(), FormulaError> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(FormulaError::new(
                ErrorKind::TooDeep,
                format!("the formula nests more than {MAX_DEPTH} deep: write it more simply"),
            ));
        }
        Ok(())
    }

    /// A sum, optionally compared with another.
    fn expression(&mut self) -> Result<Expr, FormulaError> {
        let left = self.sum()?;
        if let Some(Token::Compare(compare)) = self.peek().cloned() {
            self.at += 1;
            let right = self.sum()?;
            return Ok(Expr::Compare(compare, Box::new(left), Box::new(right)));
        }
        Ok(left)
    }

    fn sum(&mut self) -> Result<Expr, FormulaError> {
        let mut left = self.product()?;
        loop {
            let op = match self.peek() {
                Some(Token::Plus) => Op::Add,
                Some(Token::Minus) => Op::Subtract,
                _ => return Ok(left),
            };
            self.at += 1;
            let right = self.product()?;
            left = Expr::Binary(op, Box::new(left), Box::new(right));
        }
    }

    fn product(&mut self) -> Result<Expr, FormulaError> {
        let mut left = self.unary()?;
        loop {
            let op = match self.peek() {
                Some(Token::Star) => Op::Multiply,
                Some(Token::Slash) => Op::Divide,
                _ => return Ok(left),
            };
            self.at += 1;
            let right = self.unary()?;
            left = Expr::Binary(op, Box::new(left), Box::new(right));
        }
    }

    fn unary(&mut self) -> Result<Expr, FormulaError> {
        if self.peek() == Some(&Token::Minus) {
            self.at += 1;
            self.deeper()?;
            let inner = self.unary()?;
            self.depth -= 1;
            return Ok(Expr::Negate(Box::new(inner)));
        }
        self.atom()
    }

    fn atom(&mut self) -> Result<Expr, FormulaError> {
        match self.take() {
            Some(Token::Number(value)) => Ok(Expr::Number(value)),
            Some(Token::Open) => {
                self.deeper()?;
                let inner = self.expression()?;
                if self.take() != Some(Token::Close) {
                    return Err(syntax("a bracket is opened and never closed"));
                }
                self.depth -= 1;
                Ok(inner)
            }
            Some(Token::Name(name)) => {
                if self.peek() != Some(&Token::Open) {
                    return Ok(Expr::Name(name));
                }
                self.at += 1;
                let Some(function) = Function::named(&name) else {
                    return Err(FormulaError::new(
                        ErrorKind::UnknownFunction,
                        format!(
                            "there is no function \"{name}\": use min, max, round, ceil, floor, \
                             abs, if, and, or or not"
                        ),
                    ));
                };
                self.deeper()?;
                let mut arguments = Vec::new();
                if self.peek() == Some(&Token::Close) {
                    self.at += 1;
                } else {
                    loop {
                        arguments.push(self.expression()?);
                        match self.take() {
                            Some(Token::Comma) => {}
                            Some(Token::Close) => break,
                            _ => {
                                return Err(syntax(&format!(
                                    "{}( is opened and never closed",
                                    function.name()
                                )));
                            }
                        }
                    }
                }
                self.depth -= 1;
                let (least, most) = function.arity();
                if arguments.len() < least || arguments.len() > most {
                    return Err(FormulaError::new(
                        ErrorKind::Arguments,
                        format!(
                            "{}() takes {}, not {}",
                            function.name(),
                            arity_words(least, most),
                            arguments.len()
                        ),
                    ));
                }
                Ok(Expr::Call(function, arguments))
            }
            Some(token) => Err(syntax(&format!(
                "the formula can't have {} there",
                describe(&token)
            ))),
            None => Err(syntax("the formula ends too soon")),
        }
    }
}

fn arity_words(least: usize, most: usize) -> String {
    if least == most {
        format!("{least}")
    } else if most == usize::MAX {
        format!("{least} or more")
    } else {
        format!("{least} or {most}")
    }
}

fn describe(token: &Token) -> String {
    match token {
        Token::Number(_) => "a number".to_owned(),
        Token::Name(name) => format!("\"{name}\""),
        Token::Plus => "\"+\"".to_owned(),
        Token::Minus => "\"-\"".to_owned(),
        Token::Star => "\"*\"".to_owned(),
        Token::Slash => "\"/\"".to_owned(),
        Token::Open => "\"(\"".to_owned(),
        Token::Close => "\")\"".to_owned(),
        Token::Comma => "a comma".to_owned(),
        Token::Compare(_) => "a comparison".to_owned(),
    }
}

/// A formula read once, to be worked out with different values.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Formula {
    expr: Expr,
}

/// Read `text` as a formula.
///
/// # Errors
///
/// A formula that is too long, nests too deep, or can't be read.
pub(crate) fn parse(text: &str) -> Result<Formula, FormulaError> {
    if text.chars().count() > MAX_FORMULA_CHARS {
        return Err(FormulaError::new(
            ErrorKind::TooLong,
            format!("a formula is at most {MAX_FORMULA_CHARS} characters"),
        ));
    }
    let tokens = tokens(text)?;
    if tokens.is_empty() {
        return Err(syntax("the formula is empty"));
    }
    let mut parser = Parser {
        tokens,
        at: 0,
        depth: 0,
    };
    let expr = parser.expression()?;
    if let Some(token) = parser.peek() {
        return Err(syntax(&format!(
            "the formula can't have {} there",
            describe(token)
        )));
    }
    Ok(Formula { expr })
}

impl Formula {
    /// Every name the formula reads, in order, each once.
    pub(crate) fn names(&self) -> Vec<String> {
        fn walk(expr: &Expr, out: &mut Vec<String>) {
            match expr {
                Expr::Number(_) => {}
                Expr::Name(name) => {
                    if !out.contains(name) {
                        out.push(name.clone());
                    }
                }
                Expr::Negate(inner) => walk(inner, out),
                Expr::Binary(_, left, right) | Expr::Compare(_, left, right) => {
                    walk(left, out);
                    walk(right, out);
                }
                Expr::Call(_, arguments) => {
                    for argument in arguments {
                        walk(argument, out);
                    }
                }
            }
        }
        let mut out = Vec::new();
        walk(&self.expr, &mut out);
        out
    }

    /// Work the formula out with `values`.
    ///
    /// # Errors
    ///
    /// A name with no value, a division by zero, a number too large, or digits that aren't whole.
    pub(crate) fn evaluate(&self, values: &BTreeMap<String, f64>) -> Result<f64, FormulaError> {
        let value = eval(&self.expr, values)?;
        finite(value)
    }
}

/// Read and work out `text` with `values`, in one step.
///
/// # Errors
///
/// As [`parse`] and [`Formula::evaluate`].
pub(crate) fn evaluate(text: &str, values: &BTreeMap<String, f64>) -> Result<f64, FormulaError> {
    parse(text)?.evaluate(values)
}

/// A piece of a result's note: words as written, or a formula in braces.
#[derive(Debug, Clone, PartialEq)]
enum NotePart {
    Words(String),
    Formula(Formula),
}

/// A result's note, read: words with formulas in braces, such as `"{found} of 3 found"`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Note {
    parts: Vec<NotePart>,
}

/// Read `text` as a result's note: words, with each formula in braces.
///
/// # Errors
///
/// A `{` with no `}` after it, a `}` with no `{` before it, or a formula in braces that can't be
/// read.
pub(crate) fn parse_note(text: &str) -> Result<Note, FormulaError> {
    let mut parts = Vec::new();
    let mut rest = text;
    while !rest.is_empty() {
        let open = rest.find('{');
        let close = rest.find('}');
        match (open, close) {
            (None, None) => {
                parts.push(NotePart::Words(rest.to_owned()));
                break;
            }
            (open, Some(close)) if open.is_none_or(|open| close < open) => {
                return Err(syntax("a } in a note closes a { before it"));
            }
            (Some(open), close) => {
                let Some(close) = close else {
                    return Err(syntax("a { in a note needs a } after its formula"));
                };
                if open > 0 {
                    parts.push(NotePart::Words(rest[..open].to_owned()));
                }
                let inside = &rest[open + 1..close];
                if inside.contains('{') {
                    return Err(syntax("a { in a note needs a } after its formula"));
                }
                parts.push(NotePart::Formula(parse(inside)?));
                rest = &rest[close + 1..];
            }
            (None, Some(_)) => unreachable!("a closing brace with no opening one is refused above"),
        }
    }
    Ok(Note { parts })
}

impl Note {
    /// Every name the note's formulas read, in order, each once.
    pub(crate) fn names(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for part in &self.parts {
            if let NotePart::Formula(formula) = part {
                for name in formula.names() {
                    if !out.contains(&name) {
                        out.push(name);
                    }
                }
            }
        }
        out
    }

    /// The note with each formula worked out with `values` and written as [`display`] writes it,
    /// with up to two decimals.
    ///
    /// # Errors
    ///
    /// As [`Formula::evaluate`].
    pub(crate) fn fill(&self, values: &BTreeMap<String, f64>) -> Result<String, FormulaError> {
        let mut out = String::new();
        for part in &self.parts {
            match part {
                NotePart::Words(words) => out.push_str(words),
                NotePart::Formula(formula) => {
                    let value = formula.evaluate(values)?;
                    out.push_str(&display(value, None).unwrap_or_else(|| "too large".to_owned()));
                }
            }
        }
        Ok(out)
    }
}

fn finite(value: f64) -> Result<f64, FormulaError> {
    if value.is_finite() {
        Ok(value)
    } else {
        Err(FormulaError::new(
            ErrorKind::NotFinite,
            "the result is too large to be a number",
        ))
    }
}

fn truth(value: bool) -> f64 {
    if value { 1.0 } else { 0.0 }
}

// Comparing exactly is what `==` and a switch's 0 mean here.
#[allow(clippy::float_cmp)]
fn eval(expr: &Expr, values: &BTreeMap<String, f64>) -> Result<f64, FormulaError> {
    match expr {
        Expr::Number(value) => Ok(*value),
        Expr::Name(name) => values.get(name).copied().ok_or_else(|| {
            FormulaError::new(
                ErrorKind::UnknownName,
                format!("\"{name}\" is not one of this calculator's inputs or results"),
            )
        }),
        Expr::Negate(inner) => Ok(-eval(inner, values)?),
        Expr::Binary(op, left, right) => {
            let left = eval(left, values)?;
            let right = eval(right, values)?;
            let value = match op {
                Op::Add => left + right,
                Op::Subtract => left - right,
                Op::Multiply => left * right,
                Op::Divide => {
                    if right == 0.0 {
                        return Err(FormulaError::new(
                            ErrorKind::DivideByZero,
                            "the formula divides by zero",
                        ));
                    }
                    left / right
                }
            };
            finite(value)
        }
        Expr::Compare(compare, left, right) => {
            let left = eval(left, values)?;
            let right = eval(right, values)?;
            Ok(truth(match compare {
                Compare::Less => left < right,
                Compare::AtMost => left <= right,
                Compare::Greater => left > right,
                Compare::AtLeast => left >= right,
                Compare::Equal => left == right,
                Compare::NotEqual => left != right,
            }))
        }
        Expr::Call(function, arguments) => call(*function, arguments, values),
    }
}

#[allow(clippy::float_cmp)]
fn call(
    function: Function,
    arguments: &[Expr],
    values: &BTreeMap<String, f64>,
) -> Result<f64, FormulaError> {
    // `if` works out only the branch it takes, so the other may divide by zero.
    if function == Function::If {
        let condition = eval(&arguments[0], values)?;
        return eval(&arguments[if condition == 0.0 { 2 } else { 1 }], values);
    }
    let numbers = arguments
        .iter()
        .map(|argument| eval(argument, values))
        .collect::<Result<Vec<f64>, _>>()?;
    Ok(match function {
        Function::Min => numbers.iter().copied().fold(f64::INFINITY, f64::min),
        Function::Max => numbers.iter().copied().fold(f64::NEG_INFINITY, f64::max),
        Function::Abs => numbers[0].abs(),
        Function::Not => truth(numbers[0] == 0.0),
        Function::And => truth(numbers.iter().all(|number| *number != 0.0)),
        Function::Or => truth(numbers.iter().any(|number| *number != 0.0)),
        Function::Round | Function::Ceil | Function::Floor => {
            let digits = match numbers.get(1) {
                None => 0,
                Some(digits) => whole_digits(function, *digits)?,
            };
            let mode = match function {
                Function::Round => Mode::Round,
                Function::Ceil => Mode::Ceil,
                _ => Mode::Floor,
            };
            rounded(numbers[0], digits, mode)?
        }
        Function::If => unreachable!("handled above"),
    })
}

#[allow(clippy::float_cmp)]
fn whole_digits(function: Function, digits: f64) -> Result<i32, FormulaError> {
    if digits.fract() != 0.0 || digits.abs() > MAX_DIGITS {
        return Err(FormulaError::new(
            ErrorKind::Arguments,
            format!(
                "{}()'s digits must be a whole number from -15 to 15",
                function.name()
            ),
        ));
    }
    // Whole and at most 15 either way, so it fits.
    #[allow(clippy::cast_possible_truncation)]
    Ok(digits as i32)
}

/// Which way a number is rounded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// To the nearest, halves away from zero.
    Round,
    /// Up, towards positive infinity.
    Ceil,
    /// Down, towards negative infinity.
    Floor,
}

/// A number as decimal digits: `0.d₁d₂… × 10^exponent`, with no leading zero digit; zero has no
/// digits.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Decimal {
    negative: bool,
    digits: Vec<u8>,
    exponent: i32,
}

impl Decimal {
    /// `value`'s shortest decimal form, cut to [`SIGNIFICANT`] digits.
    fn of(value: f64) -> Self {
        // Shortest round-trip digits in exponent form, as JavaScript's `toExponential()` writes
        // them: "1.35e5", "-2.5e0", "3.0000000000000004e-1", "0e0".
        let written = format!("{value:e}");
        let (mantissa, power) = written.split_once('e').unwrap_or((&written, "0"));
        let negative = mantissa.starts_with('-');
        let power: i32 = power.parse().unwrap_or(0);
        let mut digits: Vec<u8> = mantissa
            .bytes()
            .filter(u8::is_ascii_digit)
            .map(|byte| byte - b'0')
            .collect();
        while digits.first() == Some(&0) {
            digits.remove(0);
        }
        let mut decimal = Self {
            negative,
            digits,
            exponent: power + 1,
        };
        if decimal.digits.len() > SIGNIFICANT {
            let up = decimal.digits[SIGNIFICANT] >= 5;
            decimal.digits.truncate(SIGNIFICANT);
            if up {
                decimal.carry();
            }
        }
        decimal.trim();
        decimal
    }

    /// Add one to the last digit.
    fn carry(&mut self) {
        let mut at = self.digits.len();
        loop {
            if at == 0 {
                self.digits.insert(0, 1);
                self.exponent += 1;
                return;
            }
            at -= 1;
            if self.digits[at] == 9 {
                self.digits[at] = 0;
            } else {
                self.digits[at] += 1;
                return;
            }
        }
    }

    fn trim(&mut self) {
        while self.digits.last() == Some(&0) {
            self.digits.pop();
        }
        if self.digits.is_empty() {
            self.negative = false;
            self.exponent = 0;
        }
    }

    /// Rounded to `places` decimal places (negative: to tens, hundreds…).
    fn round(&self, places: i32, mode: Mode) -> Self {
        let keep = self.exponent + places;
        let tail_nonzero = |from: usize| self.digits.iter().skip(from).any(|digit| *digit != 0);
        if keep <= 0 {
            // Every digit is past the place rounded to.
            let up = match mode {
                Mode::Round => keep == 0 && self.digits.first().is_some_and(|digit| *digit >= 5),
                Mode::Ceil => !self.negative && tail_nonzero(0),
                Mode::Floor => self.negative && tail_nonzero(0),
            };
            return if up {
                Self {
                    negative: self.negative,
                    digits: vec![1],
                    exponent: 1 - places,
                }
            } else {
                Self {
                    negative: false,
                    digits: Vec::new(),
                    exponent: 0,
                }
            };
        }
        // `keep` is positive here.
        #[allow(clippy::cast_sign_loss)]
        let keep = keep as usize;
        if keep >= self.digits.len() {
            return self.clone();
        }
        let up = match mode {
            Mode::Round => self.digits[keep] >= 5,
            Mode::Ceil => !self.negative && tail_nonzero(keep),
            Mode::Floor => self.negative && tail_nonzero(keep),
        };
        let mut out = Self {
            negative: self.negative,
            digits: self.digits[..keep].to_vec(),
            exponent: self.exponent,
        };
        if up {
            out.carry();
        }
        out.trim();
        out
    }

    fn to_f64(&self) -> f64 {
        if self.digits.is_empty() {
            return 0.0;
        }
        let digits: String = self
            .digits
            .iter()
            .map(|digit| char::from(b'0' + digit))
            .collect();
        let length = i32::try_from(self.digits.len()).unwrap_or(i32::MAX);
        let written = format!(
            "{}{digits}e{}",
            if self.negative { "-" } else { "" },
            self.exponent - length
        );
        written.parse().unwrap_or(0.0)
    }
}

fn rounded(value: f64, digits: i32, mode: Mode) -> Result<f64, FormulaError> {
    finite(Decimal::of(finite(value)?).round(digits, mode).to_f64())
}

/// `value` written for a person: grouped thousands with commas, a point for decimals, `decimals`
/// places exactly, or when `None` up to two with trailing zeros left off. `None` for a number that
/// can't be written exactly: not finite, or 10¹⁵ and over.
pub(crate) fn display(value: f64, decimals: Option<u8>) -> Option<String> {
    if !value.is_finite() {
        return None;
    }
    let places = decimals.unwrap_or(2).min(MAX_DECIMALS);
    let rounded = Decimal::of(value).round(i32::from(places), Mode::Round);
    if rounded.exponent >= WRITTEN_BELOW {
        return None;
    }
    let digit = |at: i32| -> char {
        usize::try_from(at)
            .ok()
            .and_then(|at| rounded.digits.get(at))
            .map_or('0', |digit| char::from(b'0' + digit))
    };
    let whole: String = if rounded.exponent <= 0 {
        "0".to_owned()
    } else {
        (0..rounded.exponent).map(digit).collect()
    };
    let mut fraction: String = (0..i32::from(places))
        .map(|place| digit(rounded.exponent + place))
        .collect();
    if decimals.is_none() {
        while fraction.ends_with('0') {
            fraction.pop();
        }
    }
    let mut out = String::new();
    if rounded.negative && !rounded.digits.is_empty() {
        out.push('-');
    }
    out.push_str(&grouped(&whole));
    if !fraction.is_empty() {
        out.push('.');
        out.push_str(&fraction);
    }
    Some(out)
}

fn grouped(whole: &str) -> String {
    let mut out = String::new();
    for (at, character) in whole.chars().enumerate() {
        if at > 0 && (whole.len() - at).is_multiple_of(3) {
            out.push(',');
        }
        out.push(character);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn cases() -> Value {
        serde_json::from_str(include_str!("../../../../schemas/formula.cases.json"))
            .expect("schemas/formula.cases.json holds the cases")
    }

    #[test]
    #[allow(clippy::float_cmp)]
    fn every_formula_case_works_out_as_the_app_does() {
        let cases = cases();
        let evaluate_cases = cases["evaluate"].as_array().expect("evaluate cases");
        assert!(evaluate_cases.len() > 40, "the cases are all read");
        for case in evaluate_cases {
            let name = case["name"].as_str().unwrap_or_default();
            let formula = case["formula"].as_str().expect("a formula");
            let values: BTreeMap<String, f64> = case["values"]
                .as_object()
                .expect("values")
                .iter()
                .map(|(key, value)| (key.clone(), value.as_f64().expect("a number")))
                .collect();
            let got = evaluate(formula, &values);
            if let Some(expected) = case["result"].as_f64() {
                let got = got.unwrap_or_else(|error| panic!("{name}: {formula} failed: {error}"));
                assert_eq!(got, expected, "{name}: {formula}");
            } else {
                let expected = case["error"].as_str().expect("a result or an error");
                let error = got.expect_err(&format!("{name}: {formula} should fail"));
                assert_eq!(error.kind.code(), expected, "{name}: {formula}: {error}");
                assert!(
                    !error.message.is_empty(),
                    "{name}: the error says what to change"
                );
            }
        }
    }

    #[test]
    fn every_number_is_written_as_the_app_writes_it() {
        let cases = cases();
        for case in cases["display"].as_array().expect("display cases") {
            let value = case["value"].as_f64().expect("a value");
            let decimals = case["decimals"]
                .as_u64()
                .map(|places| u8::try_from(places).expect("a few places"));
            let expected = case["text"].as_str();
            assert_eq!(
                display(value, decimals).as_deref(),
                expected,
                "{value} with {decimals:?} decimals"
            );
        }
    }

    #[test]
    fn every_note_is_filled_in_as_the_app_fills_it() {
        let cases = cases();
        let notes = cases["notes"].as_array().expect("note cases");
        assert!(notes.len() > 5, "the note cases are all read");
        for case in notes {
            let name = case["name"].as_str().unwrap_or_default();
            let note = case["note"].as_str().expect("a note");
            let values: BTreeMap<String, f64> = case["values"]
                .as_object()
                .expect("values")
                .iter()
                .map(|(key, value)| (key.clone(), value.as_f64().expect("a number")))
                .collect();
            let got = parse_note(note).and_then(|read| read.fill(&values));
            if let Some(expected) = case["text"].as_str() {
                let got = got.unwrap_or_else(|error| panic!("{name}: {note} failed: {error}"));
                assert_eq!(got, expected, "{name}: {note}");
            } else {
                let expected = case["error"].as_str().expect("a text or an error");
                let error = got.expect_err(&format!("{name}: {note} should fail"));
                assert_eq!(error.kind.code(), expected, "{name}: {note}: {error}");
            }
        }
    }

    #[test]
    fn a_brace_inside_braces_says_to_close_the_first() {
        let error = parse_note("{a {b}}").unwrap_err();
        assert_eq!(error.message, "a { in a note needs a } after its formula");
    }

    #[test]
    fn a_note_names_what_its_formulas_read_once_each() {
        let note = parse_note("{found} of {total} found, {found / total * 100}%").unwrap();
        assert_eq!(note.names(), ["found", "total"]);
    }

    #[test]
    fn a_formula_names_what_it_reads_once_each() {
        let formula = parse("if(round_up, ceil(total / pupils, -4), total / pupils)").unwrap();
        assert_eq!(formula.names(), ["round_up", "total", "pupils"]);
    }

    #[test]
    fn the_branch_not_taken_may_divide_by_zero() {
        let values = BTreeMap::from([("pupils".to_owned(), 0.0)]);
        assert_eq!(
            evaluate("if(pupils == 0, 0, 100 / pupils)", &values),
            Ok(0.0)
        );
    }

    #[test]
    fn a_formula_too_long_says_so() {
        let long = "1+".repeat(200) + "1";
        assert_eq!(
            parse(&long).unwrap_err().kind,
            ErrorKind::TooLong,
            "past {MAX_FORMULA_CHARS} characters"
        );
    }
}
