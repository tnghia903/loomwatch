//! A picture an agent draws in its answer (ADR 0117): the thing it explains, drawn as outlines,
//! with up to 8 numbered parts the person taps or steps through, whose shapes turn gold.
//!
//! The agent writes its drawing as SVG, which models draw well, and `LoomWatch` keeps only the
//! shapes of it: `path`, `circle`, `ellipse`, `rect`, `line`, `polyline` and `polygon`, in `svg`
//! and `g` with their transforms, and the words of its `text` as plain labels where it placed them.
//! Colours, gradients, pictures, links, styles and scripts are left out, and nothing the agent
//! wrote is ever shown as markup. Each shape is redrawn as absolute moves, lines and cubic curves
//! in a frame [`WIDTH`] wide, so the apps draw it in a few lines of their own, in `LoomWatch`'s
//! ink: every shape outlined, a filled one shaded (dark when its fill is dark), a dashed one
//! dashed, and an arrowhead where a marker was. Its labels are set in `LoomWatch`'s own type.
//!
//! A picture plays when the agent draws one thing again at each stage (`data-moves`): the apps move
//! it from one stage's drawing to the next. It may ask one question first, before the step whose
//! outcome surprises ([`Guess`]). ADR 0117's amendment of 7 November says why, from learning
//! research on pictures that move.

use std::fmt::Write as _;

use quick_xml::events::{BytesStart, Event};
use quick_xml::reader::Reader;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{Widget, limits, list, text};

/// The width every picture is redrawn to; its height keeps the drawing's shape.
pub(crate) const WIDTH: f64 = 640.0;

/// One shape of a picture, in the picture's units: an outline `LoomWatch` draws in its ink, gold
/// while its part is picked.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Shape {
    /// Absolute moves, lines and cubic curves only, such as `M10 20L30 40C1 2 3 4 5 6Z`.
    pub(crate) d: String,
    /// The part it shows, from 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) part: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) fill: Option<Shade>,
    #[serde(default, skip_serializing_if = "super::is_false")]
    pub(crate) dashed: bool,
}

/// How a filled shape is shaded: lightly, or dark where the agent filled it with a dark colour.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Shade {
    Light,
    Dark,
}

/// One numbered part of a picture: what it is, a sentence or two, and where its number stands.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Part {
    pub(crate) label: String,
    pub(crate) text: String,
    /// Where its number stands, in the picture's units.
    pub(crate) at: [f64; 2],
}

/// Words the agent put on its picture, set in `LoomWatch`'s type where it placed them: plain text,
/// never markup.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Label {
    pub(crate) text: String,
    /// Where it stands, in the picture's units: its middle across `anchor`'s edge, and its middle
    /// down.
    pub(crate) at: [f64; 2],
    pub(crate) anchor: Anchor,
    /// The part it names, from 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) part: Option<u8>,
}

/// Which of a label's edges stands at its point, as SVG's `text-anchor` says.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Anchor {
    #[default]
    Start,
    Middle,
    End,
}

/// One thing the agent drew again at each stage, so the apps move it from stage to stage: at each,
/// its shapes and labels (indexes into the picture's), drawn the same way in the same order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Move {
    pub(crate) stages: Vec<Stage>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Stage {
    /// The part that is this stage, from 1.
    pub(crate) part: u8,
    pub(crate) shapes: Vec<usize>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) labels: Vec<usize>,
}

/// A question asked once, as a picture first plays, before the step whose outcome surprises: a
/// guess before a surprise is remembered best.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Guess {
    /// The part it comes before, from 2.
    pub(crate) before: u8,
    pub(crate) question: String,
    pub(crate) choices: Vec<String>,
    /// The right choice, from 0.
    pub(crate) answer: u8,
}

/// A picture, read from the agent's `drawing`, `parts` and `guess` and checked.
pub(crate) fn read(arguments: &Value, title: String) -> Result<Widget, String> {
    let parts = match arguments.get("parts") {
        None | Some(Value::Null) => Vec::new(),
        Some(_) => list(arguments, "parts", limits::PARTS, |part| {
            Ok((
                text(part, "label", 1, limits::PART_LABEL_CHARS)?,
                text(part, "text", 1, limits::PART_TEXT_CHARS)?,
                point(part.get("at"))?,
            ))
        })?,
    };
    let Some(drawing) = arguments.get("drawing").and_then(Value::as_str) else {
        return Err("drawing is missing: give the picture as SVG".to_owned());
    };
    let length = drawing.chars().count();
    if length > limits::DRAWING_CHARS {
        return Err(format!(
            "drawing is {length} characters; keep it to {}: draw fewer, simpler shapes",
            limits::DRAWING_CHARS
        ));
    }
    let reading = Reading::of(drawing)?;
    reading.in_parts(parts.len())?;
    let guess = match arguments.get("guess") {
        None | Some(Value::Null) => None,
        Some(guess) => Some(guessed(guess, parts.len())?),
    };
    let frame = reading.frame()?;
    let drawn = reading.framed(&frame);
    if drawn.is_empty() {
        return Err(
            "drawing has nothing to draw: draw the thing itself with path, circle, ellipse, rect, \
             line, polyline or polygon, with no background"
                .to_owned(),
        );
    }
    let given: Vec<Option<P>> = parts
        .iter()
        .map(|(_, _, at)| at.map(|at| frame.matrix.apply(at)))
        .collect();
    let words: Vec<(&RawLabel, P)> = reading
        .labels
        .iter()
        .map(|label| (label, frame.matrix.apply(label.at)))
        .collect();
    // A picture that plays shows its parts' numbers on its line of steps, not on it: no room is
    // kept for them, and nothing joins them to their parts.
    let plays = !reading.copies.is_empty();
    let crop = cropped(
        &drawn,
        if plays { &[] } else { &given },
        &words,
        frame.height,
    );
    let drawn: Vec<(&Raw, Vec<Segment>)> = drawn
        .into_iter()
        .map(|(raw, segments)| (raw, mapped(&segments, &crop.matrix)))
        .collect();
    let (mut shapes, owners) = outlined(&drawn);
    if shapes.len() > limits::SHAPES {
        return Err(format!(
            "drawing has {} shapes; keep it to {}: draw fewer, simpler shapes",
            shapes.len(),
            limits::SHAPES
        ));
    }
    let moves = moving(&reading.copies, &drawn, &owners, &shapes, &words)?;
    if guess.is_some() && moves.is_empty() {
        return Err(
            "guess is for a picture that plays: draw what moves again in each stage's part with \
             data-moves, or leave guess out"
                .to_owned(),
        );
    }
    let labels = words
        .iter()
        .map(|(label, at)| label.placed(crop.matrix.apply(*at)))
        .collect();
    let drawn_shapes = shapes.len();
    let placed = numbered(parts, &given, &drawn, &crop, &mut shapes)?;
    if plays {
        shapes.truncate(drawn_shapes);
    }
    Ok(Widget::Picture {
        title,
        width: WIDTH,
        height: rounded(crop.height),
        shapes,
        parts: placed,
        labels,
        moves,
        guess,
    })
}

/// Each thing drawn again at each stage, its copies in the order of their parts, checked to be drawn
/// the same way so every point has one to move to.
fn moving(
    copies: &[Copied],
    drawn: &[(&Raw, Vec<Segment>)],
    owners: &[usize],
    shapes: &[Shape],
    words: &[(&RawLabel, P)],
) -> Result<Vec<Move>, String> {
    let mut names: Vec<&str> = Vec::new();
    for copy in copies {
        if !names.contains(&copy.name.as_str()) {
            names.push(&copy.name);
        }
    }
    if names.len() > limits::MOVES {
        return Err(format!(
            "{} things move; keep it to {}: move only what the person should watch",
            names.len(),
            limits::MOVES
        ));
    }
    let mut moves = Vec::new();
    for name in names {
        let mut stages: Vec<Stage> = Vec::new();
        for (at, copy) in copies
            .iter()
            .enumerate()
            .filter(|(_, copy)| copy.name == name)
        {
            let Some(part) = copy.part else {
                return Err(format!(
                    "data-moves=\"{name}\" needs its stage: put data-part=\"N\" on the same g"
                ));
            };
            let own_shapes: Vec<usize> = owners
                .iter()
                .enumerate()
                .filter(|(_, owner)| drawn[**owner].0.copy == Some(at))
                .map(|(index, _)| index)
                .collect();
            let own_labels: Vec<usize> = words
                .iter()
                .enumerate()
                .filter(|(_, (label, _))| label.copy == Some(at))
                .map(|(index, _)| index)
                .collect();
            if own_shapes
                .iter()
                .any(|index| shapes[*index].part != Some(part))
                || own_labels
                    .iter()
                    .any(|index| words[*index].0.part != Some(part))
            {
                return Err(format!(
                    "everything in a copy of \"{name}\" belongs to its stage, part {part}: take \
                     data-part off what is inside it"
                ));
            }
            if own_shapes.is_empty() && own_labels.is_empty() {
                return Err(format!(
                    "the copy of \"{name}\" in part {part} has nothing in it"
                ));
            }
            if stages.iter().any(|stage| stage.part == part) {
                return Err(format!(
                    "\"{name}\" is drawn twice in part {part}: draw it once in each stage"
                ));
            }
            stages.push(Stage {
                part,
                shapes: own_shapes,
                labels: own_labels,
            });
        }
        if stages.len() < 2 {
            return Err(format!(
                "\"{name}\" is drawn in one part only: draw it again in each part where it has \
                 moved, or leave data-moves off"
            ));
        }
        stages.sort_by_key(|stage| stage.part);
        alike(name, &stages, shapes)?;
        moves.push(Move { stages });
    }
    Ok(moves)
}

