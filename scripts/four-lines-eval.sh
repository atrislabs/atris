#!/usr/bin/env bash
# One eval run for cmp-four-lines-real: a fresh atris project, the fixture
# copied in, one headless engine run, saved where judge.sh reads it.
#
#   scripts/four-lines-eval.sh <engine> <treatment|control> <n>
#
# treatment keeps the four opening lines; control strips them from every file.
# Output: atris/campaigns/cmp-four-lines-real/evals/runs/<engine>/<arm>-<n>/
#   workdir/ (no .git, no node_modules), transcript.log, meta.json
# Env: FOUR_LINES_MODEL picks a model (codex defaults to gpt-6.1-sol, agy to
# gemini-4-argon-high, grok to grok-4.7-build-fast),
# FOUR_LINES_TIMEOUT caps seconds (900). FOUR_LINES_PROMPT replaces the task
# and FOUR_LINES_OUT the output folder, so an isolation probe runs the exact
# engine command a real eval does.
#
# Every engine is barred from reading the real HOME by its own sandbox, so an
# agent cannot open the owner's files by absolute path. Logins are copied into
# the temp dir first (claude reads its own from the keychain, outside the
# sandbox), so nothing under HOME is re-opened.
set -euo pipefail

ENGINE="${1:-}"; ARM="${2:-}"; N="${3:-}"
usage() { echo "usage: $0 <claude|codex|agy|grok> <treatment|control> <n>" >&2; exit 2; }
[ -n "$ENGINE" ] && [ -n "$N" ] || usage
case "$ARM" in treatment|control) ;; *) usage ;; esac

REPO="$(cd "$(dirname "$0")/.." && pwd)"
CAMP="$REPO/atris/campaigns/cmp-four-lines-real"
OUT="${FOUR_LINES_OUT:-$CAMP/evals/runs/$ENGINE/$ARM-$N}"
CAP="${FOUR_LINES_TIMEOUT:-900}"
LINE_RE='^- \*\*(Acceleration|Accuracy|Ambition|Agency)\.\*\* '

case "$ENGINE" in
  claude) command -v claude >/dev/null || { echo "claude is not installed" >&2; exit 3; } ;;
  codex)
    command -v codex >/dev/null || { echo "codex is not installed" >&2; exit 3; }
    [ -f "$HOME/.codex/auth.json" ] || { echo "codex is not logged in (no ~/.codex/auth.json)" >&2; exit 3; }
    ;;
  agy)
    command -v agy >/dev/null || { echo "agy is not installed" >&2; exit 3; }
    [ -f "$HOME/.gemini/antigravity-cli/antigravity-oauth-token" ] || { echo "agy is not logged in (no antigravity-oauth-token)" >&2; exit 3; }
    ;;
  grok)
    command -v grok >/dev/null || { echo "grok is not installed" >&2; exit 3; }
    [ -f "$HOME/.grok/auth.json" ] || { echo "grok is not logged in (no ~/.grok/auth.json)" >&2; exit 3; }
    ;;
  *) echo "engine '$ENGINE' is not wired yet (claude, codex, agy, and grok so far)" >&2; exit 3 ;;
esac

ROOT="$(mktemp -d)"; trap 'rm -rf "$ROOT"' EXIT

# A temp HOME has no keychain, and macOS answers any app that tries to save a
# secret there with a "Keychain Not Found" dialog on the owner's screen. Each
# temp home gets its own empty, never-locking keychain: no dialog, and the
# owner's login keychain stays out of reach.
scratch_keychain() {
  [ "$(uname)" = Darwin ] || return 0
  local kc="$1/Library/Keychains/login.keychain-db"
  mkdir -p "$1/Library/Keychains"
  HOME="$1" security create-keychain -p "" "$kc" >/dev/null 2>&1 || true
  HOME="$1" security set-keychain-settings "$kc" >/dev/null 2>&1 || true
}
W="$ROOT/project"; SHIM="$ROOT/bin"; mkdir -p "$W" "$SHIM"

