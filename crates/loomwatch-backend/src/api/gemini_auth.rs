//! Whether Gemini CLI can work with another app, read from its own settings without starting it.
//!
//! Gemini CLI has no sign-in status command (see [`super::SignInCheck`]). Started over ACP
//! (`gemini --acp`), it signs in the way `security.auth.selectedType` in `~/.gemini/settings.json`
//! says, and with a Gemini API key when nothing is chosen. Two setups fail every check, and both
//! used to read as ready until a check started Gemini:
//!
//! - **A Google sign-in** (`oauth-personal`). Google refuses it for other apps: `session/new`
//!   answers "This client is no longer supported for Gemini Code Assist for individuals."
//! - **API-key sign-in with no key.** `session/new` answers "Gemini API key is missing or not
//!   configured."
//!
//! Read against Gemini CLI 0.54.4 (`AcpSessionManager.newSession`, `createContentGeneratorConfig`,
//! `loadApiKey`, `findEnvFile`). As with the status commands, only a plain answer counts: settings
//! this does not understand, an administrator's or a team folder's own settings, and a key it
//! cannot rule out all leave the verdict to the handshake, as before.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

/// The catalog id these checks are for.
pub(super) const HARNESS_ID: &str = "gemini";

/// Why Gemini CLI can't work with another app.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Unusable {
    /// API-key sign-in, chosen or the ACP default, with no key anywhere Gemini CLI looks.
    NoApiKey,
    /// A personal Google sign-in, which Google refuses for other apps.
    GoogleSignIn,
}

impl Unusable {
    /// What the operator does about it, in words the UI prints verbatim.
    pub(super) fn reason(self) -> &'static str {
        match self {
            Self::NoApiKey => {
                "Gemini CLI needs a Gemini API key to work with other apps: set GEMINI_API_KEY, then restart LoomWatch."
            }
            // The key alone is not enough here: a chosen Google sign-in wins over it.
            Self::GoogleSignIn => {
                "Gemini CLI needs a Gemini API key to work with other apps, not a Google sign-in: set GEMINI_API_KEY, run \"gemini\" and choose Use Gemini API Key under /auth, then restart LoomWatch."
            }
        }
    }
}

/// The same two verdicts, read from what Gemini CLI said when a check did start it: the settings
/// can look fine (a key this check could not rule out) and still fail.
pub(super) fn unusable_from_error(detail: &str) -> Option<Unusable> {
    if detail.contains("Gemini API key is missing or not configured") {
        Some(Unusable::NoApiKey)
    } else if detail.contains("This client is no longer supported") {
        Some(Unusable::GoogleSignIn)
    } else {
        None
    }
}

/// Look at Gemini CLI's settings, without starting it. `home` holds its `.gemini` folder;
/// `workspace` is where a check starts it, which decides the `.env` files it loads.
pub(super) async fn check(home: Option<&Path>, workspace: &Path) -> Option<Unusable> {
    #[cfg(test)]
    if let Some(fake) = tests::fake_environment() {
        return settle(fake.read(workspace), !fake.saved_key);
    }
    let reading = read(home, workspace, &|name| std::env::var(name).ok());
    let no_key_saved = match (reading, home) {
        (Reading::NeedsSavedKey, Some(home)) => no_saved_key(home).await,
        _ => false,
    };
    settle(reading, no_key_saved)
}

/// What the settings and the environment say, before a key Gemini CLI saved itself is asked about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Reading {
    /// Usable as far as these files tell, or set up in a way this check does not judge.
    Unjudged,
    Unusable(Unusable),
    /// API-key sign-in with no key in the environment or a `.env` file. Gemini CLI's /auth
    /// dialog can still have saved one.
    NeedsSavedKey,
}

fn settle(reading: Reading, no_key_saved: bool) -> Option<Unusable> {
    match reading {
        Reading::Unjudged => None,
        Reading::Unusable(why) => Some(why),
        Reading::NeedsSavedKey => no_key_saved.then_some(Unusable::NoApiKey),
    }
}

#[cfg(target_os = "macos")]
const SYSTEM_SETTINGS: &str = "/Library/Application Support/GeminiCli/settings.json";
#[cfg(windows)]
const SYSTEM_SETTINGS: &str = "C:\\ProgramData\\gemini-cli\\settings.json";
#[cfg(not(any(target_os = "macos", windows)))]
const SYSTEM_SETTINGS: &str = "/etc/gemini-cli/settings.json";

