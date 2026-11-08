//! A finder (ADR 0114, amended 8 November): questions the person answers by tapping, each answer
//! leading on to a later question or to an outcome, so the answer for their own case shows at once,
//! without another run. An answer may only lead to a later question, so every path ends at an
//! outcome, and every question and outcome must be reachable from the first question.
//!
//! What the person answered is kept as the index of each answer they took, from the first question
//! down their path ([`read_state`]), and the next run reads their path in words ([`change`]).

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{Widget, limits, list, text};

/// One question: its words and the answers the person taps.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Question {
    pub(crate) text: String,
    pub(crate) answers: Vec<Answer>,
}

/// One answer to a question, and where it leads: a later question or an outcome, each by its
/// number from 1. Exactly one of the two.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Answer {
    pub(crate) label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) next: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) outcome: Option<u8>,
}

/// Where a path ends: what is true, or what to do, in that case.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Outcome {
    pub(crate) label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) text: Option<String>,
}

/// Where one answer leads.
enum Leads {
    Question(usize),
    Outcome(usize),
}

impl Answer {
    fn leads(&self) -> Leads {
        match (self.next, self.outcome) {
            (Some(next), _) => Leads::Question(usize::from(next)),
            (None, Some(outcome)) => Leads::Outcome(usize::from(outcome)),
            // `read` refuses an answer that leads nowhere.
            (None, None) => Leads::Outcome(0),
        }
    }
}

/// A finder, read and checked.
pub(crate) fn read(arguments: &Value, title: String) -> Result<Widget, String> {
    let outcomes = list(arguments, "outcomes", limits::OUTCOMES, |outcome| {
        Ok(Outcome {
            label: text(outcome, "label", 1, limits::OUTCOME_LABEL_CHARS)?,
            text: super::optional_text(outcome, "text", limits::OUTCOME_TEXT_CHARS)?,
        })
    })?;
    let questions = list(arguments, "questions", limits::QUESTIONS, |question| {
        Ok(Question {
            text: text(question, "text", 1, limits::QUESTION_CHARS)?,
            answers: list(question, "answers", limits::ANSWERS, read_answer)?,
        })
    })?;
    let count = questions.len();
    for (at, question) in questions.iter().enumerate() {
        for (which, answer) in question.answers.iter().enumerate() {
            leads_well(answer, at + 1, count, outcomes.len())
                .map_err(|error| format!("questions {}: answers {}: {error}", at + 1, which + 1))?;
        }
    }
    let mut asked = vec![false; questions.len()];
    let mut ends = vec![false; outcomes.len()];
    if let Some(first) = asked.first_mut() {
        *first = true;
    }
    for (at, question) in questions.iter().enumerate() {
        // An answer only leads to a later question, so one pass in order sees every way in.
        if !asked[at] {
            return Err(format!(
                "question {} is never reached: point an answer of an earlier question at it with \
                 next, or leave it out",
                at + 1
            ));
        }
        for answer in &question.answers {
            match answer.leads() {
                Leads::Question(next) => asked[next - 1] = true,
                Leads::Outcome(outcome) => ends[outcome - 1] = true,
            }
        }
    }
    if let Some(unused) = ends.iter().position(|reached| !reached) {
        return Err(format!(
            "outcome {} is never reached: point an answer at it with outcome, or leave it out",
            unused + 1
        ));
    }
    Ok(Widget::Finder {
        title,
        questions,
        outcomes,
    })
}

fn read_answer(answer: &Value) -> Result<Answer, String> {
    let label = text(answer, "label", 1, limits::ANSWER_CHARS)?;
    let number = |field: &str| -> Result<Option<u8>, String> {
        match answer.get(field) {
            None | Some(Value::Null) => Ok(None),
            Some(value) => value
                .as_u64()
                .and_then(|number| u8::try_from(number).ok())
                .map(Some)
                .ok_or_else(|| format!("{field} is a number, from 1")),
        }
    };
    let next = number("next")?;
    let outcome = number("outcome")?;
    match (next, outcome) {
        (Some(_), Some(_)) => Err(
            "give next for the question it leads to or outcome for where it ends, not both"
                .to_owned(),
        ),
        (None, None) => {
            Err("give next, the later question it leads to, or outcome, where it ends".to_owned())
        }
        _ => Ok(Answer {
            label,
            next,
            outcome,
        }),
    }
}

