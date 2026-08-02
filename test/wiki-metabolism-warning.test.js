'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const WIKI_NUDGE = 'the wiki has grown a lot since its last pruning; run: atris wiki consolidate';

function createWorkspace(t, { indexEntries = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-wiki-warning-'));
  const wikiDir = path.join(root, 'atris', 'wiki');
  fs.mkdirSync(wikiDir, { recursive: true });
  fs.writeFileSync(
    path.join(wikiDir, 'index.md'),
    `# index\n\n${Array.from({ length: indexEntries }, (_, index) => `- entry ${index}`).join('\n')}\n`,
    'utf8'
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, wikiDir };
}

function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  if (result.error) throw result.error;
  return result;
}

function assertNudgeCount(result, count) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.split(WIKI_NUDGE).length - 1, count, result.stdout);
}

function runBootAndTidy(root) {
  return {
    boot: runCli(['atris.md'], root),
    tidy: runCli(['clean', '--dry-run'], root),
  };
}

test('boot and tidy output show one wiki pruning nudge when findings exist', (t) => {
  const { root } = createWorkspace(t, { indexEntries: 41 });
  const results = runBootAndTidy(root);

  assertNudgeCount(results.boot, 1);
  assertNudgeCount(results.tidy, 1);
});

test('boot and tidy output omit the wiki pruning nudge when the wiki is clean', (t) => {
  const { root } = createWorkspace(t, { indexEntries: 1 });
  const results = runBootAndTidy(root);

  assertNudgeCount(results.boot, 0);
  assertNudgeCount(results.tidy, 0);
});

test('a missing wiki does not break boot or tidy output', (t) => {
  const { root, wikiDir } = createWorkspace(t);
  fs.rmSync(wikiDir, { recursive: true });
  const results = runBootAndTidy(root);

  assertNudgeCount(results.boot, 0);
  assertNudgeCount(results.tidy, 0);
});

test('an unreadable metabolism marker does not break boot or tidy output', (t) => {
  const { root } = createWorkspace(t, { indexEntries: 41 });
  fs.mkdirSync(path.join(root, '.atris', 'state', 'wiki.metabolism.json'), { recursive: true });
  const results = runBootAndTidy(root);

  assertNudgeCount(results.boot, 1);
  assertNudgeCount(results.tidy, 1);
});

test('an unreadable wiki surface does not break boot or tidy output', (t) => {
  const { root, wikiDir } = createWorkspace(t);
  fs.rmSync(path.join(wikiDir, 'index.md'));
  fs.mkdirSync(path.join(wikiDir, 'index.md'));
  const results = runBootAndTidy(root);

  assertNudgeCount(results.boot, 0);
  assertNudgeCount(results.tidy, 0);
});
