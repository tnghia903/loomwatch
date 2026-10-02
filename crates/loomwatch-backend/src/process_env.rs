//! Environment passed to harnesses, separate from the daemon's infrastructure credentials.
use std::collections::BTreeMap;

fn inherited_key(name: &str) -> bool {
    matches!(
        name,
        "PATH"
            | "HOME"
            | "USER"
            | "LOGNAME"
            | "SHELL"
            | "TMPDIR"
            | "TMP"
            | "TEMP"
            | "LANG"
            | "LC_ALL"
            | "LC_CTYPE"
            | "TERM"
            | "COLORTERM"
            | "NO_COLOR"
            | "SYSTEMROOT"
            | "SystemRoot"
            | "WINDIR"
            | "COMSPEC"
            | "PATHEXT"
            | "APPDATA"
            | "LOCALAPPDATA"
            | "USERPROFILE"
            | "PROGRAMFILES"
            | "XDG_CONFIG_HOME"
            | "XDG_DATA_HOME"
            | "XDG_CACHE_HOME"
            | "HTTP_PROXY"
            | "HTTPS_PROXY"
            | "ALL_PROXY"
            | "NO_PROXY"
            | "http_proxy"
            | "https_proxy"
            | "all_proxy"
            | "no_proxy"
            | "SSL_CERT_FILE"
            | "SSL_CERT_DIR"
            | "SSH_AUTH_SOCK"
            | "OPENAI_API_KEY"
            | "OPENAI_BASE_URL"
            | "OPENAI_ORG_ID"
            | "OPENAI_PROJECT_ID"
            | "ANTHROPIC_API_KEY"
            | "ANTHROPIC_AUTH_TOKEN"
            | "ANTHROPIC_BASE_URL"
            | "GEMINI_API_KEY"
            | "GOOGLE_API_KEY"
            | "GOOGLE_APPLICATION_CREDENTIALS"
            | "GOOGLE_CLOUD_PROJECT"
            | "GOOGLE_CLOUD_LOCATION"
            | "CLAUDE_CODE_USE_BEDROCK"
            | "CLAUDE_CODE_USE_VERTEX"
            | "AWS_ACCESS_KEY_ID"
            | "AWS_SECRET_ACCESS_KEY"
            | "AWS_SESSION_TOKEN"
            | "AWS_PROFILE"
            | "AWS_REGION"
            | "AWS_DEFAULT_REGION"
            | "AZURE_OPENAI_API_KEY"
            | "AZURE_OPENAI_ENDPOINT"
            | "CODEX_HOME"
            | "CLAUDE_CONFIG_DIR"
    )
}

fn daemon_key(name: &str) -> bool {
    name == "DATABASE_URL" || name.starts_with("POSTGRES_") || name.starts_with("LOOMWATCH_")
}

pub(crate) fn harness_environment(
    inherited: impl IntoIterator<Item = (String, String)>,
    explicit: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut env: BTreeMap<_, _> = inherited
        .into_iter()
        .filter(|(key, _)| inherited_key(key))
        .collect();
    // Explicit run configuration remains authoritative, except daemon infrastructure secrets.
    env.extend(
        explicit
            .iter()
            .filter(|(key, _)| !daemon_key(key))
            .map(|(k, v)| (k.clone(), v.clone())),
    );
    env
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn infrastructure_and_loader_values_do_not_leak() {
        let inherited = [
            "DATABASE_URL",
            "POSTGRES_PASSWORD",
            "LOOMWATCH_HOST_RUNNER_TOKEN",
            "LOOMWATCH_CONTROL_TOKEN",
            "NODE_OPTIONS",
            "PYTHONPATH",
            "DYLD_INSERT_LIBRARIES",
            "PATH",
            "ANTHROPIC_API_KEY",
        ]
        .map(|name| (name.to_owned(), "value".to_owned()));
        let explicit = BTreeMap::from([
            ("MODE".into(), "test".into()),
            ("DATABASE_URL".into(), "secret".into()),
        ]);
        let env = harness_environment(inherited, &explicit);
        assert_eq!(env.len(), 3);
        assert_eq!(env["MODE"], "test");
        assert!(env.contains_key("PATH") && env.contains_key("ANTHROPIC_API_KEY"));
    }
}
