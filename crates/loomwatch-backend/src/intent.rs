//! What an `@` message in the team chat is asking for, read before it starts any work, and the
//! agents' own answers when it asks for no work.
//!
//! `@team` and `@name` start work (ADR 0051), and a team that runs its workflow on every message
//! does its standing job on every message: greeted with "hi", a research team researches and
//! writes its whole brief. A team of people would not. Greeted, each of them says hello back;
//! asked who checks the sources, the one who does answers; only a real job goes through the
//! team's way of working, each passing their part to the next.
//!
//! So a message is read first ([`read`]): one turn of the fast model, with no tools, sees it with
//! the conversation so far, who it was for and what each agent is for, and says either that it
//! needs the team's workflow, or which agents would answer it themselves. Those agents then answer
//! at the same time ([`reply`]), each in one turn on its own model, as itself, with its own
//! instructions and the conversation, and with no tools and no handovers. The message stays in the
//! chat as a note with their answers under it, and "Start the team on this" is still on it.
//!
//! The read holds work back only when it is sure. A long message, a team on a stand-in model, no
//! model connected, a slow or failed turn, or an answer it can't read: each starts the workflow, as
//! every message did before. Inside the workflow, every agent is told to read the request for what
//! it means too (`## Reading the request`, [`crate::compose_prompt`]).

use std::fmt::Write as _;
use std::path::Path;
use std::time::Duration;

use uuid::Uuid;

use crate::agent::OFFLINE_MODEL;
use crate::ai::ModelRef;
use crate::archive::EventArchive;
use crate::config::{AgentConfig, TeamConfig};
use crate::engine::{AgentRun, AppReportedError, EventLog, TeamSessionContext};

/// Past this many characters a message is taken as work without reading it first: a message this
/// long spells out a job, and reading it would only make it wait.
pub(crate) const MAX_READ_CHARS: usize = 600;
/// The message's send waits this long for the read at most; past it, the workflow starts.
const READ_LIMIT: Duration = Duration::from_secs(20);
/// One agent's answer may take this long; past it, that agent did not answer ([`TOO_SLOW`]).
const REPLY_LIMIT: Duration = Duration::from_secs(120);
/// Why an agent did not answer, when it took longer than [`REPLY_LIMIT`].
const TOO_SLOW: &str = "The answer took over two minutes, so LoomWatch stopped waiting. Try again.";
/// Why an agent did not answer, when its turn could not even start.
const NOT_STARTED: &str = "LoomWatch couldn't start the answer. Try again.";
/// An answer is a chat message: past this it is cut in the middle, as handed text is.
const MAX_ANSWER_CHARS: usize = 4_000;
/// How much of each agent's instructions the read sees: an agent's job is said at the top.
const ROLE_CHARS: usize = 400;
/// How much of its own instructions an agent answering in the chat is given.
const OWN_ROLE_CHARS: usize = 6_000;
/// What the read's session is recorded as.
const READER_ID: &str = "reader";
/// What the reader is told it is, in place of the base prompt every team agent gets.
const READER_PROMPT: &str = "You read one message sent to a LoomWatch team's chat, as a \
     thoughtful colleague on that team would, and say what it needs. Answer in exactly the format \
     you are asked for.";
/// What an agent answering for itself replies when it has nothing to add.
const PASS: &str = "PASS";

/// Who a message was for.
pub(crate) struct Addressed<'a> {
    pub(crate) team: &'a TeamConfig,
    /// The agent it was for, or the team's first step for `@team`.
    pub(crate) speaker: &'a AgentConfig,
    /// `@team` rather than one agent: then whichever agents would answer, answer.
    pub(crate) whole_team: bool,
}

/// What the message is around: the conversation so far in the chat, and the message it replies
/// to, as the conversation section names it.
#[derive(Default, Clone)]
pub(crate) struct Context {
    pub(crate) conversation: Option<String>,
    pub(crate) replying: Option<String>,
}

