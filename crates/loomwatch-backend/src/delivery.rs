//! Delivering wired knowledge sources and tools to an agent (ADR 0029).
//!
//! Skills are delivered by `workspace` (ADR 0012, 0019, 0021). This module does the same for the
//! other two Library kinds, and `workspace::materialise` calls it once per agent:
//!
//! * A **knowledge source** is a folder or file the operator chose (ADR 0035, 0036), supplied as
//!   the snapshot the panel previews ([`crate::chosen_knowledge::snapshot`]) — what the operator
//!   sees is what the agent gets. The agent reads further in it without asking: its permission
//!   policy approves reads inside connected knowledge (`permissions.rs`).
//! * A **tool** was an MCP server the operator had configured for another AI app. `LoomWatch`'s
//!   own agents don't take servers from other apps' settings, which hold their credentials, so a
//!   wired tool is named to the agent as unavailable and recorded, and the run goes on without it.
use std::path::Path;

use serde::Serialize;
use sha2::{Digest as _, Sha256};

use crate::capabilities::{self, CapabilityDefinition, CapabilityInventory};
use crate::config::{AgentConfig, CapabilityKind};

/// The most knowledge one agent is handed in its prompt. Each snapshot is already bounded (a
/// listing, a README excerpt, recent session titles); this stops many of them adding up to a
/// prompt nobody intended, and fails the run rather than shortening what the operator connected.
pub const KNOWLEDGE_BUDGET_BYTES: usize = 64 * 1024;

/// One knowledge source, read for one agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveredKnowledge {
    pub name: String,
    /// The Library's provenance, e.g. `LoomWatch + OpenCode`.
    pub source: String,
    /// Folders the agent may read, for a source that is one.
    pub folders: Vec<String>,
    /// Single files the agent may read: a file the operator added (ADR 0035). Omitted when none,
    /// so a record from before it is unchanged.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
    /// Whether the agent reads further in [`Self::folders`] and [`Self::files`] without asking.
    /// `None` when there are none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_access: Option<Permission>,
    pub chars: usize,
    /// SHA-256 of the snapshot as supplied, so the record proves which bytes the agent read.
    pub sha256: String,
    /// The snapshot itself. Archived in full as its prompt section, so not twice here.
    #[serde(skip)]
    pub contents: Vec<CapabilityDefinition>,
    /// An excerpted file's full text, for the workspace's `knowledge/` folder (ADR 0035).
    #[serde(skip)]
    pub text_copy: Option<capabilities::TextCopy>,
}

impl DeliveredKnowledge {
    /// The snapshot as the prompt carries it.
    #[must_use]
    pub fn rendered_contents(&self) -> String {
        self.contents
            .iter()
            .map(|part| format!("### {} — {}\n{}", part.source, part.path, part.content))
            .collect::<Vec<_>>()
            .join("\n\n")
    }
}

/// Everything besides skills that one agent is handed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Delivery {
    pub knowledge: Vec<DeliveredKnowledge>,
    /// Tools wired to the agent, none of which it can use ([`WiredTool`]).
    pub tools: Vec<WiredTool>,
    /// `LoomWatch`'s folder for this agent, which holds the copies the prompt points at (skills,
    /// full texts). Readable wherever the agent works (ADR 0042). `None` before `materialise`.
    pub copies: Option<std::path::PathBuf>,
}

impl Delivery {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.knowledge.is_empty() && self.tools.is_empty()
    }
}

/// A tool wired to an agent: an MCP server the operator had configured for another AI app.
/// `LoomWatch`'s agents don't take servers from other apps' settings, so the agent is told it
/// doesn't have it and the run goes on without it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WiredTool {
    /// The Library name the team file wires.
    pub name: String,
}

/// What a turned-off tool may never be named: the Team Bus, which is how a team hands work on.
pub const RESERVED_SERVER: &str = "loomwatch-team-bus";

