use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::Deserialize;

/// Phase-02 subset of a version-1 team configuration.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamConfig {
    pub schema_version: u64,
    pub entrypoint: String,
    pub agents: Vec<AgentConfig>,
}

#[derive(Debug, Deserialize)]
pub struct AgentConfig {
    pub id: String,
    pub spawn: SpawnConfig,
    pub model: String,
}

#[derive(Debug, Deserialize)]
pub struct SpawnConfig {
    pub cmd: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub cwd: PathBuf,
}

impl TeamConfig {
    /// Read and minimally validate a Phase-02 team file.
    ///
    /// # Errors
    ///
    /// Returns an error when the file cannot be read, parsed, or uses an unknown version.
    pub fn load(path: &Path) -> Result<Self> {
        let source = fs::read_to_string(path)
            .with_context(|| format!("failed to read team file {}", path.display()))?;
        let team: Self = serde_yaml::from_str(&source)
            .with_context(|| format!("failed to parse team file {}", path.display()))?;
        if team.schema_version != 1 {
            bail!("unsupported team schema version {}", team.schema_version);
        }
        Ok(team)
    }

    /// Resolve the entrypoint to its configured agent.
    ///
    /// # Errors
    ///
    /// Returns an error when no agent has the configured entrypoint ID.
    pub fn entrypoint_agent(&self) -> Result<&AgentConfig> {
        self.agents
            .iter()
            .find(|agent| agent.id == self.entrypoint)
            .with_context(|| format!("entrypoint agent {:?} does not exist", self.entrypoint))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_entrypoint_agent() {
        let team: TeamConfig = serde_yaml::from_str(
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: acp\n      cwd: .\n    model: test/model\n",
        )
        .expect("valid config");
        assert_eq!(team.entrypoint_agent().expect("entrypoint").id, "a");
    }
}
