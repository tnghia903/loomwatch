use axum::body::Body;
use axum::http::Request as HttpRequest;
use http_body_util::BodyExt as _;

use super::*;

fn put(body: &Value) -> Request {
    HttpRequest::builder()
        .method(Method::PUT)
        .uri(ROUTE)
        .body(Body::from(body.to_string()))
        .unwrap()
}

fn delete() -> Request {
    HttpRequest::builder()
        .method(Method::DELETE)
        .uri(ROUTE)
        .body(Body::empty())
        .unwrap()
}

async fn answer(response: Response) -> (StatusCode, Value) {
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn steps(day: &str, value: f64) -> Value {
    json!({"kind": "steps", "day": day, "value": value, "unit": "count", "source": "iPhone"})
}

async fn called(health: &Health, call: &str, arguments: Value) -> Value {
    let (text, failed) = health.call(call, &arguments).await;
    assert!(!failed, "{text}");
    serde_json::from_str(&text).unwrap()
}

/// What the phone sends is kept, sending a day again replaces it, and the tool answers day by
/// day and week by week.
#[tokio::test]
async fn keeps_a_phones_readings_and_answers_from_them() {
    let health = Health::new(Db::temp().await);
    let batch = json!({
        "days": [steps("2026-11-02", 4000.0), steps("2026-11-03", 6000.0), steps("2026-11-09", 1000.0),
                 {"kind": "resting_heart_rate", "day": "2026-11-03", "value": 58.0, "unit": "bpm"}],
        "events": [{"kind": "sleep", "start": "2026-11-02T23:10:00+07:00", "end": "2026-11-03T06:40:00+07:00"}],
    });
    let (status, kept) = answer(route(Some(&health), "phone-a", put(&batch)).await).await;
    assert_eq!((status, kept), (StatusCode::OK, json!({"kept": 5})));
    // The same day again replaces it rather than adding a second figure.
    let again = json!({"days": [steps("2026-11-03", 6500.0)]});
    let (status, _) = answer(route(Some(&health), "phone-a", put(&again)).await).await;
    assert_eq!(status, StatusCode::OK);

    let daily = called(
        &health,
        "daily",
        json!({"kind": "steps", "from": "2026-11-01", "to": "2026-11-05"}),
    )
    .await;
    assert_eq!(
        daily["days"],
        json!([{"day": "2026-11-02", "value": 4000.0}, {"day": "2026-11-03", "value": 6500.0}])
    );
    let weekly = called(
        &health,
        "weekly",
        json!({"kind": "steps", "from": "2026-11-01", "to": "2026-11-15"}),
    )
    .await;
    // 2 November 2026 is a Monday: the week of the 2nd adds its two days, the 9th starts the next.
    assert_eq!(
        weekly["weeks"],
        json!([
            {"weekOf": "2026-11-02", "value": 10500.0, "daysWithReadings": 2},
            {"weekOf": "2026-11-09", "value": 1000.0, "daysWithReadings": 1},
        ])
    );
    let latest = called(&health, "latest", json!({"kind": "resting_heart_rate"})).await;
    assert_eq!(
        (latest["day"].clone(), latest["value"].clone()),
        (json!("2026-11-03"), json!(58.0))
    );
    let sleep = called(
        &health,
        "sleep",
        json!({"from": "2026-11-01", "to": "2026-11-05"}),
    )
    .await;
    assert_eq!(sleep["events"].as_array().unwrap().len(), 1);
    let kinds = called(&health, "list_kinds", json!({})).await;
    let names: Vec<&str> = kinds["kinds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|kind| kind["kind"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["resting_heart_rate", "steps", "sleep"]);
    assert!(health.has_readings().await);
}

/// A phone forgets only its own readings: the door names the phone, never the request.
#[tokio::test]
async fn a_phone_forgets_only_its_own_readings() {
    let health = Health::new(Db::temp().await);
    for phone in ["phone-a", "phone-b"] {
        let (status, _) = answer(
            route(
                Some(&health),
                phone,
                put(&json!({"days": [steps("2026-11-02", 100.0)]})),
            )
            .await,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }
    let (status, _) = answer(route(Some(&health), "phone-b", delete()).await).await;
    assert_eq!(status, StatusCode::OK);
    let count = |device: &'static str| {
        let health = health.clone();
        async move {
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM health_days WHERE device = $1")
                .bind(device)
                .fetch_one(health.db.reader())
                .await
                .unwrap()
        }
    };
    assert_eq!((count("phone-a").await, count("phone-b").await), (1, 0));
    health.forget(None).await.unwrap();
    assert!(
        !health.has_readings().await,
        "removing the tool forgets every phone's"
    );
}

/// What isn't a reading is refused whole, with why, and nothing of it is kept.
#[tokio::test]
async fn refuses_what_isnt_a_reading() {
    let health = Health::new(Db::temp().await);
    for (bad, why) in [
        (
            json!({"days": [{"kind": "blood_type", "day": "2026-11-02", "value": 1, "unit": "count"}]}),
            "isn't a kind",
        ),
        (
            json!({"days": [{"kind": "steps", "day": "2026-11-02", "value": 1, "unit": "kg"}]}),
            "counted in count",
        ),
        (
            json!({"days": [{"kind": "steps", "day": "Monday", "value": 1, "unit": "count"}]}),
            "isn't a day",
        ),
        (
            json!({"events": [{"kind": "sleep", "start": "2026-11-03T06:00:00Z", "end": "2026-11-02T23:00:00Z"}]}),
            "isn't a reading",
        ),
    ] {
        let (status, said) = answer(route(Some(&health), "phone-a", put(&bad)).await).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}");
        assert!(said["error"].as_str().unwrap().contains(why), "{said}");
    }
    let (status, _) =
        answer(route(Some(&health), "phone-a", put(&json!({"extra": 1}))).await).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(!health.has_readings().await);
    let (status, _) = answer(route(None, "phone-a", put(&json!({}))).await).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
}

/// The reading calls only read; logging changes the person's Health, and a remove can't be
/// undone, so it asks every time. Asking for another kind says which there are.
#[test]
fn reading_calls_read_and_logging_calls_ask_as_changes() {
    let calls = calls();
    let named = |name: &str| calls.iter().find(|call| call.name == name).unwrap();
    for reading in [
        "list_kinds",
        "daily",
        "weekly",
        "latest",
        "sleep",
        "workouts",
        "logged",
    ] {
        assert!(
            named(reading).read_only && !named(reading).cant_undo,
            "{reading}"
        );
    }
    for logging in ["log_meal", "log_water", "log_weight"] {
        assert!(
            !named(logging).read_only && !named(logging).cant_undo,
            "{logging}"
        );
    }
    assert!(!named("remove_logged").read_only && named("remove_logged").cant_undo);
    assert!(
        calls
            .iter()
            .all(|call| call.input_schema["type"] == "object")
    );
    assert!(unknown_kind("blood_type").contains("steps"));
}

/// A night that starts after midnight where the person is belongs to that day, though in UTC it
/// is still the day before; a time sent in UTC is read in this computer's time zone.
#[tokio::test]
async fn an_event_belongs_to_the_day_it_started_where_the_person_was() {
    let health = Health::new(Db::temp().await);
    let batch = json!({"events": [
        {"kind": "sleep", "start": "2026-11-08T00:30:00+07:00", "end": "2026-11-08T07:00:00+07:00"}
    ]});
    let (status, _) = answer(route(Some(&health), "phone-a", put(&batch)).await).await;
    assert_eq!(status, StatusCode::OK);
    let night = called(
        &health,
        "sleep",
        json!({"from": "2026-11-08", "to": "2026-11-08"}),
    )
    .await;
    assert_eq!(night["events"].as_array().unwrap().len(), 1, "{night}");
    assert_eq!(night["events"][0]["day"], "2026-11-08");
    let before = called(
        &health,
        "sleep",
        json!({"from": "2026-11-07", "to": "2026-11-07"}),
    )
    .await;
    assert!(before["events"].as_array().unwrap().is_empty(), "{before}");

    let utc = "2026-11-07T17:30:00Z";
    let local = DateTime::parse_from_rfc3339(utc)
        .unwrap()
        .with_timezone(&chrono::Local)
        .date_naive()
        .to_string();
    assert_eq!(start_day(utc), Some(local.clone()));
    assert_eq!(start_day("not a time"), None);
    // Sent in UTC, it is found on its local day: 8 November on a computer seven or more hours
    // ahead of UTC, where reading the date as sent would miss it.
    let batch =
        json!({"events": [{"kind": "workout", "start": utc, "end": "2026-11-07T18:00:00Z"}]});
    let (status, _) = answer(route(Some(&health), "phone-a", put(&batch)).await).await;
    assert_eq!(status, StatusCode::OK);
    let workouts = called(&health, "workouts", json!({"from": local, "to": local})).await;
    assert_eq!(
        workouts["events"].as_array().unwrap().len(),
        1,
        "{workouts}"
    );
}

fn get_writes() -> Request {
    HttpRequest::builder()
        .method(Method::GET)
        .uri(WRITES_ROUTE)
        .body(Body::empty())
        .unwrap()
}

fn post_settled(id: &str, body: &Value) -> Request {
    HttpRequest::builder()
        .method(Method::POST)
        .uri(format!("{WRITES_ROUTE}/{id}"))
        .body(Body::from(body.to_string()))
        .unwrap()
}

/// A store with phone `device` sending readings, whose log calls wait `wait` for the phone.
async fn sending(device: &str, wait: std::time::Duration) -> Health {
    let health = Health {
        phone_wait: wait,
        ..Health::new(Db::temp().await)
    };
    let batch = json!({"days": [steps("2026-11-08", 5000.0)]});
    let (status, _) = answer(route(Some(&health), device, put(&batch)).await).await;
    assert_eq!(status, StatusCode::OK);
    health
}

/// Plays the phone: takes what waits for `device` and says each was saved.
async fn phone_saves(health: &Health, device: &str) -> Vec<Value> {
    let (status, waiting) = answer(route(Some(health), device, get_writes()).await).await;
    assert_eq!(status, StatusCode::OK);
    let writes = waiting["writes"].as_array().unwrap().clone();
    for write in &writes {
        let id = write["id"].as_str().unwrap();
        let (status, settled) = answer(
            route(
                Some(health),
                device,
                post_settled(id, &json!({"saved": true})),
            )
            .await,
        )
        .await;
        assert_eq!(
            (status, settled),
            (StatusCode::OK, json!({"settled": true}))
        );
    }
    writes
}

/// A meal an agent logs goes to the phone that sends the readings, which is woken, takes it at
/// the door, saves it and says so; the agent's call hears that it was saved.
#[tokio::test]
async fn a_logged_meal_reaches_the_phone_and_the_agent_hears_it_was_saved() {
    let health = sending("phone-a", std::time::Duration::from_secs(10)).await;
    let phone = {
        let health = health.clone();
        tokio::spawn(async move {
            // The phone is woken only once the entry is kept, and takes it then.
            loop {
                if health.take_wakes() == vec!["phone-a".to_owned()] {
                    return phone_saves(&health, "phone-a").await;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
    };
    let logged = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        health.call(
            "log_meal",
            &json!({"at": "2026-11-09T12:30:00+07:00", "name": "Lunch", "energy_kcal": 920,
                    "protein_g": 41.25, "carbs_g": 95, "fat_g": 34}),
        ),
    )
    .await
    .unwrap();
    assert!(!logged.1, "{}", logged.0);
    let logged: Value = serde_json::from_str(&logged.0).unwrap();
    assert_eq!(logged["state"], "saved", "{logged}");
    assert!(
        logged["inWords"]
            .as_str()
            .unwrap()
            .starts_with("Saved in Apple Health")
    );

    let taken = phone.await.unwrap();
    assert_eq!(taken.len(), 1);
    assert_eq!(
        taken[0],
        json!({"id": logged["id"], "action": "add", "kind": "meal", "at": "2026-11-09T12:30:00+07:00",
               "name": "Lunch", "target": null,
               "amounts": {"energy_kcal": 920.0, "protein_g": 41.3, "carbs_g": 95.0, "fat_g": 34.0}})
    );
    // Taken once: the phone isn't given it again, and the day it was eaten finds it.
    assert!(phone_saves(&health, "phone-a").await.is_empty());
    let listed = called(
        &health,
        "logged",
        json!({"from": "2026-11-09", "to": "2026-11-09"}),
    )
    .await;
    assert_eq!(listed["entries"][0]["state"], "saved");
    assert_eq!(listed["entries"][0]["name"], "Lunch");
}

/// When the phone doesn't answer in time, the agent is told it waits for the phone, and the
/// phone still takes it later.
#[tokio::test]
async fn an_entry_the_phone_hasnt_taken_yet_says_so_and_waits_for_it() {
    let health = sending("phone-a", std::time::Duration::from_millis(300)).await;
    let water = called(&health, "log_water", json!({"water_ml": 500})).await;
    assert_eq!(water["state"], "waiting");
    assert!(
        water["inWords"]
            .as_str()
            .unwrap()
            .contains("Waiting for the person's iPhone")
    );
    assert_eq!(health.take_wakes(), vec!["phone-a".to_owned()]);
    assert!(health.take_wakes().is_empty(), "each wake is given once");
    let taken = phone_saves(&health, "phone-a").await;
    assert_eq!(taken[0]["kind"], "water");
    assert_eq!(taken[0]["amounts"], json!({"water_ml": 500.0}));
    let today = chrono::Local::now().date_naive().to_string();
    let listed = called(&health, "logged", json!({"from": today, "to": today})).await;
    assert_eq!(listed["entries"][0]["state"], "saved");
}

/// What the phone refuses comes back to the agent with the phone's words; another phone can't
/// answer for it.
#[tokio::test]
async fn a_phone_answers_only_for_its_own_entries_and_a_refusal_says_why() {
    let health = sending("phone-a", std::time::Duration::from_millis(300)).await;
    let weight = called(&health, "log_weight", json!({"weight_kg": 71.5})).await;
    let id = weight["id"].as_str().unwrap();
    let (_, other) = answer(route(Some(&health), "phone-b", get_writes()).await).await;
    assert_eq!(other, json!({"writes": []}));
    let (status, settled) = answer(
        route(
            Some(&health),
            "phone-b",
            post_settled(id, &json!({"saved": true})),
        )
        .await,
    )
    .await;
    assert_eq!(
        (status, settled),
        (StatusCode::OK, json!({"settled": false}))
    );
    let said = "Logging to Health is off on this iPhone.";
    let (_, settled) = answer(
        route(
            Some(&health),
            "phone-a",
            post_settled(id, &json!({"saved": false, "said": said})),
        )
        .await,
    )
    .await;
    assert_eq!(settled, json!({"settled": true}));
    let today = chrono::Local::now().date_naive().to_string();
    let listed = called(&health, "logged", json!({"from": today, "to": today})).await;
    assert_eq!(listed["entries"][0]["state"], "refused");
    assert_eq!(listed["entries"][0]["said"], said);
    let (status, _) = answer(
        route(
            Some(&health),
            "phone-a",
            post_settled(id, &json!({"saving": true})),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

/// A remove takes out only an entry logged here: one not yet taken never reaches the phone; one
/// saved goes to the phone as a remove, and is marked removed once the phone says so.
#[tokio::test]
async fn removing_takes_out_only_what_was_logged_here() {
    let health = sending("phone-a", std::time::Duration::from_millis(300)).await;
    let early = called(&health, "log_water", json!({"water_ml": 250})).await;
    let removed = called(&health, "remove_logged", json!({"id": early["id"]})).await;
    assert_eq!(removed["state"], "removed");
    assert!(
        phone_saves(&health, "phone-a").await.is_empty(),
        "never given to the phone"
    );

    let meal = called(&health, "log_meal", json!({"energy_kcal": 400})).await;
    assert_eq!(phone_saves(&health, "phone-a").await.len(), 1);
    let removing = called(&health, "remove_logged", json!({"id": meal["id"]})).await;
    assert_eq!(removing["state"], "waiting");
    let taken = phone_saves(&health, "phone-a").await;
    assert_eq!(
        (
            taken[0]["action"].as_str(),
            taken[0]["target"].as_str(),
            taken[0]["kind"].as_str()
        ),
        (Some("remove"), meal["id"].as_str(), Some("meal"))
    );
    let today = chrono::Local::now().date_naive().to_string();
    let listed = called(&health, "logged", json!({"from": today, "to": today})).await;
    let states: Vec<&str> = listed["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["state"].as_str().unwrap())
        .collect();
    assert_eq!(states, ["removed", "removed"], "{listed}");
    let (said, failed) = health
        .call("remove_logged", &json!({"id": meal["id"]}))
        .await;
    assert!(failed && said.contains("already"), "{said}");
    let (said, failed) = health
        .call("remove_logged", &json!({"id": "a-workout"}))
        .await;
    assert!(failed && said.contains("only those"), "{said}");
}

/// What isn't an entry is refused with why, nothing is kept and no phone is woken; with no phone
/// sending readings there's nowhere to log.
#[tokio::test]
async fn refuses_what_isnt_an_entry() {
    let nobody = Health::new(Db::temp().await);
    let (said, failed) = nobody.call("log_water", &json!({"water_ml": 300})).await;
    assert!(failed && said.contains("No iPhone"), "{said}");

    let health = sending("phone-a", std::time::Duration::from_millis(300)).await;
    for (call, arguments, expected) in [
        ("log_meal", json!({"name": "Lunch"}), "at least one"),
        ("log_meal", json!({"energy_kcal": -5}), "more than 0"),
        ("log_meal", json!({"energy_kcal": "lots"}), "a number"),
        ("log_weight", json!({"weight_kg": 900}), "at most"),
        (
            "log_water",
            json!({"water_ml": 300, "at": "noon"}),
            "offset",
        ),
        (
            "log_water",
            json!({"water_ml": 300, "at": "2099-01-01T00:00:00Z"}),
            "ahead",
        ),
        // A meal's amounts aren't a weight's.
        ("log_weight", json!({"energy_kcal": 300}), "weight_kg"),
    ] {
        let (said, failed) = health.call(call, &arguments).await;
        assert!(
            failed && said.contains(expected),
            "{call} {arguments}: {said}"
        );
    }
    assert!(health.take_wakes().is_empty());
    assert!(phone_saves(&health, "phone-a").await.is_empty());
}

/// Removing the phone or the tool forgets what was logged for it, as it does the readings.
#[tokio::test]
async fn forgetting_a_phone_forgets_what_was_logged_for_it() {
    let health = sending("phone-a", std::time::Duration::from_millis(100)).await;
    called(&health, "log_water", json!({"water_ml": 300})).await;
    health.forget(Some("phone-a")).await.unwrap();
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM health_writes")
        .fetch_one(health.db.reader())
        .await
        .unwrap();
    assert_eq!(left, 0);
}

/// The door hands the phone's Health paths here and nothing else.
#[test]
fn the_door_hands_over_only_the_health_paths() {
    for path in [ROUTE, WRITES_ROUTE, "/phone/v0/health/writes/lw-1"] {
        assert!(is_route(path), "{path}");
    }
    for path in [
        "/phone/v0/healthy",
        "/phone/v0/health/writes/",
        "/phone/v0/health/writes/a/b",
        "/phone/v0/health/other",
        "/phone/v0/home",
    ] {
        assert!(!is_route(path), "{path}");
    }
}
