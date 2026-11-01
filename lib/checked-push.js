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
  const sourceMatches = () => {
    if (!process.env.ATRIS_CHECKED_SOURCE_REF) return true;
    const source = spawnSync('git', ['rev-parse', '--verify', process.env.ATRIS_CHECKED_SOURCE_REF], { encoding: 'utf8' });
    return source.status === 0 && source.stdout.trim() === process.env.ATRIS_CHECKED_SOURCE_OID;
  };
  if (!sourceMatches()) {
    process.stderr.write('source branch moved before push; nothing was landed\n');
    process.exitCode = 1;
    return;
  }
  const hook = process.env.ATRIS_CHECKED_PUSH_HOOK;
  if (hook) {
    const result = spawnSync(hook, process.argv.slice(2), { input, encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit'] });
    if (result.error) process.stderr.write(`${result.error.message}\n`);
    if (result.status !== 0) { process.exitCode = result.status === null ? 1 : result.status; return; }
  }
  if (!sourceMatches()) {
    process.stderr.write('source branch moved during the push hook; nothing was landed\n');
    process.exitCode = 1;
  }
}

function checkedPush({ root, candidate, target, base, sourceRef, sourceOid, env, timeout }) {
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
        ATRIS_CHECKED_SOURCE_REF: sourceRef || '', ATRIS_CHECKED_SOURCE_OID: sourceOid || '',
      },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { checkedPush, prePush };
