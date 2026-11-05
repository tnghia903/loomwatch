//! Widgets: working parts an answer can hold under its words (ADR 0114).
//!
//! The agent whose reply is the answer calls the Team Bus tool `show_widget` before it writes that
//! answer. `LoomWatch` checks the widget here, works out a calculator's results, and tells the agent
//! them, so its words use `LoomWatch`'s numbers. When the run succeeds, the widgets of the turn whose
//! reply became the answer are kept with it ([`of_answer`], [`store`]); what the person ticks or
//! changes is kept beside them, and the next run's conversation says so ([`showed`], [`changes`]).
//!
//! Eight kinds, drawn by the app (`ui/src/components/chat/widgets/`): choices the person taps to
//! reply, a checklist they tick, a calculator whose results `LoomWatch` works out as they change its
//! inputs ([`formula`]), steps they tap through, and four to look at: a chart whose bars `LoomWatch`
//! draws to scale from the figures the agent gives, a graph of bars or a line over labels, a row of
//! things marked yes or no, and a flow of boxes and arrows. The agent never draws or writes markup.
//!
//! Each widget is told a place line, `{{widget N}}`, that the agent writes on its own line where the
//! widget belongs in its answer. When the run ends the line is taken out of the answer's words and
//! the widget keeps the line it stood before ([`place`]), so the words read whole everywhere else.

pub(crate) mod formula;
pub(crate) mod store;

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::prompt_blocks::Block;
use crate::{EventKind, RunEvent};

/// Whether an agent with no `widgets` setting may show widgets. On: an agent asked for something to
/// use, or for a chart, had no way to give one and drew bars in text or wrote a page instead. The
/// agent that answers is told to show its answer with one whenever one fits
/// (`agent::prompt::WIDGETS`), and `widgets: false` keeps an agent without it (ADR 0114, decision
/// 7, revisited).
pub(crate) const DEFAULT_ON: bool = true;

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
    pub(crate) const INPUTS: (usize, usize) = (1, 12);
    pub(crate) const RESULTS: (usize, usize) = (1, 4);
    pub(crate) const LABEL_CHARS: usize = 60;
    pub(crate) const UNIT_CHARS: usize = 12;
    pub(crate) const ID_CHARS: usize = 24;
    /// The words, and formulas, of the line under a result.
    pub(crate) const RESULT_NOTE_CHARS: usize = 80;
    pub(crate) const PRESETS: (usize, usize) = (0, 3);
    pub(crate) const STEPS: (usize, usize) = (2, 8);
    pub(crate) const STEP_LABEL_CHARS: usize = 40;
    pub(crate) const STEP_CHARS: usize = 320;
    pub(crate) const BARS: (usize, usize) = (2, 12);
    pub(crate) const CELLS: (usize, usize) = (1, 12);
    pub(crate) const CELL_CHARS: usize = 24;
    pub(crate) const FACTS: (usize, usize) = (0, 3);
    pub(crate) const FACT_CHARS: usize = 80;
    pub(crate) const BOXES: (usize, usize) = (2, 8);
    pub(crate) const BOX_LABEL_CHARS: usize = 40;
    pub(crate) const BOX_NOTE_CHARS: usize = 60;
    pub(crate) const POINTS: (usize, usize) = (2, 24);
    pub(crate) const POINT_CHARS: usize = 16;
    pub(crate) const SERIES: (usize, usize) = (1, 3);
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
        /// Buttons that set some inputs to a case worth trying.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        presets: Vec<Preset>,
    },
    Steps {
        title: String,
        steps: Vec<Step>,
        #[serde(default, skip_serializing_if = "is_false")]
        repeats: bool,
    },
    /// Bars drawn to scale from the agent's figures, one unit for all of them.
    Chart {
        title: String,
        bars: Vec<Bar>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        unit: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prefix: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        decimals: Option<u8>,
    },
    /// A row of things, each marked yes, no or neither, with facts under it. To look at.
    Marks {
        title: String,
        cells: Vec<Cell>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        facts: Vec<String>,
    },
    /// Boxes joined by arrows, in order. To look at.
    Flow {
        title: String,
        boxes: Vec<FlowBox>,
        #[serde(default, skip_serializing_if = "is_false")]
        repeats: bool,
    },
    /// A graph: bars or a line over labelled points, up to three series. To look at; tapping a
    /// point reads its values.
    Graph {
        title: String,
        style: GraphStyle,
        labels: Vec<String>,
        series: Vec<Series>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        unit: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prefix: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        decimals: Option<u8>,
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
    /// Switches next to each other with the same group are drawn as one row of boxes to tap,
    /// under the group's name, each box showing its switch's label.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) group: Option<String>,
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
    /// A short line under the figure saying why, its formulas in braces worked out as the inputs
    /// change: "{found} of 3 found".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) note: Option<String>,
}

