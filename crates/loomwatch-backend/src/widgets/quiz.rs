//! A quiz (ADR 0114, amended 8 November): a few questions after an explanation that check the
//! person took it in, each with one right choice and a sentence saying why, shown once they pick.
//! Answering from memory helps people keep what they learned more than reading it again, and the
//! answer's words still carry the explanation: the quiz is something to try after it.
//!
//! What the person picked is kept, one choice or none for each question ([`read_state`]), and the
//! next run reads how they did and what they missed ([`change`]), so the agent can explain that
//! part again.

use std::collections::BTreeSet;
use std::fmt::Write as _;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{Widget, limits, list, optional_text, text};

/// One question: its words, its choices, the right one (from 0) and why it is right.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Check {
    pub(crate) question: String,
    pub(crate) choices: Vec<String>,
    pub(crate) answer: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) why: Option<String>,
}

/// A quiz, read and checked: every question's choices differ, and its answer is one of them.
pub(crate) fn read(arguments: &Value, title: String) -> Result<Widget, String> {
    let checks = list(arguments, "checks", limits::CHECKS, |check| {
        let question = text(check, "question", 1, limits::QUESTION_CHARS)?;
        let choices = list(check, "choices", limits::CHECK_CHOICES, |choice| {
            choice
                .as_str()
                .map(str::trim)
                .filter(|choice| {
                    !choice.is_empty() && choice.chars().count() <= limits::CHECK_CHOICE_CHARS
                })
                .map(str::to_owned)
                .ok_or_else(|| {
                    format!(
                        "each choice is a few words, {} characters at most",
                        limits::CHECK_CHOICE_CHARS
                    )
                })
        })?;
        let mut seen = BTreeSet::new();
        if let Some(twice) = choices
            .iter()
            .find(|choice| !seen.insert(choice.to_lowercase()))
        {
            return Err(format!(
                "\"{twice}\" is a choice twice: make each choice differ"
            ));
        }
        let answer = check
            .get("answer")
            .and_then(Value::as_str)
            .map(str::trim)
            .and_then(|answer| choices.iter().position(|choice| choice == answer))
            .and_then(|answer| u8::try_from(answer).ok())
            .ok_or("answer is the right choice, written as in choices")?;
        Ok(Check {
            question,
            choices,
            answer,
            why: optional_text(check, "why", limits::WHY_CHARS)?,
        })
    })?;
    Ok(Widget::Quiz { title, checks })
}

/// A quiz's state: `{"picked": [choice or null, …]}`, one for each question, each from 0.
pub(crate) fn read_state(checks: &[Check], state: &Value) -> Result<Value, String> {
    let picked = state
        .get("picked")
        .and_then(Value::as_array)
        .ok_or("a quiz's state is {\"picked\": [a choice from 0, or null, one per question]}")?;
    if picked.len() != checks.len() {
        return Err(format!(
            "a quiz's state has {} picks, a choice or null for each question",
            checks.len()
        ));
    }
    for (check, pick) in checks.iter().zip(picked) {
        let fits = pick.is_null()
            || pick
                .as_u64()
                .and_then(|pick| usize::try_from(pick).ok())
                .is_some_and(|pick| pick < check.choices.len());
        if !fits {
            return Err(format!(
                "\"{}\" has {} choices: pick one from 0, or null",
                check.question,
                check.choices.len()
            ));
        }
    }
    Ok(json!({"picked": picked}))
}

/// "In "Check yourself", 1 of 2 right. Missed "Where does the oxygen come from?": picked Carbon
/// dioxide; it's Water.": how the person did, for the next run. Questions they left are said too.
pub(crate) fn change(title: &str, checks: &[Check], state: &Value) -> Option<String> {
    let picked = state.get("picked")?.as_array()?;
    let picks: Vec<Option<usize>> = picked
        .iter()
        .map(|pick| pick.as_u64().and_then(|pick| usize::try_from(pick).ok()))
        .collect();
    let answered = picks.iter().flatten().count();
    if answered == 0 {
        return Some(format!("In \"{title}\", nothing is answered."));
    }
    let right = checks
        .iter()
        .zip(&picks)
        .filter(|(check, pick)| **pick == Some(usize::from(check.answer)))
        .count();
    let mut line = format!("In \"{title}\", {right} of {answered} right");
    if answered < checks.len() {
        let _ = write!(line, " ({} not answered)", checks.len() - answered);
    }
    line.push('.');
    for (check, pick) in checks.iter().zip(&picks) {
        if let Some(pick) = pick
            && *pick != usize::from(check.answer)
        {
            let _ = write!(
                line,
                " Missed \"{}\": picked {}; it's {}.",
                check.question,
                check.choices.get(*pick).map_or("?", String::as_str),
                check
                    .choices
                    .get(usize::from(check.answer))
                    .map_or("?", String::as_str)
            );
        }
    }
    Some(line)
}

#[cfg(test)]
mod tests;
