//! Widgets: working parts an answer can hold under its words (ADR 0114).
//!
//! The agent whose reply is the answer calls the Team Bus tool `show_widget` before it writes that
//! answer. `LoomWatch` checks the widget here, works out a calculator's results, and tells the agent
//! them, so its words use `LoomWatch`'s numbers. When the run succeeds, the widgets of the turn whose
//! reply became the answer are kept with it ([`of_answer`], [`store`]); what the person ticks or
//! changes is kept beside them, and the next run's conversation says so ([`showed`], [`changes`]).
//!
//! Four kinds, drawn by the app (`ui/src/components/chat/widgets/`): choices the person taps to
//! reply, a checklist they tick, a calculator whose results `LoomWatch` works out as they change its
//! inputs ([`formula`]), and steps they tap through. The agent never draws or writes markup.

pub(crate) mod formula;
pub(crate) mod store;

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::prompt_blocks::Block;
use crate::{EventKind, RunEvent};

/// Whether an agent with no `widgets` setting may show widgets. Off until the bench shows answers
/// that need none are no worse with the tool offered (ADR 0114, decision 7); turning it on is this
/// line.
pub(crate) const DEFAULT_ON: bool = false;

/// The Team Bus tool's name.
pub(crate) const TOOL: &str = "show_widget";

/// The most widgets under one answer: past it, the last ones shown.
pub(crate) const MOST_PER_ANSWER: usize = 4;

/// How much a widget may hold. Generous, and checked here rather than by the provider, which
/// doesn't enforce a tool's schema.
pub(crate) mod limits {
    pub(crate) const TITLE_CHARS: usize = 80;
    pub(crate) const OPTIONS: (usize, usize) = (2, 6);
    pub(crate) const OPTION_CHARS: usize = 80;
    pub(crate) const DETAIL_CHARS: usize = 160;
    pub(crate) const ITEMS: (usize, usize) = (1, 20);
    pub(crate) const ITEM_CHARS: usize = 160;
    pub(crate) const NOTE_CHARS: usize = 24;
    pub(crate) const INPUTS: (usize, usize) = (1, 8);
    pub(crate) const RESULTS: (usize, usize) = (1, 4);
    pub(crate) const LABEL_CHARS: usize = 60;
    pub(crate) const UNIT_CHARS: usize = 12;
    pub(crate) const ID_CHARS: usize = 24;
    pub(crate) const STEPS: (usize, usize) = (2, 8);
    pub(crate) const STEP_LABEL_CHARS: usize = 40;
    pub(crate) const STEP_CHARS: usize = 320;
    /// What the next run's conversation says of the person's changes under one answer.
    pub(crate) const CHANGES_CHARS: usize = 400;
}

/// One widget, as the agent asked for it and `LoomWatch` checked it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum Widget {
    Choices {
        title: String,
        options: Vec<Choice>,
    },
    Checklist {
        title: String,
        items: Vec<Item>,
    },
    Calculator {
        title: String,
        inputs: Vec<Input>,
        results: Vec<Figure>,
    },
    Steps {
        title: String,
        steps: Vec<Step>,
        #[serde(default, skip_serializing_if = "is_false")]
        repeats: bool,
    },
}

// serde's `skip_serializing_if` passes a reference.
#[allow(clippy::trivially_copy_pass_by_ref)]
fn is_false(value: &bool) -> bool {
    !value
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Choice {
    pub(crate) label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Item {
    pub(crate) text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) note: Option<String>,
}

/// A calculator's input: a number (`start`) or a switch (`on`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Input {
    pub(crate) id: String,
    pub(crate) label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) start: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) on: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) unit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) prefix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) min: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) max: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) step: Option<f64>,
}

impl Input {
    fn is_switch(&self) -> bool {
        self.on.is_some()
    }
}

/// A calculator's result: a figure `LoomWatch` works out.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Figure {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) formula: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) unit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) prefix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) decimals: Option<u8>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Step {
    pub(crate) label: String,
    pub(crate) text: String,
}