/// A calculator's button that sets some inputs to a case worth trying.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Preset {
    pub(crate) label: String,
    /// Input id → a number, or true or false for a switch.
    pub(crate) values: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Step {
    pub(crate) label: String,
    pub(crate) text: String,
}

/// One bar of a chart: what it is and its figure, which may be below zero.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Bar {
    pub(crate) label: String,
    pub(crate) value: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) note: Option<String>,
}

/// One thing in a row of marks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Cell {
    pub(crate) label: String,
    pub(crate) mark: Mark,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) note: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Mark {
    Yes,
    No,
    Neither,
}

/// One box in a flow.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct FlowBox {
    pub(crate) label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) note: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum GraphStyle {
    Bar,
    Line,
}

/// One series of a graph: a value for each of its labels.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Series {
    pub(crate) label: String,
    pub(crate) values: Vec<f64>,
}

impl Widget {
    pub(crate) fn title(&self) -> &str {
        match self {
            Self::Choices { title, .. }
            | Self::Checklist { title, .. }
            | Self::Calculator { title, .. }
            | Self::Steps { title, .. }
            | Self::Chart { title, .. }
            | Self::Marks { title, .. }
            | Self::Flow { title, .. }
            | Self::Graph { title, .. } => title,
        }
    }

    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Self::Choices { .. } => "choices",
            Self::Checklist { .. } => "checklist",
            Self::Calculator { .. } => "calculator",
            Self::Steps { .. } => "steps",
            Self::Chart { .. } => "chart",
            Self::Marks { .. } => "marks",
            Self::Flow { .. } => "flow",
            Self::Graph { .. } => "graph",
        }
    }

    /// "a calculator "Zoo trip"": what it is, in words.
    fn named(&self) -> String {
        let what = match self {
            Self::Choices { .. } => "choices",
            Self::Checklist { .. } => "a checklist",
            Self::Calculator { .. } => "a calculator",
            Self::Steps { .. } => "steps",
            Self::Chart { .. } => "a chart",
            Self::Marks { .. } => "a row of marks",
            Self::Flow { .. } => "a flow",
            Self::Graph {
                style: GraphStyle::Bar,
                ..
            } => "a bar graph",
            Self::Graph {
                style: GraphStyle::Line,
                ..
            } => "a line graph",
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
        "calculator" => read_calculator(arguments, title)?,
        "marks" => read_marks(arguments, title)?,
        "flow" => Widget::Flow {
            boxes: list(arguments, "boxes", limits::BOXES, |each| {
                Ok(FlowBox {
                    label: text(each, "label", 1, limits::BOX_LABEL_CHARS)?,
                    note: optional_text(each, "note", limits::BOX_NOTE_CHARS)?,
                })
            })?,
            repeats: repeats(arguments)?,
            title,
        },
        "graph" => read_graph(arguments, title)?,
        "steps" => Widget::Steps {
            steps: list(arguments, "steps", limits::STEPS, |step| {
                Ok(Step {
                    label: text(step, "label", 1, limits::STEP_LABEL_CHARS)?,
                    text: text(step, "text", 1, limits::STEP_CHARS)?,
                })
            })?,
            repeats: repeats(arguments)?,
            title,
        },
        "chart" => Widget::Chart {
            bars: list(arguments, "bars", limits::BARS, |bar| {
                Ok(Bar {
                    label: text(bar, "label", 1, limits::LABEL_CHARS)?,
                    value: number(bar, "value")?.ok_or("value is missing: give it as a number")?,
                    note: optional_text(bar, "note", limits::NOTE_CHARS)?,
                })
            })?,
            unit: optional_text(arguments, "unit", limits::UNIT_CHARS)?,
            prefix: optional_text(arguments, "prefix", limits::UNIT_CHARS)?,
            decimals: decimals(arguments)?,
            title,
        },
        other => {
            return Err(format!(
                "kind \"{other}\" isn't a widget: use choices, checklist, calculator, steps, \
                 chart, graph, marks or flow"
            ));
        }
    };
    Ok(widget)
}

