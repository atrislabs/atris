const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { knownCommands } = require('../lib/known-commands');
const { buildPushChangePlan, buildPushUploadBatches } = require('../commands/push');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-watch-alias-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, env = {}, timeout = 6000 } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      NODE_NO_WARNINGS: '1',
      ...env,
    },
  });
  if (result.error) throw result.error;
  return result;
}

test('watch is a known top-level proactive watcher command', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    fs.mkdirSync(home, { recursive: true });

    assert.ok(knownCommands.includes('watch'));
    const res = runCli(['watch', '--help'], { cwd: dir, env: { HOME: home } });

    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.doesNotMatch(res.stdout, /Unknown command/);
    assert.match(res.stdout, /atris watch "<sentence>"/);
    assert.match(res.stdout, /atris watch list/);
    assert.match(res.stdout, /looking for the old file-sync watcher\? use: atris sync --watch/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('push skips manifest-unchanged files before upload and batches small changed files', () => {
  const reads = [];
  const plan = buildPushChangePlan({
    baseFiles: {
      '/atris/wiki/unchanged.md': { hash: 'same', size: 6 },
      '/atris/wiki/a.md': { hash: 'old-a', size: 5 },
      '/atris/wiki/b.md': { hash: 'old-b', size: 5 },
    },
    localFiles: {
      '/atris/wiki/unchanged.md': { hash: 'same', size: 6 },
      '/atris/wiki/a.md': { hash: 'new-a', size: 8 },
      '/atris/wiki/b.md': { hash: 'new-b', size: 8 },
    },
    readFileContent: (filePath) => {
      reads.push(filePath);
      return `content:${filePath}`;
    },
  });

  assert.deepEqual(reads.sort(), ['/atris/wiki/a.md', '/atris/wiki/b.md']);
  assert.deepEqual(plan.filesToPush.map((file) => file.path).sort(), ['/atris/wiki/a.md', '/atris/wiki/b.md']);
  assert.equal(plan.unchangedCount, 1);

  const batches = buildPushUploadBatches(plan.filesToPush, { maxBatchBytes: 1024 });
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].map((file) => file.path).sort(), ['/atris/wiki/a.md', '/atris/wiki/b.md']);
});