/// Read one knowledge capability from its `path`, the folder or file the operator chose (ADR 0035);
/// the name is only a label. A knowledge entry with no path is refused (ADR 0036): the Library no
/// longer lists folders or other apps' history, so a name alone points at nothing. `chars` and
/// `sha256` are left for [`prepare_for`], which measures the knowledge budget across all of them.
fn resolve_knowledge(
    team_dir: &Path,
    inventory: &CapabilityInventory,
    capability: &crate::config::CapabilityRef,
) -> Result<DeliveredKnowledge, String> {
    let name = capability.name.as_str();
    if let Some(notion) = &capability.notion {
        return resolve_notion(name, notion);
    }
    let Some(path) = &capability.path else {
        if find(&inventory.sources, name).is_some_and(|item| item.memory.is_some()) {
            return Err(format!(
                "cannot use {name} as a knowledge capability: it is team memory, which reaches an agent through the team's memory settings (memory.inherits), not through capabilities."
            ));
        }
        return Err(format!(
            "cannot use the knowledge {name}: it names no folder or file. Remove it from the agent's Context, then use Add folder… or Add file… to choose what the agent should read."
        ));
    };
    let snapshot = crate::chosen_knowledge::snapshot(team_dir, path)
        .map_err(|reason| format!("cannot use the knowledge {name}: {reason}."))?;
    let source = if snapshot.folders.is_empty() {
        "Added file"
    } else {
        "Linked folder"
    };
    if snapshot.contents.is_empty() {
        return Err(format!(
            "cannot use the knowledge {name}: nothing readable was found in it."
        ));
    }
    let paths = |paths: &[std::path::PathBuf]| {
        paths
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
    };
    Ok(DeliveredKnowledge {
        name: name.to_owned(),
        source: source.to_owned(),
        folders: paths(&snapshot.folders),
        files: paths(&snapshot.files),
        read_access: (!snapshot.folders.is_empty() || !snapshot.files.is_empty())
            .then_some(Permission::Granted),
        chars: 0,
        sha256: String::new(),
        contents: snapshot.contents,
        text_copy: snapshot.text_copy,
    })
}

/// A Notion page as the run read it (ADR 0050), supplied like an added file: the whole page when
/// it is short, else its opening with the full text in the workspace's `knowledge/` folder. No
/// read grant: the agent is handed the text, never the connection.
fn resolve_notion(
    name: &str,
    notion: &crate::config::NotionRef,
) -> Result<DeliveredKnowledge, String> {
    let page = notion.read.as_deref().ok_or_else(|| {
        format!(
            "cannot use the Notion page {name}: it was not read from Notion when the run started."
        )
    })?;
    let short = notion.page.split('-').next().unwrap_or_default();
    let (mut content, text_copy) = if page.text.trim().is_empty() {
        ("This page is empty in Notion.".to_owned(), None)
    } else {
        crate::chosen_knowledge::excerpt(&page.text, &format!("{}-{short}.md", slug(&page.title)))
    };
    if page.truncated {
        content.push_str("\n\nNotion left part of this page out, so this may not be all of it.");
    }
    Ok(DeliveredKnowledge {
        name: name.to_owned(),
        source: NOTION_SOURCE.to_owned(),
        folders: Vec::new(),
        files: Vec::new(),
        read_access: None,
        chars: 0,
        sha256: String::new(),
        contents: vec![CapabilityDefinition {
            source: format!("{NOTION_SOURCE} · {}", page.title),
            path: page.url.clone(),
            content,
        }],
        text_copy,
    })
}

/// How a delivered Notion page is labelled in the record and in the prompt.
pub const NOTION_SOURCE: &str = "Notion page";

/// `Q3 Roadmap: draft!` → `q3-roadmap-draft`, for a file name that is safe everywhere.
fn slug(title: &str) -> String {
    let words = title
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_ascii_lowercase)
        .collect::<Vec<_>>()
        .join("-");
    let slug: String = words.chars().take(48).collect();
    let slug = slug.trim_end_matches('-');
    if slug.is_empty() {
        "notion-page".to_owned()
    } else {
        slug.to_owned()
    }
}