/// A calculator, read and checked.
fn read_calculator(arguments: &Value, title: String) -> Result<Widget, String> {
    let inputs = list(arguments, "inputs", limits::INPUTS, read_input)?;
    let results = list(arguments, "results", limits::RESULTS, |figure| {
        Ok(Figure {
            id: id(figure)?,
            label: text(figure, "label", 1, limits::LABEL_CHARS)?,
            formula: text(figure, "formula", 1, formula::MAX_FORMULA_CHARS)?,
            unit: optional_text(figure, "unit", limits::UNIT_CHARS)?,
            prefix: optional_text(figure, "prefix", limits::UNIT_CHARS)?,
            decimals: decimals(figure)?,
            note: optional_text(figure, "note", limits::RESULT_NOTE_CHARS)?,
        })
    })?;
    let presets = match arguments.get("presets") {
        None | Some(Value::Null) => Vec::new(),
        Some(_) => list(arguments, "presets", limits::PRESETS, |preset| {
            Ok(Preset {
                label: text(preset, "label", 1, limits::LABEL_CHARS)?,
                values: preset
                    .get("values")
                    .and_then(Value::as_object)
                    .filter(|values| !values.is_empty())
                    .cloned()
                    .ok_or("values is missing: give input id → value for each input it sets")?,
            })
        })?,
    };
    let widget = Widget::Calculator {
        title,
        inputs,
        results,
        presets,
    };
    check_calculator(&widget)?;
    Ok(widget)
}

/// A row of marks, read and checked.
fn read_marks(arguments: &Value, title: String) -> Result<Widget, String> {
    Ok(Widget::Marks {
        cells: list(arguments, "cells", limits::CELLS, |cell| {
            Ok(Cell {
                label: text(cell, "label", 1, limits::CELL_CHARS)?,
                mark: match cell.get("mark").and_then(Value::as_str) {
                    Some("yes") => Mark::Yes,
                    Some("no") => Mark::No,
                    Some("neither") => Mark::Neither,
                    _ => return Err("mark is yes, no or neither".to_owned()),
                },
                note: optional_text(cell, "note", limits::CELL_CHARS)?,
            })
        })?,
        facts: match arguments.get("facts") {
            None | Some(Value::Null) => Vec::new(),
            Some(_) => list(arguments, "facts", limits::FACTS, |fact| {
                let Some(fact) = fact.as_str().map(str::trim).filter(|fact| !fact.is_empty())
                else {
                    return Err("a fact is a few words".to_owned());
                };
                let length = fact.chars().count();
                if length > limits::FACT_CHARS {
                    return Err(format!(
                        "a fact is {length} characters; keep it to {}",
                        limits::FACT_CHARS
                    ));
                }
                Ok(fact.to_owned())
            })?,
        },
        title,
    })
}

fn repeats(arguments: &Value) -> Result<bool, String> {
    match arguments.get("repeats") {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(repeats)) => Ok(*repeats),
        Some(_) => Err("repeats is true or false".to_owned()),
    }
}

fn read_graph(arguments: &Value, title: String) -> Result<Widget, String> {
    let style = match arguments.get("style").and_then(Value::as_str) {
        Some("bar") => GraphStyle::Bar,
        Some("line") => GraphStyle::Line,
        _ => return Err("style is bar or line".to_owned()),
    };
    let labels = list(arguments, "labels", limits::POINTS, |label| {
        let Some(label) = label
            .as_str()
            .map(str::trim)
            .filter(|label| !label.is_empty())
        else {
            return Err("a label is a word or two".to_owned());
        };
        let length = label.chars().count();
        if length > limits::POINT_CHARS {
            return Err(format!(
                "a label is {length} characters; keep it to {}",
                limits::POINT_CHARS
            ));
        }
        Ok(label.to_owned())
    })?;
    let points = labels.len();
    let series = list(arguments, "series", limits::SERIES, |series| {
        let values = series
            .get("values")
            .and_then(Value::as_array)
            .ok_or_else(|| format!("values is missing: give {points} numbers, one per label"))?;
        if values.len() != points {
            return Err(format!(
                "values has {}; give {points}, one per label",
                values.len()
            ));
        }
        Ok(Series {
            label: text(series, "label", 1, limits::LABEL_CHARS)?,
            values: values
                .iter()
                .map(|value| {
                    value
                        .as_f64()
                        .filter(|value| value.is_finite())
                        .ok_or_else(|| "each value is a number".to_owned())
                })
                .collect::<Result<_, _>>()?,
        })
    })?;
    Ok(Widget::Graph {
        title,
        style,
        labels,
        series,
        unit: optional_text(arguments, "unit", limits::UNIT_CHARS)?,
        prefix: optional_text(arguments, "prefix", limits::UNIT_CHARS)?,
        decimals: decimals(arguments)?,
    })
}

