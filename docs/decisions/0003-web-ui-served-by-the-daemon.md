# 0003 — Client is a web UI served by the daemon, not a native app

- **Date:** 2026-09-06
- **Status:** Accepted
- **Decided by:** Operator — explicit decision after weighing SwiftUI, Tauri, egui and Electron
- **Reverses:** ARCHITECTURE.md §6 "macOS app" (Swift 6.3 / SwiftUI), revisions 0.1–0.3

## Context

Revisions 0.1–0.3 specified a native macOS SwiftUI client for phases 04–05. Two things
changed the calculus on 2026-09-06:

1. **The product goal became a sellable, cross-platform tool** with a free / plus / max
   subscription model — not a personal Mac utility. SwiftUI is Apple-only and caps the
   addressable market to roughly a third of developers.
2. **The daemon already speaks WebSocket + REST** (frozen in Phase 03). The UI was always a
   thin client of `loomwatchd`; the only real question was how to package it.

Options considered: native macOS SwiftUI (Apple-only); Tauri (cross-platform native shell,
per-OS signing/packaging/update burden, WebKitGTK fragility on Linux); egui (pure-Rust GPU
native, strong performance but a custom look and a thin UI ecosystem); Electron (rejected
outright for its resource cost); and a web UI the daemon serves.

## Decision

1. **`loomwatchd` serves a single-page web UI** (static assets baked in with `rust-embed`,
   served by `axum`) plus the existing WebSocket for live events. The user runs the daemon
   and opens a browser, or installs the page as a PWA for a standalone window and a
   launcher icon. This takes only the *deployment shape* from Paperclip — a daemon that
   serves a page — not its UI.
2. **Stack: React + Vite + React Flow + Tailwind.** React Flow is the most mature node-graph
   canvas and has the most precedent for an AI-assisted build. No SSR, no meta-framework —
   a plain SPA for a local tool.
3. **UI/UX is eye-catching and minimal, and explicitly not Paperclip's.** Paperclip's UI is
   dense and complex and a poor experience; LoomWatch's is the opposite — few surfaces,
   generous whitespace, one obvious action per screen, progressive disclosure. The canvas
   is the product; the chrome recedes. A design spec (Phase 04) owns this and the build
   holds to it.
4. **Computer use stays in the daemon**, per-OS behind a trait. The daemon already holds
   the OS privilege to spawn agents; screen capture and input synthesis are the same
   category. The browser renders what the daemon captured and posts intent back — a browser
   tab never touches the OS directly. This is what keeps a web UI viable for a product that
   needs computer use.
5. **No native shell.** No Electron, no Tauri, no SwiftUI. If an ambient menu-bar / tray
   status indicator is wanted later, a small native helper (Rust, `tray-icon`, no UI
   framework) sits beside the daemon. Deferred, not planned.

## Consequences

- **Phases 01–03 are unaffected.** The Rust daemon, ACP spine, Team Bus, event archive and
  the frozen `RunEvent` / WebSocket schemas all carry over unchanged.
- Phase 04 becomes "the web UI `loomwatchd` serves": agent panel, drag-to-instantiate, edge
  drawing, node inspector, YAML round-trip. Phase 05 adds the observed-edge layer over the
  WebSocket stream.
- Cross-platform from day one — the daemon is the only thing that needs a per-OS build, and
  it is already a portable Rust binary.
- **Multi-device for free:** the UI opens from any device that can reach the daemon's port
  (LAN, Tailscale, SSH tunnel).
- Distribution is the daemon only — `brew` / a one-line installer / signed installers per
  OS. The UI updates when the daemon does; nobody reinstalls to get a new canvas.
- A hosted UI + billing layer can point at the same daemon over a token later, without
  changing the daemon. Not committed to now.
- The TNG-21 staffing plan's "macOS / SwiftUI Engineer" role is superseded by a web UI
  engineer; the Chief Secretary re-staffs when Phase 04 is picked up.
- Trade-off accepted: no menu-bar ambient presence in v1, and the UI is a browser page
  rather than a "real app" window unless installed as a PWA.
