//! What a person's message says done looks like (ADR 0098), read while the work runs and held to
//! before the work becomes the answer.
//!
//! People already say it: "in a few lines", "at most 250 words", "exactly three sections", "stop
//! after 5 tries". An agent given those words in its task still misses them, and checking its own
//! work does not catch it: in the quality bench's calibration of 2026-10-25 the conditions a
//! request stated in plain words were the items missed most, counted rather than judged. So one
//! turn of the fast model reads the message for them while the work starts ([`read`]), and the
//! check the work gets — the team's own check step, or `LoomWatch`'s when it has none — holds the
//! work to them.
//!
//! What this module holds to:
//!
//! - **Beside the work, never before it.** Nothing needs the conditions until the work replies, so
//!   the read adds no wait, and the working agent's prompt is unchanged.
//! - **Quoted, never added.** An item whose words and numbers are not the message's is dropped, and
//!   so is a number of tries the message doesn't name ([`parse`]). A read that fails, is slow or
//!   answers something that can't be read changes nothing but a quiet mark under the message.
//! - **The person's.** They see what was read under their message, and can take any of it off the
//!   check and put it back, until the check has ended ([`MessageDone::set_checked`]).

use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::{Notify, watch};

use crate::EventKind;
use crate::archive::EventArchive;
use crate::config::{DONE_WHEN_CHARS, DONE_WHEN_ITEMS};
use crate::engine::EventLog;

/// The id `LoomWatch`'s own check, and what it read in the message, are recorded under. A team
/// file can never give an agent this id (`config::is_identifier` refuses the colon), so it is never
/// one of the team's.
pub const CHECKER_ID: &str = "loomwatch:check";
/// The name `LoomWatch`'s own check is shown and spoken of by.
pub const CHECKER_NAME: &str = "LoomWatch";
/// The `session_meta` phase a message's Done when is recorded under, each time it changes.
pub const PHASE: &str = "done_when";
/// What the read's own session is recorded as: the same as the chat's read of a message
/// ([`crate::intent`]), so the Usage page counts both as `LoomWatch` working out what messages need.
const READER_ID: &str = "reader";
/// How long the read may take. It runs beside the work, so only a check that comes sooner waits.
const READ_LIMIT: Duration = Duration::from_secs(90);
/// The most tries a message is read as giving the work: past it, a number is about something else.
const MOST_TRIES: u32 = 20;
/// How much of the conversation the read is shown: enough to read "do it again, shorter".
const CONVERSATION_CHARS: usize = 4_000;
/// What the reader is told it is, in place of the base prompt every team agent gets.
const READER_PROMPT: &str = "You read one message a person sent to their LoomWatch agents and \
     list what it says the finished work must satisfy, in its own words. Answer in exactly the \
     format you are asked for.";
/// The line the read answers with when the message states nothing that can be checked.
const NONE: &str = "NONE";
/// The line its items come under.
const HEADING: &str = "DONE WHEN";
/// The line that says how many tries the work has.
const TRIES: &str = "TRIES";
/// Why an item can't be taken off or put back, once the check has ended.
pub const ENDED: &str = "The check has ended, so what it checks can no longer change.";
/// Why an item can't be taken off or put back, when the message has no such item.
pub const NO_ITEM: &str = "This message has no such Done when item.";

/// What a message says the finished work must satisfy: its own words, and how many tries it gives
/// the work when it says.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Asked {
    pub items: Vec<String>,
    pub tries: Option<u32>,
}

/// How far the read of a message has come.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reading {
    Reading,
    /// It says what done looks like.
    Found(Asked),
    /// It says nothing that can be checked.
    Nothing,
    /// The read failed, ran out of time, or answered something that can't be read.
    Failed,
}

impl Reading {
    const fn as_str(&self) -> &'static str {
        match self {
            Self::Reading => "reading",
            Self::Found(_) => "found",
            Self::Nothing => "none",
            Self::Failed => "failed",
        }
    }
}

/// A message's Done when as it stands for its run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct State {
    pub reading: Reading,
    /// The items the person took off the check, by their place in what was read.
    pub off: BTreeSet<usize>,
    /// How many times the work may go back for them, once the check knows.
    pub rounds: Option<u32>,
    /// The model `LoomWatch`'s own check runs on, once it starts, and whether its maker is the
    /// checked agent's own: the person's message and work go to that maker too.
    pub checker: Option<(String, bool)>,
    /// The check has ended, or the run did: nothing can be taken off or put back any more.
    pub ended: bool,
}