/// Resolve every knowledge source and tool `agent` wires, or say which one cannot be delivered.
///
/// # Errors
///
/// Returns one sentence naming the capability and what to do: knowledge with no folder or file, a
/// memory source wired as knowledge, a path that is gone or unreadable, or over the knowledge
/// budget. A wired tool is never an error: see [`WiredTool`].
///
/// `copies_at` is where an excerpted file's full text will be written, when the agent works
/// somewhere else (ADR 0042): the excerpt then names the copy by its full path, not as a folder
/// inside the agent's own.
pub fn prepare_for(
    team_dir: &Path,
    inventory: &CapabilityInventory,
    agent: &AgentConfig,
    copies_at: Option<&Path>,
) -> Result<Delivery, String> {
    let mut delivery = Delivery::default();
    let mut knowledge_bytes = 0usize;
    for capability in &agent.capabilities {
        let name = capability.name.as_str();
        match capability.kind {
            CapabilityKind::Skill => {}
            CapabilityKind::Knowledge => {
                // Two chosen paths can share a label, and skipping the second would drop it
                // without a word.
                if delivery.knowledge.iter().any(|item| item.name == name) {
                    return Err(format!(
                        "two knowledge sources connected to {} are both called {name}; rename one in the team file.",
                        agent.name
                    ));
                }
                let mut knowledge = resolve_knowledge(team_dir, inventory, capability)?;
                if let (Some(folder), Some(copy)) = (copies_at, &knowledge.text_copy) {
                    for part in &mut knowledge.contents {
                        part.content = crate::chosen_knowledge::relocate_copy_note(
                            &part.content,
                            &copy.file_name,
                            folder,
                        );
                    }
                }
                let rendered = knowledge.rendered_contents();
                knowledge_bytes += rendered.len();
                if knowledge_bytes > KNOWLEDGE_BUDGET_BYTES {
                    return Err(format!(
                        "the knowledge connected to this agent exceeds {} KiB once {name} is added; connect fewer sources to it.",
                        KNOWLEDGE_BUDGET_BYTES / 1024
                    ));
                }
                knowledge.chars = rendered.chars().count();
                knowledge.sha256 = format!("{:x}", Sha256::digest(rendered.as_bytes()));
                delivery.knowledge.push(knowledge);
            }
            CapabilityKind::Tool => {
                if !delivery.tools.iter().any(|tool| tool.name == name) {
                    delivery.tools.push(WiredTool {
                        name: name.to_owned(),
                    });
                }
            }
        }
    }
    Ok(delivery)
}

/// Exact name first, then case-insensitively, the way skills are matched.
fn find<'a>(
    items: &'a [capabilities::DetectedCapability],
    name: &str,
) -> Option<&'a capabilities::DetectedCapability> {
    items.iter().find(|item| item.name == name).or_else(|| {
        items
            .iter()
            .find(|item| item.name.eq_ignore_ascii_case(name))
    })
}