impl Widget {
    pub(crate) fn title(&self) -> &str {
        match self {
            Self::Choices { title, .. }
            | Self::Checklist { title, .. }
            | Self::Calculator { title, .. }
            | Self::Steps { title, .. } => title,
        }
    }

    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Self::Choices { .. } => "choices",
            Self::Checklist { .. } => "checklist",
            Self::Calculator { .. } => "calculator",
            Self::Steps { .. } => "steps",
        }
    }

    /// "a calculator "Zoo trip"": what it is, in words.
    fn named(&self) -> String {
        let what = match self {
            Self::Choices { .. } => "choices",
            Self::Checklist { .. } => "a checklist",
            Self::Calculator { .. } => "a calculator",
            Self::Steps { .. } => "steps",
        };
        format!("{what} \"{}\"", self.title())
    }
}

// ---------------------------------------------------------------------------------------------
// Reading what the agent asked for
// ---------------------------------------------------------------------------------------------

/// The widget `arguments` ask for, checked; or what to change, for the agent.
///
/// # Errors
///
/// A widget that breaks a limit, a formula that can't be read or worked out, or a field its kind
/// needs that is missing.
pub(crate) fn read(arguments: &Value) -> Result<Widget, String> {
    let kind = text(arguments, "kind", 1, 20)?;
    let title = text(arguments, "title", 1, limits::TITLE_CHARS)?;
    let widget = match kind.as_str() {
        "choices" => Widget::Choices {
            options: list(arguments, "options", limits::OPTIONS, |option| {
                Ok(Choice {
                    label: text(option, "label", 1, limits::OPTION_CHARS)?,
                    detail: optional_text(option, "detail", limits::DETAIL_CHARS)?,
                })
            })?,
            title,
        },
        "checklist" => Widget::Checklist {
            items: list(arguments, "items", limits::ITEMS, |item| {
                Ok(Item {
                    text: text(item, "text", 1, limits::ITEM_CHARS)?,
                    note: optional_text(item, "note", limits::NOTE_CHARS)?,
                })
            })?,
            title,
        },
        "calculator" => {
            let inputs = list(arguments, "inputs", limits::INPUTS, read_input)?;
            let results = list(arguments, "results", limits::RESULTS, |figure| {
                Ok(Figure {
                    id: id(figure)?,
                    label: text(figure, "label", 1, limits::LABEL_CHARS)?,
                    formula: text(figure, "formula", 1, formula::MAX_FORMULA_CHARS)?,
                    unit: optional_text(figure, "unit", limits::UNIT_CHARS)?,
                    prefix: optional_text(figure, "prefix", limits::UNIT_CHARS)?,
                    decimals: match figure.get("decimals") {
                        None | Some(Value::Null) => None,
                        Some(decimals) => Some(
                            decimals
                                .as_u64()
                                .and_then(|places| u8::try_from(places).ok())
                                .filter(|places| *places <= formula::MAX_DECIMALS)
                                .ok_or_else(|| {
                                    format!(
                                        "a result's decimals is a whole number from 0 to {}",
                                        formula::MAX_DECIMALS
                                    )
                                })?,
                        ),
                    },
                })
            })?;
            let widget = Widget::Calculator {
                title,
                inputs,
                results,
            };
            check_calculator(&widget)?;
            widget
        }
        "steps" => Widget::Steps {
            steps: list(arguments, "steps", limits::STEPS, |step| {
                Ok(Step {
                    label: text(step, "label", 1, limits::STEP_LABEL_CHARS)?,
                    text: text(step, "text", 1, limits::STEP_CHARS)?,
                })
            })?,
            repeats: match arguments.get("repeats") {
                None | Some(Value::Null) => false,
                Some(Value::Bool(repeats)) => *repeats,
                Some(_) => return Err("repeats is true or false".to_owned()),
            },
            title,
        },
        other => {
            return Err(format!(
                "kind \"{other}\" isn't a widget: use choices, checklist, calculator or steps"
            ));
        }
    };
    Ok(widget)
}

