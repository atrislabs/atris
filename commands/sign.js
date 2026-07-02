const fs = require('fs');
const path = require('path');

// atris sign: co-author trailer on every commit in an atris workspace.
// Installs a prepare-commit-msg hook that appends "Co-authored-by: Atris"
// when the repo has an atris/ folder — same credit line Claude and Cursor use.
// Idempotent and non-destructive: appends a marked block, removes only its own block.

const MARKER = '# atris co-author';
const TRAILER = 'Co-authored-by: Atris <noreply@atris.ai>';

const HOOK_BLOCK = `
${MARKER}
if [ -d "$(git rev-parse --show-toplevel 2>/dev/null)/atris" ] && [ "$2" != "merge" ] && [ "$2" != "squash" ]; then
  if ! grep -qi "^co-authored-by: atris" "$1"; then
    printf '\\nCo-authored-by: Atris <noreply@atris.ai>\\n' >> "$1"
  fi
fi
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
  const cleaned = content.replace(HOOK_BLOCK, '');
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
      : `\n  nothing to remove — atris co-author is not installed\n`);
    return 0;
  }
  if (sub === 'status') {
    const { hookPath, installed } = signStatus();
    console.log(installed
      ? `\n  ✓ atris co-author is on: ${rel(hookPath)}\n    every commit gets: ${TRAILER}\n`
      : `\n  atris co-author is off — run 'atris sign' to turn it on\n`);
    return installed ? 0 : 1;
  }
  if (sub && sub !== 'on' && sub !== 'install') {
    console.log(`\n  atris sign — co-author trailer on every commit\n\n  atris sign          install the prepare-commit-msg hook\n  atris sign off      remove it\n  atris sign status   check whether it's installed\n\n  While installed, any commit in a repo with an atris/ folder gets:\n    ${TRAILER}\n`);
    return 0;
  }
  const { hookPath, already } = installSignHook();
  console.log(already
    ? `\n  already installed: ${rel(hookPath)}\n`
    : `\n  ✓ atris co-author installed: ${rel(hookPath)}\n    every commit here now gets: ${TRAILER}\n`);
  return 0;
}

module.exports = { signCommand, installSignHook, removeSignHook, signStatus, TRAILER };
