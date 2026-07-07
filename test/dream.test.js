'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dream = require('../commands/dream');
const nextMoves = require('../lib/next-moves');
const { nextCommand } = require('../commands/next');
const { DEFAULT_CLAUDE_RUNNER_MODEL } = require('../lib/runner-command');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-dream-'));
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function writeJournal(root, date, text) {
  const year = date.slice(0, 4);
  const dir = path.join(root, 'atris', 'logs', year);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${date}.md`), text, 'utf8');
}

function readDreamRows(root) {
  const file = path.join(root, '.atris', 'state', 'dreams.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function captureDreamCommand(args, root, options) {
  const lines = [];
  const code = await dream.dreamCommand(args, root, {
    ...options,
    log: (line) => lines.push(String(line)),
  });
  return { code, stdout: lines.join('\n') };
}

test('atris dream writes model cards', async () => {
  const root = tmp();
  try {
    writeJournal(root, '2099-01-01', '# Log 2099-01-01\n\n## Completed\n\n- shipped a loop\n');
    const calls = [];
    const response = JSON.stringify([
      { title: 'Check open wishes', why: 'A wish needs a clear next step.', move: 'Open atris next and answer the waiting wish.' },
      { title: 'Review mission proof', why: 'A proof is ready to read.', move: 'Read the latest mission receipt.' },
    ]);
    const result = await captureDreamCommand([], root, {
      stamp: '2099-01-02T00:00:00.000Z',
      runner: async (call) => {
        calls.push(call);
        return { ok: true, stdout: response };
      },
    });

    assert.equal(result.code, 0);
    assert.match(result.stdout, /Dreamed 2 cards\./);
    assert.match(result.stdout, /Run me nightly: atris dream/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, 'claude-haiku-4-5');
    assert.match(calls[0].prompt, /shipped a loop/);

    const rows = readDreamRows(root);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], {
      ts: '2099-01-02T00:00:00.000Z',
      title: 'Check open wishes',
      why: 'A wish needs a clear next step.',
      move: 'Open atris next and answer the waiting wish.',
      source: 'dream',
    });
  } finally {
    cleanup(root);
  }
});

test('next ranker deals and consumes a dream card', () => {
  const root = tmp();
  try {
    const now = new Date().toISOString();
    fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
    fs.writeFileSync(path.join(root, '.atris', 'state', 'dreams.jsonl'), `${JSON.stringify({
      ts: now,
      title: 'Check open wishes',
      why: 'A wish needs a clear next step.',
      move: 'Open atris next and answer the waiting wish.',
      source: 'dream',
    })}\n`, 'utf8');

    const cards = nextMoves.nextCards(root, 3);
    assert.equal(cards[0].source, 'dream');
    assert.equal(cards[0].kind, 'dream');

    const oldLog = console.log;
    const lines = [];
    console.log = (line) => lines.push(String(line));
    try {
      nextCommand([], root);
    } finally {
      console.log = oldLog;
    }

    assert.match(lines.join('\n'), /Check open wishes/);
    const rows = readDreamRows(root);
    assert.equal(rows[0].consumed_reason, 'dealt');
    assert.ok(rows[0].consumed_at);
    assert.equal(nextMoves.nextCards(root, 3).some((card) => card.source === 'dream'), false);
  } finally {
    cleanup(root);
  }
});

test('malformed dream output exits cleanly and leaves a noop row', async () => {
  const root = tmp();
  try {
    writeJournal(root, '2099-01-01', '# Log 2099-01-01\n\n## Notes\n\n- today had work\n');
    const result = await captureDreamCommand([], root, {
      runner: async () => ({ ok: true, stdout: 'not json' }),
    });

    assert.equal(result.code, 0);
    assert.match(result.stdout, /^No dreams tonight: could not read dream cards/m);
    const rows = readDreamRows(root);
    assert.equal(rows.filter((row) => row.source === 'dream').length, 0);
    assert.equal(rows.at(-1).kind, 'dream_noop');
    assert.equal(rows.at(-1).reason, 'could not read dream cards');
  } finally {
    cleanup(root);
  }
});

test('spawn failure retries once and writes a noop row', async () => {
  const root = tmp();
  try {
    writeJournal(root, '2099-01-01', '# Log 2099-01-01\n\n## Notes\n\n- today had work\n');
    const models = [];
    const result = await captureDreamCommand([], root, {
      runner: async (call) => {
        models.push(call.model);
        return { ok: false, error: 'boom' };
      },
    });

    assert.equal(result.code, 0);
    assert.match(result.stdout, /^No dreams tonight: model could not start/m);
    assert.deepEqual(models, ['claude-haiku-4-5', DEFAULT_CLAUDE_RUNNER_MODEL]);
    const rows = readDreamRows(root);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'dream_noop');
    assert.equal(rows[0].reason, 'model could not start');
  } finally {
    cleanup(root);
  }
});