/// Who decides whether a call to a delivered capability is allowed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Permission {
    /// The agent reads it without asking: its policy approves reads inside connected knowledge.
    Granted,
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::*;
    use crate::config::CapabilityRef;
    use crate::memory::PromptSectionKind as Kind;

    struct TempDirectory(PathBuf);

    impl TempDirectory {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("loomwatch-delivery-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).expect("create temp directory");
            Self(path)
        }
    }

    impl Drop for TempDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn agent(cmd: &str, capabilities: &[(CapabilityKind, &str)]) -> AgentConfig {
        let mut agent = crate::config::TeamConfig::parse(&format!(
            "schemaVersion: 1\nid: t\nname: T\nentrypoint: a\nagents:\n  - id: a\n    spawn:\n      cmd: {cmd}\n      cwd: .\n    model: test/model\n"
        ))
        .expect("team")
        .agents
        .remove(0);
        agent.capabilities = capabilities
            .iter()
            .map(|(kind, name)| CapabilityRef {
                kind: *kind,
                name: (*name).to_owned(),
                path: None,
                notion: None,
            })
            .collect();
        agent
    }

    /// `agent`, with every knowledge entry linked to `folder` (ADR 0035).
    fn linked(mut agent: AgentConfig, folder: &Path) -> AgentConfig {
        for capability in &mut agent.capabilities {
            if capability.kind == CapabilityKind::Knowledge {
                capability.path = Some(folder.to_path_buf());
            }
        }
        agent
    }

    /// A Claude Code agent with the demo project folder linked as knowledge and the `agentmemory`
    /// server as a tool.
    fn demo_agent(teams: &Path) -> AgentConfig {
        linked(
            agent(
                "claude-agent-acp",
                &[
                    (CapabilityKind::Knowledge, "demo project"),
                    (CapabilityKind::Tool, "Agent Memory"),
                ],
            ),
            teams.parent().expect("project"),
        )
    }

    /// A machine with one project folder (the teams root's parent) and one MCP server configured
    /// for Claude Code.
    fn machine() -> (TempDirectory, PathBuf, PathBuf) {
        let directory = TempDirectory::new();
        let home = directory.0.join("home");
        let project = directory.0.join("demo");
        let teams = project.join("teams");
        fs::create_dir_all(&home).expect("home");
        fs::create_dir_all(&teams).expect("teams");
        fs::write(project.join("README.md"), "# Demo\nThe product.\n").expect("readme");
        (directory, home, teams)
    }

    #[test]
    fn a_wired_folder_and_tool_resolve_into_a_delivery() {
        let (_directory, home, teams) = machine();
        let inventory = capabilities::detect_capabilities(Some(&home), &teams);
        let delivery = prepare_for(
            &teams,
            &inventory,
            &linked(
                agent(
                    "claude-agent-acp",
                    &[
                        (CapabilityKind::Knowledge, "demo project"),
                        (CapabilityKind::Tool, "Agent Memory"),
                        (CapabilityKind::Skill, "not-resolved-here"),
                    ],
                ),
                teams.parent().expect("project"),
            ),
            None,
        )
        .expect("deliverable");

        let [knowledge] = delivery.knowledge.as_slice() else {
            panic!("one knowledge source: {delivery:?}");
        };
        let folder =
            crate::platform::canonicalize(teams.parent().expect("project")).expect("canonical");
        assert_eq!(knowledge.folders, [folder.to_string_lossy()]);
        assert_eq!(knowledge.read_access, Some(Permission::Granted));
        assert!(knowledge.rendered_contents().contains("The product."));
        assert_eq!(
            knowledge.chars,
            knowledge.rendered_contents().chars().count()
        );

        assert_eq!(
            delivery.tools,
            [WiredTool {
                name: "Agent Memory".to_owned()
            }],
            "a wired tool is named, not delivered: no app's settings are read for it"
        );
    }

    #[test]
    fn what_cannot_be_delivered_is_refused_by_name() {
        let (_directory, home, teams) = machine();
        let inventory = capabilities::detect_capabilities(Some(&home), &teams);
        // ADR 0036: a name alone no longer points at a folder.
        {
            let (kind, name, expected) = (
                CapabilityKind::Knowledge,
                "nowhere project",
                "names no folder or file",
            );
            let error = prepare_for(
                &teams,
                &inventory,
                &agent("claude-agent-acp", &[(kind, name)]),
                None,
            )
            .expect_err("refused");
            assert!(error.contains(name) && error.contains(expected), "{error}");
        }
    }

    /// ADR 0050: a Notion page is supplied like an added file, as the text the run read: the whole
    /// page when short, its opening and a full copy when long, and no read grant, since the agent
    /// never reaches Notion itself. A page the run did not read is refused rather than left out.
    #[test]
    fn a_notion_page_is_supplied_as_the_text_the_run_read() {
        let (_directory, home, teams) = machine();
        let inventory = capabilities::detect_capabilities(Some(&home), &teams);
        let page = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
        let given = |text: Option<String>, truncated: bool| {
            let mut agent = agent(
                "claude-agent-acp",
                &[(CapabilityKind::Knowledge, "Q3 Roadmap")],
            );
            agent.capabilities[0].notion = Some(crate::config::NotionRef {
                page: page.to_owned(),
                read: text.map(|text| {
                    std::sync::Arc::new(crate::config::NotionPage {
                        title: "Q3 Roadmap: draft!".to_owned(),
                        url: "https://app.notion.com/p/0f1e2d3c4b5a69788796a5b4c3d2e1f0".to_owned(),
                        text,
                        truncated,
                    })
                }),
            });
            prepare_for(&teams, &inventory, &agent, None)
        };

        let delivery =
            given(Some("# Goals\nShip the canvas.".to_owned()), false).expect("short page");
        let [knowledge] = delivery.knowledge.as_slice() else {
            panic!("one source: {delivery:?}");
        };
        assert_eq!(knowledge.source, NOTION_SOURCE);
        assert_eq!((knowledge.folders.len(), knowledge.files.len()), (0, 0));
        assert_eq!(
            knowledge.read_access, None,
            "nothing to grant: the agent gets the text"
        );
        assert_eq!(
            knowledge.rendered_contents(),
            "### Notion page · Q3 Roadmap: draft! — https://app.notion.com/p/0f1e2d3c4b5a69788796a5b4c3d2e1f0\n# Goals\nShip the canvas."
        );
        assert!(knowledge.text_copy.is_none());
        let section = crate::compose_prompt(
            &agent("claude-agent-acp", &[]),
            &crate::memory::ContextPacket::default(),
            &crate::NodeTask::goal("Plan Q3"),
        )
        .with_delivery(&delivery)
        .sections
        .into_iter()
        .find(|section| section.kind == Kind::Knowledge)
        .expect("a knowledge section");
        assert_eq!(section.heading, "## Knowledge: Q3 Roadmap");
        assert!(
            section
                .text
                .contains("you cannot open it in Notion yourself")
                && section.text.ends_with("Ship the canvas."),
            "{}",
            section.text
        );

        let long = "A line of the roadmap.\n".repeat(1_000);
        let delivery = given(Some(long.clone()), true).expect("long page");
        let knowledge = &delivery.knowledge[0];
        let copy = knowledge
            .text_copy
            .as_ref()
            .expect("the full text is copied");
        assert_eq!(copy.file_name, "q3-roadmap-draft-0f1e2d3c.md");
        assert_eq!(copy.text, long);
        let shown = knowledge.rendered_contents();
        assert!(
            shown.contains("knowledge/q3-roadmap-draft-0f1e2d3c.md"),
            "{shown}"
        );
        assert!(shown.ends_with("may not be all of it."), "{shown}");

        let error = given(None, false).expect_err("not read at run start");
        assert!(
            error.contains("Q3 Roadmap") && error.contains("not read from Notion"),
            "{error}"
        );
    }

    /// The sections land after the role and capabilities and before the task, the prompt text is
    /// exactly the sections joined (so the record and the prompt cannot disagree), and the
    /// knowledge is framed as material rather than instruction.
    #[test]
    fn knowledge_and_tools_are_composed_into_the_prompt_in_order() {
        let (_directory, home, teams) = machine();
        let inventory = capabilities::detect_capabilities(Some(&home), &teams);
        let wired = demo_agent(&teams);
        let delivery = prepare_for(&teams, &inventory, &wired, None).expect("deliverable");
        let composed = crate::compose_prompt(
            &wired,
            &crate::memory::ContextPacket::default(),
            &crate::NodeTask::goal("Research the market"),
        )
        .with_delivery(&delivery);

        let kinds = composed
            .sections
            .iter()
            .map(|section| section.kind)
            .collect::<Vec<_>>();
        assert_eq!(
            kinds,
            [
                Kind::Role,
                Kind::Capabilities,
                Kind::Knowledge,
                Kind::Tool,
                Kind::Task
            ]
        );
        let joined = composed
            .sections
            .iter()
            .map(|section| format!("{}\n{}", section.heading, section.text))
            .collect::<Vec<_>>()
            .join("\n\n");
        assert_eq!(composed.text, joined);
        assert!(
            composed
                .text
                .contains("- demo project (knowledge)\n- Agent Memory (tool)")
        );
        assert!(
            composed.text.contains(
                "## Knowledge: demo project\nThe operator connected this knowledge source"
            )
        );
        assert!(composed.text.contains("not as instructions"));
        assert!(composed.text.contains("The product."));
        assert!(
            composed
                .text
                .contains("## Tool: Agent Memory\nThe operator connected this tool to you, but")
        );
        assert!(composed.text.contains("so you don't have it"));
        let meta = composed.meta();
        assert_eq!(meta["knowledge"][0]["name"], "demo project");
        assert_eq!(meta["tools"][0]["name"], "Agent Memory");

        // With a place in the team (ADR 0034), it stays directly under the role, and knowledge and
        // tools still follow the capabilities list — the text is still exactly the sections.
        let placed = crate::compose_prompt(
            &wired,
            &crate::memory::ContextPacket::default(),
            &crate::NodeTask {
                place: Some("You are Research, step 1 of 2.".to_owned()),
                ..crate::NodeTask::goal("Research the market")
            },
        )
        .with_delivery(&delivery);
        assert_eq!(
            placed
                .sections
                .iter()
                .map(|section| section.kind)
                .collect::<Vec<_>>(),
            [
                Kind::Role,
                Kind::Team,
                Kind::Capabilities,
                Kind::Knowledge,
                Kind::Tool,
                Kind::Task
            ]
        );
        let joined = placed
            .sections
            .iter()
            .map(|section| format!("{}\n{}", section.heading, section.text))
            .collect::<Vec<_>>()
            .join("\n\n");
        assert_eq!(placed.text, joined);

        // Nothing wired, nothing changed.
        let plain = agent("claude-agent-acp", &[]);
        let before = crate::compose_prompt(
            &plain,
            &crate::memory::ContextPacket::default(),
            &crate::NodeTask::goal("x"),
        );
        let after = before.clone().with_delivery(&Delivery::default());
        assert_eq!(before, after);
        assert!(after.meta().get("knowledge").is_none());
    }
}