/// An answer of question `question` (from 1) leads to a later question or to an outcome there is.
fn leads_well(
    answer: &Answer,
    question: usize,
    questions: usize,
    outcomes: usize,
) -> Result<(), String> {
    match answer.leads() {
        Leads::Question(next) if next <= question || next > questions => {
            Err(if question == questions {
                format!("next is {next}, but this is the last question: give outcome instead")
            } else {
                format!(
                    "next is {next}: an answer leads to a later question, {} to {questions}",
                    question + 1
                )
            })
        }
        Leads::Outcome(outcome) if outcome == 0 || outcome > outcomes => Err(format!(
            "outcome is {outcome}: give the number of one of the {outcomes} outcomes, from 1"
        )),
        _ => Ok(()),
    }
}

/// The person's path through a finder: each step the question and the answer they took, and the
/// outcome when the path got there.
struct Walked<'a> {
    path: Vec<(&'a Question, &'a Answer)>,
    ended: Option<&'a Outcome>,
}

/// The person's path through `questions`, or `None` for one that doesn't follow the finder.
fn walk<'a>(
    questions: &'a [Question],
    outcomes: &'a [Outcome],
    taken: &[Value],
) -> Option<Walked<'a>> {
    let mut path = Vec::new();
    let mut question = questions.first()?;
    let mut ended = None;
    for index in taken {
        if ended.is_some() {
            return None;
        }
        let index = usize::try_from(index.as_u64()?).ok()?;
        let answer = question.answers.get(index)?;
        path.push((question, answer));
        match answer.leads() {
            Leads::Question(next) => question = questions.get(next.checked_sub(1)?)?,
            Leads::Outcome(outcome) => ended = Some(outcomes.get(outcome.checked_sub(1)?)?),
        }
    }
    Some(Walked { path, ended })
}

/// A finder's state: `{"answers": [index, …]}`, the answer taken at each question from the first,
/// each from 0. Fewer than a whole path is a finder part answered; none, one started again.
pub(crate) fn read_state(
    questions: &[Question],
    outcomes: &[Outcome],
    state: &Value,
) -> Result<Value, String> {
    let taken = state
        .get("answers")
        .and_then(Value::as_array)
        .ok_or("a finder's state is {\"answers\": [the answer taken at each question, from 0]}")?;
    walk(questions, outcomes, taken).ok_or("those answers aren't a path through the finder")?;
    Ok(json!({"answers": taken}))
}

/// "In "Do you need a visa?", answered: Which passport do you hold? Vietnam; How long will you
/// stay? Under 15 days → No visa needed.": what the person answered, for the next run.
pub(crate) fn change(
    title: &str,
    questions: &[Question],
    outcomes: &[Outcome],
    state: &Value,
) -> Option<String> {
    let Walked { path, ended } = walk(questions, outcomes, state.get("answers")?.as_array()?)?;
    if path.is_empty() {
        return Some(format!("In \"{title}\", nothing is answered."));
    }
    let answered = path
        .iter()
        .map(|(question, answer)| format!("{} {}", question.text, answer.label))
        .collect::<Vec<_>>()
        .join("; ");
    Some(match ended {
        Some(outcome) => format!("In \"{title}\", answered: {answered} → {}.", outcome.label),
        None => format!("In \"{title}\", answered: {answered}, and stopped there."),
    })
}

/// "3 questions, first "Which passport do you hold?"; outcomes: No visa needed, An e-visa": a finder
/// in a line, for the next run.
pub(crate) fn line(questions: &[Question], outcomes: &[Outcome]) -> String {
    let first = questions
        .first()
        .map(|question| question.text.as_str())
        .unwrap_or_default();
    let asked = if questions.len() == 1 {
        format!("1 question, \"{first}\"")
    } else {
        format!("{} questions, first \"{first}\"", questions.len())
    };
    format!(
        "{asked}; outcomes: {}",
        outcomes
            .iter()
            .map(|outcome| outcome.label.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    )
}

#[cfg(test)]
mod tests;
