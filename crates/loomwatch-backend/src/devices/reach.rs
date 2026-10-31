//! Bringing other devices to the door through the person's own Tailscale (ADR 0102), so nobody
//! types `tailscale serve`: finds Tailscale's command line, says whether the door is shared on the
//! tailnet, and shares it on a free HTTPS port when the person asks. It never changes or removes
//! anything Tailscale already shares.

use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

/// The ports Tailscale shares HTTPS on, in the order tried.
pub const HTTPS_PORTS: [u16; 3] = [443, 8443, 10000];

/// How long `tailscale serve` may take. It waits, without end, for the person's OK when the tailnet
/// doesn't allow sharing yet; it is stopped as soon as it has printed the page to give it on.
pub const SHARE_LIMIT: Duration = Duration::from_secs(15);

/// A read such as `tailscale status` answers at once, or Tailscale is stuck.
const READ_LIMIT: Duration = Duration::from_secs(10);

/// Whether other devices can reach the door, and what stands in the way when they can't.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Reach {
    /// Devices reach the door at this address.
    Ready { address: String },
    /// Tailscale is on and signed in, but the door isn't shared on it yet.
    NotShared,
    /// Tailscale isn't on this computer.
    NoTailscale,
    /// Tailscale is installed but not running, or turned off.
    TailscaleOff,
    /// This computer isn't signed in to Tailscale. `url` signs it in, when Tailscale gave one.
    SignedOut { url: Option<String> },
    /// The tailnet must allow sharing once, on this page.
    NeedsOk { url: String },
    /// Every port Tailscale shares HTTPS on already shares something else.
    PortsTaken,
    /// Tailscale answered in a way this doesn't understand.
    Failed { message: String },
}

/// The link a device opens to pair: `loomwatch://pair?address=…&code=…`, shown as a QR code too.
#[must_use]
pub fn pair_link(address: &str, code: &str) -> String {
    let query: String =
        reqwest::Url::parse_with_params("loomwatch://pair", [("address", address), ("code", code)])
            .map_or_else(
                |_| String::new(),
                |url| url.query().unwrap_or_default().to_owned(),
            );
    format!("loomwatch://pair?{query}")
}

/// What to do, from `tailscale status --json` and `tailscale serve status --json`.
#[derive(Debug, PartialEq, Eq)]
pub enum Plan {
    Done(Reach),
    /// Share the door on this HTTPS port of `name`.
    Share {
        name: String,
        https_port: u16,
    },
}

/// Decides from Tailscale's state alone, without running anything.
#[must_use]
pub fn plan(status: &Value, serving: &Value, door_port: u16) -> Plan {
    match status.get("BackendState").and_then(Value::as_str) {
        Some("Running") => {}
        Some("NeedsLogin" | "NeedsMachineAuth") => {
            let url = status
                .get("AuthURL")
                .and_then(Value::as_str)
                .filter(|url| !url.is_empty())
                .map(str::to_owned);
            return Plan::Done(Reach::SignedOut { url });
        }
        _ => return Plan::Done(Reach::TailscaleOff),
    }
    let Some(name) = status
        .pointer("/Self/DNSName")
        .and_then(Value::as_str)
        .map(|name| name.trim_end_matches('.'))
        .filter(|name| !name.is_empty())
    else {
        return Plan::Done(Reach::Failed {
            message: "Tailscale didn't say this computer's name".into(),
        });
    };
    // Shared already: the door behind one of this computer's HTTPS ports.
    if let Some(web) = serving.get("Web").and_then(Value::as_object) {
        for (host_port, config) in web {
            let Some((host, port)) = host_port.rsplit_once(':') else {
                continue;
            };
            let proxy = config
                .pointer("/Handlers/~1/Proxy")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if host == name && points_at(proxy, door_port) {
                return Plan::Done(Reach::Ready {
                    address: address(name, port.parse().unwrap_or(443)),
                });
            }
        }
    }
    let taken = serving.get("TCP").and_then(Value::as_object);
    match HTTPS_PORTS
        .into_iter()
        .find(|port| taken.is_none_or(|taken| !taken.contains_key(&port.to_string())))
    {
        Some(https_port) => Plan::Share {
            name: name.to_owned(),
            https_port,
        },
        None => Plan::Done(Reach::PortsTaken),
    }
}

/// How a device reaches `name` on `port`.
fn address(name: &str, port: u16) -> String {
    if port == 443 {
        format!("https://{name}")
    } else {
        format!("https://{name}:{port}")
    }
}

/// Whether a Serve proxy target is the door on this computer.
fn points_at(proxy: &str, door_port: u16) -> bool {
    let target = proxy.strip_prefix("http://").unwrap_or(proxy);
    let target = target.trim_end_matches('/');
    target == format!("127.0.0.1:{door_port}") || target == format!("localhost:{door_port}")
}

/// The page Tailscale asks the person to open, in what `tailscale serve` printed. Links to its docs
/// are not it.
#[must_use]
pub fn approval_url(printed: &str) -> Option<String> {
    printed
        .split_whitespace()
        .map(|word| word.trim_end_matches(['.', ',', ')']))
        .find(|word| word.starts_with("https://") && !word.contains("tailscale.com/kb"))
        .map(str::to_owned)
}

