//! The agent pinned to the notch asks one of the person's teams to do part of what it was asked
//! (ADR 0083, decision 9). The person confirms each: nothing runs until they press Start.
//!
//! The agent's `ask_team` call (on the Team Bus, only for the pinned agent in its own chat)
//! records a request here as waiting and returns at once. The island at the notch lists the
//! requests (`GET /api/team-requests`) and answers one (`POST /api/team-requests/{id}`): Start
//! launches a run of that team exactly as the person starting it in `LoomWatch` would, and Not now
//! declines it. When a started run ends, its answer goes into the asking agent's own chat as a
//! message to it, through the chat's own send path, so it is archived and shown in its Chat tab
//! and the agent writes the person their answer.
//!
//! Requests live in memory, as the messages agents answer in the chat do (`chat::NotesAnswering`):
//! a restart clears them, and a finished one is kept for an hour.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::StatusCode;
use axum::middleware;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::api::ApiError;
use crate::archive::EventArchive;
use crate::runs::{
    LaunchError, RunAskedBy, RunRegistry, RunStatus, StartRunOutcome, StartRunRequest,
};
use crate::watch_api::local_evidence;

/// How long a finished request stays listed.
const KEEP: Duration = Duration::from_hours(1);
/// Requests one run may have waiting for the person at once.
pub(crate) const MAX_WAITING_PER_RUN: usize = 3;
/// How often a started request looks at its run, as a delivery does (`runs::deliver_when_finished`).
const POLL: Duration = Duration::from_millis(500);
/// The most of a team's answer the asking agent is handed.
const ANSWER_KEPT_CHARS: usize = 20_000;

/// Who asked: the run, the agent and the chat it asked from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AskedBy {
    pub(crate) run_id: String,
    pub(crate) agent: String,
    /// The agent's name, which the team's chat shows its request under.
    pub(crate) name: String,
    /// The asking agent's own chat team, relative to the teams root (`.jobs/.bench/<id>.yaml`).
    pub(crate) chat_path: String,
}

/// The team asked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TeamRef {
    /// Its file, relative to the teams root.
    pub(crate) path: String,
    pub(crate) name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Status {
    Waiting,
    Started,
    Declined,
    Done,
    Failed,
}

impl Status {
    const fn finished(self) -> bool {
        matches!(self, Self::Declined | Self::Done | Self::Failed)
    }
}

/// One request, as `GET /api/team-requests` lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TeamRequest {
    pub(crate) id: String,
    pub(crate) asked_by: AskedBy,
    pub(crate) team: TeamRef,
    pub(crate) request: String,
    pub(crate) status: Status,
    /// The team's run, once started.
    pub(crate) run_id: Option<String>,
    /// Why it could not start, or why the team stopped, in plain words.
    pub(crate) problem: Option<String>,
    pub(crate) created_at: DateTime<Utc>,
    pub(crate) finished_at: Option<DateTime<Utc>>,
}

/// Every request this daemon has, oldest first.
static REQUESTS: Mutex<Vec<TeamRequest>> = Mutex::new(Vec::new());

fn requests() -> std::sync::MutexGuard<'static, Vec<TeamRequest>> {
    REQUESTS.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Record that `asked_by` asks `team` to do `request`. Refused, with words for the agent, past
/// [`MAX_WAITING_PER_RUN`] requests waiting from one run.
pub(crate) fn ask(asked_by: AskedBy, team: TeamRef, request: &str) -> Result<TeamRequest, String> {
    let request = request.trim();
    if request.is_empty() {
        return Err("Say what the team should do: the request is empty.".to_owned());
    }
    let mut all = requests();
    let waiting = all
        .iter()
        .filter(|each| each.asked_by.run_id == asked_by.run_id && each.status == Status::Waiting)
        .count();
    if waiting >= MAX_WAITING_PER_RUN {
        return Err(format!(
            "{MAX_WAITING_PER_RUN} requests already wait for the person to press Start. Wait for \
             them, or do this part yourself."
        ));
    }
    let made = TeamRequest {
        id: Uuid::new_v4().to_string(),
        asked_by,
        team,
        request: request.to_owned(),
        status: Status::Waiting,
        run_id: None,
        problem: None,
        created_at: Utc::now(),
        finished_at: None,
    };
    all.push(made.clone());
    Ok(made)
}

