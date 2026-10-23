#!/usr/bin/env bash
# One eval run for cmp-four-lines-real: a fresh atris project, the fixture
# copied in, one headless engine run, saved where judge.sh reads it.
#
#   scripts/four-lines-eval.sh <engine> <treatment|control> <n>
#
# treatment keeps the four opening lines; control strips them from every file.
# Output: atris/campaigns/cmp-four-lines-real/evals/runs/<engine>/<arm>-<n>/
#   workdir/ (no .git, no node_modules), transcript.log, meta.json
# Env: FOUR_LINES_MODEL picks a model (codex defaults to gpt-6.1-sol),
# FOUR_LINES_TIMEOUT caps seconds (900).
set -euo pipefail

ENGINE="${1:-}"; ARM="${2:-}"; N="${3:-}"
usage() { echo "usage: $0 <claude|codex> <treatment|control> <n>" >&2; exit 2; }
[ -n "$ENGINE" ] && [ -n "$N" ] || usage
case "$ARM" in treatment|control) ;; *) usage ;; esac

REPO="$(cd "$(dirname "$0")/.." && pwd)"
CAMP="$REPO/atris/campaigns/cmp-four-lines-real"
OUT="$CAMP/evals/runs/$ENGINE/$ARM-$N"
CAP="${FOUR_LINES_TIMEOUT:-900}"
LINE_RE='^- \*\*(Acceleration|Accuracy|Ambition|Agency)\.\*\* '

case "$ENGINE" in
  claude) command -v claude >/dev/null || { echo "claude is not installed" >&2; exit 3; } ;;
  codex)
    command -v codex >/dev/null || { echo "codex is not installed" >&2; exit 3; }
    [ -f "$HOME/.codex/auth.json" ] || { echo "codex is not logged in (no ~/.codex/auth.json)" >&2; exit 3; }
    ;;
  *) echo "engine '$ENGINE' is not wired yet (claude and codex so far)" >&2; exit 3 ;;
esac

ROOT="$(mktemp -d)"; trap 'rm -rf "$ROOT"' EXIT
W="$ROOT/project"; SHIM="$ROOT/bin"; mkdir -p "$W" "$SHIM"

# The project's own hooks call `atris`; make that this repo's code, not the
# copy installed on this machine.
printf '#!/bin/sh\nexec node "%s/bin/atris.js" "$@"\n' "$REPO" > "$SHIM/atris"
chmod +x "$SHIM/atris"

cd "$W"
git init -q
node "$REPO/bin/atris.js" init --yes --no-commit >/dev/null

if [ "$ARM" = control ]; then
  grep -rlE "$LINE_RE" . --exclude-dir=.git | while read -r f; do
    perl -i -ne "print unless /$LINE_RE/" "$f"
  done
  if grep -rqE "$LINE_RE" . --exclude-dir=.git; then echo "control strip left lines behind" >&2; exit 4; fi
else
  for w in Acceleration Accuracy Ambition Agency; do
    grep -q "\*\*$w\.\*\*" atris/atris.md || { echo "treatment is missing the $w line" >&2; exit 4; }
  done
fi

cp -R "$CAMP/fixture/." "$W/"
git add -A
git -c user.name=four-lines-eval -c user.email=eval@localhost commit -qm "fresh project with fixture" --no-gpg-sign
PROMPT="$(cat "$CAMP/fixture/TASK.md")"

rm -rf "$OUT"; mkdir -p "$OUT"
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; T0=$(date +%s)
set +e
case "$ENGINE" in
  claude)
    # Subscription login only: no API key. User-level settings, CLAUDE.md,
    # skills, plugins, and hooks stay out because only project and local
    # setting sources load. The sandbox confines shell writes to the project;
    # acceptEdits only auto-approves file edits inside it.
    PATH="$SHIM:$PATH" npm_config_cache="$ROOT/npm-cache" \
    env -u ANTHROPIC_API_KEY -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT \
      perl -e 'alarm shift; exec @ARGV' "$CAP" \
      claude -p "$PROMPT" ${FOUR_LINES_MODEL:+--model "$FOUR_LINES_MODEL"} \
        --setting-sources project,local \
        --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
        --no-session-persistence \
        --permission-mode acceptEdits \
        --settings '{"sandbox":{"enabled":true,"autoAllowBashIfSandboxed":true,"allowUnsandboxedCommands":false}}' \
        --output-format stream-json --verbose \
        > "$OUT/transcript.log" 2>&1 < /dev/null
    CODE=$?
    ;;
  codex)
    # A temp CODEX_HOME holding only the login: no user config.toml, AGENTS.md,
    # instructions, memories, skills, rules, or MCP servers load. HOME is a
    # temp dir too, because codex also reads skills from ~/.agents. The sandbox
    # lets shell commands write only inside the project. If the login token
    # refreshes mid run, copy it back so the real login keeps working.
    CH="$ROOT/codex-home"; mkdir -p "$CH" "$ROOT/home"
    cp "$HOME/.codex/auth.json" "$CH/auth.json"; chmod 600 "$CH/auth.json"
    PATH="$SHIM:$PATH" npm_config_cache="$ROOT/npm-cache" CODEX_HOME="$CH" HOME="$ROOT/home" \
    env -u OPENAI_API_KEY -u CODEX_SANDBOX -u CODEX_SANDBOX_NETWORK_DISABLED -u CODEX_THREAD_ID \
      perl -e 'alarm shift; exec @ARGV' "$CAP" \
      codex exec --model "${FOUR_LINES_MODEL:-gpt-6.1-sol}" \
        --cd "$W" --sandbox workspace-write -c approval_policy='"never"' \
        --ignore-user-config --ignore-rules --ephemeral --json --color never \
        "$PROMPT" > "$OUT/transcript.log" 2>&1 < /dev/null
    CODE=$?
    node -e 'const f=require("fs"),[a,b]=process.argv.slice(1),r=p=>{try{return JSON.parse(f.readFileSync(p,"utf8")).last_refresh||""}catch{return ""}};
      if (r(a) > r(b)) { f.copyFileSync(a, b); console.error("codex login refreshed during the run; saved it back"); }' \
      "$CH/auth.json" "$HOME/.codex/auth.json" || true
    ;;
