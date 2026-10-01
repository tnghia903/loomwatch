# Capability imports

This directory is mounted read-only at `/opt/loomwatch/capabilities` in the LoomWatch container.
Copy only the capability definitions you want LoomWatch to discover, preserving their conventional
paths:

```text
.claude/skills/<skill>/SKILL.md
.claude/plugins/...                      (not plugins/marketplaces/, which is a catalog)
.codex/skills/<skill>/SKILL.md
.codex/plugins/cache/...
.config/opencode/skills/<skill>/SKILL.md (or skill/)
.gemini/skills/<skill>/SKILL.md
.gemini/extensions/<extension>/skills/<skill>/SKILL.md
.hermes/skills/<category>/<skill>/SKILL.md
.hermes/profiles/<profile>/skills/...
.openclaw/skills/<skill>/SKILL.md        (also workspace/skills/ and plugin-skills/)
.pi/agent/skills/<skill>/SKILL.md
.agents/skills/<skill>/SKILL.md
```

Folders named `.trash`, `.staging` and `.tmp` are skipped wherever they appear. The full list, and
the order in which a copy is preferred, is `skill_roots` in `capabilities.rs` (ADR 0031).

Do not put provider credentials, SSH keys, or your complete home directory here. Harness credentials
and mutable CLI state belong in the `loomwatch-home` Docker volume.
