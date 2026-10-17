//! What joins a built-in agent's session to its run: where its events go, who answers its
//! permission requests, and the daemon's own tools it can call.
//!
//! Events and permission records go down one channel to the engine, which writes them to the run's
//! record in the order they happened. The record is written while the turn is still running, so
//! the app shows the agent working, and shows a permission card while the agent waits on it.

use serde_json::{Value, json};
use tokio::sync::mpsc::UnboundedSender;

use crate::agent::{
    BoxFuture, Decision, EventSink, HostTools, PermissionRequest, Permissions, ToolSpec,
};
use crate::permissions::{AskOutcome, PermissionAsker, PermissionPolicy};
use crate::team_bus::TeamBusConnection;

/// One thing for the run's record.
#[derive(Debug)]
pub(crate) enum Record {
    /// An update in the archive's `session/update` shape.
    Update(Value),
    /// A `session_meta` note of `LoomWatch`'s own, such as "waiting for the operator".
    Meta(Value),
    /// A permission request and how it was answered.
    Permission { request: Value, response: Value },
}

/// Sends a session's updates to the engine.
pub(crate) struct ChannelSink(pub(crate) UnboundedSender<Record>);

impl EventSink for ChannelSink {
    fn update(&self, update: Value) -> BoxFuture<'_, anyhow::Result<()>> {
        let sent = self.0.send(Record::Update(update));
        Box::pin(async move {
            sent.map_err(|_| anyhow::anyhow!("the run stopped recording this agent"))
        })
    }
}

/// Answers a session's permission requests with the run agent's policy (ADR 0037), Auto mode
/// (ADR 0061) and, when those don't decide, the operator (ADR 0040).
///
/// What the policy approves on its own — reading inside the agent's folder, a web fetch with the
/// web switched on — is approved without a record, as an app's own settings approved it before.
/// Everything else is recorded with its answer, so the run says who decided.
pub(crate) struct PolicyGate {
    pub(crate) policy: Option<PermissionPolicy>,
    pub(crate) asker: Option<PermissionAsker>,
    pub(crate) records: UnboundedSender<Record>,
}

impl Permissions for PolicyGate {
    fn request<'a>(&'a self, request: &'a PermissionRequest) -> BoxFuture<'a, Decision> {
        Box::pin(async move {
            let message = request.as_message();
            let Some(policy) = &self.policy else {
                // An agent with no policy (Ask, a one-turn helper) is offered no tool that asks.
                self.record(&message, &request.tool_call_id, false);
                return Decision::Deny;
            };
            if policy.approves(&message) {
                return Decision::Allow;
            }
            let outcome = match &self.asker {
                Some(asker) => self.ask(asker, &message, policy).await,
                None => AskOutcome::NotAsked,
            };
            let allowed = outcome.allows();
            self.record(&message, &request.tool_call_id, allowed);
            if allowed {
                Decision::Allow
            } else {
                Decision::Deny
            }
        })
    }
}

impl PolicyGate {
    fn record(&self, message: &Value, tool_call_id: &str, allowed: bool) {
        let response = json!({
            "jsonrpc": "2.0",
            "id": tool_call_id,
            "result": {"outcome": {"outcome": "selected", "optionId": if allowed { "allow" } else { "deny" }}},
        });
        let _ = self.records.send(Record::Permission {
            request: message.clone(),
            response,
        });
    }

    fn note(&self, payload: Value) {
        let _ = self.records.send(Record::Meta(payload));
    }

    /// Puts a request the policy declined to the operator, and records that it was asked and how
    /// it was answered: by the person, the clock, Auto mode, or nobody — a routine's run has
    /// nobody to ask and declines at once (`not_asked`).
    async fn ask(
        &self,
        asker: &PermissionAsker,
        request: &Value,
        policy: &PermissionPolicy,
    ) -> AskOutcome {
        use crate::auto_mode::Verdict;
        let (title, kind, detail) = crate::permissions::describe(request);
        let allowed_for_run = asker.allowed_for_run(request);
        let verdict = if allowed_for_run {
            None
        } else {
            asker.auto(request, policy)
        };
        let auto_note = match &verdict {
            Some(Verdict::Undecided(why)) => Some(why.clone()),
            _ => None,
        };
        let (outcome, request_id) = if allowed_for_run {
            (AskOutcome::AllowedForRun, None)
        } else if verdict == Some(Verdict::Approved) {
            (AskOutcome::AutoApproved, None)
        } else if let Some(open) = asker.open(request, auto_note.clone()) {
            let request_id = open.request.id.clone();
            // What the card asks, recorded whole, so the team's chat can show the ask after the
            // live request is gone (ADR 0051).
            self.note(json!({
                "phase": "awaiting_permission",
                "requestId": request_id,
                "title": title,
                "kind": kind,
                "switch": open.request.switch,
                "detail": open.request.detail,
                "expiresAt": open.request.expires_at,
                "autoNote": open.request.auto,
            }));
            (open.wait().await, Some(request_id))
        } else {
            (AskOutcome::NotAsked, None)
        };
        self.note(json!({
            "phase": "permission_answered",
            "requestId": request_id,
            "title": title,
            "kind": kind,
            "outcome": outcome.as_str(),
            "allowed": outcome.allows(),
            "detail": detail,
            "autoNote": auto_note,
        }));
        outcome
    }
}

/// The Team Bus, as tools of the agent behind one connection. The bus records its own calls
/// ("Team Bus: ask" and so on): the delegation graph is built from them.
pub(crate) struct BusTools {
    connection: TeamBusConnection,
    specs: Vec<ToolSpec>,
}

impl BusTools {
    pub(crate) fn new(connection: TeamBusConnection) -> Self {
        let specs = connection
            .tool_definitions()
            .iter()
            .filter_map(tool_spec)
            .collect();
        Self { connection, specs }
    }
}

impl HostTools for BusTools {
    fn specs(&self) -> Vec<ToolSpec> {
        self.specs.clone()
    }

    fn records_own_calls(&self, _name: &str) -> bool {
        true
    }

    fn call<'a>(&'a self, name: &'a str, input: Value) -> BoxFuture<'a, (String, bool)> {
        Box::pin(async move { tool_answer(&self.connection.call(name, input).await) })
    }
}

/// A tool definition `{name, description, inputSchema}` as the agent offers it.
pub(crate) fn tool_spec(definition: &Value) -> Option<ToolSpec> {
    Some(ToolSpec {
        name: definition.get("name")?.as_str()?.to_owned(),
        description: definition
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        parameters: definition
            .get("inputSchema")
            .cloned()
            .unwrap_or_else(|| json!({"type": "object"})),
    })
}

/// A tool answer `{content: [{type: text, text}], isError}` as text, and whether it failed.
pub(crate) fn tool_answer(result: &Value) -> (String, bool) {
    let text = result
        .get("content")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| result.to_string());
    let failed = result
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    (text, failed)
}
