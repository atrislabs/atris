'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { computeTreeHash } = require('../lib/tree-hash');
const { runBench, runBenchPair } = require('../lib/bench/runner');
const { materializeCandidate, renderTreeInto } = require('../lib/bench/tree-render');
const { benchCommand } = require('../commands/bench');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-bench-pair-test-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function writeTree(parent, name, label) {
  const root = path.join(parent, name);
  fs.mkdirSync(path.join(root, 'atris', 'skills', 'example'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris.md'), `# ${label}\n`, 'utf8');
  fs.writeFileSync(path.join(root, 'atris', 'skills', 'example', 'SKILL.md'), `# ${label} skill\n`, 'utf8');
  return root;
}

function writeAgentTask(repoRoot, dirname, options = {}) {
  const id = options.id || dirname.replace(/^\d+-/, '');
  const taskDir = path.join(repoRoot, 'atris', 'benchmarks', 'pair-v1', dirname);
  fs.mkdirSync(path.join(taskDir, 'fixture'), { recursive: true });
  fs.writeFileSync(path.join(taskDir, 'fixture', 'seed.txt'), 'fixture\n', 'utf8');
  fs.writeFileSync(path.join(taskDir, 'prompt.md'), 'Inspect the fixture and make the requested benchmark change.\n', 'utf8');
  fs.writeFileSync(path.join(taskDir, 'check.js'), options.check || `
    module.exports = {
      id: ${JSON.stringify(id)},
      title: ${JSON.stringify(id)},
      category: 'pair',
      async check() {},
    };
  `, 'utf8');
  fs.writeFileSync(path.join(taskDir, 'solution.sh'), options.solution || '#!/bin/sh\nexit 0\n', 'utf8');
  if (options.setup) fs.writeFileSync(path.join(taskDir, 'setup.js'), options.setup, 'utf8');
  return taskDir;
}

function candidateOnlyCheck(id) {
  return `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    module.exports = {
      id: ${JSON.stringify(id)},
      title: ${JSON.stringify(id)},
      category: 'pair',
      async check(ctx) {
        assert.match(fs.readFileSync(path.join(ctx.workspace, 'atris.md'), 'utf8'), /candidate/);
      },
    };
  `;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function runGit(repo, args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test('render copies the text tree and only creates missing pointer files', () => {
  const dir = makeTempDir();
  try {
    const tree = writeTree(dir, 'tree', 'candidate');
    const workspace = path.join(dir, 'workspace');
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'fixture agents\n', 'utf8');

    const rendered = renderTreeInto(workspace, tree);

    assert.equal(fs.readFileSync(path.join(workspace, 'atris.md'), 'utf8'), '# candidate\n');
    assert.equal(
      fs.readFileSync(path.join(workspace, 'atris', 'skills', 'example', 'SKILL.md'), 'utf8'),
      '# candidate skill\n',
    );
    assert.equal(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8'), 'fixture agents\n');
    assert.equal(
      fs.readFileSync(path.join(workspace, 'CLAUDE.md'), 'utf8'),
      '# CLAUDE.md\nRead atris.md at the workspace root first and follow it.\nSkills live under atris/skills, team briefs under atris/team.\n',
    );
    assert.deepEqual(rendered, { tree_hash: computeTreeHash(tree).hash, files: 2 });

    fs.writeFileSync(path.join(workspace, 'CLAUDE.md'), 'fixture claude\n', 'utf8');
    renderTreeInto(workspace, tree);
    assert.equal(fs.readFileSync(path.join(workspace, 'CLAUDE.md'), 'utf8'), 'fixture claude\n');
  } finally {
    cleanup(dir);
  }
});

test('runBench renders a requested tree and records that rendered hash', async () => {
  const dir = makeTempDir();
  try {
    writeAgentTask(dir, '01-tree-check', { id: 'tree-check', check: candidateOnlyCheck('tree-check') });
    const current = writeTree(dir, 'current', 'current');
    const candidate = writeTree(dir, 'candidate', 'candidate');
    const { record, exitCode } = await runBench({
      repoRoot: dir,
      pack: 'pair-v1',
      engine: 'null',
      stateRoot: current,
      treeRoot: candidate,
      persist: false,
    });

    assert.equal(exitCode, 0);
    assert.equal(record.tree_hash, computeTreeHash(candidate).hash);
    assert.notEqual(record.tree_hash, computeTreeHash(current).hash);
  } finally {
    cleanup(dir);
  }
});

test('a passing candidate against a failing current tree is selected', async () => {
  const dir = makeTempDir();
  try {
    writeAgentTask(dir, '01-tree-win', { id: 'tree-win', check: candidateOnlyCheck('tree-win') });
    const current = writeTree(dir, 'current', 'current');
    const candidate = writeTree(dir, 'candidate', 'candidate');
    const { record, exitCode } = await runBenchPair({
      repoRoot: dir,
      pack: 'pair-v1',
      engine: 'null',
      stateRoot: current,
      candidateRoot: candidate,
    });

    assert.equal(exitCode, 0);
    assert.equal(record.verdict, 'select');
    assert.equal(record.reason, 'candidate won 1 pairing and lost 0');
    assert.deepEqual(record.tasks.map((task) => task.outcome), ['win']);
    assert.deepEqual(record.current_scores, [0]);
    assert.deepEqual(record.candidate_scores, [1]);
    assert.equal(record.current_tree_hash, computeTreeHash(current).hash);
    assert.equal(record.candidate_tree_hash, computeTreeHash(candidate).hash);
    const resultRows = fs.readFileSync(path.join(current, '.atris', 'state', 'bench', 'results.jsonl'), 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.deepEqual(resultRows, [record]);
  } finally {
    cleanup(dir);
  }
});

test('equal pair scores are ties and use exit code 2', async () => {
  const dir = makeTempDir();
  try {
    writeAgentTask(dir, '01-equal', {
      id: 'equal',
      check: `
        module.exports = {
          id: 'equal', title: 'equal', category: 'pair',
          async check() { throw new Error('expected failure'); },
        };
      `,
    });
    const current = writeTree(dir, 'current', 'current');
    const candidate = writeTree(dir, 'candidate', 'candidate');
    const { record, exitCode } = await runBenchPair({
      repoRoot: dir,
      pack: 'pair-v1',
      engine: 'null',
      stateRoot: current,
      candidateRoot: candidate,
      persist: false,
    });

    assert.equal(exitCode, 2);
    assert.equal(record.verdict, 'reject');
    assert.equal(record.reason, 'all pairings tied');
    assert.deepEqual(record.current_scores, [0]);
    assert.deepEqual(record.candidate_scores, [0]);
    assert.deepEqual([record.wins, record.losses, record.ties], [0, 0, 1]);
  } finally {
    cleanup(dir);
  }
});

test('a candidate that cannot run ranks below a failing current tree', async () => {
  const dir = makeTempDir();
  try {
    writeAgentTask(dir, '01-unavailable', {
      id: 'unavailable',
      setup: `
        const fs = require('node:fs');
        const path = require('node:path');
        module.exports = function setup(ctx) {
          const tree = fs.readFileSync(path.join(ctx.workspace, 'atris.md'), 'utf8');
          if (tree.includes('candidate')) throw new Error('candidate setup failed');
        };
      `,
      check: `
        module.exports = {
          id: 'unavailable', title: 'unavailable', category: 'pair',
          async check() { throw new Error('current fails its check'); },
        };
      `,
    });
    const current = writeTree(dir, 'current', 'current');
    const candidate = writeTree(dir, 'candidate', 'candidate');
    const { record, exitCode } = await runBenchPair({
      repoRoot: dir,
      pack: 'pair-v1',
      engine: 'null',
      stateRoot: current,
      candidateRoot: candidate,
      persist: false,
    });

    assert.equal(exitCode, 1);
    assert.deepEqual(record.current_scores, [0]);
    assert.deepEqual(record.candidate_scores, [null]);
    assert.equal(record.tasks[0].outcome, 'loss');
    assert.match(record.tasks[0].candidate_failures[0], /candidate setup failed/);
  } finally {
    cleanup(dir);
  }
});

test('minimum win margin can reject a single candidate win', async () => {
  const dir = makeTempDir();
  try {
    writeAgentTask(dir, '01-margin', { id: 'margin', check: candidateOnlyCheck('margin') });
    const current = writeTree(dir, 'current', 'current');
    const candidate = writeTree(dir, 'candidate', 'candidate');
    const { record, exitCode } = await runBenchPair({
      repoRoot: dir,
      pack: 'pair-v1',
      engine: 'null',
      stateRoot: current,
      candidateRoot: candidate,
      minWinMargin: 1,
      persist: false,
    });

    assert.equal(exitCode, 1);
    assert.equal(record.verdict, 'reject');
    assert.equal(record.wins, 1);
    assert.equal(record.losses, 0);
    assert.equal(record.min_win_margin, 1);
  } finally {
    cleanup(dir);
  }
});

test('pair execution interleaves current then candidate in pack order', async () => {
  const dir = makeTempDir();
  try {
    const orderFile = path.join(dir, 'order.txt');
    for (const [dirname, id] of [['01-first', 'first'], ['02-second', 'second']]) {
      writeAgentTask(dir, dirname, {
        id,
        solution: `#!/bin/sh\nlabel=$(sed -n '1s/^# //p' atris.md)\nprintf '%s:%s\\n' ${shellQuote(id)} "$label" >> ${shellQuote(orderFile)}\n`,
      });
    }
    const current = writeTree(dir, 'current', 'current');
    const candidate = writeTree(dir, 'candidate', 'candidate');
    const { record } = await runBenchPair({
      repoRoot: dir,
      pack: 'pair-v1',
      engine: 'solution',
      taskIds: ['second', 'first'],
      stateRoot: current,
      candidateRoot: candidate,
      repeats: 2,
      persist: false,
    });

    assert.equal(
      fs.readFileSync(orderFile, 'utf8'),
      'first:current\nfirst:candidate\nfirst:current\nfirst:candidate\n'
        + 'second:current\nsecond:candidate\nsecond:current\nsecond:candidate\n',
    );
    assert.deepEqual(record.tasks.map((task) => task.id), ['first', 'first', 'second', 'second']);
  } finally {
    cleanup(dir);
  }
});

test('materializeCandidate accepts directories and extracts git refs', () => {
  const dir = makeTempDir();
  let materialized = null;
  try {
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    runGit(repo, ['init']);
    runGit(repo, ['config', 'user.email', 'bench@example.com']);
    runGit(repo, ['config', 'user.name', 'bench']);
    fs.writeFileSync(path.join(repo, 'atris.md'), '# committed candidate\n', 'utf8');
    runGit(repo, ['add', 'atris.md']);
    runGit(repo, ['commit', '-m', 'candidate tree']);

    assert.equal(materializeCandidate(repo, repo), path.resolve(repo));
    materialized = materializeCandidate('HEAD', repo);
    assert.notEqual(materialized, path.resolve(repo));
    assert.equal(fs.readFileSync(path.join(materialized, 'atris.md'), 'utf8'), '# committed candidate\n');
    assert.throws(() => materializeCandidate('missing-ref', repo), /missing-ref/);
  } finally {
    if (materialized) cleanup(materialized);
    cleanup(dir);
  }
});

test('bench pair command prints task scores and the final verdict', async () => {
  const dir = makeTempDir();
  const originalCwd = process.cwd();
  const originalLog = console.log;
  const lines = [];
  try {
    const current = writeTree(dir, 'current', 'current');
    const candidate = writeTree(dir, 'candidate', 'candidate');
    process.chdir(current);
    console.log = (line = '') => lines.push(String(line));
    const exitCode = await benchCommand([
      'pair',
      '--candidate', candidate,
      '--current', current,
      '--pack', 'agents-v1',
      '--engine', 'null',
      '--task', 'find-the-bug-line',
      '--here',
    ]);

    assert.equal(exitCode, 2);
    assert.deepEqual(lines, [
      'find-the-bug-line   current fail   candidate fail   tie',
      'wins 0  losses 0  ties 1',
      'verdict: reject, all pairings tied',
    ]);
  } finally {
    console.log = originalLog;
    process.chdir(originalCwd);
    cleanup(dir);
  }
});
