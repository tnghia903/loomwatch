"""A stand-in for OpenRouter on 127.0.0.1, for end-to-end checks of LoomWatch with no real key.

It answers the five things LoomWatch asks OpenRouter: the key check (GET /api/v1/key), the model
list (GET /api/v1/models), streamed chat completions (POST /api/v1/chat/completions), streamed
Anthropic-shaped Messages calls for a Claude (POST /api/v1/messages) and the reading of an agent's
setup for a model suggestion (POST /api/alpha/decisions, which the real OpenRouter answers with
TypeSafe's Jev; here a few keywords stand in, so a trial shows the flow, not how well Jev reads).
Replies are scripted from what the request says, so a run exercises real tool calls:

- "MOCK-RUN: <command>" in the task  -> a run_command call, then a summary
- "MOCK-WRITE: <path>" in the task    -> a write_file call, then a summary
- "MOCK-READ: <path>" in the task     -> a read_file call, then a summary
- "MOCK-TOOL: <call> <json>" in the task -> a call of any offered tool whose name is <call> or ends
  in "__<call>" (a connected tool's, such as deepwiki__ask_question), then a summary
- "MOCK-FAIL-402" in the task         -> a 402 out-of-credits answer
- the chat's read of an @ message     -> TALK for a greeting, thanks or a question ("hi", "thanks",
                                         "Explain …", "… ?"), so the agents answer it in the chat;
                                         else WORK, which starts a run
- the learner (ADR 0078)              -> a lesson when the person's words ask for something shorter
                                         or in bullets, one about the person ("aboutYou") when they
                                         ask for Vietnamese, else no edits; an agent whose
                                         instructions hold the bullets lesson answers in three bullets
- "MOCK-LONG: <n>" in the task        -> an answer of about n words, streamed three words at a time
                                         as a real model streams (for measuring how the app keeps up)
- "MOCK-HELPERS: <n>" in the task     -> n start_helper calls at once (ADR 0079); each helper lists
  its folder, waits a few seconds ("MOCK-WAIT: <s>" in its brief) and sends back its findings, and
  the agent then answers with what they found
- "MOCK-MY-AGENTS: <name>" in the task -> a my_agents call (ADR 0092), then a dispatch to the listed
  agent whose id holds <name> (the first listed when none does), then an answer from what it sent
- a Research lead (its role says so)  -> two dispatch calls at once, then ask the Writer
- a Researcher / a Writer             -> findings / a cited report
- anything else                       -> a short text reply

A setup whose instructions contain "MOCK-FAIL-402" is answered 402, like a key out of credit.

The task is the text after the last "## Task" in the latest request, so earlier messages in the
team's chat don't trigger anything again. Only a key starting "sk-or-v1-mock" is accepted.

Every request is logged to requests.jsonl, and the latest one in full to last_request.json, in
$MOCK_OPENROUTER_LOG (default: the system's temporary folder). Nothing is written elsewhere.

Usage: python3 scripts/mock-openrouter.py [port]   (default 4100)
"""

import hashlib
import json
import os
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.environ.get("MOCK_OPENROUTER_LOG") or tempfile.gettempdir()
LOG = os.path.join(HERE, "requests.jsonl")
LOCK = threading.Lock()
COUNTER = [0]

MODELS = [
    {"id": "anthropic/claude-opus-5.5", "name": "Anthropic: Claude Opus 5.5", "created": 3,
     "context_length": 1000000, "pricing": {"prompt": "0.000004", "completion": "0.00002"},
     "architecture": {"input_modalities": ["text", "image"], "output_modalities": ["text"]},
     "supported_parameters": ["tools", "reasoning"]},
    {"id": "anthropic/claude-sonnet-5.5", "name": "Anthropic: Claude Sonnet 5.5", "created": 2,
     "context_length": 1000000, "pricing": {"prompt": "0.000002", "completion": "0.00001"},
     "architecture": {"input_modalities": ["text", "image"], "output_modalities": ["text"]},
     "supported_parameters": ["tools", "reasoning"]},
    {"id": "openai/gpt-6.1-sol", "name": "OpenAI: GPT-6.1 Sol", "created": 1,
     "context_length": 400000, "pricing": {"prompt": "0.000003", "completion": "0.000015"},
     "architecture": {"input_modalities": ["text", "image"], "output_modalities": ["text"]},
     "supported_parameters": ["tools", "reasoning"]},
    {"id": "google/gemma-4-31b-it:free", "name": "Google: Gemma 4 31B (free)", "created": 1,
     "context_length": 128000, "pricing": {"prompt": "0", "completion": "0"},
     "supported_parameters": ["tools"]},
]