esac
set -e
ENDED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; SECS=$(( $(date +%s) - T0 ))

rsync -a --exclude .git --exclude node_modules "$W/" "$OUT/workdir/"

OUT="$OUT" ENGINE="$ENGINE" ARM="$ARM" N="$N" CODE="$CODE" SECS="$SECS" CAP="$CAP" \
STARTED="$STARTED" ENDED="$ENDED" REPO="$REPO" PROMPT="$PROMPT" node -e '
const fs = require("fs"), crypto = require("crypto"), cp = require("child_process");
const e = process.env, out = e.OUT;
const sha = crypto.createHash("sha256").update(fs.readFileSync(out + "/workdir/atris/atris.md")).digest("hex");
let model = e.FOUR_LINES_MODEL || (e.ENGINE === "codex" ? "gpt-6.1-sol" : null);
for (const line of fs.readFileSync(out + "/transcript.log", "utf8").split("\n")) {
  try { const j = JSON.parse(line); if (j.type === "system" && j.subtype === "init") { model = j.model; break; } } catch {}
}
const git = (a) => { try { return cp.execFileSync("git", a, { cwd: e.REPO, encoding: "utf8" }).trim(); } catch { return null; } };
let version = null; try { version = cp.execFileSync(e.ENGINE, ["--version"], { encoding: "utf8" }).trim(); } catch {}
const meta = {
  engine: e.ENGINE, engine_version: version, model, arm: e.ARM, n: Number(e.N),
  atris_md_sha256: sha,
  isolation: e.ENGINE === "codex" ? {
    workdir: "fresh mktemp dir, git init, atris init --yes from this repo, fixture copied in and committed",
    instructions: "CODEX_HOME is a new temp dir holding only auth.json, plus --ignore-user-config and --ignore-rules: no user config.toml, AGENTS.md, instructions, memories, MCP servers, or exec rules load; only the fresh project AGENTS.md does",
    skills: "HOME is a temp dir so ~/.agents/skills does not load; only the four skills codex ships with remain",
    memory: "--ephemeral and a new CODEX_HOME, so no past sessions or memories exist",
    auth: "OPENAI_API_KEY unset; the copied ChatGPT login is used, and saved back only if it refreshed mid run",
    writes: "--sandbox workspace-write with approval_policy never; shell writes outside the project fail",
    stdin: "/dev/null, so codex never waits on input",
    atris_binary: "project hooks resolve atris to this repo via a PATH shim",
    probe: "2026-10-23: probe run named only the project AGENTS.md and the four built-in codex skills; touch in the real home failed with Operation not permitted, touch ./ worked. Without the temp HOME it also listed ~/.agents/skills, which is why HOME is replaced",
  } : {
    workdir: "fresh mktemp dir, git init, atris init --yes from this repo, fixture copied in and committed",
    instructions: "--setting-sources project,local: user CLAUDE.md, user settings, user hooks, user skills, and plugins do not load; only the fresh project files do",
    mcp: "--strict-mcp-config with an empty server list",
    memory: "--no-session-persistence; the temp path is new, so its auto-memory folder starts empty",
    auth: "ANTHROPIC_API_KEY unset, so the run uses the subscription login",
    writes: "sandbox on with unsandboxed commands refused; shell writes outside the project fail, and file edits outside it are not auto-approved",
    atris_binary: "project hooks resolve atris to this repo via a PATH shim",
    probe: "2026-10-23: probe run named only the project CLAUDE.md as loaded and no user-level rules; touch $HOME and Write to $HOME both failed, touch ./ worked",
  },
  prompt: e.PROMPT, timeout_seconds: Number(e.CAP), timed_out: Number(e.SECS) >= Number(e.CAP),
  started_at: e.STARTED, ended_at: e.ENDED, duration_seconds: Number(e.SECS), exit_code: Number(e.CODE),
  repo_commit: git(["rev-parse", "HEAD"]), repo_dirty: Boolean(git(["status", "--porcelain"])),
};
fs.writeFileSync(out + "/meta.json", JSON.stringify(meta, null, 2) + "\n");
'
echo "$ENGINE $ARM-$N: exit $CODE in ${SECS}s -> ${OUT#$REPO/}"