# The project's own hooks call `atris`; make that this repo's code, not the
# copy installed on this machine. It is packed into the temp dir because the
# repo sits under HOME, which the agent cannot read.
(cd "$REPO" && npm pack --ignore-scripts --silent --pack-destination "$ROOT" >/dev/null)
tar -xzf "$ROOT"/atris-*.tgz -C "$ROOT" && mv "$ROOT/package" "$ROOT/atris-cli" && rm "$ROOT"/atris-*.tgz
printf '#!/bin/sh\nexec node "%s/bin/atris.js" "$@"\n' "$ROOT/atris-cli" > "$SHIM/atris"
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
PROMPT="${FOUR_LINES_PROMPT:-$(cat "$CAMP/fixture/TASK.md")}"

rm -rf "$OUT"; mkdir -p "$OUT"
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; T0=$(date +%s)
set +e
case "$ENGINE" in
  claude)
    # Subscription login only: no API key. User-level settings, CLAUDE.md,
    # skills, plugins, and hooks stay out because only project and local
    # setting sources load. The sandbox confines shell writes to the project;
    # acceptEdits only auto-approves file edits inside it. HOME is read-denied
    # twice: denyRead for shell commands, a Read deny rule for the file tools.
    # git and npm get empty config files, since ~/.gitconfig is now unreadable
    # and git stops on it; XDG_CONFIG_HOME moves git's ignore file lookup too.
    : > "$ROOT/gitconfig"; : > "$ROOT/npmrc"; mkdir -p "$ROOT/xdg"
    PATH="$SHIM:$PATH" npm_config_cache="$ROOT/npm-cache" \
    GIT_CONFIG_GLOBAL="$ROOT/gitconfig" NPM_CONFIG_USERCONFIG="$ROOT/npmrc" XDG_CONFIG_HOME="$ROOT/xdg" \
    env -u ANTHROPIC_API_KEY -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT \
      perl -e 'alarm shift; exec @ARGV' "$CAP" \
      claude -p "$PROMPT" ${FOUR_LINES_MODEL:+--model "$FOUR_LINES_MODEL"} \
        --setting-sources project,local \
        --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
        --no-session-persistence \
        --permission-mode acceptEdits \
        --settings '{"sandbox":{"enabled":true,"autoAllowBashIfSandboxed":true,"allowUnsandboxedCommands":false,"filesystem":{"denyRead":["'"$HOME"'"]}},"permissions":{"deny":["Read(/'"$HOME"'/**)"]}}' \
        --output-format stream-json --verbose \
        > "$OUT/transcript.log" 2>&1 < /dev/null
    CODE=$?
    ;;
  codex)
    # A temp CODEX_HOME holding only the login: no user config.toml, AGENTS.md,
    # instructions, memories, skills, rules, or MCP servers load. HOME is a
    # temp dir too, because codex also reads skills from ~/.agents. The
    # permission profile matches workspace-write (writes in the project and the
    # temp dirs, no network) and adds a read deny on the real HOME. If the login token
    # refreshes mid run, copy it back so the real login keeps working.
    CH="$ROOT/codex-home"; mkdir -p "$CH" "$ROOT/home"; scratch_keychain "$ROOT/home"
    cp "$HOME/.codex/auth.json" "$CH/auth.json"; chmod 600 "$CH/auth.json"
    PATH="$SHIM:$PATH" npm_config_cache="$ROOT/npm-cache" CODEX_HOME="$CH" HOME="$ROOT/home" \
    env -u OPENAI_API_KEY -u CODEX_SANDBOX -u CODEX_SANDBOX_NETWORK_DISABLED -u CODEX_THREAD_ID \
      perl -e 'alarm shift; exec @ARGV' "$CAP" \
      codex exec --model "${FOUR_LINES_MODEL:-gpt-6.1-sol}" \
        --cd "$W" -c approval_policy='"never"' -c default_permissions='"four-lines"' \
        -c 'permissions.four-lines.filesystem={":root"="read",":project_roots"="write",":tmpdir"="write",":slash_tmp"="write","'"$HOME"'"="deny"}' \
        --ignore-user-config --ignore-rules --ephemeral --json --color never \
        "$PROMPT" > "$OUT/transcript.log" 2>&1 < /dev/null
    CODE=$?
    node -e 'const f=require("fs"),[a,b]=process.argv.slice(1),r=p=>{try{return JSON.parse(f.readFileSync(p,"utf8")).last_refresh||""}catch{return ""}};
      if (r(a) > r(b)) { f.copyFileSync(a, b); console.error("codex login refreshed during the run; saved it back"); }' \
      "$CH/auth.json" "$HOME/.codex/auth.json" || true
    ;;
  agy)
    # HOME is a temp dir holding only the login token: no user GEMINI.md,
    # settings, skills, MCP servers, or past conversations load. --add-dir is
    # the real project path, or agy edits its own scratch folder instead.
    # --sandbox keeps shell writes out of everything but /tmp; file edits
    # still land in the project. The headless line stops the ask-first habit.
    # The temp settings.json denies read_file on the real HOME, turns off file
    # access outside the workspace, and sets proceed-in-sandbox: commands in
    # the sandbox run unasked, and one that tries to leave it is refused.
    # --dangerously-skip-permissions is gone because it approved those exits,
    # and an unsandboxed cat read the owner's files.
    AH="$ROOT/agy-home/.gemini/antigravity-cli"; mkdir -p "$AH"; scratch_keychain "$ROOT/agy-home"
    cp "$HOME/.gemini/antigravity-cli/antigravity-oauth-token" "$AH/"; chmod 600 "$AH/antigravity-oauth-token"
    printf '{"toolPermission":"proceed-in-sandbox","allowNonWorkspaceAccess":false,"permissions":{"deny":["read_file(%s)"]}}\n' "$HOME" > "$AH/settings.json"
    PATH="$SHIM:$PATH" npm_config_cache="$ROOT/npm-cache" HOME="$ROOT/agy-home" \
    env -u GEMINI_API_KEY -u GOOGLE_API_KEY \
      perl -e 'alarm shift; exec @ARGV' "$CAP" \
      agy -p "You are running headless with edit permission already granted. Apply changes directly and never ask for confirmation.

