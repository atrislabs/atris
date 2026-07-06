'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const fleet = require('../lib/fleet');
const {
  appendBriefRecord,
  buildBriefReview,
  latestBriefs,
  readBriefLedger,
  stampBriefOutcome,
} = require('../lib/brief-ledger');
const {
  buildBriefData,
  briefCommand,
  handleBriefAnswer,
  renderBrief,
  renderBriefHtml,
  shouldPromptBrief,
} = require('../commands/brief');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-07-05T12:00:00Z').getTime();

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-brief-test-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function seedProjection(dir, tasks) {
  const stateDir = path.join(dir, '.atris', 'state');
  ensureDir(stateDir);
  fs.writeFileSync(path.join(stateDir, 'tasks.projection.json'), JSON.stringify({ tasks }, null, 2), 'utf8');
}

function seedRoadmap(dir, items) {
  fs.writeFileSync(
    path.join(dir, 'ROADMAP.md'),
    `# Roadmap\n\n## Open loop items\n\n${items.map(item => `- [ ] ${item}`).join('\n')}\n`,
    'utf8'
  );
}

function runGit(dir, args) {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function makeGitWorktreeFixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-brief-git-'));
  const repo = path.join(parent, 'repo');
  const wt = path.join(parent, 'worker');
  fs.mkdirSync(repo, { recursive: true });
  runGit(repo, ['init']);
  runGit(repo, ['config', 'user.email', 'test@example.com']);
  runGit(repo, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n', 'utf8');
  runGit(repo, ['add', 'README.md']);
  runGit(repo, ['commit', '-m', 'initial']);
  runGit(repo, ['branch', '-M', 'master']);
  runGit(repo, ['worktree', 'add', '-b', 'worker', wt]);
  return { parent, repo, wt };
}

function captureStdout(fn) {
  const originalLog = console.log;
  let out = '';
  console.log = (...args) => {
    out += `${args.join(' ')}\n`;
  };
  return Promise.resolve()
    .then(fn)
    .then((code) => ({ code, out }))
    .finally(() => {
      console.log = originalLog;
    });
}

test('empty workspace renders a friendly brief', () => {
  const dir = makeTempDir();
  try {
    const data = buildBriefData(dir, { now: NOW });
    const out = renderBrief(data);
    assert.match(out, /atris brief: 0 landed, 0 waiting, 0 next moves/);
    assert.match(out, /landed: nothing finished yet/);
    assert.match(out, /waiting on you: nothing waiting/);
    assert.match(out, /next moves: nothing ranked/);
  } finally {
    cleanup(dir);
  }
});

test('seeded done task inside 24h appears in landed with proof pointer', () => {
  const dir = makeTempDir();
  try {
    seedProjection(dir, [
      {
        id: 'done-1',
        display_id: 'CLI-1',
        title: 'Ship atris brief for fast operator review',
        status: 'done',
        done_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(),
        metadata: {
          latest_agent_proof: 'verified with receipt atris/runs/brief-proof.json',
        },
      },
      {
        id: 'old-1',
        display_id: 'CLI-2',
        title: 'Old done task',
        status: 'done',
        done_at: new Date(NOW - 2 * DAY_MS).toISOString(),
      },
    ]);
    const data = buildBriefData(dir, { now: NOW });
    assert.equal(data.landed.length, 1);
    assert.equal(data.landed[0].id, 'CLI-1');
    assert.equal(data.landed[0].proof, 'atris/runs/brief-proof.json');
    assert.match(renderBrief(data), /atris\/runs\/brief-proof\.json/);
  } finally {
    cleanup(dir);
  }
});

test('seeded review task appears in waiting', () => {
  const dir = makeTempDir();
  try {
    seedProjection(dir, [
      {
        id: 'review-1',
        display_id: 'CLI-3',
        title: 'Approve the brief so operators can keep shipping',
        status: 'review',
        tag: 'customer',
        updated_at: new Date(NOW - 5 * 60 * 60 * 1000).toISOString(),
      },
    ]);
    const data = buildBriefData(dir, { now: NOW });
    assert.equal(data.waiting.length, 1);
    assert.equal(data.waiting[0].id, 'CLI-3');
    assert.equal(data.waiting[0].why, 'protected customer lane');
    assert.match(renderBrief(data), /waiting on you: review work needs a decision/);
  } finally {
    cleanup(dir);
  }
});

test('--json shape is stable', async () => {
  const dir = makeTempDir();
  try {
    seedProjection(dir, [
      {
        id: 'done-1',
        display_id: 'CLI-1',
        title: 'Ship json brief',
        status: 'done',
        done_at: new Date().toISOString(),
      },
    ]);
    const { code, out } = await captureStdout(() => briefCommand(['--json'], dir, {
      stdin: { isTTY: false },
      stdout: { isTTY: false },
    }));
    assert.equal(code, 0);
    const data = JSON.parse(out);
    assert.deepEqual(Object.keys(data), ['schema', 'days', 'landed', 'waiting', 'moves', 'week']);
    assert.equal(data.schema, 'atris.brief.v1');
    assert.equal(data.days, 1);
    assert.equal(data.landed.length, 1);
    assert.deepEqual(data.waiting, []);
    assert.deepEqual(data.moves, []);
    assert.match(data.week, /^week in review:/);
  } finally {
    cleanup(dir);
  }
});

test('html contains the waiting panel', () => {
  const dir = makeTempDir();
  try {
    seedProjection(dir, [
      {
        id: 'review-1',
        display_id: 'CLI-4',
        title: 'Review the brief html',
        status: 'review',
        updated_at: new Date(NOW).toISOString(),
      },
    ]);
    const html = renderBriefHtml(buildBriefData(dir, { now: NOW }));
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /data-atris-block="panel"/);
    assert.match(html, /waiting on you/);
    assert.match(html, /review lane/);
  } finally {
    cleanup(dir);
  }
});