fn read(home: Option<&Path>, workspace: &Path, var: &dyn Fn(&str) -> Option<String>) -> Reading {
    let Some(home) = home else {
        return Reading::Unjudged;
    };
    // An administrator's settings can choose or enforce the sign-in, and a team folder's own
    // `.gemini/settings.json` overrides the person's: neither is judged here.
    let system = var("GEMINI_CLI_SYSTEM_SETTINGS_PATH")
        .map_or_else(|| PathBuf::from(SYSTEM_SETTINGS), PathBuf::from);
    let system_defaults = var("GEMINI_CLI_SYSTEM_DEFAULTS_PATH").map_or_else(
        || system.with_file_name("system-defaults.json"),
        PathBuf::from,
    );
    let user_settings = home.join(".gemini").join("settings.json");
    let workspace_settings = workspace.join(".gemini").join("settings.json");
    // Started in the home folder, Gemini CLI reads that file once, as the person's settings.
    let same_file =
        || fs::canonicalize(&workspace_settings).ok() == fs::canonicalize(&user_settings).ok();
    if system.exists() || system_defaults.exists() || (workspace_settings.exists() && !same_file())
    {
        return Reading::Unjudged;
    }
    let Ok(selected) = selected_auth_type(&user_settings) else {
        return Reading::Unjudged;
    };

    let env_files: Vec<String> = env_files(home, workspace)
        .iter()
        .filter_map(|file| fs::read_to_string(file).ok())
        .collect();
    let set = |name: &str| {
        var(name).is_some_and(|value| !value.trim().is_empty())
            || env_files.iter().any(|text| defines(text, name))
    };
    match selected.as_deref() {
        // Nothing chosen: over ACP that is a Gemini API key, or a gateway when one is named.
        None if set("GOOGLE_GEMINI_BASE_URL") => Reading::Unjudged,
        None | Some("gemini-api-key") if set("GEMINI_API_KEY") => Reading::Unjudged,
        None | Some("gemini-api-key") => Reading::NeedsSavedKey,
        // A Google Cloud project is how a paid Gemini Code Assist sign-in is set up. Google
        // refuses only the individual one.
        Some("oauth-personal") if set("GOOGLE_CLOUD_PROJECT") || set("GOOGLE_CLOUD_PROJECT_ID") => {
            Reading::Unjudged
        }
        Some("oauth-personal") => Reading::Unusable(Unusable::GoogleSignIn),
        // Vertex AI, Cloud Shell, a gateway, or a kind of sign-in newer than this check.
        Some(_) => Reading::Unjudged,
    }
}

/// `security.auth.selectedType` from a settings file: `Ok(None)` when the file or the value is
/// absent, `Err` when the file can't be read as JSON. Gemini CLI allows comments in it, which this
/// does not; such a file is simply not judged.
fn selected_auth_type(path: &Path) -> Result<Option<String>, ()> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(()),
    };
    let settings: Value = serde_json::from_str(&text).map_err(|_| ())?;
    Ok(settings
        .pointer("/security/auth/selectedType")
        .and_then(Value::as_str)
        .map(str::to_owned))
}

/// Every `.env` file Gemini CLI could load when started in `workspace`: `.gemini/.env`, then
/// `.env`, in each folder from `workspace` up, then the same two in `home`. Gemini CLI loads only
/// the first it finds (and skips `.gemini/.env` in a folder it doesn't trust); a key in any of them
/// is enough to leave the verdict to the handshake.
fn env_files(home: &Path, workspace: &Path) -> Vec<PathBuf> {
    workspace
        .ancestors()
        .chain([home])
        .flat_map(|folder| [folder.join(".gemini").join(".env"), folder.join(".env")])
        .collect()
}