/// The waiting and started requests, and those finished in the last `finished_within`, oldest
/// first. Anything finished longer ago than [`KEEP`] is forgotten here.
pub(crate) fn list(finished_within: Option<Duration>, now: DateTime<Utc>) -> Vec<TeamRequest> {
    let kept = |request: &TeamRequest, within: Duration| {
        request.finished_at.is_none_or(|finished| {
            now.signed_duration_since(finished)
                .to_std()
                .is_ok_and(|age| age <= within)
                || finished > now
        })
    };
    let mut all = requests();
    all.retain(|request| kept(request, KEEP));
    all.iter()
        .filter(|request| {
            !request.status.finished() || kept(request, finished_within.unwrap_or_default())
        })
        .cloned()
        .collect()
}

fn get_request(id: &str) -> Option<TeamRequest> {
    requests().iter().find(|request| request.id == id).cloned()
}

/// Change request `id` with `change`, and answer what it is now.
fn update(id: &str, change: impl FnOnce(&mut TeamRequest)) -> Option<TeamRequest> {
    let mut all = requests();
    let request = all.iter_mut().find(|request| request.id == id)?;
    change(request);
    Some(request.clone())
}

#[derive(Clone)]
struct TeamRequestsState {
    archive: Option<EventArchive>,
    teams_root: PathBuf,
    registry: RunRegistry,
}

/// `GET /api/team-requests` and `POST /api/team-requests/{id}`. Loopback and this origin only,
/// like run control.
pub fn router(archive: Option<EventArchive>, teams_root: PathBuf, registry: RunRegistry) -> Router {
    let teams_root = crate::platform::canonicalize(&teams_root).unwrap_or(teams_root);
    Router::new()
        .route("/api/team-requests", get(list_route))
        .route("/api/team-requests/{id}", post(answer_route))
        .route_layer(middleware::from_fn(local_evidence))
        .with_state(TeamRequestsState {
            archive,
            teams_root,
            registry,
        })
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListQuery {
    finished_within: Option<u64>,
}

async fn list_route(Query(query): Query<ListQuery>) -> Json<Vec<TeamRequest>> {
    Json(list(
        query.finished_within.map(Duration::from_secs),
        Utc::now(),
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Decision {
    Start,
    Decline,
}

#[derive(Debug, Deserialize)]
struct Answer {
    decision: Decision,
}

async fn answer_route(
    State(state): State<TeamRequestsState>,
    AxumPath(id): AxumPath<String>,
    Json(answer): Json<Answer>,
) -> Result<Json<TeamRequest>, ApiError> {
    // Taken under the lock, so a second press finds it no longer waiting.
    let mut taken = false;
    let request = update(&id, |request| {
        if request.status == Status::Waiting {
            taken = true;
            request.status = match answer.decision {
                Decision::Start => Status::Started,
                Decision::Decline => Status::Declined,
            };
            if matches!(answer.decision, Decision::Decline) {
                request.finished_at = Some(Utc::now());
            }
        }
    })
    .ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            "LoomWatch has no such request: it was answered or forgotten.".to_owned(),
        )
    })?;
    if !taken {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "This request was already answered.".to_owned(),
        ));
    }
    let request = match answer.decision {
        // Boxed: a run's start is a large future, and the route's would pass Clippy's limit.
        Decision::Start => Box::pin(start(&state, request)).await,
        Decision::Decline => {
            decline(&state, &request).await;
            request
        }
    };
    Ok(Json(request))
}

