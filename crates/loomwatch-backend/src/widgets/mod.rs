//! Widgets: working parts an answer can hold under its words (ADR 0114).
//!
//! The agent whose reply is the answer calls the Team Bus tool `show_widget` before it writes that
//! answer. `LoomWatch` checks the widget here, works out a calculator's results, and tells the agent
//! them, so its words use `LoomWatch`'s numbers. When the run succeeds, the widgets of the turn whose
//! reply became the answer are kept with it ([`of_answer`], [`store`]); what the person ticks or
//! changes is kept beside them, and the next run's conversation says so ([`showed`], [`changes`]).
//!
//! Fourteen kinds, drawn by the app (`ui/src/components/chat/widgets/`): choices the person taps to
//! reply, a checklist they tick, a calculator whose results `LoomWatch` works out as they change its
//! inputs ([`formula`]), a finder whose questions they answer to reach the outcome for their own
//! case ([`finder`]), a quiz that checks they took in what was explained ([`quiz`]), steps they
//! tap through, a picture whose numbered parts they step through, and seven to look at: a
//! comparison of two or three things side by side (or the parts of one thing) with facts read
//! across, a chart whose bars `LoomWatch` draws to scale from the figures the agent gives, a graph
//! of bars or a line over labels, a scale of named ranges with figures pinned where they fall
//! ([`scale`]), a timeline of events on their dates ([`timeline`]), a row of things marked yes or
//! no, and a flow of boxes and arrows. Figures that count whole things (`counted`) are drawn as dots. A
//! picture is the one the agent draws (ADR 0117): `LoomWatch` keeps only the shapes of its SVG and
//! draws them again in its own lines ([`picture`]), so nothing the agent writes is shown as
//! markup. The tool's description tells it which kind fits which shape of answer
//! ([`SHOW_WIDGET`]).
//!
//! Each widget is told a place line, `{{widget N}}`, that the agent writes on its own line where the
//! widget belongs in its answer. When the run ends the line is taken out of the answer's words and
//! the widget keeps the line it stood before ([`place`]), so the words read whole everywhere else.