/// `decimals`: the places a figure is shown with, from 0 to [`formula::MAX_DECIMALS`].
fn decimals(value: &Value) -> Result<Option<u8>, String> {
    match value.get("decimals") {
        None | Some(Value::Null) => Ok(None),
        Some(decimals) => decimals
            .as_u64()
            .and_then(|places| u8::try_from(places).ok())
            .filter(|places| *places <= formula::MAX_DECIMALS)
            .map(Some)
            .ok_or_else(|| {
                format!(
                    "decimals is a whole number from 0 to {}",
                    formula::MAX_DECIMALS
                )
            }),
    }
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
        group: optional_text(value, "group", limits::LABEL_CHARS)?,
    };
    if input.group.is_some() && input.on.is_none() {
        return Err("group is for switches; a number stands on its own".to_owned());
    }
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

/// Every id once, a group's switches next to each other, every formula and note read, reading
/// only inputs and the results above it (a note may read its own result too), every preset a
/// value its inputs take, and all worked out with the starting values and with each preset.
fn check_calculator(widget: &Widget) -> Result<(), String> {
    let Widget::Calculator {
        inputs,
        results,
        presets,
        ..
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
    let mut groups: Vec<&str> = Vec::new();
    for group in inputs.iter().filter_map(|input| input.group.as_deref()) {
        if groups.last() != Some(&group) {
            if groups.contains(&group) {
                return Err(format!(
                    "group \"{group}\": put its switches next to each other"
                ));
            }
            groups.push(group);
        }
    }
    let reads_known = |label: &str, names: Vec<String>, known: &BTreeSet<&str>, what: &str| {
        for name in names {
            if !known.contains(name.as_str()) {
                let can = known.iter().copied().collect::<Vec<_>>().join(", ");
                return Err(format!(
                    "result \"{label}\"{what} reads \"{name}\", which isn't an input or a result \
                     above it; it can read {can}"
                ));
            }
        }
        Ok(())
    };
    for figure in results {
        let read = formula::parse(&figure.formula)
            .map_err(|error| format!("result \"{}\": {error}", figure.label))?;
        reads_known(&figure.label, read.names(), &known, "")?;
        if !known.insert(figure.id.as_str()) {
            return Err(format!("id \"{}\" is used twice", figure.id));
        }
        if let Some(note) = &figure.note {
            let read = formula::parse_note(note)
                .map_err(|error| format!("result \"{}\"'s note: {error}", figure.label))?;
            reads_known(&figure.label, read.names(), &known, "'s note")?;
        }
    }
    for preset in presets {
        read_state(widget, &json!({"values": preset.values}))
            .map_err(|error| format!("preset \"{}\": {error}", preset.label))?;
    }
    work_out(widget, None)
        .map(|_| ())
        .map_err(|(label, error)| {
            format!("result \"{label}\" with the starting values: {error}")
        })?;
    for preset in presets {
        work_out(widget, Some(&json!({"values": preset.values}))).map_err(|(label, error)| {
            format!(
                "result \"{label}\" with preset \"{}\": {error}",
                preset.label
            )
        })?;
    }
    Ok(())
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

/// One result of a calculator, worked out.
struct Worked {
    label: String,
    value: f64,
    /// The line under it, filled in.
    note: Option<String>,
}

/// A calculator's results with its inputs as in `state` (the starting values when `None`); or the
/// label of the first that can't be worked out, and why.
fn work_out(
    widget: &Widget,
    state: Option<&Value>,
) -> Result<Vec<Worked>, (String, formula::FormulaError)> {
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
        let note = figure
            .note
            .as_deref()
            .map(|note| formula::parse_note(note).and_then(|note| note.fill(&values)))
            .transpose()
            .map_err(|error| (figure.label.clone(), error))?;
        out.push(Worked {
            label: figure.label.clone(),
            value,
            note,
        });
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

/// "Each family pays = 135,000 ₫; Found = 2 (2 of 3 found)": a calculator's results as `state`
/// gives them, each with its note.
fn results_line(widget: &Widget, state: Option<&Value>) -> Option<String> {
    let Widget::Calculator { results, .. } = widget else {
        return None;
    };
    let worked = work_out(widget, state).ok()?;
    Some(
        results
            .iter()
            .zip(worked)
            .map(|(figure, worked)| {
                let mut line = format!(
                    "{} = {}",
                    worked.label,
                    written(
                        worked.value,
                        figure.prefix.as_deref(),
                        figure.unit.as_deref(),
                        figure.decimals
                    )
                );
                if let Some(note) = worked.note {
                    let _ = write!(line, " ({note})");
                }
                line
            })
            .collect::<Vec<_>>()
            .join("; "),
    )
}

/// Each preset of a calculator with what its results would be: "Try moving relevant documents to
/// the top → RR@5 = 1 (First at #1)", for the agent to write about it.
fn preset_lines(widget: &Widget) -> Vec<String> {
    let Widget::Calculator { presets, .. } = widget else {
        return Vec::new();
    };
    presets
        .iter()
        .filter_map(|preset| {
            let results = results_line(widget, Some(&json!({"values": preset.values})))?;
            Some(format!("{} → {results}", preset.label))
        })
        .collect()
}

/// "Democrats 51 seats; Republicans 49 seats": a chart's figures as the person reads them.
fn bars_line(widget: &Widget) -> Option<String> {
    let Widget::Chart {
        bars,
        unit,
        prefix,
        decimals,
        ..
    } = widget
    else {
        return None;
    };
    Some(
        bars.iter()
            .map(|bar| {
                format!(
                    "{} {}",
                    bar.label,
                    written(bar.value, prefix.as_deref(), unit.as_deref(), *decimals)
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
    "Show your answer with what LoomWatch draws, so the person sees it at a glance and can use \
     it: a chart whose bars LoomWatch draws to scale from figures you give, a graph of bars or a \
     line over labels such as months, a calculator whose results LoomWatch works out as they \
     change its inputs, a checklist they tick, steps they tap through one at a time, choices they \
     tap to reply, a row of things marked yes or no, or a flow of boxes and arrows. Use one \
     whenever the answer has figures to compare (chart), figures that change over time or several \
     series (graph), a sum, a split or a cost they may change (calculator), things to do \
     (checklist), a process or a how-to (steps), a choice of what to do next (choices), which of \
     several things pass a test (marks), or how parts connect (flow), and prefer it to a table, a \
     list or bars written in text, or a page written for it. Show up to 4 when the answer has more \
     than one of these. Words alone are for an answer with none of them, such as a short fact. \
     Call it before you write your answer, once for each, then put each where it belongs with the \
     place line it gives you, after the words that lead to it, and say in words what to notice or \
     try. Give the main result in words too, since a copy of the answer shows only your words.",
);

/// `show_widget`'s `kind`.
pub(crate) const SHOW_WIDGET_KIND: Block = Block::new(
    "bus.show_widget.kind",
    "choices, checklist, calculator, steps, chart, graph, marks or flow. Fill in only that kind's \
     fields.",
);

/// A calculator result's `note`.
pub(crate) const SHOW_WIDGET_NOTE: Block = Block::new(
    "bus.show_widget.note",
    "A few words under the figure saying why, with formulas in braces that LoomWatch works out as \
     the inputs change, such as \"{found} of 3 found\" or \"First at #{if(d1, 1, if(d2, 2, 3))}\". \
     A note may read the inputs, this result and the results above it.",
);

/// A calculator's `presets`.
pub(crate) const SHOW_WIDGET_PRESETS: Block = Block::new(
    "bus.show_widget.presets",
    "calculator: up to 3 buttons that set some inputs to a case worth trying, such as \"Try \
     moving the relevant ones to the top\". A button sets the inputs it names and puts the rest \
     back to their starting values. You are told each one's results, so your words can say what \
     changes.",
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

/// A chart's `bars`.
pub(crate) const SHOW_WIDGET_BARS: Block = Block::new(
    "bus.show_widget.bars",
    "chart: 2 to 12 bars, in the order to read them, each a label and its figure in the chart's \
     one unit. Give the figures you found or worked out, never ones you guess; a figure below \
     zero is drawn to the left.",
);

/// What `show_widget` answers with, beside a calculator's results.
pub(crate) const SHOW_WIDGET_SHOWN: Block = Block::new(
    "bus.show_widget.shown",
    "Now write your answer in words. Put the place line on a line of its own where this belongs, \
     after the words that lead to it; LoomWatch draws it there and takes the line out of your \
     words. Without it, it shows at the end of your answer. Give the main result in words and say \
     what to notice or try, without repeating all of it. Up to 4 show with one answer.",
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
                    "enum": ["choices", "checklist", "calculator", "steps", "chart", "graph", "marks", "flow"]
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
                    "description": "calculator: up to 12 values the person can change. A number has start, and may have unit, prefix, min, max and step; a switch has on instead",
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
                            "step": {"type": "number", "description": "How much one press changes it"},
                            "group": {"type": "string", "description": "Switches next to each other with the same group show as one row of boxes to tap, under the group's name, each box showing its label: give them short labels, such as #1 or Mon"}
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
                            "decimals": {"type": "integer", "description": "Decimal places shown; without it, up to 2", "minimum": 0, "maximum": formula::MAX_DECIMALS},
                            "note": {"type": "string", "description": SHOW_WIDGET_NOTE.text()}
                        },
                        "required": ["id", "label", "formula"],
                        "additionalProperties": false
                    }
                },
                "presets": {
                    "type": "array",
                    "description": SHOW_WIDGET_PRESETS.text(),
                    "maxItems": limits::PRESETS.1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": {"type": "string", "description": "What the button says", "minLength": 1},
                            "values": {"type": "object", "description": "Input id: a number, or true or false for a switch"}
                        },
                        "required": ["label", "values"],
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
                "repeats": {"type": "boolean", "description": "steps or flow: true when the last leads back to the first, as in a cycle"},
                "bars": {
                    "type": "array",
                    "description": SHOW_WIDGET_BARS.text(),
                    "maxItems": limits::BARS.1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": label,
                            "value": {"type": "number", "description": "Its figure"},
                            "note": {"type": "string", "description": "A few words beside it, such as a change since last time"}
                        },
                        "required": ["label", "value"],
                        "additionalProperties": false
                    }
                },
                "style": {"type": "string", "description": "graph: bars side by side, or a line over time", "enum": ["bar", "line"]},
                "labels": {
                    "type": "array",
                    "description": "graph: 2 to 24 labels along the bottom, such as months",
                    "maxItems": limits::POINTS.1,
                    "items": {"type": "string"}
                },
                "series": {
                    "type": "array",
                    "description": "graph: 1 to 3 series, each a value for every label",
                    "maxItems": limits::SERIES.1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": label,
                            "values": {"type": "array", "items": {"type": "number"}}
                        },
                        "required": ["label", "values"],
                        "additionalProperties": false
                    }
                },
                "cells": {
                    "type": "array",
                    "description": "marks: 1 to 12 things in a row, each marked, such as which results were relevant or which days are free",
                    "maxItems": limits::CELLS.1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": {"type": "string", "description": "A word or two, such as #1 or Mon", "minLength": 1},
                            "mark": {"type": "string", "enum": ["yes", "no", "neither"]},
                            "note": {"type": "string", "description": "Only what the mark doesn't say, such as 0.82 or 9–11 am; leave it out when the mark says it all"}
                        },
                        "required": ["label", "mark"],
                        "additionalProperties": false
                    }
                },
                "facts": {
                    "type": "array",
                    "description": "marks: up to 3 short facts under the row, such as \"2 of 3 relevant found\"",
                    "maxItems": limits::FACTS.1,
                    "items": {"type": "string"}
                },
                "boxes": {
                    "type": "array",
                    "description": "flow: 2 to 8 boxes in order, joined by arrows, such as the parts a request passes through",
                    "maxItems": limits::BOXES.1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": {"type": "string", "description": "A word or two", "minLength": 1},
                            "note": {"type": "string", "description": "A few words under it"}
                        },
                        "required": ["label"],
                        "additionalProperties": false
                    }
                },
                "unit": {"type": "string", "description": "chart or graph: written after every figure, such as seats, % or km"},
                "prefix": {"type": "string", "description": "chart or graph: written before every figure, such as $"},
                "decimals": {"type": "integer", "description": "chart or graph: decimal places shown; without it, up to 2", "minimum": 0, "maximum": formula::MAX_DECIMALS}
            },
            "required": ["kind", "title"],
            "additionalProperties": false
        }
    })
}