def read_setup(state):
    """The stand-in reading: which kind of work the setup's instructions describe, by keywords."""
    text = state.split("Instructions:", 1)[-1].lower()
    kind = "produce"
    if any(word in text for word in ("verdict", "met or not met", "check the", "verify every")):
        kind = "check"
    elif any(word in text for word in ("do not write", "don't write", "do not judge", "do not teach",
                                         "hand them on", "tag it", "return them raw")):
        kind = "gather"
    others = [other for other in ("gather", "produce", "check") if other != kind]
    return {"type": "choice", "choice": kind, "probabilities": {kind: 0.88, others[0]: 0.08, others[1]: 0.04},
            "confidence": 0.85}


def log(entry):
    with LOCK:
        with open(LOG, "a") as handle:
            handle.write(json.dumps(entry) + "\n")


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(part.get("text", "") for part in content if isinstance(part, dict))
    return ""


def tool_names(body):
    """The tools a request offers, in chat completions' shape or Anthropic's."""
    names = []
    for tool in body.get("tools") or []:
        name = (tool.get("function") or {}).get("name") or tool.get("name")
        if name:
            names.append(name)
    return names


def find_tool(names, suffix):
    for name in names:
        if name == suffix or name.endswith("__" + suffix) or name.endswith("." + suffix):
            return name
    return None


def latest_task(messages):
    """The text after the last "## Task" in the newest user message: what this turn was asked."""
    users = [text_of(m.get("content")) for m in messages if m.get("role") == "user"]
    return (users[-1] if users else "").rsplit("## Task", 1)[-1]


