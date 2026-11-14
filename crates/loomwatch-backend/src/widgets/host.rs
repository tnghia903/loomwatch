//! `show_widget` for an agent answering in the chat without starting work (ADR 0114): a quick
//! question answered in one turn, such as "what is nDCG". The turn has no Team Bus, so the daemon
//! serves the tool itself, as one of its own tools, and keeps what it shows for the answer. So it
//! does `suggest_skill` (ADR 0118) and `suggest_tool` (ADR 0126), which an agent has whether its
//! widgets switch is on or not.

use std::sync::{Arc, Mutex, PoisonError};

use serde_json::Value;

use super::{MOST_PER_ANSWER, Shown, TOOL, connect, read, shown, skill, tool_definition};
use crate::agent::{BoxFuture, HostTools, ToolSpec};
use crate::config::AgentConfig;

/// The widgets one agent shows in one answer in the chat, numbered from 1 in the order shown, and
/// the skills and tools it suggests there.
#[derive(Default)]
pub(crate) struct WidgetTools {
    shown: Mutex<Vec<Shown>>,
    /// Its widgets switch: off, it may still suggest a skill or a tool.
    widgets: bool,
    /// The agent answering, whose tools it was given it may suggest connecting.
    agent: Option<AgentConfig>,
}

impl WidgetTools {
    pub(crate) fn new(widgets: bool, agent: Option<AgentConfig>) -> Arc<Self> {
        Arc::new(Self {
            shown: Mutex::default(),
            widgets,
            agent,
        })
    }

    /// What it showed, the last [`MOST_PER_ANSWER`], each with its place number.
    pub(crate) fn taken(&self) -> Vec<Shown> {
        let mut shown =
            std::mem::take(&mut *self.shown.lock().unwrap_or_else(PoisonError::into_inner));
        let extra = shown.len().saturating_sub(MOST_PER_ANSWER);
        shown.drain(..extra);
        shown
    }
}

impl HostTools for WidgetTools {
    fn specs(&self) -> Vec<ToolSpec> {
        let spec = |tool: Value| ToolSpec {
            name: tool["name"].as_str().unwrap_or_default().to_owned(),
            description: tool["description"].as_str().unwrap_or_default().to_owned(),
            parameters: tool["inputSchema"].clone(),
        };
        let mut specs = Vec::new();
        if self.widgets {
            specs.push(spec(tool_definition()));
        }
        specs.push(spec(skill::tool_definition()));
        specs.push(spec(connect::tool_definition()));
        specs
    }

    fn call<'a>(&'a self, name: &'a str, input: Value) -> BoxFuture<'a, (String, bool)> {
        Box::pin(async move {
            if name == skill::TOOL {
                return match skill::read(&input) {
                    Ok(widget) => {
                        let told = skill::suggested(&widget);
                        // Under the answer's words, where nothing placed it.
                        self.shown
                            .lock()
                            .unwrap_or_else(PoisonError::into_inner)
                            .push(Shown {
                                place: None,
                                widget,
                            });
                        (told.to_string(), false)
                    }
                    Err(error) => (format!("It isn't suggested: {error}."), true),
                };
            }
            if name == connect::TOOL {
                return match connect::read(&input).and_then(|widget| {
                    connect::check(&widget, self.agent.as_ref()).map(|()| widget)
                }) {
                    Ok(widget) => {
                        let mut all = self.shown.lock().unwrap_or_else(PoisonError::into_inner);
                        let place = u32::try_from(all.len() + 1).unwrap_or(u32::MAX);
                        let told = connect::suggested(&widget, place);
                        all.push(Shown {
                            place: Some(place),
                            widget,
                        });
                        (told.to_string(), false)
                    }
                    Err(error) => (format!("It isn't suggested: {error}."), true),
                };
            }
            if name != TOOL || !self.widgets {
                return (format!("There's no tool called {name}."), true);
            }
            match read(&input) {
                Ok(widget) => {
                    let mut all = self.shown.lock().unwrap_or_else(PoisonError::into_inner);
                    let place = u32::try_from(all.len() + 1).unwrap_or(u32::MAX);
                    let told = shown(&widget, place);
                    all.push(Shown {
                        place: Some(place),
                        widget,
                    });
                    (told.to_string(), false)
                }
                Err(error) => (format!("It isn't shown: {error}."), true),
            }
        })
    }
}

/// The key a chat answer's widgets are kept under, beside runs' in the `widgets` table: the
/// message answered and the agent that answered it.
pub(crate) fn note_key(message_id: &str, agent: &str) -> String {
    format!("note:{message_id}:{agent}")
}