/// The agents who would answer `message` themselves, in the team's order; `None` when it needs
/// the team's workflow, or when that can't be told. One turn on `model`.
pub(crate) async fn read(
    archive: Option<&EventArchive>,
    teams_root: &Path,
    addressed: &Addressed<'_>,
    message: &str,
    context: &Context,
    model: &str,
) -> Option<Vec<String>> {
    let message = message.trim();
    if message.is_empty() || message.chars().count() > MAX_READ_CHARS {
        return None;
    }
    // A team on the offline demo or a scripted stand-in never calls a real model, so neither does
    // the read of its messages.
    if stand_in(&addressed.speaker.model) {
        return None;
    }
    let prompt = read_prompt(addressed, message, context);
    let turn = one_turn(
        archive?,
        teams_root,
        READER_ID,
        READER_PROMPT,
        model,
        &prompt,
        &[],
    );
    match tokio::time::timeout(READ_LIMIT, turn).await {
        Ok(Ok(reply)) => talkers(&reply, addressed),
        Ok(Err(_)) | Err(_) => None,
    }
}

/// What an agent said last in the newest work, which it answers with in mind.
pub(crate) struct OwnWords {
    /// The work's short id, as the conversation names it.
    pub(crate) work: String,
    pub(crate) text: String,
}

/// What an agent answering in the chat came back with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Reply {
    /// Its answer.
    Said(String),
    /// It had nothing to add: it said PASS, or nothing at all. It stays silent.
    Passed,
    /// Its turn failed, so it could not answer: why, in the words a run that stopped shows
    /// ([`crate::agent::AgentError`]), for the person to read under their message.
    Failed(String),
}

/// `agent`'s own answer to `message`, as itself in the team's chat: one turn on its own model with
/// no tools, remembering what it said last in the newest work.
pub(crate) async fn reply(
    archive: Option<&EventArchive>,
    teams_root: &Path,
    addressed: &Addressed<'_>,
    message: &str,
    context: &Context,
    own: Option<&OwnWords>,
    lessons: &[String],
) -> Reply {
    let Some(archive) = archive else {
        return Reply::Failed(NOT_STARTED.to_owned());
    };
    let agent = addressed.speaker;
    let instructions = own_instructions(addressed.team, agent);
    let prompt = reply_prompt(addressed, message.trim(), context, own);
    let model = agent.model_selector();
    let turn = one_turn(
        archive,
        teams_root,
        &agent.id,
        &instructions,
        &model,
        &prompt,
        lessons,
    );
    reply_of(tokio::time::timeout(REPLY_LIMIT, turn).await.ok())
}

/// What an answer's turn came to: `None` when it ran out of time.
fn reply_of(turn: Option<Result<String, String>>) -> Reply {
    let answer = match turn {
        None => return Reply::Failed(TOO_SLOW.to_owned()),
        Some(Err(why)) => return Reply::Failed(why),
        Some(Ok(answer)) => answer,
    };
    let answer = answer.trim();
    let passed = answer
        .trim_matches(|c: char| !c.is_alphanumeric())
        .eq_ignore_ascii_case(PASS);
    if answer.is_empty() || passed {
        Reply::Passed
    } else {
        Reply::Said(crate::cap_middle_text(answer, MAX_ANSWER_CHARS))
    }
}

/// One turn with no tools, recorded as a session of its own: its reply, or why it failed.
async fn one_turn(
    archive: &EventArchive,
    teams_root: &Path,
    agent_id: &str,
    instructions: &str,
    model: &str,
    prompt: &str,
    lessons: &[String],
) -> Result<String, String> {
    let workspace = match crate::control::prepare_workspace(teams_root) {
        Ok(workspace) => workspace,
        Err(error) => {
            eprintln!("warning: the chat could not answer a message: {error}");
            return Err(NOT_STARTED.to_owned());
        }
    };
    // An agent answering as itself keeps to what it learned (ADR 0078); the reader learned nothing.
    let mut spec = crate::control::ask_spec(workspace);
    spec.lessons = lessons.to_vec();
    let mut process = AgentRun::spawn(&spec)
        .map_err(|_| NOT_STARTED.to_owned())?
        .without_tools()
        .with_instructions(instructions);
    let context = TeamSessionContext {
        archive,
        bus: None,
        event_log: Some(EventLog::new(
            archive.clone(),
            format!("chat-{agent_id}-{}", Uuid::new_v4()),
        )),
        packet: None,
        composed: None,
        boundary: None,
    };
    match process
        .run_session_with_bus(agent_id, model, prompt, context)
        .await
    {
        Ok(outcome) => Ok(outcome.reply),
        Err(error) => {
            eprintln!("warning: the chat could not answer a message: {error:#}");
            Err(failure_words(&error))
        }
    }
}