def plan(body):
    """What to answer: ("text", str) or ("calls", [(name, args)])."""
    messages = body.get("messages") or []
    system = "\n".join(text_of(m.get("content")) for m in messages if m.get("role") == "system")
    users = [text_of(m.get("content")) for m in messages if m.get("role") == "user"]
    latest = users[-1] if users else ""
    last = messages[-1] if messages else {}
    names = tool_names(body)
    # A job is said in the system prompt or under "## Your assigned role" in the first request.
    first = users[0] if users else ""
    own = first.split("## Your assigned role", 1)[1].split("\n## ", 1)[0] if "## Your assigned role" in first else system
    lower_system = own.lower()

    if last.get("role") == "tool":
        said = text_of(last.get("content"))
        # Which call this answers.
        call_name = ""
        for message in reversed(messages):
            for call in message.get("tool_calls") or []:
                if call.get("id") == last.get("tool_call_id"):
                    call_name = (call.get("function") or {}).get("name", "")
            if call_name:
                break
        if call_name.endswith("ask"):
            try:
                reply = json.loads(said).get("reply", said)
            except (ValueError, AttributeError):
                reply = said
            return ("text", f"{reply}\n\n## Not confirmed\n- Nothing: both sources agreed.")
        if call_name.endswith("start_helper"):
            return ("text", "I started helpers on the parts. Their work comes back next.")
        if call_name.endswith("my_agents"):
            # ADR 0092: bring in the listed agent the task names, or the first one listed.
            try:
                listed = [entry.get("agent", "") for entry in json.loads(said).get("agents", [])]
            except (ValueError, AttributeError):
                listed = []
            brief = latest_task(messages)
            wanted = brief.rsplit("MOCK-MY-AGENTS:", 1)[1].split()[0].lower() if "MOCK-MY-AGENTS:" in brief else ""
            chosen = next((agent for agent in listed if wanted and wanted in agent.lower()), listed[0] if listed else "")
            dispatch = find_tool(names, "dispatch")
            if chosen and dispatch:
                return ("calls", [(dispatch, {"agent": chosen, "task": "The part no one on this team does: find three facts with a source for each."})])
            return ("text", "None of your other agents can help here, so I did it myself.")
        if call_name.endswith("list_files") and "MOCK-WAIT:" in latest_task(messages):
            brief = latest_task(messages)
            time.sleep(float(brief.rsplit("MOCK-WAIT:", 1)[1].split()[0]))
            part = brief.strip().splitlines()[0]
            return ("text", f"- {part}: three sources agree ([Example](https://example.com/{len(part)}), 2026-10-01).\n- Not confirmed: the 2026 figure.")
        if call_name.endswith("dispatch"):
            # Both dispatches answered with "accepted": end this turn; the results come back later.
            return ("text", "I handed the two parts of the question to the Researcher. Their findings come back next.")
        return ("text", f"Done. The tool answered: {said[:300]}")

    # The chat's read of an @ message (intent.rs): one turn, one word.
    if any("You read one message sent to a LoomWatch team" in text_of(m.get("content")) for m in messages):
        said = latest.split("<message>", 1)[-1].split("</message>", 1)[0].strip().lower()
        first = said.split()[0].strip(",.!") if said else ""
        talk = said.endswith("?") or first in ("hi", "hello", "hey", "thanks", "thank", "explain")
        return ("text", "TALK" if talk else "WORK")

    # The learner (ADR 0078): one turn, JSON only. It learns only from the person's words.
    if "You keep the lessons a LoomWatch agent learns" in system:
        said = latest.split("Then the person wrote this about the work:", 1)[-1].split("\n\n", 1)[0].lower()
        if "Then the person wrote" in latest and "vietnamese" in said:
            return ("text", json.dumps({"edits": [{"do": "add", "lesson": "When replying to this person, always write in Vietnamese.", "aboutYou": True}]}))
        if "Then the person wrote" in latest and any(word in said for word in ("too long", "shorter", "bullet")):
            if "1. When answering, keep it to three short bullets." in latest:
                return ("text", json.dumps({"edits": [{"do": "missed", "number": 1}]}))
            return ("text", json.dumps({"edits": [{"do": "add", "lesson": "When answering, keep it to three short bullets."}]}))
        return ("text", json.dumps({"edits": []}))
    if "## What you have learned" in system and "keep it to three short bullets" in system:
        return ("text", "- First point, short.\n- Second point, short.\n- Third point, short.")

    task = latest.rsplit("## Task", 1)[-1]
    if "## What the agents you started came back with" in latest:
        return ("text", "# What the team found\n\nThe agent I brought in sent back three facts, each with a source, and I checked them against the request.")
    if "MOCK-MY-AGENTS" in task and find_tool(names, "my_agents"):
        return ("calls", [(find_tool(names, "my_agents"), {})])
    if "## What your helpers came back with" in latest:
        parts = [line.split(":", 1)[0].lstrip("- ").strip() for line in latest.splitlines() if line.startswith("- Part ")]
        return ("text", "# What I found\n\nI split this into " + str(len(parts)) + " parts and checked what came back.\n\n"
                + "\n".join(f"- **{part}**: three sources agree." for part in parts) + "\n\nNot confirmed: the 2026 figure.")
    helper = find_tool(names, "start_helper")
    if "MOCK-HELPERS:" in task and helper:
        count = int(task.rsplit("MOCK-HELPERS:", 1)[1].split()[0])
        return ("calls", [(helper, {"title": f"Part {i}", "task": f"Part {i} of the question. MOCK-WAIT: {2 + 2 * i}",
                                    "send_back": "A list of findings with links, and what you could not confirm."})
                          for i in range(1, count + 1)])
    if "MOCK-WAIT:" in task and find_tool(names, "list_files"):
        return ("calls", [(find_tool(names, "list_files"), {"path": "."})])
    if "MOCK-LONG:" in task:
        return ("text", long_answer(int(task.rsplit("MOCK-LONG:", 1)[1].split()[0])))
    if "MOCK-RUN:" in task:
        command = task.rsplit("MOCK-RUN:", 1)[1].strip().splitlines()[0]
        return ("calls", [(find_tool(names, "run_command") or "run_command", {"command": command})])
    if "MOCK-WRITE:" in task:
        path = task.rsplit("MOCK-WRITE:", 1)[1].strip().split()[0]
        return ("calls", [(find_tool(names, "write_file") or "write_file",
                           {"path": path, "content": "# Notes\n\nWritten by the mock model.\n"})])

    if "MOCK-READ:" in task:
        path = task.rsplit("MOCK-READ:", 1)[1].strip().split()[0]
        return ("calls", [(find_tool(names, "read_file") or "read_file", {"path": path})])

    if "MOCK-TOOL:" in task:
        line = task.rsplit("MOCK-TOOL:", 1)[1].strip().splitlines()[0]
        call, _, arguments = line.partition(" ")
        try:
            args = json.loads(arguments) if arguments.strip() else {}
        except ValueError:
            args = {}
        return ("calls", [(find_tool(names, call) or call, args)])

    dispatch = find_tool(names, "dispatch")
    ask = find_tool(names, "ask")
    if "team’s research lead" in lower_system or "team's research lead" in lower_system:
        if "came back with" in latest and ask:
            return ("calls", [(ask, {"agent": "writer", "question":
                "Write a short report that answers: what makes a good onboarding guide? Use only these "
                "findings, with a numbered citation after every claim and a ## Sources list.\n\n"
                "Findings: short guides get finished more often [https://example.com/a, 2026-09-01]; "
                "screenshots help newcomers [https://example.com/b, 2026-08-15]."})])
        if dispatch:
            return ("calls", [
                (dispatch, {"agent": "researcher", "task": "Sub-question 1: how long should an onboarding guide be? Send back findings with sources."}),
                (dispatch, {"agent": "researcher", "task": "Sub-question 2: do screenshots help newcomers? Send back findings with sources."}),
            ])
    if "you are the team’s researcher" in lower_system:
        return ("text", "## Summary\nShort guides get finished more often.\n\n## Findings\n- Guides under one page are finished twice as often ([Example A](https://example.com/a), 2026-09-01).\n\n## Conflicts and gaps\nNone found.\n\n## Sources\n- Example A — https://example.com/a — 2026-09-01")
    if "you are the team’s writer" in lower_system:
        return ("text", "# What makes a good onboarding guide\n\nShort guides get finished more often [1]. Screenshots help newcomers follow along [2].\n\n## Sources\n1. Example A — https://example.com/a — 2026-09-01\n2. Example B — https://example.com/b — 2026-08-15")
    return ("text", f"Mock reply: {latest.strip()[:160]}")