/// Each stage of `name` drawn as the one before it: the same shapes with the same commands, and as
/// many labels, so every point and word has one to move to.
fn alike(name: &str, stages: &[Stage], shapes: &[Shape]) -> Result<(), String> {
    for pair in stages.windows(2) {
        let (from, to) = (&pair[0], &pair[1]);
        let alike = from.shapes.len() == to.shapes.len()
            && from
                .shapes
                .iter()
                .zip(&to.shapes)
                .all(|(a, b)| commands(&shapes[*a].d) == commands(&shapes[*b].d));
        if !alike {
            return Err(format!(
                "\"{name}\" isn't drawn the same way in parts {} and {}: draw each copy with \
                 the same shapes in the same order, changing only where it is, its size or its \
                 turn",
                from.part, to.part
            ));
        }
        if from.labels.len() != to.labels.len() {
            return Err(format!(
                "\"{name}\" has {} labels in part {} and {} in part {}: give each copy the \
                 same labels",
                from.labels.len(),
                from.part,
                to.labels.len(),
                to.part
            ));
        }
    }
    Ok(())
}

/// An outline moved by `matrix`.
fn mapped(segments: &[Segment], matrix: &Matrix) -> Vec<Segment> {
    segments
        .iter()
        .map(|segment| segment.mapped(matrix))
        .collect()
}

/// A shape's commands without their points: two shapes alike in these can move into each other.
fn commands(d: &str) -> String {
    d.chars().filter(char::is_ascii_alphabetic).collect()
}

/// The question to ask before a step, checked against the parts it names.
fn guessed(value: &Value, parts: usize) -> Result<Guess, String> {
    if parts < 2 {
        return Err("guess needs a picture in stages: give its stages as parts".to_owned());
    }
    let before = value
        .get("before")
        .and_then(Value::as_u64)
        .and_then(|before| u8::try_from(before).ok())
        .filter(|before| (2..=parts).contains(&usize::from(*before)))
        .ok_or_else(|| {
            format!("guess.before is the part the question comes before, from 2 to {parts}")
        })?;
    let question = text(value, "question", 1, limits::GUESS_CHARS)
        .map_err(|error| format!("guess.{error}"))?;
    let choices = list(value, "choices", limits::GUESS_CHOICES, |choice| {
        choice
            .as_str()
            .map(str::trim)
            .filter(|choice| {
                !choice.is_empty() && choice.chars().count() <= limits::GUESS_CHOICE_CHARS
            })
            .map(str::to_owned)
            .ok_or_else(|| {
                format!(
                    "each choice is a few words, {} characters at most",
                    limits::GUESS_CHOICE_CHARS
                )
            })
    })
    .map_err(|error| format!("guess.{error}"))?;
    let answer = value
        .get("answer")
        .and_then(Value::as_str)
        .map(str::trim)
        .and_then(|answer| choices.iter().position(|choice| choice == answer))
        .and_then(|answer| u8::try_from(answer).ok())
        .ok_or_else(|| "guess.answer is the right choice, written as in choices".to_owned())?;
    Ok(Guess {
        before,
        question,
        choices,
        answer,
    })
}

/// Each shape as the apps draw it, with a head on each open stroke of an arrowed path: a model
/// writes several arrows as one path with one marker, meaning each, where SVG would mark only its
/// last point. Beside them, which of `drawn` each came from.
fn outlined(drawn: &[(&Raw, Vec<Segment>)]) -> (Vec<Shape>, Vec<usize>) {
    let mut shapes = Vec::new();
    let mut owners = Vec::new();
    for (owner, (raw, segments)) in drawn.iter().enumerate() {
        owners.push(owner);
        shapes.push(Shape {
            d: path_data(segments),
            part: raw.part,
            fill: raw.fill,
            dashed: raw.dashed,
        });
        for stroke in strokes(segments).filter(|stroke| !stroke.contains(&Segment::Close)) {
            for (tip, from) in [
                raw.arrow_end.then(|| end_of(stroke)).flatten(),
                raw.arrow_start.then(|| start_of(stroke)).flatten(),
            ]
            .into_iter()
            .flatten()
            {
                owners.push(owner);
                shapes.push(Shape {
                    d: arrowhead(tip, from),
                    part: raw.part,
                    fill: None,
                    dashed: false,
                });
            }
        }
    }
    (shapes, owners)
}

/// Each part where its number stands: where the agent put it, or above its shapes; with a line
/// to its part when the agent put it away from it, added to `shapes`.
fn numbered(
    parts: Vec<(String, String, Option<P>)>,
    given: &[Option<P>],
    drawn: &[(&Raw, Vec<Segment>)],
    crop: &Frame,
    shapes: &mut Vec<Shape>,
) -> Result<Vec<Part>, String> {
    let mut placed = Vec::new();
    for (at, ((label, words, _), given)) in parts.into_iter().zip(given.iter().copied()).enumerate()
    {
        let number = u8::try_from(at + 1).unwrap_or(u8::MAX);
        let own: Vec<Segment> = drawn
            .iter()
            .filter(|(raw, _)| raw.part == Some(number))
            .flat_map(|(_, segments)| segments.iter().copied())
            .collect();
        let at = match given {
            Some(given) => crop.matrix.apply(given),
            None if own.is_empty() => {
                return Err(format!(
                    "part {number} \"{label}\" has no shapes and no at: put \
                 data-part=\"{number}\" on what shows it"
                ));
            }
            None => mark_beside(&Bounds::of(&own), crop.height),
        };
        let at = P {
            x: at.x.clamp(MARK, WIDTH - MARK),
            y: at.y.clamp(MARK, crop.height - MARK),
        };
        // A number the agent put away from what it names is joined to it, as a textbook figure
        // joins a label to its part: often the only free ground is beyond something larger.
        if let Some(near) = nearest(&own, at)
            && near.minus(at).length() > LEADER_FROM
        {
            let back = at.minus(near);
            let end = near.plus(back.times(LEADER_GAP / back.length()));
            shapes.push(Shape {
                d: path_data(&[Segment::Move(at), Segment::Line(end)]),
                part: Some(number),
                fill: None,
                dashed: false,
            });
        }
        placed.push(Part {
            label,
            text: words,
            at: [rounded(at.x), rounded(at.y)],
        });
    }
    Ok(placed)
}

