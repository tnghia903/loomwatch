//! Changing a text by its numbered lines (ADR 0078, ADR 0119): `LoomWatch`'s own agent is shown
//! the text one numbered line per line and names only the lines it changes. `LoomWatch` makes the
//! edits, so a line it doesn't name stays exactly as it was. A model asked to write the whole text
//! again loses detail with every pass.
//!
//! Each edit is a JSON object in the shape the skill writer uses (ADR 0118):
//! - `{"n": <line>, "replace": "<the whole new line, or lines>"}`. An empty replacement drops it.
//! - `{"n": <line>, "drop": true}`
//! - `{"after": <line>, "add": "<new lines>"}`, with 0 for the start.

use std::collections::BTreeMap;
use std::collections::btree_map::Entry;
use std::fmt::Write as _;

use serde_json::Value;

/// `text` one numbered line per line, from 1: `[1] first line`.
pub(super) fn numbered(text: &str) -> String {
    let mut listing = String::new();
    for (index, line) in text.split('\n').enumerate() {
        let _ = writeln!(listing, "[{}] {line}", index + 1);
    }
    listing
}

/// The text with the edits made, and the edits that named no line it has.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Applied {
    pub(super) text: String,
    /// Each edit that was left out, in plain words: one naming a line the text doesn't have, a
    /// second edit to one line, or one that says nothing to do.
    pub(super) missed: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Edit {
    Drop,
    Replace(String),
}

fn number(value: Option<&Value>) -> Option<usize> {
    let value = value?;
    let n = value
        .as_u64()
        .or_else(|| value.as_str().and_then(|n| n.trim().parse().ok()))?;
    usize::try_from(n).ok()
}

/// `text` with `edits` made. Lines are split on `\n`, as [`numbered`] shows them.
pub(super) fn apply(text: &str, edits: &[Value]) -> Applied {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut changed: BTreeMap<usize, Edit> = BTreeMap::new();
    let mut added: BTreeMap<usize, Vec<String>> = BTreeMap::new();
    let mut missed = Vec::new();
    for item in edits {
        if let Some(after) = number(item.get("after")) {
            let add = item
                .get("add")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim_end();
            if after > lines.len() {
                missed.push(format!(
                    "after line {after}: there are only {} lines",
                    lines.len()
                ));
            } else if add.trim().is_empty() {
                missed.push(format!("after line {after}: nothing to add"));
            } else {
                added.entry(after).or_default().push(add.to_owned());
            }
            continue;
        }
        let Some(n) = number(item.get("n")) else {
            missed.push(format!("{item}: names no line"));
            continue;
        };
        if n == 0 || n > lines.len() {
            missed.push(format!("line {n}: there are only {} lines", lines.len()));
            continue;
        }
        let edit = if item.get("drop").and_then(Value::as_bool) == Some(true) {
            Edit::Drop
        } else {
            match item.get("replace").and_then(Value::as_str) {
                Some(text) if text.trim().is_empty() => Edit::Drop,
                Some(text) => Edit::Replace(text.trim_end().to_owned()),
                None => {
                    missed.push(format!("line {n}: says neither replace nor drop"));
                    continue;
                }
            }
        };
        match changed.entry(n) {
            Entry::Vacant(slot) => {
                slot.insert(edit);
            }
            Entry::Occupied(_) => missed.push(format!("line {n}: changed twice")),
        }
    }
    let mut out: Vec<String> = added.remove(&0).unwrap_or_default();
    for (index, line) in lines.iter().enumerate() {
        match changed.get(&(index + 1)) {
            Some(Edit::Drop) => {}
            Some(Edit::Replace(text)) => out.push(text.clone()),
            None => out.push((*line).to_owned()),
        }
        if let Some(more) = added.remove(&(index + 1)) {
            out.extend(more);
        }
    }
    Applied {
        text: out.join("\n"),
        missed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const TEXT: &str =
        "You find facts.\nHow to work:\n- Use primary sources.\nReply with the facts.";

    #[test]
    fn lines_are_numbered_from_one() {
        assert_eq!(
            numbered("a\nb"),
            "[1] a\n[2] b\n",
            "the same shape the skill writer shows"
        );
    }

    #[test]
    fn a_line_not_named_stays_byte_for_byte() {
        let text = "  Indented line  \nSecond\twith a tab\nThird";
        let applied = apply(text, &[json!({"n": 2, "replace": "Second, changed"})]);
        assert!(applied.missed.is_empty(), "{:?}", applied.missed);
        assert_eq!(applied.text, "  Indented line  \nSecond, changed\nThird");
    }

    #[test]
    fn replace_drop_and_add_after() {
        let applied = apply(
            TEXT,
            &[
                json!({"n": 1, "replace": "You find facts and say how sure you are."}),
                json!({"n": "3", "drop": true}),
                json!({"after": 2, "add": "- Say how sure you are of each fact.\n- Name its source."}),
                json!({"after": 0, "add": "Work for the person's team."}),
            ],
        );
        assert!(applied.missed.is_empty(), "{:?}", applied.missed);
        assert_eq!(
            applied.text,
            "Work for the person's team.\nYou find facts and say how sure you are.\nHow to work:\n- Say how sure you are of each fact.\n- Name its source.\nReply with the facts."
        );
        assert_eq!(
            apply(TEXT, &[json!({"n": 3, "replace": "  "})]).text,
            "You find facts.\nHow to work:\nReply with the facts.",
            "an empty replacement drops the line"
        );
    }

    #[test]
    fn an_edit_that_names_no_line_it_has_is_said_and_left_out() {
        let applied = apply(
            TEXT,
            &[
                json!({"n": 9, "replace": "Nowhere."}),
                json!({"n": 0, "drop": true}),
                json!({"after": 7, "add": "Late."}),
                json!({"after": 1, "add": "   "}),
                json!({"n": 2}),
                json!({"replace": "No number."}),
                json!({"n": 1, "replace": "First."}),
                json!({"n": 1, "drop": true}),
            ],
        );
        assert_eq!(
            applied.text, "First.\nHow to work:\n- Use primary sources.\nReply with the facts.",
            "only the one edit that names a line it has, once"
        );
        assert_eq!(
            applied.missed,
            vec![
                "line 9: there are only 4 lines".to_owned(),
                "line 0: there are only 4 lines".to_owned(),
                "after line 7: there are only 4 lines".to_owned(),
                "after line 1: nothing to add".to_owned(),
                "line 2: says neither replace nor drop".to_owned(),
                r#"{"replace":"No number."}: names no line"#.to_owned(),
                "line 1: changed twice".to_owned(),
            ]
        );
    }

    #[test]
    fn no_edits_leave_the_text_as_it_is() {
        let applied = apply(TEXT, &[]);
        assert_eq!(applied.text, TEXT);
        assert!(applied.missed.is_empty());
    }
}