/// What the agent is told when its widget is shown: what it is, the line that places it, a
/// calculator's results with the starting values and with each preset, and to write the answer
/// now. `place` counts the widgets this agent's session has shown, from 1.
pub(crate) fn shown(widget: &Widget, place: u32) -> Value {
    let mut out = json!({"shown": widget.named(), "place": place_line(place)});
    if let Some(results) = results_line(widget, None) {
        out["results"] = json!(results);
    }
    let presets = preset_lines(widget);
    if !presets.is_empty() {
        out["presets"] = json!(presets);
    }
    if let Some(bars) = bars_line(widget) {
        out["bars"] = json!(bars);
    }
    out["next"] = json!(SHOW_WIDGET_SHOWN.text());
    out
}

/// `{{widget 3}}`: the line an agent writes where its third widget belongs.
pub(crate) fn place_line(place: u32) -> String {
    format!("{{{{widget {place}}}}}")
}

/// The number in a place line, read loosely (`{{ Widget 3 }}`), when `text` is one.
fn place_of(text: &str) -> Option<u32> {
    let inside = text.trim().strip_prefix("{{")?.strip_suffix("}}")?.trim();
    let (word, number) = inside.split_once(char::is_whitespace)?;
    if !word.eq_ignore_ascii_case("widget") {
        return None;
    }
    number.trim().parse().ok()
}