/// One run's read of its message, shared by the run, the API and the chat's record of it.
#[derive(Clone, Debug)]
pub struct MessageDone {
    state: Arc<watch::Sender<State>>,
    recording: Arc<Mutex<Option<Recording>>>,
    /// The model `LoomWatch`'s own check runs on in place of the Checker job's: a test's stand-in.
    checker_model: Option<String>,
}

impl MessageDone {
    /// A message whose read has just started.
    #[must_use]
    pub fn reading() -> Self {
        Self::with(Reading::Reading)
    }

    /// A message already read, as `items` and `tries`: a test's, or a routine's read once.
    #[must_use]
    pub fn found(items: &[&str], tries: Option<u32>) -> Self {
        Self::with(Reading::Found(Asked {
            items: items.iter().map(|item| (*item).to_owned()).collect(),
            tries,
        }))
    }

    fn with(reading: Reading) -> Self {
        let (state, _) = watch::channel(State {
            reading,
            off: BTreeSet::new(),
            rounds: None,
            checker: None,
            ended: false,
        });
        Self {
            state: Arc::new(state),
            recording: Arc::default(),
            checker_model: None,
        }
    }

    /// This read, with `LoomWatch`'s own check on `model` rather than the Checker job's: a test's.
    #[must_use]
    pub fn checked_on(mut self, model: Option<String>) -> Self {
        self.checker_model = model;
        self
    }

    /// The model `LoomWatch`'s own check of work done on `work_model` runs on, and its thinking
    /// effort: the Checker job's, on another maker's model than the work's where the person's
    /// sources have one (ADR 0098).
    #[must_use]
    pub fn checker_model(&self, work_model: &str) -> (String, Option<String>) {
        if let Some(model) = &self.checker_model {
            return (model.clone(), None);
        }
        let (_, model, effort) = crate::control::checker_job();
        if maker(&model) != maker(work_model) {
            return (model, Some(effort));
        }
        let strong = crate::control::tier_model("strong");
        let model = if maker(&strong) == maker(work_model) {
            model
        } else {
            strong
        };
        (model, Some(effort))
    }

    /// The check started on `model`, checking work done on `work_model`.
    pub fn set_checker(&self, model: &str, work_model: &str) {
        let started = Some((model.to_owned(), maker(model) == maker(work_model)));
        self.state.send_if_modified(|state| {
            let changed = state.checker != started;
            state.checker.clone_from(&started);
            changed
        });
    }

    /// The read is done: what it found. Only the first answer counts.
    pub fn finish(&self, reading: Reading) {
        self.state.send_if_modified(|state| {
            let reading_now = state.reading == Reading::Reading;
            if reading_now {
                state.reading = reading;
            }
            reading_now
        });
    }

    /// Where it stands now.
    #[must_use]
    pub fn now(&self) -> State {
        self.state.borrow().clone()
    }

    /// What the message asks, once the read is done: waits at most `wait` for it, and a read still
    /// going then counts as failed. `None` when it found nothing to check.
    pub async fn read(&self, wait: Duration) -> Option<Asked> {
        let mut seen = self.state.subscribe();
        let timed_out = tokio::time::timeout(
            wait,
            seen.wait_for(|state| state.reading != Reading::Reading),
        )
        .await
        .is_err();
        if timed_out {
            self.finish(Reading::Failed);
        }
        match &self.state.borrow().reading {
            Reading::Found(asked) => Some(asked.clone()),
            _ => None,
        }
    }

    /// The items still to check: what was read, less what the person took off.
    #[must_use]
    pub fn checked_items(&self) -> Vec<String> {
        let state = self.state.borrow();
        match &state.reading {
            Reading::Found(asked) => asked
                .items
                .iter()
                .enumerate()
                .filter(|(index, _)| !state.off.contains(index))
                .map(|(_, item)| item.clone())
                .collect(),
            _ => Vec::new(),
        }
    }

    /// The items the person took off the check.
    #[must_use]
    pub fn taken_off(&self) -> Vec<String> {
        let state = self.state.borrow();
        match &state.reading {
            Reading::Found(asked) => state
                .off
                .iter()
                .filter_map(|index| asked.items.get(*index).cloned())
                .collect(),
            _ => Vec::new(),
        }
    }