fn text(value: &Value, field: &str, least: usize, most: usize) -> Result<String, String> {
    let Some(written) = value.get(field).and_then(Value::as_str) else {
        return Err(format!("{field} is missing: give it as text"));
    };
    let written = written.trim();
    let length = written.chars().count();
    if length < least {
        return Err(format!("{field} is empty"));
    }
    if length > most {
        return Err(format!("{field} is {length} characters; keep it to {most}"));
    }
    Ok(written.to_owned())
}

fn optional_text(value: &Value, field: &str, most: usize) -> Result<Option<String>, String> {
    match value.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(written)) if written.trim().is_empty() => Ok(None),
        Some(_) => text(value, field, 1, most).map(Some),
    }
}

fn number(value: &Value, field: &str) -> Result<Option<f64>, String> {
    match value.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(number) => number
            .as_f64()
            .filter(|number| number.is_finite())
            .map(Some)
            .ok_or_else(|| format!("{field} is a number")),
    }
}

fn list<T>(
    value: &Value,
    field: &str,
    (least, most): (usize, usize),
    read_one: impl Fn(&Value) -> Result<T, String>,
) -> Result<Vec<T>, String> {
    let Some(entries) = value.get(field).and_then(Value::as_array) else {
        return Err(format!("{field} is missing: give {least} to {most}"));
    };
    if entries.len() < least || entries.len() > most {
        return Err(format!(
            "{field} has {}; give {least} to {most}",
            entries.len()
        ));
    }
    entries
        .iter()
        .enumerate()
        .map(|(at, entry)| read_one(entry).map_err(|error| format!("{field} {}: {error}", at + 1)))
        .collect()
}

fn id(value: &Value) -> Result<String, String> {
    let id = text(value, "id", 1, limits::ID_CHARS)?;
    let mut chars = id.chars();
    let starts_well = chars.next().is_some_and(|first| first.is_ascii_lowercase());
    if !starts_well || !chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_') {
        return Err(format!(
            "id \"{id}\" must start with a lowercase letter and hold only lowercase letters, \
             digits and _"
        ));
    }
    if formula::is_function(&id) {
        return Err(format!(
            "id \"{id}\" is the name of a function: call it something else"
        ));
    }
    Ok(id)
}

fn read_input(value: &Value) -> Result<Input, String> {
    let input = Input {
        id: id(value)?,
        label: text(value, "label", 1, limits::LABEL_CHARS)?,
        start: number(value, "start")?,
        on: match value.get("on") {
            None | Some(Value::Null) => None,
            Some(Value::Bool(on)) => Some(*on),
            Some(_) => return Err("on is true or false".to_owned()),
        },
        unit: optional_text(value, "unit", limits::UNIT_CHARS)?,
        prefix: optional_text(value, "prefix", limits::UNIT_CHARS)?,
        min: number(value, "min")?,
        max: number(value, "max")?,
        step: number(value, "step")?,
    };
    match (input.start, input.on) {
        (Some(_), Some(_)) => {
            return Err("give start for a number or on for a switch, not both".to_owned());
        }
        (None, None) => {
            return Err("give start for a number, or on (true or false) for a switch".to_owned());
        }
        _ => {}
    }
    if let Some(start) = input.start {
        if input.min.is_some_and(|min| start < min) || input.max.is_some_and(|max| start > max) {
            return Err("start is outside min and max".to_owned());
        }
        if let (Some(min), Some(max)) = (input.min, input.max)
            && min > max
        {
            return Err("min is more than max".to_owned());
        }
    }
    if input.step.is_some_and(|step| step <= 0.0) {
        return Err("step is more than 0".to_owned());
    }
    Ok(input)
}

