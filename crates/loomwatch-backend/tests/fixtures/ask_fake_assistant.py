#!/usr/bin/env python3
"""Scripted ACP app for Ask LoomWatch tests and offline demos; never contacts a model provider.

It behaves like an AI app that was given the LoomWatch Control tools at `session/new`: it calls them
over HTTP with the address and token it was handed, reports each call as an ACP tool call, and
answers in plain words. What it does depends on keywords in the person's message:

- "team" or "brief": reads the AI apps, proposes a broken team file first (to exercise the
  validation loop), then a valid four-step team with a review stop.
- "add": reads the team and proposes it with an Editor added before the Writer, and the Writer's
  job changed — a change to an existing team rather than a new one.
- "run": asks to start a run of the proposed team.
- "note": drafts a note for an open review stop.
- anything else: lists the teams.
"""
import json
import sys
import urllib.request

SESSION = "ask-fake"
mcp = {"url": None, "headers": {}, "session": None, "next": 1}
state = {"team": None}


def emit(value):
    print(json.dumps(value), flush=True)


def update(session_update, **fields):
    emit({"jsonrpc": "2.0", "method": "session/update",
          "params": {"sessionId": SESSION, "update": {"sessionUpdate": session_update, **fields}}})


def say(text):
    update("agent_message_chunk", content={"type": "text", "text": text}, messageId=f"m{mcp['next']}")


def rpc(method, params=None, notify=False):
    body = {"jsonrpc": "2.0", "method": method}
    if params is not None:
        body["params"] = params
    if not notify:
        body["id"] = mcp["next"]
        mcp["next"] += 1
    headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
               **mcp["headers"]}
    if mcp["session"]:
        headers["Mcp-Session-Id"] = mcp["session"]
    request = urllib.request.Request(mcp["url"], data=json.dumps(body).encode(), headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=30) as response:
        mcp["session"] = response.headers.get("Mcp-Session-Id") or mcp["session"]
        text = response.read().decode()
    if notify or not text.strip():
        return None
    if text.lstrip().startswith("event:") or text.lstrip().startswith("data:"):
        text = "\n".join(line[5:].strip() for line in text.splitlines() if line.startswith("data:"))
    return json.loads(text)


def call(tool, arguments):
    """One LoomWatch Control tool call, reported the way an AI app reports MCP calls."""
    call_id = f"call-{mcp['next']}"
    update("tool_call", toolCallId=call_id, title=f"mcp__loomwatch__{tool}", kind="other", status="pending",
           rawInput=arguments)
    reply = rpc("tools/call", {"name": tool, "arguments": arguments})
    result = reply.get("result", {}) if reply else {}
    failed = bool(result.get("isError")) or "error" in (reply or {})
    text = "".join(part.get("text", "") for part in result.get("content", []) if isinstance(part, dict))
    update("tool_call_update", toolCallId=call_id, status="failed" if failed else "completed",
           rawOutput=result.get("structuredContent", text))
    return failed, result.get("structuredContent") or {}, text


TEAM = """schemaVersion: 1
id: morning-chip-brief
name: Morning chip brief
entrypoint: collector
agents:
  - id: collector
    name: Collector
    role: Collect today's AI and chip news, with a link for every story.
    spawn: {spawn}
    model: {model}
  - id: checker
    name: Fact-checker
    role: Check every claim against its source and list any you cannot confirm.
    spawn: {spawn}
    model: {model}
  - id: review
    kind: operator
    name: You
    role: Fact-checker is done. Approve the brief, or say what to change.
  - id: writer
    name: Writer
    role: Write a five-bullet brief from the checked stories.
    spawn: {spawn}
    model: {model}
edges:
  - {{from: collector, to: checker, layer: configured, kind: sequence, ts: "2026-10-02T00:00:00Z"}}
  - {{from: checker, to: review, layer: configured, kind: sequence, ts: "2026-10-02T00:00:00Z"}}
  - {{from: review, to: writer, layer: configured, kind: sequence, ts: "2026-10-02T00:00:00Z"}}
"""