    /// How many times the work may go back for these items, as the check worked it out.
    pub fn set_rounds(&self, rounds: u32) {
        self.state.send_if_modified(|state| {
            let changed = state.rounds != Some(rounds);
            state.rounds = Some(rounds);
            changed
        });
    }

    /// Take item `index` off the check, or put it back.
    ///
    /// # Errors
    ///
    /// [`ENDED`] once the check has ended, and [`NO_ITEM`] when the message has no item `index`.
    pub fn set_checked(&self, index: usize, checked: bool) -> Result<State, &'static str> {
        let mut answer = Err(NO_ITEM);
        self.state.send_if_modified(|state| {
            if state.ended {
                answer = Err(ENDED);
                return false;
            }
            let Reading::Found(asked) = &state.reading else {
                return false;
            };
            if index >= asked.items.len() {
                return false;
            }
            answer = Ok(());
            if checked {
                state.off.remove(&index)
            } else {
                state.off.insert(index)
            }
        });
        answer.map(|()| self.now())
    }

    /// The check has ended: what it checks is settled.
    pub fn end(&self) {
        self.state.send_if_modified(|state| {
            let changed = !state.ended;
            state.ended = true;
            changed
        });
    }

    /// Record every change in `log` from now on, so the chat shows it under the message.
    pub(crate) fn record_in(&self, log: EventLog) {
        let recording = record(self, log);
        *self
            .recording
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(recording);
    }

    /// The run is over: settle what was read, and write its last change before the run's events
    /// are counted.
    pub async fn close(&self) {
        self.end();
        let recording = self
            .recording
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(recording) = recording {
            recording.stop().await;
        }
    }
}

/// What the chat is told of a message's Done when.
pub(crate) fn payload(state: &State) -> Value {
    let (items, tries) = match &state.reading {
        Reading::Found(asked) => (
            asked
                .items
                .iter()
                .enumerate()
                .map(|(index, text)| json!({"text": text, "checked": !state.off.contains(&index)}))
                .collect(),
            asked.tries,
        ),
        _ => (Vec::new(), None),
    };
    json!({
        "phase": PHASE,
        "state": state.reading.as_str(),
        "items": items,
        "tries": tries,
        "rounds": state.rounds,
        "checker": state.checker.as_ref().map(|(model, same)| json!({"model": model, "sameMaker": same})),
        "ended": state.ended,
    })
}

/// Who makes `model`: `openai` for a `ChatGPT` plan's, `anthropic` for Claude credit's, and an
/// `OpenRouter` id's own first part.
fn maker(model: &str) -> String {
    let model = crate::ai::ModelRef::parse(model);
    match model.source {
        crate::ai::Source::ChatGpt => "openai".to_owned(),
        crate::ai::Source::Anthropic => "anthropic".to_owned(),
        crate::ai::Source::OpenRouter => model
            .id
            .split('/')
            .next()
            .unwrap_or_default()
            .to_lowercase(),
    }
}

/// The task that writes a message's Done when into its run's archive each time it changes.
#[derive(Debug)]
struct Recording {
    stop: Arc<Notify>,
    task: tokio::task::JoinHandle<()>,
}

impl Recording {
    /// Write the last change, then end.
    async fn stop(self) {
        self.stop.notify_one();
        let _ = self.task.await;
    }
}

/// Only what the chat shows is written: what was found, and a read that failed. A read still
/// going, or one that found nothing, writes nothing.
fn record(done: &MessageDone, log: EventLog) -> Recording {
    let stop = Arc::new(Notify::new());
    let stopped = Arc::clone(&stop);
    let mut seen = done.state.subscribe();
    let task = tokio::spawn(async move {
        let mut last: Option<State> = None;
        loop {
            let state = seen.borrow_and_update().clone();
            write(&log, &state, &mut last).await;
            // Neither side is a database future: the write above is never dropped part way.
            tokio::select! {
                changed = seen.changed() => if changed.is_err() { break },
                () = stopped.notified() => break,
            }
        }
        let state = seen.borrow().clone();
        write(&log, &state, &mut last).await;
    });
    Recording { stop, task }
}

async fn write(log: &EventLog, state: &State, last: &mut Option<State>) {
    let shown = matches!(state.reading, Reading::Found(_) | Reading::Failed);
    if !shown || last.as_ref() == Some(state) {
        return;
    }
    if let Err(error) = log
        .append(
            CHECKER_ID,
            EventKind::SessionMeta,
            payload(state),
            Some(json!({"source": "loomwatch", "phase": PHASE})),
        )
        .await
    {
        eprintln!("warning: could not record what the message asks: {error:#}");
    }
    *last = Some(state.clone());
}

