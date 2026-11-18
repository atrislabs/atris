'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { buildMatrix, comparisonBase } = require('../scripts/ci-test-plan');

test('a small selection uses one runner and heavier selections distribute every test once', () => {
  const files = Array.from({ length: 16 }, (_, i) => `test/feature-${i}.test.js`);
  const weights = Object.fromEntries(files.map(file => [file, 30000]));
  for (const [size, count] of [[1, 1], [3, 3], [16, 8]]) {
    const selected = files.slice(0, size);
    const result = buildMatrix({ full: false, files: [...selected, selected[0]] }, 'merge_group', weights);
    assert.equal(result.mode, 'selected');
    const groups = result.matrix.include;
    assert.equal(groups.length, count);
    assert.deepEqual(groups.map(row => row.group), groups.map((_, i) => `${i + 1}/${count}`));
    assert.deepEqual(groups.flatMap(row => row.files).sort(), [...selected].sort());
    assert.ok(groups.every(row => row.files.length > 0));
  }
});

test('pull requests use quick fallback while the queue and scheduled or manual runs use all eight shards', () => {
  const fallback = { full: true, files: [], reason: 'unmapped change' };
  for (const event of ['pull_request', 'merge_group', 'schedule', 'workflow_dispatch']) {
    const { mode, matrix } = buildMatrix(fallback, event, {});
    const count = event === 'pull_request' ? 3 : 8;
    assert.equal(mode, event === 'pull_request' ? 'quick' : 'full');
    assert.deepEqual(matrix.include.map(row => row.group), Array.from({ length: count }, (_, i) => `${i + 1}/${count}`));
  }
});

function queueFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-stacked-queue-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const commitFile = name => {
    fs.writeFileSync(path.join(root, name), name);
    git('add', name);
    git('commit', '-qm', name);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-qb', 'main');
  git('config', 'user.name', 'Queue Test');
  git('config', 'user.email', 'queue@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  const base = commitFile('base');
  git('update-ref', 'refs/remotes/origin/main', base);
  git('switch', '-qc', 'change-one');
  const first = commitFile('first-file');
  git('switch', '-qc', 'queue', base);
  git('merge', '--no-ff', '-qm', 'queue change one', first);
  const firstQueued = git('rev-parse', 'HEAD');
  git('switch', '-qc', 'change-two', base);
  const second = commitFile('second-file');
  git('switch', '-q', 'queue');
  git('merge', '--no-ff', '-qm', 'queue change two', second);
  return { git, root, base, second, firstQueued, head: git('rev-parse', 'HEAD') };
}

test('a speculative queue entry covers both its own files and an unmerged predecessor', t => {
  const { git, root, base, firstQueued, head } = queueFixture(t);
  const group = { base_ref: 'refs/heads/main', base_sha: firstQueued, head_sha: head };
  const compare = payload => comparisonBase(root, 'merge_group', { merge_group: payload });
  assert.equal(compare(group), base);
  assert.deepEqual(git('diff', '--name-only', compare(group), head).split('\n'), ['first-file', 'second-file']);

  git('update-ref', 'refs/remotes/origin/main', firstQueued);
  assert.equal(compare(group), firstQueued);
  assert.throws(() => compare({ ...group, head_sha: firstQueued }));
  assert.throws(() => compare({ ...group, base_ref: 'refs/heads/missing' }));
});

test('a pull request comparison starts at the actual base of the tested merge commit', t => {
  const { root, firstQueued, second } = queueFixture(t);
  const event = { pull_request: { base: { sha: firstQueued, ref: 'main' }, head: { sha: second } } };
  assert.equal(comparisonBase(root, 'pull_request', event), firstQueued);
  assert.throws(() => comparisonBase(root, 'pull_request', { pull_request: { ...event.pull_request, head: { sha: firstQueued } } }));
});

test('the command writes a complete fallback plan when a pull request comparison cannot be verified', t => {
  const { root, base, second } = queueFixture(t);
  const eventPath = path.join(root, 'event.json');
  const output = path.join(root, 'outputs');
  fs.writeFileSync(eventPath, JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: second } } }));
  execFileSync(process.execPath, [require.resolve('../scripts/ci-test-plan')], {
    cwd: root, env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: output },
  });
  const lines = fs.readFileSync(output, 'utf8').trim().split('\n');
  assert.ok(lines.includes('mode=full'));
  const matrix = JSON.parse(lines.find(line => line.startsWith('matrix=')).slice('matrix='.length));
  assert.equal(matrix.include.length, 8);
});

test('the required GitHub check rejects every non-success outcome for every job it needs', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/ci.yml'), 'utf8');
  for (const trigger of ['pull_request', 'merge_group', 'schedule', 'workflow_dispatch']) {
    assert.match(workflow, new RegExp('^  ' + trigger + ':', 'm'));
  }
  assert.match(workflow, /cron:\s*['"][^'"]+['"]/);
  assert.match(workflow, /node scripts\/ci-test-plan\.js/);
  assert.match(workflow, /fromJSON\(needs\.plan\.outputs\.matrix\)/);

  const gate = workflow.split(/^  test:\s*$/m)[1].split(/^  [\w-]+:\s*$/m)[0];
  assert.match(gate, /if:\s*always\(\)/);
  const required = gate.match(/needs:\s*\[([^\]]+)\]/)[1].split(',').map(name => name.trim());
  assert.deepEqual(required.sort(), ['decks', 'plan', 'unit']);
  const env = {};
  for (const job of required) {
    const variable = gate.match(new RegExp('([A-Z_]+):\\s*\\$\\{\\{\\s*needs\\.' + job + '\\.result\\s*\\}\\}'));
    assert.ok(variable, 'missing result for ' + job);
    env[variable[1]] = 'success';
  }
  const script = gate.match(/run:\s*\|\s*\n((?:[ \t]+[^\n]+\n?)+)/)[1];
  const run = values => spawnSync('sh', ['-e', '-c', script], { env: values }).status;
  assert.equal(run(env), 0);
  for (const variable of Object.keys(env)) {
    for (const result of ['failure', 'cancelled', 'skipped', '']) {
      assert.equal(run({ ...env, [variable]: result }), 1, variable + ' = ' + result);
    }
  }
});