/// Start the team as the person would, and hand its answer back when it ends. The run keeps
/// which agent asked, so the team's chat shows the request as that agent's, not the person's.
async fn start(state: &TeamRequestsState, request: TeamRequest) -> TeamRequest {
    let launch = StartRunRequest::from_chat(
        &request.team.path,
        &request.request,
        None,
        Some(format!("team-request-{}", request.id)),
    )
    .asked_by(RunAskedBy {
        agent: request.asked_by.agent.clone(),
        name: request.asked_by.name.clone(),
    });
    let outcome = crate::runs::launch_manual(
        &state.registry,
        state.archive.clone(),
        &state.teams_root,
        &launch,
    )
    .await;
    // What the person reads, and for the agent, what LoomWatch knows besides.
    let (problem, detail) = match outcome {
        Ok(StartRunOutcome::Accepted(record) | StartRunOutcome::Duplicate(record)) => {
            state.registry.persist_quietly(&record.run_id).await;
            let run_id = record.run_id;
            let started = update(&request.id, |request| request.run_id = Some(run_id.clone()))
                .unwrap_or(request);
            tokio::spawn(hand_back(state.clone(), started.id.clone(), run_id));
            return started;
        }
        Ok(StartRunOutcome::IdempotencyConflict { .. }) => {
            (format!("{} is already starting.", request.team.name), None)
        }
        Err(LaunchError::NeedsReview(_)) => (
            format!(
                "{0}, or one of its agents, changed outside LoomWatch, so it didn't run. Open {0} \
                 and press Run team to see what it will do, then ask again.",
                request.team.name
            ),
            None,
        ),
        Err(LaunchError::StaleRevision { .. }) => (
            format!(
                "{} changed while it was starting, so it didn't run. Ask again.",
                request.team.name
            ),
            None,
        ),
        Err(LaunchError::Api(error)) => (
            format!(
                "{} can't run as it is. Open it in LoomWatch to see what to fix.",
                request.team.name
            ),
            Some(error.message),
        ),
    };
    let failed = update(&request.id, |request| {
        request.status = Status::Failed;
        request.problem = Some(problem.clone());
        request.finished_at = Some(Utc::now());
    })
    .unwrap_or(request);
    // The agent is told too, so it can answer the person itself; it alone hears the details.
    let (text, heading) = told_not_started(&failed, &problem, detail.as_deref());
    tell(
        state,
        &failed,
        &text,
        Some(handed_back(state, &failed, None, Some(heading))),
        true,
    )
    .await;
    failed
}

/// What the asking agent is told when `request`'s team could not start, and the words before
/// what its chat shows of it: the problem in plain words, `detail` being for the agent alone.
fn told_not_started(
    request: &TeamRequest,
    problem: &str,
    detail: Option<&str>,
) -> (String, String) {
    let detail = detail
        .map(|detail| format!(" ({detail})"))
        .unwrap_or_default();
    let heading = format!(
        "{} didn't start “{}”{detail}:",
        request.team.name, request.request
    );
    (format!("{heading} {problem}"), heading)
}

/// What the asking agent is told when `request`'s team stopped before it finished, and the words
/// before the reason, which is what its chat shows.
fn told_stopped(request: &TeamRequest, problem: &str) -> (String, String) {
    let heading = format!(
        "{} stopped before it finished “{}”:",
        request.team.name, request.request
    );
    (format!("{heading} {problem}"), heading)
}

/// Not now: the asking agent hears it while its turn is still at work, and nothing otherwise.
async fn decline(state: &TeamRequestsState, request: &TeamRequest) {
    // Shown in the agent's chat, where the person's own messages are: written as theirs.
    tell(
        state,
        request,
        &format!("Don't ask {} for this now.", request.team.name),
        None,
        true,
    )
    .await;
}

/// Wait for the team's run to end, then hand its answer, or why it stopped, to the agent that
/// asked.
async fn hand_back(state: TeamRequestsState, id: String, run_id: String) {
    let record = loop {
        match state.registry.get(&run_id) {
            Some(record) if record.status.is_terminal() => break Some(record),
            Some(_) => tokio::time::sleep(POLL).await,
            None => break None,
        }
    };
    let Some(request) = get_request(&id) else {
        return;
    };
    // The agent reads whose answer follows; the chat shows the answer as the team's.
    let (status, problem, text, heading) = match &record {
        Some(record) if record.status == RunStatus::Succeeded => {
            let answer = record.reply.as_deref().unwrap_or_default().trim();
            let answer = crate::cap_middle_text(answer, ANSWER_KEPT_CHARS);
            let heading = format!("{}'s answer to “{}”:", request.team.name, request.request);
            (
                Status::Done,
                None,
                format!("{heading}\n\n{answer}"),
                Some(heading),
            )
        }
        Some(record) => {
            let problem = stopped_because(record.status, record.error.as_deref());
            let (text, heading) = told_stopped(&request, &problem);
            (Status::Failed, Some(problem), text, Some(heading))
        }
        None => {
            let problem = "LoomWatch lost track of its run.".to_owned();
            let (text, heading) = told_stopped(&request, &problem);
            (Status::Failed, Some(problem), text, Some(heading))
        }
    };
    let Some(request) = update(&id, |request| {
        request.status = status;
        request.problem = problem;
        request.finished_at = Some(Utc::now());
    }) else {
        return;
    };
    let responder = record.as_ref().map(|record| record.responder.as_str());
    let handed = handed_back(&state, &request, responder, heading);
    tell(&state, &request, &text, Some(handed), false).await;
}