/// Every id once, every formula read, reading only inputs and the results above it, and worked
/// out with the starting values.
fn check_calculator(widget: &Widget) -> Result<(), String> {
    let Widget::Calculator {
        inputs, results, ..
    } = widget
    else {
        return Ok(());
    };
    let mut known: BTreeSet<&str> = BTreeSet::new();
    for id in inputs.iter().map(|input| input.id.as_str()) {
        if !known.insert(id) {
            return Err(format!("id \"{id}\" is used twice"));
        }
    }
    for figure in results {
        let read = formula::parse(&figure.formula)
            .map_err(|error| format!("result \"{}\": {error}", figure.label))?;
        for name in read.names() {
            if !known.contains(name.as_str()) {
                let can = known.iter().copied().collect::<Vec<_>>().join(", ");
                return Err(format!(
                    "result \"{}\" reads \"{name}\", which isn't an input or a result above it; \
                     it can read {can}",
                    figure.label
                ));
            }
        }
        if !known.insert(figure.id.as_str()) {
            return Err(format!("id \"{}\" is used twice", figure.id));
        }
    }
    work_out(widget, None)
        .map(|_| ())
        .map_err(|(label, error)| format!("result \"{label}\" with the starting values: {error}"))
}

// ---------------------------------------------------------------------------------------------
// A calculator's figures
// ---------------------------------------------------------------------------------------------

/// A calculator's input values: the starting ones, with the person's from `state` over them. A
/// switch is 1 when on.
fn values_of(inputs: &[Input], state: Option<&Value>) -> BTreeMap<String, f64> {
    let changed = state.and_then(|state| state.get("values"));
    inputs
        .iter()
        .map(|input| {
            let given = changed.and_then(|values| values.get(&input.id));
            let value = if input.is_switch() {
                let on = given.and_then(Value::as_bool).or(input.on).unwrap_or(false);
                if on { 1.0 } else { 0.0 }
            } else {
                given
                    .and_then(Value::as_f64)
                    .or(input.start)
                    .unwrap_or_default()
            };
            (input.id.clone(), value)
        })
        .collect()
}

/// A calculator's results with its inputs as in `state` (the starting values when `None`), each
/// as `(label, value)`; or the label of the first that can't be worked out, and why.
fn work_out(
    widget: &Widget,
    state: Option<&Value>,
) -> Result<Vec<(String, f64)>, (String, formula::FormulaError)> {
    let Widget::Calculator {
        inputs, results, ..
    } = widget
    else {
        return Ok(Vec::new());
    };
    let mut values = values_of(inputs, state);
    let mut out = Vec::new();
    for figure in results {
        let value = formula::evaluate(&figure.formula, &values)
            .map_err(|error| (figure.label.clone(), error))?;
        values.insert(figure.id.clone(), value);
        out.push((figure.label.clone(), value));
    }
    Ok(out)
}

/// A figure as the person reads it: "135,000 ₫", "$12.50".
fn written(value: f64, prefix: Option<&str>, unit: Option<&str>, decimals: Option<u8>) -> String {
    let number = formula::display(value, decimals).unwrap_or_else(|| "too large".to_owned());
    let mut out = String::new();
    if let Some(prefix) = prefix {
        out.push_str(prefix);
    }
    out.push_str(&number);
    if let Some(unit) = unit {
        out.push(' ');
        out.push_str(unit);
    }
    out
}

/// An input's value as the person reads it: a number with up to six decimals, or on / off.
// A switch's value is exactly 0 or 1.
#[allow(clippy::float_cmp)]
fn input_written(input: &Input, value: f64) -> String {
    if input.is_switch() {
        return if value == 0.0 { "off" } else { "on" }.to_owned();
    }
    let mut number = formula::display(value, Some(formula::MAX_DECIMALS))
        .unwrap_or_else(|| "too large".to_owned());
    if number.contains('.') {
        while number.ends_with('0') {
            number.pop();
        }
        if number.ends_with('.') {
            number.pop();
        }
    }
    written_around(&number, input.prefix.as_deref(), input.unit.as_deref())
}

fn written_around(number: &str, prefix: Option<&str>, unit: Option<&str>) -> String {
    format!(
        "{}{number}{}",
        prefix.unwrap_or_default(),
        unit.map(|unit| format!(" {unit}")).unwrap_or_default()
    )
}

