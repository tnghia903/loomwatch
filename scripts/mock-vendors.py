"""Stand-ins for Anthropic and OpenAI on 127.0.0.1, for end-to-end checks of LoomWatch's two plan
sources (ADR 0073) with no real key, no ChatGPT account and no spending.

Two servers start, one per vendor:

- Anthropic on <port> (default 4200): the key check and model list (GET /v1/models) and streamed
  Messages calls (POST /v1/messages). Only a key starting "sk-ant-api03-mock" is accepted.
- OpenAI on <port>+1 (default 4201): the "Sign in with ChatGPT" pages (GET /api/accounts/authorize,
  a stand-in consent page whose Continue button sends the browser back to LoomWatch), the token,
  refresh and revoke endpoints (POST /api/accounts/oauth/token and /revoke), the plan's model list
  (GET /v1/models) and streamed Responses calls (POST /v1/responses).

Start the daemon with LOOMWATCH_ANTHROPIC_URL=http://127.0.0.1:4200,
LOOMWATCH_OPENAI_AUTH_URL=http://127.0.0.1:4201 and LOOMWATCH_OPENAI_URL=http://127.0.0.1:4201.
Each is honoured only for a loopback address.

Replies are scripted from the task the same way scripts/mock-openrouter.py scripts them (MOCK-RUN:,
MOCK-WRITE:, MOCK-READ:, MOCK-TOOL:, the research team's roles), so a run makes real tool calls. On
top of those, in the text after the last "## Task":

- "MOCK-FAIL-CREDIT"  -> Anthropic: 400 "Your credit balance is too low", as when the credit is gone
- "MOCK-FAIL-LIMIT"   -> OpenAI: 429 subscription_sharing_usage_limit_exceeded (the plan's limit)
- "MOCK-FAIL-PLAN"    -> OpenAI: 403 subscription_sharing_user_not_eligible (a Free or Go plan)

MOCK_CHATGPT_PLAN_OFF=1 makes a sign-in come back without the plan-use scope, as when the person
turned plan use off on the consent page.

Each request is checked against the vendor's rules and refused the way the vendor refuses it: a
system-role item or a field plan usage doesn't take (OpenAI), a thinking block replayed with a
changed signature or a system message in `messages` (Anthropic). So a body LoomWatch shapes wrong
fails here as it would live.

Every request is logged to vendors.jsonl, and each vendor's latest body in full to
last_anthropic.json and last_openai.json, in $MOCK_VENDORS_LOG (default: the system's temporary
folder). Nothing is written elsewhere.

Usage: python3 scripts/mock-vendors.py [port]   (default 4200; OpenAI on port + 1)
"""

import base64
import hashlib
import importlib.util
import json
import os
import secrets
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlparse

HERE = os.environ.get("MOCK_VENDORS_LOG") or tempfile.gettempdir()
LOG = os.path.join(HERE, "vendors.jsonl")
LOCK = threading.Lock()
COUNTER = [0]

# The scripted replies are mock-openrouter.py's, so every stand-in answers a task alike.
_SPEC = importlib.util.spec_from_file_location(
    "mock_openrouter", os.path.join(os.path.dirname(os.path.abspath(__file__)), "mock-openrouter.py"))
SCRIPT = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(SCRIPT)

CLAUDE_MODELS = [
    {"id": "claude-opus-5-5", "display_name": "Claude Opus 5.5", "max_input_tokens": 1000000, "max_tokens": 128000},
    {"id": "claude-sonnet-5-5", "display_name": "Claude Sonnet 5.5", "max_input_tokens": 1000000, "max_tokens": 64000},
    {"id": "claude-haiku-5-5", "display_name": "Claude Haiku 5.5", "max_input_tokens": 200000, "max_tokens": 64000},
]

PLAN_MODELS = [
    {"slug": "gpt-6.1-sol", "display_name": "GPT-6.1-Sol", "context_window": 400000, "priority": 1},
    {"slug": "gpt-6-luna", "display_name": "GPT-6-Luna", "context_window": 272000, "priority": 4},
    {"slug": "gpt-6-astra", "display_name": "GPT-6-Astra", "context_window": 500000, "priority": 2},
    {"slug": "gpt-5.6-terra", "display_name": "GPT-5.6-Terra", "context_window": 272000, "priority": 6},
    {"slug": "codex-auto-review", "display_name": "Codex review", "context_window": 272000, "priority": 9,
     "visibility": "hide"},
]