test('renderBrief output has no em dash character', () => {
  const out = renderBrief({
    schema: 'atris.brief.v1',
    days: 1,
    landed: [{ id: 'CLI-1', title: 'Finished work', proof: 'proof on file', age: '1h' }],
    waiting: [{ id: 'CLI-2', title: 'Review work', why: 'review lane', age: '2h' }],
    moves: [{ id: 'm_1', title: 'Next move', why: 'roadmap item', source: 'roadmap' }],
    week: 'week in review: 1 landed, 0 completions, 0 xp',
  });
  assert.equal(out.includes('\u2014'), false);
});

test('non-tty branch does not prompt and one-shot answer handling is factored', async () => {
  const dir = makeTempDir();
  try {
    seedProjection(dir, [
      {
        id: 'review-1',
        display_id: 'CLI-5',
        title: 'Review the waiting item',
        status: 'review',
        updated_at: new Date(NOW).toISOString(),
      },
    ]);
    seedRoadmap(dir, ['approve the next loop move']);
    const data = buildBriefData(dir, { now: NOW });
    assert.equal(shouldPromptBrief({
      flags: {},
      stdin: { isTTY: false },
      stdout: { isTTY: true },
      data,
    }), false);

    const accepted = handleBriefAnswer(dir, data, 'a 1', {
      acceptTask: (id) => ({ ok: true, output: `accepted ${id}` }),
    });
    assert.deepEqual(accepted, { ok: true, message: 'accepted CLI-5' });

    const moved = handleBriefAnswer(dir, data, 'm 1', {
      approveMove: () => ({ alreadyPresent: false }),
    });
    assert.equal(moved.ok, true);
    assert.match(moved.message, /seeded into the loop/);
  } finally {
    cleanup(dir);
  }
});

test('fleet dispatch captures a well-shaped brief ledger record', () => {
  const fixture = makeGitWorktreeFixture();
  try {
    const result = fleet.dispatchToEngine({
      root: fixture.repo,
      worktreePath: fixture.wt,
      engine: 'codex',
      task: {
        display_id: 'CLI-901',
        title: 'brief ledger Done: capture prompt quality. Check: node --test test/brief.test.js.',
      },
      runner: () => ({ status: 0, stdout: 'report: done', stderr: '' }),
    });
    assert.equal(result.exitCode, 0);
    assert.ok(result.brief_id);
    const records = readBriefLedger(fixture.repo);
    assert.equal(records.length, 1);
    assert.equal(records[0].brief_id, result.brief_id);
    assert.equal(records[0].engine, 'codex');
    assert.equal(records[0].task_id, 'CLI-901');
    assert.match(records[0].prompt_text, /Done criteria: capture prompt quality/);
    assert.deepEqual(Object.keys(records[0].context), ['worktree', 'base_ref']);
    assert.equal(records[0].context.worktree, fixture.wt);
    assert.equal(records[0].outcome, null);
  } finally {
    cleanup(fixture.parent);
  }
});

test('brief outcome stamping appends a latest outcome row', () => {
  const dir = makeTempDir();
  try {
    const record = appendBriefRecord(dir, {
      author: 'orb',
      engine: 'cursor',
      task_id: 'CLI-901',
      prompt_text: 'Done criteria: ship it. Check: node --test test/brief.test.js.',
      context: { worktree: dir, base_ref: 'origin/master' },
    }, { now: new Date('2026-07-05T12:00:00Z') });
    const stamped = stampBriefOutcome(dir, record.brief_id, {
      result: 'pass',
      note: 'merged PR',
    }, { now: new Date('2026-07-05T12:10:00Z') });
    assert.equal(stamped.ok, true);
    const raw = readBriefLedger(dir);
    assert.equal(raw.length, 2);
    const latest = latestBriefs(raw)[0];
    assert.equal(latest.brief_id, record.brief_id);
    assert.equal(latest.outcome.result, 'pass');
    assert.equal(latest.outcome.note, 'merged PR');
  } finally {
    cleanup(dir);
  }
});