/// The frame cut down to what is drawn, with room around it and for the parts' numbers, and
/// scaled back to [`WIDTH`]: a drawing that leaves half its frame empty still fills its picture.
/// Within the shapes' limits of wide and tall; the whole frame when that is near all of it.
fn cropped(
    drawn: &[(&Raw, Vec<Segment>)],
    given: &[Option<P>],
    words: &[(&RawLabel, P)],
    height: f64,
) -> Frame {
    let all: Vec<Segment> = drawn
        .iter()
        .flat_map(|(_, segments)| segments.iter().copied())
        .collect();
    let mut bounds = Bounds::of(&all);
    for p in given.iter().flatten() {
        bounds.include(*p);
    }
    // A label keeps its room: about as wide as the app sets its words, from the edge it stands on.
    for (label, at) in words {
        #[allow(clippy::cast_precision_loss)]
        let wide = label.text.chars().count() as f64 * WORD_CHAR;
        let left = match label.anchor {
            Anchor::Start => at.x,
            Anchor::Middle => at.x - wide / 2.0,
            Anchor::End => at.x - wide,
        };
        bounds.include(P {
            x: left,
            y: at.y - WORD_HALF,
        });
        bounds.include(P {
            x: left + wide,
            y: at.y + WORD_HALF,
        });
    }
    if given.iter().any(Option::is_none) {
        // A number of its own stands above its part's shapes.
        bounds.top -= MARK_GAP + MARK;
    }
    let mut left = (bounds.left - MARGIN).max(0.0);
    let mut top = (bounds.top - MARGIN).max(0.0);
    let mut width = (bounds.right + MARGIN).min(WIDTH) - left;
    let mut tall = (bounds.bottom + MARGIN).min(height) - top;
    let whole = Frame {
        matrix: Matrix::IDENTITY,
        height,
    };
    if width <= 1.0 || tall <= 1.0 || width * tall >= KEEP_WHOLE * WIDTH * height {
        return whole;
    }
    if width / tall > limits::MOST_ASPECT {
        let grown = width / limits::MOST_ASPECT;
        top -= (grown - tall) / 2.0;
        tall = grown;
    } else if tall / width > limits::MOST_ASPECT {
        let grown = tall / limits::MOST_ASPECT;
        left -= (grown - width) / 2.0;
        width = grown;
    }
    let scale = WIDTH / width;
    Frame {
        matrix: Matrix::scale(scale, scale).then(&Matrix::translate(-left, -top)),
        height: tall * scale,
    }
}

/// Room left around what is drawn when a picture is cut to it.
const MARGIN: f64 = 20.0;
/// A cut keeping this share of the frame or more isn't made.
const KEEP_WHOLE: f64 = 0.9;

/// A filled shape at least this share of the frame is its background, left out.
const BACKGROUND: f64 = 0.9;
/// Half a part's number mark, in the picture's units: the least room it needs from an edge.
const MARK: f64 = 16.0;
/// How far a part's number stands from its shapes.
const MARK_GAP: f64 = 20.0;
/// How far a number may stand from its part before a line joins them, about a number's width on
/// a phone; and how short of the part the line stops.
const LEADER_FROM: f64 = 48.0;
const LEADER_GAP: f64 = 6.0;
/// How wide a label's character, and half its height, stand in the picture's units, about as the
/// apps set them in a chat: room kept for it when a picture is cut.
const WORD_CHAR: f64 = 8.0;
const WORD_HALF: f64 = 10.0;
/// An arrowhead's sides, and their angle either side of the line.
const HEAD_LENGTH: f64 = 14.0;
const HEAD_ANGLE: f64 = 0.45;

/// `[x, y]`, when given.
fn point(value: Option<&Value>) -> Result<Option<P>, String> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(pair)) if pair.len() == 2 => {
            let x = pair[0].as_f64().filter(|x| x.is_finite());
            let y = pair[1].as_f64().filter(|y| y.is_finite());
            match (x, y) {
                (Some(x), Some(y)) => Ok(Some(P { x, y })),
                _ => Err("at is [x, y], two numbers in the drawing's units".to_owned()),
            }
        }
        Some(_) => Err("at is [x, y], two numbers in the drawing's units".to_owned()),
    }
}

