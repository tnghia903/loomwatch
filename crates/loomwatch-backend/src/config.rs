use std::collections::{BTreeMap, BTreeSet};
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
    #[serde(default)]
    pub guards: GuardsConfig,
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
#[serde(rename_all = "camelCase")]
pub struct GuardsConfig {
    #[serde(default = "default_max_dispatch_depth")]
    pub max_dispatch_depth: u32,
    #[serde(default = "default_max_concurrent_dispatches")]
    pub max_concurrent_dispatches: u32,
}

impl Default for GuardsConfig {
    fn default() -> Self {
        Self {
            max_dispatch_depth: default_max_dispatch_depth(),
            max_concurrent_dispatches: default_max_concurrent_dispatches(),
        }
    }
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

const fn default_max_dispatch_depth() -> u32 {
    8
}

const fn default_max_concurrent_dispatches() -> u32 {
    8
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
        Self::parse(&source)
            .with_context(|| format!("failed to parse team file {}", path.display()))
    }

    /// Parse and minimally validate a team document in memory.
    ///
    /// This is the in-memory counterpart to [`Self::load`]. It lets the configuration API
    /// validate an edited document before replacing its file.
    ///
    /// # Errors
    ///
    /// Returns an error when the document cannot be parsed, uses an unknown version, or
    /// fails the runtime's semantic checks.
    pub fn parse(source: &str) -> Result<Self> {
        let team: Self = serde_yaml::from_str(source).context("invalid team YAML")?;
        if team.schema_version != 1 {
            bail!("unsupported team schema version {}", team.schema_version);
        }
        team.entrypoint_agent()?;
        team.pipeline_order()?;
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

    /// Topological run order for pipeline mode (non-empty `edges`).
    ///
    /// Team mode (`edges` empty) has no backend-driven order, so this returns an empty
    /// vector without inspecting agents.
    ///
    /// # Errors
    ///
    /// Returns an error when an edge names an unknown agent, is a self-edge, duplicates
    /// another configured edge, the entrypoint has an incoming configured edge, or the
    /// configured edges are not a single DAG reachable from the entrypoint (including a
    /// cycle).
    pub fn pipeline_order(&self) -> Result<Vec<String>> {
        if self.edges.is_empty() {
            return Ok(Vec::new());
        }
        let agent_ids: BTreeSet<&str> = self.agents.iter().map(|agent| agent.id.as_str()).collect();
        let mut adjacency: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut indegree: BTreeMap<String, usize> = BTreeMap::new();
        let mut seen_edges: BTreeSet<(&str, &str)> = BTreeSet::new();

        for edge in &self.edges {
            if !agent_ids.contains(edge.from.as_str()) {
                bail!("configured edge references unknown agent {:?}", edge.from);
            }
            if !agent_ids.contains(edge.to.as_str()) {
                bail!("configured edge references unknown agent {:?}", edge.to);
            }
            if edge.from == edge.to {
                bail!(
                    "configured edge cannot connect agent {:?} to itself",
                    edge.from
                );
            }
            if !seen_edges.insert((edge.from.as_str(), edge.to.as_str())) {
                bail!("duplicate configured edge {:?} -> {:?}", edge.from, edge.to);
            }
            adjacency
                .entry(edge.from.clone())
                .or_default()
                .push(edge.to.clone());
            indegree.entry(edge.from.clone()).or_insert(0);
            *indegree.entry(edge.to.clone()).or_insert(0) += 1;
        }

        if indegree.get(&self.entrypoint).copied().unwrap_or(0) != 0 {
            bail!(
                "pipeline entrypoint {:?} has an incoming configured edge; it must be a source node",
                self.entrypoint
            );
        }

        let total_nodes = indegree.len();
        let mut remaining = indegree;
        let mut ready: BTreeSet<String> = BTreeSet::from([self.entrypoint.clone()]);
        let mut order = Vec::with_capacity(total_nodes);

        while let Some(node) = ready.iter().next().cloned() {
            ready.remove(&node);
            order.push(node.clone());
            for next in adjacency.get(&node).into_iter().flatten() {
                let entry = remaining
                    .get_mut(next)
                    .context("pipeline edge endpoint missing from indegree map")?;
                *entry -= 1;
                if *entry == 0 {
                    ready.insert(next.clone());
                }
            }
        }

        if order.len() != total_nodes {
            bail!(
                "configured edges contain a cycle, or a node unreachable from entrypoint {:?}",
                self.entrypoint
            );
        }
        Ok(order)
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
        assert_eq!(team.guards.max_dispatch_depth, 8);
        assert_eq!(team.guards.max_concurrent_dispatches, 8);
        assert!((team.agents[0].budget.limit_usd - 3.0).abs() < f64::EPSILON);
        assert_eq!(team.agents[0].budget.warn_at_percent, 70);
        assert!(team.agents[0].allow_recruiting);
        assert_eq!(team.edges[0].from, "a");
        assert_eq!(team.edges[0].to, "b");
    }

    fn pipeline_team(entrypoint: &str, edges_yaml: &str) -> TeamConfig {
        serde_yaml::from_str(&format!(
            "schemaVersion: 1\nentrypoint: {entrypoint}\nagents:\n  - id: a\n    spawn:\n      cmd: acp\n      cwd: .\n    model: test/model\n    budget:\n      limitUsd: 1\n  - id: b\n    spawn:\n      cmd: acp\n      cwd: .\n    model: test/model\n    budget:\n      limitUsd: 1\n  - id: c\n    spawn:\n      cmd: acp\n      cwd: .\n    model: test/model\n    budget:\n      limitUsd: 1\nedges:\n{edges_yaml}\n"
        ))
        .expect("valid config")
    }

    #[test]
    fn pipeline_order_follows_declared_edges() {
        let team = pipeline_team(
            "a",
            "  - from: a\n    to: b\n    layer: configured\n    kind: sequence\n    ts: \"2026-09-06T00:00:00Z\"\n  - from: b\n    to: c\n    layer: configured\n    kind: sequence\n    ts: \"2026-09-06T00:00:00Z\"\n",
        );
        assert_eq!(
            team.pipeline_order().expect("acyclic pipeline"),
            vec!["a".to_owned(), "b".to_owned(), "c".to_owned()]
        );
    }

    #[test]
    fn pipeline_order_is_empty_in_team_mode() {
        let team = pipeline_team("a", "");
        assert!(team.pipeline_order().expect("team mode").is_empty());
    }

    #[test]
    fn pipeline_order_rejects_a_cycle() {
        let team = pipeline_team(
            "a",
            "  - from: a\n    to: b\n    layer: configured\n    kind: sequence\n    ts: \"2026-09-06T00:00:00Z\"\n  - from: b\n    to: a\n    layer: configured\n    kind: sequence\n    ts: \"2026-09-06T00:00:00Z\"\n",
        );
        let error = team.pipeline_order().expect_err("cycle must be rejected");
        assert!(
            error
                .to_string()
                .contains("has an incoming configured edge"),
            "{error}"
        );
    }

    #[test]
    fn pipeline_order_rejects_a_longer_cycle_not_touching_the_entrypoint() {
        let team = pipeline_team(
            "a",
            "  - from: a\n    to: b\n    layer: configured\n    kind: sequence\n    ts: \"2026-09-06T00:00:00Z\"\n  - from: b\n    to: c\n    layer: configured\n    kind: sequence\n    ts: \"2026-09-06T00:00:00Z\"\n  - from: c\n    to: b\n    layer: configured\n    kind: sequence\n    ts: \"2026-09-06T00:00:00Z\"\n",
        );
        let error = team.pipeline_order().expect_err("cycle must be rejected");
        assert!(error.to_string().contains("cycle"), "{error}");
    }

    #[test]
    fn pipeline_order_rejects_a_self_edge() {
        let team = pipeline_team(
            "a",
            "  - from: a\n    to: a\n    layer: configured\n    kind: sequence\n    ts: \"2026-09-06T00:00:00Z\"\n",
        );
        let error = team
            .pipeline_order()
            .expect_err("self-edge must be rejected");
        assert!(error.to_string().contains("itself"), "{error}");
    }

    #[test]
    fn pipeline_order_rejects_a_duplicate_edge() {
        let team = pipeline_team(
            "a",
            "  - from: a\n    to: b\n    layer: configured\n    kind: sequence\n    ts: \"2026-09-06T00:00:00Z\"\n  - from: a\n    to: b\n    layer: configured\n    kind: sequence\n    ts: \"2026-09-06T00:00:00Z\"\n",
        );
        let error = team
            .pipeline_order()
            .expect_err("duplicate edge must be rejected");
        assert!(
            error.to_string().contains("duplicate configured edge"),
            "{error}"
        );
    }

    #[test]
    fn pipeline_order_rejects_an_edge_to_an_unknown_agent() {
        let team = pipeline_team(
            "a",
            "  - from: a\n    to: nobody\n    layer: configured\n    kind: sequence\n    ts: \"2026-09-06T00:00:00Z\"\n",
        );
        let error = team
            .pipeline_order()
            .expect_err("unknown agent must be rejected");
        assert!(error.to_string().contains("unknown agent"), "{error}");
    }

    #[test]
    fn pipeline_order_rejects_an_entrypoint_with_an_incoming_edge() {
        let team = pipeline_team(
            "b",
            "  - from: a\n    to: b\n    layer: configured\n    kind: sequence\n    ts: \"2026-09-06T00:00:00Z\"\n",
        );
        let error = team
            .pipeline_order()
            .expect_err("entrypoint must be a source node");
        assert!(
            error.to_string().contains("must be a source node"),
            "{error}"
        );
    }

    #[test]
    fn parses_dispatch_guards() {
        let team: TeamConfig = serde_yaml::from_str(
            "schemaVersion: 1\nentrypoint: a\nguards:\n  maxDispatchDepth: 3\n  maxConcurrentDispatches: 5\nagents:\n  - id: a\n    spawn:\n      cmd: acp\n      cwd: .\n    model: test/model\n    budget:\n      limitUsd: 1\n",
        )
        .expect("valid config");

        assert_eq!(team.guards.max_dispatch_depth, 3);
        assert_eq!(team.guards.max_concurrent_dispatches, 5);
    }
}