/// Why a turn failed, as a run that stopped says it: the agent's own stop in the person's words
/// when there is one (out of credits, a refused key), or else the error as it is.
fn failure_words(error: &anyhow::Error) -> String {
    error
        .chain()
        .find_map(<dyn std::error::Error>::downcast_ref::<AppReportedError>)
        .map_or_else(|| format!("{error:#}"), |reported| reported.message.clone())
}

/// A model that never calls a real one: the offline demo, or a test's scripted `demo/…` stand-in.
fn stand_in(model: &str) -> bool {
    let model = ModelRef::parse(model);
    model.id == OFFLINE_MODEL || model.id.starts_with("demo/")
}

/// The agents that may answer: every agent but a review step, which is the operator.
fn answerers(team: &TeamConfig) -> impl Iterator<Item = &AgentConfig> {
    team.agents.iter().filter(|agent| !agent.is_operator())
}

/// The read's question: the message, who it was for, what each agent is for and the conversation
/// so far.
fn read_prompt(addressed: &Addressed<'_>, message: &str, context: &Context) -> String {
    let team = addressed.team;
    let mut agents = String::new();
    for agent in answerers(team) {
        let _ = writeln!(
            agents,
            "- {} (`{}`): {}",
            name(agent),
            agent.id,
            opening(&agent.role, ROLE_CHARS)
        );
    }
    let (to, talk_format) = if addressed.whole_team {
        (
            "the whole team".to_owned(),
            "the ids of the agents who would answer it themselves, the way people on a team \
             answer in a group chat: everyone for a greeting or thanks to all of them, only the \
             one it asks or is about for a question to one of them"
                .to_owned(),
        )
    } else {
        let speaker = name(addressed.speaker);
        (
            speaker.clone(),
            format!("nothing else: {speaker} answers it"),
        )
    };
    format!(
        "The person wrote this in the chat of their LoomWatch team{}, to {to}{}:\n\n\
         <message>\n{message}\n</message>\n\n\
         The team's agents, each with its id and the start of its instructions:\n{agents}\n\
         {}\
         Read the message as a thoughtful colleague on this team would, with the conversation, \
         and decide what it needs. An agent's instructions say what it is for, not a job to do \
         again on every message.\n\n\
         It needs the team's workflow when it asks for anything to be researched, looked up, \
         found, written, made, checked, changed, planned, compared or decided; when it follows up \
         on earlier work in a way that takes more than a short answer from what the conversation \
         already holds; or when it answers or approves something the team asked \
         (\u{201c}yes\u{201d}, \u{201c}do it\u{201d}, \u{201c}the second one\u{201d}).\n\n\
         The agents can answer it themselves, with no workflow, when it is only a greeting, \
         thanks, a goodbye, a reaction or small talk; a question about who they are, what they do \
         or how they work; or a question they can answer in a few sentences from the \
         conversation above.\n\n\
         When you are not sure, it needs the team's workflow.\n\n\
         If it needs the team's workflow, answer with the one word WORK and nothing else. \
         Otherwise answer with the word TALK followed by {talk_format}, on one line.",
        team_name(team),
        context
            .replying
            .as_deref()
            .map_or_else(String::new, |reply| format!(", replying to {reply}")),
        conversation_block(context),
    )
}

/// Who answers, from the read's reply: `None` for the workflow and for anything that isn't the
/// answer asked for. "TALK" with no agent named is everyone a message to the team was for.
fn talkers(reply: &str, addressed: &Addressed<'_>) -> Option<Vec<String>> {
    let text = reply.trim().trim_matches('`').trim();
    let line = text
        .lines()
        .next()?
        .trim()
        .trim_start_matches(['*', '#', '_', ' ']);
    if !line.get(..4)?.eq_ignore_ascii_case("talk") {
        return None;
    }
    if !addressed.whole_team {
        return Some(vec![addressed.speaker.id.clone()]);
    }
    let named = line[4..]
        .split(|c: char| c.is_whitespace() || c == ',')
        .map(|word| word.trim_matches(|c: char| !(c.is_alphanumeric() || c == '-' || c == '_')))
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>();
    let mut who = answerers(addressed.team)
        .filter(|agent| named.iter().any(|word| agent.id.eq_ignore_ascii_case(word)))
        .map(|agent| agent.id.clone())
        .collect::<Vec<_>>();
    if who.is_empty() {
        who = answerers(addressed.team)
            .map(|agent| agent.id.clone())
            .collect();
    }
    Some(who)
}

