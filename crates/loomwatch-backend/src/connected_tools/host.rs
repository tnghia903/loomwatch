//! The calls of the tools an agent was given, as tools of its session.
//!
//! Each is offered as `<tool>__<call>` (`linear__create_issue`), described as its server
//! describes it. Opening the session makes no network call: the calls are the ones listed when the
//! tool was last checked. The first call opens a session with the tool's server, which the rest of
//! the agent's session reuses. Every call asks the operator first ([`HostTools::asks`]) unless the
//! operator always allows it for this agent.
use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{Value, json};
use tokio::sync::Mutex;

use super::client::{self, Session};
use super::{Auth, ConnectedTool, ToolCall, Tools, slug};
use crate::agent::{BoxFuture, HostAsk, HostTools, ToolSpec};
use crate::mac_apps::{self, App};

/// The longest a function name may be, for the providers' sake.
const MAX_FUNCTION_CHARS: usize = 64;

pub(crate) struct OutsideTools {
    tools: Tools,
    given: Vec<Given>,
    specs: Vec<ToolSpec>,
    /// Each function name offered: which tool, and which of its calls.
    calls: HashMap<String, Offered>,
}

struct Given {
    tool: ConnectedTool,
    /// Open after the first call, until the agent's session ends.
    session: Mutex<Option<Arc<Session>>>,
}

struct Offered {
    given: usize,
    call: String,
    title: String,
    cant_undo: bool,
}

/// The Mac app `tool` is, when it is one (ADR 0121).
fn mac_app(tool: &ConnectedTool) -> Option<App> {
    (tool.auth == Auth::OnThisMac)
        .then(|| App::at(&tool.url))
        .flatten()
}

/// Whether `tool` is Apple Health, read from what a paired iPhone sent (ADR 0121).
fn is_health(tool: &ConnectedTool) -> bool {
    tool.auth == Auth::FromPhone && tool.url == crate::health::URL
}

/// What `tool` offers: a Mac app's or Apple Health's own list, which `tools.json` can't change, or
/// what its server listed when last checked.
fn offered_calls(tool: &ConnectedTool) -> Vec<ToolCall> {
    if is_health(tool) {
        return crate::health::calls();
    }
    mac_app(tool).map_or_else(|| tool.calls.clone(), App::calls)
}

impl OutsideTools {
    /// The calls of `given`, the connected tools an agent was given.
    pub(crate) fn new(tools: Tools, given: Vec<ConnectedTool>) -> Self {
        let mut specs = Vec::new();
        let mut calls = HashMap::new();
        let mut slugs: Vec<String> = Vec::new();
        for (index, tool) in given.iter().enumerate() {
            let mut prefix = slug(&tool.name);
            if slugs.contains(&prefix) {
                prefix = format!("{prefix}_{}", index + 1);
            }
            slugs.push(prefix.clone());
            for call in &offered_calls(tool) {
                let name = function_name(&prefix, &call.name);
                if calls.contains_key(&name) {
                    continue;
                }
                let description = if call.description.is_empty() {
                    format!("From {}: {}.", tool.name, call.label())
                } else {
                    format!("From {}: {}", tool.name, call.description)
                };
                specs.push(ToolSpec {
                    name: name.clone(),
                    description,
                    parameters: parameters(&call.input_schema),
                });
                calls.insert(
                    name,
                    Offered {
                        given: index,
                        call: call.name.clone(),
                        title: format!("{}: {}", tool.name, sentence_case(&call.label())),
                        cant_undo: call.cant_undo,
                    },
                );
            }
        }
        Self {
            tools,
            given: given
                .into_iter()
                .map(|tool| Given {
                    tool,
                    session: Mutex::new(None),
                })
                .collect(),
            specs,
            calls,
        }
    }

    /// The session with tool `index`'s server, opened on first use.
    async fn session(&self, index: usize) -> Result<Arc<Session>, String> {
        let given = &self.given[index];
        let mut open = given.session.lock().await;
        if let Some(session) = open.as_ref() {
            return Ok(session.clone());
        }
        match client::open(&self.tools, &given.tool).await {
            Ok(session) => {
                let session = Arc::new(session);
                *open = Some(session.clone());
                if given.tool.problem.is_some() {
                    self.tools.note(&given.tool.id, Ok(None)).await;
                }
                Ok(session)
            }
            Err(said) => {
                self.tools.note(&given.tool.id, Err(&said)).await;
                Err(said)
            }
        }
    }
}