/// Read what `message` says the finished work must satisfy: one turn on `model`, with no tools.
pub(crate) async fn read(
    archive: &EventArchive,
    teams_root: &Path,
    message: &str,
    conversation: Option<&str>,
    model: &str,
) -> Reading {
    let message = message.trim();
    if message.is_empty() {
        return Reading::Nothing;
    }
    let prompt = read_prompt(message, conversation);
    let turn = crate::intent::one_turn(
        archive,
        teams_root,
        READER_ID,
        READER_PROMPT,
        model,
        &prompt,
        &[],
    );
    match tokio::time::timeout(READ_LIMIT, turn).await {
        Ok(Ok(reply)) => parse(&reply, message),
        Ok(Err(_)) | Err(_) => Reading::Failed,
    }
}

/// The read's question.
fn read_prompt(message: &str, conversation: Option<&str>) -> String {
    let mut prompt = format!(
        "A person sent this message to their LoomWatch agents:\n\n<message>\n{message}\n</message>\n\n"
    );
    if let Some(conversation) = conversation.filter(|text| !text.trim().is_empty()) {
        let _ = write!(
            prompt,
            "It continues this conversation:\n\n<conversation>\n{}\n</conversation>\n\n",
            crate::cap_middle_text(conversation.trim(), CONVERSATION_CHARS)
        );
    }
    let _ = write!(
        prompt,
        "List the conditions the message itself says the finished work must meet, each one \
         something a reader could check from the work or by measuring it: a length, a format, \
         sections or headings, a file to make, a number to reach, a test to pass, something to \
         leave out. Quote the message's own words for each, trimmed to the condition, in its own \
         language. Never reword one, and never add one the message does not state.\n\n\
         Not a condition: the task itself (what to make or do), how to work (where to look, what \
         to use), or a wish nobody could check.\n\n\
         If the message says how many tries or attempts the work may take, give that number too.\n\n\
         Answer in this format and nothing else, with at most {DONE_WHEN_ITEMS} conditions, the \
         message's first:\n{HEADING}\n- <condition>\n- <condition>\n{TRIES} <number>\n\n\
         Leave out the {TRIES} line when the message gives no number of tries. When the message \
         states no condition, answer with the one word {NONE}."
    );
    prompt
}

/// What the read's reply says, held to the message: an item is kept only when its words and its
/// numbers are the message's, and a number of tries only when the message names it.
fn parse(reply: &str, message: &str) -> Reading {
    let lines: Vec<&str> = reply
        .lines()
        .map(|line| line.trim().trim_matches(['*', '_', '`', '#']).trim())
        .filter(|line| !line.is_empty())
        .collect();
    let Some(first) = lines.first() else {
        return Reading::Failed;
    };
    if first.eq_ignore_ascii_case(NONE) {
        return Reading::Nothing;
    }
    let mut asked = Asked::default();
    let mut answered = false;
    for line in &lines {
        if line.trim_end_matches(':').eq_ignore_ascii_case(HEADING) {
            answered = true;
        } else if let Some(number) = tries_line(line) {
            answered = true;
            asked.tries = Some(number).filter(|tries| names_number(message, *tries));
        } else if let Some(item) = list_item(line) {
            answered = true;
            let item = cut(item);
            if asked.items.len() < DONE_WHEN_ITEMS
                && quotes(&item, message)
                && !asked.items.contains(&item)
            {
                asked.items.push(item);
            }
        }
    }
    if !answered {
        return Reading::Failed;
    }
    if asked.items.is_empty() {
        return Reading::Nothing;
    }
    Reading::Found(asked)
}

/// The number on a `TRIES 5` line.
fn tries_line(line: &str) -> Option<u32> {
    let rest = line.get(..TRIES.len())?;
    if !rest.eq_ignore_ascii_case(TRIES) {
        return None;
    }
    let number: u32 = line[TRIES.len()..]
        .trim_matches(|c: char| !c.is_ascii_digit())
        .parse()
        .ok()?;
    (1..=MOST_TRIES).contains(&number).then_some(number)
}