test('brief review groups recent briefs by outcome with computable signals', () => {
  const dir = makeTempDir();
  try {
    const pass = appendBriefRecord(dir, {
      author: 'orb',
      engine: 'codex',
      task_id: 'CLI-1',
      prompt_text: 'Done criteria: bounded slice. Check: node --test test/brief.test.js.',
      context: { worktree: dir, base_ref: 'origin/master' },
    }, { now: new Date('2026-07-05T12:00:00Z') });
    const fail = appendBriefRecord(dir, {
      author: 'orb',
      engine: 'cursor',
      task_id: 'CLI-2',
      prompt_text: 'Do a broad thing with no verifier.',
      context: { worktree: dir, base_ref: 'origin/master' },
    });
    const partial = appendBriefRecord(dir, {
      author: 'orb',
      engine: 'devin',
      task_id: 'CLI-3',
      prompt_text: 'Done criteria: one bounded slice.',
      context: { worktree: dir, base_ref: 'origin/master' },
    });
    appendBriefRecord(dir, {
      author: 'orb',
      engine: 'codex',
      task_id: 'CLI-4',
      prompt_text: 'Open flight. Check: node --test test/open.test.js.',
      context: { worktree: dir, base_ref: 'origin/master' },
    });
    stampBriefOutcome(dir, pass.brief_id, { result: 'pass', note: 'merged' }, { now: new Date('2026-07-05T12:12:00Z') });
    stampBriefOutcome(dir, fail.brief_id, { result: 'fail', note: 'dead flight' });
    stampBriefOutcome(dir, partial.brief_id, { result: 'partial', note: 'verify failed' });
    const review = buildBriefReview(dir, { limit: 10 });
    assert.equal(review.groups.pass.length, 1);
    assert.equal(review.groups.fail.length, 1);
    assert.equal(review.groups.partial.length, 1);
    assert.equal(review.groups.open.length, 1);
    assert.equal(review.groups.pass[0].signals.has_named_verify, true);
    assert.equal(review.groups.pass[0].signals.had_exit_criteria, true);
    assert.equal(review.groups.pass[0].signals.time_to_land_ms, 12 * 60 * 1000);
  } finally {
    cleanup(dir);
  }
});

test('brief lessons appear only after a five-record signal bucket exists', () => {
  const dir = makeTempDir();
  try {
    for (let i = 0; i < 4; i += 1) {
      const record = appendBriefRecord(dir, {
        author: 'orb',
        engine: 'codex',
        prompt_text: `Done criteria: bounded ${i}. Check: node --test test/${i}.test.js.`,
        context: { worktree: dir, base_ref: 'origin/master' },
      });
      stampBriefOutcome(dir, record.brief_id, { result: i < 3 ? 'pass' : 'fail', note: 'done' });
    }
    assert.deepEqual(buildBriefReview(dir, { lessons: true }).lessons, []);
    const fifth = appendBriefRecord(dir, {
      author: 'orb',
      engine: 'codex',
      prompt_text: 'Done criteria: bounded 5. Check: node --test test/five.test.js.',
      context: { worktree: dir, base_ref: 'origin/master' },
    });
    stampBriefOutcome(dir, fifth.brief_id, { result: 'pass', note: 'done' });
    const lessons = buildBriefReview(dir, { lessons: true }).lessons;
    assert.ok(lessons.some((line) => /briefs with a named verify command land 4 of 5/.test(line)));
  } finally {
    cleanup(dir);
  }
});

test('brief ledger default output hides generated ids', async () => {
  const dir = makeTempDir();
  try {
    const promptFile = path.join(dir, 'prompt.md');
    fs.writeFileSync(promptFile, 'Done criteria: keep ids hidden. Check: node --test test/brief.test.js.\n', 'utf8');
    const logged = await captureStdout(() => briefCommand(['log', '--engine', 'codex', '--prompt-file', promptFile], dir, {
      stdin: { isTTY: false },
      stdout: { isTTY: false },
    }));
    assert.equal(logged.code, 0);
    assert.match(logged.out, /brief logged for codex/);
    assert.doesNotMatch(logged.out, /brief-\d{8}/);
    const id = readBriefLedger(dir)[0].brief_id;
    const outcome = await captureStdout(() => briefCommand(['outcome', id, '--result', 'pass', '--note', 'merged'], dir, {
      stdin: { isTTY: false },
      stdout: { isTTY: false },
    }));
    assert.equal(outcome.code, 0);
    assert.equal(outcome.out.trim(), 'brief outcome recorded: pass');
    assert.doesNotMatch(outcome.out, new RegExp(id));
  } finally {
    cleanup(dir);
  }
});
