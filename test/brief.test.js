'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
        done_at: new Date(NOW).toISOString(),
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
