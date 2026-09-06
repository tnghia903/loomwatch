use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::Deserialize;

/// Runtime-relevant fields from a version-1 team configuration.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamConfig {
    pub schema_version: u64,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub entrypoint: String,
    #[serde(default)]
    pub budget: Option<BudgetConfig>,
    pub agents: Vec<AgentConfig>,
    #[serde(default)]
    pub edges: Vec<EdgeConfig>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub role: String,
    pub spawn: SpawnConfig,
    pub model: String,
    pub budget: BudgetConfig,
    #[serde(default = "default_allow_recruiting")]
    pub allow_recruiting: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SpawnConfig {
    pub cmd: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub cwd: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetConfig {
    pub limit_usd: f64,
    #[serde(default = "default_warn_at_percent")]
    pub warn_at_percent: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct EdgeConfig {
    pub from: String,
    pub to: String,
    pub layer: String,
    pub kind: String,
    pub ts: String,
}

const fn default_warn_at_percent() -> u8 {
    80
}

const fn default_allow_recruiting() -> bool {
    true
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
            "schemaVersion: 1\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: acp\n      cwd: .\n    model: test/model\n    budget:\n      limitUsd: 1\n",
        )
        .expect("valid config");
        assert_eq!(team.entrypoint_agent().expect("entrypoint").id, "a");
    }

    #[test]
    fn parses_team_and_agent_budgets_and_edges() {
        let team: TeamConfig = serde_yaml::from_str(
            r#"schemaVersion: 1
id: example
name: Example
entrypoint: a
budget:
  limitUsd: 12.5
agents:
  - id: a
    name: Agent A
    role: Lead
    spawn:
      cmd: acp
      cwd: .
    model: test/model
    budget:
      limitUsd: 3
      warnAtPercent: 70
edges:
  - from: a
    to: b
    layer: configured
    kind: sequence
    ts: "2026-09-06T00:00:00Z"
"#,
        )
        .expect("valid config");

        assert_eq!(team.budget.expect("team budget").warn_at_percent, 80);
        assert!((team.agents[0].budget.limit_usd - 3.0).abs() < f64::EPSILON);
        assert_eq!(team.agents[0].budget.warn_at_percent, 70);
        assert!(team.agents[0].allow_recruiting);
        assert_eq!(team.edges[0].from, "a");
        assert_eq!(team.edges[0].to, "b");
    }
}
