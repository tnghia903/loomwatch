//! The planned-capability sidecar: `<team>.layout.json` beside `<team>.yaml`.
//!
//! `docs/TNG122_FREEFORM_CAPABILITY_COMPOSER.md` §8.2 is explicit that capability nodes and their
//! typed edges must not be folded into `team.schema.yaml` without a deliberate ADR, and that a
//! versioned sidecar is the recommended home until then. The daemon runs the team file; it never
//! reads this file to execute anything. It holds editable *intent* only: which skills, connectors
//! and knowledge sources the operator wants an agent to be able to reach, and where those cards
//! sit on the canvas.
//!
//! Nothing here grants access. A planned edge may name a capability but confers no permission —
//! execution still requires the harness's own authorization (§8.4).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Bump only for a breaking shape change; readers reject a version they do not know.
///
/// **Version 2** (ADR 0016) adds two fields, both additive: a knowledge card may carry the
/// `memory` reference it stands for, and the sidecar may carry agent positions. A version-1 file
/// is read and upgraded in place by [`ComposerLayout::migrate`] — there is nothing to convert,
/// only two absent fields — so no operator loses a canvas to a version number.
pub const LAYOUT_VERSION: u32 = 2;

/// The lowest version this daemon reads. Everything between this and [`LAYOUT_VERSION`] is
/// upgraded on read rather than refused.
pub const OLDEST_READABLE_LAYOUT_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CapabilityKind {
    Skill,
    Tool,
    Knowledge,
}