/// Whether a `.env` file sets `name` to something, as the `dotenv` package Gemini CLI uses reads
/// it: `NAME=value`, optionally after `export`, optionally quoted; `#` starts a comment.
fn defines(text: &str, name: &str) -> bool {
    text.lines().any(|line| {
        let line = line.trim_start();
        let line = line.strip_prefix("export ").map_or(line, str::trim_start);
        let Some((key, value)) = line.split_once('=') else {
            return false;
        };
        if key.trim_end() != name {
            return false;
        }
        let value = value.trim();
        let value = match value.chars().next() {
            Some(quote @ ('"' | '\'' | '`')) => value[1..].split(quote).next().unwrap_or_default(),
            _ => value.split('#').next().unwrap_or_default(),
        };
        !value.trim().is_empty()
    })
}

/// True only when Gemini CLI plainly has no key saved through its /auth dialog, which keeps it in
/// the login keychain on macOS (service `gemini-cli-api-key`, account `default-api-key`).
#[cfg_attr(not(target_os = "macos"), allow(clippy::unused_async))]
async fn no_saved_key(home: &Path) -> bool {
    // Gemini CLI's encrypted fallback file can hold a key or a Google sign-in, and only Gemini CLI
    // can read it, so while it exists a saved key can't be ruled out.
    if home
        .join(".gemini")
        .join("gemini-credentials.json")
        .exists()
    {
        return false;
    }
    #[cfg(target_os = "macos")]
    {
        keychain_lacks("gemini-cli-api-key", "default-api-key").await
    }
    // Elsewhere the key sits in a secret service this check does not open.
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Whether the login keychain plainly has no such item. Asks for its attributes only, never its
/// secret, so macOS shows no prompt.
#[cfg(target_os = "macos")]
async fn keychain_lacks(service: &str, account: &str) -> bool {
    let status = tokio::time::timeout(
        super::SIGN_IN_CHECK_TIMEOUT,
        tokio::process::Command::new("/usr/bin/security")
            .args(["find-generic-password", "-s", service, "-a", account])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .status(),
    )
    .await;
    // 44 is `security`'s "The specified item could not be found in the keychain."
    matches!(status, Ok(Ok(status)) if status.code() == Some(44))
}

#[cfg(test)]
pub(super) mod tests {
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::rc::Rc;

    use uuid::Uuid;

    use super::*;

    /// A made-up home, environment and keychain for [`check`], so a test's verdict never depends
    /// on how Gemini CLI is set up on the computer running it.
    #[derive(Debug, Clone)]
    pub(in crate::api) struct FakeEnvironment {
        pub(in crate::api) home: PathBuf,
        pub(in crate::api) vars: HashMap<String, String>,
        /// Gemini CLI saved a key itself, or one can't be ruled out.
        pub(in crate::api) saved_key: bool,
    }

    impl FakeEnvironment {
        /// No settings, no key: what a fresh Gemini CLI install looks like over ACP.
        pub(in crate::api) fn new(home: &Path) -> Self {
            let mut vars = HashMap::new();
            // Never the real administrator's settings.
            let nowhere = home.join("no-system-settings").join("settings.json");
            vars.insert(
                "GEMINI_CLI_SYSTEM_SETTINGS_PATH".to_owned(),
                nowhere.to_string_lossy().into_owned(),
            );
            Self {
                home: home.to_path_buf(),
                vars,
                saved_key: false,
            }
        }

        pub(in crate::api) fn with_var(mut self, name: &str, value: &str) -> Self {
            self.vars.insert(name.to_owned(), value.to_owned());
            self
        }

        pub(super) fn read(&self, workspace: &Path) -> Reading {
            read(Some(self.home.as_path()), workspace, &|name| {
                self.vars.get(name).cloned()
            })
        }
    }

    thread_local! {
        static FAKE: RefCell<Option<Rc<FakeEnvironment>>> = const { RefCell::new(None) };
    }

    pub(super) fn fake_environment() -> Option<Rc<FakeEnvironment>> {
        FAKE.with(|fake| fake.borrow().clone())
    }

    /// Until it drops, every [`check`] on this thread reads `fake` instead of the computer.
    /// `#[tokio::test]` runs the router on the test's own thread, so this reaches its handlers.
    pub(in crate::api) struct FakeEnvironmentGuard;

    impl Drop for FakeEnvironmentGuard {
        fn drop(&mut self) {
            FAKE.with(|fake| fake.borrow_mut().take());
        }
    }

    pub(in crate::api) fn use_fake_environment(fake: FakeEnvironment) -> FakeEnvironmentGuard {
        FAKE.with(|slot| *slot.borrow_mut() = Some(Rc::new(fake)));
        FakeEnvironmentGuard
    }

    struct TempDirectory(PathBuf);

    impl TempDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("loomwatch-gemini-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).expect("create temporary directory");
            Self(path)
        }

        fn write(&self, relative: &str, text: &str) {
            let path = self.0.join(relative);
            fs::create_dir_all(path.parent().expect("parent")).expect("create parent");
            fs::write(path, text).expect("write file");
        }
    }

    impl Drop for TempDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// A home with a team folder inside it, the usual `~/LoomWatch/teams` shape.
    fn home_and_teams() -> (TempDirectory, PathBuf) {
        let home = TempDirectory::new();
        let teams = home.0.join("LoomWatch").join("teams");
        fs::create_dir_all(&teams).expect("teams folder");
        (home, teams)
    }

    const CHOSEN_KEY: &str = r#"{"security":{"auth":{"selectedType":"gemini-api-key"}}}"#;
    const CHOSEN_GOOGLE: &str = r#"{"security":{"auth":{"selectedType":"oauth-personal"}}}"#;

    #[test]
    fn an_api_key_sign_in_without_a_key_needs_one_unless_gemini_saved_it() {
        let (home, teams) = home_and_teams();
        let fake = FakeEnvironment::new(&home.0);
        // Nothing chosen is the ACP default: a Gemini API key.
        assert_eq!(fake.read(&teams), Reading::NeedsSavedKey);
        home.write(".gemini/settings.json", CHOSEN_KEY);
        assert_eq!(fake.read(&teams), Reading::NeedsSavedKey);
        assert_eq!(
            settle(Reading::NeedsSavedKey, true),
            Some(Unusable::NoApiKey)
        );
        // A key Gemini CLI's /auth dialog saved, or one this check can't rule out.
        assert_eq!(settle(Reading::NeedsSavedKey, false), None);

        // Hooks and other settings beside the sign-in don't change the answer.
        home.write(
            ".gemini/settings.json",
            r#"{"hooks":{"BeforeTool":[]},"security":{"auth":{"selectedType":"gemini-api-key"}}}"#,
        );
        assert_eq!(fake.read(&teams), Reading::NeedsSavedKey);
    }

    #[test]
    fn a_key_anywhere_gemini_looks_leaves_the_verdict_to_the_handshake() {
        let (home, teams) = home_and_teams();
        home.write(".gemini/settings.json", CHOSEN_KEY);
        let fake = FakeEnvironment::new(&home.0);
        assert_eq!(
            fake.clone()
                .with_var("GEMINI_API_KEY", "key-from-shell")
                .read(&teams),
            Reading::Unjudged
        );
        // An empty variable is no key: Gemini CLI reads it as unset.
        assert_eq!(
            fake.clone().with_var("GEMINI_API_KEY", "").read(&teams),
            Reading::NeedsSavedKey
        );

        for file in [
            ".gemini/.env",
            ".env",
            "LoomWatch/.env",
            "LoomWatch/teams/.env",
            "LoomWatch/teams/.gemini/.env",
        ] {
            let (home, teams) = home_and_teams();
            home.write(".gemini/settings.json", CHOSEN_KEY);
            home.write(
                file,
                "# Gemini\nexport GEMINI_API_KEY=\"key-from-file\" # mine\n",
            );
            assert_eq!(
                FakeEnvironment::new(&home.0).read(&teams),
                Reading::Unjudged,
                "{file}"
            );
        }

        for (line, defines_it) in [
            ("GEMINI_API_KEY=abc", true),
            ("  GEMINI_API_KEY = 'abc'", true),
            ("export GEMINI_API_KEY=`abc`", true),
            ("GEMINI_API_KEY=", false),
            ("GEMINI_API_KEY=\"\"", false),
            ("GEMINI_API_KEY= # later", false),
            ("# GEMINI_API_KEY=abc", false),
            ("GEMINI_API_KEY_OLD=abc", false),
            ("GOOGLE_API_KEY=abc", false),
        ] {
            assert_eq!(defines(line, "GEMINI_API_KEY"), defines_it, "{line}");
        }
    }

    #[test]
    fn a_google_sign_in_is_refused_unless_it_is_a_paid_code_assist_one() {
        let (home, teams) = home_and_teams();
        home.write(".gemini/settings.json", CHOSEN_GOOGLE);
        let fake = FakeEnvironment::new(&home.0);
        assert_eq!(fake.read(&teams), Reading::Unusable(Unusable::GoogleSignIn));
        // A key alone doesn't help: the chosen sign-in wins over it.
        assert_eq!(
            fake.clone().with_var("GEMINI_API_KEY", "key").read(&teams),
            Reading::Unusable(Unusable::GoogleSignIn)
        );
        assert_eq!(
            fake.clone()
                .with_var("GOOGLE_CLOUD_PROJECT", "my-company")
                .read(&teams),
            Reading::Unjudged
        );
        home.write(".env", "GOOGLE_CLOUD_PROJECT_ID=my-company\n");
        assert_eq!(fake.read(&teams), Reading::Unjudged);
    }

    #[test]
    fn setups_this_check_does_not_understand_are_left_to_the_handshake() {
        let (home, teams) = home_and_teams();
        let fake = FakeEnvironment::new(&home.0);
        for settings in [
            r#"{"security":{"auth":{"selectedType":"vertex-ai"}}}"#,
            r#"{"security":{"auth":{"selectedType":"compute-default-credentials"}}}"#,
            r#"{"security":{"auth":{"selectedType":"some-future-sign-in"}}}"#,
            // Gemini CLI allows comments; this check does not read such a file.
            "// mine\n{\"security\":{\"auth\":{\"selectedType\":\"oauth-personal\"}}}",
        ] {
            home.write(".gemini/settings.json", settings);
            assert_eq!(fake.read(&teams), Reading::Unjudged, "{settings}");
        }

        // A gateway named in the environment, with nothing chosen.
        fs::remove_file(home.0.join(".gemini/settings.json")).expect("remove settings");
        assert_eq!(
            fake.clone()
                .with_var("GOOGLE_GEMINI_BASE_URL", "https://gateway.example")
                .read(&teams),
            Reading::Unjudged
        );

        // A team folder's own settings override the person's.
        home.write(".gemini/settings.json", CHOSEN_GOOGLE);
        home.write("LoomWatch/teams/.gemini/settings.json", CHOSEN_KEY);
        assert_eq!(fake.read(&teams), Reading::Unjudged);
        fs::remove_file(teams.join(".gemini/settings.json")).expect("remove team settings");

        // An administrator's settings can enforce a sign-in.
        home.write("managed/settings.json", "{}");
        let managed = home.0.join("managed/settings.json");
        assert_eq!(
            fake.clone()
                .with_var(
                    "GEMINI_CLI_SYSTEM_SETTINGS_PATH",
                    &managed.to_string_lossy()
                )
                .read(&teams),
            Reading::Unjudged
        );
        assert_eq!(fake.read(&teams), Reading::Unusable(Unusable::GoogleSignIn));

        assert_eq!(read(None, &teams, &|_| None), Reading::Unjudged);
    }

    #[test]
    fn what_gemini_said_in_a_failed_check_names_the_same_two_setups() {
        assert_eq!(
            unusable_from_error(
                "ACP session/new failed during model discovery: ACP error response: {\"code\":-32000,\"message\":\"Gemini API key is missing or not configured.\"}"
            ),
            Some(Unusable::NoApiKey)
        );
        assert_eq!(
            unusable_from_error(
                "This client is no longer supported for Gemini Code Assist for individuals."
            ),
            Some(Unusable::GoogleSignIn)
        );
        assert_eq!(unusable_from_error("spawn failed: ENOENT"), None);
    }

    #[tokio::test]
    async fn gemini_s_encrypted_fallback_file_means_a_saved_key_cannot_be_ruled_out() {
        let home = TempDirectory::new();
        home.write(".gemini/gemini-credentials.json", "aa:bb:cc");
        assert!(!no_saved_key(&home.0).await);
    }

    /// The real `security`: a keychain item nobody made reads as plainly absent.
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn a_keychain_item_nobody_saved_reads_as_absent() {
        let service = format!("loomwatch-test-{}", Uuid::new_v4());
        assert!(keychain_lacks(&service, "default-api-key").await);
    }
}