/// Finds Tailscale and says whether devices reach the door on `door_port`. With `share`, the person
/// asked for it, so a door not shared yet is shared. `program` is Tailscale's command line when
/// known; `share_limit` is how long `tailscale serve` may wait for the person's OK.
pub async fn reach(
    program: Option<&Path>,
    door_port: u16,
    share_limit: Duration,
    share: bool,
) -> Reach {
    let found = crate::platform::tailscale_program();
    let Some(program) = program.or(found.as_deref()) else {
        return Reach::NoTailscale;
    };
    let Some(status) = read_json(program, &["status", "--json"]).await else {
        return Reach::TailscaleOff;
    };
    // `serve status` answers `{}` when nothing is shared.
    let serving = read_json(program, &["serve", "status", "--json"])
        .await
        .unwrap_or(Value::Null);
    let (name, https_port) = match plan(&status, &serving, door_port) {
        Plan::Done(reach) => return reach,
        Plan::Share { .. } if !share => return Reach::NotShared,
        Plan::Share { name, https_port } => (name, https_port),
    };
    let https = format!("--https={https_port}");
    let target = format!("http://127.0.0.1:{door_port}");
    let mut ran = run(
        program,
        &["serve", "--bg", "--yes", &https, &target],
        share_limit,
        asks_for_ok,
    )
    .await;
    // Tailscale before `--yes` (1.7x) has no prompts to skip.
    if ran.printed.contains("flag provided but not defined") {
        ran = run(
            program,
            &["serve", "--bg", &https, &target],
            share_limit,
            asks_for_ok,
        )
        .await;
    }
    if !ran.succeeded {
        return match approval_url(&ran.printed) {
            Some(url) => Reach::NeedsOk { url },
            None => Reach::Failed {
                message: last_line(&ran.printed),
            },
        };
    }
    // Read back what Tailscale now shares, rather than trusting what was asked.
    let serving = read_json(program, &["serve", "status", "--json"])
        .await
        .unwrap_or(Value::Null);
    match plan(&status, &serving, door_port) {
        Plan::Done(reach) => reach,
        Plan::Share { .. } => Reach::Failed {
            message: format!("Tailscale took the setting but doesn't share {name} yet"),
        },
    }
}

/// Whether `tailscale serve` is waiting for the person's OK, with the page printed ("To enable,
/// visit: https://…"). A share that worked prints its own address, which is not this.
fn asks_for_ok(printed: &str) -> bool {
    printed.contains("visit:") && approval_url(printed).is_some()
}

async fn read_json(program: &Path, args: &[&str]) -> Option<Value> {
    let output = tokio::time::timeout(
        READ_LIMIT,
        Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    if !output.status.success() {
        return None;
    }
    serde_json::from_slice(&output.stdout).ok()
}

struct Ran {
    succeeded: bool,
    /// What it printed, both streams.
    printed: String,
}

/// Runs `program` for at most `limit`, or until what it printed is `enough`, keeping what it printed
/// even when it has to be stopped.
async fn run(program: &Path, args: &[&str], limit: Duration, enough: fn(&str) -> bool) -> Ran {
    let spawned = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => {
            return Ran {
                succeeded: false,
                printed: error.to_string(),
            };
        }
    };
    let printed = Arc::new(Mutex::new(String::new()));
    let readers = [
        child
            .stdout
            .take()
            .map(|pipe| tokio::spawn(drain(pipe, printed.clone()))),
        child
            .stderr
            .take()
            .map(|pipe| tokio::spawn(drain(pipe, printed.clone()))),
    ];
    let deadline = tokio::time::Instant::now() + limit;
    let finished = loop {
        tokio::select! {
            status = child.wait() => break status.ok(),
            () = tokio::time::sleep(Duration::from_millis(200)) => {
                let said_enough = printed.lock().is_ok_and(|text| enough(&text));
                if said_enough || tokio::time::Instant::now() >= deadline {
                    let _ = child.kill().await;
                    break None;
                }
            }
        }
    };
    for reader in readers.into_iter().flatten() {
        let _ = tokio::time::timeout(Duration::from_secs(1), reader).await;
    }
    let printed = printed.lock().map(|text| text.clone()).unwrap_or_default();
    Ran {
        succeeded: finished.is_some_and(|status| status.success()),
        printed,
    }
}

async fn drain(mut pipe: impl AsyncRead + Unpin, into: Arc<Mutex<String>>) {
    let mut buffer = [0u8; 1024];
    while let Ok(read) = pipe.read(&mut buffer).await {
        if read == 0 {
            break;
        }
        if let Ok(mut text) = into.lock() {
            text.push_str(&String::from_utf8_lossy(&buffer[..read]));
        }
    }
}