impl CapabilityKind {
    /// The one relationship the typed connection matrix (§4) allows into this kind.
    #[must_use]
    pub fn relation(self) -> &'static str {
        match self {
            Self::Skill => "uses skill",
            Self::Tool => "invokes",
            Self::Knowledge => "reads",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Position {
    pub x: f64,
    pub y: f64,
}

/// Which memory a knowledge card stands for: another team on this daemon, or an imported pack.
///
/// The card carries it because the card is what gets wired. Drawing an edge from an agent to this
/// card writes `memory.inherits[]` in the **team file** — executable configuration — and that
/// entry needs the team id or the pack path verbatim. Before version 2 a card held only `kind`,
/// `name` and a display-only `source`, so a card on the canvas could not say which memory it was;
/// the only way to reach inheritance was to edit the YAML.
///
/// Exactly one of the two is set. The team file's own schema says the same thing with a `oneOf`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRef {
    /// The team id for `memory.inherits[].team`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team: Option<String>,
    /// The pack folder for `memory.inherits[].pack`, relative to the teams root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pack: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityNode {
    /// Stable within one layout, e.g. `skill:notebooklm`.
    pub id: String,
    pub kind: CapabilityKind,
    pub name: String,
    /// Provenance as the Library showed it, e.g. `Codex · sales`. Display only.
    #[serde(default)]
    pub source: String,
    pub position: Position,
    /// Set on a knowledge card that is team memory. Absent on every other card, and absent in
    /// every version-1 file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory: Option<MemoryRef>,
    /// Set on a knowledge card that is a folder or file the operator chose (ADR 0042): the same
    /// `path` its agents' knowledge entries carry, so one card stands for one source however many
    /// agents read it. Absent on every other card. Additive, so the version stays 2.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Set on a knowledge card that is a Notion page the operator chose (ADR 0050): the same
    /// `notion` its agents' knowledge entries carry. Absent on every other card. Additive, so the
    /// version stays 2.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notion: Option<NotionCard>,
}

/// The Notion page a card stands for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionCard {
    pub page: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityEdge {
    /// Agent id in the team file. Only agents may reach a capability (§4).
    pub from: String,
    /// Capability node id in this layout.
    pub to: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposerLayout {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<OutputPlan>,
    pub version: u32,
    #[serde(default)]
    pub nodes: Vec<CapabilityNode>,
    #[serde(default)]
    pub edges: Vec<CapabilityEdge>,
    /// Where the operator put each **agent** card, by agent id.
    ///
    /// `docs/CANVAS_SPEC.md` §7.3 flagged this and did not decide it: `x`/`y` cannot go into the
    /// team file (`additionalProperties: false` at every level, and ARCHITECTURE §5 wants the
    /// reviewed file free of position churn), and `localStorage` loses them on the next machine,
    /// which defeats a daemon-served UI. Option A — this sidecar — is what ADR 0016 takes.
    ///
    /// It is the same rule ADR 0011/0012 already drew: **positions in the sidecar, contract in the
    /// team file**. An empty map means "no positions saved", which is a normal state: the canvas
    /// falls back to the deterministic `dagre` auto-layout seeded by the team id, so the same file
    /// still opens the same shape on a machine that has never seen it.
    #[serde(default)]
    pub agents: BTreeMap<String, Position>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OutputPlan {
    pub name: String,
    pub format: String,
}

impl Default for ComposerLayout {
    fn default() -> Self {
        Self {
            version: LAYOUT_VERSION,
            output: None,
            nodes: Vec::new(),
            edges: Vec::new(),
            agents: BTreeMap::new(),
        }
    }
}

/// Why a layout was refused. The message reaches the operator verbatim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayoutError(pub String);

impl std::fmt::Display for LayoutError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for LayoutError {}

impl ComposerLayout {
    /// Structural checks the client cannot be trusted to have done. Agent ids are *not* checked
    /// against the team file: the two are saved separately, and an edge whose agent was renamed
    /// is dropped on read rather than made unsavable.
    ///
    /// # Errors
    /// When the version is unknown, an id repeats, or an edge names a node that is not here.
    pub fn validate(&self) -> Result<(), LayoutError> {
        if self.version < OLDEST_READABLE_LAYOUT_VERSION || self.version > LAYOUT_VERSION {
            return Err(LayoutError(format!(
                "unsupported layout version {} (this daemon reads                  {OLDEST_READABLE_LAYOUT_VERSION}–{LAYOUT_VERSION})",
                self.version
            )));
        }
        for (agent_id, position) in &self.agents {
            if agent_id.trim().is_empty() {
                return Err(LayoutError("a saved position has no agent id".into()));
            }
            if !position.x.is_finite() || !position.y.is_finite() {
                return Err(LayoutError(format!(
                    "agent {agent_id} has a saved position that is not a number"
                )));
            }
        }
        for node in &self.nodes {
            if node.path.is_some()
                && (node.kind != CapabilityKind::Knowledge || node.memory.is_some())
            {
                return Err(LayoutError(format!(
                    "capability {} has a path, which only a folder or file card may have",
                    node.id
                )));
            }
            if node.notion.is_some()
                && (node.kind != CapabilityKind::Knowledge
                    || node.memory.is_some()
                    || node.path.is_some())
            {
                return Err(LayoutError(format!(
                    "capability {} names a Notion page, which only a Notion page card may do",
                    node.id
                )));
            }
            if let Some(memory) = &node.memory
                && (memory.team.is_none() == memory.pack.is_none())
            {
                return Err(LayoutError(format!(
                    "capability {} names {} of a team and a pack; a memory card stands for                      exactly one",
                    node.id,
                    if memory.team.is_some() {
                        "both"
                    } else {
                        "neither"
                    }
                )));
            }
        }
        let mut seen = std::collections::BTreeSet::new();
        for node in &self.nodes {
            if node.id.trim().is_empty() {
                return Err(LayoutError("a capability node has no id".into()));
            }
            if node.name.trim().is_empty() {
                return Err(LayoutError(format!("capability {} has no name", node.id)));
            }
            if !node.position.x.is_finite() || !node.position.y.is_finite() {
                return Err(LayoutError(format!(
                    "capability {} has a position that is not a number",
                    node.id
                )));
            }
            if !seen.insert(node.id.as_str()) {
                return Err(LayoutError(format!("duplicate capability id {}", node.id)));
            }
        }
        for edge in &self.edges {
            if edge.from.trim().is_empty() {
                return Err(LayoutError("an edge has no source agent".into()));
            }
            if !seen.contains(edge.to.as_str()) {
                return Err(LayoutError(format!(
                    "edge {} → {} names a capability that is not in this layout",
                    edge.from, edge.to
                )));
            }
        }
        Ok(())
    }

    /// Read a file of any supported version as the current one.
    ///
    /// A version-1 file needs no conversion — version 2 only *adds* fields — so this stamps the
    /// current version and leaves the content alone. It exists so the upgrade has one name and one
    /// place, rather than being a `version = LAYOUT_VERSION` assignment scattered where files are
    /// read.
    pub fn migrate(&mut self) {
        self.version = LAYOUT_VERSION;
    }

    /// Drop edges and saved positions whose agent no longer exists, so renaming or deleting an
    /// agent in the team file cannot leave the canvas drawing an edge from nothing — or holding a
    /// position for a card that is gone, which would come back if the id were ever reused.
    pub fn prune_to_agents(&mut self, agent_ids: &[String]) {
        self.edges.retain(|edge| agent_ids.contains(&edge.from));
        self.agents
            .retain(|agent_id, _| agent_ids.contains(agent_id));
    }
}

/// `teams/daily-news.yaml` → `teams/daily-news.layout.json`. Derived on the server so a client
/// can never name the file it writes.
#[must_use]
pub fn layout_path(team_path: &Path) -> PathBuf {
    team_path.with_extension("layout.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str, kind: CapabilityKind) -> CapabilityNode {
        CapabilityNode {
            id: id.to_owned(),
            kind,
            name: id.to_owned(),
            source: "Claude Code".to_owned(),
            position: Position { x: 10.0, y: 20.0 },
            memory: None,
            path: None,
            notion: None,
        }
    }

    #[test]
    fn the_sidecar_sits_beside_the_team_file_whatever_the_team_is_called() {
        assert_eq!(
            layout_path(Path::new("/teams/daily-news.yaml")),
            Path::new("/teams/daily-news.layout.json")
        );
        assert_eq!(
            layout_path(Path::new("/teams/nested/my.team.yaml")),
            Path::new("/teams/nested/my.team.layout.json")
        );
    }

    #[test]
    fn each_kind_carries_exactly_one_relationship_word() {
        assert_eq!(CapabilityKind::Skill.relation(), "uses skill");
        assert_eq!(CapabilityKind::Tool.relation(), "invokes");
        assert_eq!(CapabilityKind::Knowledge.relation(), "reads");
    }

    #[test]
    fn refuses_a_layout_that_would_draw_an_edge_to_nothing() {
        let layout = ComposerLayout {
            version: LAYOUT_VERSION,
            nodes: vec![node("skill:a", CapabilityKind::Skill)],
            edges: vec![CapabilityEdge {
                from: "collector".into(),
                to: "skill:missing".into(),
            }],
            ..Default::default()
        };
        assert_eq!(
            layout.validate().unwrap_err().to_string(),
            "edge collector → skill:missing names a capability that is not in this layout"
        );
    }

    #[test]
    fn refuses_duplicates_unknown_versions_and_unplaceable_nodes() {
        let duplicated = ComposerLayout {
            version: LAYOUT_VERSION,
            nodes: vec![
                node("skill:a", CapabilityKind::Skill),
                node("skill:a", CapabilityKind::Tool),
            ],
            edges: Vec::new(),
            ..Default::default()
        };
        assert_eq!(
            duplicated.validate().unwrap_err().to_string(),
            "duplicate capability id skill:a"
        );

        let future = ComposerLayout {
            version: 99,
            ..Default::default()
        };
        assert!(
            future
                .validate()
                .unwrap_err()
                .to_string()
                .contains("unsupported layout version 99")
        );

        let mut unplaceable = ComposerLayout {
            version: LAYOUT_VERSION,
            nodes: vec![node("skill:a", CapabilityKind::Skill)],
            edges: Vec::new(),
            ..Default::default()
        };
        unplaceable.nodes[0].position.x = f64::NAN;
        assert!(
            unplaceable
                .validate()
                .unwrap_err()
                .to_string()
                .contains("position that is not a number")
        );
    }

    /// A renamed or deleted agent must not leave an edge dangling from nothing on the canvas.
    #[test]
    fn prunes_edges_whose_agent_left_the_team_file() {
        let mut layout = ComposerLayout {
            output: None,
            version: LAYOUT_VERSION,
            nodes: vec![node("skill:a", CapabilityKind::Skill)],
            edges: vec![
                CapabilityEdge {
                    from: "collector".into(),
                    to: "skill:a".into(),
                },
                CapabilityEdge {
                    from: "deleted".into(),
                    to: "skill:a".into(),
                },
            ],
            agents: BTreeMap::from([
                ("collector".to_owned(), Position { x: 1.0, y: 2.0 }),
                ("deleted".to_owned(), Position { x: 3.0, y: 4.0 }),
            ]),
        };
        layout.prune_to_agents(&["collector".to_owned()]);
        assert_eq!(layout.edges.len(), 1);
        assert_eq!(layout.edges[0].from, "collector");
        assert_eq!(
            layout.agents.keys().collect::<Vec<_>>(),
            ["collector"],
            "a saved position outlives its agent only if pruning misses it"
        );
    }

    /// A version-1 sidecar is an operator's arranged canvas. It is read, upgraded and written back
    /// with its content intact — the two fields version 2 adds are simply absent, which is what
    /// "no positions saved" and "not a memory card" already mean.
    #[test]
    fn a_version_one_sidecar_loads_and_round_trips_as_version_two() {
        let version_one = r#"{"version":1,"nodes":[{"id":"skill:notebooklm","kind":"skill","name":"notebooklm","source":"Claude Code","position":{"x":320.0,"y":240.0}}],"edges":[{"from":"collector","to":"skill:notebooklm"}]}"#;
        let mut layout: ComposerLayout = serde_json::from_str(version_one).expect("parse");
        layout.validate().expect("version 1 is still readable");
        assert!(layout.agents.is_empty() && layout.nodes[0].memory.is_none());
        layout.migrate();
        assert_eq!(layout.version, LAYOUT_VERSION);
        assert_eq!(layout.nodes[0].position, Position { x: 320.0, y: 240.0 });
        assert_eq!(layout.edges[0].from, "collector");

        // And a version nobody wrote is still refused, in both directions.
        for version in [0, LAYOUT_VERSION + 1] {
            let unknown = ComposerLayout {
                version,
                ..Default::default()
            };
            assert!(
                unknown
                    .validate()
                    .unwrap_err()
                    .to_string()
                    .contains(&format!("unsupported layout version {version}")),
                "version {version} must be refused"
            );
        }
    }

    /// A memory card stands for exactly one memory. Both, or neither, would write a
    /// `memory.inherits` entry the team schema's own `oneOf` refuses.
    #[test]
    fn a_memory_card_names_exactly_one_source() {
        let card = |memory: MemoryRef| {
            let mut node = node("knowledge:research", CapabilityKind::Knowledge);
            node.memory = Some(memory);
            ComposerLayout {
                nodes: vec![node],
                ..Default::default()
            }
        };
        assert!(
            card(MemoryRef {
                team: Some("research-team".into()),
                pack: None,
            })
            .validate()
            .is_ok()
        );
        assert!(
            card(MemoryRef {
                team: None,
                pack: Some("packs/onboarding.memory".into()),
            })
            .validate()
            .is_ok()
        );
        for (both, expected) in [
            (
                MemoryRef {
                    team: Some("research-team".into()),
                    pack: Some("packs/onboarding.memory".into()),
                },
                "names both of a team and a pack",
            ),
            (
                MemoryRef {
                    team: None,
                    pack: None,
                },
                "names neither",
            ),
        ] {
            let error = card(both).validate().unwrap_err().to_string();
            assert!(error.contains(expected), "{error}");
        }
    }

    /// A saved agent position that is not a number would put a card at `NaN` and lose it.
    /// ADR 0042: a folder or file card keeps its path through a save, so one card stands for one
    /// source on every reload; a path on any other card is refused rather than kept as noise.
    #[test]
    fn a_folder_card_keeps_its_path_and_no_other_card_may_have_one() {
        let mut folder = node("knowledge@/Users/me/reports", CapabilityKind::Knowledge);
        folder.path = Some("/Users/me/reports".into());
        let layout = ComposerLayout {
            nodes: vec![folder],
            ..Default::default()
        };
        layout.validate().expect("a folder card is valid");
        let text = serde_json::to_string(&layout).expect("serialise");
        assert!(text.contains(r#""path":"/Users/me/reports""#), "{text}");
        let back: ComposerLayout = serde_json::from_str(&text).expect("read back");
        assert_eq!(back, layout);

        let mut skill = node("skill:notebooklm", CapabilityKind::Skill);
        skill.path = Some("/Users/me/reports".into());
        let error = ComposerLayout {
            nodes: vec![skill],
            ..Default::default()
        }
        .validate()
        .expect_err("only knowledge has a path");
        assert!(error.0.contains("only a folder or file card"), "{error:?}");
    }

    /// ADR 0050: a Notion page card keeps its page through a save, and only a knowledge card that
    /// is neither memory nor a folder or file may name one.
    #[test]
    fn a_notion_card_keeps_its_page_and_no_other_card_may_have_one() {
        let page = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
        let notion = || {
            let mut card = node(&format!("notion@{page}"), CapabilityKind::Knowledge);
            card.notion = Some(NotionCard {
                page: page.to_owned(),
            });
            card
        };
        let layout = ComposerLayout {
            nodes: vec![notion()],
            ..Default::default()
        };
        layout.validate().expect("a Notion card is valid");
        let text = serde_json::to_string(&layout).expect("serialise");
        assert!(
            text.contains(&format!(r#""notion":{{"page":"{page}"}}"#)),
            "{text}"
        );
        let back: ComposerLayout = serde_json::from_str(&text).expect("read back");
        assert_eq!(back, layout);

        let mut skill = notion();
        skill.kind = CapabilityKind::Skill;
        let mut with_path = notion();
        with_path.path = Some("/Users/me/reports".into());
        for card in [skill, with_path] {
            let error = ComposerLayout {
                nodes: vec![card],
                ..Default::default()
            }
            .validate()
            .expect_err("only a Notion page card names a page");
            assert!(error.0.contains("only a Notion page card"), "{error:?}");
        }
    }

    #[test]
    fn refuses_a_saved_agent_position_that_is_not_a_number() {
        let mut layout = ComposerLayout {
            agents: BTreeMap::from([("collector".to_owned(), Position { x: 1.0, y: 2.0 })]),
            ..Default::default()
        };
        layout.validate().expect("a finite position is fine");
        layout.agents.insert(
            "collector".to_owned(),
            Position {
                x: f64::NAN,
                y: 2.0,
            },
        );
        assert!(
            layout
                .validate()
                .unwrap_err()
                .to_string()
                .contains("agent collector has a saved position that is not a number")
        );
    }

    /// The wire shape, pinned. Version 2 adds `agents` and a knowledge card's `memory`, and this
    /// is the byte contract `ui/src/lib/composer-layout/types.ts` writes against.
    #[test]
    fn round_trips_as_the_json_the_ui_writes() {
        let json = r#"{"version":2,"nodes":[{"id":"skill:notebooklm","kind":"skill","name":"notebooklm","source":"Claude Code","position":{"x":320.0,"y":240.0}},{"id":"knowledge:research-team-memory","kind":"knowledge","name":"Research team · memory","source":"LoomWatch","position":{"x":320.0,"y":420.0},"memory":{"team":"research-team"}}],"edges":[{"from":"collector","to":"skill:notebooklm"}],"agents":{"collector":{"x":0.0,"y":0.0},"writer":{"x":344.0,"y":96.0}}}"#;
        let layout: ComposerLayout = serde_json::from_str(json).expect("parse");
        layout.validate().expect("valid");
        assert_eq!(layout.nodes[0].kind, CapabilityKind::Skill);
        assert_eq!(
            layout.nodes[1]
                .memory
                .as_ref()
                .and_then(|memory| memory.team.as_deref()),
            Some("research-team")
        );
        assert_eq!(layout.agents["writer"], Position { x: 344.0, y: 96.0 });
        assert_eq!(
            serde_json::to_value(&layout).expect("serialize"),
            serde_json::from_str::<serde_json::Value>(json).expect("reparse")
        );
    }
}