/// What a list line says, without its marker and the quotes around it.
fn list_item(line: &str) -> Option<&str> {
    let rest = ["- ", "• ", "* "]
        .iter()
        .find_map(|marker| line.strip_prefix(marker))
        .or_else(|| {
            let digits = line.find(|c: char| !c.is_ascii_digit())?;
            (digits > 0)
                .then(|| {
                    line[digits..]
                        .strip_prefix(". ")
                        .or_else(|| line[digits..].strip_prefix(") "))
                })
                .flatten()
        })?;
    let item = rest
        .trim()
        .trim_matches([
            '"', '\'', '\u{201c}', '\u{201d}', '\u{2018}', '\u{2019}', '`',
        ])
        .trim();
    (!item.is_empty()).then_some(item)
}

/// An item no longer than an agent's Done when item may be.
fn cut(item: &str) -> String {
    if item.chars().count() <= DONE_WHEN_CHARS {
        return item.to_owned();
    }
    let kept: String = item.chars().take(DONE_WHEN_CHARS - 1).collect();
    format!("{}\u{2026}", kept.trim_end())
}

/// The words of `text`, in lowercase: runs of letters and digits, in any language.
fn words(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_lowercase)
        .collect()
}

/// Whether `item` is the message's own: every number in it is the message's, and at least seven
/// in ten of its words are.
fn quotes(item: &str, message: &str) -> bool {
    let said: BTreeSet<String> = words(message).into_iter().collect();
    let words = words(item);
    if words.is_empty() {
        return false;
    }
    if words
        .iter()
        .any(|word| word.chars().any(|c| c.is_ascii_digit()) && !said.contains(word))
    {
        return false;
    }
    let found = words.iter().filter(|word| said.contains(*word)).count();
    found * 10 >= words.len() * 7
}

/// The numbers up to twenty, as English writes them.
const NUMBER_WORDS: [&str; 21] = [
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
    "twenty",
];

/// Whether `message` names `number`, in digits or, in English, in words.
fn names_number(message: &str, number: u32) -> bool {
    let words = words(message);
    let digits = number.to_string();
    let word = usize::try_from(number)
        .ok()
        .and_then(|index| NUMBER_WORDS.get(index));
    words
        .iter()
        .any(|said| *said == digits || word.is_some_and(|word| said == word))
}

