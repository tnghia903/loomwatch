# Capability imports

This directory is mounted read-only at `/opt/loomwatch/capabilities` in the LoomWatch container.
Copy only the capability definitions you want LoomWatch to discover, preserving their conventional
paths:

```text
.codex/skills/<skill>/SKILL.md
.codex/plugins/cache/...
.claude/skills/<skill>/SKILL.md
.claude/plugins/...
.agents/skills/<skill>/SKILL.md
.config/opencode/skills/<skill>/SKILL.md
```

Do not put provider credentials, SSH keys, or your complete home directory here. Harness credentials
and mutable CLI state belong in the `loomwatch-home` Docker volume.
