'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-review-wish-home-'));
process.env.HOME = SANDBOX_HOME;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}

const { reviewWish } = require('../lib/wish-delegate');

test.after(() => {
  fs.rmSync(SANDBOX_HOME, { recursive: true, force: true });
});

const STATE_REL = path.join('.atris', 'state', 'wishes.jsonl');

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-review-wish-'));
}

function writeEvents(root, events) {
  const file = path.join(root, STATE_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, events.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');
}

function readEvents(root) {
  const file = path.join(root, STATE_REL);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function reviewEvents(root) {
  return readEvents(root).filter((event) => event.kind === 'review');
}

// Runs reviewWish with console output captured and a fixed actor name.
function run(positionals, root, options, actor = 'tester') {
  const out = [];
  const err = [];
  const realLog = console.log;
  const realError = console.error;
  const hadActor = Object.prototype.hasOwnProperty.call(process.env, 'ATRIS_AGENT_ID');
  const previousActor = process.env.ATRIS_AGENT_ID;
  console.log = (...args) => out.push(args.join(' '));
  console.error = (...args) => err.push(args.join(' '));
  if (actor === null) delete process.env.ATRIS_AGENT_ID;
  else process.env.ATRIS_AGENT_ID = actor;
  let status;
  try {
    status = reviewWish(positionals, root, options);
  } finally {
    console.log = realLog;
    console.error = realError;
    if (hadActor) process.env.ATRIS_AGENT_ID = previousActor;
    else delete process.env.ATRIS_AGENT_ID;
  }
  return { status, stdout: out.join('\n'), stderr: err.join('\n') };
}

function twoWishes(root) {
  writeEvents(root, [
    {
      id: 'wish-old',
      n: 1,
      ts: '2026-07-06T10:00:00.000Z',
      text: 'make old thing clearer',
      status: 'delegated',
      dispatched_at: '2026-07-06T10:00:00.000Z',
    },
    {
      id: 'wish-new',
      n: 2,
      ts: '2026-07-06T11:00:00.000Z',
      text: 'make new thing clearer',
      status: 'complete',
      completed_at: '2026-07-06T11:00:00.000Z',
    },
  ]);
}

test('review with no ref saves a record on the newest reviewable wish', () => {
  const root = makeRoot();
  try {
    twoWishes(root);
    const result = run(['review', 'It landed cleanly.'], root);

    assert.strictEqual(result.status, 0);
    assert.strictEqual(
      result.stdout,
      'Review saved for "make new thing clearer". It shapes future runs once distilled into lessons.',
    );
    assert.strictEqual(result.stderr, '');

    const reviews = reviewEvents(root);
    assert.strictEqual(reviews.length, 1);
    assert.strictEqual(reviews[0].wish_id, 'wish-new');
    assert.strictEqual(reviews[0].review_text, 'It landed cleanly.');
    assert.strictEqual(reviews[0].review_score, null);
    assert.strictEqual(reviews[0].reviewed_by, 'tester');
    assert.ok(Number.isFinite(Date.parse(reviews[0].ts)), 'ts is a parseable timestamp');
    assert.strictEqual(readEvents(root).length, 3, 'only one line was appended');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('review skips wishes that are not delegated or complete when picking latest', () => {
  const root = makeRoot();
  try {
    writeEvents(root, [
      {
        id: 'wish-shipped',
        ts: '2026-07-06T09:00:00.000Z',
        text: 'ship the shipped thing',
        status: 'delegated',
        dispatched_at: '2026-07-06T09:00:00.000Z',
      },
      {
        id: 'wish-asking',
        ts: '2026-07-06T12:00:00.000Z',
        text: 'still asking questions',
        status: 'needs_input',
      },
    ]);
    const result = run(['review', 'latest', 'Worked fine.'], root);

    assert.strictEqual(result.status, 0);
    assert.strictEqual(reviewEvents(root)[0].wish_id, 'wish-shipped');
    assert.strictEqual(reviewEvents(root)[0].review_text, 'Worked fine.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('review resolves an explicit target by id, by number, and by hash number', () => {
  const root = makeRoot();
  try {
    twoWishes(root);

    assert.strictEqual(run(['review', 'wish-old', 'Useful but too broad.'], root).status, 0);
    assert.strictEqual(run(['review', '1', 'Second look.'], root).status, 0);
    assert.strictEqual(run(['review', '#2', 'Third look.'], root).status, 0);

    const reviews = reviewEvents(root);
    assert.deepStrictEqual(reviews.map((row) => row.wish_id), ['wish-old', 'wish-old', 'wish-new']);
    assert.deepStrictEqual(
      reviews.map((row) => row.review_text),
      ['Useful but too broad.', 'Second look.', 'Third look.'],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('review joins several words into one sentence and drops blank pieces', () => {
  const root = makeRoot();
  try {
    twoWishes(root);
    const result = run(['review', 'latest', 'It', '  ', 'was', '', 'slow', 'today'], root);

    assert.strictEqual(result.status, 0);
    assert.strictEqual(reviewEvents(root)[0].review_text, 'It was slow today');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('review turns plain words into scores and leaves other sentences unscored', () => {
  const root = makeRoot();
  try {
    twoWishes(root);
    const sentences = ['Great!', '  LOVE   IT. ', 'good', 'meh', 'Wrong.', 'helpful but still slow'];
    for (const sentence of sentences) {
      assert.strictEqual(run(['review', 'wish-new', sentence], root).status, 0);
    }

    assert.deepStrictEqual(
      reviewEvents(root).map((row) => row.review_score),
      [5, 5, 4, 3, 1, null],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an explicit reviewScore option wins over the plain-word score, including zero and negatives', () => {
  const root = makeRoot();
  try {
    twoWishes(root);
    assert.strictEqual(run(['review', 'wish-new', 'great'], root, { reviewScore: 2 }).status, 0);
    assert.strictEqual(run(['review', 'wish-new', 'great'], root, { reviewScore: 0 }).status, 0);
    assert.strictEqual(run(['review', 'wish-new', 'This missed the point.'], root, { reviewScore: -1 }).status, 0);
    assert.strictEqual(run(['review', 'wish-new', 'great'], root, { reviewScore: null }).status, 0);

    assert.deepStrictEqual(
      reviewEvents(root).map((row) => row.review_score),
      [2, 0, -1, 5],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reviewed_by falls back to the operator when no agent id or user is set', () => {
  const root = makeRoot();
  const hadUser = Object.prototype.hasOwnProperty.call(process.env, 'USER');
  const previousUser = process.env.USER;
  try {
    twoWishes(root);
    delete process.env.USER;
    assert.strictEqual(run(['review', 'Fine work.'], root, undefined, null).status, 0);

    assert.strictEqual(reviewEvents(root)[0].reviewed_by, 'operator');
  } finally {
    if (hadUser) process.env.USER = previousUser;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the saved review shows up on the wish when wishes are read back', () => {
  const root = makeRoot();
  try {
    twoWishes(root);
    assert.strictEqual(run(['review', 'wish-old', 'Nice.'], root).status, 0);

    const { readWishes } = require('../lib/wish-store');
    const wishes = readWishes(root);
    const old = wishes.find((wish) => wish.id === 'wish-old');
    const fresh = wishes.find((wish) => wish.id === 'wish-new');
    assert.strictEqual(old.reviewed, true);
    assert.strictEqual(old.review_count, 1);
    assert.strictEqual(old.latest_review.review_text, 'Nice.');
    assert.strictEqual(old.latest_review.review_score, 4);
    assert.strictEqual(fresh.reviewed, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('review without any feedback text exits 2 and writes nothing', () => {
  const root = makeRoot();
  try {
    twoWishes(root);
    const before = fs.readFileSync(path.join(root, STATE_REL), 'utf8');

    const bare = run(['review'], root);
    assert.strictEqual(bare.status, 2);
    assert.strictEqual(bare.stderr, 'wish review needs one sentence of feedback.');
    assert.strictEqual(bare.stdout, '');

    const blank = run(['review', '   ', ''], root);
    assert.strictEqual(blank.status, 2);
    assert.strictEqual(blank.stderr, 'wish review needs one sentence of feedback.');

    const refOnly = run(['review', 'latest'], root);
    assert.strictEqual(refOnly.status, 2);
    assert.strictEqual(refOnly.stderr, 'wish review needs one sentence of feedback.');

    const idOnly = run(['review', 'wish-old'], root);
    assert.strictEqual(idOnly.status, 2);
    assert.strictEqual(idOnly.stderr, 'wish review needs one sentence of feedback.');

    assert.strictEqual(fs.readFileSync(path.join(root, STATE_REL), 'utf8'), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('review on an empty workspace says there is nothing to review', () => {
  const root = makeRoot();
  try {
    const result = run(['review', 'Looks good.'], root);

    assert.strictEqual(result.status, 2);
    assert.strictEqual(result.stderr, 'No wishes to review yet.');
    assert.strictEqual(result.stdout, '');
    assert.strictEqual(fs.existsSync(path.join(root, STATE_REL)), false, 'no state file was created');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('review reports when wishes exist but none is delegated or complete', () => {
  const root = makeRoot();
  try {
    writeEvents(root, [
      { id: 'wish-asking', ts: '2026-07-06T12:00:00.000Z', text: 'still asking', status: 'needs_input' },
    ]);
    const result = run(['review', 'Looks good.'], root);

    assert.strictEqual(result.status, 2);
    assert.strictEqual(result.stderr, 'No delegated or completed wishes to review.');
    assert.strictEqual(reviewEvents(root).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('review with an unknown wish id errors and writes nothing', () => {
  const root = makeRoot();
  try {
    twoWishes(root);
    const result = run(['review', 'wish-missing', 'Looks good.'], root);

    assert.strictEqual(result.status, 2);
    assert.strictEqual(result.stderr, 'No wish found with id wish-missing.');
    assert.strictEqual(reviewEvents(root).length, 0);

    const badNumber = run(['review', '99', 'Looks good.'], root);
    assert.strictEqual(badNumber.status, 2);
    assert.strictEqual(badNumber.stderr, 'No wish found with id 99.');
    assert.strictEqual(reviewEvents(root).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('review falls back to the wish id in the message when the wish has no text', () => {
  const root = makeRoot();
  try {
    writeEvents(root, [
      { id: 'wish-textless', ts: '2026-07-06T10:00:00.000Z', text: '', status: 'delegated' },
    ]);
    const result = run(['review', 'Fine.'], root);

    assert.strictEqual(result.status, 0);
    assert.strictEqual(
      result.stdout,
      'Review saved for "wish-textless". It shapes future runs once distilled into lessons.',
    );
    assert.strictEqual(reviewEvents(root)[0].review_score, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
