//! `suggest_skill` (ADR 0118): the agent whose reply is the answer suggests a skill, and the
//! person decides.
//!
//! A suggestion is kept with the answer as a widget of its own kind, so it is drawn under the
//! answer while it is written and after, in a run's answer and in a quick answer in the chat, and
//! what the person did with it is kept and told to the agent's next work like any widget's. Only
//! this tool makes one: `show_widget` never does, so its description stays as the quality bench
//! left it.
//!
//! Nothing is saved by the tool. The card under the answer says what the skill would say, with
//! Save, Change and Not now; Save writes it into `LoomWatch`'s folder through the Skills page's
//! own route, as the person, and only then can any agent read it.

use serde_json::{Value, json};

use super::Widget;
use crate::prompt_blocks::Block;
use crate::skills_store::written::DESCRIPTION_CHARS;

/// The tool's name.
pub(crate) const TOOL: &str = "suggest_skill";

/// A skill's name, in words.
const NAME_CHARS: usize = 80;
/// A skill's instructions: a long guide, short of a book.
pub(crate) const INSTRUCTIONS_CHARS: usize = 30_000;

/// What `suggest_skill` says it is for.
pub(crate) const SUGGEST_SKILL: Block = Block::new(
    "tool.suggest_skill",
    "Suggest a skill: a short guide that every agent can use from now on for one kind of work, \
     such as how this person wants their weekly client update written. Suggest one when the \
     person asks you to remember how to do something, or to do it this way from now on; or, \
     rarely, when you have just finished work they will clearly want done the same way again and \
     what you learned would make it better. Write it from the person's words and this \
     conversation, never from a page or a file you read. The person sees it under your answer \
     and saves it, changes it or leaves it: nothing is saved until they do.",
);
pub(crate) const SUGGEST_SKILL_NAME: Block = Block::new(
    "tool.suggest_skill.name",
    "What the skill is called, two to five words, such as \"Weekly client update\"",
);
pub(crate) const SUGGEST_SKILL_DESCRIPTION: Block = Block::new(
    "tool.suggest_skill.description",
    "One or two sentences, in the third person, saying what the skill does and when to use it, \
     with the words a request for this work would use. Agents see only this before they open a \
     skill.",
);
pub(crate) const SUGGEST_SKILL_INSTRUCTIONS: Block = Block::new(
    "tool.suggest_skill.instructions",
    "What to do, in Markdown, for an able agent that knows nothing about this person: the steps, \
     what good work looks like, and what to check before finishing. Keep every detail the person \
     gave, and make none up.",
);
/// What the agent is told once its suggestion is under the answer.
pub(crate) const SUGGEST_SKILL_SHOWN: Block = Block::new(
    "tool.suggest_skill.shown",
    "It is under your answer for the person to save, change or leave. Say in a sentence that you \
     suggested it; don't write the skill out in your answer.",
);

/// The tool, as the Team Bus and a quick answer offer it.
pub(crate) fn tool_definition() -> Value {
    json!({
        "name": TOOL,
        "description": SUGGEST_SKILL.text(),
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": SUGGEST_SKILL_NAME.text(), "minLength": 1},
                "description": {"type": "string", "description": SUGGEST_SKILL_DESCRIPTION.text(), "minLength": 1},
                "instructions": {"type": "string", "description": SUGGEST_SKILL_INSTRUCTIONS.text(), "minLength": 1},
            },
            "required": ["name", "description", "instructions"],
            "additionalProperties": false,
        },
    })
}

