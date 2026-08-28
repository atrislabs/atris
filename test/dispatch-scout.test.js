'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const fleet = require('../lib/fleet');
const {
  SCOUT_BLOCK_HEADING,
  SCOUT_PACK_SCHEMA,
  SCOUT_TIMEOUT_MS,
  appendVerifiedScoutPack,
  buildScoutInvocation,
  buildVerifiedScoutPack,
  checkoutCommit,
  seedScoutContext,
  verifyScoutPack,
} = require('../lib/dispatch-scout');

const TASK = {
  display_id: 'CLI-1273',
  status: 'open',
  title: 'Fix alpha and beta dispatch context. Done: both entry points are covered. Check: git diff --check.',
};

function runGit(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')} failed: ${result.stderr}`);
  return String(result.stdout || '').trim();
}

function makeFixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-scout-fixture-'));
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  const alphaExcerpt = [
    'function alphaEntry() {',
    "  return 'alpha dispatch context';",
    '}',
  ].join('\n');
  const alphaSource = ["'use strict';", ...Array.from({ length: 20 }, () => ''), alphaExcerpt, ''].join('\n');
  const betaExcerpt = [
    'function betaEntry() {',
    "  return 'beta dispatch context';",
    '}',
  ].join('\n');
  const largeAlpha = `const largeAlpha = '${'a'.repeat(2200)}';`;
  const largeBeta = `const largeBeta = '${'b'.repeat(2200)}';`;
  const mapLines = [
    '# fixture map',
    '- `lib/alpha.js:2` alphaEntry is the alpha dispatch context entry point.',
    '- `lib/beta.js:1` betaEntry is the beta dispatch context entry point.',
    '- `lib/large-alpha.js:1` largeAlpha is a large dispatch fixture.',
    '- `lib/large-beta.js:1` largeBeta is a large dispatch fixture.',
    '',
  ];
  fs.writeFileSync(path.join(root, 'atris', 'MAP.md'), mapLines.join('\n'));
  fs.writeFileSync(path.join(root, 'lib', 'alpha.js'), alphaSource);
  fs.writeFileSync(path.join(root, 'lib', 'beta.js'), `${betaExcerpt}\n`);
  fs.writeFileSync(path.join(root, 'lib', 'large-alpha.js'), `${largeAlpha}\n`);
  fs.writeFileSync(path.join(root, 'lib', 'large-beta.js'), `${largeBeta}\n`);
  runGit(root, ['init', '-q']);
  runGit(root, ['config', 'user.name', 'Fixture']);
  runGit(root, ['config', 'user.email', 'fixture@example.com']);
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '-qm', 'fixture']);
  return {
    root,
    commit: checkoutCommit(root),
    alphaExcerpt,
    alphaLine: alphaSource.split('\n').findIndex((line) => line === 'function alphaEntry() {') + 1,
    betaExcerpt,
    largeAlpha,
    largeBeta,
    mapLines,
  };
}

function rawPack(fixture, hits, extra = {}) {
  return {
    schema: SCOUT_PACK_SCHEMA,
    task_id: TASK.display_id,
    checkout_commit: fixture.commit,
    hits,
    map_gotchas: [{ line: 2, text: fixture.mapLines[1] }],
    not_checked: ['runtime callers outside the allowed list'],
    ...extra,
  };
}

function alphaHit(fixture, line = fixture.alphaLine) {
  return {
    path: 'lib/alpha.js',
    line,
    excerpt: fixture.alphaExcerpt,
    why: 'This is the alpha entry point named by the task.',
  };
}

function betaHit(fixture) {
  return {
    path: 'lib/beta.js',
    line: 1,
    excerpt: fixture.betaExcerpt,
    why: 'This is the beta entry point named by the task.',
  };
}

test('the scout ask is Haiku in read-only plan mode with local tools only', () => {
  const invocation = buildScoutInvocation({ engine: 'haiku', model: '', prompt: 'inspect allowed files' });
  assert.equal(invocation.bin, 'claude');
  assert.match(invocation.args.join(' '), /--model claude-haiku-4-5/);
  assert.match(invocation.args.join(' '), /--permission-mode plan/);
  assert.doesNotMatch(invocation.args.join(' '), /--safe-mode/);
  assert.match(invocation.args.join(' '), /--no-session-persistence/);
  assert.equal(invocation.args[invocation.args.indexOf('--tools') + 1], 'Read,Glob,Grep');
});