/// "Each family pays = 135,000 ₫; Total = …": a calculator's results as `state` gives them.
fn results_line(widget: &Widget, state: Option<&Value>) -> Option<String> {
    let Widget::Calculator { results, .. } = widget else {
        return None;
    };
    let worked = work_out(widget, state).ok()?;
    Some(
        results
            .iter()
            .zip(worked)
            .map(|(figure, (label, value))| {
                format!(
                    "{label} = {}",
                    written(
                        value,
                        figure.prefix.as_deref(),
                        figure.unit.as_deref(),
                        figure.decimals
                    )
                )
            })
            .collect::<Vec<_>>()
            .join("; "),
    )
}

// ---------------------------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------------------------

/// What `show_widget` is for. Where it is called matters: words the agent writes in the same
/// message as a tool call are left out of its answer.
pub(crate) const SHOW_WIDGET: Block = Block::new(
    "bus.show_widget",
    "Put something the person can use under your answer, drawn by LoomWatch: choices they tap to \
     reply, a checklist they tick, a calculator whose results LoomWatch works out as they change \
     its inputs, or steps they tap through one at a time. Use one only when it helps more than \
     words: numbers they may want to change, a choice of what to do next, things for them to do, \
     or the steps of a process. For a simple answer, words alone are better. Call it before you \
     write your answer. Then write the answer in words: give the main result in a sentence, since \
     a copy of the answer and the phone show only your words, and call what you showed by what it \
     is, such as \"the calculator below\".",
);

/// `show_widget`'s `kind`.
pub(crate) const SHOW_WIDGET_KIND: Block = Block::new(
    "bus.show_widget.kind",
    "choices, checklist, calculator or steps. Fill in only that kind's fields.",
);

/// `show_widget`'s `options`.
pub(crate) const SHOW_WIDGET_OPTIONS: Block = Block::new(
    "bus.show_widget.options",
    "choices: 2 to 6 replies the person may tap. A tap sends the label as their message, so write \
     it as they would say it.",
);

/// A calculator result's `formula`.
pub(crate) const SHOW_WIDGET_FORMULA: Block = Block::new(
    "bus.show_widget.formula",
    "Worked out by LoomWatch from the inputs and the results above this one, by id: numbers, + - \
     * / and brackets, one comparison (< <= > >= == !=, giving 1 or 0), min, max, round(x, \
     digits), ceil(x, digits), floor(x, digits), abs, if(condition, then, else), and, or, not. A \
     switch is 1 when on. Digits may be negative: ceil(x, -4) rounds up to the nearest 10,000.",
);

/// What `show_widget` answers with, beside a calculator's results.
pub(crate) const SHOW_WIDGET_SHOWN: Block = Block::new(
    "bus.show_widget.shown",
    "It shows under your answer. Now write your answer in words: the main result in a sentence, \
     and what you showed called by what it is, without repeating all of it. Up to 4 show under one \
     answer.",
);