def propose():
    _, apps, _ = call("list_apps", {})
    usable = [app for app in apps.get("apps", []) if app.get("available")]
    app = usable[0] if usable else {"spawn": {"cmd": "python3", "args": ["operator-stop-harness.py", "researcher"], "env": {}, "cwd": "."},
                                    "defaultModel": "fake/offline"}
    spawn = json.dumps(app["spawn"])
    model = json.dumps(app.get("defaultModel") or "default")
    broken = TEAM.format(spawn=spawn, model=model).replace("entrypoint: collector", "entrypoint: nobody")
    failed, _, error = call("propose_team", {"file": "morning-chip-brief.yaml", "yaml": broken,
                                             "summary": "A first draft"})
    if failed:
        say("My first draft named a starting agent that doesn't exist, so I fixed it. ")
    failed, proposal, error = call("propose_team", {
        "file": "morning-chip-brief.yaml", "yaml": TEAM.format(spawn=spawn, model=model),
        "summary": "A weekday brief: Collector gathers, Fact-checker checks, you approve, Writer writes."})
    if failed:
        say("I couldn't make a valid team: " + error)
        return
    state["team"] = proposal.get("file", "morning-chip-brief.yaml")
    say("Here is a team for that. Fact-checker checks every claim, and the team stops for you before the "
        "Writer starts. Apply it on the canvas, or tell me what to change.")


def change():
    team = state["team"] or "morning-chip-brief.yaml"
    failed, current, error = call("read_team", {"file": team})
    if failed:
        say("I couldn't read that team: " + error)
        return
    yaml = current.get("yaml", "")
    spawn_line = next((line for line in yaml.splitlines() if line.strip().startswith("spawn:")), "    spawn: {}")
    model_line = next((line for line in yaml.splitlines() if line.strip().startswith("model:")), "    model: default")
    editor = ("  - id: editor\n    name: Editor\n    role: Tighten the checked stories and cut anything repeated.\n"
              f"{spawn_line}\n{model_line}\n")
    changed = (yaml.replace("  - id: writer\n", editor + "  - id: writer\n", 1)
               .replace("role: Write a five-bullet brief from the checked stories.",
                        "role: Write a five-bullet brief from the edited stories, with a link on every bullet.")
               .replace("from: review, to: writer,", "from: review, to: editor,", 1)
               .replace("edges:\n", 'edges:\n  - {from: editor, to: writer, layer: configured, kind: sequence, ts: "2026-10-02T00:00:00Z"}\n', 1))
    failed, _, error = call("propose_team", {"file": team, "yaml": changed,
                                             "summary": "Adds an Editor after your review, and the Writer links every bullet."})
    say("I couldn't change it: " + error if failed else "Here's the change. Apply it on the canvas, or tell me what to adjust.")


def start():
    team = state["team"] or "morning-chip-brief.yaml"
    failed, outcome, error = call("start_run", {"file": team, "request": "Prepare today's brief."})
    if failed:
        say("I couldn't start it: " + error)
    elif outcome.get("status") == "started":
        say("Started the run. I'll keep an eye on it here.")
    else:
        say("Press Start run in the card when you're ready. Nothing runs until you do.")


def note():
    _, run, _ = call("get_run", {})
    question = (run.get("waitingOn") or {}).get("question") or "the open question"
    call("draft_review_note", {"text": "Approved. Keep the brief to five bullets."})
    say(f"The team is waiting for you on: {question} I drafted a note you can put in the review box.")


for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    result = {}
    if method == "initialize":
        result = {"protocolVersion": 1, "agentCapabilities": {"mcpCapabilities": {"http": True}}}
    elif method == "session/new":
        for server in request["params"].get("mcpServers", []):
            if server.get("name") == "loomwatch":
                mcp["url"] = server["url"]
                mcp["headers"] = {h["name"]: h["value"] for h in server.get("headers", [])}
        result = {"sessionId": SESSION, "configOptions": []}
    elif method == "session/prompt":
        text = "\n".join(part.get("text", "") for part in request["params"]["prompt"]).lower()
        message = text.rsplit("## the person's message", 1)[-1]
        if not mcp["url"]:
            say("LoomWatch didn't give me its tools, so I can't help with this.")
        else:
          try:
            if not mcp["session"]:
                rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                   "clientInfo": {"name": "ask-fake", "version": "1"}})
                rpc("notifications/initialized", notify=True)
            if "note" in message:
                note()
            elif "add" in message:
                change()
            elif "run" in message:
                start()
            elif "team" in message or "brief" in message:
                propose()
            else:
                _, teams, _ = call("list_teams", {})
                names = ", ".join(team.get("name", team.get("file", "")) for team in teams.get("teams", []))
                say("Your teams: " + (names or "none yet") + ".")
          except Exception:  # surfaced in the transcript, so a broken fixture explains itself
            import traceback
            say("The offline assistant hit an error: " + traceback.format_exc())
        result = {"stopReason": "end_turn"}
    elif method == "session/cancel":
        continue
    elif method != "session/close":
        emit({"jsonrpc": "2.0", "id": request.get("id"), "error": {"code": -32601, "message": "Unsupported"}})
        continue
    emit({"jsonrpc": "2.0", "id": request.get("id"), "result": result})
    if method == "session/close":
        break
