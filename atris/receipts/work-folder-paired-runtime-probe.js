'use strict';

// Advisory baseline, not a refusal regression: both production runners still
// accept this path. Only startup PATH is controlled; no candidate fix is added.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildVerifiedProof } = require('../../lib/task-proof');
const { writeTaskReceipt } = require('../../lib/task-receipt');
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";

if (process.argv[2] === '--child') {
  const root = process.argv[3];
  assert.ok(path.dirname(process.execPath).includes(':'));
  const competitor = path.join(root, 'competing');
  let calls = 0;
  const runner = (file, args, options) => {
    assert.equal(file, 'bash');
    assert.equal(args[0], '-lc');
    calls++;
    return spawnSync(file, ['-lc', `export PATH=${quote(competitor)}:"$PATH"\n${args[1]}`], options);
  };
  for (const kind of ['shared', 'receipt']) {
    const sentinel = path.join(root, `${kind}-ran.txt`);
    const command = `printf ran > ${quote(sentinel)}; node --version`;
    const result = kind === 'shared'
      ? buildVerifiedProof(command, '', runner, { cwd: root })
      : writeTaskReceipt({ taskId: 'paired-runtime-probe', command, root, runner });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.exit, 0);
    assert.equal(result.output, 'competing-node');
    assert.equal(result.cmd, command);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'ran');
    if (kind === 'receipt') {
      assert.equal(result.passed, true);
      const receipt = JSON.parse(fs.readFileSync(result.receiptFile, 'utf8'));
      assert.equal(receipt.command, command);
      assert.equal(receipt.result.passed, true);
      assert.equal(receipt.result.output, 'competing-node');
    } else {
      assert.ok(result.proof.startsWith(`[verified] \`${command}\` passed (exit 0)`));
    }
    console.log(`${kind}: ok ${result.ok}, exit ${result.exit}, output ${result.output}, command ran`);
    console.log(`${kind}: ${kind === 'receipt' ? 'passing receipt written' : 'passing proof returned'}; colon-path refusal absent`);
  }
  assert.equal(calls, 2);
  console.log('two real runner calls reproduced the baseline; production unchanged');
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-paired-runtime-'));
  try {
    const caller = path.join(root, "caller node's:bin");
    const competitor = path.join(root, 'competing');
    fs.mkdirSync(caller);
    fs.mkdirSync(competitor);
    const libraries = path.resolve(path.dirname(process.execPath), '../lib');
    if (process.platform === 'darwin' && fs.existsSync(libraries)) {
      fs.symlinkSync(libraries, path.join(root, 'lib'), 'dir');
    }
    fs.writeFileSync(path.join(competitor, 'node'), '#!/bin/sh\nprintf competing-node\n', { mode: 0o755 });
    const binary = path.join(caller, path.basename(process.execPath));
    fs.copyFileSync(process.execPath, binary);
    fs.chmodSync(binary, 0o755);
    const child = spawnSync(binary, [__filename, '--child', root], { encoding: 'utf8', timeout: 30000 });
    process.stdout.write(child.stdout || '');
    process.stderr.write(child.stderr || '');
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0);
  } finally {
    // Remove only this invocation's generated fixture, including its receipts.
    fs.rmSync(root, { recursive: true, force: true });
  }
}