pub(crate) mod finder;
pub(crate) mod formula;
pub(crate) mod host;
pub(crate) mod picture;
pub(crate) mod quiz;
pub(crate) mod scale;
pub(crate) mod store;
pub(crate) mod timeline;

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
    /// A comparison's sides: three at most, so each keeps a readable column on a phone.
    pub(crate) const SIDES: (usize, usize) = (2, 3);
    pub(crate) const SIDE_LABEL_CHARS: usize = 40;
    pub(crate) const SIDE_NOTE_CHARS: usize = 60;
    pub(crate) const ROWS: (usize, usize) = (0, 6);
    pub(crate) const ROW_LABEL_CHARS: usize = 40;
    pub(crate) const ROW_VALUE_CHARS: usize = 60;
    /// What the next run's conversation says of the person's changes under one answer.
    pub(crate) const CHANGES_CHARS: usize = 400;
    /// A picture's drawing as the agent writes it, and what it may hold once read: room for a
    /// detailed figure, short of a page of markup.
    pub(crate) const DRAWING_CHARS: usize = 30_000;
    pub(crate) const SHAPES: usize = 160;
    pub(crate) const SEGMENTS: usize = 6_000;
    pub(crate) const DEPTH: usize = 24;
    /// Wide to tall, and tall to wide: past it a picture reads poorly in a chat.
    pub(crate) const MOST_ASPECT: f64 = 3.0;
    pub(crate) const PARTS: (usize, usize) = (0, 8);
    pub(crate) const PART_LABEL_CHARS: usize = 40;
    pub(crate) const PART_TEXT_CHARS: usize = 320;
    /// A picture's words: a few each, enough to name what a textbook figure names.
    pub(crate) const LABELS: usize = 24;
    pub(crate) const LABEL_WORDS_CHARS: usize = 40;
    /// Things that move from stage to stage in one picture.
    pub(crate) const MOVES: usize = 12;
    /// The one question a picture may ask before a step, and its choices.
    pub(crate) const GUESS_CHARS: usize = 160;
    pub(crate) const GUESS_CHOICES: (usize, usize) = (2, 3);
    pub(crate) const GUESS_CHOICE_CHARS: usize = 40;
    /// The name of what a picture's dial turns: a word or two.
    pub(crate) const DIAL_CHARS: usize = 24;
    /// A finder's questions, each one's answers, and the outcomes they lead to.
    pub(crate) const QUESTIONS: (usize, usize) = (1, 6);
    pub(crate) const QUESTION_CHARS: usize = 160;
    pub(crate) const ANSWERS: (usize, usize) = (2, 4);
    pub(crate) const ANSWER_CHARS: usize = 60;
    pub(crate) const OUTCOMES: (usize, usize) = (2, 8);
    pub(crate) const OUTCOME_LABEL_CHARS: usize = 60;
    pub(crate) const OUTCOME_TEXT_CHARS: usize = 320;
    /// A quiz's questions, each one's choices, and the sentence saying why its answer is right.
    pub(crate) const CHECKS: (usize, usize) = (1, 5);
    pub(crate) const CHECK_CHOICES: (usize, usize) = (2, 4);
    pub(crate) const CHECK_CHOICE_CHARS: usize = 80;
    pub(crate) const WHY_CHARS: usize = 240;
    /// A scale's ranges, and the values pinned on it.
    pub(crate) const RANGES: (usize, usize) = (2, 6);
    pub(crate) const RANGE_LABEL_CHARS: usize = 24;
    pub(crate) const PINS: (usize, usize) = (1, 3);
    pub(crate) const PIN_LABEL_CHARS: usize = 24;
    /// A timeline's events.
    pub(crate) const EVENTS: (usize, usize) = (2, 12);
    pub(crate) const EVENT_LABEL_CHARS: usize = 60;
    pub(crate) const EVENT_NOTE_CHARS: usize = 160;
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
        /// The figures count whole things (seats, people): drawn as dots.
        #[serde(default, skip_serializing_if = "is_false")]
        counted: bool,
    },
    /// Two or three things side by side, or the parts of one thing (`whole`): each its name, a
    /// figure in one unit when they share a measure, and rows of facts read across. To look at.
    Compare {
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        whole: Option<Whole>,
        sides: Vec<Side>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        rows: Vec<Row>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        unit: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prefix: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        decimals: Option<u8>,
        /// The figures count whole things (seats, people): drawn as dots.
        #[serde(default, skip_serializing_if = "is_false")]
        counted: bool,
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
    /// A picture the agent drew, redrawn in `LoomWatch`'s own lines (ADR 0117): outlines in the
    /// picture's units, [`picture::WIDTH`] wide, its words as labels, and up to 8 numbered parts the
    /// person taps or steps through, whose shapes turn gold. When the agent drew something again at
    /// each stage it plays, and it may ask one question first. To look at.
    Picture {
        title: String,
        width: f64,
        height: f64,
        shapes: Vec<picture::Shape>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        parts: Vec<picture::Part>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        labels: Vec<picture::Label>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        moves: Vec<picture::Move>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        guess: Option<picture::Guess>,
        /// What the picture's stages are values of, when they aren't moments in time: the cause
        /// the person turns, such as "Speed". Each part's label is then its value.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        dial: Option<String>,
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
    /// Questions the person answers by tapping, each answer leading to a later question or to an
    /// outcome, so the answer for their own case shows at once ([`finder`]). What they answered
    /// is kept.
    Finder {
        title: String,
        questions: Vec<finder::Question>,
        outcomes: Vec<finder::Outcome>,
    },
    /// Questions after an explanation that check the person took it in, each with one right choice
    /// and why ([`quiz`]). What they picked is kept.
    Quiz {
        title: String,
        checks: Vec<quiz::Check>,
    },
    /// Named ranges from low to high drawn to scale, with up to three values pinned where they
    /// fall ([`scale`]). To look at.
    Scale {
        title: String,
        ranges: Vec<scale::Range>,
        pins: Vec<scale::Pin>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        unit: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prefix: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        decimals: Option<u8>,
    },
    /// Events on their dates, in date order, spaced by the time between them ([`timeline`]). To
    /// look at.
    Timeline {
        title: String,
        events: Vec<timeline::Event>,
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

/// What a comparison's sides are parts of.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Whole {
    pub(crate) label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) note: Option<String>,
}

/// One side of a comparison: its name, its figure when the sides share a measure, a few words.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Side {
    pub(crate) label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) value: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) note: Option<String>,
}