# What plan usage refuses in a Responses body (developers.openai.com/siwc/token-sharing-open-source).
NOT_TAKEN = ["background", "conversation", "max_output_tokens", "max_tool_calls", "metadata", "moderation",
             "multi_agent", "prompt", "prompt_cache_retention", "safety_identifier", "temperature",
             "top_logprobs", "top_p", "truncation", "user", "previous_response_id"]

# OpenAI's sign-in state: codes waiting to be exchanged, and the refresh tokens it gave.
CODES = {}
REFRESH = {}


def log(entry):
    with LOCK:
        with open(LOG, "a") as handle:
            handle.write(json.dumps(entry) + "\n")


def keep(name, body):
    with LOCK:
        with open(os.path.join(HERE, name), "w") as handle:
            json.dump(body, handle, indent=1)


def next_number():
    with LOCK:
        COUNTER[0] += 1
        return COUNTER[0]


signature = SCRIPT.signature


def b64(data):
    return base64.urlsafe_b64encode(json.dumps(data).encode()).decode().rstrip("=")


def jwt(claims):
    """A token shaped like a JWT. Unsigned: LoomWatch reads its claims over TLS, as OIDC allows."""
    return f"{b64({'alg': 'none', 'typ': 'JWT'})}.{b64(claims)}.mock"


def task_of(conversation):
    users = [m["content"] for m in conversation if m.get("role") == "user"]
    return (users[-1] if users else "").rsplit("## Task", 1)[-1]


words = SCRIPT.words