/// `line` with every place line inside it taken out, as `(the rest, whether any was)`.
fn without_places(line: &str) -> (String, bool) {
    let mut out = String::new();
    let mut rest = line;
    let mut found = false;
    while let Some(open) = rest.find("{{") {
        let Some(close) = rest[open..].find("}}").map(|close| open + close + 2) else {
            break;
        };
        out.push_str(&rest[..open]);
        let taken = place_of(&rest[open..close]).is_some();
        if taken {
            found = true;
        } else {
            out.push_str(&rest[open..close]);
        }
        rest = &rest[close..];
        // "First {{widget 2}} words." reads "First words.", not with two spaces.
        if taken && out.ends_with(' ') && rest.starts_with(' ') {
            rest = &rest[1..];
        }
    }
    out.push_str(rest);
    (out, found)
}

/// `reply` with any place line taken out, for an answer none of whose widgets were kept (a call
/// that was refused, a database that failed): the line never shows as written. Words with none are
/// kept exactly.
pub(crate) fn without_place_lines(reply: &str) -> String {
    if reply
        .split('\n')
        .any(|line| place_of(line).is_some() || without_places(line).1)
    {
        place(reply, &[]).0
    } else {
        reply.to_owned()
    }
}

/// The answer's words with every place line taken out, and for each of `shown`, the line of those
/// words it now stands before: `None` for one the answer didn't place, which shows at the end.
///
/// A place line on a line of its own puts its widget there, the first time; one inside a sentence
/// is taken out and places nothing. Code blocks are left as written. Blank lines at the start or
/// the end go too.
pub(crate) fn place(reply: &str, shown: &[Shown]) -> (String, Vec<Option<u32>>) {
    let mut lines: Vec<String> = Vec::new();
    let mut at: Vec<Option<usize>> = vec![None; shown.len()];
    let mut fence: Option<&str> = None;
    // A place line between two blank lines leaves one of them.
    let mut after_place = false;
    for line in reply.split('\n') {
        let trimmed = line.trim_start();
        if std::mem::take(&mut after_place)
            && fence.is_none()
            && trimmed.is_empty()
            && lines.last().is_none_or(|last| last.trim().is_empty())
        {
            continue;
        }
        let marker = ["```", "~~~"]
            .into_iter()
            .find(|marker| trimmed.starts_with(marker));
        if let Some(open) = fence {
            if trimmed.starts_with(open) {
                fence = None;
            }
            lines.push(line.to_owned());
            continue;
        }
        if let Some(marker) = marker {
            fence = Some(marker);
            lines.push(line.to_owned());
            continue;
        }
        if let Some(number) = place_of(line) {
            if let Some(index) = shown
                .iter()
                .zip(&at)
                .position(|(one, placed)| one.place == Some(number) && placed.is_none())
            {
                at[index] = Some(lines.len());
            }
            after_place = true;
            continue;
        }
        let (rest, found) = without_places(line);
        lines.push(if found {
            rest.trim_end().to_owned()
        } else {
            rest
        });
    }
    let lead = lines
        .iter()
        .take_while(|line| line.trim().is_empty())
        .count();
    lines.drain(..lead);
    while lines.last().is_some_and(|line| line.trim().is_empty()) {
        lines.pop();
    }
    let total = lines.len();
    let at = at
        .into_iter()
        .map(|line| {
            line.map(|line| {
                let line = line.saturating_sub(lead).min(total);
                u32::try_from(line).unwrap_or(u32::MAX)
            })
        })
        .collect();
    (lines.join("\n"), at)
}

