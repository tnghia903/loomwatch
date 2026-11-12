//! A page: the widget an agent writes itself, for what no other kind fits (ADR 0125).
//!
//! The agent writes `html`, and a `script` for what moves or answers a tap. The app draws them in a
//! frame that reaches nothing (`ui/src/lib/widgets/page/`). The script runs apart from the page, in
//! a worker that can't touch it, and the page's markup is cleaned before it is drawn.
//! `LoomWatch` gives the page its colours, its look for plain HTML, and the figures the page
//! declares. Those are a calculator's `inputs`, `results` and `presets`: `LoomWatch` works them
//! out, checks them here at the start, at each preset and at the ends of the inputs' ranges, and
//! tells the agent what they come to, so the figures in its words and on the page are
//! `LoomWatch`'s. What the person sets is kept, as a calculator's is, and so is a line saying the
//! page didn't draw, for the next run.

use serde_json::{Value, json};

use super::{
    Input, PAGES_ON, Sums, Widget, check_calculator, input_written, limits, list, optional_text,
    read_figure, read_input, read_presets, read_values, set_line, text, work_out,
};

/// Up to this many inputs with ends, a page is worked out at every corner of their ranges; past
/// it, each input alone at each end (64 workings at most either way).
const CORNERS_UP_TO: usize = 6;

/// Whether `show_widget` offers a page now: [`PAGES_ON`], or `LOOMWATCH_WIDGET_PAGES=on` for a
/// trial.
pub(crate) fn offered() -> bool {
    PAGES_ON || std::env::var_os("LOOMWATCH_WIDGET_PAGES").is_some_and(|value| value == "on")
}

/// A page, read and checked: what it is for, something to draw, within [`limits::PAGE_CHARS`],
/// and figures that work out everywhere their inputs can go.
pub(crate) fn read(arguments: &Value, title: String) -> Result<Widget, String> {
    let why = text(arguments, "why", 1, limits::PAGE_WHY_CHARS)?;
    let html = optional_text(arguments, "html", limits::PAGE_CHARS)?.unwrap_or_default();
    let script = optional_text(arguments, "script", limits::PAGE_CHARS)?.unwrap_or_default();
    if html.is_empty() && script.is_empty() {
        return Err("give html, script or both: what the page shows".to_owned());
    }
    let size = html.chars().count() + script.chars().count();
    if size > limits::PAGE_CHARS {
        return Err(format!(
            "html and script are {size} characters together; keep them to {}",
            limits::PAGE_CHARS
        ));
    }
    let inputs = optional_list(arguments, "inputs", limits::INPUTS, read_input)?;
    let results = optional_list(arguments, "results", limits::PAGE_RESULTS, read_figure)?;
    let presets = read_presets(arguments)?;
    if !presets.is_empty() && inputs.is_empty() {
        return Err("presets set inputs: declare the inputs they set".to_owned());
    }
    let widget = Widget::Page {
        title,
        why,
        html,
        script,
        inputs,
        results,
        presets,
    };
    check_calculator(&widget)?;
    check_range(&widget)?;
    Ok(widget)
}

/// A list a page may leave out, or give empty.
fn optional_list<T>(
    value: &Value,
    field: &str,
    bounds: (usize, usize),
    read_one: impl Fn(&Value) -> Result<T, String>,
) -> Result<Vec<T>, String> {
    match value.get(field) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(entries)) if entries.is_empty() => Ok(Vec::new()),
        Some(_) => list(value, field, bounds, read_one),
    }
}

/// The page's results worked out at the ends of its inputs' ranges: a switch off and on, a number
/// at its `min` and its `max` (one with no `min` or `max` stays at its start). With up to
/// [`CORNERS_UP_TO`] such inputs, every mix of their ends; with more, each alone. A result that
/// can't be worked out at one is refused, with the inputs that broke it and a way out.
fn check_range(widget: &Widget) -> Result<(), String> {
    let Some(Sums {
        inputs, results, ..
    }) = widget.sums()
    else {
        return Ok(());
    };
    if results.is_empty() {
        return Ok(());
    }
    let ends: Vec<(&Input, [Value; 2])> = inputs
        .iter()
        .filter_map(|input| {
            if input.is_switch() {
                Some((input, [json!(false), json!(true)]))
            } else {
                Some((input, [json!(input.min?), json!(input.max?)]))
            }
        })
        .collect();
    let cases: Vec<Vec<(&Input, &Value)>> = if ends.len() <= CORNERS_UP_TO {
        (0..1_usize << ends.len())
            .map(|corner| {
                ends.iter()
                    .enumerate()
                    .map(|(bit, (input, both))| (*input, &both[(corner >> bit) & 1]))
                    .collect()
            })
            .collect()
    } else {
        ends.iter()
            .flat_map(|(input, both)| both.iter().map(move |end| vec![(*input, end)]))
            .collect()
    };
    for case in cases {
        let values: serde_json::Map<String, Value> = case
            .iter()
            .map(|(input, end)| (input.id.clone(), (*end).clone()))
            .collect();
        if let Err((label, error)) = work_out(widget, Some(&json!({ "values": values }))) {
            let at = case
                .iter()
                .map(|(input, end)| {
                    let value = end.as_f64().unwrap_or_else(|| {
                        if end.as_bool() == Some(true) {
                            1.0
                        } else {
                            0.0
                        }
                    });
                    format!("{} {}", input.label, input_written(input, value))
                })
                .collect::<Vec<_>>()
                .join(", ");
            return Err(format!(
                "result \"{label}\" with {at}: {error}. Make it work there too, such as with \
                 if(), or give its inputs a narrower min and max"
            ));
        }
    }
    Ok(())
}

/// A page's state: the values the person set, as a calculator's, and `broke`, what the app said
/// when the page couldn't draw, cut to [`limits::BROKE_CHARS`].
pub(crate) fn read_state(inputs: &[Input], state: &Value) -> Result<Value, String> {
    let mut out = serde_json::Map::new();
    if let Some(values) = state.get("values") {
        let values = values
            .as_object()
            .ok_or("a page's state is {\"values\": {input id: value}}")?;
        out.insert(
            "values".to_owned(),
            Value::Object(read_values(inputs, values, "the page's")?),
        );
    }
    match state.get("broke") {
        None | Some(Value::Null) => {}
        Some(Value::String(broke)) => {
            let broke: String = broke.trim().chars().take(limits::BROKE_CHARS).collect();
            if !broke.is_empty() {
                out.insert("broke".to_owned(), Value::String(broke));
            }
        }
        Some(_) => return Err("broke is what went wrong, as text".to_owned()),
    }
    if out.is_empty() {
        return Err(
            "a page's state is {\"values\": {input id: value}}, or {\"broke\": what went wrong}"
                .to_owned(),
        );
    }
    Ok(Value::Object(out))
}

/// What the next run is told of a page the person changed, or that didn't draw: "\"Pendulum\":
/// Length 2.5 m → One swing on Earth = 3.2 s." or "\"Pendulum\": it didn't draw for them (…)."
pub(crate) fn change(widget: &Widget, inputs: &[Input], state: &Value) -> Option<String> {
    let mut parts = Vec::new();
    if !inputs.is_empty() && state.get("values").is_some() {
        parts.push(set_line(widget, inputs, state));
    }
    if let Some(broke) = state.get("broke").and_then(Value::as_str) {
        parts.push(format!("it didn't draw for them ({broke})"));
    }
    if parts.is_empty() {
        return None;
    }
    Some(format!("\"{}\": {}.", widget.title(), parts.join("; ")))
}

#[cfg(test)]
mod tests;
