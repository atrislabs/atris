'use strict';

// Pre-build evidence only: inject real shell startup, never a fabricated result.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildVerifiedProof } = require('../../lib/task-proof');
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";

if (process.argv[2] === '--child') {
  const cwd = process.argv[3];
  const colonPath = path.dirname(process.execPath).includes(':');
  const competitor = path.join(cwd, 'competing');
  const prefix = `export PATH=${quote(path.dirname(process.execPath))}:"$PATH"\n`;
  let calls = 0;
  const runner = candidate => (file, args, options) => {
    assert.equal(file, 'bash');
    assert.equal(args[0], '-lc');
    calls++;
    // Set a known competing executable after the actual login profile loads.
    // The candidate prefix then runs exactly where production would put it.
    const script = `export PATH=${quote(competitor)}:"$PATH"\n${candidate ? prefix : ''}${args[1]}`;
    return spawnSync(file, ['-lc', script], options);
  };
  function check(label, command, candidate, exit, output) {
    const result = buildVerifiedProof(command, '', runner(candidate), { cwd });
    assert.equal(result.exit, exit, JSON.stringify(result));
    assert.equal(result.ok, exit === 0);
    assert.equal(result.cmd, command);
    assert.equal(result.output, output);
    if (exit === 0) assert.ok(result.proof.startsWith(`[verified] \`${command}\` passed (exit 0)`));
    else assert.equal(result.reason, 'verifier_failed');
    console.log(`${label}: ${result.output}, exit ${result.exit}`);
  }
  check('controlled competing executable', 'node --version', false, 0, 'competing-node');
  if (colonPath) {
    check('colon splits the candidate PATH entry', 'node --version', true, 0, 'competing-node');
    check('quoted absolute caller bypasses PATH splitting', `${quote(process.execPath)} -p process.execPath`, true, 0, process.execPath);
    assert.equal(calls, 3);
    console.log('colon boundary reproduced with three actual login-shell children; production unchanged');
    return;
  }
  check('caller path with spaces and apostrophe', 'node -p process.execPath', true, 0, process.execPath);
  const script = 'console.log(JSON.stringify(process.argv.slice(1)))';
  check('quoted variable and glob', `VALUE='two words'; node -e ${quote(script)} "$VALUE" sample-*.txt`, true, 0,
    '["two words","sample-one.txt","sample-two.txt"]');
  check('ordinary shell command', "printf '%s' 'shell still works'", true, 0, 'shell still works');
  check('failed child', "node -e 'console.log(\"expected failure\"); process.exit(7)'", true, 7, 'expected failure');
  check('explicit path override', `PATH=${quote(competitor)}:"$PATH" node --version`, true, 0, 'competing-node');
  assert.equal(calls, 6);
  console.log('six actual login-shell children checked; production unchanged');
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-proof-runtime-'));
  try {
    const competitor = path.join(dir, 'competing');
    fs.mkdirSync(competitor);
    // Homebrew Node loads its shared library relative to the executable.
    const libraries = path.resolve(path.dirname(process.execPath), '../lib');
    if (process.platform === 'darwin' && fs.existsSync(libraries)) {
      fs.symlinkSync(libraries, path.join(dir, 'lib'), 'dir');
    }
    fs.writeFileSync(path.join(competitor, 'node'), '#!/bin/sh\nprintf competing-node\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'sample-one.txt'), 'one');
    fs.writeFileSync(path.join(dir, 'sample-two.txt'), 'two');
    for (const name of ["caller node's bin", "caller node's:bin"]) {
      const caller = path.join(dir, name);
      fs.mkdirSync(caller);
      const binary = path.join(caller, path.basename(process.execPath));
      // A copy keeps process.execPath at the unusual path; a symlink resolves away.
      fs.copyFileSync(process.execPath, binary);
      fs.chmodSync(binary, 0o755);
      const result = spawnSync(binary, [__filename, '--child', dir], { encoding: 'utf8', timeout: 30000 });
      process.stdout.write(result.stdout || '');
      process.stderr.write(result.stderr || '');
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0);
    }
  } finally {
    // Only this invocation's generated temporary fixture is removed.
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
