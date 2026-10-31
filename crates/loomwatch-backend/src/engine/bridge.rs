//! What joins a built-in agent's session to its run: where its events go, who answers its
//! permission requests, and the daemon's own tools it can call.
//!
//! Events and permission records go down one channel to the engine, which writes them to the run's
//! record in the order they happened. The record is written while the turn is still running, so
//! the app shows the agent working, and shows a permission card while the agent waits on it.

use std::sync::Arc;

use serde_json::{Value, json};
use tokio::sync::mpsc::UnboundedSender;

use crate::agent::{
    BoxFuture, Decision, EventSink, Go, HostAsk, HostTools, PermissionRequest, Permissions, Spend,
    ToolSpec, Usage,
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
/// (ADR 0061) and, when those don't decide, the operator (ADR 0040). The operator may also change
/// a command before allowing it, or answer in the agent's place: the agent then runs the changed
/// command, or reads the answer as what the tool returned.
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
                self.record(&message, &request.tool_call_id, "deny");
                return Decision::Deny;
            };
            if policy.approves(&message) {
                return Decision::Allow;
            }
            if policy.reaches_key(&message) {
                // Not asked: no answer may hand the key to a model.
                self.record(&message, &request.tool_call_id, "deny");
                return Decision::Deny;
            }
            let outcome = match &self.asker {
                Some(asker) => self.ask(asker, &message, policy).await,
                None => AskOutcome::NotAsked,
            };
            let decision = match &outcome {
                AskOutcome::Edited(command) => {
                    crate::permissions::edited_input(&message, &request.input, command)
                        .map_or(Decision::Deny, Decision::AllowEdited)
                }
                AskOutcome::AnsweredInstead(answer) => Decision::Answer(answer.clone()),
                other if other.allows() => Decision::Allow,
                _ => Decision::Deny,
            };
            let option = match &decision {
                Decision::Allow | Decision::AllowEdited(_) => "allow",
                Decision::Answer(_) => "answer",
                Decision::Deny => "deny",
            };
            self.record(&message, &request.tool_call_id, option);
            decision
        })
    }
}

/// Holds a session to its run's spool (ADR 0068). Each call's cost goes on the run record; before
/// each call, an agent whose run (or whose own guard) is used up waits at the run's spend stop
/// until the operator adds money or finishes. A routine's run waits the same way until its stop's
/// deadline, then finishes with what it has (ADR 0090).
///
/// The agent that opens a stop records it, and how it was answered, as `session_meta` notes
/// (`awaiting_spend`, `spend_answered`, `spend_stopped`), so the chat and the receipt can say what
/// happened. The others wait at the same stop without a record of their own.
pub(crate) struct SpoolGate {
    pub(crate) asker: PermissionAsker,
    pub(crate) records: UnboundedSender<Record>,
}

impl Spend for SpoolGate {
    fn before_call(&self) -> BoxFuture<'_, Go> {
        use crate::spend::Gate;
        Box::pin(async move {
            loop {
                match self.asker.spend_gate() {
                    Gate::Ahead => return Go::Ahead,
                    Gate::Stop { first } => {
                        if let Some(stop) = first {
                            self.note(spend_note("spend_stopped", &stop, |note| {
                                note["reason"] = json!("nobody_to_ask");
                            }));
                        }
                        return Go::Stop;
                    }
                    Gate::Wait {
                        stop,
                        opened,
                        mut answer,
                    } => {
                        if opened {
                            self.note(spend_note("awaiting_spend", &stop, |_| {}));
                        }
                        let deadline = stop.expires_at.as_deref().and_then(crate::deadline::parse);
                        // Closed rather than answered when the run ends while it waits. In a
                        // routine's run, nobody answering by the deadline finishes it (ADR 0090).
                        let waited = tokio::select! {
                            answered = async {
                                answer
                                    .wait_for(Option::is_some)
                                    .await
                                    .ok()
                                    .and_then(|answered| *answered)
                            } => Some(answered),
                            () = crate::deadline::passed_if_any(deadline) => None,
                        };
                        let Some(answered) = waited else {
                            if self.asker.finish_unanswered_spend(&stop.id).await && opened {
                                self.note(spend_note("spend_answered", &stop, |note| {
                                    note["decision"] = json!(crate::spend::SpendDecision::Finish);
                                    note["reason"] = json!("no_answer");
                                }));
                            }
                            continue;
                        };
                        if opened && let Some(answered) = answered {
                            self.note(spend_note("spend_answered", &stop, |note| {
                                note["decision"] = json!(answered.decision);
                                note["limitUsd"] = json!(answered.limit_usd);
                                if let Some(add) = answered.add_usd {
                                    note["addedUsd"] = json!(add);
                                }
                            }));
                        }
                        // Look again: money added lets the call go ahead, while a finish, or a run
                        // that ended, stops it.
                    }
                }
            }
        })
    }

    fn spent(&self, usage: &Usage) {
        self.asker.count_spend(usage.cost_usd);
    }
}