/// Above the shapes, centred; below them when they reach the top.
fn mark_beside(bounds: &Bounds, height: f64) -> P {
    let x = f64::midpoint(bounds.left, bounds.right);
    let above = bounds.top - MARK_GAP;
    if above >= MARK {
        P { x, y: above }
    } else {
        P {
            x,
            y: (bounds.bottom + MARK_GAP).min(height - MARK),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
struct P {
    x: f64,
    y: f64,
}

impl P {
    fn plus(self, other: Self) -> Self {
        Self {
            x: self.x + other.x,
            y: self.y + other.y,
        }
    }

    fn minus(self, other: Self) -> Self {
        Self {
            x: self.x - other.x,
            y: self.y - other.y,
        }
    }

    fn times(self, by: f64) -> Self {
        Self {
            x: self.x * by,
            y: self.y * by,
        }
    }

    fn length(self) -> f64 {
        self.x.hypot(self.y)
    }
}

/// An affine transform, as SVG writes one: `(x, y)` goes to `(a x + c y + e, b x + d y + f)`.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Matrix {
    a: f64,
    b: f64,
    c: f64,
    d: f64,
    e: f64,
    f: f64,
}

impl Matrix {
    const IDENTITY: Self = Self {
        a: 1.0,
        b: 0.0,
        c: 0.0,
        d: 1.0,
        e: 0.0,
        f: 0.0,
    };

    fn translate(x: f64, y: f64) -> Self {
        Self {
            e: x,
            f: y,
            ..Self::IDENTITY
        }
    }

    fn scale(x: f64, y: f64) -> Self {
        Self {
            a: x,
            d: y,
            ..Self::IDENTITY
        }
    }

    fn rotate(degrees: f64) -> Self {
        let (sin, cos) = degrees.to_radians().sin_cos();
        Self {
            a: cos,
            b: sin,
            c: -sin,
            d: cos,
            e: 0.0,
            f: 0.0,
        }
    }

    /// `self` after `then`: a point goes through `then` first.
    fn then(&self, then: &Self) -> Self {
        Self {
            a: self.a * then.a + self.c * then.b,
            b: self.b * then.a + self.d * then.b,
            c: self.a * then.c + self.c * then.d,
            d: self.b * then.c + self.d * then.d,
            e: self.a * then.e + self.c * then.f + self.e,
            f: self.b * then.e + self.d * then.f + self.f,
        }
    }

    fn apply(&self, p: P) -> P {
        P {
            x: self.a * p.x + self.c * p.y + self.e,
            y: self.b * p.x + self.d * p.y + self.f,
        }
    }
}

/// One piece of an outline, in absolute points: what every shape and path command becomes.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Segment {
    Move(P),
    Line(P),
    Cubic(P, P, P),
    Close,
}

impl Segment {
    fn mapped(&self, matrix: &Matrix) -> Self {
        match *self {
            Self::Move(p) => Self::Move(matrix.apply(p)),
            Self::Line(p) => Self::Line(matrix.apply(p)),
            Self::Cubic(a, b, c) => Self::Cubic(matrix.apply(a), matrix.apply(b), matrix.apply(c)),
            Self::Close => Self::Close,
        }
    }

    fn points(&self) -> Vec<P> {
        match *self {
            Self::Move(p) | Self::Line(p) => vec![p],
            Self::Cubic(a, b, c) => vec![a, b, c],
            Self::Close => Vec::new(),
        }
    }
}

/// The box around some outlines, their curves' handles counted: near enough for placing a mark.
#[derive(Debug, Clone, Copy)]
struct Bounds {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}

impl Bounds {
    fn of(segments: &[Segment]) -> Self {
        let mut bounds = Self {
            left: f64::INFINITY,
            top: f64::INFINITY,
            right: f64::NEG_INFINITY,
            bottom: f64::NEG_INFINITY,
        };
        for p in segments.iter().flat_map(Segment::points) {
            bounds.include(p);
        }
        bounds
    }

    fn include(&mut self, p: P) {
        self.left = self.left.min(p.x);
        self.top = self.top.min(p.y);
        self.right = self.right.max(p.x);
        self.bottom = self.bottom.max(p.y);
    }

    fn area(&self) -> f64 {
        if self.right < self.left {
            return 0.0;
        }
        (self.right - self.left) * (self.bottom - self.top)
    }
}

/// The point of these outlines nearest `to`, from points along each line and curve: near enough
/// to aim a line at.
// A curve's handles and its parameter, as the formula names them.
#[allow(clippy::many_single_char_names)]
fn nearest(segments: &[Segment], to: P) -> Option<P> {
    let mut current = None;
    let mut start = None;
    let mut best: Option<P> = None;
    let mut consider = |p: P| {
        if best.is_none_or(|best| p.minus(to).length() < best.minus(to).length()) {
            best = Some(p);
        }
    };
    for segment in segments {
        match *segment {
            Segment::Move(p) => {
                current = Some(p);
                start = Some(p);
                consider(p);
            }
            Segment::Line(_) | Segment::Close => {
                let Some(from) = current else { continue };
                let p = match *segment {
                    Segment::Line(p) => p,
                    _ => start.unwrap_or(from),
                };
                for step in 0..=8 {
                    consider(from.plus(p.minus(from).times(f64::from(step) / 8.0)));
                }
                current = Some(p);
            }
            Segment::Cubic(a, b, c) => {
                let from = current.unwrap_or(a);
                for step in 0..=8 {
                    let t = f64::from(step) / 8.0;
                    let u = 1.0 - t;
                    consider(
                        from.times(u * u * u)
                            .plus(a.times(3.0 * u * u * t))
                            .plus(b.times(3.0 * u * t * t))
                            .plus(c.times(t * t * t)),
                    );
                }
                current = Some(c);
            }
        }
    }
    best
}

/// An outline's strokes: each from one move to the next.
fn strokes(segments: &[Segment]) -> impl Iterator<Item = &[Segment]> {
    let starts: Vec<usize> = segments
        .iter()
        .enumerate()
        .filter(|(_, segment)| matches!(segment, Segment::Move(_)))
        .map(|(at, _)| at)
        .collect();
    let ends: Vec<usize> = starts
        .iter()
        .skip(1)
        .copied()
        .chain([segments.len()])
        .collect();
    starts
        .into_iter()
        .zip(ends)
        .map(move |(start, end)| &segments[start..end])
}

/// The point an outline ends on, and a point just before it, for an arrowhead pointing on.
fn end_of(segments: &[Segment]) -> Option<(P, P)> {
    let mut current = None;
    let mut start = None;
    let mut last = None;
    for segment in segments {
        match *segment {
            Segment::Move(p) => {
                current = Some(p);
                start = Some(p);
            }
            Segment::Line(p) => {
                last = current.map(|from| (p, from));
                current = Some(p);
            }
            Segment::Cubic(a, b, c) => {
                let from = [b, a]
                    .into_iter()
                    .find(|handle| handle.minus(c).length() > 1e-6)
                    .or(current);
                last = from.map(|from| (c, from));
                current = Some(c);
            }
            Segment::Close => {
                if let (Some(from), Some(to)) = (current, start) {
                    last = Some((to, from));
                }
                current = start;
            }
        }
    }
    last.filter(|(tip, from)| tip.minus(*from).length() > 1e-6)
}

/// The point an outline starts on, and the next one, for an arrowhead pointing back.
fn start_of(segments: &[Segment]) -> Option<(P, P)> {
    let mut iter = segments.iter();
    let Some(Segment::Move(tip)) = iter.next() else {
        return None;
    };
    let next = match iter.next()? {
        Segment::Line(p) => *p,
        Segment::Cubic(a, b, c) => [*a, *b, *c]
            .into_iter()
            .find(|p| p.minus(*tip).length() > 1e-6)?,
        _ => return None,
    };
    Some((*tip, next)).filter(|(tip, next)| tip.minus(*next).length() > 1e-6)
}

/// Two short strokes back from `tip`, away from `from`.
fn arrowhead(tip: P, from: P) -> String {
    let back = from.minus(tip);
    let unit = back.times(1.0 / back.length());
    let side = |angle: f64| {
        let (sin, cos) = angle.sin_cos();
        tip.plus(
            P {
                x: unit.x * cos - unit.y * sin,
                y: unit.x * sin + unit.y * cos,
            }
            .times(HEAD_LENGTH),
        )
    };
    path_data(&[
        Segment::Move(side(HEAD_ANGLE)),
        Segment::Line(tip),
        Segment::Line(side(-HEAD_ANGLE)),
    ])
}

/// `M10 20L30.5 40C…Z`: absolute, to a tenth of a unit.
fn path_data(segments: &[Segment]) -> String {
    let mut out = String::new();
    for segment in segments {
        let (letter, points) = match segment {
            Segment::Move(_) => ('M', segment.points()),
            Segment::Line(_) => ('L', segment.points()),
            Segment::Cubic(..) => ('C', segment.points()),
            Segment::Close => ('Z', Vec::new()),
        };
        out.push(letter);
        for (at, p) in points.iter().enumerate() {
            if at > 0 {
                out.push(' ');
            }
            let _ = write!(out, "{} {}", number(p.x), number(p.y));
        }
    }
    out
}

fn rounded(value: f64) -> f64 {
    let value = (value * 10.0).round() / 10.0;
    if value == 0.0 { 0.0 } else { value }
}

/// A number to a tenth, without a trailing `.0` or a `-0`.
fn number(value: f64) -> String {
    let value = rounded(value);
    if value.fract() == 0.0 && value.abs() < 1e15 {
        // A whole number that fits: written without its point.
        #[allow(clippy::cast_possible_truncation)]
        let whole = value as i64;
        whole.to_string()
    } else {
        format!("{value:.1}")
    }
}

// ---------------------------------------------------------------------------------------------
// Reading the SVG
// ---------------------------------------------------------------------------------------------

/// Elements whose content is never drawn: definitions, paint, pictures and code, and words that
/// aren't on the picture (a title, a description).
const LEFT_OUT: &[&str] = &[
    "defs",
    "title",
    "desc",
    "metadata",
    "style",
    "script",
    "marker",
    "clippath",
    "mask",
    "pattern",
    "lineargradient",
    "radialgradient",
    "filter",
    "symbol",
    "image",
    "foreignobject",
    "switch",
    "a",
];

/// The most elements a drawing may have, all counted.
const MOST_ELEMENTS: usize = 600;

/// What is inherited from a group: how its shapes are filled and dashed, their markers, their part,
/// and the transform to the drawing's own units.
#[derive(Debug, Clone)]
struct Style {
    fill: Fill,
    dashed: bool,
    arrow_end: bool,
    arrow_start: bool,
    part: Option<u8>,
    matrix: Matrix,
    anchor: Anchor,
    font_size: f64,
    /// The copy of a moving thing it is in, an index into [`Reading::copies`].
    copy: Option<usize>,
}

#[derive(Debug, Clone, PartialEq)]
enum Fill {
    /// Not said: closed shapes are shaded lightly, open lines not at all.
    Unset,
    None,
    Shaded(Shade),
}

/// One shape as drawn, in the drawing's units.
#[derive(Debug)]
struct Raw {
    segments: Vec<Segment>,
    part: Option<u8>,
    fill: Option<Shade>,
    dashed: bool,
    arrow_end: bool,
    arrow_start: bool,
    copy: Option<usize>,
}

/// One label as written, its middle in the drawing's units.
#[derive(Debug)]
struct RawLabel {
    text: String,
    at: P,
    anchor: Anchor,
    part: Option<u8>,
    copy: Option<usize>,
}

impl RawLabel {
    /// As the apps read it, its middle at `at` in the picture's units.
    fn placed(&self, at: P) -> Label {
        Label {
            text: self.text.clone(),
            at: [rounded(at.x), rounded(at.y)],
            anchor: self.anchor,
            part: self.part,
        }
    }
}

/// One copy of a moving thing: what it is called, and the stage (part) it is drawn in.
#[derive(Debug)]
struct Copied {
    name: String,
    part: Option<u8>,
}

/// A `text` being read: where it stands and what it says so far, and how deep in its `tspan`s.
struct Words {
    label: RawLabel,
    depth: usize,
}

/// Where the drawing's units go: scaled to [`WIDTH`], and the height that gives.
struct Frame {
    matrix: Matrix,
    height: f64,
}

/// A drawing read: its frame as the outer `svg` says it, and its shapes.
#[derive(Debug, Default)]
struct Reading {
    view_box: Option<(f64, f64, f64, f64)>,
    shapes: Vec<Raw>,
    labels: Vec<RawLabel>,
    copies: Vec<Copied>,
    segments: usize,
}

impl Reading {
    // One walk through the drawing, its elements in order: split up, it reads worse.
    #[allow(clippy::too_many_lines)]
    fn of(drawing: &str) -> Result<Self, String> {
        let mut reader = Reader::from_str(drawing);
        let mut reading = Self::default();
        let mut stack = vec![Style {
            fill: Fill::Unset,
            dashed: false,
            arrow_end: false,
            arrow_start: false,
            part: None,
            matrix: Matrix::IDENTITY,
            anchor: Anchor::Start,
            font_size: DEFAULT_FONT,
            copy: None,
        }];
        let mut skipping = 0_usize;
        let mut words: Option<Words> = None;
        let mut elements = 0_usize;
        let mut seen_svg = false;
        loop {
            let event = reader.read_event().map_err(|error| {
                format!("the drawing isn't SVG LoomWatch can read ({error}): write it as SVG")
            })?;
            if let Some(reading_words) = words.as_mut() {
                match event {
                    Event::Text(text) => reading_words.label.text.push_str(&text.xml10_content()),
                    Event::CData(text) => reading_words.label.text.push_str(&text.xml10_content()),
                    Event::GeneralRef(reference) => {
                        if let Some(written) = referred(&reference) {
                            reading_words.label.text.push_str(&written);
                        }
                    }
                    Event::Start(_) => {
                        elements += 1;
                        reading_words.depth += 1;
                        reading_words.label.text.push(' ');
                    }
                    Event::End(_) if reading_words.depth > 0 => {
                        reading_words.depth -= 1;
                        reading_words.label.text.push(' ');
                    }
                    Event::End(_) => {
                        if let Some(done) = words.take() {
                            reading.keep(done.label)?;
                        }
                    }
                    Event::Eof => break,
                    _ => {}
                }
                continue;
            }
            let (tag, opens) = match event {
                Event::Eof => break,
                Event::Start(tag) => (tag, true),
                Event::Empty(tag) => (tag, false),
                Event::End(_) => {
                    if skipping > 0 {
                        skipping -= 1;
                    } else if stack.len() > 1 {
                        stack.pop();
                    }
                    continue;
                }
                _ => continue,
            };
            if skipping > 0 {
                if opens {
                    skipping += 1;
                }
                continue;
            }
            elements += 1;
            if elements > MOST_ELEMENTS {
                return Err(format!(
                    "the drawing has more than {MOST_ELEMENTS} elements: draw fewer, simpler shapes"
                ));
            }
            let name = tag.local_name().as_ref().to_lowercase();
            if name == "use" {
                // A copy would go missing without a word: the agent draws it again instead.
                return Err(
                    "<use> isn't drawn: draw each copy in a g with its own transform".to_owned(),
                );
            }
            let hidden = property(&tag, "display").as_deref() == Some("none")
                || property(&tag, "visibility").as_deref() == Some("hidden");
            if LEFT_OUT.contains(&name.as_str()) || hidden {
                if opens {
                    skipping = 1;
                }
                continue;
            }
            let parent = stack
                .last()
                .cloned()
                .unwrap_or_else(|| unreachable!("the drawing's own style stays at the bottom"));
            let mut style = styled(&parent, &tag, &name)?;
            if name == "svg" && !seen_svg {
                seen_svg = true;
                reading.view_box = frame_of(&tag)?;
            }
            if let Some(moves) = attribute(&tag, "data-moves") {
                if parent.copy.is_some() {
                    return Err(format!(
                        "<{name}> has data-moves inside another data-moves: give it to the outer \
                         g only"
                    ));
                }
                if moves.is_empty() || moves.chars().count() > limits::ID_CHARS {
                    return Err(format!(
                        "data-moves=\"{moves}\" names what moves in a word or two"
                    ));
                }
                reading.copies.push(Copied {
                    name: moves,
                    part: style.part,
                });
                style.copy = Some(reading.copies.len() - 1);
            }
            if name == "text" {
                if opens {
                    words = Some(Words {
                        label: RawLabel {
                            text: String::new(),
                            at: style.matrix.apply(placed(&tag, &style)?),
                            anchor: style.anchor,
                            part: style.part,
                            copy: style.copy,
                        },
                        depth: 0,
                    });
                }
                continue;
            }
            if let Some(segments) = outline(&name, &tag)? {
                let segments: Vec<Segment> = segments
                    .iter()
                    .map(|segment| segment.mapped(&style.matrix))
                    .collect();
                reading.segments += segments.len();
                if reading.segments > limits::SEGMENTS {
                    return Err(format!(
                        "the drawing has more than {} points: draw fewer, simpler shapes",
                        limits::SEGMENTS
                    ));
                }
                if !segments.is_empty() {
                    let closed = matches!(name.as_str(), "circle" | "ellipse" | "rect" | "polygon")
                        || segments.contains(&Segment::Close);
                    reading.shapes.push(Raw {
                        fill: match style.fill {
                            Fill::Unset => closed.then_some(Shade::Light),
                            Fill::None => None,
                            Fill::Shaded(shade) => Some(shade),
                        },
                        segments,
                        part: style.part,
                        dashed: style.dashed,
                        arrow_end: style.arrow_end,
                        arrow_start: style.arrow_start,
                        copy: style.copy,
                    });
                }
            }
            if opens {
                if stack.len() > limits::DEPTH {
                    return Err(format!(
                        "the drawing's groups go more than {} deep",
                        limits::DEPTH
                    ));
                }
                stack.push(style);
            }
        }
        Ok(reading)
    }

    /// Each shape in the frame's units, a sky or a backdrop left out: the picture stands on the
    /// chat's own ground.
    fn framed(&self, frame: &Frame) -> Vec<(&Raw, Vec<Segment>)> {
        self.shapes
            .iter()
            .filter_map(|raw| {
                let segments = mapped(&raw.segments, &frame.matrix);
                let backdrop = raw.part.is_none()
                    && raw.fill.is_some()
                    && Bounds::of(&segments).area() >= BACKGROUND * WIDTH * frame.height;
                (!backdrop).then_some((raw, segments))
            })
            .collect()
    }

    /// Every shape and label is in a part there is.
    fn in_parts(&self, count: usize) -> Result<(), String> {
        for (what, part) in [
            (
                "shape",
                self.shapes.iter().filter_map(|shape| shape.part).max(),
            ),
            (
                "label",
                self.labels.iter().filter_map(|label| label.part).max(),
            ),
        ] {
            if let Some(part) = part
                && usize::from(part) > count
            {
                return Err(match count {
                    0 => format!(
                        "a {what} has data-part=\"{part}\", but there are no parts: give parts"
                    ),
                    count => format!(
                        "a {what} has data-part=\"{part}\", but there are {count} parts: number \
                         them from 1 to {count}"
                    ),
                });
            }
        }
        Ok(())
    }

    /// A label read whole: its words in one line, kept when they say something, refused when they
    /// say too much.
    fn keep(&mut self, mut label: RawLabel) -> Result<(), String> {
        label.text = label.text.split_whitespace().collect::<Vec<_>>().join(" ");
        if label.text.is_empty() {
            return Ok(());
        }
        let length = label.text.chars().count();
        if length > limits::LABEL_WORDS_CHARS {
            let start: String = label.text.chars().take(24).collect();
            return Err(format!(
                "a label says \"{start}…\" in {length} characters: keep each label to a few \
                 words, {} at most, and say the rest in the parts",
                limits::LABEL_WORDS_CHARS
            ));
        }
        if self.labels.len() == limits::LABELS {
            return Err(format!(
                "the drawing has more than {} labels: name only what the person needs to know",
                limits::LABELS
            ));
        }
        self.labels.push(label);
        Ok(())
    }

    /// The outer `svg`'s `viewBox`, else the box around every shape with a little room.
    fn frame(&self) -> Result<Frame, String> {
        let (left, top, width, height) = if let Some(view_box) = self.view_box {
            view_box
        } else {
            let all: Vec<Segment> = self
                .shapes
                .iter()
                .flat_map(|shape| shape.segments.iter().copied())
                .collect();
            let bounds = Bounds::of(&all);
            if bounds.right < bounds.left {
                return Err(
                    "drawing has nothing to draw: draw the thing itself with path, circle, \
                     ellipse, rect, line, polyline or polygon"
                        .to_owned(),
                );
            }
            let room = (bounds.right - bounds.left).max(bounds.bottom - bounds.top) * 0.04;
            (
                bounds.left - room,
                bounds.top - room,
                bounds.right - bounds.left + 2.0 * room,
                bounds.bottom - bounds.top + 2.0 * room,
            )
        };
        if !(width > 0.0 && height > 0.0) {
            return Err("the svg's viewBox needs a width and a height above 0".to_owned());
        }
        let aspect = width / height;
        if aspect > limits::MOST_ASPECT || aspect < 1.0 / limits::MOST_ASPECT {
            return Err(format!(
                "the drawing is {} wide for 1 tall; keep it between 1:{most} and {most}:1, such as \
                 viewBox=\"0 0 640 360\"",
                number(aspect),
                most = limits::MOST_ASPECT
            ));
        }
        let scale = WIDTH / width;
        Ok(Frame {
            matrix: Matrix::scale(scale, scale).then(&Matrix::translate(-left, -top)),
            height: height * scale,
        })
    }
}

/// An attribute's value, unescaped and trimmed.
fn attribute(tag: &BytesStart<'_>, key: &str) -> Option<String> {
    tag.attributes()
        .with_checks(false)
        .flatten()
        .find(|attribute| attribute.key.as_ref() == key)
        .map(|attribute| {
            quick_xml::escape::unescape(&attribute.value).map_or_else(
                |_| attribute.value.trim().to_owned(),
                |value| value.trim().to_owned(),
            )
        })
}

/// A property from the element's attribute or its `style`, the style winning as in SVG.
fn property(tag: &BytesStart<'_>, key: &str) -> Option<String> {
    let styled = attribute(tag, "style").and_then(|style| {
        style.split(';').find_map(|declaration| {
            let (name, value) = declaration.split_once(':')?;
            (name.trim().eq_ignore_ascii_case(key)).then(|| value.trim().to_owned())
        })
    });
    styled.or_else(|| attribute(tag, key))
}

/// `parent`'s style with this element's own over it.
fn styled(parent: &Style, tag: &BytesStart<'_>, name: &str) -> Result<Style, String> {
    let mut style = parent.clone();
    if let Some(fill) = property(tag, "fill") {
        style.fill = fill_of(&fill);
    }
    if property(tag, "fill-opacity")
        .or_else(|| property(tag, "opacity"))
        .and_then(|opacity| opacity.parse::<f64>().ok())
        .is_some_and(|opacity| opacity <= 0.05)
    {
        style.fill = Fill::None;
    }
    if let Some(dashes) = property(tag, "stroke-dasharray") {
        let dashes = dashes.to_ascii_lowercase();
        style.dashed = dashes != "none"
            && dashes.split([' ', ',']).any(|dash| {
                dash.trim_end_matches("px")
                    .parse::<f64>()
                    .is_ok_and(|dash| dash > 0.0)
            });
    }
    let marker = |key: &str| property(tag, key).map(|marker| !marker.eq_ignore_ascii_case("none"));
    if let Some(on) = marker("marker-end") {
        style.arrow_end = on;
    }
    if let Some(on) = marker("marker-start") {
        style.arrow_start = on;
    }
    match property(tag, "text-anchor").as_deref() {
        Some("middle") => style.anchor = Anchor::Middle,
        Some("end") => style.anchor = Anchor::End,
        Some("start") => style.anchor = Anchor::Start,
        _ => {}
    }
    if let Some(size) = property(tag, "font-size")
        .and_then(|size| size.trim_end_matches("px").trim().parse::<f64>().ok())
        .filter(|size| size.is_finite() && *size > 0.0)
    {
        style.font_size = size;
    }
    if let Some(part) = attribute(tag, "data-part") {
        let number = part
            .parse::<u8>()
            .ok()
            .filter(|number| *number >= 1)
            .ok_or_else(|| {
                format!("<{name}> has data-part=\"{part}\": give its part's number, from 1")
            })?;
        style.part = Some(number);
    }
    if let Some(transform) = attribute(tag, "transform") {
        let own = transform_of(&transform).map_err(|error| format!("<{name}> {error}"))?;
        style.matrix = style.matrix.then(&own);
    }
    Ok(style)
}

/// SVG's size for words when none is said.
const DEFAULT_FONT: f64 = 16.0;

/// The middle of a `text`'s words, in its own units: its `x` (the first, when it lists several) and
/// its baseline raised to the middle of its letters, as its `dominant-baseline` says.
fn placed(tag: &BytesStart<'_>, style: &Style) -> Result<P, String> {
    let first = |key: &str| -> Result<f64, String> {
        let Some(written) = attribute(tag, key) else {
            return Ok(0.0);
        };
        let bare = written.replace("px", "");
        Lexer::new(&bare)
            .numbers()
            .ok()
            .and_then(|numbers| numbers.first().copied())
            .filter(|value| value.is_finite())
            .ok_or_else(|| {
                format!("<text> {key}=\"{written}\" isn't a number: give it in the drawing's units")
            })
    };
    let raise = match property(tag, "dominant-baseline").as_deref() {
        Some("middle" | "central") => 0.0,
        Some("hanging" | "text-before-edge") => 0.4 * style.font_size,
        _ => -0.35 * style.font_size,
    };
    Ok(P {
        x: first("x")?,
        y: first("y")? + raise,
    })
}

/// What `&amp;` or `&#233;` in a label stands for.
fn referred(reference: &quick_xml::events::BytesRef<'_>) -> Option<String> {
    if reference.is_char_ref() {
        return reference
            .resolve_char_ref()
            .ok()
            .flatten()
            .map(String::from);
    }
    quick_xml::escape::resolve_predefined_entity(&reference.xml10_content()).map(str::to_owned)
}

/// How a fill colour is drawn: none, a light shade, or a dark one for a dark colour.
fn fill_of(fill: &str) -> Fill {
    let fill = fill.trim().to_ascii_lowercase();
    if fill == "none" || fill == "transparent" {
        return Fill::None;
    }
    let lightness = colour_lightness(&fill);
    Fill::Shaded(match lightness {
        Some(lightness) if lightness < 0.42 => Shade::Dark,
        None if DARK_NAMES.contains(&fill.as_str()) => Shade::Dark,
        _ => Shade::Light,
    })
}

/// Colour names a model uses for something drawn dark.
const DARK_NAMES: &[&str] = &[
    "black",
    "currentcolor",
    "navy",
    "darkblue",
    "midnightblue",
    "darkgreen",
    "darkred",
    "maroon",
    "indigo",
    "purple",
    "brown",
    "saddlebrown",
    "dimgray",
    "dimgrey",
    "darkslategray",
    "darkslategrey",
    "darkslateblue",
    "darkolivegreen",
];

/// How light `#rgb`, `#rrggbb` (with or without alpha) or `rgb(r, g, b)` is, from 0 to 1.
fn colour_lightness(colour: &str) -> Option<f64> {
    let (r, g, b) = if let Some(hex) = colour.strip_prefix('#') {
        let channel = |at: usize, width: usize| {
            let digits = hex.get(at..at + width)?;
            let value = u8::from_str_radix(digits, 16).ok()?;
            Some(if width == 1 { value * 17 } else { value })
        };
        match hex.len() {
            3 | 4 => (channel(0, 1)?, channel(1, 1)?, channel(2, 1)?),
            6 | 8 => (channel(0, 2)?, channel(2, 2)?, channel(4, 2)?),
            _ => return None,
        }
    } else {
        let inside = colour
            .strip_prefix("rgba(")
            .or_else(|| colour.strip_prefix("rgb("))?
            .strip_suffix(')')?;
        let mut channels = inside
            .split([',', ' ', '/'])
            .filter(|part| !part.is_empty());
        let mut next = || -> Option<u8> {
            let part = channels.next()?;
            let value = match part.strip_suffix('%') {
                Some(percent) => percent.parse::<f64>().ok()? * 2.55,
                None => part.parse::<f64>().ok()?,
            };
            // A channel is 0 to 255, so it fits.
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            Some(value.clamp(0.0, 255.0).round() as u8)
        };
        (next()?, next()?, next()?)
    };
    Some((0.299 * f64::from(r) + 0.587 * f64::from(g) + 0.114 * f64::from(b)) / 255.0)
}

/// The outer `svg`'s frame: its `viewBox`, else its `width` and `height`.
fn frame_of(tag: &BytesStart<'_>) -> Result<Option<(f64, f64, f64, f64)>, String> {
    if let Some(view_box) = attribute(tag, "viewBox") {
        let numbers = Lexer::new(&view_box).numbers()?;
        let [left, top, width, height] = numbers[..] else {
            return Err(format!(
                "viewBox=\"{view_box}\" is four numbers: left, top, width and height"
            ));
        };
        return Ok(Some((left, top, width, height)));
    }
    let width = length(tag, "svg", "width")?;
    let height = length(tag, "svg", "height")?;
    Ok(width
        .zip(height)
        .map(|(width, height)| (0.0, 0.0, width, height)))
}

/// A shape's outline in its own units, or `None` for an element that isn't a shape.
fn outline(name: &str, tag: &BytesStart<'_>) -> Result<Option<Vec<Segment>>, String> {
    let get = |key: &str| length(tag, name, key).map(Option::unwrap_or_default);
    let segments = match name {
        "path" => {
            let Some(d) = attribute(tag, "d") else {
                return Ok(Some(Vec::new()));
            };
            path(&d).map_err(|error| format!("<path> d: {error}"))?
        }
        "circle" => {
            let r = get("r")?;
            ellipse(
                P {
                    x: get("cx")?,
                    y: get("cy")?,
                },
                r,
                r,
            )
        }
        "ellipse" => ellipse(
            P {
                x: get("cx")?,
                y: get("cy")?,
            },
            get("rx")?,
            get("ry")?,
        ),
        "rect" => {
            let rx = length(tag, name, "rx")?;
            let ry = length(tag, name, "ry")?;
            rect(
                P {
                    x: get("x")?,
                    y: get("y")?,
                },
                get("width")?,
                get("height")?,
                rx.or(ry).unwrap_or_default(),
                ry.or(rx).unwrap_or_default(),
            )
        }
        "line" => vec![
            Segment::Move(P {
                x: get("x1")?,
                y: get("y1")?,
            }),
            Segment::Line(P {
                x: get("x2")?,
                y: get("y2")?,
            }),
        ],
        "polyline" | "polygon" => {
            let numbers = Lexer::new(&attribute(tag, "points").unwrap_or_default())
                .numbers()
                .map_err(|error| format!("<{name}> points: {error}"))?;
            let mut segments: Vec<Segment> = numbers
                .as_chunks::<2>()
                .0
                .iter()
                .enumerate()
                .map(|(at, &[x, y])| {
                    let p = P { x, y };
                    if at == 0 {
                        Segment::Move(p)
                    } else {
                        Segment::Line(p)
                    }
                })
                .collect();
            if segments.len() < 2 {
                segments.clear();
            } else if name == "polygon" {
                segments.push(Segment::Close);
            }
            segments
        }
        _ => return Ok(None),
    };
    Ok(Some(segments))
}

/// A number attribute, in the drawing's units (`px` allowed).
fn length(tag: &BytesStart<'_>, name: &str, key: &str) -> Result<Option<f64>, String> {
    let Some(written) = attribute(tag, key) else {
        return Ok(None);
    };
    let bare = written.trim_end_matches("px").trim();
    bare.parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
        .map(Some)
        .ok_or_else(|| {
            format!("<{name}> {key}=\"{written}\" isn't a number: give it in the drawing's units")
        })
}

/// The four quarters of an ellipse, as cubic curves.
fn ellipse(centre: P, rx: f64, ry: f64) -> Vec<Segment> {
    let (rx, ry) = (rx.abs(), ry.abs());
    if rx == 0.0 || ry == 0.0 {
        return Vec::new();
    }
    let k = 0.552_284_749_8;
    let at = |x: f64, y: f64| P {
        x: centre.x + x,
        y: centre.y + y,
    };
    vec![
        Segment::Move(at(rx, 0.0)),
        Segment::Cubic(at(rx, k * ry), at(k * rx, ry), at(0.0, ry)),
        Segment::Cubic(at(-k * rx, ry), at(-rx, k * ry), at(-rx, 0.0)),
        Segment::Cubic(at(-rx, -k * ry), at(-k * rx, -ry), at(0.0, -ry)),
        Segment::Cubic(at(k * rx, -ry), at(rx, -k * ry), at(rx, 0.0)),
        Segment::Close,
    ]
}

/// A rectangle, its corners rounded by `rx` and `ry` as SVG rounds them.
fn rect(corner: P, width: f64, height: f64, rx: f64, ry: f64) -> Vec<Segment> {
    if width <= 0.0 || height <= 0.0 {
        return Vec::new();
    }
    let rx = rx.abs().min(width / 2.0);
    let ry = ry.abs().min(height / 2.0);
    let at = |x: f64, y: f64| P {
        x: corner.x + x,
        y: corner.y + y,
    };
    if rx == 0.0 || ry == 0.0 {
        return vec![
            Segment::Move(at(0.0, 0.0)),
            Segment::Line(at(width, 0.0)),
            Segment::Line(at(width, height)),
            Segment::Line(at(0.0, height)),
            Segment::Close,
        ];
    }
    let k = 1.0 - 0.552_284_749_8;
    vec![
        Segment::Move(at(rx, 0.0)),
        Segment::Line(at(width - rx, 0.0)),
        Segment::Cubic(at(width - k * rx, 0.0), at(width, k * ry), at(width, ry)),
        Segment::Line(at(width, height - ry)),
        Segment::Cubic(
            at(width, height - k * ry),
            at(width - k * rx, height),
            at(width - rx, height),
        ),
        Segment::Line(at(rx, height)),
        Segment::Cubic(
            at(k * rx, height),
            at(0.0, height - k * ry),
            at(0.0, height - ry),
        ),
        Segment::Line(at(0.0, ry)),
        Segment::Cubic(at(0.0, k * ry), at(k * rx, 0.0), at(rx, 0.0)),
        Segment::Close,
    ]
}

/// A `transform` list, applied right to left as SVG applies it.
// A matrix's six numbers, as SVG names them.
#[allow(clippy::many_single_char_names)]
fn transform_of(written: &str) -> Result<Matrix, String> {
    let mut matrix = Matrix::IDENTITY;
    let mut lexer = Lexer::new(written);
    loop {
        lexer.skip();
        let Some(name) = lexer.word() else {
            break;
        };
        lexer.skip();
        if !lexer.eat(b'(') {
            return Err(format!(
                "transform=\"{written}\": {name} needs its numbers in brackets"
            ));
        }
        let mut numbers = Vec::new();
        while lexer.at_number() {
            numbers.push(lexer.number()?);
        }
        lexer.skip();
        if !lexer.eat(b')') {
            return Err(format!("transform=\"{written}\" can't be read"));
        }
        let wrong = || {
            format!(
                "transform=\"{written}\": {name} has {} numbers",
                numbers.len()
            )
        };
        let own = match (name.as_str(), numbers.as_slice()) {
            ("translate", &[x]) => Matrix::translate(x, 0.0),
            ("translate", &[x, y]) => Matrix::translate(x, y),
            ("scale", &[s]) => Matrix::scale(s, s),
            ("scale", &[x, y]) => Matrix::scale(x, y),
            ("rotate", &[angle]) => Matrix::rotate(angle),
            ("rotate", &[angle, x, y]) => Matrix::translate(x, y)
                .then(&Matrix::rotate(angle))
                .then(&Matrix::translate(-x, -y)),
            ("skewX", &[angle]) => Matrix {
                c: angle.to_radians().tan(),
                ..Matrix::IDENTITY
            },
            ("skewY", &[angle]) => Matrix {
                b: angle.to_radians().tan(),
                ..Matrix::IDENTITY
            },
            ("matrix", &[a, b, c, d, e, f]) => Matrix { a, b, c, d, e, f },
            ("translate" | "scale" | "rotate" | "skewX" | "skewY" | "matrix", _) => {
                return Err(wrong());
            }
            _ => {
                return Err(format!(
                    "transform=\"{written}\": {name} isn't one of translate, scale, rotate, \
                     skewX, skewY or matrix"
                ));
            }
        };
        matrix = matrix.then(&own);
    }
    Ok(matrix)
}

/// Path data (`d`), every command made absolute moves, lines and cubic curves.
// One command per arm, as SVG lists them: split up, it reads worse.
#[allow(clippy::too_many_lines)]
fn path(d: &str) -> Result<Vec<Segment>, String> {
    let mut lexer = Lexer::new(d);
    let mut out = Vec::new();
    let mut current = P { x: 0.0, y: 0.0 };
    let mut start = current;
    // The handle a smooth curve reflects: the last cubic's second, the last quadratic's own.
    let mut cubic_handle: Option<P> = None;
    let mut quad_handle: Option<P> = None;
    let mut command: Option<u8> = None;
    loop {
        lexer.skip();
        if lexer.done() {
            break;
        }
        let letter = match lexer.letter() {
            Some(letter) => letter,
            None => match command {
                // Numbers after a command repeat it; after a move, they are lines.
                Some(b'M') => b'L',
                Some(b'm') => b'l',
                Some(b'Z' | b'z') | None => {
                    return Err(format!(
                        "\"{}\" can't be read: start with M and put a letter before each command",
                        lexer.rest()
                    ));
                }
                Some(previous) => previous,
            },
        };
        let relative = letter.is_ascii_lowercase();
        let base = if relative {
            current
        } else {
            P { x: 0.0, y: 0.0 }
        };
        let upper = letter.to_ascii_uppercase();
        if upper != b'M' && out.is_empty() {
            return Err("start with M, where the outline begins".to_owned());
        }
        let mut next_cubic = None;
        let mut next_quad = None;
        match upper {
            b'M' => {
                let p = lexer.point()?.plus(base);
                out.push(Segment::Move(p));
                current = p;
                start = p;
            }
            b'L' => {
                let p = lexer.point()?.plus(base);
                out.push(Segment::Line(p));
                current = p;
            }
            b'H' => {
                let x = lexer.number()? + base.x;
                current = P { x, y: current.y };
                out.push(Segment::Line(current));
            }
            b'V' => {
                let y = lexer.number()? + base.y;
                current = P { x: current.x, y };
                out.push(Segment::Line(current));
            }
            b'C' | b'S' => {
                let first = if upper == b'C' {
                    lexer.point()?.plus(base)
                } else {
                    cubic_handle.map_or(current, |handle| current.times(2.0).minus(handle))
                };
                let second = lexer.point()?.plus(base);
                let end = lexer.point()?.plus(base);
                out.push(Segment::Cubic(first, second, end));
                next_cubic = Some(second);
                current = end;
            }
            b'Q' | b'T' => {
                let handle = if upper == b'Q' {
                    lexer.point()?.plus(base)
                } else {
                    quad_handle.map_or(current, |handle| current.times(2.0).minus(handle))
                };
                let end = lexer.point()?.plus(base);
                out.push(Segment::Cubic(
                    current.plus(handle.minus(current).times(2.0 / 3.0)),
                    end.plus(handle.minus(end).times(2.0 / 3.0)),
                    end,
                ));
                next_quad = Some(handle);
                current = end;
            }
            b'A' => {
                let rx = lexer.number()?;
                let ry = lexer.number()?;
                let turn = lexer.number()?;
                let large = lexer.flag()?;
                let sweep = lexer.flag()?;
                let end = lexer.point()?.plus(base);
                out.extend(arc(current, rx, ry, turn, large, sweep, end));
                current = end;
            }
            b'Z' => {
                out.push(Segment::Close);
                current = start;
            }
            _ => {
                return Err(format!(
                    "{} isn't a path command: use M, L, H, V, C, S, Q, T, A or Z",
                    char::from(letter)
                ));
            }
        }
        cubic_handle = next_cubic;
        quad_handle = next_quad;
        command = Some(letter);
    }
    Ok(out)
}

/// An elliptical arc from `from` to `to`, as SVG draws one, in cubic curves of a quarter turn or
/// less.
#[allow(clippy::many_single_char_names, clippy::fn_params_excessive_bools)]
fn arc(from: P, rx: f64, ry: f64, turn: f64, large: bool, sweep: bool, to: P) -> Vec<Segment> {
    if from.minus(to).length() < 1e-9 {
        return Vec::new();
    }
    let (mut rx, mut ry) = (rx.abs(), ry.abs());
    if rx < 1e-9 || ry < 1e-9 {
        return vec![Segment::Line(to)];
    }
    let (sin, cos) = turn.to_radians().sin_cos();
    let half = from.minus(to).times(0.5);
    let x1 = cos * half.x + sin * half.y;
    let y1 = -sin * half.x + cos * half.y;
    let stretch = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if stretch > 1.0 {
        rx *= stretch.sqrt();
        ry *= stretch.sqrt();
    }
    let top = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
    let under = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    let side = if large == sweep { -1.0 } else { 1.0 };
    let factor = side * (top / under).max(0.0).sqrt();
    let cx1 = factor * rx * y1 / ry;
    let cy1 = -factor * ry * x1 / rx;
    let middle = from.plus(to).times(0.5);
    let centre = P {
        x: cos * cx1 - sin * cy1 + middle.x,
        y: sin * cx1 + cos * cy1 + middle.y,
    };
    let angle = |ux: f64, uy: f64, vx: f64, vy: f64| (ux * vy - uy * vx).atan2(ux * vx + uy * vy);
    let start = angle(1.0, 0.0, (x1 - cx1) / rx, (y1 - cy1) / ry);
    let mut delta = angle(
        (x1 - cx1) / rx,
        (y1 - cy1) / ry,
        (-x1 - cx1) / rx,
        (-y1 - cy1) / ry,
    );
    if !sweep && delta > 0.0 {
        delta -= std::f64::consts::TAU;
    } else if sweep && delta < 0.0 {
        delta += std::f64::consts::TAU;
    }
    // At most four quarter turns: a whole number from 1 to 4.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let pieces = (delta.abs() / std::f64::consts::FRAC_PI_2 - 1e-9)
        .ceil()
        .clamp(1.0, 4.0) as u32;
    let step = delta / f64::from(pieces);
    let handle = 4.0 / 3.0 * (step / 4.0).tan();
    let on = |t: f64| {
        let (s, c) = t.sin_cos();
        P {
            x: centre.x + rx * c * cos - ry * s * sin,
            y: centre.y + rx * c * sin + ry * s * cos,
        }
    };
    let along = |t: f64| {
        let (s, c) = t.sin_cos();
        P {
            x: -rx * s * cos - ry * c * sin,
            y: -rx * s * sin + ry * c * cos,
        }
    };
    (0..pieces)
        .map(|piece| {
            let a = start + step * f64::from(piece);
            let b = a + step;
            let end = if piece + 1 == pieces { to } else { on(b) };
            Segment::Cubic(
                on(a).plus(along(a).times(handle)),
                end.minus(along(b).times(handle)),
                end,
            )
        })
        .collect()
}

/// Reads numbers, letters and flags out of path data, points and transforms.
struct Lexer<'t> {
    text: &'t [u8],
    at: usize,
}