fn last_line(printed: &str) -> String {
    let line = printed
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("Tailscale stopped without saying why");
    line.chars().take(200).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NAME: &str = "my-mac.tail1234.ts.net";

    fn running() -> Value {
        json!({"BackendState": "Running", "Self": {"DNSName": format!("{NAME}.")}})
    }

    #[test]
    fn a_door_already_shared_is_ready_on_its_port() {
        let alone = json!({
            "TCP": {"443": {"HTTPS": true}},
            "Web": {format!("{NAME}:443"): {"Handlers": {"/": {"Proxy": "http://127.0.0.1:3440"}}}}
        });
        assert_eq!(
            plan(&running(), &alone, 3440),
            Plan::Done(Reach::Ready {
                address: format!("https://{NAME}")
            })
        );
        let beside_another = json!({
            "TCP": {"443": {"HTTPS": true}, "8443": {"HTTPS": true}},
            "Web": {
                format!("{NAME}:443"): {"Handlers": {"/": {"Proxy": "http://127.0.0.1:8123"}}},
                format!("{NAME}:8443"): {"Handlers": {"/": {"Proxy": "localhost:3440"}}}
            }
        });
        assert_eq!(
            plan(&running(), &beside_another, 3440),
            Plan::Done(Reach::Ready {
                address: format!("https://{NAME}:8443")
            })
        );
    }

    #[test]
    fn a_port_sharing_something_else_is_left_alone() {
        let other = json!({
            "TCP": {"443": {"HTTPS": true}},
            "Web": {format!("{NAME}:443"): {"Handlers": {"/": {"Proxy": "http://127.0.0.1:8123"}}}}
        });
        assert_eq!(
            plan(&running(), &other, 3440),
            Plan::Share {
                name: NAME.into(),
                https_port: 8443
            }
        );
        assert_eq!(
            plan(&running(), &json!({}), 3440),
            Plan::Share {
                name: NAME.into(),
                https_port: 443
            }
        );
        let all = json!({"TCP": {"443": {}, "8443": {}, "10000": {}}});
        assert_eq!(plan(&running(), &all, 3440), Plan::Done(Reach::PortsTaken));
    }

    #[test]
    fn tailscale_signed_out_or_off_says_so() {
        let signed_out =
            json!({"BackendState": "NeedsLogin", "AuthURL": "https://login.tailscale.com/a/abc"});
        assert_eq!(
            plan(&signed_out, &json!({}), 3440),
            Plan::Done(Reach::SignedOut {
                url: Some("https://login.tailscale.com/a/abc".into())
            })
        );
        assert_eq!(
            plan(
                &json!({"BackendState": "NeedsLogin", "AuthURL": ""}),
                &json!({}),
                3440
            ),
            Plan::Done(Reach::SignedOut { url: None })
        );
        assert_eq!(
            plan(&json!({"BackendState": "Stopped"}), &json!({}), 3440),
            Plan::Done(Reach::TailscaleOff)
        );
        assert!(matches!(
            plan(&json!({"BackendState": "Running"}), &json!({}), 3440),
            Plan::Done(Reach::Failed { .. })
        ));
    }

    #[test]
    fn the_app_reads_these_shapes() {
        let ready = Reach::Ready {
            address: format!("https://{NAME}:8443"),
        };
        assert_eq!(
            serde_json::to_string(&ready).unwrap(),
            r#"{"state":"ready","address":"https://my-mac.tail1234.ts.net:8443"}"#
        );
        assert_eq!(
            serde_json::to_string(&Reach::NotShared).unwrap(),
            r#"{"state":"notShared"}"#
        );
        let waiting = Reach::NeedsOk {
            url: "https://login.tailscale.com/f/serve?node=n1".into(),
        };
        assert_eq!(
            serde_json::to_string(&waiting).unwrap(),
            r#"{"state":"needsOk","url":"https://login.tailscale.com/f/serve?node=n1"}"#
        );
        assert_eq!(
            serde_json::to_string(&Reach::SignedOut { url: None }).unwrap(),
            r#"{"state":"signedOut","url":null}"#
        );
        assert_eq!(
            serde_json::to_string(&Reach::TailscaleOff).unwrap(),
            r#"{"state":"tailscaleOff"}"#
        );
    }

    #[test]
    fn the_pairing_link_carries_the_address_and_the_code() {
        assert_eq!(
            pair_link("https://my-mac.tail1234.ts.net:8443", "a-b_c"),
            "loomwatch://pair?address=https%3A%2F%2Fmy-mac.tail1234.ts.net%3A8443&code=a-b_c"
        );
    }

    #[test]
    fn the_page_to_give_the_ok_on_is_found_in_what_serve_printed() {
        let printed = "Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=n123\n\nWaiting for approval...";
        assert_eq!(
            approval_url(printed).as_deref(),
            Some("https://login.tailscale.com/f/serve?node=n123")
        );
        assert_eq!(
            approval_url("error: see https://tailscale.com/kb/1312/serve."),
            None
        );
        assert!(asks_for_ok(printed));
        // A share that worked prints its address: that is no reason to stop it.
        assert!(!asks_for_ok(
            "Available within your tailnet:\n\nhttps://my-mac.tail1234.ts.net:8443/\n|-- proxy http://127.0.0.1:3440\n\nServe started and running in the background."
        ));
    }
}
