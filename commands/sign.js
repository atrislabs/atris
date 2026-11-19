const fs = require('fs');
const path = require('path');

// atris sign: co-author trailer on every commit in an atris workspace.
// Installs a prepare-commit-msg hook that appends "Co-authored-by: Atris"
// when the repo has an atris/ folder, same credit line Claude and Cursor use.
// Idempotent and non-destructive: appends a marked block, removes only its own block.

const MARKER = '# atris co-author';
const TRAILER = 'Co-authored-by: Atris <299057014+atris-builder[bot]@users.noreply.github.com>';

const LEGACY_HOOK_BLOCK = `
${MARKER}
if [ -d "$(git rev-parse --show-toplevel 2>/dev/null)/atris" ] && [ "$2" != "merge" ] && [ "$2" != "squash" ]; then
  if ! grep -qi "^co-authored-by: atris" "$1"; then
    printf '\\nCo-authored-by: Atris <299057014+atris-builder[bot]@users.noreply.github.com>\\n' >> "$1"
  fi
fi
`;

// A save typed in a terminal with no agent running also gets "Atris-Made-By: person",
// so counts of agent changes can tell a person's hand fix apart (seen 2026-11-17:
// 112 of 112 saves read as agents, the owner's own edits among them).
const AGENT_ENV = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID',
  'CURSOR_AGENT', 'DEVIN_SESSION_ID', 'ATRIS_MISSION_DRIVER_DETACHED', 'ATRIS_MISSION_DRIVER_PARENT_PID',
  'ATRIS_DISPATCH_DEPTH', 'ATRIS_AGENT_PROOF_ONLY'];
const PERSON_TRAILER = 'Atris-Made-By: person';

// A person, not a helper: a terminal is attached, no helper sign is set, and no program that
// started this save is a helper (one ps call, parents walked from git). Helpers the tool starts
// carry no sign of their own (seen 2026-11-17), so the starters are what is trusted. A blind
// look (no process list) says agent, never person.
const HELPER_PROGRAMS = '(claude|codex|cursor-agent|devin|grok|agy|opencode|muse|[\\/]atris( |$)|atris[.]js|bin[\\/]ax( |$))';
const PERSON_BLOCK = [
  '  if [ -n "${TERM_PROGRAM}${SSH_TTY}" ] && [ -z "' + AGENT_ENV.map((v) => '${' + v + '}').join('') + '" ] && ! grep -qi "^atris-made-by:" "$1" \\',
  '    && ${ATRIS_SIGN_PS:-ps -axo pid=,ppid=,args=} 2>/dev/null | awk -v p="$PPID" \'{ id = $1; pp[id] = $2; $1 = ""; $2 = ""; args[id] = tolower($0) } END { if (NR == 0) exit 1; for (i = 0; i < 40 && p > 1; i++) { if (args[p] ~ /' + HELPER_PROGRAMS + '/) exit 1; p = pp[p] } exit 0 }\'; then',
  '    printf \'' + PERSON_TRAILER + '\\n\' >> "$1"',
  '  fi',
  '',
].join('\n');

const HOOK_BLOCK = `
${MARKER}
if [ -d "$(git rev-parse --show-toplevel 2>/dev/null)/atris" ] && [ "$2" != "merge" ] && [ "$2" != "squash" ]; then
  if ! grep -qi "^co-authored-by: atris" "$1"; then
    printf '\\nCo-authored-by: Atris <299057014+atris-builder[bot]@users.noreply.github.com>\\n' >> "$1"
  fi
${PERSON_BLOCK}fi
`;

function hookPathFor(root) {
  return path.join(root, '.git', 'hooks', 'prepare-commit-msg');
}

// Install the marked block into .git/hooks/prepare-commit-msg. Returns { hookPath, already }.
function installSignHook(root = process.cwd()) {
  if (!fs.existsSync(path.join(root, '.git'))) throw new Error('not a git repo (no .git here)');
  const hookPath = hookPathFor(root);
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  let content = '';
  try { content = fs.readFileSync(hookPath, 'utf8'); } catch {}
  if (content.includes(HOOK_BLOCK)) return { hookPath, already: true };
  if (content.includes(LEGACY_HOOK_BLOCK)) {
    // An older install: swap in the current block, leave the rest of the hook alone.
    fs.writeFileSync(hookPath, content.replace(LEGACY_HOOK_BLOCK, HOOK_BLOCK));
    return { hookPath, already: false, upgraded: true };
  }
  if (content.includes(MARKER)) return { hookPath, already: true };
  if (!content) content = '#!/bin/sh\n';
  if (!content.endsWith('\n')) content += '\n';
  content += HOOK_BLOCK;
  fs.writeFileSync(hookPath, content);
  fs.chmodSync(hookPath, 0o755);
  return { hookPath, already: false };
}

// Remove only our marked block; leave the rest of the hook untouched.
function removeSignHook(root = process.cwd()) {
  const hookPath = hookPathFor(root);
  let content = '';
  try { content = fs.readFileSync(hookPath, 'utf8'); } catch { return { hookPath, removed: false }; }
  if (!content.includes(MARKER)) return { hookPath, removed: false };
  const cleaned = content.replace(HOOK_BLOCK, '').replace(LEGACY_HOOK_BLOCK, '');
  if (cleaned.trim() === '#!/bin/sh') {
    fs.unlinkSync(hookPath);
  } else {
    fs.writeFileSync(hookPath, cleaned);
  }
  return { hookPath, removed: true };
}

function signStatus(root = process.cwd()) {
  const hookPath = hookPathFor(root);
  let content = '';
  try { content = fs.readFileSync(hookPath, 'utf8'); } catch {}
  return { hookPath, installed: content.includes(MARKER) };
}

function signCommand(sub) {
  const rel = (p) => path.relative(process.cwd(), p);
  if (sub === 'off' || sub === 'remove') {
    const { hookPath, removed } = removeSignHook();
    console.log(removed
      ? `\n  ✓ atris co-author removed: ${rel(hookPath)}\n`
      : `\n  nothing to remove, atris co-author is not installed\n`);
    return 0;
  }
  if (sub === 'status') {
    const { hookPath, installed } = signStatus();
    console.log(installed
      ? `\n  ✓ atris co-author is on: ${rel(hookPath)}\n    every commit gets: ${TRAILER}\n`
      : `\n  atris co-author is off, run 'atris sign' to turn it on\n`);
    return 0;
  }
  if (sub && sub !== 'on' && sub !== 'install') {
    console.log(`\n  atris sign: co-author trailer on every commit\n\n  atris sign          install the prepare-commit-msg hook\n  atris sign off      remove it\n  atris sign status   check whether it's installed\n\n  While installed, any commit in a repo with an atris/ folder gets:\n    ${TRAILER}\n`);
    return 2;
  }
  const { hookPath, already } = installSignHook();
  console.log(already
    ? `\n  already installed: ${rel(hookPath)}\n`
    : `\n  ✓ atris co-author installed: ${rel(hookPath)}\n    every commit here now gets: ${TRAILER}\n`);
  return 0;
}

module.exports = { signCommand, installSignHook, removeSignHook, signStatus, TRAILER };