// ---------------------------------------------------------------------------------------------
// The answer's widgets, at the end of a run
// ---------------------------------------------------------------------------------------------

/// A widget an agent showed, with the number of its place line (`None` in a run from before place
/// lines).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Shown {
    pub(crate) place: Option<u32>,
    pub(crate) widget: Widget,
}

/// The widgets of `responder`'s answer: the `show_widget` calls that went through in the turn
/// whose reply became the answer, or, when that turn showed none, in the latest earlier turn of
/// work in the same session that did (a revision after a check sent the work back, an answer after
/// a question). The last [`MOST_PER_ANSWER`].
///
/// Turns are read as [`crate::runs`]' `last_words` reads them: by agent and session, starting at
/// each prompt, with the coordinator's checkpoints and handovers skipped.
pub(crate) fn of_answer(events: &[RunEvent], responder: Option<&str>) -> Vec<Shown> {
    #[derive(Default)]
    struct Turns {
        current: Vec<Shown>,
        earlier: Vec<Shown>,
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
                    let place = event.payload["rawOutput"]["place"]
                        .as_str()
                        .and_then(place_of);
                    turns
                        .entry(at)
                        .or_default()
                        .current
                        .push(Shown { place, widget });
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
        Widget::Choices { .. }
        | Widget::Steps { .. }
        | Widget::Chart { .. }
        | Widget::Marks { .. }
        | Widget::Flow { .. }
        | Widget::Graph { .. } => Err(format!("{} keep nothing", widget.kind())),
    }
}