/// One fact of a comparison, read across: its name, and a value for each side in their order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Row {
    pub(crate) label: String,
    pub(crate) values: Vec<String>,
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
            | Self::Compare { title, .. }
            | Self::Marks { title, .. }
            | Self::Flow { title, .. }
            | Self::Picture { title, .. }
            | Self::Graph { title, .. }
            | Self::Finder { title, .. }
            | Self::Quiz { title, .. }
            | Self::Scale { title, .. }
            | Self::Timeline { title, .. } => title,
        }
    }

    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Self::Choices { .. } => "choices",
            Self::Checklist { .. } => "checklist",
            Self::Calculator { .. } => "calculator",
            Self::Steps { .. } => "steps",
            Self::Chart { .. } => "chart",
            Self::Compare { .. } => "compare",
            Self::Marks { .. } => "marks",
            Self::Flow { .. } => "flow",
            Self::Picture { .. } => "picture",
            Self::Graph { .. } => "graph",
            Self::Finder { .. } => "finder",
            Self::Quiz { .. } => "quiz",
            Self::Scale { .. } => "scale",
            Self::Timeline { .. } => "timeline",
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
            Self::Compare { .. } => "a comparison",
            Self::Marks { .. } => "a row of marks",
            Self::Flow { .. } => "a flow",
            Self::Picture { .. } => "a picture",
            Self::Graph {
                style: GraphStyle::Bar,
                ..
            } => "a bar graph",
            Self::Graph {
                style: GraphStyle::Line,
                ..
            } => "a line graph",
            // What the person may read in the agent's words: "Finder" is the Mac's file app.
            Self::Finder { .. } => "a decision guide",
            Self::Quiz { .. } => "a quiz",
            Self::Scale { .. } => "a scale",
            Self::Timeline { .. } => "a timeline",
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
        "chart" => {
            let bars = list(arguments, "bars", limits::BARS, |bar| {
                Ok(Bar {
                    label: text(bar, "label", 1, limits::LABEL_CHARS)?,
                    value: number(bar, "value")?.ok_or("value is missing: give it as a number")?,
                    note: optional_text(bar, "note", limits::NOTE_CHARS)?,
                })
            })?;
            let counted = flag(arguments, "counted")?;
            if counted {
                check_counted(bars.iter().map(|bar| bar.value))?;
            }
            Widget::Chart {
                bars,
                unit: optional_text(arguments, "unit", limits::UNIT_CHARS)?,
                prefix: optional_text(arguments, "prefix", limits::UNIT_CHARS)?,
                decimals: decimals(arguments)?,
                counted,
                title,
            }
        }
        "compare" => read_compare(arguments, title)?,
        "picture" => picture::read(arguments, title)?,
        "finder" => finder::read(arguments, title)?,
        "quiz" => quiz::read(arguments, title)?,
        "scale" => scale::read(arguments, title)?,
        "timeline" => timeline::read(arguments, title)?,
        other => {
            return Err(format!(
                "kind \"{other}\" isn't a widget: use compare, chart, graph, scale, timeline, \
                 flow, steps, picture, calculator, checklist, finder, quiz, marks or choices"
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
    flag(arguments, "repeats")
}

/// A true-or-false field, false when absent.
fn flag(arguments: &Value, field: &str) -> Result<bool, String> {
    match arguments.get(field) {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(on)) => Ok(*on),
        Some(_) => Err(format!("{field} is true or false")),
    }
}

/// Figures drawn as dots count whole things: each a whole number, 0 or more.
fn check_counted(values: impl IntoIterator<Item = f64>) -> Result<(), String> {
    if values
        .into_iter()
        .all(|value| value >= 0.0 && value.fract() == 0.0)
    {
        Ok(())
    } else {
        Err(
            "counted figures are whole numbers of things, 0 or more: leave counted out for \
             figures such as prices, shares or averages"
                .to_owned(),
        )
    }
}

/// A comparison, read and checked: every side has a figure or none does, and every row has a value
/// for each side.
fn read_compare(arguments: &Value, title: String) -> Result<Widget, String> {
    let whole = match arguments.get("whole") {
        None | Some(Value::Null) => None,
        Some(whole @ Value::Object(_)) => Some(Whole {
            label: text(whole, "label", 1, limits::SIDE_LABEL_CHARS)
                .map_err(|error| format!("whole: {error}"))?,
            note: optional_text(whole, "note", limits::SIDE_NOTE_CHARS)
                .map_err(|error| format!("whole: {error}"))?,
        }),
        Some(_) => return Err("whole is {\"label\", \"note\"}".to_owned()),
    };
    let sides = list(arguments, "sides", limits::SIDES, |side| {
        Ok(Side {
            label: text(side, "label", 1, limits::SIDE_LABEL_CHARS)?,
            value: number(side, "value")?,
            note: optional_text(side, "note", limits::SIDE_NOTE_CHARS)?,
        })
    })?;
    let with_figures = sides.iter().filter(|side| side.value.is_some()).count();
    if with_figures != 0 && with_figures != sides.len() {
        return Err(format!(
            "{with_figures} of {} sides have a value: give every side a value in the same unit, \
             or none",
            sides.len()
        ));
    }
    let counted = flag(arguments, "counted")?;
    if counted {
        if with_figures == 0 {
            return Err("counted draws the sides' values: give each side a value".to_owned());
        }
        check_counted(sides.iter().filter_map(|side| side.value))?;
    }
    let count = sides.len();
    let rows = match arguments.get("rows") {
        None | Some(Value::Null) => Vec::new(),
        Some(_) => list(arguments, "rows", limits::ROWS, |row| {
            let values = row
                .get("values")
                .and_then(Value::as_array)
                .ok_or_else(|| format!("values is missing: give {count}, one per side"))?;
            if values.len() != count {
                return Err(format!(
                    "values has {}; give {count}, one per side in their order",
                    values.len()
                ));
            }
            Ok(Row {
                label: text(row, "label", 1, limits::ROW_LABEL_CHARS)?,
                values: values
                    .iter()
                    .map(|value| {
                        let written = value
                            .as_str()
                            .map(str::trim)
                            .filter(|written| !written.is_empty())
                            .ok_or("each value is a few words")?;
                        let length = written.chars().count();
                        if length > limits::ROW_VALUE_CHARS {
                            return Err(format!(
                                "a value is {length} characters; keep it to {}",
                                limits::ROW_VALUE_CHARS
                            ));
                        }
                        Ok(written.to_owned())
                    })
                    .collect::<Result<_, String>>()?,
            })
        })?,
    };
    if with_figures == 0 && rows.is_empty() {
        return Err(
            "a comparison needs something to compare: a value for each side, or rows".to_owned(),
        );
    }
    Ok(Widget::Compare {
        title,
        whole,
        sides,
        rows,
        unit: optional_text(arguments, "unit", limits::UNIT_CHARS)?,
        prefix: optional_text(arguments, "prefix", limits::UNIT_CHARS)?,
        decimals: decimals(arguments)?,
        counted,
    })
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

/// "Senate 100 seats; House 435 seats": a comparison's figures as the person reads them, when its
/// sides have them.
fn sides_line(widget: &Widget) -> Option<String> {
    let Widget::Compare {
        sides,
        unit,
        prefix,
        decimals,
        ..
    } = widget
    else {
        return None;
    };
    let figures = sides
        .iter()
        .map(|side| {
            side.value.map(|value| {
                format!(
                    "{} {}",
                    side.label,
                    written(value, prefix.as_deref(), unit.as_deref(), *decimals)
                )
            })
        })
        .collect::<Option<Vec<_>>>()?;
    Some(figures.join("; "))
}

/// "Congress: Senate 100 seats, House 435 seats; Term: 6 years | 2 years": a comparison in a
/// line, for the next run.
fn compare_line(widget: &Widget) -> String {
    let Widget::Compare {
        whole, sides, rows, ..
    } = widget
    else {
        return String::new();
    };
    let mut line = whole
        .as_ref()
        .map(|whole| format!("{}: ", whole.label))
        .unwrap_or_default();
    line.push_str(&sides_line(widget).map_or_else(
        || {
            sides
                .iter()
                .map(|side| side.label.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        },
        |figures| figures.replace("; ", ", "),
    ));
    for row in rows {
        let _ = write!(line, "; {}: {}", row.label, row.values.join(" | "));
    }
    line
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
    "Show your answer with what LoomWatch draws, so the person takes it in at a glance and can \
     use it. Pick the kind by the shape of what you are telling:\n\
     - two or three things side by side, or two or three parts of one thing, with facts to read \
     across: compare\n\
     - figures to compare, one for each thing: chart\n\
     - figures that change over time, or several series: graph\n\
     - where a figure stands among named ranges, such as whether a temperature is a fever, a \
     score is good or a speed is safe: scale\n\
     - things that happened or are due on dates, such as a history, a life or a plan with \
     deadlines: timeline\n\
     - something to see, drawn by you: how a machine, a body or nature works, where a thing's \
     parts are, what happens in steps or rounds, such as how it moves or a message passing \
     through a network, or how one thing changes another, which play: picture\n\
     - one thing leading to the next, in order, when there is nothing to see: flow\n\
     - a process the person follows, one step at a time: steps\n\
     - a sum, a split or a cost they may change: calculator\n\
     - things to do: checklist\n\
     - an answer that turns on the person's own case, which a few questions settle, such as \
     whether they need a visa or which plan suits them: finder\n\
     - which of several things pass a test: marks\n\
     - what they may want next, which they send to you: choices\n\
     - when they want to learn or understand something, a few questions after it is explained, \
     beside the rest, that check they took it in: quiz\n\
     A finder answers them at once from what you set out; choices send their reply to you and \
     wait for another answer. When things in order have dates, show a timeline, which spaces \
     them by the time between them, rather than a flow. \
     A flow's line says that one thing leads to the next, so two or three parts that sit side by \
     side, such as a shop's sales and support teams, are shown with compare, not flow. When what \
     you explain can be seen, such as how an engine or a lung works or how a tide moves, draw it \
     in a picture, not boxes in a flow: a flow only names what a picture shows. When it happens \
     in steps or rounds, the picture plays its steps (drawing says how) rather than numbering \
     them with arrows; a picture of parts numbers its parts. When \
     figures count whole things, such as seats or people, set counted. Prefer one of these to a \
     table, a list or bars written in text, or a page written for it. Show up to 4 when the answer has more than one of these. Words alone \
     are for an answer with none of them, such as a short fact. Call it before you write your \
     answer, once for each, then put each where it belongs with the place line it gives you, \
     after the words that lead to it, and say in words what to notice or try. Give the main \
     result in words too, since a copy of the answer shows only your words.",
);

/// `show_widget`'s `kind`.
pub(crate) const SHOW_WIDGET_KIND: Block = Block::new(
    "bus.show_widget.kind",
    "compare, chart, graph, scale, timeline, flow, steps, picture, calculator, checklist, finder, \
     quiz, marks or choices, picked by the shape of what you are telling. Fill in only that \
     kind's fields.",
);

/// A picture's `drawing` (ADR 0117).
pub(crate) const SHOW_WIDGET_DRAWING: Block = Block::new(
    "bus.show_widget.drawing",
    "picture: the picture as SVG, such as <svg viewBox=\"0 0 640 360\">…</svg>, with path, \
     circle, ellipse, rect, line, polyline, polygon, text and g, transforms too. First decide \
     what it does, from what the answer is. The parts of a thing, such as the parts of a flower, \
     stay still, numbered. Something that happens in steps or rounds, such as a plane taking \
     off, the moon going round the Earth, blood through the heart or a message passed from node \
     to node in a network, plays its steps instead of arrows for the order. A why, one thing \
     changing another, such as why a ball thrown faster goes further, why a swing pushed harder \
     goes higher or why ice melts in warm air, turns a dial: its steps are 3 to 5 values of the \
     cause, from least to most, in numbers when it has them; set dial to the cause's name. To \
     play, make each step a part and draw what moves or changes again in each step's part, where \
     it is at that step, or at its size for a force or a flow that grows, the same shapes and \
     words in the same order, each copy in a g with the same data-moves name. A message going \
     from A through B to C: <g data-part=\"1\" data-moves=\"msg\" transform=\"translate(80 \
     120)\"><circle r=\"8\"/><text x=\"14\">message</text></g>, then that g again with \
     data-part=\"2\" at B and data-part=\"3\" at C. LoomWatch moves it from step to step and \
     dots in where it was. Then draw the place where the answer happens, at the size it \
     happens, big enough to fill the picture: the wing and the air around it to say why a plane \
     flies, a node and its neighbours to say how a network passes messages, a valve to say how \
     the heart keeps blood going one way; add the whole thing small in a corner only when it \
     helps to know where that place is. Draw a real example as a good textbook figure does: \
     people with names rather than dots, a plane with its wings and engines, in a few plain \
     shapes you can draw well, each big enough to read on a phone, with room between them: a \
     rounded body and a flat wing read better than a detailed outline gone wrong. Draw what \
     happens too: the forces, what changes. Name what the person needs to know with <text>, a \
     few words each in their language, beside what it names, on empty ground and not squeezed \
     inside a small shape; LoomWatch sets the words in its own type. Before you finish, check \
     the drawing against the facts: which side the light comes from, what is above or below, \
     what joins what. No background, sky or colours: LoomWatch draws every line in its own ink. \
     A shape with a fill is shaded, dark when the fill is dark, and fill=\"none\" leaves it an \
     outline; stroke-dasharray dashes a line, and marker-end puts an arrowhead at its end, with \
     no defs needed. Put data-part=\"N\" on the shapes, or the g, that show part N.",
);

/// A picture's `parts` (ADR 0117).
pub(crate) const SHOW_WIDGET_PARTS: Block = Block::new(
    "bus.show_widget.parts",
    "picture: up to 8 parts in the order to read them: the steps of a picture that plays, the \
     values of its dial, or the parts to know, each a short label and a sentence or two. The \
     person taps a part's number on the picture, or steps through them, and its shapes turn gold. at is [x, y] in the drawing's \
     units where its number stands, on empty ground beside what it names; without it, the \
     number stands above its shapes.",
);

/// A picture's `dial` (ADR 0117, amended 7 November).
pub(crate) const SHOW_WIDGET_DIAL: Block = Block::new(
    "bus.show_widget.dial",
    "picture that plays, when what it shows is how one thing changes another, as the answer to \
     a why usually is, such as how far a ball goes with how fast it is thrown: the name of the \
     cause in a word or two, such as \"Speed\". Its parts are then 3 to 5 values of the cause, \
     from least to most, each part's label its value, in numbers when it has them, such as \
     \"10 m/s\", \"20 m/s\" and \"30 m/s\", and its text what that value does. The person \
     turns the dial and watches what follows from it. Leave dial out when the parts are steps \
     in time.",
);

/// A picture's `guess` (ADR 0117, amended 7 November).
pub(crate) const SHOW_WIDGET_GUESS: Block = Block::new(
    "bus.show_widget.guess",
    "picture that plays: one question to ask before the step whose outcome would surprise the \
     person, only when it really would, such as which force is bigger as a plane leaves the \
     ground: before is that step's part number, question is the question in the person's \
     language, choices are 2 or 3 short answers, and answer is the right one, written as in \
     choices. The picture stops before that step the first time it plays; the person answers or \
     skips, then watches.",
);

/// A comparison's `sides`.
pub(crate) const SHOW_WIDGET_SIDES: Block = Block::new(
    "bus.show_widget.sides",
    "compare: 2 or 3 things side by side, in the order to read them, each a name and a few words \
     under it. When they share a measure, such as seats, members or a price, give each side its \
     figure as value, in the comparison's one unit, rather than in a row: LoomWatch draws values \
     to scale, which words in a row can't be. Every side or none.",
);

/// A comparison's `rows`.
pub(crate) const SHOW_WIDGET_ROWS: Block = Block::new(
    "bus.show_widget.rows",
    "compare: up to 6 facts read across the sides, each a few words and one value per side in \
     their order, such as {\"label\": \"Term\", \"values\": [\"6 years\", \"2 years\"]}.",
);

/// `counted`, on a chart or a comparison.
pub(crate) const SHOW_WIDGET_COUNTED: Block = Block::new(
    "bus.show_widget.counted",
    "chart or compare: true when the figures count whole things, such as seats, people or votes. \
     LoomWatch draws them as dots, one for each thing or for a round number of them, so a \
     difference is seen before it is read. Leave it out for prices, shares, averages or \
     measures.",
);

/// A finder's `questions` (ADR 0114, amended 8 November).
pub(crate) const SHOW_WIDGET_QUESTIONS: Block = Block::new(
    "bus.show_widget.questions",
    "finder: 1 to 6 questions, numbered from 1 in the order given, the first asked first. Ask only \
     what changes the outcome, the one that settles the most first, such as which passport they \
     hold before how long they stay. Each has 2 to 4 answers the person taps, written as they \
     would say them, and each answer leads to a later question with next or to an outcome with \
     outcome, by its number, so every path ends at an outcome.",
);

/// A finder's `outcomes` (ADR 0114, amended 8 November).
pub(crate) const SHOW_WIDGET_OUTCOMES: Block = Block::new(
    "bus.show_widget.outcomes",
    "finder: 2 to 8 outcomes, numbered from 1 in the order given, each a few words saying what \
     is true in that case, such as \"No visa for up to 45 days\", and a sentence or two on what \
     to do. Every outcome is reached by some answer.",
);

/// A quiz's `checks` (ADR 0114, amended 8 November).
pub(crate) const SHOW_WIDGET_CHECKS: Block = Block::new(
    "bus.show_widget.checks",
    "quiz: 1 to 5 questions, each on one idea your answer explains, not a detail to look up, \
     with 2 to 4 short choices in a natural order, such as smallest to largest, the right one \
     wherever it falls. answer is the right one, written as in choices, and why is a sentence \
     the person reads once they pick, saying why it is right. LoomWatch keeps what they pick, \
     so you hear what they missed.",
);

/// A scale's `ranges` (ADR 0114, amended 8 November).
pub(crate) const SHOW_WIDGET_RANGES: Block = Block::new(
    "bus.show_widget.ranges",
    "scale: 2 to 6 named ranges from low to high, each where it starts (from) and ends (to), \
     each starting where the one before it ends, such as Normal from 36.1 to 37.5 then Fever \
     from 37.5 to 40, as a source the person can trust gives them. LoomWatch draws them to \
     scale.",
);

/// A scale's `pins` (ADR 0114, amended 8 November).
pub(crate) const SHOW_WIDGET_PINS: Block = Block::new(
    "bus.show_widget.pins",
    "scale: 1 to 3 figures to place on it, each a word or two and its value in the scale's unit, \
     such as {\"label\": \"You\", \"value\": 38.5}. LoomWatch tells you the range each falls \
     in.",
);

/// A timeline's `events` (ADR 0114, amended 8 November).
pub(crate) const SHOW_WIDGET_EVENTS: Block = Block::new(
    "bus.show_widget.events",
    "timeline: 2 to 12 events, each its date, a few words on what happened or is due, and a \
     note of a few more. A date is a year such as 1997, a month such as 1997-06 or a day such \
     as 1997-06-26; a year before year 1 is below zero, -500 for 500 BC. LoomWatch puts them in \
     date order and spaces them by the time between them.",
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
    // The fields of the kinds added on 8 November, put in after the literal: with them it would
    // pass `json!`'s recursion limit.
    let questions = json!({
        "type": "array",
        "description": SHOW_WIDGET_QUESTIONS.text(),
        "maxItems": limits::QUESTIONS.1,
        "items": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "The question, as you would ask it", "minLength": 1},
                "answers": {
                    "type": "array",
                    "description": "2 to 4 answers to tap",
                    "maxItems": limits::ANSWERS.1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": {"type": "string", "description": "A few words, as the person would answer", "minLength": 1},
                            "next": {"type": "integer", "description": "The later question it leads to, by its number"},
                            "outcome": {"type": "integer", "description": "The outcome it ends at, by its number"}
                        },
                        "required": ["label"],
                        "additionalProperties": false
                    }
                }
            },
            "required": ["text", "answers"],
            "additionalProperties": false
        }
    });
    let outcomes = json!({
        "type": "array",
        "description": SHOW_WIDGET_OUTCOMES.text(),
        "maxItems": limits::OUTCOMES.1,
        "items": {
            "type": "object",
            "properties": {
                "label": {"type": "string", "description": "A few words: what is true in this case", "minLength": 1},
                "text": {"type": "string", "description": "A sentence or two on what to do"}
            },
            "required": ["label"],
            "additionalProperties": false
        }
    });
    let checks = json!({
        "type": "array",
        "description": SHOW_WIDGET_CHECKS.text(),
        "maxItems": limits::CHECKS.1,
        "items": {
            "type": "object",
            "properties": {
                "question": {"type": "string", "minLength": 1},
                "choices": {"type": "array", "description": "2 to 4 short choices", "items": {"type": "string"}, "maxItems": limits::CHECK_CHOICES.1},
                "answer": {"type": "string", "description": "The right choice, as written in choices"},
                "why": {"type": "string", "description": "A sentence saying why it is right"}
            },
            "required": ["question", "choices", "answer"],
            "additionalProperties": false
        }
    });
    let ranges = json!({
        "type": "array",
        "description": SHOW_WIDGET_RANGES.text(),
        "maxItems": limits::RANGES.1,
        "items": {
            "type": "object",
            "properties": {
                "label": {"type": "string", "description": "A word or two, such as Normal", "minLength": 1},
                "from": {"type": "number", "description": "Where it starts"},
                "to": {"type": "number", "description": "Where it ends, and the next one starts"}
            },
            "required": ["label", "from", "to"],
            "additionalProperties": false
        }
    });
    let pins = json!({
        "type": "array",
        "description": SHOW_WIDGET_PINS.text(),
        "maxItems": limits::PINS.1,
        "items": {
            "type": "object",
            "properties": {
                "label": {"type": "string", "description": "A word or two, such as You", "minLength": 1},
                "value": {"type": "number", "description": "Its figure"}
            },
            "required": ["label", "value"],
            "additionalProperties": false
        }
    });
    let events = json!({
        "type": "array",
        "description": SHOW_WIDGET_EVENTS.text(),
        "maxItems": limits::EVENTS.1,
        "items": {
            "type": "object",
            "properties": {
                "date": {"type": "string", "description": "1997, 1997-06, 1997-06-26, or -500 for 500 BC", "minLength": 1},
                "label": {"type": "string", "description": "A few words: what happened or is due", "minLength": 1},
                "note": {"type": "string", "description": "A few words more"}
            },
            "required": ["date", "label"],
            "additionalProperties": false
        }
    });
    let mut tool = json!({
        "name": TOOL,
        "description": SHOW_WIDGET.text(),
        "inputSchema": {
            "type": "object",
            "properties": {
                "kind": {
                    "type": "string",
                    "description": SHOW_WIDGET_KIND.text(),
                    "enum": ["compare", "chart", "graph", "scale", "timeline", "flow", "steps", "picture", "calculator", "checklist", "finder", "quiz", "marks", "choices"]
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
                "drawing": {"type": "string", "description": SHOW_WIDGET_DRAWING.text(), "minLength": 1},
                "dial": {"type": "string", "description": SHOW_WIDGET_DIAL.text(), "minLength": 1},
                "guess": {
                    "type": "object",
                    "description": SHOW_WIDGET_GUESS.text(),
                    "properties": {
                        "before": {"type": "integer", "description": "The part the question comes before, from 2"},
                        "question": {"type": "string", "minLength": 1},
                        "choices": {"type": "array", "description": "2 or 3 short answers", "items": {"type": "string"}, "maxItems": limits::GUESS_CHOICES.1},
                        "answer": {"type": "string", "description": "The right choice, as written in choices"}
                    },
                    "required": ["before", "question", "choices", "answer"],
                    "additionalProperties": false
                },
                "parts": {
                    "type": "array",
                    "description": SHOW_WIDGET_PARTS.text(),
                    "maxItems": limits::PARTS.1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": {"type": "string", "description": "A word or two", "minLength": 1},
                            "text": {"type": "string", "description": "What it is or what happens there", "minLength": 1},
                            "at": {"type": "array", "description": "[x, y]: two numbers, where its number stands", "items": {"type": "number"}, "maxItems": 2}
                        },
                        "required": ["label", "text"],
                        "additionalProperties": false
                    }
                },
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
                    "description": "flow: 2 to 8 stops in order, each leading to the next, such as what happens from an order to its delivery",
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
                "whole": {
                    "type": "object",
                    "description": "compare: what the sides are parts of, when they are, drawn above them and joined to each",
                    "properties": {
                        "label": label,
                        "note": {"type": "string", "description": "A few words under it"}
                    },
                    "required": ["label"],
                    "additionalProperties": false
                },
                "sides": {
                    "type": "array",
                    "description": SHOW_WIDGET_SIDES.text(),
                    "maxItems": limits::SIDES.1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": {"type": "string", "description": "A word or two", "minLength": 1},
                            "value": {"type": "number", "description": "Its figure"},
                            "note": {"type": "string", "description": "A few words under it"}
                        },
                        "required": ["label"],
                        "additionalProperties": false
                    }
                },
                "rows": {
                    "type": "array",
                    "description": SHOW_WIDGET_ROWS.text(),
                    "maxItems": limits::ROWS.1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": label,
                            "values": {"type": "array", "items": {"type": "string"}}
                        },
                        "required": ["label", "values"],
                        "additionalProperties": false
                    }
                },
                "counted": {"type": "boolean", "description": SHOW_WIDGET_COUNTED.text()},
                "unit": {"type": "string", "description": "chart, compare, graph or scale: written after every figure, such as seats, % or km"},
                "prefix": {"type": "string", "description": "chart, compare, graph or scale: written before every figure, such as $"},
                "decimals": {"type": "integer", "description": "chart, compare, graph or scale: decimal places shown; without it, up to 2", "minimum": 0, "maximum": formula::MAX_DECIMALS}
            },
            "required": ["kind", "title"],
            "additionalProperties": false
        }
    });
    if let Some(properties) = tool
        .pointer_mut("/inputSchema/properties")
        .and_then(Value::as_object_mut)
    {
        for (name, field) in [
            ("questions", questions),
            ("outcomes", outcomes),
            ("checks", checks),
            ("ranges", ranges),
            ("pins", pins),
            ("events", events),
        ] {
            properties.insert(name.to_owned(), field);
        }
    }
    tool
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
    if let Some(figures) = sides_line(widget) {
        out["figures"] = json!(figures);
    }
    if let Widget::Scale {
        ranges,
        pins,
        unit,
        prefix,
        decimals,
        ..
    } = widget
    {
        out["pins"] = json!(scale::pins_line(
            ranges,
            pins,
            prefix.as_deref(),
            unit.as_deref(),
            *decimals
        ));
    }
    if let Widget::Timeline { events, .. } = widget {
        out["order"] = json!(timeline::line(events));
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
/// item), a calculator's values (`{"values": {"pupils": 30, "round_up": true}}`, any of its
/// inputs), a finder's answers along the person's path (`{"answers": [0, 2]}`) or a quiz's picks
/// (`{"picked": [1, null]}`). The kinds to look at, choices and steps keep nothing.
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
        Widget::Finder {
            questions,
            outcomes,
            ..
        } => finder::read_state(questions, outcomes, state),
        Widget::Quiz { checks, .. } => quiz::read_state(checks, state),
        Widget::Choices { .. }
        | Widget::Steps { .. }
        | Widget::Chart { .. }
        | Widget::Compare { .. }
        | Widget::Marks { .. }
        | Widget::Flow { .. }
        | Widget::Picture { .. }
        | Widget::Graph { .. }
        | Widget::Scale { .. }
        | Widget::Timeline { .. } => Err(format!("{} keep nothing", widget.kind())),
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
            Widget::Picture { parts, .. } if !parts.is_empty() => format!(
                "{} ({})",
                kept.spec.named(),
                parts
                    .iter()
                    .enumerate()
                    .map(|(at, part)| format!("{} {}", at + 1, part.label))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            Widget::Picture { .. } => kept.spec.named(),
            Widget::Compare { .. } => {
                format!("{} ({})", kept.spec.named(), compare_line(&kept.spec))
            }
            Widget::Finder { .. }
            | Widget::Quiz { .. }
            | Widget::Scale { .. }
            | Widget::Timeline { .. } => {
                format!("{} ({})", kept.spec.named(), in_brief(&kept.spec))
            }
        })
        .collect();
    Some(format!("[Under this answer: {}.]", each.join("; ")))
}