/// The tool, as the Team Bus offers it. One schema literal, read top to bottom.
#[allow(clippy::too_many_lines)]
pub(crate) fn tool_definition() -> Value {
    let id = json!({"type": "string", "description": "Lowercase letters, digits and _, used in formulas", "minLength": 1});
    let label =
        json!({"type": "string", "description": "A few words the person reads", "minLength": 1});
    let unit =
        json!({"type": "string", "description": "Written after the number, such as ₫, km or %"});
    let prefix = json!({"type": "string", "description": "Written before the number, such as $"});
    json!({
        "name": TOOL,
        "description": SHOW_WIDGET.text(),
        "inputSchema": {
            "type": "object",
            "properties": {
                "kind": {
                    "type": "string",
                    "description": SHOW_WIDGET_KIND.text(),
                    "enum": ["choices", "checklist", "calculator", "steps"]
                },
                "title": {
                    "type": "string",
                    "description": "A few words above it, such as \"Zoo trip: cost per family\"",
                    "minLength": 1
                },
                "options": {
                    "type": "array",
                    "description": SHOW_WIDGET_OPTIONS.text(),
                    "maxItems": limits::OPTIONS.1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": label,
                            "detail": {"type": "string", "description": "A few more words under the label"}
                        },
                        "required": ["label"],
                        "additionalProperties": false
                    }
                },
                "items": {
                    "type": "array",
                    "description": "checklist: 1 to 20 things to do, in order",
                    "maxItems": limits::ITEMS.1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "text": {"type": "string", "description": "The thing to do", "minLength": 1},
                            "note": {"type": "string", "description": "A few words beside it, such as a day"}
                        },
                        "required": ["text"],
                        "additionalProperties": false
                    }
                },
                "inputs": {
                    "type": "array",
                    "description": "calculator: up to 8 values the person can change. A number has start, and may have unit, prefix, min, max and step; a switch has on instead",
                    "maxItems": limits::INPUTS.1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": id,
                            "label": label,
                            "start": {"type": "number", "description": "A number's starting value"},
                            "on": {"type": "boolean", "description": "A switch's starting value"},
                            "unit": unit,
                            "prefix": prefix,
                            "min": {"type": "number", "description": "The least it may be"},
                            "max": {"type": "number", "description": "The most it may be"},
                            "step": {"type": "number", "description": "How much one press changes it"}
                        },
                        "required": ["id", "label"],
                        "additionalProperties": false
                    }
                },
                "results": {
                    "type": "array",
                    "description": "calculator: 1 to 4 figures LoomWatch works out, in order",
                    "maxItems": limits::RESULTS.1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": id,
                            "label": label,
                            "formula": {"type": "string", "description": SHOW_WIDGET_FORMULA.text(), "minLength": 1},
                            "unit": unit,
                            "prefix": prefix,
                            "decimals": {"type": "integer", "description": "Decimal places shown; without it, up to 2", "minimum": 0, "maximum": formula::MAX_DECIMALS}
                        },
                        "required": ["id", "label", "formula"],
                        "additionalProperties": false
                    }
                },
                "steps": {
                    "type": "array",
                    "description": "steps: 2 to 8, in order, each a short label and a sentence or two",
                    "maxItems": limits::STEPS.1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": {"type": "string", "description": "A word or two", "minLength": 1},
                            "text": {"type": "string", "description": "What happens at this step", "minLength": 1}
                        },
                        "required": ["label", "text"],
                        "additionalProperties": false
                    }
                },
                "repeats": {"type": "boolean", "description": "steps: true when the last step leads back to the first, as in a cycle"}
            },
            "required": ["kind", "title"],
            "additionalProperties": false
        }
    })
}

/// What the agent is told when its widget is shown: what it is, a calculator's results with the
/// starting values, and to write the answer now.
pub(crate) fn shown(widget: &Widget) -> Value {
    let mut out = json!({"shown": widget.named()});
    if let Some(results) = results_line(widget, None) {
        out["results"] = json!(results);
    }
    out["next"] = json!(SHOW_WIDGET_SHOWN.text());
    out
}

// ---------------------------------------------------------------------------------------------
// The answer's widgets, at the end of a run
// ---------------------------------------------------------------------------------------------