class Base(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def send_json(self, status, payload, headers=None):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(data)

    def send_html(self, status, html):
        data = html.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def start_stream(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

    def event(self, payload, name=None):
        head = f"event: {name}\n".encode() if name else b""
        self.wfile.write(head + b"data: " + json.dumps(payload).encode() + b"\n\n")
        self.wfile.flush()


# ---------------------------------------------------------------------------------------- Anthropic


claude_conversation = SCRIPT.claude_conversation


def claude_refusal(body):
    """Why Anthropic would refuse this body, if it would."""
    if not isinstance(body.get("max_tokens"), int):
        return "max_tokens: Field required"
    for message in body.get("messages") or []:
        if message.get("role") not in ("user", "assistant"):
            return f"messages: Unexpected role \"{message.get('role')}\". Use the top-level system parameter."
        content = message.get("content")
        for block in content if isinstance(content, list) else []:
            if block.get("type") == "thinking" and block.get("signature") != signature(block.get("thinking", "")):
                return "messages: Invalid `signature` in `thinking` block"
    thinking = body.get("thinking") or {}
    if thinking.get("type") == "enabled" or "budget_tokens" in thinking:
        return "thinking.type: \"enabled\" is not supported for this model. Use \"adaptive\"."
    if (body.get("tool_choice") or {}).get("type") in ("any", "tool") and thinking.get("type") == "adaptive":
        return "tool_choice: Thinking may not be enabled when tool_choice forces tool use."
    return None


class Anthropic(Base):
    def authorised(self):
        return self.headers.get("x-api-key", "").startswith("sk-ant-api03-mock")

    def do_GET(self):
        if not self.path.startswith("/v1/models"):
            return self.send_json(404, {"type": "error", "error": {"type": "not_found_error", "message": "Not found"}})
        log({"at": time.time(), "vendor": "anthropic", "path": self.path, "authorised": self.authorised()})
        if not self.authorised():
            return self.send_json(401, {"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}})
        effort = {"supported": True, **{level: {"supported": True} for level in ("low", "medium", "high", "xhigh", "max")}}
        data = [{"type": "model", "created_at": "2026-09-01T00:00:00Z", **model,
                 "capabilities": {"thinking": {"supported": True, "types": {"adaptive": {"supported": True}}},
                                  "effort": effort}} for model in CLAUDE_MODELS]
        return self.send_json(200, {"data": data, "has_more": False, "first_id": data[0]["id"], "last_id": data[-1]["id"]})

    def do_POST(self):
        raw = self.read_body()
        if not self.path.startswith("/v1/messages"):
            return self.send_json(404, {"type": "error", "error": {"type": "not_found_error", "message": "Not found"}})
        body = json.loads(raw or b"{}")
        number = next_number()
        conversation = claude_conversation(body)
        tools = [{"function": {"name": tool.get("name")}} for tool in body.get("tools") or [] if tool.get("name")]
        entry = {"at": time.time(), "n": number, "vendor": "anthropic", "model": body.get("model"),
                 "authorised": self.authorised(), "thinking": body.get("thinking"),
                 "effort": (body.get("output_config") or {}).get("effort"), "tool_choice": body.get("tool_choice"),
                 "tools": [tool["function"]["name"] for tool in tools], "messages": len(body.get("messages") or []),
                 "beta": self.headers.get("anthropic-beta")}
        keep("last_anthropic.json", body)
        if not self.authorised():
            log({**entry, "answer": "401"})
            return self.send_json(401, {"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}})
        refused = claude_refusal(body)
        if refused:
            log({**entry, "answer": "400", "why": refused})
            return self.send_json(400, {"type": "error", "error": {"type": "invalid_request_error", "message": refused}})
        if body.get("model") not in [model["id"] for model in CLAUDE_MODELS]:
            log({**entry, "answer": "404"})
            return self.send_json(404, {"type": "error", "error": {"type": "not_found_error", "message": f"model: {body.get('model')}"}})
        if "MOCK-FAIL-CREDIT" in task_of(conversation):
            log({**entry, "answer": "credit"})
            return self.send_json(400, {"type": "error", "error": {"type": "invalid_request_error", "message":
                "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}})

        forced_off = (body.get("tool_choice") or {}).get("type") == "none"
        kind, value = SCRIPT.plan({"messages": conversation, "tools": tools})
        if forced_off and kind == "calls":
            kind, value = "text", "Here is where the work stands: nothing more to call."
        log({**entry, "answer": kind, "detail": value if kind == "calls" else value[:120]})

        self.start_stream()
        for name, payload in SCRIPT.claude_events(body, kind, value, number, {"output_tokens": 120}):
            self.event(payload, name)


# ------------------------------------------------------------------------------------------- OpenAI


def plan_conversation(body):
    """The Responses body as the chat-completions shape the scripted replies read."""
    conversation = [{"role": "system", "content": body.get("instructions") or ""}]
    for item in body.get("input") or []:
        kind = item.get("type", "message")
        if kind == "message":
            content = item.get("content")
            text = content if isinstance(content, str) else "".join(
                part.get("text", "") for part in content or [] if isinstance(part, dict))
            role = "system" if item.get("role") == "developer" else item.get("role")
            conversation.append({"role": role, "content": text})
        elif kind == "function_call":
            conversation.append({"role": "assistant", "content": "", "tool_calls": [
                {"id": item.get("call_id"), "function": {"name": item.get("name")}}]})
        elif kind == "function_call_output":
            conversation.append({"role": "tool", "tool_call_id": item.get("call_id"), "content": item.get("output") or ""})
    return conversation


def plan_tools(body):
    names = []
    for tool in body.get("tools") or []:
        if tool.get("type") == "namespace":
            names.extend(inner.get("name") for inner in tool.get("tools") or [] if inner.get("name"))
        elif tool.get("type") == "function" and tool.get("name"):
            names.append(tool["name"])
    return names


def plan_refusal(body):
    """Why plan usage would refuse this body, if it would: (status, error)."""
    for item in body.get("input") or []:
        if item.get("role") == "system":
            return 400, {"detail": "System messages are not allowed"}
    for field in NOT_TAKEN:
        if field in body:
            return 400, {"error": {"code": "subscription_sharing_unsupported_capability", "param": field,
                                   "message": f"{field} is not supported with ChatGPT plan usage."}}
    if body.get("store") is not False:
        return 400, {"error": {"code": "subscription_sharing_unsupported_capability", "param": "store",
                               "message": "store must be false with ChatGPT plan usage."}}
    if body.get("stream") is not True:
        return 400, {"error": {"code": "subscription_sharing_unsupported_capability", "param": "stream",
                               "message": "stream must be true with ChatGPT plan usage."}}
    if (body.get("reasoning") or {}).get("effort") == "minimal":
        return 400, {"error": {"code": "unsupported_value", "param": "reasoning.effort",
                               "message": "'minimal' is not supported with this model."}}
    for tool in body.get("tools") or []:
        if tool.get("type") not in ("namespace", "function", "web_search"):
            return 400, {"error": {"code": "subscription_sharing_unsupported_capability", "param": "tools",
                                   "message": f"{tool.get('type')} tools are not supported with ChatGPT plan usage."}}
    return None


class OpenAI(Base):
    def base(self):
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def bearer(self):
        auth = self.headers.get("Authorization", "")
        return auth[len("Bearer "):] if auth.startswith("Bearer ") else ""

    def authorised(self):
        return self.bearer().startswith(f"{b64({'alg': 'none', 'typ': 'JWT'})}.") and self.bearer().endswith(".mock")

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/api/accounts/authorize":
            return self.authorize(parse_qs(url.query))
        if url.path == "/api/accounts/continue":
            return self.consent(parse_qs(url.query))
        if url.path == "/v1/models":
            log({"at": time.time(), "vendor": "openai", "path": self.path, "authorised": self.authorised()})
            if not self.authorised():
                return self.send_json(401, {"error": {"code": "invalid_api_key", "message": "Missing bearer"}})
            models = [{"visibility": "list", "supported_in_api": True, "default_reasoning_level": "medium",
                       "supported_reasoning_levels": [{"effort": level} for level in ("low", "medium", "high", "xhigh", "max")],
                       **model} for model in PLAN_MODELS]
            return self.send_json(200, {"models": models}, {"x-models-etag": "mock"})
        self.send_json(404, {"error": {"message": "not found"}})

    def authorize(self, query):
        one = {key: values[0] for key, values in query.items()}
        missing = [key for key in ("response_type", "client_id", "redirect_uri", "scope", "state", "nonce",
                                   "code_challenge", "code_challenge_method", "ext_agent_host_id") if not one.get(key)]
        redirect = one.get("redirect_uri", "")
        log({"at": time.time(), "vendor": "openai", "path": "/api/accounts/authorize", "client_id": one.get("client_id"),
             "agent_name_hint": one.get("agent_name_hint"), "login_hint": one.get("login_hint"), "missing": missing,
             "redirect_uri": redirect})
        if missing or not redirect.startswith("http://127.0.0.1:"):
            return self.send_html(400, f"<p>Stand-in OpenAI refused the sign-in: missing {missing or 'a 127.0.0.1 redirect'}.</p>")
        name = one.get("agent_name_hint") or "LoomWatch"
        go = "/api/accounts/continue?" + urlencode(one)
        return self.send_html(200, f"""<!doctype html><meta charset="utf-8"><title>Sign in with ChatGPT (stand-in)</title>
<body style="font:16px system-ui;max-width:28rem;margin:4rem auto;color:#222">
<p style="color:#a00;font-size:13px">Stand-in for OpenAI, for testing. Nothing here reaches OpenAI.</p>
<h1 style="font-size:22px">Connect your {name} to ChatGPT</h1>
<p>{name} will be able to use your ChatGPT plan's usage.</p>
<p><a id="continue" href="{go}" style="display:inline-block;padding:.6rem 1.2rem;background:#111;color:#fff;border-radius:999px;text-decoration:none">Continue</a></p>
</body>""")

    def consent(self, query):
        one = {key: values[0] for key, values in query.items()}
        code = "code-" + secrets.token_hex(8)
        client = one["client_id"] if one["client_id"] != "dynamic_agent_client" else "oaiapp_mock" + secrets.token_hex(4)
        scope = "openid profile email offline_access resource.invoke"
        if os.environ.get("MOCK_CHATGPT_PLAN_OFF") != "1":
            scope += " chatgpt.tokens.use.direct"
        CODES[code] = {"client_id": client, "nonce": one["nonce"], "verifier_hash": one["code_challenge"],
                       "redirect_uri": one["redirect_uri"], "scope": scope, "email": one.get("login_hint") or "newcomer@example.com"}
        back = one["redirect_uri"] + "?" + urlencode({"code": code, "state": one["state"], "scope": scope, "client_id": client})
        self.send_response(302)
        self.send_header("Location", back)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def tokens(self, client, scope, email, nonce=None):
        now = int(time.time())
        refresh = "rt-mock-" + secrets.token_hex(8)
        REFRESH[refresh] = {"client_id": client, "scope": scope, "email": email}
        answer = {"access_token": jwt({"client_id": client, "scope": scope, "aud": "https://api.openai.com/v1", "exp": now + 3600}),
                  "refresh_token": refresh, "token_type": "Bearer", "expires_in": 3600, "scope": scope,
                  "earliest_refresh_at": now + 3600 - 360}
        if nonce:
            answer["id_token"] = jwt({"iss": self.base(), "aud": [client], "exp": now + 3600, "iat": now, "nonce": nonce,
                                      "sub": "user-mock-1", "email": email, "name": "Stand-in Person"})
        return answer

    def do_POST(self):
        raw = self.read_body()
        url = urlparse(self.path)
        if url.path == "/api/accounts/oauth/token":
            form = {key: values[0] for key, values in parse_qs(raw.decode()).items()}
            grant = form.get("grant_type")
            log({"at": time.time(), "vendor": "openai", "path": url.path, "grant": grant, "client_id": form.get("client_id"),
                 "resource": form.get("resource"), "scope_sent": "scope" in form})
            if grant == "authorization_code":
                held = CODES.pop(form.get("code", ""), None)
                challenge = base64.urlsafe_b64encode(hashlib.sha256(form.get("code_verifier", "").encode()).digest()).decode().rstrip("=")
                if not held or held["client_id"] != form.get("client_id") or held["redirect_uri"] != form.get("redirect_uri") \
                        or held["verifier_hash"] != challenge:
                    return self.send_json(400, {"error": "invalid_grant", "error_description": "code, client, redirect or verifier wrong"})
                return self.send_json(200, self.tokens(held["client_id"], held["scope"], held["email"], held["nonce"]))
            if grant == "refresh_token":
                held = REFRESH.pop(form.get("refresh_token", ""), None)
                if not held or held["client_id"] != form.get("client_id") or "scope" in form:
                    return self.send_json(400, {"error": "invalid_grant", "error_description": "refresh token unknown or reused"})
                return self.send_json(200, self.tokens(held["client_id"], held["scope"], held["email"]))
            return self.send_json(400, {"error": "unsupported_grant_type"})
        if url.path == "/api/accounts/oauth/revoke":
            form = {key: values[0] for key, values in parse_qs(raw.decode()).items()}
            REFRESH.pop(form.get("token", ""), None)
            log({"at": time.time(), "vendor": "openai", "path": url.path, "hint": form.get("token_type_hint")})
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None
        if url.path != "/v1/responses":
            return self.send_json(404, {"error": {"message": "not found"}})
        return self.respond(json.loads(raw or b"{}"))

    def respond(self, body):
        number = next_number()
        conversation = plan_conversation(body)
        names = plan_tools(body)
        entry = {"at": time.time(), "n": number, "vendor": "openai", "model": body.get("model"),
                 "authorised": self.authorised(), "reasoning": body.get("reasoning"), "tool_choice": body.get("tool_choice"),
                 "tools": names, "input": len(body.get("input") or []), "prompt_cache_key": body.get("prompt_cache_key")}
        keep("last_openai.json", body)
        if not self.authorised():
            log({**entry, "answer": "401"})
            return self.send_json(401, {"error": {"code": "subscription_sharing_invalid_user", "message": "Sign in again."}})
        refused = plan_refusal(body)
        if refused:
            log({**entry, "answer": str(refused[0]), "why": refused[1]})
            return self.send_json(*refused)
        if body.get("model") not in [model["slug"] for model in PLAN_MODELS]:
            log({**entry, "answer": "404"})
            return self.send_json(404, {"error": {"code": "model_not_found", "message": f"The model {body.get('model')} does not exist."}})
        task = task_of(conversation)
        if "MOCK-FAIL-LIMIT" in task:
            log({**entry, "answer": "limit"})
            return self.send_json(429, {"error": {"code": "subscription_sharing_usage_limit_exceeded",
                                                  "message": "You've reached your ChatGPT plan's usage limit."}})
        if "MOCK-FAIL-PLAN" in task:
            log({**entry, "answer": "not eligible"})
            return self.send_json(403, {"error": {"code": "subscription_sharing_user_not_eligible",
                                                  "message": "This ChatGPT plan can't share usage with apps."}})

        kind, value = SCRIPT.plan({"messages": conversation, "tools": [{"function": {"name": name}} for name in names]})
        if body.get("tool_choice") == "none" and kind == "calls":
            kind, value = "text", "Here is where the work stands: nothing more to call."
        log({**entry, "answer": kind, "detail": value if kind == "calls" else value[:120]})

        self.start_stream()
        response = {"id": f"resp_{number}", "object": "response", "model": body.get("model"), "status": "in_progress", "output": []}
        self.event({"type": "response.created", "response": response}, "response.created")
        position = 0
        if "reasoning.encrypted_content" in (body.get("include") or []):
            reasoning = {"type": "reasoning", "id": f"rs_{number}", "summary": [],
                         "encrypted_content": "enc-" + secrets.token_hex(12)}
            self.event({"type": "response.output_item.added", "output_index": 0, "item": {**reasoning, "encrypted_content": None}}, "response.output_item.added")
            self.event({"type": "response.output_item.done", "output_index": 0, "item": reasoning}, "response.output_item.done")
            position = 1
        if kind == "text":
            item_id = f"msg_{number}"
            self.event({"type": "response.output_item.added", "output_index": position, "item": {
                "type": "message", "id": item_id, "role": "assistant", "status": "in_progress", "content": []}}, "response.output_item.added")
            for piece in words(value):
                self.event({"type": "response.output_text.delta", "item_id": item_id, "output_index": position,
                            "content_index": 0, "delta": piece}, "response.output_text.delta")
                time.sleep(0.05)
            self.event({"type": "response.output_item.done", "output_index": position, "item": {
                "type": "message", "id": item_id, "role": "assistant", "status": "completed",
                "content": [{"type": "output_text", "text": value, "annotations": []}]}}, "response.output_item.done")
        else:
            for offset, (name, args) in enumerate(value):
                item = {"type": "function_call", "id": f"fc_{number}_{offset}", "call_id": f"call_{number}_{offset}",
                        "name": name, "namespace": "loomwatch", "arguments": json.dumps(args), "status": "completed"}
                self.event({"type": "response.output_item.added", "output_index": position + offset,
                            "item": {**item, "arguments": "", "status": "in_progress"}}, "response.output_item.added")
                time.sleep(0.03)
                self.event({"type": "response.output_item.done", "output_index": position + offset, "item": item}, "response.output_item.done")
        prompt = 900 + 40 * len(body.get("input") or [])
        # As live: the finished response's output is empty; the items came one by one above.
        self.event({"type": "response.completed", "response": {**response, "status": "completed", "usage": {
            "input_tokens": prompt, "input_tokens_details": {"cached_tokens": 600, "cache_write_tokens": 0},
            "output_tokens": 120, "output_tokens_details": {"reasoning_tokens": 40}, "total_tokens": prompt + 120}}},
            "response.completed")


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4200
    openai = ThreadingHTTPServer(("127.0.0.1", port + 1), OpenAI)
    threading.Thread(target=openai.serve_forever, daemon=True).start()
    print(f"Stand-in Anthropic on http://127.0.0.1:{port}, OpenAI on http://127.0.0.1:{port + 1}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Anthropic).serve_forever()
