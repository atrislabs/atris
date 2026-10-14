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

// A fake gh that appends each call's arguments to a log and serves pull
// request JSON from a config file the test can rewrite.
function writeFakeGh(bin, log, config) {
  fs.writeFileSync(path.join(bin, 'gh'), [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    `const cfg = fs.existsSync(${JSON.stringify(config)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(config)}, 'utf8')) : {};`,
    "const [a, b] = process.argv.slice(2);",
    "if (a === 'pr' && b === 'list') console.log(JSON.stringify(cfg.list || []));",
    "if (a === 'pr' && b === 'create') console.log(cfg.createUrl || 'https://github.com/acme/repo/pull/7');",
  ].join('\n'), { mode: 0o755 });
}

// A main checkout with a bare origin, a mission worktree on its own branch,
// and the fake gh on PATH.
function fixture({ policy, branch = 'codex/member-work', gh = {} } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-autoland-'));
  const origin = path.join(base, 'origin.git');
  const main = path.join(base, 'main');
  git(['init', '--bare', '-b', 'master', origin], base);
  git(['init', '-b', 'master', main], base);
  git(['config', 'user.email', 'test@example.com'], main);
  git(['config', 'user.name', 'Test'], main);
  fs.writeFileSync(path.join(main, 'README.md'), '# fixture\n');
  git(['add', '.'], main);
  git(['commit', '-m', 'init'], main);
  git(['remote', 'add', 'origin', origin], main);
  git(['push', '-q', 'origin', 'master'], main);
  if (policy !== undefined) {
    fs.mkdirSync(path.join(main, '.atris', 'policy'), { recursive: true });
    fs.writeFileSync(path.join(main, '.atris', 'policy', 'autoland.json'), policy);
  }
  const worktree = path.join(base, 'wt');
  git(['worktree', 'add', '-q', '-b', branch, worktree, 'master'], main);
  fs.writeFileSync(path.join(worktree, 'work.txt'), 'done\n');
  git(['add', '.'], worktree);
  git(['commit', '-q', '-m', 'member work'], worktree);

  const bin = path.join(base, 'bin');
  const log = path.join(base, 'gh-calls.jsonl');
  const config = path.join(base, 'gh-config.json');
  fs.mkdirSync(bin);
  fs.writeFileSync(config, JSON.stringify(gh));
  writeFakeGh(bin, log, config);
  const fx = { base, origin, worktree, bin, log, config, branch };
  writeRunReceipt(fx);
  return fx;
}

// The receipt shape a real run saves in the mission folder: the referee on
// each tick and the code tree the run ended on.
function writeRunReceipt(fx, { missionId = 'mission-test', at = '2026-10-14T06-58-08-502Z', ticks, gitTree } = {}) {
  const dir = path.join(fx.worktree, 'atris', 'runs');
  fs.mkdirSync(dir, { recursive: true });
  const receipt = {
    schema: 'atris.mission_receipt.v1',
    tree_hash: 'doctrine-only',
    git_tree: gitTree === undefined ? git(['rev-parse', 'HEAD^{tree}'], fx.worktree) : gitTree,
    mission_id: missionId,
    result: {
      kind: 'mission_run_summary',
      ticks: ticks || [{ engine_id: 'claude', referee_result: { passed: true, mode: 'engine', engine: 'codex', output: 'VERDICT: PASS' } }],
    },
  };
  fs.writeFileSync(path.join(dir, `mission-${missionId}-${at}.json`), JSON.stringify(receipt));
}

