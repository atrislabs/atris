// Seen 2026-11-17: 112 of 112 saves read as agent changes, the owner's own hand edits among them,
// because the Atris line goes on every save. A save typed in a terminal with no agent running
// now also says "Atris-Made-By: person", and the counter reads it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { installSignHook } = require('../commands/sign');
const { isAgentCommitBody } = require('../commands/improve');

function repo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-sign-person-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q'], { cwd: root });
  fs.mkdirSync(path.join(root, 'atris'));
  return root;
}

function hook(root, env) {
  const msg = path.join(root, 'MSG');
  fs.writeFileSync(msg, 'fix a typo\n');
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
    !/^(CLAUDE|CODEX|CURSOR|DEVIN|ATRIS_|TERM_PROGRAM$|SSH_TTY$)/.test(k)));
  const r = spawnSync('sh', [path.join(root, '.git/hooks/prepare-commit-msg'), msg], { cwd: root, env: { ...clean, ...env } });
  assert.equal(r.status, 0, String(r.stderr));
  return fs.readFileSync(msg, 'utf8');
}

test('a terminal save with no agent running is marked as a person; an agent save is not', (t) => {
  const root = repo(t);
  installSignHook(root);
  const person = hook(root, { TERM_PROGRAM: 'Apple_Terminal' });
  assert.match(person, /^Co-authored-by: Atris /m, 'the Atris line always stays');
  assert.match(person, /^Atris-Made-By: person$/m);
  assert.equal(isAgentCommitBody(person), false);

  // ATRIS_RUNNER_PROFILE: found 2026-11-17 by a member testing this before it landed; atris engine sets it.
  for (const marker of ['CLAUDECODE', 'CODEX_SANDBOX', 'ATRIS_MISSION_DRIVER_DETACHED', 'ATRIS_RUNNER_PROFILE']) {
    const agent = hook(root, { TERM_PROGRAM: 'Apple_Terminal', [marker]: '1' });
    assert.match(agent, /^Co-authored-by: Atris /m);
    assert.doesNotMatch(agent, /Atris-Made-By/, marker);
    assert.equal(isAgentCommitBody(agent), true, marker);
  }
  const scheduled = hook(root, {});
  assert.doesNotMatch(scheduled, /Atris-Made-By/, 'no terminal, no claim it was a person');
});

test('an older install is upgraded in place, and a named agent still wins over the person mark', (t) => {
  const root = repo(t);
  const hookPath = path.join(root, '.git/hooks/prepare-commit-msg');
  fs.writeFileSync(hookPath, `#!/bin/sh\necho mine\n
# atris co-author
if [ -d "$(git rev-parse --show-toplevel 2>/dev/null)/atris" ] && [ "$2" != "merge" ] && [ "$2" != "squash" ]; then
  if ! grep -qi "^co-authored-by: atris" "$1"; then
    printf '\\nCo-authored-by: Atris <299057014+atris-builder[bot]@users.noreply.github.com>\\n' >> "$1"
  fi
fi
`);
  fs.chmodSync(hookPath, 0o755);
  assert.equal(installSignHook(root).upgraded, true);
  assert.match(fs.readFileSync(hookPath, 'utf8'), /echo mine/, 'the rest of the hook stays');
  assert.match(hook(root, { TERM_PROGRAM: 'iTerm.app' }), /^Atris-Made-By: person$/m);
  assert.equal(installSignHook(root).already, true);
  assert.equal(isAgentCommitBody('x\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nAtris-Made-By: person\n'), true);
  assert.equal(isAgentCommitBody('x\n\nCo-authored-by: Atris <299057014+atris-builder[bot]@users.noreply.github.com>\n'), true, 'old saves keep reading as before');
});