impl<'t> Lexer<'t> {
    fn new(text: &'t str) -> Self {
        Self {
            text: text.as_bytes(),
            at: 0,
        }
    }

    fn skip(&mut self) {
        while self
            .text
            .get(self.at)
            .is_some_and(|byte| byte.is_ascii_whitespace() || *byte == b',')
        {
            self.at += 1;
        }
    }

    fn done(&self) -> bool {
        self.at >= self.text.len()
    }

    fn rest(&self) -> String {
        String::from_utf8_lossy(&self.text[self.at..self.text.len().min(self.at + 24)]).into_owned()
    }

    fn eat(&mut self, byte: u8) -> bool {
        if self.text.get(self.at) == Some(&byte) {
            self.at += 1;
            true
        } else {
            false
        }
    }

    /// A path command's letter (never `e`, which is a number's exponent).
    fn letter(&mut self) -> Option<u8> {
        let byte = *self.text.get(self.at)?;
        (byte.is_ascii_alphabetic() && byte != b'e' && byte != b'E').then(|| {
            self.at += 1;
            byte
        })
    }

    fn word(&mut self) -> Option<String> {
        let begin = self.at;
        while self.text.get(self.at).is_some_and(u8::is_ascii_alphabetic) {
            self.at += 1;
        }
        (self.at > begin).then(|| String::from_utf8_lossy(&self.text[begin..self.at]).into_owned())
    }