/// Whether `text` gives a number, in digits or, in English, in words: what a measurement says.
pub(crate) fn has_number(text: &str) -> bool {
    text.chars().any(|c| c.is_ascii_digit())
        || words(text)
            .iter()
            .any(|word| NUMBER_WORDS.contains(&word.as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MESSAGE: &str = "Write this week's update for Lan. Use exactly three sections, headed \
         Agreed, Open and Next steps. At most 250 words, and stop after 3 tries.";

    fn found(reading: Reading) -> Asked {
        match reading {
            Reading::Found(asked) => asked,
            other => panic!("expected items, got {other:?}"),
        }
    }

    /// **Quoted, never added.** The read's items are kept in its order when they are the message's
    /// own words and numbers; an item with a number the message doesn't have, or words it never
    /// used, is dropped, and so is a second copy of one.
    #[test]
    fn only_what_the_message_says_is_kept() {
        let reply = "DONE WHEN\n\
             - \u{201c}exactly three sections, headed Agreed, Open and Next steps\u{201d}\n\
             - At most 250 words\n\
             - At most 200 words\n\
             - Written in a friendly, warm tone for the client\n\
             - At most 250 words\n\
             TRIES 3";
        let asked = found(parse(reply, MESSAGE));
        assert_eq!(
            asked.items,
            [
                "exactly three sections, headed Agreed, Open and Next steps",
                "At most 250 words"
            ]
        );
        assert_eq!(asked.tries, Some(3));
    }

    /// A number of tries is kept only when the message names it, in digits or in words, and only up
    /// to twenty.
    #[test]
    fn tries_are_the_message_s_number() {
        let item = "DONE WHEN\n- At most 250 words\nTRIES 5";
        assert_eq!(found(parse(item, MESSAGE)).tries, None, "it said 3");
        assert_eq!(
            found(parse(item, "At most 250 words, five tries at most")).tries,
            Some(5)
        );
        assert_eq!(
            found(parse("DONE WHEN\n- 250 words\nTRIES 250", "250 words")).tries,
            None
        );
    }

    /// NONE is nothing to check; items that are all dropped are nothing too; a reply that is
    /// neither the format nor NONE is a read that failed.
    #[test]
    fn nothing_and_failure_are_told_apart() {
        assert_eq!(parse("NONE", MESSAGE), Reading::Nothing);
        assert_eq!(parse("**NONE**", MESSAGE), Reading::Nothing);
        assert_eq!(
            parse("DONE WHEN\n- In a cheerful voice", MESSAGE),
            Reading::Nothing
        );
        assert_eq!(
            parse("I think the person wants an update.", MESSAGE),
            Reading::Failed
        );
        assert_eq!(parse("", MESSAGE), Reading::Failed);
    }

    /// The read quotes in the message's own language: words are letters in any script.
    #[test]
    fn a_vietnamese_message_is_quoted_in_vietnamese() {
        let message = "Viết báo cáo tuần cho Lan, tối đa 250 chữ.";
        let asked = found(parse("DONE WHEN\n1. tối đa 250 chữ", message));
        assert_eq!(asked.items, ["tối đa 250 chữ"]);
    }

    /// At most five items, each no longer than a Done when item.
    #[test]
    fn items_are_held_to_done_when_limits() {
        let long = "word ".repeat(60);
        let message = format!("{long} a b c d e f");
        let reply = format!("DONE WHEN\n- {long}\n- a\n- b\n- c\n- d\n- e\n- f");
        let asked = found(parse(&reply, &message));
        assert_eq!(asked.items.len(), DONE_WHEN_ITEMS);
        assert!(asked.items[0].chars().count() <= DONE_WHEN_CHARS);
        assert!(asked.items[0].ends_with('\u{2026}'));
    }

    /// The person can take an item off and put it back until the check ends; then nothing changes.
    #[test]
    fn items_come_off_and_go_back_until_the_check_ends() {
        let done = MessageDone::found(&["At most 250 words", "Three sections"], Some(3));
        assert!(done.set_checked(0, false).is_ok());
        assert_eq!(done.checked_items(), ["Three sections"]);
        assert_eq!(done.taken_off(), ["At most 250 words"]);
        assert!(done.set_checked(0, true).is_ok());
        assert_eq!(done.checked_items().len(), 2);
        assert_eq!(done.set_checked(5, false), Err(NO_ITEM));
        done.end();
        assert_eq!(done.set_checked(1, false), Err(ENDED));
        assert_eq!(done.checked_items().len(), 2);
    }

    /// A read still going when the check needs it counts as failed, and says nothing to check.
    #[tokio::test]
    async fn a_read_that_takes_too_long_is_a_read_that_failed() {
        let done = MessageDone::reading();
        assert_eq!(done.read(Duration::from_millis(10)).await, None);
        assert_eq!(done.now().reading, Reading::Failed);
        done.finish(Reading::Nothing);
        assert_eq!(
            done.now().reading,
            Reading::Failed,
            "only the first answer counts"
        );
    }

    /// **One turn reads the message, with the conversation it continues.** What it answers is held
    /// to the message; a model that can't be reached is a read that failed.
    #[tokio::test]
    async fn one_turn_reads_the_message_with_its_conversation() -> anyhow::Result<()> {
        use crate::agent::{Completion, Demo};
        let folder =
            std::env::temp_dir().join(format!("loomwatch-done-read-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&folder)?;
        let archive = EventArchive::open(&folder.join("loomwatch.db")).await?;
        let reader = Demo::scripted(vec![Completion::text(
            "DONE WHEN\n- At most 250 words\nTRIES 3",
        )]);
        let model = crate::engine::demo_model(reader.clone());
        let reading = read(
            &archive,
            &folder,
            MESSAGE,
            Some("You: the update for Lan, please"),
            &model,
        )
        .await;
        assert_eq!(
            reading,
            Reading::Found(Asked {
                items: vec!["At most 250 words".to_owned()],
                tries: Some(3),
            })
        );
        let asked = reader.requests();
        assert_eq!(asked.len(), 1, "one turn, no tools to call");
        assert!(
            asked[0]
                .prompt()
                .contains(&format!("<message>\n{MESSAGE}\n</message>"))
        );
        assert!(
            asked[0]
                .prompt()
                .contains("<conversation>\nYou: the update for Lan, please\n</conversation>")
        );
        let down = crate::engine::demo_model(Demo::dying("", "the provider is down"));
        assert_eq!(
            read(&archive, &folder, MESSAGE, None, &down).await,
            Reading::Failed
        );
        let _ = std::fs::remove_dir_all(&folder);
        Ok(())
    }

    /// A measurement gives a number, in digits or in words.
    #[test]
    fn a_measurement_gives_a_number() {
        assert!(has_number("241 words"));
        assert!(has_number("three sections"));
        assert!(!has_number("short enough"));
    }
}