/// What the chat shows a message from `request`'s team as: the team, the agent of it that answers
/// (`responder`, or the one its file names when no run says), and what it was asked, with `heading`
/// the words before the team's own answer.
fn handed_back(
    state: &TeamRequestsState,
    request: &TeamRequest,
    responder: Option<&str>,
    heading: Option<String>,
) -> crate::chat::HandedBack {
    let team = crate::config::TeamConfig::load_in(
        &state.teams_root.join(&request.team.path),
        &state.teams_root,
    )
    .ok();
    let agent = responder
        .map(str::to_owned)
        .or_else(|| team.as_ref().and_then(|team| team.responder_id().ok()));
    let from_agent = team
        .as_ref()
        .zip(agent.as_deref())
        .and_then(|(team, id)| team.agents.iter().find(|each| each.id == id))
        .and_then(|each| each.from_agent.clone());
    crate::chat::HandedBack {
        team_path: request.team.path.clone(),
        team_name: request.team.name.clone(),
        agent,
        from_agent,
        request: request.request.clone(),
        heading,
    }
}

/// Why a team's run ended without an answer, in plain words, as a sentence of its own.
fn stopped_because(status: RunStatus, error: Option<&str>) -> String {
    if status == RunStatus::Cancelled {
        return "It was stopped.".to_owned();
    }
    error
        .map(str::trim)
        .filter(|error| !error.is_empty())
        .map_or_else(
            || "It failed without saying why.".to_owned(),
            |error| {
                let line = first_line(error, 300);
                let mut chars = line.chars();
                chars
                    .next()
                    .map(|first| first.to_uppercase().chain(chars).collect())
                    .unwrap_or_default()
            },
        )
}

/// The first line of `text`, at most `limit` characters, with "…" when anything was left out.
fn first_line(text: &str, limit: usize) -> String {
    let line = text.lines().next().unwrap_or_default().trim();
    let cut: String = line.chars().take(limit).collect();
    if cut.len() < line.len() || text.lines().nth(1).is_some() {
        format!("{cut}…")
    } else {
        cut
    }
}

/// Say `text` to the agent that asked, in its own chat; with `handed_back`, as the team's rather
/// than the person's. `only_while_working`: only as a note to a turn still at work, never starting
/// a new one.
async fn tell(
    state: &TeamRequestsState,
    request: &TeamRequest,
    text: &str,
    handed_back: Option<crate::chat::HandedBack>,
    only_while_working: bool,
) {
    if let Err(problem) = crate::chat::tell_agent(
        &state.registry,
        state.archive.clone(),
        &state.teams_root,
        &request.asked_by.chat_path,
        &request.asked_by.agent,
        text,
        handed_back,
        only_while_working,
        Some(format!("team-request-{}-{:?}", request.id, request.status)),
    )
    .await
    {
        eprintln!(
            "warning: {} could not be told about {}: {problem}",
            request.asked_by.agent, request.team.name
        );
    }
}