    fn at_number(&mut self) -> bool {
        self.skip();
        self.text
            .get(self.at)
            .is_some_and(|byte| byte.is_ascii_digit() || matches!(byte, b'-' | b'+' | b'.'))
    }

    fn number(&mut self) -> Result<f64, String> {
        self.skip();
        let begin = self.at;
        if matches!(self.text.get(self.at), Some(b'-' | b'+')) {
            self.at += 1;
        }
        let mut digits = 0;
        let mut point = false;
        while let Some(byte) = self.text.get(self.at) {
            if byte.is_ascii_digit() {
                digits += 1;
            } else if *byte == b'.' && !point {
                point = true;
            } else {
                break;
            }
            self.at += 1;
        }
        if digits > 0 && matches!(self.text.get(self.at), Some(b'e' | b'E')) {
            let mark = self.at;
            self.at += 1;
            if matches!(self.text.get(self.at), Some(b'-' | b'+')) {
                self.at += 1;
            }
            if self.text.get(self.at).is_some_and(u8::is_ascii_digit) {
                while self.text.get(self.at).is_some_and(u8::is_ascii_digit) {
                    self.at += 1;
                }
            } else {
                self.at = mark;
            }
        }
        let written = std::str::from_utf8(&self.text[begin..self.at]).unwrap_or_default();
        if digits == 0 {
            self.at = begin;
            return Err(format!("a number is missing at \"{}\"", self.rest()));
        }
        written
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite())
            .ok_or_else(|| format!("\"{written}\" isn't a number"))
    }

    fn point(&mut self) -> Result<P, String> {
        Ok(P {
            x: self.number()?,
            y: self.number()?,
        })
    }

    /// An arc's flag: `0` or `1`, which may run into the next number.
    fn flag(&mut self) -> Result<bool, String> {
        self.skip();
        let flag = match self.text.get(self.at) {
            Some(b'0') => false,
            Some(b'1') => true,
            _ => return Err(format!("an arc's flag is 0 or 1, at \"{}\"", self.rest())),
        };
        self.at += 1;
        Ok(flag)
    }

    fn numbers(&mut self) -> Result<Vec<f64>, String> {
        let mut out = Vec::new();
        while self.at_number() {
            out.push(self.number()?);
        }
        self.skip();
        if self.done() {
            Ok(out)
        } else {
            Err(format!("\"{}\" isn't a number", self.rest()))
        }
    }
}

#[cfg(test)]
mod tests;
