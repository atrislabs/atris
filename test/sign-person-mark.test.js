// Seen 2026-11-17: 112 of 112 saves read as agent changes, the owner's own hand edits among them,
// because the Atris line goes on every save. A save typed in a terminal with no agent running
// now also says "Atris-Made-By: person", and the counter reads it.
// A member testing the first try found helpers the tool starts carry no helper sign, so the
// programs that started the save are checked, not the signs alone.
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

// The hook's parent is this test process; a fake process list says who started it.
function tree(root, starter) {
  const file = path.join(root, 'ps.txt');
  fs.writeFileSync(file, [
    '50 1 /sbin/launchd',
    '60 50 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal',
    '70 60 -zsh',
    ...(starter ? [`75 70 ${starter}`] : []),
    `${process.pid} ${starter ? 75 : 70} git commit -m x`,
  ].join('\n') + '\n');
  return { ATRIS_SIGN_PS: `cat ${file}` };
}

test('a save started from a plain terminal is marked as a person; one started by a helper is not', (t) => {
  const root = repo(t);
  installSignHook(root);
  const person = hook(root, { TERM_PROGRAM: 'Apple_Terminal', ...tree(root) });
  assert.match(person, /^Co-authored-by: Atris /m, 'the Atris line always stays');
  assert.match(person, /^Atris-Made-By: person$/m);
  assert.equal(isAgentCommitBody(person), false);

  // Seen 2026-11-17: helpers the tool starts carry no helper sign, so the starters decide.
  for (const starter of ['node /opt/homebrew/bin/atris member run krishna', '/opt/homebrew/bin/grok --always-approve -p go',
    'codex exec -m gpt-6-sol go', '/Applications/Atris.app/Contents/MacOS/Atris', 'claude -p go']) {
    const agent = hook(root, { TERM_PROGRAM: 'Apple_Terminal', ...tree(root, starter) });
    assert.match(agent, /^Co-authored-by: Atris /m);
    assert.doesNotMatch(agent, /Atris-Made-By/, starter);
    assert.equal(isAgentCommitBody(agent), true, starter);
  }
  const signed = hook(root, { TERM_PROGRAM: 'Apple_Terminal', CLAUDECODE: '1', ...tree(root) });
  assert.doesNotMatch(signed, /Atris-Made-By/, 'a helper sign is enough on its own');
  assert.doesNotMatch(hook(root, tree(root)), /Atris-Made-By/, 'no terminal, no claim it was a person');
  // A member's case, 2026-11-17: when the process list cannot be read, nobody is called a person.
  assert.doesNotMatch(hook(root, { TERM_PROGRAM: 'Apple_Terminal', ATRIS_SIGN_PS: 'true' }), /Atris-Made-By/, 'a blind look says agent');
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
  assert.match(hook(root, { TERM_PROGRAM: 'iTerm.app', ...tree(root) }), /^Atris-Made-By: person$/m);
  assert.equal(installSignHook(root).already, true);
  assert.equal(isAgentCommitBody('x\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nAtris-Made-By: person\n'), true);
  assert.equal(isAgentCommitBody('x\n\nCo-authored-by: Atris <299057014+atris-builder[bot]@users.noreply.github.com>\n'), true, 'old saves keep reading as before');
});
