//! `suggest_tool` (ADR 0126): the agent whose reply is the answer suggests connecting a tool it
//! doesn't have, and the person connects it in the answer with one tap.
//!
//! A suggestion is kept with the answer as a widget of its own kind, as a suggested skill is (ADR
//! 0118), and stands where the agent's words place it. Nothing is connected by the tool. The card
//! has the tool's own mark and one Connect button, which connects it as Connections does (macOS
//! asks for the Mac's own apps, a site asks its sign-in, a token is pasted), gives it to the agent
//! that suggested it, and sends "I connected …" as the person's reply, so the agent carries on with
//! its calls. That it was connected is kept and told to the agent's next work like any widget's
//! state.

use serde_json::{Value, json};

use super::Widget;
use crate::config::{AgentConfig, CapabilityKind};
use crate::prompt_blocks::Block;

/// The tool's name.
pub(crate) const TOOL: &str = "suggest_tool";

/// A tool's name: as long as Connections lets one be.
const NAME_CHARS: usize = 40;

/// What `suggest_tool` says it is for.
pub(crate) const SUGGEST_TOOL: Block = Block::new(
    "tool.suggest_tool",
    "Suggest connecting a tool you don't have when the person asks for something it would do, \
     such as putting events on their calendar, setting a reminder or adding a page in Notion. \
     They see it in your answer with the tool's mark and a Connect button; once they connect it, \
     it is given to you, you are told, and you carry on with its calls. When more than one could \
     do it, such as Apple Reminders and Todoist, suggest the one they named, or ask which they \
     use. Use it instead of telling them how to set a tool up, and for the Mac's own apps in the \
     list instead of a command. Say in your answer what you will do once it is connected, and do \
     now whatever doesn't need it.",
);
/// The tools it may name, after [`SUGGEST_TOOL`].
pub(crate) const SUGGEST_TOOL_LIST: Block = Block::new(
    "tool.suggest_tool.list",
    "The tools you can suggest: {tools}. You can also suggest a tool you were given that isn't \
     connected yet.",
);
pub(crate) const SUGGEST_TOOL_NAME: Block = Block::new(
    "tool.suggest_tool.name",
    "The tool's name as it is listed, such as \"Apple Calendar\"",
);
/// What the agent is told once its suggestion is in the answer.
pub(crate) const SUGGEST_TOOL_SHOWN: Block = Block::new(
    "tool.suggest_tool.shown",
    "Its Connect button is in your answer. Write its place line on its own line where it belongs, \
     such as after the sentence that asks for it, and say what you will do once it is connected; \
     don't explain how to connect it. When the person connects it, their next message says so and \
     its calls are yours.",
);

/// The tool, as the Team Bus and a quick answer offer it, listing what this computer can connect.
pub(crate) fn tool_definition() -> Value {
    let names: Vec<&str> = crate::connected_tools::starter_names_here().collect();
    tool_definition_listing(&names)
}

/// The tool, listing `names` as the tools it may suggest.
pub(crate) fn tool_definition_listing(names: &[&str]) -> Value {
    json!({
        "name": TOOL,
        "description": format!(
            "{} {}",
            SUGGEST_TOOL.text(),
            SUGGEST_TOOL_LIST.fill(&[("tools", &names.join(", "))])
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "tool": {"type": "string", "description": SUGGEST_TOOL_NAME.text(), "minLength": 1},
            },
            "required": ["tool"],
            "additionalProperties": false,
        },
    })
}

/// The suggestion `arguments` ask for, checked for its shape: a starter tool's name is spelled as
/// the list spells it. Whether it is one the agent may suggest is [`check`]'s.
///
/// # Errors
///
/// No name, or one longer than a tool's may be.
pub(crate) fn read(arguments: &Value) -> Result<Widget, String> {
    let name = arguments
        .get("tool")
        .and_then(Value::as_str)
        .map(|name| name.split_whitespace().collect::<Vec<_>>().join(" "))
        .unwrap_or_default();
    if name.is_empty() {
        return Err("name the tool to connect".to_owned());
    }
    if name.chars().count() > NAME_CHARS {
        return Err(format!("a tool's name is at most {NAME_CHARS} characters"));
    }
    let title = crate::connected_tools::starter_named(&name).map_or(name, str::to_owned);
    Ok(Widget::Connect { title })
}

/// `widget` is a tool `agent` may suggest: one this computer can connect from the list, or one it
/// was given by name.
///
/// # Errors
///
/// Any other name, with the ones it may suggest.
pub(crate) fn check(widget: &Widget, agent: Option<&AgentConfig>) -> Result<(), String> {
    let name = widget.title();
    let listed = crate::connected_tools::starter_names_here().any(|listed| listed == name);
    let given = agent.is_some_and(|agent| {
        agent.capabilities.iter().any(|capability| {
            capability.kind == CapabilityKind::Tool
                && capability.name.trim().eq_ignore_ascii_case(name)
        })
    });
    if listed || given {
        return Ok(());
    }
    let names: Vec<&str> = crate::connected_tools::starter_names_here().collect();
    Err(format!(
        "\"{name}\" isn't a tool LoomWatch can connect here. The tools you can suggest: {}",
        names.join(", ")
    ))
}

