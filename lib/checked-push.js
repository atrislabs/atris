'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Git's pre-push input is the remote value from its own advertisement. Checking
// it here binds an ordinary fast-forward push to the exact base we tested.
function prePush() {
  const input = fs.readFileSync(0, 'utf8');
  const rows = input.split(/\r?\n/).filter(Boolean).map((line) => line.split(' '));
  const expected = rows.find((row) => row[2] === process.env.ATRIS_CHECKED_PUSH_REF);
  if (!expected || expected[3] !== process.env.ATRIS_CHECKED_PUSH_BASE) {
    process.stderr.write('target moved before push; nothing was landed\n');
    process.exitCode = 1;
    return;
  }
  const hook = process.env.ATRIS_CHECKED_PUSH_HOOK;
  if (!hook) return;
  const result = spawnSync(hook, process.argv.slice(2), { input, encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit'] });
  if (result.error) process.stderr.write(`${result.error.message}\n`);
  process.exitCode = result.status === null ? 1 : result.status;
}

function checkedPush({ root, candidate, target, base, env, timeout }) {
  const lookup = spawnSync('git', ['rev-parse', '--git-path', 'hooks/pre-push'], { cwd: root, encoding: 'utf8' });
  if (lookup.status !== 0) return { status: 1, stderr: 'could not find the existing push hook' };
  const hook = path.resolve(root, String(lookup.stdout || '').trim());
  let original = '';
  try { fs.accessSync(hook, fs.constants.X_OK); original = hook; } catch {}
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-checked-push-'));
  try {
    const script = `#!${process.execPath}\nrequire(${JSON.stringify(__filename)}).prePush();\n`;
    fs.writeFileSync(path.join(dir, 'pre-push'), script, { mode: 0o755 });
    return spawnSync('git', ['-c', `core.hooksPath=${dir}`, '-c', 'push.followTags=false', 'push', 'origin', `${candidate}:${target}`], {
      cwd: root, encoding: 'utf8', timeout, killSignal: 'SIGKILL', env: {
        ...env, ATRIS_CHECKED_PUSH_REF: target, ATRIS_CHECKED_PUSH_BASE: base, ATRIS_CHECKED_PUSH_HOOK: original,
      },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { checkedPush, prePush };