/// What an agent answering in the chat is told it is: itself, by its own instructions, talking
/// rather than working.
fn own_instructions(team: &TeamConfig, agent: &AgentConfig) -> String {
    format!(
        "You are {}, an agent on the LoomWatch team{}. Your instructions, which say who you are and \
         what you work on:\n\n<instructions>\n{}\n</instructions>\n\n\
         Right now you are not doing that work. You are talking with the person who runs the team, \
         in the team's chat.",
        name(agent),
        team_name(team),
        opening_lines(&agent.role, OWN_ROLE_CHARS),
    )
}

/// What an agent answering in the chat is asked: the conversation, the message, and to answer as
/// a person on a team would.
fn reply_prompt(
    addressed: &Addressed<'_>,
    message: &str,
    context: &Context,
    own: Option<&OwnWords>,
) -> String {
    let others = answerers(addressed.team)
        .filter(|agent| agent.id != addressed.speaker.id)
        .map(name)
        .collect::<Vec<_>>();
    let (to, together) = if addressed.whole_team {
        let together = if others.is_empty() {
            String::new()
        } else {
            format!(
                " {} {} reading it too and may answer for themselves.",
                list(&others),
                if others.len() == 1 { "is" } else { "are" },
            )
        };
        ("the whole team", together)
    } else {
        ("you", String::new())
    };
    let remembered = own.map_or_else(String::new, |own| {
        format!(
            "What you said last, in work {}:\n<your_words>\n{}\n</your_words>\n\n",
            own.work,
            own.text.trim()
        )
    });
    format!(
        "{}{remembered}The person wrote this in the team's chat, to {to}{}:\n\n<message>\n{message}\n</message>\n\
         {together}\n\n\
         Reply as yourself, the way a person on a team replies in a group chat: in the language of \
         the message, plainly, in one to four short sentences unless the question needs a little \
         more. Answer from what you know about your own work and from the conversation, and speak \
         only for yourself. Don't start your work or produce your usual result: if they want \
         that, they will ask the team for it. If you have nothing to add, reply with exactly \
         {PASS}.",
        conversation_block(context),
        context
            .replying
            .as_deref()
            .map_or_else(String::new, |reply| format!(", replying to {reply}")),
    )
}

fn conversation_block(context: &Context) -> String {
    context
        .conversation
        .as_deref()
        .map(str::trim)
        .filter(|conversation| !conversation.is_empty())
        .map_or_else(
            || "There is no earlier conversation in this chat.\n\n".to_owned(),
            |conversation| {
                format!(
                    "The conversation so far in this chat, oldest first:\n<conversation>\n\
                     {conversation}\n</conversation>\n\n"
                )
            },
        )
}

fn team_name(team: &TeamConfig) -> String {
    if team.name.trim().is_empty() {
        String::new()
    } else {
        format!(" \u{201c}{}\u{201d}", team.name.trim())
    }
}

fn name(agent: &AgentConfig) -> String {
    let name = agent.name.trim();
    if name.is_empty() {
        agent.id.clone()
    } else {
        name.to_owned()
    }
}