/// What the agent is told once the suggestion is in its answer: what it is, and its place line.
pub(crate) fn suggested(widget: &Widget, place: u32) -> Value {
    json!({
        "suggested": widget.title(),
        "place": super::place_line(place),
        "next": SUGGEST_TOOL_SHOWN.text(),
    })
}

/// What the person did with a suggestion, checked: `{"connected": true}`, kept once it is
/// connected and given to the agent.
///
/// # Errors
///
/// Any other state.
pub(crate) fn read_state(state: &Value) -> Result<Value, String> {
    if state.get("connected").and_then(Value::as_bool) == Some(true) {
        return Ok(json!({"connected": true}));
    }
    Err("a suggested tool's state is {\"connected\": true}".to_owned())
}

/// What the person did with it, for the agent's next work.
pub(crate) fn change(title: &str, state: &Value) -> Option<String> {
    (state.get("connected").and_then(Value::as_bool) == Some(true)).then(|| {
        format!("Connected {title}, which you suggested, and gave it to you: its calls are yours.")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent_given(tool: &str) -> AgentConfig {
        serde_yaml::from_str(&format!(
            "id: coby\nname: Coby\nrole: Help.\nmodel: fake/offline\ncapabilities:\n  - kind: tool\n    name: {tool}\n"
        ))
        .expect("an agent")
    }

    #[test]
    fn a_suggestion_is_read_and_spelled_as_the_list_spells_it() {
        let widget = read(&json!({"tool": "  notion "})).expect("a suggestion");
        assert_eq!(
            widget,
            Widget::Connect {
                title: "Notion".to_owned()
            }
        );
        assert_eq!(widget.kind(), "connect");
        // A name the list doesn't have is kept as written, for a tool the agent was given.
        assert_eq!(
            read(&json!({"tool": "Acme   CRM"})).expect("kept").title(),
            "Acme CRM"
        );
        for (arguments, says) in [
            (json!({}), "name the tool"),
            (json!({"tool": "  "}), "name the tool"),
            (json!({"tool": "x".repeat(NAME_CHARS + 1)}), "at most 40"),
        ] {
            let error = read(&arguments).expect_err("refused");
            assert!(error.contains(says), "{error}");
        }
    }

    #[test]
    fn only_a_tool_this_computer_lists_or_the_agent_was_given_is_suggested() {
        let notion = read(&json!({"tool": "Notion"})).expect("read");
        assert_eq!(check(&notion, None), Ok(()));
        // The Mac's own apps are listed only on a Mac, as Connections lists them.
        let calendar = read(&json!({"tool": "Apple Calendar"})).expect("read");
        assert_eq!(check(&calendar, None).is_ok(), cfg!(target_os = "macos"));
        let crm = read(&json!({"tool": "acme crm"})).expect("read");
        let refused = check(&crm, None).expect_err("not listed, not given");
        assert!(refused.contains("\"acme crm\" isn't a tool"), "{refused}");
        assert!(
            refused.contains("Notion"),
            "names what it may suggest: {refused}"
        );
        assert_eq!(check(&crm, Some(&agent_given("Acme CRM"))), Ok(()));
        let google = read(&json!({"tool": "Google Calendar"})).expect("read");
        assert!(check(&google, Some(&agent_given("Acme CRM"))).is_err());
    }

    #[test]
    fn the_tool_lists_what_it_may_suggest_and_the_agent_is_told_its_place() {
        let definition = tool_definition_listing(&["Apple Calendar", "Notion"]);
        let description = definition["description"].as_str().expect("words");
        assert!(
            description.starts_with(SUGGEST_TOOL.default_text()),
            "{description}"
        );
        assert!(
            description.contains("The tools you can suggest: Apple Calendar, Notion."),
            "{description}"
        );
        assert_eq!(definition["inputSchema"]["required"], json!(["tool"]));
        let told = suggested(
            &Widget::Connect {
                title: "Notion".to_owned(),
            },
            2,
        );
        assert_eq!(told["suggested"], "Notion");
        assert_eq!(told["place"], "{{widget 2}}");
    }

    #[test]
    fn being_connected_is_kept_and_told() {
        assert_eq!(
            read_state(&json!({"connected": true})),
            Ok(json!({"connected": true}))
        );
        assert!(read_state(&json!({"connected": false})).is_err());
        assert!(read_state(&json!({"dismissed": true})).is_err());
        assert_eq!(
            change("Apple Calendar", &json!({"connected": true})).as_deref(),
            Some(
                "Connected Apple Calendar, which you suggested, and gave it to you: its calls are yours."
            )
        );
        assert_eq!(change("Apple Calendar", &json!({})), None);
    }
}
