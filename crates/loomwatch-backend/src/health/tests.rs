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

/// The tool only reads, and says which kinds there are when asked for another.
#[test]
fn the_tool_only_reads() {
    let calls = calls();
    assert!(calls.iter().all(|call| call.read_only && !call.cant_undo));
    assert!(
        calls
            .iter()
            .all(|call| call.input_schema["type"] == "object")
    );
    assert!(unknown_kind("blood_type").contains("steps"));
}