/// A finder, a quiz, a scale or a timeline in a few words, for the next run: its questions and
/// outcomes, how many questions, its ranges and where each figure falls, or its first events.
fn in_brief(widget: &Widget) -> String {
    match widget {
        Widget::Finder {
            questions,
            outcomes,
            ..
        } => finder::line(questions, outcomes),
        Widget::Quiz { checks, .. } => format!(
            "{} question{}",
            checks.len(),
            if checks.len() == 1 { "" } else { "s" }
        ),
        Widget::Scale {
            ranges,
            pins,
            unit,
            prefix,
            decimals,
            ..
        } => format!(
            "{}; {}",
            scale::ranges_line(ranges, prefix.as_deref(), unit.as_deref(), *decimals),
            scale::pins_line(ranges, pins, prefix.as_deref(), unit.as_deref(), *decimals)
        ),
        Widget::Timeline { events, .. } => timeline::line(events),
        _ => String::new(),
    }
}

/// What `person` changed in the widgets of `answer` ("the answer of work 3f2a9c1e", "Researcher's
/// answer in the chat") at or before `before` (RFC 3339), in a line of about
/// [`limits::CHANGES_CHARS`]: "Mai changed what is under the answer of work 3f2a9c1e: "Zoo trip":
/// Pupils 25, … → Each family pays = 160,000 ₫. In "Before Wednesday", ticked: Print 32 copies (of
/// 2)."
pub(crate) fn changes(
    person: &str,
    answer: &str,
    widgets: &[Kept],
    before: &str,
) -> Option<String> {
    let parts: Vec<String> = widgets
        .iter()
        .filter(|kept| kept.changed_at.as_deref().is_some_and(|at| at <= before))
        .filter_map(|kept| change(&kept.spec, kept.state.as_ref()?))
        .collect();
    if parts.is_empty() {
        return None;
    }
    let mut line = format!("{person} changed what is under {answer}:");
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
        Widget::Finder {
            questions,
            outcomes,
            ..
        } => finder::change(widget.title(), questions, outcomes, state),
        Widget::Quiz { checks, .. } => quiz::change(widget.title(), checks, state),
        Widget::Choices { .. }
        | Widget::Steps { .. }
        | Widget::Chart { .. }
        | Widget::Compare { .. }
        | Widget::Marks { .. }
        | Widget::Flow { .. }
        | Widget::Picture { .. }
        | Widget::Graph { .. }
        | Widget::Scale { .. }
        | Widget::Timeline { .. } => None,
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