$PROMPT" --model "${FOUR_LINES_MODEL:-gemini-4-argon-high}" \
        --add-dir "$(pwd -P)" --mode accept-edits --sandbox \
        --output-format stream-json > "$OUT/transcript.log" 2>&1 < /dev/null
    CODE=$?
    ;;
  grok)
    # A temp GROK_HOME holding only the login, and a temp HOME: no user
    # config, rules, memory, skills, plugins, MCP servers, or hooks load,
    # including the ~/.claude ones grok reads for compat. Grok only reads a
    # folder's AGENTS.md and CLAUDE.md once the folder is trusted, so the temp
    # home trusts exactly this workdir. The sandbox profile is grok's
    # workspace one with /tmp and the real HOME denied (deny blocks reads too):
    # writes land in the project, the temp grok home, and the per-user system
    # temp dir grok itself needs to start.
    GH="$ROOT/grok-home"; mkdir -p "$GH" "$ROOT/home" "$ROOT/tmp"; scratch_keychain "$ROOT/home"
    cp "$HOME/.grok/auth.json" "$GH/auth.json"; chmod 600 "$GH/auth.json"
    printf '[folders."%s"]\ntrusted = true\ndecided_at = %s\n' "$(pwd -P)" "$(date +%s)" > "$GH/trusted_folders.toml"
    printf '[profiles.four-lines]\nextends = "workspace"\ndeny = ["/tmp", "/private/tmp", "%s"]\n' "$HOME" > "$GH/sandbox.toml"
    PATH="$SHIM:$PATH" npm_config_cache="$ROOT/npm-cache" GROK_HOME="$GH" HOME="$ROOT/home" TMPDIR="$ROOT/tmp" \
    env -u XAI_API_KEY -u GROK_SANDBOX -u GROK_AGENT \
      perl -e 'alarm shift; exec @ARGV' "$CAP" \
      grok -p "$PROMPT" --model "${FOUR_LINES_MODEL:-grok-4.7-build-fast}" \
        --sandbox four-lines --always-approve --no-memory \
        --output-format streaming-json > "$OUT/transcript.log" 2>&1 < /dev/null
    CODE=$?
    # A refresh rotates the token, so save a newer login back to the real home.
    node -e 'const f=require("fs"),[a,b]=process.argv.slice(1),r=p=>{try{return Object.values(JSON.parse(f.readFileSync(p,"utf8")))[0].expires_at||""}catch{return ""}};
      if (r(a) > r(b)) { f.copyFileSync(a, b); console.error("grok login refreshed during the run; saved it back"); }' \
      "$GH/auth.json" "$HOME/.grok/auth.json" || true
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
let model = e.FOUR_LINES_MODEL || ({ codex: "gpt-6.1-sol", agy: "gemini-4-argon-high", grok: "grok-4.7-build-fast" }[e.ENGINE] || null);
for (const line of fs.readFileSync(out + "/transcript.log", "utf8").split("\n")) {
  try { const j = JSON.parse(line); if (j.type === "system" && j.subtype === "init") { model = j.model; break; } } catch {}
}
const git = (a) => { try { return cp.execFileSync("git", a, { cwd: e.REPO, encoding: "utf8" }).trim(); } catch { return null; } };
let version = null; try { version = cp.execFileSync(e.ENGINE, ["--version"], { encoding: "utf8" }).trim(); } catch {}
// the exact isolation this run used: judge.sh refuses runs made with an older copy of this script
const harness = crypto.createHash("sha256").update(fs.readFileSync(e.REPO + "/scripts/four-lines-eval.sh")).digest("hex");
const meta = {
  engine: e.ENGINE, engine_version: version, model, arm: e.ARM, n: Number(e.N),
  atris_md_sha256: sha,
  harness_sha256: harness,
  isolation: e.ENGINE === "grok" ? {
    workdir: "fresh mktemp dir, git init, atris init --yes from this repo, fixture copied in and committed",
    instructions: "GROK_HOME is a new temp dir holding only auth.json, a trust entry for this workdir alone, and the sandbox profile; HOME is a temp dir too. No user config.toml, global rules, ~/.claude CLAUDE.md, skills, plugins, MCP servers, or hooks load; the project AGENTS.md and CLAUDE.md do, because the workdir is trusted",
    memory: "--no-memory and a new GROK_HOME, so no past sessions or memories exist",
    auth: "XAI_API_KEY unset; the copied grok login is used, and saved back only if it refreshed mid run",
    writes: "--always-approve inside a custom sandbox profile: grok workspace with /tmp and the real HOME denied. Writes land in the workdir, the temp grok home, and the per-user system temp dir; home and /tmp fail. Denying the system temp dir stops grok from starting",
    stdin: "/dev/null, so grok never waits on input",
    atris_binary: "project hooks and the agent resolve atris to an npm pack copy of this repo in the temp dir, via a PATH shim; the repo itself sits under the read-denied HOME",
    keychain: "a new empty keychain inside the temp HOME, so the agent cannot reach the owner login keychain and macOS shows no Keychain Not Found dialog. The login comes from the copied token file",
    probe: "2026-10-23: grok inspect with the temp homes listed 0 user skills, plugins, MCP servers, and hooks (the real home gives 141 skills and the user CLAUDE.md). Without the trust entry no project rules load at all; with it, a probe run named only the project Agents.md and Claude.md and quoted the Acceleration line verbatim. touch in the real home and /tmp failed with Operation not permitted, touch ./ worked",
    home_reads: "the real HOME is on the sandbox profile deny list, which grok enforces in the kernel for reads as well as writes, read_file included. Nothing under HOME is re-opened: the login is a copy in the temp GROK_HOME",
    home_reads_probe: "2026-10-23: told to read a canary file in the real HOME, read_file returned Permission denied and cat returned Operation not permitted; the canary contents never appeared in the transcript",
  } : e.ENGINE === "agy" ? {
    workdir: "fresh mktemp dir, git init, atris init --yes from this repo, fixture copied in and committed",
    instructions: "HOME is a new temp dir holding only the agy login token: no user GEMINI.md, settings.json, skills, MCP servers, knowledge, or past conversations load; only the fresh project AGENTS.md does",
    skills: "only the two skills agy ships with (agy-customizations, antigravity-guide) remain",
    edits: "--add-dir is the resolved project path, so edits land in the project and not in agy scratch",
    auth: "GEMINI_API_KEY and GOOGLE_API_KEY unset; a copy of the login token is used and the real one is never written",
    writes: "--sandbox: shell writes fail everywhere except /tmp, including the project; file edits through the edit tool land in the project. Stricter than claude and codex, whose shells can write inside the project",
    prompt_prefix: "one line asking it to apply edits without asking first, since agy otherwise stops to ask and exits without editing",
    stdin: "/dev/null, so agy never waits on input",
    atris_binary: "project hooks and the agent resolve atris to an npm pack copy of this repo in the temp dir, via a PATH shim; the repo itself sits under the read-denied HOME",
    keychain: "a new empty keychain inside the temp HOME, so the agent cannot reach the owner login keychain and macOS shows no Keychain Not Found dialog. The login comes from the copied token file",
    probe: "2026-10-23: probe run in a temp HOME named only the project rule file and the two built-in skills; with --sandbox, touch in the real home and touch ./ both failed and an edit-tool change inside the project landed. Without --sandbox, touch in the real home succeeded, which is why the sandbox is on",
    permissions: "toolPermission proceed-in-sandbox in the temp settings.json replaces --dangerously-skip-permissions: sandboxed commands run unasked, a command asking to bypass the sandbox is refused because nobody can approve it headless",
    home_reads: "the terminal sandbox denies the real HOME, a read_file deny rule on HOME covers the file tool, and allowNonWorkspaceAccess is false. Nothing under HOME is re-opened: the login is a copy in the temp HOME",
    home_reads_probe: "2026-10-23: read_file on a canary in the real HOME hit the deny rule, cat on it and on a /Users/Shared symlink to it failed with Operation not permitted, and the retry with the sandbox bypassed was refused; the contents never appeared. With the old --dangerously-skip-permissions the bypassed retry printed the canary. echo, ls, and a write_file in the project still worked",
  } : e.ENGINE === "codex" ? {
    workdir: "fresh mktemp dir, git init, atris init --yes from this repo, fixture copied in and committed",
    instructions: "CODEX_HOME is a new temp dir holding only auth.json, plus --ignore-user-config and --ignore-rules: no user config.toml, AGENTS.md, instructions, memories, MCP servers, or exec rules load; only the fresh project AGENTS.md does",
    skills: "HOME is a temp dir so ~/.agents/skills does not load; only the four skills codex ships with remain",
    memory: "--ephemeral and a new CODEX_HOME, so no past sessions or memories exist",
    auth: "OPENAI_API_KEY unset; the copied ChatGPT login is used, and saved back only if it refreshed mid run",
    writes: "a permission profile matching workspace-write, with approval_policy never: shell writes land in the project and the temp dirs, everything else fails, network off",
    stdin: "/dev/null, so codex never waits on input",
    atris_binary: "project hooks and the agent resolve atris to an npm pack copy of this repo in the temp dir, via a PATH shim; the repo itself sits under the read-denied HOME",
    keychain: "a new empty keychain inside the temp HOME, so the agent cannot reach the owner login keychain and macOS shows no Keychain Not Found dialog. The login comes from the copied token file",
    probe: "2026-10-23: probe run named only the project AGENTS.md and the four built-in codex skills; touch in the real home failed with Operation not permitted, touch ./ worked. Without the temp HOME it also listed ~/.agents/skills, which is why HOME is replaced",
    home_reads: "default_permissions names a profile passed with -c: root readable, project and temp dirs writable, the real HOME denied. It replaces --sandbox workspace-write, which let shell commands read anything. Nothing under HOME is re-opened: the login is a copy in the temp CODEX_HOME",
    home_reads_probe: "2026-10-23: told the canary path, codex declined to try because its policy names the HOME deny. Told to cat a /Users/Shared symlink to a canary in the real HOME and to run a node script reading it, both failed with Operation not permitted and the contents never appeared. Under the old workspace-write, cat read the same canary",
  } : {
    workdir: "fresh mktemp dir, git init, atris init --yes from this repo, fixture copied in and committed",
    instructions: "--setting-sources project,local: user CLAUDE.md, user settings, user hooks, user skills, and plugins do not load; only the fresh project files do",
    mcp: "--strict-mcp-config with an empty server list",
    memory: "--no-session-persistence; the temp path is new, so its auto-memory folder starts empty",
    auth: "ANTHROPIC_API_KEY unset, so the run uses the subscription login",
    writes: "sandbox on with unsandboxed commands refused; shell writes outside the project fail, and file edits outside it are not auto-approved",
    atris_binary: "project hooks and the agent resolve atris to an npm pack copy of this repo in the temp dir, via a PATH shim; the repo itself sits under the read-denied HOME",
    keychain: "claude runs under the real HOME and reads its own subscription login from the login keychain, as it always does; isolation is by the flags above, not by a temp HOME. No keychain is linked into any temp dir",
    probe: "2026-10-23: probe run named only the project CLAUDE.md as loaded and no user-level rules; touch $HOME and Write to $HOME both failed, touch ./ worked",
    user_instructions_probe: "2026-10-23: a temp HOME held a copy of the owner ~/.claude/CLAUDE.md with a canary line appended and a canary skill in ~/.claude/skills; the real files were not touched. With user sources allowed, claude answered both canary words and listed the canary skill. This script with that HOME answered UNKNOWN to both and listed no canary skill, so --setting-sources project,local keeps user CLAUDE.md and user skills out",
    home_reads: "sandbox.filesystem.denyRead on the real HOME for shell commands, plus a Read deny rule on it for the Read, Grep, and Glob tools. Nothing under HOME is re-opened, since claude reads its login from the keychain outside the sandbox. git and npm get empty config files in the temp dir so the unreadable ~/.gitconfig does not stop them",
    home_reads_probe: "2026-10-23: told to read a canary file in the real HOME, the Read tool was refused by the permission settings and cat failed with Operation not permitted; the contents never appeared. atris --version, git status, and a write in ./ still worked",
  },
  prompt: e.PROMPT, timeout_seconds: Number(e.CAP), timed_out: Number(e.SECS) >= Number(e.CAP),
  started_at: e.STARTED, ended_at: e.ENDED, duration_seconds: Number(e.SECS), exit_code: Number(e.CODE),
  repo_commit: git(["rev-parse", "HEAD"]), repo_dirty: Boolean(git(["status", "--porcelain"])),
};
fs.writeFileSync(out + "/meta.json", JSON.stringify(meta, null, 2) + "\n");
'
echo "$ENGINE $ARM-$N: exit $CODE in ${SECS}s -> ${OUT#$REPO/}"