# ------------------------------------------------------------------------- Anthropic's Messages shape
# OpenRouter answers a Claude through /api/v1/messages in Anthropic's shape; scripts/mock-vendors.py's
# stand-in for Anthropic streams the same events.


def signature(thinking):
    """The signature a thinking block is sent with; a replay must bring it back unchanged."""
    return "mock-sig-" + hashlib.sha256(thinking.encode()).hexdigest()[:24]


def long_answer(count):
    """About `count` words of a cited Markdown report: headings, paragraphs, a list and links."""
    sentence = ("Short onboarding guides are finished more often than long ones, and a screenshot "
                "beside each step helps a newcomer follow along ([Example](https://example.com/{n}), 2026-09-01).")
    parts, total, n = ["# Findings"], 2, 0
    while total < count:
        n += 1
        if n % 6 == 1:
            parts.append(f"## Part {n // 6 + 1}")
        line = sentence.format(n=n)
        parts.append(f"- {line}" if n % 3 == 0 else line)
        total += len(line.split(" "))
    return "\n\n".join(parts)


def words(text):
    pieces = text.split(" ")
    # A long answer streams three words at a time, as a real model's tokens arrive; a short one in four.
    step = 3 if len(pieces) > 200 else max(1, len(pieces) // 4)
    for start in range(0, len(pieces), step):
        piece = " ".join(pieces[start:start + step])
        yield piece + (" " if start + step < len(pieces) else "")


def claude_conversation(body):
    """The Messages body as the chat-completions shape the scripted replies read."""
    system = body.get("system")
    if isinstance(system, list):
        system = "".join(block.get("text", "") for block in system if isinstance(block, dict))
    conversation = [{"role": "system", "content": system or ""}]
    for message in body.get("messages") or []:
        content = message.get("content")
        blocks = [{"type": "text", "text": content}] if isinstance(content, str) else (content or [])
        if message.get("role") == "assistant":
            calls = [{"id": b.get("id"), "function": {"name": b.get("name")}} for b in blocks if b.get("type") == "tool_use"]
            text = "".join(b.get("text", "") for b in blocks if b.get("type") == "text")
            conversation.append({"role": "assistant", "content": text, "tool_calls": calls})
            continue
        text = "".join(b.get("text", "") for b in blocks if b.get("type") == "text")
        if text:
            conversation.append({"role": "user", "content": text})
        for block in blocks:
            if block.get("type") == "tool_result":
                result = block.get("content")
                if isinstance(result, list):
                    result = "".join(part.get("text", "") for part in result if isinstance(part, dict))
                conversation.append({"role": "tool", "tool_call_id": block.get("tool_use_id"), "content": result or ""})
    return conversation


def claude_events(body, kind, value, number, usage):
    """Anthropic's stream for a scripted answer, as (event name, payload) pairs. `usage` is what the
    closing message_delta reports."""
    prompt = 900 + 40 * len(body.get("messages") or [])
    yield "message_start", {"type": "message_start", "message": {
        "id": f"msg_{number}", "type": "message", "role": "assistant", "model": body.get("model"), "content": [],
        "stop_reason": None, "usage": {"input_tokens": prompt - 600, "cache_read_input_tokens": 600,
                                       "cache_creation_input_tokens": 0, "output_tokens": 1}}}
    yield "ping", {"type": "ping"}
    index = 0
    if (body.get("thinking") or {}).get("type") == "adaptive":
        thought = f"Working out step {number}."
        yield "content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": "", "signature": ""}}
        yield "content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": thought}}
        yield "content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": signature(thought)}}
        yield "content_block_stop", {"type": "content_block_stop", "index": 0}
        index = 1
    if kind == "text":
        yield "content_block_start", {"type": "content_block_start", "index": index, "content_block": {"type": "text", "text": ""}}
        pieces = list(words(value))
        for piece in pieces:
            yield "content_block_delta", {"type": "content_block_delta", "index": index, "delta": {"type": "text_delta", "text": piece}}
            time.sleep(0.01 if len(pieces) > 50 else 0.05)
        yield "content_block_stop", {"type": "content_block_stop", "index": index}
        stop = "end_turn"
    else:
        for offset, (name, args) in enumerate(value):
            at = index + offset
            arguments = json.dumps(args)
            half = len(arguments) // 2
            yield "content_block_start", {"type": "content_block_start", "index": at, "content_block": {
                "type": "tool_use", "id": f"toolu_{number}_{offset}", "name": name, "input": {}}}
            yield "content_block_delta", {"type": "content_block_delta", "index": at, "delta": {"type": "input_json_delta", "partial_json": arguments[:half]}}
            time.sleep(0.03)
            yield "content_block_delta", {"type": "content_block_delta", "index": at, "delta": {"type": "input_json_delta", "partial_json": arguments[half:]}}
            yield "content_block_stop", {"type": "content_block_stop", "index": at}
        stop = "tool_use"
    yield "message_delta", {"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None}, "usage": usage}
    yield "message_stop", {"type": "message_stop"}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def send_json(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authorised(self):
        auth = self.headers.get("Authorization", "")
        return auth.startswith("Bearer sk-or-v1-mock")

    def do_GET(self):
        if self.path.startswith("/api/v1/models"):
            log({"at": time.time(), "path": self.path})
            return self.send_json(200, {"data": MODELS})
        if self.path.startswith("/api/v1/key"):
            log({"at": time.time(), "path": self.path, "authorised": self.authorised()})
            if not self.authorised():
                return self.send_json(401, {"error": {"code": 401, "message": "No auth credentials found"}})
            return self.send_json(200, {"data": {"label": "sk-or-v1-moc...ock", "usage": 0.42,
                                                 "usage_monthly": 0.17, "limit_remaining": 9.58,
                                                 "is_free_tier": False}})
        self.send_json(404, {"error": {"code": 404, "message": "not found"}})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        COUNTER[0] += 1
        number = COUNTER[0]
        messages = body.get("messages") or []
        users = [text_of(m.get("content")) for m in messages if m.get("role") == "user"]
        entry = {"at": time.time(), "n": number, "path": self.path, "authorised": self.authorised(),
                 "model": body.get("model"), "stream": body.get("stream"),
                 "reasoning": body.get("reasoning"), "tools": tool_names(body),
                 "messages": len(messages), "latest_user": (users[-1] if users else "")[:200],
                 "system_head": text_of(messages[0].get("content"))[:120] if messages else ""}
        if self.path.startswith("/api/alpha/decisions"):
            state = str(body.get("state") or "")
            log({**entry, "answer": "decision", "questions": sorted((body.get("questions") or {}).keys()),
                 "state_head": state[:120]})
            if not self.authorised():
                return self.send_json(401, {"error": {"code": 401, "message": "No auth credentials found"}})
            if "MOCK-FAIL-402" in state:
                return self.send_json(402, {"error": {"code": 402, "message": "Insufficient credits"}})
            tokens = len(state) // 4 + 200
            return self.send_json(200, {"id": f"dec-{number}", "model": body.get("model"), "provider": "Mock",
                                        "answers": {"job": read_setup(state)},
                                        "usage": {"input_tokens": tokens, "output_tokens": 0,
                                                  "cost": round(tokens * 0.000000042, 9)}})
        if self.path.startswith("/api/v1/messages"):
            return self.messages(body, number, entry)
        if not self.path.startswith("/api/v1/chat/completions"):
            return self.send_json(404, {"error": {"code": 404, "message": "not found"}})
        if not self.authorised():
            log({**entry, "answer": "401"})
            return self.send_json(401, {"error": {"code": 401, "message": "No auth credentials found"}})
        if "MOCK-FAIL-402" in (users[-1] if users else "").rsplit("## Task", 1)[-1]:
            log({**entry, "answer": "402"})
            return self.send_json(402, {"error": {"code": 402, "message": "Insufficient credits"}})
        # The whole latest request, for checking what an agent was told (skills, orientation).
        with LOCK:
            with open(os.path.join(HERE, "last_request.json"), "w") as handle:
                json.dump(body, handle, indent=1)
        kind, value = plan(body)
        log({**entry, "answer": kind, "detail": value if kind == "calls" else value[:120]})

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        def event(payload):
            self.wfile.write(b"data: " + json.dumps(payload).encode() + b"\n\n")
            self.wfile.flush()

        self.wfile.write(b": OPENROUTER PROCESSING\n\n")
        base = {"id": f"gen-{number}", "model": body.get("model"), "object": "chat.completion.chunk"}
        if kind == "text":
            pieces = list(words(value))
            for piece in pieces:
                event({**base, "choices": [{"index": 0, "delta": {"role": "assistant", "content": piece}, "finish_reason": None}]})
                time.sleep(0.01 if len(pieces) > 50 else 0.05)
            finish = "stop"
        else:
            for index, (name, args) in enumerate(value):
                arguments = json.dumps(args)
                half = len(arguments) // 2
                event({**base, "choices": [{"index": 0, "delta": {"tool_calls": [
                    {"index": index, "id": f"call_{number}_{index}", "type": "function",
                     "function": {"name": name, "arguments": arguments[:half]}}]}, "finish_reason": None}]})
                time.sleep(0.03)
                event({**base, "choices": [{"index": 0, "delta": {"tool_calls": [
                    {"index": index, "function": {"arguments": arguments[half:]}}]}, "finish_reason": None}]})
            finish = "tool_calls"
        prompt_tokens = 900 + 40 * len(messages)
        event({**base, "choices": [{"index": 0, "delta": {}, "finish_reason": finish}],
               "usage": {"prompt_tokens": prompt_tokens, "completion_tokens": 120,
                         "prompt_tokens_details": {"cached_tokens": 600},
                         "cost": round(prompt_tokens * 0.000002 + 120 * 0.00001, 6)}})
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def messages(self, body, number, entry):
        """A Claude's call, in Anthropic's shape, as OpenRouter's /api/v1/messages answers it."""
        conversation = claude_conversation(body)
        entry = {**entry, "messages": len(body.get("messages") or []), "thinking": body.get("thinking"),
                 "effort": (body.get("output_config") or {}).get("effort"), "tool_choice": body.get("tool_choice"),
                 "latest_user": next((m["content"] for m in reversed(conversation) if m["role"] == "user"), "")[:200],
                 "system_head": conversation[0]["content"][:120]}
        if not self.authorised():
            log({**entry, "answer": "401"})
            return self.send_json(401, {"error": {"code": 401, "message": "No auth credentials found"}})
        users = [m["content"] for m in conversation if m["role"] == "user"]
        if "MOCK-FAIL-402" in (users[-1] if users else "").rsplit("## Task", 1)[-1]:
            log({**entry, "answer": "402"})
            return self.send_json(402, {"error": {"code": 402, "message": "Insufficient credits"}})
        with LOCK:
            with open(os.path.join(HERE, "last_request.json"), "w") as handle:
                json.dump(body, handle, indent=1)
        tools = [{"function": {"name": name}} for name in tool_names(body)]
        kind, value = plan({"messages": conversation, "tools": tools})
        if (body.get("tool_choice") or {}).get("type") == "none" and kind == "calls":
            kind, value = "text", "Here is where the work stands: nothing more to call."
        log({**entry, "answer": kind, "detail": value if kind == "calls" else value[:120]})

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        prompt = 900 + 40 * len(body.get("messages") or [])
        usage = {"input_tokens": prompt - 600, "cache_read_input_tokens": 600, "output_tokens": 120,
                 "cost": round(prompt * 0.000002 + 120 * 0.00001, 6)}
        for name, payload in claude_events(body, kind, value, number, usage):
            self.wfile.write(f"event: {name}\n".encode() + b"data: " + json.dumps(payload).encode() + b"\n\n")
            self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4100
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