impl HostTools for OutsideTools {
    fn specs(&self) -> Vec<ToolSpec> {
        self.specs.clone()
    }

    fn asks(&self, name: &str) -> Option<HostAsk> {
        let offered = self.calls.get(name)?;
        Some(HostAsk {
            title: offered.title.clone(),
            server: self.given[offered.given].tool.name.clone(),
            call: offered.call.clone(),
            cant_undo: offered.cant_undo,
        })
    }

    fn call<'a>(&'a self, name: &'a str, input: Value) -> BoxFuture<'a, (String, bool)> {
        Box::pin(async move {
            let Some(offered) = self.calls.get(name) else {
                return (format!("There's no tool called {name}."), true);
            };
            let given = &self.given[offered.given].tool;
            if is_health(given) {
                return match crate::health::installed() {
                    Some(health) => health.call(&offered.call, &input).await,
                    None => (
                        "Apple Health's readings can't be read right now.".to_owned(),
                        true,
                    ),
                };
            }
            if let Some(app) = mac_app(given) {
                // A Mac app's action runs here, never through a server (ADR 0121).
                let answer = self.tools.mac().call(app, &offered.call, input).await;
                return mac_apps::for_the_agent(answer);
            }
            let tool = &given.name;
            match self.session(offered.given).await {
                Ok(session) => client::call(&session, tool, &offered.call, input).await,
                Err(said) => (said, true),
            }
        })
    }
}

/// `<prefix>__<call>`, with anything a provider refuses in a function name made `_`, cut to
/// [`MAX_FUNCTION_CHARS`].
fn function_name(prefix: &str, call: &str) -> String {
    let call: String = call
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("{prefix}__{call}")
        .chars()
        .take(MAX_FUNCTION_CHARS)
        .collect()
}

/// A call's argument schema as a provider accepts one: an object schema.
fn parameters(schema: &Value) -> Value {
    match schema {
        Value::Object(fields) if fields.get("type").and_then(Value::as_str) == Some("object") => {
            schema.clone()
        }
        Value::Object(fields) if !fields.contains_key("type") => {
            let mut schema = fields.clone();
            schema.insert("type".to_owned(), json!("object"));
            Value::Object(schema)
        }
        _ => json!({"type": "object"}),
    }
}

/// "create issue" → "Create issue".
fn sentence_case(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map_or_else(String::new, |first| {
        first.to_uppercase().chain(chars).collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connected_tools::{Auth, ToolCall};

    fn tool(name: &str, calls: &[&str]) -> ConnectedTool {
        ConnectedTool {
            id: format!("id-{name}"),
            name: name.to_owned(),
            url: format!("https://mcp.{}.test/mcp", name.to_lowercase()),
            auth: Auth::None,
            calls: calls
                .iter()
                .map(|call| ToolCall {
                    name: (*call).to_owned(),
                    title: None,
                    description: String::new(),
                    input_schema: json!({"properties": {"q": {"type": "string"}}}),
                    read_only: false,
                    cant_undo: false,
                })
                .collect(),
            checked_at: None,
            metadata: None,
            pending: false,
            problem: None,
        }
    }

    #[test]
    fn offers_each_call_under_its_tools_name_and_asks_with_words() {
        let dir = std::env::temp_dir();
        let offered = OutsideTools::new(
            Tools::for_tests(&dir),
            vec![
                tool("Linear", &["create_issue", "list.teams"]),
                tool("Linear!", &["create_issue"]),
            ],
        );
        let names: Vec<String> = offered.specs().into_iter().map(|spec| spec.name).collect();
        assert_eq!(
            names,
            [
                "linear__create_issue",
                "linear__list_teams",
                "linear_2__create_issue"
            ]
        );
        let spec = &offered.specs()[0];
        assert_eq!(spec.description, "From Linear: Create issue.");
        assert_eq!(spec.parameters["type"], "object");
        let ask = offered.asks("linear__list_teams").expect("it asks");
        assert_eq!(ask.title, "Linear: List.teams");
        assert_eq!(
            (ask.server.as_str(), ask.call.as_str()),
            ("Linear", "list.teams")
        );
        assert!(offered.asks("write_file").is_none());
    }

    #[test]
    fn keeps_function_names_inside_what_providers_take() {
        let long = "a".repeat(80);
        let name = function_name("tool", &long);
        assert_eq!(name.len(), MAX_FUNCTION_CHARS);
        assert_eq!(function_name("x", "do it/now"), "x__do_it_now");
        assert_eq!(parameters(&json!("bad")), json!({"type": "object"}));
    }
}
