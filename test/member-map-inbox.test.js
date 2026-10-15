const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { autolandMemberRun } = require('../lib/member-autoland');
const { inboxMapEdits, inboxPath } = require('../lib/member-map-inbox');

function git(args, cwd, { ok = true } = {}) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (ok) assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return ok ? res.stdout.trim() : res;
}

const MAP = ['# MAP', '', '| task | file |', '|---|---|', '| board | lib/board.js |', ''].join('\n');
const NOTES = ['# MAP notes', '', '- board: lib/board.js:1', ''].join('\n');
const BRANCH = 'codex/member-work';

function write(dir, file, text) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
}

// A main checkout and a member worktree. The member adds a row to the map and
// a line to the map notes, at the same spot another landing on the main
// branch already used, so the two would clash in both shared map files.
function fixture({ touchMaps = true, newFeatureMap = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-map-inbox-'));
  const origin = path.join(base, 'origin.git');
  const main = path.join(base, 'main');
  git(['init', '--bare', '-b', 'master', origin], base);
  git(['init', '-b', 'master', main], base);
  git(['config', 'user.email', 'test@example.com'], main);
  git(['config', 'user.name', 'Test'], main);
  write(main, 'atris/MAP.md', MAP);
  write(main, 'atris/refs/MAP-NOTES.md', NOTES);
  write(main, '.gitignore', 'atris/runs/\natris/status/\n');
  git(['add', '.'], main);
  git(['commit', '-q', '-m', 'init'], main);
  git(['remote', 'add', 'origin', origin], main);
  git(['push', '-q', 'origin', 'master'], main);
  write(main, '.atris/policy/autoland.json', JSON.stringify({ enabled: true }));

  const worktree = path.join(base, 'wt');
  git(['worktree', 'add', '-q', '-b', BRANCH, worktree, 'master'], main);
  write(worktree, 'work.js', 'module.exports = "work";\n');
  if (touchMaps) {
    write(worktree, 'atris/MAP.md', MAP.replace('| board |', '| member work | lib/work.js |\n| board |'));
    write(worktree, 'atris/refs/MAP-NOTES.md', NOTES.replace('- board:', '- member: lib/work.js:1\n- board:'));
  }
  if (newFeatureMap) write(worktree, 'atris/features/work/MAP.md', '# work map\n');
  git(['add', '.'], worktree);
  git(['commit', '-q', '-m', 'member work'], worktree);

  const other = path.join(base, 'other');
  git(['clone', '-q', origin, other], base);
  git(['config', 'user.email', 'other@example.com'], other);
  git(['config', 'user.name', 'Other'], other);
  write(other, 'atris/MAP.md', MAP.replace('| board |', '| landed work | lib/landed.js |\n| board |'));
  write(other, 'atris/refs/MAP-NOTES.md', NOTES.replace('- board:', '- landed: lib/landed.js:1\n- board:'));
  write(other, 'landed.js', 'module.exports = "landed";\n');
  git(['add', '.'], other);
  git(['commit', '-q', '-m', 'landed elsewhere'], other);
  git(['push', '-q', 'origin', 'master'], other);

  const bin = path.join(base, 'bin');
  const log = path.join(base, 'gh-calls.jsonl');
  write(bin, 'gh', [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    "const [a, b] = process.argv.slice(2);",
    "if (a === 'pr' && b === 'list') console.log('[]');",
    "if (a === 'pr' && b === 'create') console.log('https://github.com/acme/repo/pull/7');",
  ].join('\n'));
  fs.chmodSync(path.join(bin, 'gh'), 0o755);

  // The receipt a finished, reviewed run saves on the member's code.
  const tree = git(['rev-parse', 'HEAD^{tree}'], worktree);
  const at = new Date(Date.now() + 1000).toISOString();
  write(worktree, `atris/runs/mission-mission-test-${at.replace(/[:.]/g, '-')}.json`, JSON.stringify({
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
  return { base, origin, main, worktree, bin, log };
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
  worktree: { branch: BRANCH },
  last_tick_at: '2000-01-01T00:00:00.000Z',
  last_tick_status: 'ran',
  last_tick_index: 1,
};

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

test('a member branch that edited both shared map files lands with the maps untouched and its edits in the map inbox', () => {
  const fx = fixture();
  withFakeGh(fx, () => {
    const head = git(['rev-parse', 'HEAD'], fx.worktree);
    const start = git(['merge-base', head, 'origin/master'], fx.main);
    const out = autolandMemberRun({ mission, cwd: fx.worktree, loadTask: () => null });
    assert.equal(out.auto_merge, true, out.line);
    assert.deepEqual([...out.map_inboxed].sort(), ['atris/MAP.md', 'atris/refs/MAP-NOTES.md']);
    assert.deepEqual(out.map_merged, []);
    assert.match(out.line, /map edits saved to the map inbox/);

    // The pushed commit sits right on the reviewed commit and leaves both
    // shared map files exactly as the branch found them.
    const pushed = git(['ls-remote', fx.origin, `refs/heads/${BRANCH}`], fx.base).split(/\s+/)[0];
    assert.equal(pushed, out.pushed);
    assert.deepEqual(git(['rev-list', '--parents', '-n', '1', pushed], fx.origin).split(' ').slice(1), [head]);
    for (const file of ['atris/MAP.md', 'atris/refs/MAP-NOTES.md']) {
      assert.equal(git(['rev-parse', `${pushed}:${file}`], fx.origin), git(['rev-parse', `${start}:${file}`], fx.main));
    }
    git(['cat-file', '-e', `${pushed}:work.js`], fx.origin);

    // So it merges into the moved main branch with no clash at all.
    const master = git(['rev-parse', 'master'], fx.origin);
    assert.equal(git(['merge-tree', '--write-tree', pushed, master], fx.origin, { ok: false }).status, 0);

    // The inbox patch is named after the branch, holds the member's lines,
    // and applies cleanly to the maps the member started from.
    const patch = git(['show', `${pushed}:${inboxPath(BRANCH)}`], fx.origin);
    assert.equal(inboxPath(BRANCH), 'atris/refs/map-inbox/codex-member-work.patch');
    assert.match(patch, /^\+\| member work \| lib\/work\.js \|$/m);
    assert.match(patch, /^\+- member: lib\/work\.js:1$/m);
    assert.equal(git(['rev-parse', 'HEAD'], fx.main), start);
    fs.writeFileSync(path.join(fx.base, 'inbox.patch'), `${patch}\n`);
    git(['apply', path.join(fx.base, 'inbox.patch')], fx.main);
    assert.equal(fs.readFileSync(path.join(fx.main, 'atris/MAP.md'), 'utf8'), git(['show', `${head}:atris/MAP.md`], fx.worktree) + '\n');

    // The member's own folder is untouched.
    assert.equal(git(['rev-parse', 'HEAD'], fx.worktree), head);
    assert.equal(git(['status', '--porcelain'], fx.worktree), '');
  });
});

test('a member branch that left the shared maps alone pushes its reviewed commit as is', () => {
  const fx = fixture({ touchMaps: false });
  withFakeGh(fx, () => {
    const head = git(['rev-parse', 'HEAD'], fx.worktree);
    const out = autolandMemberRun({ mission, cwd: fx.worktree, loadTask: () => null });
    assert.equal(out.auto_merge, true, out.line);
    assert.equal(out.pushed, head);
    assert.deepEqual(out.map_inboxed, []);
    assert.doesNotMatch(out.line, /map inbox/);
  });
});

test('a map file the branch created itself stays where it is', () => {
  const fx = fixture({ newFeatureMap: true });
  try {
    const head = git(['rev-parse', 'HEAD'], fx.worktree);
    const master = git(['rev-parse', 'origin/master'], fx.worktree);
    const out = inboxMapEdits({ headSha: head, baseSha: master, branch: BRANCH, cwd: fx.worktree });
    assert.deepEqual([...out.moved].sort(), ['atris/MAP.md', 'atris/refs/MAP-NOTES.md']);
    assert.equal(git(['show', `${out.sha}:atris/features/work/MAP.md`], fx.worktree), '# work map');
    assert.doesNotMatch(git(['show', `${out.sha}:${out.inbox}`], fx.worktree), /features\/work/);

    // Running it again on its own result finds nothing left to move.
    const again = inboxMapEdits({ headSha: out.sha, baseSha: master, branch: BRANCH, cwd: fx.worktree });
    assert.equal(again.sha, out.sha);
    assert.deepEqual(again.moved, []);
  } finally {
    fs.rmSync(fx.base, { recursive: true, force: true });
  }
});
