#!/usr/bin/env python3
"""
Persistent Atris Claude SDK terminal with local shell access.

Goals:
- Work from the installed atris-cli package without the backend repo.
- Keep SDK imports lazy so help and /run work even before Python deps exist.
- Make the workspace root explicit and local shell access first-class.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

from runtime_guard import RuntimeGuard, ActionType

logging.getLogger("runtime_guard").setLevel(logging.ERROR)

DIM = "\033[90m"
BOLD = "\033[1m"
RESET = "\033[0m"
CYAN = "\033[96m"
GREEN = "\033[92m"
YELLOW = "\033[93m"
RED = "\033[91m"

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
TEAM_DIR = PACKAGE_ROOT / "atris" / "team"
STATE_DIR = Path.home() / ".atris"
SESSION_STATE_FILE = STATE_DIR / "computer_sessions.json"
AUDIT_LOG_FILE = STATE_DIR / "computer_audit.jsonl"
RESUME_MAX_AGE_SECONDS = 6 * 60 * 60
KNOWN_MODELS = [
    "claude-sonnet-4-6",
    "claude-sonnet-4-5",
    "claude-opus-4-1",
    "claude-3-7-sonnet-latest",
]

_SDK: Dict[str, Any] = {}


def one_line(text: str, limit: int) -> str:
    return " ".join(str(text).split())[:limit]


def maybe_load_dotenv(cwd: Path) -> None:
    try:
        from dotenv import load_dotenv  # type: ignore
    except Exception:
        return

    candidates = [
        cwd / ".env",
        cwd / "backend" / ".env",
        PACKAGE_ROOT / ".env",
    ]
    for candidate in candidates:
        if candidate.exists():
            load_dotenv(candidate)


def ensure_sdk_runtime() -> Dict[str, Any]:
    if _SDK:
        return _SDK

    def _load() -> Dict[str, Any]:
        from claude_agent_sdk import (  # type: ignore
            AssistantMessage,
            ClaudeAgentOptions,
            ClaudeSDKClient,
            ResultMessage,
            SystemMessage,
            TextBlock,
            ToolUseBlock,
        )
        from claude_agent_sdk.types import StreamEvent  # type: ignore

        return {
            "AssistantMessage": AssistantMessage,
            "ClaudeAgentOptions": ClaudeAgentOptions,
            "ClaudeSDKClient": ClaudeSDKClient,
            "ResultMessage": ResultMessage,
            "SystemMessage": SystemMessage,
            "TextBlock": TextBlock,
            "ToolUseBlock": ToolUseBlock,
            "StreamEvent": StreamEvent,
        }

    try:
        _SDK.update(_load())
        return _SDK
    except Exception:
        pass

    auto_install = os.getenv("ATRIS_COMPUTER_AUTO_INSTALL", "1").lower() not in {"0", "false", "no"}
    if not auto_install:
        raise RuntimeError(
            "Missing Python runtime for local computer. Install: "
            f"{sys.executable} -m pip install --user claude-agent-sdk python-dotenv"
        )

    print("  Bootstrapping local Atris SDK runtime...", flush=True)
    cmd = [sys.executable, "-m", "pip", "install", "--user", "claude-agent-sdk", "python-dotenv"]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        msg = (proc.stderr or proc.stdout or "").strip()
        raise RuntimeError(
            "Failed to install local Atris SDK runtime. "
            f"Install manually with: {' '.join(cmd)}\n{msg}"
        )

    _SDK.update(_load())
    return _SDK


def load_persona(name: str) -> str:
    for fname in ("AGENT.md", "MEMBER.md"):
        path = TEAM_DIR / name / fname
        if path.exists():
            return path.read_text()
    flat = TEAM_DIR / f"{name}.md"
    return flat.read_text() if flat.exists() else ""


def list_agents() -> List[str]:
    if not TEAM_DIR.exists():
        return []
    out: List[str] = []
    for item in sorted(TEAM_DIR.iterdir()):
        if item.name.startswith(".") or item.name == "TEAM.md":
            continue
        if item.is_dir() and any((item / f).exists() for f in ("AGENT.md", "MEMBER.md")):
            out.append(item.name)
        elif item.suffix == ".md":
            out.append(item.stem)
    return out


def usage_breakdown(usage: Dict[str, Any]) -> Dict[str, int]:
    def coerce(value: Any) -> int:
        try:
            if value is None:
                return 0
            if isinstance(value, bool):
                return int(value)
            if isinstance(value, (int, float)):
                return int(value)
            return int(float(str(value).strip()))
        except Exception:
            return 0

    prompt_input_tokens = coerce(usage.get("input_tokens") or usage.get("inputTokens"))
    cache_creation_tokens = coerce(
        usage.get("cache_creation_input_tokens") or usage.get("cacheCreationInputTokens")
    )
    cache_read_tokens = coerce(
        usage.get("cache_read_input_tokens") or usage.get("cacheReadInputTokens")
    )
    output_tokens = coerce(usage.get("output_tokens") or usage.get("outputTokens"))
    return {
        "prompt_input_tokens": prompt_input_tokens,
        "cache_creation_tokens": cache_creation_tokens,
        "cache_read_tokens": cache_read_tokens,
        "total_input_tokens": prompt_input_tokens + cache_creation_tokens + cache_read_tokens,
        "output_tokens": output_tokens,
    }


def _load_session_state() -> Dict[str, Any]:
    if not SESSION_STATE_FILE.exists():
        return {}
    try:
        raw = json.loads(SESSION_STATE_FILE.read_text())
        return raw if isinstance(raw, dict) else {}
    except Exception:
        return {}


def _save_session_state(state: Dict[str, Any]) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    SESSION_STATE_FILE.write_text(json.dumps(state, indent=2, sort_keys=True))


def append_audit_entry(entry: Dict[str, Any]) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    with AUDIT_LOG_FILE.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, sort_keys=True) + "\n")


def read_recent_audit_entries(limit: int = 10, cwd: Optional[Path] = None) -> List[Dict[str, Any]]:
    if limit <= 0 or not AUDIT_LOG_FILE.exists():
        return []
    try:
        lines = AUDIT_LOG_FILE.read_text(encoding="utf-8").splitlines()
    except Exception:
        return []
    entries: List[Dict[str, Any]] = []
    cwd_str = str(cwd.resolve()) if cwd else None
    for line in reversed(lines):
        try:
            entry = json.loads(line)
        except Exception:
            continue
        if cwd_str and entry.get("cwd") != cwd_str:
            continue
        entries.append(entry)
        if len(entries) >= limit:
            break
    return list(reversed(entries))


def session_key(agent_name: str, model: str, cwd: Path) -> str:
    return f"{cwd.resolve()}::{agent_name or 'default'}::{model}"


def get_saved_session(agent_name: str, model: str, cwd: Path, max_total_input_tokens: int) -> Optional[str]:
    state = _load_session_state()
    entry = state.get(session_key(agent_name, model, cwd))
    if not isinstance(entry, dict):
        return None
    sid = entry.get("session_id")
    if not isinstance(sid, str) or not sid:
        return None
    updated_at = int(entry.get("updated_at", 0) or 0)
    if updated_at and (int(time.time()) - updated_at) > RESUME_MAX_AGE_SECONDS:
        return None
    last_total_input_tokens = int(entry.get("last_total_input_tokens", 0) or 0)
    if max_total_input_tokens > 0 and last_total_input_tokens > max(20000, int(max_total_input_tokens * 0.5)):
        return None
    return sid


def set_saved_session(
    agent_name: str,
    model: str,
    cwd: Path,
    session_id: Optional[str],
    last_total_input_tokens: int = 0,
) -> None:
    state = _load_session_state()
    key = session_key(agent_name, model, cwd)
    if session_id:
        state[key] = {
            "session_id": session_id,
            "last_total_input_tokens": int(last_total_input_tokens),
            "updated_at": int(time.time()),
        }
    else:
        state.pop(key, None)
    _save_session_state(state)


class Spinner:
    def __init__(self) -> None:
        self.running = False
        self.label = "Thinking"
        self.start_time = 0.0
        self.task: Optional[asyncio.Task[Any]] = None
        self.is_tty = sys.stdout.isatty()

    async def start(self, label: str = "Thinking") -> None:
        self.running = True
        self.label = label
        self.start_time = time.monotonic()
        self.task = asyncio.create_task(self._run())

    async def _run(self) -> None:
        frames = (".", "..", "...", "....")
        idx = 0
        next_emit = 0.0
        while self.running:
            elapsed = time.monotonic() - self.start_time
            dots = frames[idx % len(frames)]
            if self.is_tty:
                print(f"\r  {DIM}{self.label} {elapsed:.1f}s{dots}{RESET}", end="", flush=True)
            elif elapsed >= next_emit:
                print(f"  {DIM}{self.label} {elapsed:.1f}s{dots}{RESET}", flush=True)
                next_emit = elapsed + 1.5
            idx += 1
            await asyncio.sleep(0.2)
        if self.is_tty:
            print("\r" + (" " * 120) + "\r", end="", flush=True)

    def set_label(self, label: str) -> None:
        if self.running:
            self.label = label

    async def stop(self) -> None:
        if not self.running:
            return
        self.running = False
        if self.task:
            await self.task
        self.task = None


def _extract_stream_text(ev: Dict[str, Any]) -> str:
    ev_type = str(ev.get("type") or "")
    if ev_type == "content_block_delta":
        delta = ev.get("delta")
        if isinstance(delta, dict) and delta.get("type") == "text_delta":
            return str(delta.get("text") or "")
        if isinstance(delta, dict) and "text" in delta:
            return str(delta.get("text") or "")
    if ev_type in {"text_delta", "assistant_text_delta"} and isinstance(ev.get("text"), str):
        return str(ev.get("text"))
    if isinstance(ev.get("text"), str):
        return str(ev.get("text"))
    delta = ev.get("delta")
    return delta if isinstance(delta, str) else ""


def _extract_stream_tool_name(ev: Dict[str, Any]) -> Optional[str]:
    ev_type = str(ev.get("type") or "")
    if ev_type == "content_block_start":
        cb = ev.get("content_block")
        if isinstance(cb, dict) and cb.get("type") == "tool_use":
            return str(cb.get("name") or "tool")
    if ev_type == "tool_use":
        return str(ev.get("name") or "tool")
    return None


def tool_summary(inp: Any) -> str:
    if not isinstance(inp, dict):
        return str(inp)[:120]
    for key in ("file_path", "path", "pattern", "query", "command"):
        if key in inp:
            return str(inp[key])[:120]
    return str(inp)[:120]


@dataclass
class ChatState:
    session_id: str
    turns: int = 0
    last_total_input_tokens: int = 0


class AtrisTerminal:
    def __init__(
        self,
        cwd: Path,
        agent_name: str,
        model: str,
        max_turns: Optional[int],
        max_budget_usd: float,
        autoreset_queries: int,
        autotokens_limit: int,
        resume_last: bool,
    ) -> None:
        self.cwd = cwd.resolve()
        self.agent_name = agent_name
        self.model = model
        self.max_turns = max_turns
        self.max_budget_usd = max_budget_usd
        self.autoreset_queries = autoreset_queries
        self.autotokens_limit = autotokens_limit
        self.resume_last = resume_last
        self.spinner = Spinner()
        self.client: Optional[Any] = None
        self.client_ready = False
        self.start_task: Optional[asyncio.Task[Any]] = None
        self.start_error: Optional[BaseException] = None
        self.total_cost = 0.0
        self.persona = load_persona(agent_name)
        self.workspace_prompt = os.getenv("ATRIS_COMPUTER_SYSTEM_PROMPT", "").strip()
        self.guard_enabled = os.getenv("ATRIS_COMPUTER_GUARD", "1").lower() not in {"0", "false", "no"}
        self.guard = RuntimeGuard() if self.guard_enabled else None
        self.audit_enabled = os.getenv("ATRIS_COMPUTER_AUDIT", "1").lower() not in {"0", "false", "no"}

        session_id = f"main-{int(time.time() * 1000)}"
        if resume_last:
            resumed = get_saved_session(agent_name, model, self.cwd, autotokens_limit)
            if resumed:
                session_id = resumed
        self.chat = ChatState(session_id=session_id)
        self.audit("session_open", "ok", f"session opened at {self.cwd}")

    def _system_prompt(self) -> Optional[str]:
        parts = [p for p in (self.workspace_prompt, self.persona) if p]
        return "\n\n".join(parts) if parts else None

    def audit(self, event: str, status: str, summary: str, metadata: Optional[Dict[str, Any]] = None) -> None:
        if not self.audit_enabled:
            return
        entry: Dict[str, Any] = {
            "ts": int(time.time()),
            "event": event,
            "status": status,
            "summary": one_line(summary, 240),
            "cwd": str(self.cwd),
            "agent": self.agent_name,
            "model": self.model,
            "session_id": self.chat.session_id,
            "guard": self.guard_enabled,
        }
        if metadata:
            entry["metadata"] = metadata
        append_audit_entry(entry)

    def print_audit(self, limit: int = 10) -> None:
        entries = read_recent_audit_entries(limit=limit, cwd=self.cwd)
        if not entries:
            print(f"{DIM}No audit entries for this workspace yet.{RESET}")
            return
        print(f"{BOLD}AUDIT{RESET} last {len(entries)} event(s)")
        for entry in entries:
            stamp = time.strftime("%H:%M:%S", time.localtime(int(entry.get("ts") or time.time())))
            event = str(entry.get("event") or "event")
            status = str(entry.get("status") or "")
            summary = one_line(entry.get("summary") or "", 140)
            print(f"  {stamp}  {event:<16} {status:<7} {summary}")

    def _options(self) -> Any:
        sdk = ensure_sdk_runtime()
        return sdk["ClaudeAgentOptions"](
            model=self.model,
            permission_mode="bypassPermissions",
            continue_conversation=True,
            max_turns=self.max_turns,
            max_budget_usd=self.max_budget_usd,
            cwd=str(self.cwd),
            system_prompt=self._system_prompt(),
            include_partial_messages=True,
        )

    async def _start_client(self, quiet: bool = False) -> None:
        sdk = ensure_sdk_runtime()
        if not quiet:
            await self.spinner.start("Starting SDK")
        try:
            self.client = sdk["ClaudeSDKClient"](self._options())
            await self.client.__aenter__()
            self.client_ready = True
        finally:
            if not quiet:
                await self.spinner.stop()

    def warm_start(self) -> None:
        if self.client_ready and self.client is not None:
            return
        if self.start_task is None or self.start_task.done():
            self.start_task = asyncio.create_task(self._start_client(quiet=True))
            self.start_task.add_done_callback(self._capture_start_error)

    def _capture_start_error(self, task: asyncio.Task[Any]) -> None:
        try:
            task.result()
        except asyncio.CancelledError:
            return
        except BaseException as exc:
            self.start_error = exc

    async def start(self) -> None:
        if self.client_ready and self.client is not None:
            return
        if self.start_task is not None:
            task = self.start_task
            if not task.done():
                await self.spinner.start("Finishing SDK start")
            try:
                await task
                return
            finally:
                await self.spinner.stop()
                if self.start_task is task:
                    self.start_task = None

        self.start_task = asyncio.create_task(self._start_client(quiet=False))
        try:
            await self.start_task
        finally:
            self.start_task = None

    async def close(self) -> None:
        if self.start_task is not None and not self.start_task.done():
            self.start_task.cancel()
            try:
                await self.start_task
            except asyncio.CancelledError:
                pass
            self.start_task = None
        if self.client is None:
            return
        try:
            await self.client.__aexit__(None, None, None)
        except Exception:
            pass
        self.client = None
        self.client_ready = False

    async def restart_client(self) -> None:
        await self.close()
        await self.start()

    def reset(self) -> None:
        self.chat = ChatState(session_id=f"main-{int(time.time() * 1000)}")
        set_saved_session(self.agent_name, self.model, self.cwd, None, 0)
        self.audit("session_reset", "ok", "reset active chat")

    def maybe_autoreset(self) -> Optional[str]:
        if self.autoreset_queries > 0 and self.chat.turns >= self.autoreset_queries:
            self.reset()
            return f"query limit reached ({self.autoreset_queries})"
        if self.autotokens_limit > 0 and self.chat.last_total_input_tokens >= self.autotokens_limit:
            self.reset()
            return f"input token limit reached ({self.autotokens_limit:,})"
        return None

    async def switch_agent(self, new_agent: str) -> str:
        if new_agent not in list_agents():
            return f"{RED}Unknown agent: {new_agent}{RESET}"
        self.agent_name = new_agent
        self.persona = load_persona(new_agent)
        self.reset()
        await self.restart_client()
        self.audit("switch_agent", "ok", f"switched agent to {new_agent}")
        return f"{GREEN}Agent switched: {new_agent}{RESET}"

    async def switch_model(self, new_model: str) -> str:
        self.model = new_model
        self.reset()
        await self.restart_client()
        self.audit("switch_model", "ok", f"switched model to {new_model}")
        return f"{GREEN}Model switched: {new_model}{RESET}"

    async def run_shell(self, command: str) -> None:
        if not command.strip():
            print(f"{YELLOW}Usage: /run <cmd>{RESET}")
            return
        if self.guard_enabled and self.guard is not None:
            event = self.guard.check_tool_call(
                agent_id=f"local-{self.agent_name}",
                user_id=os.getenv("USER") or "local-user",
                tool_name="run_bash",
                tool_input={"command": command},
            )
            if event.action_taken == ActionType.BLOCK:
                self.audit(
                    "shell_blocked",
                    "blocked",
                    command,
                    {"reason": event.description},
                )
                print(f"{RED}blocked by atris-guard: {event.description}{RESET}")
                return
        proc = await asyncio.create_subprocess_shell(
            command,
            cwd=str(self.cwd),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        if stdout:
            sys.stdout.write(stdout.decode(errors="replace"))
            if not stdout.endswith(b"\n"):
                sys.stdout.write("\n")
        if stderr:
            sys.stderr.write(stderr.decode(errors="replace"))
            if not stderr.endswith(b"\n"):
                sys.stderr.write("\n")
        self.audit(
            "shell_executed",
            "ok" if proc.returncode in (0, None) else "error",
            command,
            {"exit_code": proc.returncode},
        )
        if proc.returncode not in (0, None):
            print(f"{DIM}exit {proc.returncode}{RESET}")

    async def ask(self, prompt: str, retry_on_overflow: bool = True) -> None:
        if not prompt.strip():
            return
        if self.guard_enabled and self.guard is not None:
            event = self.guard.check_tool_call(
                agent_id=f"local-{self.agent_name}",
                user_id=os.getenv("USER") or "local-user",
                tool_name="chat",
                tool_input={"message": prompt},
            )
            if event.action_taken == ActionType.BLOCK:
                self.audit(
                    "prompt_blocked",
                    "blocked",
                    prompt,
                    {"reason": event.description},
                )
                print(f"{RED}blocked by atris-guard: {event.description}{RESET}")
                return

        reset_reason = self.maybe_autoreset()
        if reset_reason:
            print(f"  {YELLOW}Auto-reset: {reset_reason}{RESET}")

        await self.start()
        if self.client is None:
            print(f"{RED}SDK client not available{RESET}")
            return

        sdk = ensure_sdk_runtime()
        usage: Dict[str, Any] = {}
        session_id = self.chat.session_id
        cost_usd = 0.0
        printed_text = False
        saw_stream_text = False
        overflow_error_text = ""
        recoverable_stream_error = ""

        await self.spinner.start("Thinking")
        try:
            await self.client.query(prompt=prompt, session_id=self.chat.session_id)
            try:
                async for message in self.client.receive_response():
                    if isinstance(message, sdk["StreamEvent"]):
                        ev = message.event if isinstance(message.event, dict) else {}
                        tool_name = _extract_stream_tool_name(ev)
                        if tool_name:
                            self.spinner.set_label(f"Using {tool_name}")
                        delta = _extract_stream_text(ev)
                        if delta:
                            if not printed_text:
                                print()
                                printed_text = True
                            print(delta, end="", flush=True)
                            saw_stream_text = True
                            self.spinner.set_label("Responding")
                        continue

                    if isinstance(message, sdk["AssistantMessage"]):
                        for block in message.content:
                            if isinstance(block, sdk["ToolUseBlock"]):
                                print(f"\n  {DIM}[{block.name}] {tool_summary(getattr(block, 'input', {}))}{RESET}")
                                self.spinner.set_label(f"Using {block.name}")
                            elif isinstance(block, sdk["TextBlock"]) and not saw_stream_text:
                                text = block.text or ""
                                if text:
                                    if not printed_text:
                                        print()
                                        printed_text = True
                                    print(text, end="", flush=True)
                        continue

                    if isinstance(message, sdk["SystemMessage"]):
                        continue

                    if isinstance(message, sdk["ResultMessage"]):
                        session_id = getattr(message, "session_id", session_id) or session_id
                        usage = getattr(message, "usage", {}) or {}
                        cost_usd = float(getattr(message, "total_cost_usd", 0.0) or 0.0)
                        if getattr(message, "is_error", False):
                            result_text = getattr(message, "result", None)
                            if result_text:
                                print(f"\n{RED}{result_text}{RESET}")
                                lowered = str(result_text).lower()
                                if "prompt is too long" in lowered or "context window" in lowered:
                                    overflow_error_text = str(result_text)
                        break
            except Exception as exc:
                message = str(exc)
                if "Unknown message type:" in message:
                    recoverable_stream_error = message
                else:
                    raise
        finally:
            await self.spinner.stop()

        if printed_text:
            print()

        if recoverable_stream_error:
            print(f"  {DIM}Ignored SDK event: {recoverable_stream_error}{RESET}")

        if overflow_error_text and retry_on_overflow:
            self.reset()
            print(f"  {YELLOW}Reset context due overflow. Retrying once...{RESET}")
            await self.ask(prompt, retry_on_overflow=False)
            return

        u = usage_breakdown(usage)
        self.total_cost += cost_usd
        self.chat.session_id = session_id
        self.chat.turns += 1
        self.chat.last_total_input_tokens = u["total_input_tokens"]
        set_saved_session(
            self.agent_name,
            self.model,
            self.cwd,
            self.chat.session_id if self.resume_last else None,
            self.chat.last_total_input_tokens,
        )
        self.audit(
            "prompt_completed",
            "ok",
            prompt,
            {
                "cost_usd": round(cost_usd, 6),
                "prompt_input_tokens": u["prompt_input_tokens"],
                "cache_creation_tokens": u["cache_creation_tokens"],
                "cache_read_tokens": u["cache_read_tokens"],
                "output_tokens": u["output_tokens"],
                "ignored_sdk_event": recoverable_stream_error or "",
            },
        )
        print(
            f"  ${cost_usd:.4f} | prompt {u['prompt_input_tokens']:,} in | "
            f"cache {u['cache_creation_tokens']:,} write / {u['cache_read_tokens']:,} read | "
            f"out {u['output_tokens']:,} | {self.chat.turns} turns"
        )


def print_header(term: AtrisTerminal) -> None:
    print(f"{BOLD}ATRIS{RESET} {CYAN}[COMPUTER]{RESET} agent={term.agent_name} model={term.model}")
    print(f"Root: {term.cwd}")
    print(f"Guard: {'ON' if term.guard_enabled else 'OFF'}")
    print("SDK: warming in background; /run is instant")
    print("Commands: /help /agents /agent <name> /model <name> /run <cmd> /audit [n] /reset /exit")


def parse_int_or_off(token: str) -> int:
    if token.lower() in {"off", "none", "0"}:
        return 0
    return max(0, int(token))


async def handle_command(term: AtrisTerminal, raw: str) -> bool:
    parts = raw.strip().split()
    cmd = parts[0].lower()

    if cmd in {"/exit", "/quit"}:
        return False
    if cmd == "/help":
        print_header(term)
        return True
    if cmd == "/agents":
        print("  " + ", ".join(list_agents()))
        return True
    if cmd == "/agent":
        if len(parts) < 2:
            print(f"{YELLOW}Usage: /agent <name>{RESET}")
            return True
        print(await term.switch_agent(parts[1]))
        return True
    if cmd == "/model":
        if len(parts) < 2:
            print(f"  current: {term.model}")
            print(f"  known: {', '.join(KNOWN_MODELS)}")
            return True
        print(await term.switch_model(parts[1]))
        return True
    if cmd == "/run":
        await term.run_shell(raw.strip()[len("/run"):].strip())
        return True
    if cmd == "/audit":
        limit = 10
        if len(parts) >= 2:
            try:
                limit = max(1, min(50, int(parts[1])))
            except ValueError:
                print(f"{RED}Invalid audit count{RESET}")
                return True
        term.print_audit(limit)
        return True
    if cmd == "/reset":
        term.reset()
        print(f"{GREEN}Reset active chat{RESET}")
        return True
    if cmd == "/autoreset":
        if len(parts) < 2:
            print(f"  current autoreset: {term.autoreset_queries or 'off'}")
            return True
        try:
            term.autoreset_queries = parse_int_or_off(parts[1])
            print(f"{GREEN}autoreset = {term.autoreset_queries or 'off'}{RESET}")
        except ValueError:
            print(f"{RED}Invalid value for /autoreset{RESET}")
        return True
    if cmd == "/autotokens":
        if len(parts) < 2:
            print(f"  current autotokens: {term.autotokens_limit or 'off'}")
            return True
        try:
            term.autotokens_limit = parse_int_or_off(parts[1])
            print(f"{GREEN}autotokens = {term.autotokens_limit or 'off'}{RESET}")
        except ValueError:
            print(f"{RED}Invalid value for /autotokens{RESET}")
        return True
    if cmd == "/resume":
        if len(parts) < 2:
            print(f"  resume-last: {'on' if term.resume_last else 'off'}")
            return True
        term.resume_last = parts[1].lower() in {"1", "on", "true", "yes"}
        if not term.resume_last:
            set_saved_session(term.agent_name, term.model, term.cwd, None, 0)
        print(f"{GREEN}resume-last = {'on' if term.resume_last else 'off'}{RESET}")
        return True

    print(f"{YELLOW}Unknown command: {cmd}{RESET}")
    return True


async def run_repl(args: argparse.Namespace) -> int:
    cwd = Path(args.cwd or os.getcwd()).resolve()
    maybe_load_dotenv(cwd)
    term = AtrisTerminal(
        cwd=cwd,
        agent_name=args.agent,
        model=args.model,
        max_turns=args.max_turns,
        max_budget_usd=args.max_budget_usd,
        autoreset_queries=args.autoreset,
        autotokens_limit=args.autotokens,
        resume_last=args.resume_last,
    )

    print_header(term)

    try:
        if args.prompt:
            await term.ask(args.prompt)
            return 0

        term.warm_start()
        while True:
            try:
                raw = (await asyncio.to_thread(input, "\ncomputer> ")).strip()
            except (EOFError, KeyboardInterrupt):
                print()
                break
            if not raw:
                continue
            if raw.startswith("/"):
                keep = await handle_command(term, raw)
                if not keep:
                    break
                continue
            await term.ask(raw)
    finally:
        await term.close()
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Persistent Atris Claude SDK terminal")
    parser.add_argument("-p", "--prompt", help="One-shot prompt (non-interactive)")
    parser.add_argument("--cwd", default=os.getcwd(), help="Workspace root")
    parser.add_argument("--agent", default="navigator", help="Agent persona from atris/team")
    parser.add_argument(
        "--model",
        default=os.getenv("ATRIS_CLAUDE_MODEL", "claude-sonnet-4-6"),
        help="Claude model ID",
    )
    parser.add_argument("--max-turns", type=int, default=None, help="SDK max_turns guard")
    parser.add_argument("--max-budget-usd", type=float, default=5.0, help="Per-query budget cap")
    parser.add_argument("--autoreset", type=int, default=10, help="Auto reset after N turns (0 disables)")
    parser.add_argument(
        "--autotokens",
        type=int,
        default=80000,
        help="Auto reset when total input tokens exceed N (0 disables)",
    )
    parser.add_argument("--resume-last", action="store_true", help="Resume last saved session")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        return asyncio.run(run_repl(args))
    except KeyboardInterrupt:
        return 130
    except RuntimeError as exc:
        print(f"{RED}{exc}{RESET}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