/// The widgets of `responder`'s answer: the `show_widget` calls that went through in the turn
/// whose reply became the answer, or, when that turn showed none, in the latest earlier turn of
/// work in the same session that did (a revision after a check sent the work back, an answer after
/// a question). The last [`MOST_PER_ANSWER`].
///
/// Turns are read as [`crate::runs`]' `last_words` reads them: by agent and session, starting at
/// each prompt, with the coordinator's checkpoints and handovers skipped.
pub(crate) fn of_answer(events: &[RunEvent], responder: Option<&str>) -> Vec<Widget> {
    #[derive(Default)]
    struct Turns {
        current: Vec<Widget>,
        earlier: Vec<Widget>,
    }
    let Some(responder) = responder else {
        return Vec::new();
    };
    let mut bookkeeping = false;
    let mut session = String::new();
    let mut turns: BTreeMap<String, Turns> = BTreeMap::new();
    // The calls asked for, by call id, until their update says how they went.
    let mut asked: BTreeMap<String, (String, Value)> = BTreeMap::new();
    for event in events.iter().filter(|event| event.agent_id == responder) {
        if let Some(named) = event
            .raw
            .as_ref()
            .and_then(|raw| raw.pointer("/params/sessionId"))
            .and_then(Value::as_str)
        {
            named.clone_into(&mut session);
        }
        match event.kind {
            EventKind::SessionMeta if event.payload["phase"] == "turn_purpose" => {
                bookkeeping = event.payload["purpose"] != "work";
            }
            _ if bookkeeping => {}
            EventKind::Message if event.payload["role"] == "user" => {
                let turn = turns.entry(session.clone()).or_default();
                if !turn.current.is_empty() {
                    turn.earlier = std::mem::take(&mut turn.current);
                }
            }
            EventKind::ToolCall if event.payload["name"] == TOOL => {
                if let Some(call) = event.payload["callId"].as_str() {
                    asked.insert(
                        call.to_owned(),
                        (session.clone(), event.payload["rawInput"].clone()),
                    );
                }
            }
            EventKind::ToolUpdate if event.payload["status"] == "completed" => {
                let call = event.payload["callId"].as_str().unwrap_or_default();
                if let Some((at, arguments)) = asked.remove(call)
                    && let Ok(widget) = read(&arguments)
                {
                    turns.entry(at).or_default().current.push(widget);
                }
            }
            _ => {}
        }
    }
    let Some(turn) = turns.remove(&session) else {
        return Vec::new();
    };
    let mut widgets = if turn.current.is_empty() {
        turn.earlier
    } else {
        turn.current
    };
    let extra = widgets.len().saturating_sub(MOST_PER_ANSWER);
    widgets.drain(..extra);
    widgets
}

// ---------------------------------------------------------------------------------------------
// What the person changes
// ---------------------------------------------------------------------------------------------

/// `state` for `widget`, checked: a checklist's ticks (`{"checked": [true, false, …]}`, one per
/// item) or a calculator's values (`{"values": {"pupils": 30, "round_up": true}}`, any of its
/// inputs). Choices and steps keep nothing.
///
/// # Errors
///
/// State the widget doesn't take, or a value outside its input's min and max.
pub(crate) fn read_state(widget: &Widget, state: &Value) -> Result<Value, String> {
    match widget {
        Widget::Checklist { items, .. } => {
            let checked = state
                .get("checked")
                .and_then(Value::as_array)
                .ok_or("a checklist's state is {\"checked\": [true or false, one per item]}")?;
            if checked.len() != items.len() || !checked.iter().all(Value::is_boolean) {
                return Err(format!(
                    "a checklist's state has {} true or false, one per item",
                    items.len()
                ));
            }
            Ok(json!({"checked": checked}))
        }
        Widget::Calculator { inputs, .. } => {
            let values = state
                .get("values")
                .and_then(Value::as_object)
                .ok_or("a calculator's state is {\"values\": {input id: value}}")?;
            let mut kept = serde_json::Map::new();
            for (id, value) in values {
                let input = inputs
                    .iter()
                    .find(|input| &input.id == id)
                    .ok_or_else(|| format!("\"{id}\" isn't one of the calculator's inputs"))?;
                if input.is_switch() {
                    if !value.is_boolean() {
                        return Err(format!("\"{id}\" is a switch: true or false"));
                    }
                } else {
                    let number = value
                        .as_f64()
                        .filter(|number| number.is_finite())
                        .ok_or_else(|| format!("\"{id}\" is a number"))?;
                    if input.min.is_some_and(|min| number < min)
                        || input.max.is_some_and(|max| number > max)
                    {
                        return Err(format!("\"{id}\" is outside its min and max"));
                    }
                }
                kept.insert(id.clone(), value.clone());
            }
            Ok(json!({"values": kept}))
        }
        Widget::Choices { .. } | Widget::Steps { .. } => {
            Err("choices and steps keep nothing".to_owned())
        }
    }
}