/// The person's teams the pinned agent may ask, for `my_teams` and to check `ask_team`'s file:
/// every team file under the teams root, `.jobs/` and its agents' chats aside, that opens as a
/// team.
pub(crate) fn teams(teams_root: &Path) -> Vec<(TeamRef, crate::config::TeamConfig)> {
    let Ok(files) = crate::api::discover_team_files(teams_root) else {
        return Vec::new();
    };
    files
        .into_iter()
        .filter_map(|file| {
            let team =
                crate::config::TeamConfig::load_in(&teams_root.join(&file), teams_root).ok()?;
            let name = if team.name.trim().is_empty() {
                file.trim_end_matches(".yaml")
                    .trim_end_matches(".yml")
                    .to_owned()
            } else {
                team.name.trim().to_owned()
            };
            Some((TeamRef { path: file, name }, team))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{Request, header};
    use http_body_util::BodyExt as _;
    use serde_json::{Value, json};
    use tower::ServiceExt as _;

    use super::*;
    use crate::agent::{Completion, Demo, Message, ToolCall};
    use crate::runs::tests::TeamsDir;
    use crate::runs::{RunRecord, RunStore};

    /// What Maya says once a team's answer reaches her.
    const WRITES_IT_UP: &str = "Here is your plan, from Trip planner.";

    /// Maya, pinned to the notch: with `ask_team` offered she asks the Trip planner (or `team`)
    /// once; after the tool answers she repeats what it said; handed a team's answer she writes it
    /// up; and without the tool she says so.
    fn maya(team: &'static str) -> String {
        stand_in(team, false)
    }

    /// Maya calling `ask_team` whether it is offered or not, as a harness that cached an older
    /// list of tools might.
    fn pushy_maya() -> String {
        stand_in("trips.yaml", true)
    }

    fn stand_in(team: &'static str, pushy: bool) -> String {
        crate::engine::demo_model(Demo::responder(move |request| {
            if request.prompt().contains("'s answer to “") {
                return Some(Completion::text(WRITES_IT_UP));
            }
            if let Some(Message::Tool { content, .. }) = request.messages.last() {
                return Some(Completion::text(&format!("The tool said: {content}")));
            }
            if !pushy && !request.tools.iter().any(|tool| tool == "ask_team") {
                return Some(Completion::text("NO ASK_TEAM"));
            }
            Some(Completion::calls(
                "",
                vec![ToolCall {
                    id: "ask-1".to_owned(),
                    name: "ask_team".to_owned(),
                    arguments: json!({"team": team, "request": "Plan 3 gentle days in Đà Lạt"})
                        .to_string(),
                }],
            ))
        }))
    }

    struct Rig {
        dir: TeamsDir,
        chat: Router,
        requests: Router,
        registry: RunRegistry,
    }

    /// A teams folder with Maya pinned and her chat written, and a Trip planner team.
    async fn rig(maya_model: &str) -> Rig {
        let pool = crate::db::Db::temp().await;
        let archive = EventArchive::new(pool.clone());
        let registry = RunRegistry::durable(RunStore::new(pool));
        let dir = TeamsDir::new();
        let jobs = dir.0.join(".jobs");
        std::fs::create_dir_all(jobs.join(".bench")).unwrap();
        std::fs::write(
            jobs.join("maya.yaml"),
            "name: Maya\ninstructions: Help me with my day.\n",
        )
        .unwrap();
        std::fs::write(
            jobs.join(".bench").join("maya.yaml"),
            format!(
                "schemaVersion: 1\nid: bench-maya\nname: Maya · chat\nentrypoint: maya\nagents:\n  - id: maya\n    name: Maya\n    role: Help me with my day.\n    model: {maya_model}\n"
            ),
        )
        .unwrap();
        let planner = crate::engine::demo_model(Demo::scripted(vec![Completion::text(
            "Day 1: the lake. Day 2: the train. Day 3: the market.",
        )]));
        std::fs::write(
            dir.0.join("trips.yaml"),
            format!(
                "schemaVersion: 1\nid: trips\nname: Trip planner\nentrypoint: planner\nagents:\n  - id: planner\n    name: Planner\n    role: Plan trips at the pace asked.\n    model: {planner}\n"
            ),
        )
        .unwrap();
        let pinned = crate::pinned::Pinned::in_memory(&dir.0);
        pinned
            .set(crate::pinned::PinnedAgent {
                agent: Some("maya".to_owned()),
            })
            .unwrap();
        crate::pinned::install(pinned);
        Rig {
            chat: crate::chat::router(Some(archive.clone()), dir.0.clone(), registry.clone()),
            requests: router(Some(archive), dir.0.clone(), registry.clone()),
            registry,
            dir,
        }
    }

    async fn call(
        app: &Router,
        method: &str,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let request = Request::builder()
            .method(method)
            .uri(uri)
            .header("host", "localhost")
            .header(header::CONTENT_TYPE, "application/json")
            .body(body.map_or_else(Body::empty, |body| Body::from(body.to_string())))
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn wait_for(registry: &RunRegistry, done: impl Fn(&[RunRecord]) -> bool) {
        tokio::time::timeout(Duration::from_secs(20), async {
            while !done(&registry.list()) {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("never got there: {:#?}", registry.list()));
    }

    /// The person writes to Maya in her own chat; her run ends.
    async fn ask_maya(rig: &Rig, team_path: &str) -> RunRecord {
        let (status, sent) = call(
            &rig.chat,
            "POST",
            "/api/chat/messages",
            Some(json!({"teamPath": team_path, "text": "Plan a trip for my parents", "to": {"kind": "agent", "agent": "maya"}, "work": true})),
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED, "{sent}");
        let run_id = sent["run"]["runId"].as_str().unwrap().to_owned();
        wait_for(&rig.registry, |runs| {
            runs.iter()
                .any(|run| run.run_id == run_id && run.status.is_terminal())
        })
        .await;
        rig.registry.get(&run_id).unwrap()
    }

    fn asked_from(run_id: &str) -> Vec<TeamRequest> {
        list(Some(KEEP), Utc::now())
            .into_iter()
            .filter(|request| request.asked_by.run_id == run_id)
            .collect()
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn the_pinned_agent_asks_a_team_the_person_starts_it_and_its_answer_comes_back_to_her() {
        let rig = rig(&maya("trips.yaml")).await;
        let first = ask_maya(&rig, ".jobs/.bench/maya.yaml").await;
        assert_eq!(first.status, RunStatus::Succeeded, "{first:?}");
        assert!(
            first
                .reply
                .as_deref()
                .unwrap_or_default()
                .contains("Nothing runs until they press Start"),
            "{first:?}"
        );

        // One request waits for the person, and the island can list it.
        let asked = asked_from(&first.run_id);
        assert_eq!(asked.len(), 1, "{asked:?}");
        let request = &asked[0];
        assert_eq!(request.status, Status::Waiting);
        assert_eq!(
            request.team,
            TeamRef {
                path: "trips.yaml".into(),
                name: "Trip planner".into()
            }
        );
        assert_eq!(
            request.asked_by,
            AskedBy {
                run_id: first.run_id.clone(),
                agent: "maya".into(),
                name: "Maya".into(),
                chat_path: ".jobs/.bench/maya.yaml".into()
            }
        );
        assert_eq!(request.request, "Plan 3 gentle days in Đà Lạt");
        let (status, listed) = call(
            &rig.requests,
            "GET",
            "/api/team-requests?finishedWithin=3600",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let shown = listed
            .as_array()
            .unwrap()
            .iter()
            .find(|each| each["id"] == request.id.as_str())
            .expect("listed")
            .clone();
        assert_eq!(shown["status"], "waiting");
        assert_eq!(shown["askedBy"]["chatPath"], ".jobs/.bench/maya.yaml");
        assert_eq!(shown["team"]["name"], "Trip planner");
        assert_eq!(shown["runId"], Value::Null);
        // Nothing ran yet: only Maya's own run.
        assert!(
            rig.registry
                .list()
                .iter()
                .all(|run| run.team_path != "trips.yaml")
        );

        // Start: the team runs on the request, as the person starting it would.
        let (status, started) = call(
            &rig.requests,
            "POST",
            &format!("/api/team-requests/{}", request.id),
            Some(json!({"decision": "start"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{started}");
        assert_eq!(started["status"], "started");
        let team_run = started["runId"].as_str().expect("a run").to_owned();
        let run = rig.registry.get(&team_run).unwrap();
        assert_eq!(
            (run.team_path.as_str(), run.prompt.as_str()),
            ("trips.yaml", "Plan 3 gentle days in Đà Lạt")
        );
        // In Trip planner's own chat the request is Maya's, not the person's: the run says who
        // asked, by her id in My agents and her name.
        let (status, team_page) =
            call(&rig.chat, "GET", "/api/chat?teamPath=trips.yaml", None).await;
        assert_eq!(status, StatusCode::OK, "{team_page}");
        let piece = team_page["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["run"]["runId"] == team_run.as_str())
            .cloned()
            .unwrap_or_else(|| panic!("the team's chat shows the work: {team_page}"));
        assert_eq!(
            piece["run"]["askedBy"],
            json!({"agent": "maya", "name": "Maya"}),
            "{piece}"
        );
        // Answering again is refused.
        let (again, _) = call(
            &rig.requests,
            "POST",
            &format!("/api/team-requests/{}", request.id),
            Some(json!({"decision": "start"})),
        )
        .await;
        assert_eq!(again, StatusCode::CONFLICT);

        // The team's answer goes to Maya in her chat, and she writes it up.
        wait_for(&rig.registry, |runs| {
            runs.iter().any(|run| {
                run.team_path == ".jobs/.bench/maya.yaml"
                    && run.run_id != first.run_id
                    && run.status == RunStatus::Succeeded
                    && run.reply.as_deref() == Some(WRITES_IT_UP)
            })
        })
        .await;
        let handed = rig
            .registry
            .list()
            .into_iter()
            .find(|run| run.team_path == ".jobs/.bench/maya.yaml" && run.run_id != first.run_id)
            .unwrap();
        assert!(
            handed
                .prompt
                .contains("Trip planner's answer to “Plan 3 gentle days in Đà Lạt”:"),
            "{}",
            handed.prompt
        );
        assert!(
            handed
                .prompt
                .contains("Day 1: the lake. Day 2: the train. Day 3: the market."),
            "{}",
            handed.prompt
        );
        // In her chat the answer is Trip planner's, not the person's: the team, its agent that
        // answered, what it was asked, and the words before the answer. Her first message is the
        // person's own.
        let (status, page) = call(
            &rig.chat,
            "GET",
            "/api/chat?teamPath=.jobs%2F.bench%2Fmaya.yaml",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{page}");
        let request_of = |run_id: &str| {
            page["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["run"]["runId"] == run_id)
                .map_or(Value::Null, |item| item["request"].clone())
        };
        let from_team = request_of(&handed.run_id);
        assert_eq!(
            from_team["handedBack"],
            json!({
                "teamPath": "trips.yaml",
                "teamName": "Trip planner",
                "agent": "planner",
                "fromAgent": null,
                "request": "Plan 3 gentle days in Đà Lạt",
                "heading": "Trip planner's answer to “Plan 3 gentle days in Đà Lạt”:",
            }),
            "{from_team}"
        );
        assert_eq!(
            from_team["text"],
            "Trip planner's answer to “Plan 3 gentle days in Đà Lạt”:\n\nDay 1: the lake. Day 2: \
             the train. Day 3: the market."
        );
        let yours = request_of(&first.run_id);
        assert!(yours["text"].is_string(), "{page}");
        assert!(yours.get("handedBack").is_none(), "{yours}");
        // The person asked Maya themself: no agent asked for that run.
        assert!(first.asked_by.is_none(), "{first:?}");
        let done = asked_from(&first.run_id).remove(0);
        assert_eq!(
            (done.status, done.run_id.as_deref()),
            (Status::Done, Some(team_run.as_str()))
        );
        assert!(done.finished_at.is_some());
        drop(rig.dir);
    }

    #[tokio::test]
    async fn only_the_pinned_agent_in_its_own_chat_is_offered_the_teams() {
        let rig = rig(&maya("trips.yaml")).await;
        // The same agent, in a team of its own rather than its chat: no tool.
        let elsewhere = std::fs::read_to_string(rig.dir.0.join(".jobs/.bench/maya.yaml"))
            .unwrap()
            .replace("id: bench-maya", "id: maya-desk");
        std::fs::write(rig.dir.0.join("desk.yaml"), elsewhere).unwrap();
        let run = ask_maya(&rig, "desk.yaml").await;
        assert_eq!(run.reply.as_deref(), Some("NO ASK_TEAM"), "{run:?}");
        assert!(asked_from(&run.run_id).is_empty());
        // In its own chat, it is.
        let own = ask_maya(&rig, ".jobs/.bench/maya.yaml").await;
        assert_eq!(asked_from(&own.run_id).len(), 1, "{own:?}");
    }

    #[tokio::test]
    async fn a_call_from_anywhere_else_is_refused_even_when_made_anyway() {
        let rig = rig(&pushy_maya()).await;
        let elsewhere = std::fs::read_to_string(rig.dir.0.join(".jobs/.bench/maya.yaml"))
            .unwrap()
            .replace("id: bench-maya", "id: maya-desk");
        std::fs::write(rig.dir.0.join("desk.yaml"), elsewhere).unwrap();
        let run = ask_maya(&rig, "desk.yaml").await;
        assert!(asked_from(&run.run_id).is_empty(), "{run:?}");
        assert!(!run.reply.unwrap_or_default().contains("Nothing runs until"));
    }

    #[tokio::test]
    async fn asking_something_that_is_not_one_of_the_persons_teams_is_refused() {
        let rig = rig(&maya(".jobs/.bench/maya.yaml")).await;
        let run = ask_maya(&rig, ".jobs/.bench/maya.yaml").await;
        let reply = run.reply.unwrap_or_default();
        assert!(
            reply.contains("is not one of the person's teams"),
            "{reply}"
        );
        assert!(asked_from(&run.run_id).is_empty());
    }

    #[tokio::test]
    async fn not_now_declines_it_and_nothing_runs() {
        let rig = rig(&maya("trips.yaml")).await;
        let first = ask_maya(&rig, ".jobs/.bench/maya.yaml").await;
        let request = asked_from(&first.run_id).remove(0);
        let (status, declined) = call(
            &rig.requests,
            "POST",
            &format!("/api/team-requests/{}", request.id),
            Some(json!({"decision": "decline"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{declined}");
        assert_eq!(declined["status"], "declined");
        assert!(declined["finishedAt"].is_string());
        tokio::time::sleep(Duration::from_millis(300)).await;
        // No team ran, and Maya, done with her turn, was not started again.
        let runs = rig.registry.list();
        assert!(
            runs.iter().all(|run| run.team_path != "trips.yaml"),
            "{runs:#?}"
        );
        assert_eq!(
            runs.iter()
                .filter(|run| run.team_path == ".jobs/.bench/maya.yaml")
                .count(),
            1
        );
        // A declined request is listed only within finishedWithin.
        assert!(
            list(None, Utc::now())
                .iter()
                .all(|each| each.id != request.id)
        );
        let (missing, _) = call(
            &rig.requests,
            "POST",
            "/api/team-requests/nope",
            Some(json!({"decision": "start"})),
        )
        .await;
        assert_eq!(missing, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn a_team_that_cannot_start_fails_in_plain_words() {
        let rig = rig(&maya("trips.yaml")).await;
        let first = ask_maya(&rig, ".jobs/.bench/maya.yaml").await;
        let request = asked_from(&first.run_id).remove(0);
        // The team file went away between the ask and Start.
        std::fs::remove_file(rig.dir.0.join("trips.yaml")).unwrap();
        let (status, failed) = call(
            &rig.requests,
            "POST",
            &format!("/api/team-requests/{}", request.id),
            Some(json!({"decision": "start"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{failed}");
        assert_eq!(failed["status"], "failed");
        assert_eq!(failed["runId"], Value::Null);
        let problem = failed["problem"].as_str().unwrap();
        assert_eq!(
            problem,
            "Trip planner can't run as it is. Open it in LoomWatch to see what to fix."
        );
        assert!(
            rig.registry
                .list()
                .iter()
                .all(|run| run.team_path != "trips.yaml")
        );
    }

    /// ADR 0083, decision 10: when the team doesn't finish, the agent reads why, the details
    /// included, and the chat shows only the reason, in plain words, after the heading.
    #[test]
    fn the_chat_shows_only_the_plain_reason_when_a_team_does_not_finish() {
        let request = ask(
            AskedBy {
                run_id: Uuid::new_v4().to_string(),
                agent: "maya".into(),
                name: "Maya".into(),
                chat_path: ".jobs/.bench/maya.yaml".into(),
            },
            TeamRef {
                path: "trips.yaml".into(),
                name: "Trip planner".into(),
            },
            "Plan Friday",
        )
        .unwrap();
        let shown = |text: &str, heading: &str| {
            text.strip_prefix(heading).map(str::trim).map(str::to_owned)
        };
        let problem = "Trip planner can't run as it is. Open it in LoomWatch to see what to fix.";
        let (text, heading) =
            told_not_started(&request, problem, Some("agents[0].model is missing"));
        assert_eq!(
            text,
            "Trip planner didn't start “Plan Friday” (agents[0].model is missing): Trip planner \
             can't run as it is. Open it in LoomWatch to see what to fix."
        );
        assert_eq!(shown(&text, &heading).as_deref(), Some(problem));
        let (text, heading) = told_stopped(&request, &stopped_because(RunStatus::Cancelled, None));
        assert_eq!(shown(&text, &heading).as_deref(), Some("It was stopped."));
        assert_eq!(
            stopped_because(RunStatus::Failed, Some("timed out after 600s\nmore")),
            "Timed out after 600s…"
        );
        assert_eq!(
            stopped_because(RunStatus::Failed, None),
            "It failed without saying why."
        );
    }

    #[test]
    fn at_most_three_requests_wait_from_one_run() {
        let asked_by = AskedBy {
            run_id: Uuid::new_v4().to_string(),
            agent: "maya".into(),
            name: "Maya".into(),
            chat_path: ".jobs/.bench/maya.yaml".into(),
        };
        let team = TeamRef {
            path: "trips.yaml".into(),
            name: "Trip planner".into(),
        };
        for _ in 0..MAX_WAITING_PER_RUN {
            ask(asked_by.clone(), team.clone(), "a job").unwrap();
        }
        assert!(
            ask(asked_by.clone(), team.clone(), "one more")
                .unwrap_err()
                .contains("already wait")
        );
        assert!(
            ask(
                AskedBy {
                    run_id: Uuid::new_v4().to_string(),
                    ..asked_by
                },
                team,
                "  "
            )
            .unwrap_err()
            .contains("empty")
        );
    }
}