impl SpoolGate {
    fn note(&self, payload: Value) {
        let _ = self.records.send(Record::Meta(payload));
    }
}

/// A `session_meta` note about a spend stop: whose limit, what it was, what was spent, what "Add"
/// offers.
fn spend_note(
    phase: &str,
    stop: &crate::spend::SpendStop,
    extra: impl FnOnce(&mut Value),
) -> Value {
    let mut note = json!({
        "phase": phase,
        "stopId": stop.id,
        "scope": if stop.agent.is_some() { "agent" } else { "team" },
        "limitUsd": stop.limit_usd,
        "spentUsd": stop.spent_usd,
        "addUsd": stop.add_usd,
    });
    if let Some(agent) = &stop.agent {
        note["agent"] = json!(agent);
    }
    extra(&mut note);
    note
}

impl PolicyGate {
    /// Records which of the request's options was chosen: `allow` (as asked, or changed),
    /// `answer` (the operator answered in the agent's place), or `deny`.
    fn record(&self, message: &Value, tool_call_id: &str, option: &str) {
        let response = json!({
            "jsonrpc": "2.0",
            "id": tool_call_id,
            "result": {"outcome": {"outcome": "selected", "optionId": option}},
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
    /// it was answered: by the person, the clock, Auto mode, or nobody — a run that has already
    /// ended has nobody to ask and declines at once (`not_asked`). A routine's run asks and waits
    /// (ADR 0090).
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
                "tool": open.request.tool,
                "detail": open.request.detail,
                "expiresAt": open.request.expires_at,
                "autoNote": open.request.auto,
            }));
            (open.wait().await, Some(request_id))
        } else {
            (AskOutcome::NotAsked, None)
        };
        let mut answered = json!({
            "phase": "permission_answered",
            "requestId": request_id,
            "title": title,
            "kind": kind,
            "outcome": outcome.as_str(),
            "allowed": outcome.allows(),
            "detail": detail,
            "autoNote": auto_note,
        });
        // What the operator wrote, so the team's chat can say what was run, or what the agent was told.
        match &outcome {
            AskOutcome::Edited(command) => answered["edited"] = json!(command),
            AskOutcome::AnsweredInstead(answer) => answered["answer"] = json!(answer),
            _ => {}
        }
        self.note(answered);
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
    /// `conversation` says the agent's opening message holds `## Conversation so far`.
    pub(crate) fn new(connection: TeamBusConnection, conversation: bool) -> Self {
        let specs = connection
            .tool_definitions(conversation)
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

/// Several kinds of daemon tools served as one: the Team Bus and the tools the operator connected
/// (ADR 0069). A name belongs to the first that offers it.
pub(crate) struct CombinedTools(pub(crate) Vec<Arc<dyn HostTools>>);

impl CombinedTools {
    fn owner(&self, name: &str) -> Option<&Arc<dyn HostTools>> {
        self.0
            .iter()
            .find(|host| host.specs().iter().any(|spec| spec.name == name))
    }
}

impl HostTools for CombinedTools {
    fn specs(&self) -> Vec<ToolSpec> {
        let mut specs: Vec<ToolSpec> = Vec::new();
        for spec in self.0.iter().flat_map(|host| host.specs()) {
            if !specs.iter().any(|known| known.name == spec.name) {
                specs.push(spec);
            }
        }
        specs
    }

    fn records_own_calls(&self, name: &str) -> bool {
        self.owner(name)
            .is_some_and(|host| host.records_own_calls(name))
    }

    fn asks(&self, name: &str) -> Option<HostAsk> {
        self.owner(name).and_then(|host| host.asks(name))
    }

    fn call<'a>(&'a self, name: &'a str, input: Value) -> BoxFuture<'a, (String, bool)> {
        match self.owner(name) {
            Some(host) => host.call(name, input),
            None => Box::pin(async move { (format!("There's no tool called {name}."), true) }),
        }
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

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::time::Duration;

    use serde_json::json;
    use tokio::sync::mpsc;

    use super::{PolicyGate, Record};
    use crate::agent::{Decision, PermissionRequest, Permissions, ToolKind};
    use crate::config::{AgentAllow, TeamConfig};
    use crate::permissions::{PermissionAsker, PermissionDecision, PermissionPolicy};
    use crate::runs::{RunRecord, RunRegistry, RunTrigger};

    /// A person-started run whose one agent may do nothing without asking, and its gate.
    fn gate() -> (
        PolicyGate,
        RunRegistry,
        String,
        mpsc::UnboundedReceiver<Record>,
    ) {
        gate_for(RunTrigger::Manual, None)
    }

    /// [`gate`] for a run started by `trigger`, waiting `wait_for_you` for the person, as `launch`
    /// fixes it for a routine's run (ADR 0090).
    fn gate_for(
        trigger: RunTrigger,
        wait_for_you: Option<chrono::Duration>,
    ) -> (
        PolicyGate,
        RunRegistry,
        String,
        mpsc::UnboundedReceiver<Record>,
    ) {
        let team = TeamConfig::parse(
            "schemaVersion: 1\nentrypoint: a\nspend:\n  perRun: 0.05\nagents:\n  - id: a\n    name: Builder\n    role: Build it.\n    model: m\n",
        )
        .unwrap();
        let registry = RunRegistry::default();
        let mut record = RunRecord::queued("t.yaml".into(), "go".into(), &team, trigger).unwrap();
        record.wait_for_you = wait_for_you;
        let run_id = record.run_id.clone();
        registry.insert(record);
        let desk = crate::operator::OperatorDesk::new(registry.clone(), None);
        let (records, received) = mpsc::unbounded_channel();
        let gate = PolicyGate {
            policy: Some(PermissionPolicy::new(
                AgentAllow::default(),
                Path::new("/tmp/loomwatch-bridge-test"),
                [],
                [],
            )),
            asker: Some(PermissionAsker::new(desk, &run_id, "a", "Builder")),
            records,
        };
        (gate, registry, run_id, received)
    }

    fn command(text: &str) -> PermissionRequest {
        PermissionRequest {
            session_id: "s".to_owned(),
            tool_call_id: "call-1".to_owned(),
            title: format!("Run: {text}"),
            kind: ToolKind::Execute,
            input: json!({"command": text, "timeout_seconds": 30}),
            locations: Vec::new(),
        }
    }

    /// Answers the run's one waiting request, once the gate has put it on the record.
    async fn answer(
        registry: &RunRegistry,
        run_id: &str,
        decision: PermissionDecision,
        text: &str,
    ) {
        for _ in 0..200 {
            let waiting = registry.get(run_id).unwrap().permission_requests;
            if let Some(request) = waiting.first() {
                registry
                    .answer_permission(run_id, &request.id, decision, Some(text))
                    .unwrap();
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("the gate never asked");
    }

    /// The run's note of the answer, and the option the recorded permission response chose.
    fn answered(received: &mut mpsc::UnboundedReceiver<Record>) -> (serde_json::Value, String) {
        let (mut note, mut option) = (None, None);
        while let Ok(record) = received.try_recv() {
            match record {
                Record::Meta(payload) if payload["phase"] == "permission_answered" => {
                    note = Some(payload);
                }
                Record::Permission { response, .. } => {
                    option = response["result"]["outcome"]["optionId"]
                        .as_str()
                        .map(str::to_owned);
                }
                _ => {}
            }
        }
        (
            note.expect("the answer is recorded"),
            option.expect("the response is recorded"),
        )
    }

    /// "Edit, then allow": the agent runs the command as the operator changed it, its other
    /// arguments kept, and the run records what was run.
    #[tokio::test]
    async fn a_command_changed_on_the_card_is_the_one_that_runs() {
        let (gate, registry, run_id, mut received) = gate();
        let request = command("rm -rf build");
        let (decision, ()) = tokio::join!(
            gate.request(&request),
            answer(
                &registry,
                &run_id,
                PermissionDecision::Edit,
                " rm -rf build/tmp "
            ),
        );
        assert_eq!(
            decision,
            Decision::AllowEdited(json!({"command": "rm -rf build/tmp", "timeout_seconds": 30}))
        );
        let (note, option) = answered(&mut received);
        assert_eq!(option, "allow");
        assert_eq!(note["outcome"], "edited");
        assert_eq!(note["allowed"], true);
        assert_eq!(note["edited"], "rm -rf build/tmp");
    }

    /// "Answer instead": nothing runs, and the agent reads the operator's words as the result.
    #[tokio::test]
    async fn an_answer_in_the_agents_place_goes_back_as_the_result() {
        let (gate, registry, run_id, mut received) = gate();
        let request = command("curl https://example.com/feed");
        let (decision, ()) = tokio::join!(
            gate.request(&request),
            answer(
                &registry,
                &run_id,
                PermissionDecision::Answer,
                "Use the feed in notes.md instead."
            ),
        );
        assert_eq!(
            decision,
            Decision::Answer("Use the feed in notes.md instead.".to_owned())
        );
        let (note, option) = answered(&mut received);
        // Its own option, so the receipt tells an answer from a refusal.
        assert_eq!(option, "answer");
        assert_eq!(note["outcome"], "answered");
        assert_eq!(note["allowed"], false);
        assert_eq!(note["answer"], "Use the feed in notes.md instead.");
    }

    /// ADR 0090: a routine's run asks too, and its request waits for the person by its own
    /// deadline, not the ten minutes a run someone just started waits. Nobody answering by then
    /// declines it, by the wall clock.
    #[tokio::test]
    async fn a_routines_request_waits_for_you_then_is_declined_by_its_deadline() {
        let wait = chrono::Duration::milliseconds(300);
        let (gate, registry, run_id, mut received) = gate_for(RunTrigger::Schedule, Some(wait));
        let request = command("npm test");
        let waiting = async {
            for _ in 0..200 {
                if let Some(open) = registry.get(&run_id).unwrap().permission_requests.first() {
                    return open.clone();
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            panic!("a routine's run never asked");
        };
        let (decision, open) = tokio::time::timeout(Duration::from_secs(5), async {
            tokio::join!(gate.request(&request), waiting)
        })
        .await
        .expect("declined by its deadline, not after ten minutes");
        let since = crate::deadline::parse(&open.since).unwrap();
        let expires = crate::deadline::parse(&open.expires_at).unwrap();
        assert_eq!(expires - since, wait, "the routine's own wait");
        assert_eq!(decision, Decision::Deny);
        assert!(
            registry
                .get(&run_id)
                .unwrap()
                .permission_requests
                .is_empty()
        );
        let (note, _) = answered(&mut received);
        assert_eq!(note["outcome"], "timed_out");
    }

    /// ADR 0090: at its spool a routine's run waits for the person like any other, and when
    /// nobody answers by the stop's deadline the team finishes with what it has, never spending
    /// more; the run's record says nobody answered.
    #[tokio::test]
    async fn a_routine_finishes_at_its_spool_when_nobody_answers_in_time() {
        let wait = chrono::Duration::milliseconds(300);
        let (_, registry, run_id, _) = gate_for(RunTrigger::Schedule, Some(wait));
        registry.count_spend(&run_id, "a", 0.06);
        let desk = crate::operator::OperatorDesk::new(registry.clone(), None);
        let (records, mut received) = mpsc::unbounded_channel();
        let spool = super::SpoolGate {
            asker: PermissionAsker::new(desk, &run_id, "a", "Builder"),
            records,
        };
        let opened = async {
            for _ in 0..200 {
                if let Some(stop) = registry.get(&run_id).unwrap().spend_stops.first() {
                    return stop.clone();
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            panic!("a routine's run never waited at its spool");
        };
        let (go, stop) = tokio::time::timeout(Duration::from_secs(5), async {
            tokio::join!(crate::agent::Spend::before_call(&spool), opened)
        })
        .await
        .expect("finished by its deadline");
        let since = crate::deadline::parse(&stop.since).unwrap();
        let expires = crate::deadline::parse(stop.expires_at.as_deref().unwrap()).unwrap();
        assert!((expires - since - wait).num_milliseconds().abs() < 1000);
        assert!(matches!(go, crate::agent::Go::Stop), "no more calls");
        assert_eq!(
            registry.spend_stopped(&run_id).map(|stopped| stopped.cause),
            Some(crate::spend::Stopped::NoAnswer),
            "the receipt says nobody answered, not that you finished it"
        );
        let mut answered = None;
        while let Ok(record) = received.try_recv() {
            if let Record::Meta(payload) = record
                && payload["phase"] == "spend_answered"
            {
                answered = Some(payload);
            }
        }
        let answered = answered.expect("how the stop ended is recorded");
        assert_eq!(answered["decision"], "finish");
        assert_eq!(answered["reason"], "no_answer");
    }
}