/// A widget kept with a run's answer, and what the person last made of it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Kept {
    /// Its place under the answer, from 1.
    pub n: u32,
    pub(crate) spec: Widget,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changed_at: Option<String>,
}

/// The first line of an answer that showed widgets, in the next run's conversation: what they
/// were, with a calculator's starting results, so the 600-character cut of an older answer keeps
/// it.
pub(crate) fn showed(widgets: &[Kept]) -> Option<String> {
    if widgets.is_empty() {
        return None;
    }
    let each: Vec<String> = widgets
        .iter()
        .map(|kept| match &kept.spec {
            Widget::Choices { options, .. } => format!(
                "{} ({})",
                kept.spec.named(),
                options
                    .iter()
                    .map(|option| option.label.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            Widget::Checklist { items, .. } => format!(
                "{} ({} item{})",
                kept.spec.named(),
                items.len(),
                if items.len() == 1 { "" } else { "s" }
            ),
            Widget::Calculator { .. } => match results_line(&kept.spec, None) {
                Some(results) => format!("{} ({results})", kept.spec.named()),
                None => kept.spec.named(),
            },
            Widget::Steps { steps, .. } => format!("{} ({} steps)", kept.spec.named(), steps.len()),
        })
        .collect();
    Some(format!("[Under this answer: {}.]", each.join("; ")))
}

/// What `person` changed in the widgets under work `work`'s answer at or before `before` (RFC
/// 3339), in a line of about [`limits::CHANGES_CHARS`]: "Mai changed what is under the answer of
/// work 3f2a9c1e: "Zoo trip": Pupils 25, … → Each family pays = 160,000 ₫. In "Before Wednesday",
/// ticked: Print 32 copies (of 2)."
pub(crate) fn changes(person: &str, work: &str, widgets: &[Kept], before: &str) -> Option<String> {
    let parts: Vec<String> = widgets
        .iter()
        .filter(|kept| kept.changed_at.as_deref().is_some_and(|at| at <= before))
        .filter_map(|kept| change(&kept.spec, kept.state.as_ref()?))
        .collect();
    if parts.is_empty() {
        return None;
    }
    let mut line = format!("{person} changed what is under the answer of work {work}:");
    for (at, part) in parts.iter().enumerate() {
        let candidate = format!(" {part}");
        if line.chars().count() + candidate.chars().count() > limits::CHANGES_CHARS {
            let _ = write!(line, " And {} more.", parts.len() - at);
            break;
        }
        line.push_str(&candidate);
    }
    Some(line)
}

fn change(widget: &Widget, state: &Value) -> Option<String> {
    match widget {
        Widget::Calculator { inputs, .. } => {
            let values = values_of(inputs, Some(state));
            let set = inputs
                .iter()
                .map(|input| {
                    format!(
                        "{} {}",
                        input.label,
                        input_written(input, values.get(&input.id).copied().unwrap_or_default())
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            let results = results_line(widget, Some(state))
                .unwrap_or_else(|| "its results can't be worked out".to_owned());
            Some(format!("\"{}\": {set} → {results}.", widget.title()))
        }
        Widget::Checklist { items, .. } => {
            let checked = state.get("checked")?.as_array()?;
            let ticked: Vec<&str> = items
                .iter()
                .zip(checked)
                .filter(|(_, on)| on.as_bool() == Some(true))
                .map(|(item, _)| item.text.as_str())
                .collect();
            Some(if ticked.is_empty() {
                format!("In \"{}\", nothing is ticked.", widget.title())
            } else {
                format!(
                    "In \"{}\", ticked: {} (of {}).",
                    widget.title(),
                    ticked.join("; "),
                    items.len()
                )
            })
        }
        Widget::Choices { .. } | Widget::Steps { .. } => None,
    }
}

#[cfg(test)]
mod tests;