/// "A", "A and B", "A, B and C".
fn list(names: &[String]) -> String {
    match names {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// The start of an agent's instructions on one line.
fn opening(role: &str, chars: usize) -> String {
    let line = role.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= chars {
        return line;
    }
    let head: String = line.chars().take(chars).collect();
    format!("{head}\u{2026}")
}

/// The start of an agent's instructions as written.
fn opening_lines(role: &str, chars: usize) -> String {
    let role = role.trim();
    if role.chars().count() <= chars {
        return role.to_owned();
    }
    let head: String = role.chars().take(chars).collect();
    format!("{head}\u{2026}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn team() -> TeamConfig {
        TeamConfig::parse(
            "schemaVersion: 1\nid: rag\nname: Enterprise RAG research\nentrypoint: researcher\n\
             agents:\n  - id: researcher\n    name: RAG researcher\n    role: |\n      Write a \
             production engineering brief on enterprise RAG.\n      Cite primary sources.\n    \
             spawn: {cmd: x, cwd: .}\n    model: m\n  - id: checker\n    name: Fact checker\n    \
             role: Check every claim.\n    spawn: {cmd: x, cwd: .}\n    model: m\n",
        )
        .expect("team")
    }

    fn to_team(team: &TeamConfig) -> Addressed<'_> {
        Addressed {
            team,
            speaker: &team.agents[0],
            whole_team: true,
        }
    }

    fn ids(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|id| (*id).to_owned()).collect()
    }

    #[test]
    fn the_read_says_workflow_or_who_talks() {
        let team = team();
        let addressed = to_team(&team);
        let read = |reply: &str| talkers(reply, &addressed);
        assert_eq!(read("WORK"), None);
        assert_eq!(read("work\n"), None);
        // A greeting to everyone: everyone answers.
        assert_eq!(
            read("TALK researcher checker"),
            Some(ids(&["researcher", "checker"]))
        );
        assert_eq!(read("TALK"), Some(ids(&["researcher", "checker"])));
        assert_eq!(
            read("**TALK:** `checker`, `researcher`"),
            Some(ids(&["researcher", "checker"]))
        );
        // A question about one of them: that one answers.
        assert_eq!(read("TALK checker"), Some(ids(&["checker"])));
        // Names that aren't agents fall back to everyone the message was for.
        assert_eq!(read("TALK everyone"), Some(ids(&["researcher", "checker"])));
        // Not the format asked for: the workflow starts.
        assert_eq!(read("Sure, here is the brief: …"), None);
        assert_eq!(read(""), None);
        assert_eq!(read("Ta"), None);
        // Written to one agent, that agent answers, whoever the line names.
        let one = Addressed {
            team: &team,
            speaker: &team.agents[1],
            whole_team: false,
        };
        assert_eq!(talkers("TALK researcher", &one), Some(ids(&["checker"])));
    }

    #[test]
    fn only_stand_in_models_are_skipped() {
        assert!(stand_in(OFFLINE_MODEL));
        assert!(stand_in("demo/0f3a"));
        assert!(!stand_in("anthropic/claude-sonnet-5.5"));
        assert!(!stand_in("chatgpt:gpt-6.1-sol"));
        assert!(!stand_in(""));
    }

    #[test]
    fn the_read_sees_the_message_the_team_and_the_conversation() {
        let team = team();
        let prompt = read_prompt(&to_team(&team), "hi", &Context::default());
        assert!(prompt.contains("<message>\nhi\n</message>"), "{prompt}");
        assert!(prompt.contains("\u{201c}Enterprise RAG research\u{201d}, to the whole team:"));
        assert!(prompt.contains(
            "- RAG researcher (`researcher`): Write a production engineering brief on enterprise \
             RAG. Cite primary sources."
        ));
        assert!(prompt.contains("- Fact checker (`checker`): Check every claim."));
        assert!(prompt.contains("There is no earlier conversation in this chat."));
        assert!(prompt.contains("When you are not sure, it needs the team's workflow."));
        assert!(prompt.contains("everyone for a greeting or thanks to all of them"));

        let one = Addressed {
            team: &team,
            speaker: &team.agents[1],
            whole_team: false,
        };
        let context = Context {
            conversation: Some("You to the team: the RAG brief".to_owned()),
            replying: Some("Fact checker's answer (\u{201c}Not met\u{201d})".to_owned()),
        };
        let prompt = read_prompt(&one, "why not met?", &context);
        assert!(prompt.contains(
            ", to Fact checker, replying to Fact checker's answer (\u{201c}Not met\u{201d}):"
        ));
        assert!(prompt.contains("<conversation>\nYou to the team: the RAG brief\n</conversation>"));
        assert!(prompt.contains("nothing else: Fact checker answers it"));
    }

    #[test]
    fn an_agent_answers_as_itself_by_its_own_instructions() {
        let team = team();
        let system = own_instructions(&team, &team.agents[1]);
        assert!(system.starts_with(
            "You are Fact checker, an agent on the LoomWatch team \u{201c}Enterprise RAG research\u{201d}."
        ));
        assert!(system.contains("<instructions>\nCheck every claim.\n</instructions>"));
        assert!(system.contains("Right now you are not doing that work."));
        let prompt = reply_prompt(&to_team(&team), "hi", &Context::default(), None);
        assert!(!prompt.contains("<your_words>"));
        let own = OwnWords {
            work: "fb49588f".to_owned(),
            text: "## Check\n1. Met".to_owned(),
        };
        let remembering = reply_prompt(
            &to_team(&team),
            "did you check it?",
            &Context::default(),
            Some(&own),
        );
        assert!(remembering.contains(
            "What you said last, in work fb49588f:\n<your_words>\n## Check\n1. Met\n</your_words>"
        ));
        assert!(
            prompt.contains("to the whole team:\n\n<message>\nhi\n</message>"),
            "{prompt}"
        );
        assert!(prompt.contains("Fact checker is reading it too"));
        assert!(prompt.contains("speak only for yourself"));
        assert!(prompt.contains("Don't start your work or produce your usual result"));
        assert!(prompt.ends_with("reply with exactly PASS."));
    }

    #[tokio::test]
    async fn a_long_message_needs_the_workflow_without_reading_it() {
        let team = team();
        let long = "hello ".repeat(MAX_READ_CHARS);
        let read = read(
            None,
            Path::new("."),
            &to_team(&team),
            &long,
            &Context::default(),
            "m",
        )
        .await;
        assert_eq!(read, None);
    }

    struct Folder(std::path::PathBuf);

    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn scripted(reply: Option<&str>) -> (String, crate::agent::Demo) {
        use crate::agent::{Completion, Demo};
        let demo = match reply {
            Some(reply) => Demo::scripted(vec![Completion::text(reply)]),
            None => Demo::dying("", "the provider is down"),
        };
        (crate::engine::demo_model(demo.clone()), demo)
    }

    /// **One turn reads, and only TALK holds the workflow back; each agent answers on its own
    /// model.** "WORK", or a turn that fails, starts the workflow; PASS or a failed answer is
    /// silence from that agent. An agent answering as itself is given what it learned (ADR 0078).
    #[allow(clippy::too_many_lines)]
    #[tokio::test]
    async fn a_hello_is_read_once_and_each_agent_answers_on_its_own_model() -> anyhow::Result<()> {
        let folder =
            Folder(std::env::temp_dir().join(format!("loomwatch-intent-{}", Uuid::new_v4())));
        std::fs::create_dir_all(&folder.0)?;
        let archive = EventArchive::open(&folder.0.join("loomwatch.db")).await?;
        let team = team();
        let addressed = to_team(&team);
        let context = Context {
            conversation: Some("You to the team: the RAG brief".to_owned()),
            replying: None,
        };

        let (model, reader) = scripted(Some("TALK researcher checker"));
        let who = read(
            Some(&archive),
            &folder.0,
            &addressed,
            "hi @team",
            &context,
            &model,
        )
        .await;
        assert_eq!(who, Some(ids(&["researcher", "checker"])));
        let asked = reader.requests();
        assert_eq!(asked.len(), 1, "one turn, no tools to call");
        assert!(
            asked[0]
                .prompt()
                .contains("<message>\nhi @team\n</message>")
        );
        assert!(
            asked[0]
                .prompt()
                .contains("<conversation>\nYou to the team: the RAG brief\n")
        );

        let (model, _) = scripted(Some("WORK"));
        let work = read(
            Some(&archive),
            &folder.0,
            &addressed,
            "research RAG security",
            &context,
            &model,
        )
        .await;
        assert_eq!(work, None);
        let (model, _) = scripted(None);
        let failed = read(
            Some(&archive),
            &folder.0,
            &addressed,
            "hi",
            &context,
            &model,
        )
        .await;
        assert_eq!(failed, None, "a failed read starts the workflow");

        // Each agent answers on its own model, as itself.
        let mut team = team;
        let (researcher_model, researcher) = scripted(Some("Hi! I write enterprise RAG briefs."));
        let (checker_model, _) = scripted(Some("PASS"));
        team.agents[0].model = researcher_model;
        team.agents[1].model = checker_model;
        let as_researcher = Addressed {
            team: &team,
            speaker: &team.agents[0],
            whole_team: true,
        };
        let said = reply(
            Some(&archive),
            &folder.0,
            &as_researcher,
            "hi @team",
            &context,
            None,
            &["When greeting, say what you work on.".to_owned()],
        )
        .await;
        assert_eq!(
            said,
            Reply::Said("Hi! I write enterprise RAG briefs.".to_owned())
        );
        let asked = researcher.requests();
        assert_eq!(asked.len(), 1);
        assert!(asked[0].prompt().contains("Fact checker is reading it too"));
        // An agent answering as itself keeps to what it learned (ADR 0078).
        assert!(matches!(
            asked[0].messages.first(),
            Some(crate::agent::Message::System { content })
                if content.contains("## What you have learned")
                    && content.contains("- When greeting, say what you work on.\n")
        ));
        let as_checker = Addressed {
            team: &team,
            speaker: &team.agents[1],
            whole_team: true,
        };
        let passed = reply(
            Some(&archive),
            &folder.0,
            &as_checker,
            "hi @team",
            &context,
            None,
            &[],
        )
        .await;
        assert_eq!(passed, Reply::Passed, "PASS is silence");
        Ok(())
    }

    /// **An agent whose turn fails says it could not answer, and why; one with nothing to add
    /// stays silent.** Out of credits, the words are the ones a run that stopped shows, which the
    /// app turns into its button; a provider's own error is kept as it said it.
    #[tokio::test]
    async fn an_answer_that_fails_says_why_where_pass_says_nothing() -> anyhow::Result<()> {
        use crate::agent::{AgentError, Demo};
        let folder =
            Folder(std::env::temp_dir().join(format!("loomwatch-intent-{}", Uuid::new_v4())));
        std::fs::create_dir_all(&folder.0)?;
        let archive = EventArchive::open(&folder.0.join("loomwatch.db")).await?;
        let mut team = team();
        team.agents[0].model = crate::engine::demo_model(Demo::failing_first(
            1,
            || AgentError::OutOfCredits(crate::ai::Source::OpenRouter),
            |_| None,
        ));
        let (provider_down, _) = scripted(None);
        team.agents[1].model = provider_down;
        let answer = async |agent: usize| {
            let addressed = Addressed {
                team: &team,
                speaker: &team.agents[agent],
                whole_team: true,
            };
            reply(
                Some(&archive),
                &folder.0,
                &addressed,
                "hi @team",
                &Context::default(),
                None,
                &[],
            )
            .await
        };
        assert_eq!(
            answer(0).await,
            Reply::Failed(AgentError::OutOfCredits(crate::ai::Source::OpenRouter).to_string())
        );
        match answer(1).await {
            Reply::Failed(why) => assert!(why.contains("the provider is down"), "{why}"),
            other => panic!("a provider error is a failure: {other:?}"),
        }
        Ok(())
    }

    /// With nothing to record its turn in, an agent can't answer, and says so.
    #[tokio::test]
    async fn an_answer_that_cannot_start_says_so() {
        let team = team();
        let addressed = Addressed {
            team: &team,
            speaker: &team.agents[0],
            whole_team: true,
        };
        let said = reply(
            None,
            Path::new("."),
            &addressed,
            "hi @team",
            &Context::default(),
            None,
            &[],
        )
        .await;
        assert_eq!(said, Reply::Failed(NOT_STARTED.to_owned()));
    }

    /// The agent's own stop is said in its words, whatever wraps it; anything else as it is.
    #[test]
    fn a_failed_turn_is_said_in_the_stops_own_words() {
        let stopped = anyhow::Error::new(AppReportedError::stopped(
            &crate::agent::AgentError::OutOfCredits(crate::ai::Source::OpenRouter),
        ))
        .context("the chat's answer failed");
        assert_eq!(
            failure_words(&stopped),
            "Your OpenRouter account is out of credits. Add credits at openrouter.ai, then try \
             again."
        );
        let other = anyhow::anyhow!("the record could not be written").context("opening a session");
        assert_eq!(
            failure_words(&other),
            "opening a session: the record could not be written"
        );
    }

    /// An answer that ran out of time did not answer; an empty one, or PASS in any dress, had
    /// nothing to add; anything else is the answer.
    #[test]
    fn a_turn_comes_to_an_answer_silence_or_why_not() {
        assert_eq!(reply_of(None), Reply::Failed(TOO_SLOW.to_owned()));
        assert_eq!(
            reply_of(Some(Err("OpenRouter reported an error: busy".to_owned()))),
            Reply::Failed("OpenRouter reported an error: busy".to_owned())
        );
        for nothing in ["", "  ", "PASS", "**pass**", "`PASS`."] {
            assert_eq!(
                reply_of(Some(Ok(nothing.to_owned()))),
                Reply::Passed,
                "{nothing:?}"
            );
        }
        assert_eq!(
            reply_of(Some(Ok(" Hello! \n".to_owned()))),
            Reply::Said("Hello!".to_owned())
        );
    }
}