test('cite verification deletes bad paths and rewrites a drifted MAP line in a fixture repo', () => {
  const fixture = makeFixtureRepo();
  try {
    const seed = seedScoutContext({ task: TASK, worktreePath: fixture.root });
    const verified = verifyScoutPack(rawPack(fixture, [
      { path: 'lib/missing.js', line: 1, excerpt: 'missing', why: 'This path is invented.' },
      alphaHit(fixture, 2),
      betaHit(fixture),
    ]), {
      task: TASK,
      worktreePath: fixture.root,
      allowedFiles: [...seed.allowedFiles, 'lib/missing.js'],
      expectedCommit: fixture.commit,
    });

    assert.ok(verified);
    assert.deepEqual(verified.hits.map((hit) => hit.path), ['lib/alpha.js', 'lib/beta.js']);
    assert.equal(verified.hits[0].line, fixture.alphaLine);
    assert.equal(verified.map_gotchas[0].line, 2);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('fewer than two surviving hits drops the whole scout pack', () => {
  const fixture = makeFixtureRepo();
  try {
    const seed = seedScoutContext({ task: TASK, worktreePath: fixture.root });
    const verified = verifyScoutPack(rawPack(fixture, [
      alphaHit(fixture),
      { path: 'lib/missing.js', line: 1, excerpt: 'missing', why: 'This path is invented.' },
    ]), {
      task: TASK,
      worktreePath: fixture.root,
      allowedFiles: seed.allowedFiles,
      expectedCommit: fixture.commit,
    });
    assert.equal(verified, null);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a verified pack over four kilobytes is dropped', () => {
  const fixture = makeFixtureRepo();
  try {
    const largeTask = { ...TASK, title: 'Inspect large alpha and large beta dispatch fixtures.' };
    const seed = seedScoutContext({ task: largeTask, worktreePath: fixture.root });
    const verified = verifyScoutPack({
      schema: SCOUT_PACK_SCHEMA,
      task_id: TASK.display_id,
      checkout_commit: fixture.commit,
      hits: [
        { path: 'lib/large-alpha.js', line: 1, excerpt: fixture.largeAlpha, why: 'This is the first large fixture.' },
        { path: 'lib/large-beta.js', line: 1, excerpt: fixture.largeBeta, why: 'This is the second large fixture.' },
      ],
      map_gotchas: [],
      not_checked: [],
    }, {
      task: largeTask,
      worktreePath: fixture.root,
      allowedFiles: seed.allowedFiles,
      expectedCommit: fixture.commit,
    });
    assert.equal(verified, null);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('commit pinning refuses a pack from a mismatched checkout', () => {
  const fixture = makeFixtureRepo();
  try {
    const seed = seedScoutContext({ task: TASK, worktreePath: fixture.root });
    const mismatched = rawPack(fixture, [alphaHit(fixture), betaHit(fixture)], {
      checkout_commit: '0'.repeat(40),
    });
    assert.equal(verifyScoutPack(mismatched, {
      task: TASK,
      worktreePath: fixture.root,
      allowedFiles: seed.allowedFiles,
      expectedCommit: fixture.commit,
    }), null);
    assert.equal(appendVerifiedScoutPack('original brief', mismatched, { worktreePath: fixture.root }), 'original brief');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

function ownCliForFixture(task, worktreePath) {
  return (args) => {
    if (args[0] === 'task' && args[1] === 'show') {
      return { status: 0, stdout: JSON.stringify(task), stderr: '' };
    }
    if (args[0] === 'worktree' && args[1] === 'start') {
      return { status: 0, stdout: `next: cd ${worktreePath}\n`, stderr: '' };
    }
    return { status: 0, stdout: 'done: worktree shipped\n', stderr: '' };
  };
}

async function runFixtureDispatch(fixture, scoutAsk) {
  const receiptRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-scout-receipt-'));
  const prompts = [];
  const flight = await fleet.runDispatchFlight({
    root: receiptRoot,
    taskIds: [TASK.display_id],
    engine: 'cursor',
    ownCli: ownCliForFixture(TASK, fixture.root),
    dispatcher: (entry) => {
      prompts.push(entry.prompt);
      return Promise.resolve({ exitCode: 0, report: 'builder launched' });
    },
    scoutAsk,
    rebase: () => ({ ok: true, stage: 'rebased' }),
    verifier: () => ({ status: 0, stdout: 'verified\n', stderr: '' }),
    log: () => {},
  });
  fs.rmSync(receiptRoot, { recursive: true, force: true });
  return { flight, prompts };
}

test('scout timeout still launches the builder with the unchanged brief', async () => {
  const fixture = makeFixtureRepo();
  let asks = 0;
  try {
    const { flight, prompts } = await runFixtureDispatch(fixture, async ({ job, timeoutMs }) => {
      asks += 1;
      assert.equal(job.engine, 'haiku');
      assert.equal(timeoutMs, SCOUT_TIMEOUT_MS);
      return { ok: false, reason: 'timeout', timed_out: true, stdout: '' };
    });
    assert.equal(asks, 1);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0], fleet.buildFleetPrompt(TASK, { worktreePath: fixture.root }));
    assert.equal(flight.status, 'completed');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a verified pack block appears exactly once in the built brief', async () => {
  const fixture = makeFixtureRepo();
  let asks = 0;
  try {
    const { prompts } = await runFixtureDispatch(fixture, async ({ job, root, timeoutMs }) => {
      asks += 1;
      assert.equal(job.engine, 'haiku');
      assert.equal(root, fixture.root);
      assert.equal(timeoutMs, SCOUT_TIMEOUT_MS);
      assert.match(job.prompt, /Allowed tracked files:/);
      return {
        ok: true,
        timed_out: false,
        stdout: JSON.stringify(rawPack(fixture, [alphaHit(fixture), betaHit(fixture)])),
      };
    });
    assert.equal(asks, 1);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].split(SCOUT_BLOCK_HEADING).length - 1, 1);
    assert.match(prompts[0], new RegExp(`verified against commit ${fixture.commit}`));
    assert.match(prompts[0], /Open atris\/MAP\.md first/);
    assert.match(prompts[0], /lib\/alpha\.js:/);
    assert.match(prompts[0], /lib\/beta\.js:/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('dispatch scout uses one fake ask response and never calls a real model', async () => {
  const fixture = makeFixtureRepo();
  let calls = 0;
  try {
    const pack = await buildVerifiedScoutPack({
      task: TASK,
      worktreePath: fixture.root,
      ask: async () => {
        calls += 1;
        return { ok: true, stdout: JSON.stringify(rawPack(fixture, [alphaHit(fixture), betaHit(fixture)])) };
      },
    });
    assert.equal(calls, 1);
    assert.equal(pack.hits.length, 2);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
