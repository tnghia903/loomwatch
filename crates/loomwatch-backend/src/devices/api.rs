//! Managing connected devices, on this computer's own address only (ADR 0102): the list, a
//! pairing code for a phone or a computer, Remove, and sharing the door through Tailscale.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{DefaultBodyLimit, Path, Request, State};
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use super::reach::{self, Reach};
use super::{Devices, Kind};
use crate::api::ApiError;

/// Whether other devices can come in, as `loomwatchd` started.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Door {
    /// The door answers here.
    Open(SocketAddr),
    /// `LOOMWATCH_DEVICES_LISTEN=off`, or `LoomWatch` behind a container's port.
    TurnedOff,
    /// It should have opened and didn't, such as when its port is taken.
    Unavailable,
}

impl Door {
    fn open(self) -> Option<SocketAddr> {
        match self {
            Self::Open(address) => Some(address),
            Self::TurnedOff | Self::Unavailable => None,
        }
    }
}

struct Manage {
    devices: Arc<Devices>,
    door: Door,
    /// Tailscale's command line, when not the one on this computer (tests).
    tailscale: Option<PathBuf>,
}

/// Tailscale's command line, when it isn't in one of the usual places.
pub const TAILSCALE_ENV: &str = "LOOMWATCH_TAILSCALE";

/// The routes. Mount on a loopback listener only.
pub fn router(devices: Arc<Devices>, door: Door) -> Router {
    let tailscale = std::env::var_os(TAILSCALE_ENV)
        .filter(|program| !program.is_empty())
        .map(PathBuf::from);
    router_with(devices, door, tailscale)
}

/// The routes, reading Tailscale through `tailscale` when given.
pub fn router_with(devices: Arc<Devices>, door: Door, tailscale: Option<PathBuf>) -> Router {
    Router::new()
        .route("/api/devices", get(list))
        .route("/api/devices/codes", post(make_code))
        .route("/api/devices/reach", get(reach_now).post(share))
        .route("/api/devices/{id}", delete(remove))
        .layer(DefaultBodyLimit::max(4 * 1024))
        .route_layer(middleware::from_fn(protect))
        .route_layer(middleware::from_fn(crate::watch_api::local_evidence))
        .with_state(Arc::new(Manage {
            devices,
            door,
            tailscale,
        }))
}

/// A change needs the header `LoomWatch`'s own page sends.
async fn protect(request: Request, next: Next) -> Response {
    if request.method() != axum::http::Method::GET
        && request
            .headers()
            .get("x-loomwatch-request")
            .is_none_or(|value| value != "1")
    {
        return failure(
            StatusCode::FORBIDDEN,
            "Open LoomWatch on this computer to connect a device.",
        );
    }
    next.run(request).await
}

/// Every connected device, and whether the door is open, or turned off on purpose.
async fn list(State(manage): State<Arc<Manage>>) -> Response {
    Json(json!({
        "devices": manage.devices.list(),
        "door": manage.door.open().map(|door| door.to_string()),
        "doorOff": manage.door == Door::TurnedOff,
    }))
    .into_response()
}

#[derive(Deserialize)]
struct NewCode {
    kind: Kind,
}

/// A pairing code for one kind of device, with the link that carries it when the door is shared.
async fn make_code(State(manage): State<Arc<Manage>>, Json(new): Json<NewCode>) -> Response {
    let Some(door) = manage.door.open() else {
        return closed();
    };
    let reach = reach::reach(
        manage.tailscale.as_deref(),
        door.port(),
        reach::SHARE_LIMIT,
        false,
    )
    .await;
    let code = manage.devices.make_code(new.kind);
    let link = match &reach {
        Reach::Ready { address } => Some(reach::pair_link(address, &code.code)),
        _ => None,
    };
    let mut response = Json(json!({
        "code": code.code,
        "kind": code.kind,
        "expiresAt": code.expires_at,
        "qr": link.as_deref().and_then(qr),
        "link": link,
        "reach": reach,
    }))
    .into_response();
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    response
}

/// Modules of quiet edge a QR code reader needs around the code.
const QUIET: usize = 4;

/// `link` as a QR code a phone's Camera reads: `{size, path}`, the dark modules as one SVG path on
/// a `size` by `size` square, its quiet edge included.
fn qr(link: &str) -> Option<serde_json::Value> {
    use std::fmt::Write as _;
    let code = qrcode::QrCode::new(link.as_bytes()).ok()?;
    let width = code.width();
    let mut path = String::new();
    for (index, color) in code.to_colors().iter().enumerate() {
        if *color == qrcode::Color::Dark {
            let (x, y) = (index % width + QUIET, index / width + QUIET);
            let _ = write!(path, "M{x} {y}h1v1h-1z");
        }
    }
    Some(json!({"size": width + 2 * QUIET, "path": path}))
}

/// Whether other devices can reach the door now. Reads Tailscale; changes nothing.
async fn reach_now(State(manage): State<Arc<Manage>>) -> Response {
    let Some(door) = manage.door.open() else {
        return closed();
    };
    Json(
        reach::reach(
            manage.tailscale.as_deref(),
            door.port(),
            reach::SHARE_LIMIT,
            false,
        )
        .await,
    )
    .into_response()
}

/// Shares the door through this computer's Tailscale, when the person asks for it.
async fn share(State(manage): State<Arc<Manage>>) -> Response {
    let Some(door) = manage.door.open() else {
        return closed();
    };
    Json(
        reach::reach(
            manage.tailscale.as_deref(),
            door.port(),
            reach::SHARE_LIMIT,
            true,
        )
        .await,
    )
    .into_response()
}

/// Removes a device: its key stops working at once.
async fn remove(State(manage): State<Arc<Manage>>, Path(id): Path<String>) -> Response {
    if manage.devices.remove(&id) {
        StatusCode::NO_CONTENT.into_response()
    } else {
        failure(StatusCode::NOT_FOUND, "That device isn't connected.")
    }
}

fn closed() -> Response {
    failure(
        StatusCode::CONFLICT,
        "Other devices can't connect right now. Quit LoomWatch and open it again.",
    )
}

fn failure(status: StatusCode, message: &str) -> Response {
    ApiError::new(status, message.to_owned()).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_link_is_a_qr_code_with_its_three_corners_and_a_quiet_edge() {
        let link = "loomwatch://pair?address=https%3A%2F%2Fmy-mac.tail1234.ts.net%3A8443&code=abc";
        let drawn = qr(link).unwrap();
        let size = usize::try_from(drawn["size"].as_u64().unwrap()).unwrap();
        let width = qrcode::QrCode::new(link.as_bytes()).unwrap().width();
        assert_eq!(size, width + 2 * QUIET);
        let path = drawn["path"].as_str().unwrap();
        // The finder squares' outer corners: top left, top right, bottom left.
        let far = width + QUIET - 1;
        for corner in [
            format!("M{QUIET} {QUIET}h"),
            format!("M{far} {QUIET}h"),
            format!("M{QUIET} {far}h"),
        ] {
            assert!(path.contains(&corner), "no {corner} in the code");
        }
        // Nothing drawn in the quiet edge.
        assert!(!path.contains("M0 ") && !path.contains(" 0h"));
    }
}