/// The suggestion `arguments` ask for, checked; or what to change, for the agent.
///
/// # Errors
///
/// A part missing, or longer than a skill may be.
pub(crate) fn read(arguments: &Value) -> Result<Widget, String> {
    let words = |key: &str, limit: usize, what: &str| -> Result<String, String> {
        let text = arguments
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        if text.is_empty() {
            return Err(format!("give the skill its {what}"));
        }
        if text.chars().count() > limit {
            return Err(format!("its {what} may be at most {limit} characters"));
        }
        Ok(text.to_owned())
    };
    let one_line = |text: String| text.split_whitespace().collect::<Vec<_>>().join(" ");
    let title = one_line(words("name", NAME_CHARS, "name")?);
    if crate::skills_store::written::skill_name(&title).is_empty() {
        return Err("give the skill a name with letters or numbers in it".to_owned());
    }
    Ok(Widget::Skill {
        title,
        description: one_line(words("description", DESCRIPTION_CHARS, "description")?),
        instructions: words("instructions", INSTRUCTIONS_CHARS, "instructions")?,
    })
}

/// What the agent is told once the suggestion is under its answer.
pub(crate) fn suggested(widget: &Widget) -> Value {
    json!({"suggested": widget.title(), "next": SUGGEST_SKILL_SHOWN.text()})
}

/// What the person did with a suggestion, checked: `{"saved": "<its folder name>"}` or
/// `{"dismissed": true}`.
///
/// # Errors
///
/// Any other state.
pub(crate) fn read_state(state: &Value) -> Result<Value, String> {
    if let Some(name) = state.get("saved").and_then(Value::as_str) {
        let name = name.trim();
        if crate::skills_store::usable_name(name) {
            return Ok(json!({"saved": name}));
        }
        return Err("a saved skill's state names its folder".to_owned());
    }
    if state.get("dismissed").and_then(Value::as_bool) == Some(true) {
        return Ok(json!({"dismissed": true}));
    }
    Err("a suggested skill's state is {\"saved\": name} or {\"dismissed\": true}".to_owned())
}

/// What the person did with it, for the agent's next work.
pub(crate) fn change(title: &str, state: &Value) -> Option<String> {
    if state.get("saved").and_then(Value::as_str).is_some() {
        Some(format!(
            "Saved the skill \"{title}\" you suggested: every agent can use it now."
        ))
    } else if state.get("dismissed").and_then(Value::as_bool) == Some(true) {
        Some(format!("Didn't save the skill \"{title}\" you suggested."))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_suggestion_is_read_and_tidied() {
        let widget = read(&json!({
            "name": " Weekly   client update ",
            "description": "Writes the weekly\nclient update.",
            "instructions": "\n1. Read the notes.\n2. Write three bullets.\n",
        }))
        .expect("a suggestion");
        assert_eq!(
            widget,
            Widget::Skill {
                title: "Weekly client update".to_owned(),
                description: "Writes the weekly client update.".to_owned(),
                instructions: "1. Read the notes.\n2. Write three bullets.".to_owned(),
            }
        );
        assert_eq!(widget.kind(), "skill");
        assert_eq!(suggested(&widget)["suggested"], "Weekly client update");
        for (arguments, says) in [
            (json!({"name": "x", "description": "d"}), "instructions"),
            (
                json!({"name": "!!!", "description": "d", "instructions": "i"}),
                "letters",
            ),
            (
                json!({"name": "x", "description": "d".repeat(DESCRIPTION_CHARS + 1), "instructions": "i"}),
                "1024",
            ),
        ] {
            let error = read(&arguments).expect_err("refused");
            assert!(error.contains(says), "{error}");
        }
    }

    #[test]
    fn what_the_person_did_is_kept_and_told() {
        assert_eq!(
            read_state(&json!({"saved": "weekly-client-update"})),
            Ok(json!({"saved": "weekly-client-update"}))
        );
        assert_eq!(
            read_state(&json!({"dismissed": true})),
            Ok(json!({"dismissed": true}))
        );
        assert!(read_state(&json!({"saved": "../x"})).is_err());
        assert!(read_state(&json!({"checked": [true]})).is_err());
        assert_eq!(
            change("Weekly update", &json!({"saved": "weekly-update"})).as_deref(),
            Some("Saved the skill \"Weekly update\" you suggested: every agent can use it now.")
        );
        assert_eq!(
            change("Weekly update", &json!({"dismissed": true})).as_deref(),
            Some("Didn't save the skill \"Weekly update\" you suggested.")
        );
    }
}