/// A widget kept with a run's answer, and what the person last made of it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Kept {
    /// Its place among the answer's widgets, from 1.
    pub n: u32,
    /// The line of the answer's words it stands before; `None` for one shown at the end.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
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
            Widget::Chart { .. } => match bars_line(&kept.spec) {
                Some(bars) => format!("{} ({bars})", kept.spec.named()),
                None => kept.spec.named(),
            },
            Widget::Marks { cells, facts, .. } => {
                let mut each = cells
                    .iter()
                    .map(|cell| {
                        let mark = match cell.mark {
                            Mark::Yes => "yes",
                            Mark::No => "no",
                            Mark::Neither => "neither",
                        };
                        format!("{} {mark}", cell.label)
                    })
                    .collect::<Vec<_>>();
                each.extend(facts.iter().cloned());
                format!("{} ({})", kept.spec.named(), each.join(", "))
            }
            Widget::Flow { boxes, repeats, .. } => format!(
                "{} ({}{})",
                kept.spec.named(),
                boxes
                    .iter()
                    .map(|each| each.label.as_str())
                    .collect::<Vec<_>>()
                    .join(" → "),
                if *repeats {
                    " → back to the first"
                } else {
                    ""
                }
            ),
            Widget::Graph { .. } => format!("{} ({})", kept.spec.named(), graph_line(&kept.spec)),
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
        Widget::Choices { .. }
        | Widget::Steps { .. }
        | Widget::Chart { .. }
        | Widget::Marks { .. }
        | Widget::Flow { .. }
        | Widget::Graph { .. } => None,
    }
}

/// A graph's figures in a line, for the next run: "Rent: Jan 1,200 $, Feb 1,250 $; …", at most
/// [`GRAPH_LINE_POINTS`] points a series before "and N more".
fn graph_line(widget: &Widget) -> String {
    let Widget::Graph {
        labels,
        series,
        unit,
        prefix,
        decimals,
        ..
    } = widget
    else {
        return String::new();
    };
    series
        .iter()
        .map(|series| {
            let mut points = labels
                .iter()
                .zip(&series.values)
                .take(GRAPH_LINE_POINTS)
                .map(|(label, value)| {
                    format!(
                        "{label} {}",
                        written(*value, prefix.as_deref(), unit.as_deref(), *decimals)
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            let more = labels.len().saturating_sub(GRAPH_LINE_POINTS);
            if more > 0 {
                let _ = write!(points, " and {more} more");
            }
            format!("{}: {points}", series.label)
        })
        .collect::<Vec<_>>()
        .join("; ")
}

/// How many points of each series the next run reads in a graph's line.
const GRAPH_LINE_POINTS: usize = 12;

#[cfg(test)]
mod tests;