function ghCalls(fx) {
  if (!fs.existsSync(fx.log)) return [];
  return fs.readFileSync(fx.log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function mission(overrides = {}) {
  return {
    id: 'mission-test',
    objective: 'Tidy the member board so finished work reads plainly to the operator every morning',
    owner: 'executor',
    runner: 'claude',
    lane: 'workspace',
    metadata: {},
    task_ids: [],
    verifier_result: { passed: true, command: 'git diff --check' },
    worktree: { branch: 'codex/member-work' },
    ...overrides,
  };
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

test('policy missing: branch stays, gh is never called', () => {
  const fx = fixture();
  withFakeGh(fx, () => {
    const out = autolandMemberRun({ mission: mission(), cwd: fx.worktree, loadTask: () => null });
    assert.equal(out.auto_merge, false);
    assert.equal(out.gate, 'policy');
    assert.deepEqual(ghCalls(fx), []);
  });
});

test('policy on and every gate passes: pushes, opens a pull request, turns on auto-merge only', () => {
  const fx = fixture({ policy: JSON.stringify({ enabled: true, owner: 'keshav' }) });
  withFakeGh(fx, () => {
    const m = mission();
    const out = autolandMemberRun({ mission: m, cwd: fx.worktree, summary: 'Board reads plainly; check passed.', loadTask: () => null });
    assert.equal(out.auto_merge, true, out.line);
    assert.equal(out.url, 'https://github.com/acme/repo/pull/7');
    assert.match(out.line, /pull\/7/);
    const calls = ghCalls(fx);
    const head = git(['rev-parse', 'HEAD'], fx.worktree);
    assert.deepEqual(calls[0].slice(0, 8), ['pr', 'list', '--head', 'codex/member-work', '--base', 'master', '--state', 'open']);
    assert.deepEqual(calls[1].slice(0, 6), ['pr', 'create', '--head', 'codex/member-work', '--base', 'master']);
    assert.equal(calls[1][calls[1].indexOf('--title') + 1], m.objective.slice(0, 70));
    assert.equal(calls[1][calls[1].indexOf('--body') + 1], 'Board reads plainly; check passed.');
    assert.deepEqual(calls[2], ['pr', 'merge', '7', '--auto', '--merge', '--match-head-commit', head]);
    assert.equal(calls.length, 3);
    for (const call of calls.filter((c) => c[1] === 'merge')) assert.ok(call.includes('--auto'), 'never a plain merge');
    assert.ok(git(['ls-remote', fx.origin, 'refs/heads/codex/member-work'], fx.base), 'branch pushed');
  });
});

test('protected mission metadata: branch stays, gh is never called', () => {
  const fx = fixture({ policy: JSON.stringify({ enabled: true }) });
  withFakeGh(fx, () => {
    const out = autolandMemberRun({
      mission: mission({ metadata: { protected_lane_note: 'Never self-land: touches session minting.' } }),
      cwd: fx.worktree,
      loadTask: () => null,
    });
    assert.equal(out.gate, 'protected');
    assert.deepEqual(ghCalls(fx), []);
  });
});

test('linked billing task: branch stays, gh is never called', () => {
  const fx = fixture({ policy: JSON.stringify({ enabled: true }) });
  withFakeGh(fx, () => {
    const out = autolandMemberRun({
      mission: mission({ task_ids: ['T-1'] }),
      cwd: fx.worktree,
      loadTask: (id) => ({ id, tag: 'billing', title: 'Fix the plan page', metadata: {} }),
    });
    assert.equal(out.gate, 'protected');
    assert.match(out.line, /billing/);
    assert.deepEqual(ghCalls(fx), []);
  });
});

test('no review verdict: branch stays, gh is never called', () => {
  const fx = fixture({ policy: JSON.stringify({ enabled: true }) });
  const tick = (referee, engine = 'claude') => [{ engine_id: engine, ...(referee ? { referee_result: referee } : {}) }];
  withFakeGh(fx, () => {
    const cases = [
      { ticks: tick(null) },
      { ticks: tick({ passed: false, mode: 'engine', engine: 'codex' }) },
      // The worker graded itself: same engine on both sides.
      { ticks: tick({ passed: true, mode: 'engine', engine: 'claude' }) },
      // The member's own name is not a second reviewer.
      { ticks: tick({ passed: true, mode: 'engine', engine: 'executor' }) },
      // Worker engine unknown, so independence cannot be shown.
      { ticks: tick({ passed: true, mode: 'engine', engine: 'codex' }, ''), mission: { runner: 'auto' } },
    ];
    for (const c of cases) {
      writeRunReceipt(fx, { ticks: c.ticks });
      const out = autolandMemberRun({ mission: mission(c.mission || {}), cwd: fx.worktree, loadTask: () => null });
      assert.equal(out.gate, 'review', JSON.stringify(c));
    }
    // A pass saved on the mission object alone is not this run's receipt.
    fs.rmSync(path.join(fx.worktree, 'atris', 'runs'), { recursive: true, force: true });
    const loose = mission({
      review_verdict: { passed: true, reviewer: 'codex' },
      verifier_result: { passed: true, referee: { passed: true, mode: 'engine', engine: 'codex' } },
    });
    assert.equal(autolandMemberRun({ mission: loose, cwd: fx.worktree, loadTask: () => null }).gate, 'review');
    assert.deepEqual(ghCalls(fx), []);
  });
});

test('a referee from another engine opens the review gate when the run names its worker engine', () => {
  const fx = fixture({ policy: JSON.stringify({ enabled: true }) });
  withFakeGh(fx, () => {
    writeRunReceipt(fx, { ticks: [{ engine_id: 'codex', referee_result: { passed: true, mode: 'engine', engine: 'claude', output: 'VERDICT: PASS' } }] });
    const m = mission({ runner: 'auto' });
    const out = autolandMemberRun({ mission: m, cwd: fx.worktree, workerEngine: 'codex', loadTask: () => null });
    assert.equal(out.auto_merge, true, out.line);
    assert.deepEqual(ghCalls(fx).map((c) => c.slice(0, 2)), [['pr', 'list'], ['pr', 'create'], ['pr', 'merge']]);
  });
});

test('a review recorded on an older code tree holds the branch', () => {
  const fx = fixture({ policy: JSON.stringify({ enabled: true }) });
  withFakeGh(fx, () => {
    const reviewedTree = git(['rev-parse', 'HEAD^{tree}'], fx.worktree);
    writeRunReceipt(fx, { gitTree: reviewedTree });
    fs.writeFileSync(path.join(fx.worktree, 'work.txt'), 'changed after the review\n');
    git(['commit', '-qam', 'unreviewed change'], fx.worktree);
    const out = autolandMemberRun({ mission: mission(), cwd: fx.worktree, loadTask: () => null });
    assert.equal(out.gate, 'review');
    assert.match(out.line, /not recorded on the code/);
    // A receipt with no code tree at all holds too.
    writeRunReceipt(fx, { gitTree: null });
    assert.equal(autolandMemberRun({ mission: mission(), cwd: fx.worktree, loadTask: () => null }).gate, 'review');
    assert.deepEqual(ghCalls(fx), []);
  });
});

test('a failing referee on the latest run holds even when an older run passed', () => {
  const fx = fixture({ policy: JSON.stringify({ enabled: true }) });
  withFakeGh(fx, () => {
    // Older passing run is written by the fixture; the newer run failed review.
    writeRunReceipt(fx, {
      at: '2026-10-14T07-10-00-000Z',
      ticks: [{ engine_id: 'claude', referee_result: { passed: false, mode: 'engine', engine: 'codex', output: 'VERDICT: FAIL' } }],
    });
    const out = autolandMemberRun({ mission: mission(), cwd: fx.worktree, loadTask: () => null });
    assert.equal(out.gate, 'review');
    assert.match(out.line, /did not pass/);
    // One failing tick among passing ones on the same run also holds.
    writeRunReceipt(fx, {
      at: '2026-10-14T07-20-00-000Z',
      ticks: [
        { engine_id: 'claude', referee_result: { passed: false, mode: 'engine', engine: 'codex' } },
        { engine_id: 'claude', referee_result: { passed: true, mode: 'engine', engine: 'codex' } },
      ],
    });
    assert.equal(autolandMemberRun({ mission: mission(), cwd: fx.worktree, loadTask: () => null }).gate, 'review');
    // Another mission's passing receipt does not count for this one.
    fs.rmSync(path.join(fx.worktree, 'atris', 'runs'), { recursive: true, force: true });
    writeRunReceipt(fx, { missionId: 'mission-test-other' });
    assert.equal(autolandMemberRun({ mission: mission(), cwd: fx.worktree, loadTask: () => null }).gate, 'review');
    assert.deepEqual(ghCalls(fx), []);
  });
});

test('malformed task_ids hold the branch', () => {
  const fx = fixture({ policy: JSON.stringify({ enabled: true }) });
  withFakeGh(fx, () => {
    for (const taskIds of ['T-1', [''], ['T-1', 7], [null], { 0: 'T-1' }, null]) {
      const out = autolandMemberRun({ mission: mission({ task_ids: taskIds }), cwd: fx.worktree, loadTask: (id) => ({ id, title: 'fine', metadata: {} }) });
      assert.equal(out.gate, 'protected', JSON.stringify(taskIds));
    }
    assert.deepEqual(ghCalls(fx), []);
  });
});

test('a billing task linked through xp_task.task_id holds the branch', () => {
  const fx = fixture({ policy: JSON.stringify({ enabled: true }) });
  withFakeGh(fx, () => {
    const seen = [];
    const loadTask = (id) => {
      seen.push(id);
      return id === 'XP-9' ? { id, tag: 'billing', title: 'Plan page copy', metadata: {} } : { id, title: 'fine', metadata: {} };
    };
    const out = autolandMemberRun({ mission: mission({ xp_task: { task_id: 'XP-9' } }), cwd: fx.worktree, loadTask });
    assert.equal(out.gate, 'protected');
    assert.match(out.line, /billing/);
    assert.deepEqual(seen, ['XP-9']);
    // Every other link field is read too, and an unreadable one holds.
    for (const field of ['task_id', 'task_ref', 'current_task_id']) {
      const held = autolandMemberRun({ mission: mission({ [field]: 'GONE-1' }), cwd: fx.worktree, loadTask: () => null });
      assert.equal(held.gate, 'protected', field);
      assert.match(held.line, /GONE-1/);
    }
    const viaRef = autolandMemberRun({ mission: mission({ xp_task: { ref: 'GONE-2' } }), cwd: fx.worktree, loadTask: () => { throw new Error('db locked'); } });
    assert.equal(viaRef.gate, 'protected');
    assert.deepEqual(ghCalls(fx), []);
  });
});

test('protected metadata tags, title hashtags, and metadata text hold the branch', () => {
  const fx = fixture({ policy: JSON.stringify({ enabled: true }) });
  withFakeGh(fx, () => {
    const clean = { id: 'T-1', title: 'Tidy the board', metadata: {} };
    const cases = [
      { task: { ...clean, metadata: { tags: ['security'] } }, lane: /security/ },
      { task: { ...clean, metadata: { todo_tags: ['ux', 'deploy'] } }, lane: /deploy/ },
      { task: { ...clean, metadata: { tag: 'payments' } }, lane: /payments/ },
      { task: { ...clean, title: 'Tidy the board #customer' }, lane: /customer/ },
      { task: { ...clean, metadata: { details: 'This rotates the service token for the worker.' } }, lane: /security/ },
      { task: { ...clean, metadata: { body: 'Human review required before this lands.' } }, lane: /human review required/ },
      { task: { ...clean, metadata: { description: 'Adds a stripe webhook.' } }, lane: /billing/ },
    ];
    for (const c of cases) {
      const out = autolandMemberRun({ mission: mission({ task_ids: ['T-1'] }), cwd: fx.worktree, loadTask: () => c.task });
      assert.equal(out.gate, 'protected', JSON.stringify(c.task));
      assert.match(out.line, c.lane);
    }
    // The same metadata on the mission itself holds too.
    const own = autolandMemberRun({ mission: mission({ metadata: { tags: ['security'] } }), cwd: fx.worktree, loadTask: () => null });
    assert.equal(own.gate, 'protected');
    const details = autolandMemberRun({ mission: mission({ metadata: { details: 'Touches session minting.' } }), cwd: fx.worktree, loadTask: () => null });
    assert.equal(details.gate, 'protected');
    assert.deepEqual(ghCalls(fx), []);
  });
});

test('a numeric branch name merges by the created pull request number, pinned to the pushed commit', () => {
  const fx = fixture({
    policy: JSON.stringify({ enabled: true }),
    branch: '1234',
    gh: { list: [], createUrl: 'https://github.com/acme/repo/pull/88' },
  });
  withFakeGh(fx, () => {
    const out = autolandMemberRun({ mission: mission({ worktree: { branch: '1234' } }), cwd: fx.worktree, loadTask: () => null });
    assert.equal(out.auto_merge, true, out.line);
    const head = git(['rev-parse', 'HEAD'], fx.worktree);
    const calls = ghCalls(fx);
    assert.deepEqual(calls[1].slice(0, 6), ['pr', 'create', '--head', '1234', '--base', 'master']);
    assert.deepEqual(calls[2], ['pr', 'merge', '88', '--auto', '--merge', '--match-head-commit', head]);
    for (const call of calls.filter((c) => c[1] === 'merge')) assert.notEqual(call[2], '1234', 'never merge by branch name');
  });
});

test('an existing pull request into a different base is not used', () => {
  const fx = fixture({
    policy: JSON.stringify({ enabled: true }),
    gh: {
      // gh hands back a pull request from the same head into another base.
      list: [{ number: 41, headRefName: 'codex/member-work', baseRefName: 'release', headRefOid: 'x', isCrossRepository: false }],
      createUrl: 'https://github.com/acme/repo/pull/90',
    },
  });
  withFakeGh(fx, () => {
    const out = autolandMemberRun({ mission: mission(), cwd: fx.worktree, loadTask: () => null });
    assert.equal(out.auto_merge, true, out.line);
    const calls = ghCalls(fx);
    assert.deepEqual(calls.map((c) => c.slice(0, 2)), [['pr', 'list'], ['pr', 'create'], ['pr', 'merge']]);
    assert.equal(calls[2][2], '90');
    assert.ok(!calls.some((c) => c.includes('41')), 'the other-base pull request is never touched');
  });
});

test('an existing pull request from this branch into the main branch is reused by number', () => {
  const fx = fixture({
    policy: JSON.stringify({ enabled: true }),
    gh: { list: [{ number: 55, headRefName: 'codex/member-work', baseRefName: 'master', headRefOid: 'x', isCrossRepository: false }] },
  });
  withFakeGh(fx, () => {
    const out = autolandMemberRun({ mission: mission(), cwd: fx.worktree, loadTask: () => null });
    assert.equal(out.auto_merge, true, out.line);
    const calls = ghCalls(fx);
    assert.deepEqual(calls.map((c) => c.slice(0, 2)), [['pr', 'list'], ['pr', 'merge']]);
    assert.deepEqual(calls[1].slice(0, 5), ['pr', 'merge', '55', '--auto', '--merge']);
  });
});

test('malformed or switched-off policy holds the branch too', () => {
  for (const policy of ['{not json', JSON.stringify({ enabled: 'true' }), JSON.stringify({ enabled: false })]) {
    const fx = fixture({ policy });
    withFakeGh(fx, () => {
      const out = autolandMemberRun({ mission: mission(), cwd: fx.worktree, loadTask: () => null });
      assert.equal(out.gate, 'policy');
      assert.deepEqual(ghCalls(fx), []);
    });
  }
});

// Live repro: a real ignited run passed its check and a claude referee, but
// auto-merge held at review because the referee rides on the saved check
// result, not a separate field. This drives the real CLI end to end.
test('a real ignited run with a passing cross-engine referee turns on auto-merge', () => {
  const { scrubAgentEnv } = require('./helpers/agent-env');
  const cliPath = path.resolve(__dirname, '..', 'bin', 'atris.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-member-autoland-cli-'));
  const root = path.join(base, 'repo');
  const origin = path.join(base, 'origin.git');
  const bin = path.join(base, 'bin');
  const log = path.join(base, 'gh-calls.jsonl');
  try {
    fs.mkdirSync(path.join(root, 'atris', 'team', 'executor'), { recursive: true });
    fs.mkdirSync(path.join(root, '.atris', 'policy'), { recursive: true });
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(root, 'atris', 'team', 'executor', 'MEMBER.md'), '---\nname: executor\nrole: Test Member\n---\n\n# executor\n');
    fs.writeFileSync(path.join(root, '.atris', 'policy', 'autoland.json'), JSON.stringify({ enabled: true, owner: 'keshav' }));
    fs.writeFileSync(path.join(root, '.gitignore'), '.atris/\n');
    git(['init', '-q', '--bare', '-b', 'master', origin], base);
    git(['init', '-q', '-b', 'master'], root);
    git(['config', 'user.email', 'test@example.com'], root);
    git(['config', 'user.name', 'Test'], root);
    git(['add', '.'], root);
    git(['commit', '-qm', 'baseline'], root);
    git(['remote', 'add', 'origin', origin], root);
    git(['push', '-q', 'origin', 'master'], root);
    const script = (file, lines) => fs.writeFileSync(path.join(bin, file), ['#!/bin/sh', ...lines, ''].join('\n'), { mode: 0o755 });
    script('codex', [
      'echo done > work.txt',
      'git add work.txt >/dev/null 2>&1 && git commit -qm "write work.txt" >/dev/null 2>&1',
      'echo "wrote work.txt"',
    ]);
    script('claude', [
      'if [ "$1" = "--help" ]; then echo "--output-format --permission-mode --resume --session-id --include-partial-messages"; exit 0; fi',
      `echo '${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'VERDICT: PASS' })}'`,
    ]);
    writeFakeGh(bin, log, path.join(base, 'gh-config.json'));

    const res = spawnSync(process.execPath, [
      cliPath, 'member', 'run', 'executor', 'Write work.txt',
      '--engine', 'codex', '--referee', '--referee-engine', 'claude',
      '--ignite', '--verify', 'test -s work.txt',
    ], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120000,
      env: { ...scrubAgentEnv(), ATRIS_SKIP_UPDATE_CHECK: '1', PATH: `${bin}${path.delimiter}${process.env.PATH || ''}` },
    });
    const out = `${res.stdout}\n${res.stderr}`;
    assert.equal(res.status, 0, out);
    assert.match(out, /merges on its own once checks pass: https:\/\/github\.com\/acme\/repo\/pull\/7/, out);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(calls.map((c) => c.slice(0, 2)), [['pr', 'list'], ['pr', 'create'], ['pr', 'merge']], out);
    assert.deepEqual(calls[2].slice(2, 6), ['7', '--auto', '--merge', '--match-head-commit']);
    const branch = calls[1][calls[1].indexOf('--head') + 1];
    assert.equal(git(['ls-remote', origin, `refs/heads/${branch}`], base).split('\t')[0], calls[2][6], 'pushed commit is the pinned one');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
