//! Sharing the door through a stand-in Tailscale that records every command it gets: the real one
//! is never run, so nothing on this computer's tailnet changes.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use super::reach::{Reach, reach};

const NAME: &str = "my-mac.tail1234.ts.net";

/// Answers `status`, `serve status` and `serve --bg` from files next to it, and writes each command
/// to `calls`. With a `needs-ok` file, `serve --bg` asks for the person's OK and waits, as Tailscale
/// does when the tailnet doesn't allow sharing yet.
const STAND_IN: &str = r#"#!/bin/sh
dir=$(dirname "$0")
echo "$*" >> "$dir/calls"
case "$*" in
  "status --json") cat "$dir/status.json" ;;
  "serve status --json") cat "$dir/serving.json" ;;
  "serve --bg"*)
    if [ -f "$dir/needs-ok" ]; then
      echo "Serve is not enabled on your tailnet."
      echo "To enable, visit:"
      echo
      echo "         https://login.tailscale.com/f/serve?node=n123"
      echo
      echo "Waiting for approval..."
      exec sleep 60
    fi
    cp "$dir/serving-after.json" "$dir/serving.json"
    echo "Available within your tailnet: https://$NAME:8443/"
    ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
"#;

struct StandIn {
    dir: PathBuf,
}

impl StandIn {
    fn new(test: &str, serving: &str, after: &str) -> Self {
        let dir =
            std::env::temp_dir().join(format!("loomwatch-reach-{test}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let program = dir.join("tailscale");
        std::fs::write(&program, STAND_IN).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(
            dir.join("status.json"),
            format!(r#"{{"BackendState": "Running", "Self": {{"DNSName": "{NAME}."}}}}"#),
        )
        .unwrap();
        std::fs::write(dir.join("serving.json"), serving).unwrap();
        std::fs::write(dir.join("serving-after.json"), after).unwrap();
        Self { dir }
    }

    fn program(&self) -> PathBuf {
        self.dir.join("tailscale")
    }

    fn calls(&self) -> Vec<String> {
        read_lines(&self.dir.join("calls"))
    }
}

impl Drop for StandIn {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn read_lines(path: &Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}

/// This computer already shares another service on 443.
fn other_on_443() -> String {
    format!(
        r#"{{"TCP": {{"443": {{"HTTPS": true}}}},
            "Web": {{"{NAME}:443": {{"Handlers": {{"/": {{"Proxy": "http://127.0.0.1:8123"}}}}}}}}}}"#
    )
}

fn other_and_door() -> String {
    format!(
        r#"{{"TCP": {{"443": {{"HTTPS": true}}, "8443": {{"HTTPS": true}}}},
            "Web": {{"{NAME}:443": {{"Handlers": {{"/": {{"Proxy": "http://127.0.0.1:8123"}}}}}},
                     "{NAME}:8443": {{"Handlers": {{"/": {{"Proxy": "http://127.0.0.1:3440"}}}}}}}}}}"#
    )
}

#[tokio::test]
async fn the_door_is_shared_on_a_free_port_beside_what_is_already_shared() {
    let tailscale = StandIn::new("free-port", &other_on_443(), &other_and_door());
    let reached = reach(
        Some(&tailscale.program()),
        3440,
        Duration::from_secs(5),
        true,
    )
    .await;
    assert_eq!(
        reached,
        Reach::Ready {
            address: format!("https://{NAME}:8443")
        }
    );
    let calls = tailscale.calls();
    assert_eq!(
        calls
            .iter()
            .filter(|call| call.starts_with("serve --"))
            .collect::<Vec<_>>(),
        ["serve --bg --yes --https=8443 http://127.0.0.1:3440"],
        "one share, on 8443: {calls:?}"
    );
}

#[tokio::test]
async fn a_door_shared_already_is_not_shared_again() {
    let tailscale = StandIn::new("shared", &other_and_door(), &other_and_door());
    let reached = reach(
        Some(&tailscale.program()),
        3440,
        Duration::from_secs(5),
        true,
    )
    .await;
    assert_eq!(
        reached,
        Reach::Ready {
            address: format!("https://{NAME}:8443")
        }
    );
    assert_eq!(tailscale.calls(), ["status --json", "serve status --json"]);
}

#[tokio::test]
async fn a_tailnet_that_doesnt_allow_sharing_yet_gives_the_page_to_allow_it() {
    let tailscale = StandIn::new("needs-ok", "{}", "{}");
    std::fs::write(tailscale.dir.join("needs-ok"), "").unwrap();
    let started = Instant::now();
    let reached = reach(
        Some(&tailscale.program()),
        3440,
        Duration::from_secs(20),
        true,
    )
    .await;
    assert_eq!(
        reached,
        Reach::NeedsOk {
            url: "https://login.tailscale.com/f/serve?node=n123".into()
        }
    );
    // As soon as the page is printed, not when the wait runs out.
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "it stops waiting once it has the page: {:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn tailscale_that_doesnt_answer_is_off() {
    let tailscale = StandIn::new("off", "{}", "{}");
    std::fs::write(tailscale.dir.join("status.json"), "").unwrap();
    std::fs::write(
        tailscale.dir.join("tailscale"),
        "#!/bin/sh\necho 'failed to connect to local Tailscale daemon' >&2\nexit 1\n",
    )
    .unwrap();
    let reached = reach(
        Some(&tailscale.program()),
        3440,
        Duration::from_secs(2),
        true,
    )
    .await;
    assert_eq!(reached, Reach::TailscaleOff);
}

#[tokio::test]
async fn a_door_not_shared_is_left_alone_until_the_person_asks() {
    let tailscale = StandIn::new("not-asked", &other_on_443(), &other_and_door());
    let reached = reach(
        Some(&tailscale.program()),
        3440,
        Duration::from_secs(5),
        false,
    )
    .await;
    assert_eq!(reached, Reach::NotShared);
    assert_eq!(
        tailscale.calls(),
        ["status --json", "serve status --json"],
        "nothing was shared"
    );
}
