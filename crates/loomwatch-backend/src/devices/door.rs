//! The door other devices come in by (ADR 0102). It answers only on this computer's own address;
//! the person's own Tailscale (or, later, the relay) brings devices to it.
//!
//! A device trades a pairing code for its key at `/devices/v0/claim`. Every other request carries
//! that key as `Authorization: Bearer …`. Past the key:
//! - a phone gets the phone's routes and list ([`super::phone`]);
//! - a computer gets everything, passed to `LoomWatch` here as a local program's request would
//!   be ([`super::pass`]). The computer it comes from applies this computer's own address and
//!   same-page checks before anything leaves it ([`super::connected`]).

use std::sync::Arc;

use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use tower::ServiceExt as _;

use super::pass::{no_store, not_running, pass_on, problem};
use super::phone::{self, Daemon, Phone};
use super::{Devices, Kind, Refused};

struct Door {
    devices: Arc<Devices>,
    /// The phone's routes, behind the key check.
    phone: Router,
    /// `LoomWatch` here, for a computer's requests.
    daemon: Daemon,
}

/// The door, in front of `LoomWatch` at `home` (such as `http://127.0.0.1:3000`).
pub fn router(devices: Arc<Devices>, home: &str) -> Router {
    let door = Arc::new(Door {
        devices,
        phone: phone::router(Phone::new(Daemon::at(home))),
        daemon: Daemon::at(home),
    });
    let claim = Router::new()
        .route("/devices/v0/claim", post(claim))
        .layer(DefaultBodyLimit::max(4 * 1024));
    claim.fallback(through).with_state(door)
}

#[derive(Deserialize)]
struct Claim {
    code: String,
    /// What the device calls itself, such as "Nghia's iPhone".
    #[serde(default)]
    name: Option<String>,
    /// What the device is, when it says: it then gets only a code made for its kind.
    #[serde(default)]
    kind: Option<Kind>,
}

/// Trades a pairing code for this device's key, shown this once.
async fn claim(State(door): State<Arc<Door>>, Json(claim): Json<Claim>) -> Response {
    match door
        .devices
        .claim(&claim.code, claim.name.as_deref(), claim.kind)
    {
        Ok((device, key)) => {
            let mut response = Json(json!({"key": key, "device": device})).into_response();
            no_store(response.headers_mut());
            response
        }
        Err(Refused::NoSuchCode) => problem(
            StatusCode::NOT_FOUND,
            "This code doesn't work any more. On the computer that runs LoomWatch, press New code under Your devices.",
        ),
        Err(Refused::MadeFor(Kind::Phone)) => problem(
            StatusCode::CONFLICT,
            "This code is for a phone. On the computer that runs LoomWatch, choose Computer and copy the new link.",
        ),
        Err(Refused::MadeFor(Kind::Computer)) => problem(
            StatusCode::CONFLICT,
            "This code is for a computer. On the computer that runs LoomWatch, choose Phone and scan the new code.",
        ),
    }
}

/// Set on every request a device makes through the door, so `LoomWatch` here can keep a few things
/// to its own screen. Whatever a device sent in its place is dropped.
pub const VIA_DEVICE: &str = "x-loomwatch-via-device";

/// Every request but a claim: the device's key, then what its kind may do.
async fn through(State(door): State<Arc<Door>>, mut request: Request) -> Response {
    let device = bearer(request.headers()).and_then(|key| door.devices.check(key));
    let Some(device) = device else {
        return problem(
            StatusCode::UNAUTHORIZED,
            "This device isn't connected any more. On the computer that runs LoomWatch, open Your devices and connect it again.",
        );
    };
    // The key opened the door; it goes no further. A second guard: neither the phone's calls nor
    // `pass::goes_on` carry it on either, and that is what the tests pin.
    request.headers_mut().remove(header::AUTHORIZATION);
    request
        .headers_mut()
        .insert(VIA_DEVICE, HeaderValue::from_static("1"));
    match device.kind {
        Kind::Phone => match door.phone.clone().oneshot(request).await {
            Ok(response) => response,
            Err(never) => match never {},
        },
        Kind::Computer => pass_on(door.daemon.client(), door.daemon.base(), request, None)
            .await
            .unwrap_or_else(not_running),
    }
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}
