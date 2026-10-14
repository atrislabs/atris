const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { autolandMemberRun } = require('../lib/member-autoland');

function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

const MAP = ['# MAP', '', '| task | file |', '|---|---|', '| board | lib/board.js |', ''].join('\n');

// A main checkout and a member worktree that both add a row to the same spot
// in atris/MAP.md, so git cannot merge them on its own. The main branch moves
// on origin after the member branched. `alsoCode` makes both sides edit the
// same code file too.
function fixture({ alsoCode = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-map-clash-'));
  const origin = path.join(base, 'origin.git');
  const main = path.join(base, 'main');
  git(['init', '--bare', '-b', 'master', origin], base);
  git(['init', '-b', 'master', main], base);
  git(['config', 'user.email', 'test@example.com'], main);
  git(['config', 'user.name', 'Test'], main);
  fs.mkdirSync(path.join(main, 'atris'));
  fs.writeFileSync(path.join(main, 'atris', 'MAP.md'), MAP);
  fs.writeFileSync(path.join(main, 'code.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(main, '.gitignore'), 'atris/runs/\natris/status/\n');
  git(['add', '.'], main);
  git(['commit', '-m', 'init'], main);
  git(['remote', 'add', 'origin', origin], main);
  git(['push', '-q', 'origin', 'master'], main);
  fs.mkdirSync(path.join(main, '.atris', 'policy'), { recursive: true });
  fs.writeFileSync(path.join(main, '.atris', 'policy', 'autoland.json'), JSON.stringify({ enabled: true }));

  const branch = 'codex/member-work';
  const worktree = path.join(base, 'wt');
  git(['worktree', 'add', '-q', '-b', branch, worktree, 'master'], main);
  fs.writeFileSync(path.join(worktree, 'atris', 'MAP.md'), MAP.replace('| board |', '| member work | lib/work.js |\n| board |'));
  fs.writeFileSync(path.join(worktree, 'work.js'), 'module.exports = "work";\n');
  if (alsoCode) fs.writeFileSync(path.join(worktree, 'code.js'), 'module.exports = 2;\n');
  git(['add', '.'], worktree);
  git(['commit', '-q', '-m', 'member work'], worktree);

  // Someone else lands on the main branch meanwhile, touching the same map spot.
  const other = path.join(base, 'other');
  git(['clone', '-q', origin, other], base);
  git(['config', 'user.email', 'other@example.com'], other);
  git(['config', 'user.name', 'Other'], other);
  fs.writeFileSync(path.join(other, 'atris', 'MAP.md'), MAP.replace('| board |', '| landed work | lib/landed.js |\n| board |'));
  fs.writeFileSync(path.join(other, 'landed.js'), 'module.exports = "landed";\n');
  if (alsoCode) fs.writeFileSync(path.join(other, 'code.js'), 'module.exports = 3;\n');
  git(['add', '.'], other);
  git(['commit', '-q', '-m', 'landed elsewhere'], other);
  git(['push', '-q', 'origin', 'master'], other);

  const bin = path.join(base, 'bin');
  const log = path.join(base, 'gh-calls.jsonl');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    "const [a, b] = process.argv.slice(2);",
    "if (a === 'pr' && b === 'list') console.log('[]');",
    "if (a === 'pr' && b === 'create') console.log('https://github.com/acme/repo/pull/7');",
  ].join('\n'), { mode: 0o755 });

  // The receipt a finished, reviewed run saves on the member's code.
  const tree = git(['rev-parse', 'HEAD^{tree}'], worktree);
  const at = new Date(Date.now() + 1000).toISOString();
  fs.mkdirSync(path.join(worktree, 'atris', 'runs'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'atris', 'runs', `mission-mission-test-${at.replace(/[:.]/g, '-')}.json`), JSON.stringify({
    clean: true,
    git_tree: tree,
    mission_id: 'mission-test',
    at,
    result: {
      kind: 'mission_run_summary',
      tick_count: 1,
      ticks: [{
        status: 'ran',
        tick_index: 1,
        engine_id: 'claude',
        verifier_passed: true,
        referee_result: { passed: true, mode: 'engine', engine: 'codex' },
        reviewed_git_tree: tree,
      }],
    },
  }));
  return { base, origin, worktree, bin, log, branch };
}

const mission = {
  id: 'mission-test',
  objective: 'Tidy the member board so finished work reads plainly to the operator every morning',
  owner: 'executor',
  runner: 'claude',
  lane: 'workspace',
  metadata: {},
  task_ids: [],
  verifier_result: { passed: true },
  worktree: { branch: 'codex/member-work' },
  last_tick_at: '2000-01-01T00:00:00.000Z',
  last_tick_status: 'ran',
  last_tick_index: 1,
};

function ghCalls(fx) {
  if (!fs.existsSync(fx.log)) return [];
  return fs.readFileSync(fx.log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function withFakeGh(fx, fn) {
  const saved = process.env.PATH;
  process.env.PATH = `${fx.bin}${path.delimiter}${saved}`;
  try {
    return fn();
  } finally {
    process.env.PATH = saved;
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
}

test('a branch that only clashes in the map file is merged with both rows kept and handed to auto-merge', () => {
  const fx = fixture();
  withFakeGh(fx, () => {
    const head = git(['rev-parse', 'HEAD'], fx.worktree);
    const out = autolandMemberRun({ mission, cwd: fx.worktree, loadTask: () => null });
    assert.equal(out.auto_merge, true, out.line);
    assert.deepEqual(out.map_merged, ['atris/MAP.md']);
    assert.match(out.line, /map lines from both sides kept/);

    // The pushed commit sits on top of the reviewed commit and the main branch.
    const pushed = git(['ls-remote', fx.origin, `refs/heads/${fx.branch}`], fx.base).split(/\s+/)[0];
    assert.equal(pushed, out.pushed);
    const masterSha = git(['rev-parse', 'master'], fx.origin);
    assert.deepEqual(git(['rev-list', '--parents', '-n', '1', pushed], fx.origin).split(' ').slice(1), [head, masterSha]);

    // Both rows survive, nothing is marked as a conflict, both sides' code is there.
    const map = git(['show', `${pushed}:atris/MAP.md`], fx.origin);
    assert.match(map, /\| member work \| lib\/work\.js \|/);
    assert.match(map, /\| landed work \| lib\/landed\.js \|/);
    assert.match(map, /\| board \| lib\/board\.js \|/);
    assert.doesNotMatch(map, /^(<<<<<<<|=======|>>>>>>>)/m);
    git(['cat-file', '-e', `${pushed}:work.js`], fx.origin);
    git(['cat-file', '-e', `${pushed}:landed.js`], fx.origin);

    // Auto-merge is pinned to the pushed merge, and the member's folder is untouched.
    const calls = ghCalls(fx);
    assert.deepEqual(calls[calls.length - 1], ['pr', 'merge', '7', '--auto', '--merge', '--match-head-commit', pushed]);
    assert.equal(git(['rev-parse', 'HEAD'], fx.worktree), head);
    assert.equal(git(['status', '--porcelain'], fx.worktree), '');
  });
});

test('a branch that also clashes in code holds with the clashing file named, and nothing is pushed', () => {
  const fx = fixture({ alsoCode: true });
  withFakeGh(fx, () => {
    const out = autolandMemberRun({ mission, cwd: fx.worktree, loadTask: () => null });
    assert.equal(out.auto_merge, false);
    assert.equal(out.gate, 'conflict');
    assert.match(out.line, /code\.js/);
    assert.doesNotMatch(out.line, /MAP\.md/);
    assert.equal(git(['ls-remote', fx.origin, `refs/heads/${fx.branch}`], fx.base), '');
    assert.deepEqual(ghCalls(fx), []);
  });
});
