'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function withMission(humanAsks, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-answer-human-ask-'));
  const previousCwd = process.cwd();
  const savedEnv = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => key === 'HOME' || key.startsWith('ATRIS_')));
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = root;
    process.chdir(root);
    const state = path.join(root, '.atris', 'state');
    fs.mkdirSync(state, { recursive: true });
    const ledger = path.join(state, 'missions.jsonl');
    const mission = {
      id: 'mission-answer-fixture',
      objective: 'Review the proposed change',
      status: 'paused',
      created_at: '2024-01-02T03:04:05.000Z',
      updated_at: '2024-01-02T03:04:05.000Z',
      human_asks: humanAsks,
    };
    fs.writeFileSync(ledger, `${JSON.stringify(mission)}\n`);
    const { answerMissionHumanAsk } = require('../commands/mission');
    run({ answerMissionHumanAsk, mission, ledger,
      events: path.join(state, 'mission_events.jsonl') });
  } finally {
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) {
      if (key === 'HOME' || key.startsWith('ATRIS_')) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function readRows(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
}

test('answers the selected ask and persists the answer and event', () => {
  const other = { text: 'Keep the draft?', answered_at: null };
  withMission([{ text: 'Publish it?', category: 'approval' }, other],
    ({ answerMissionHumanAsk, mission, ledger, events }) => {
      const result = answerMissionHumanAsk(mission.id, 0, 'YES', '  Approved for review.  ');
      assert.strictEqual(result.id, mission.id);
      assert.strictEqual(result.status, 'paused');
      assert.strictEqual(result.human_asks[0].answer, 'yes');
      assert.strictEqual(result.human_asks[0].note, 'Approved for review.');
      assert.strictEqual(result.human_asks[0].category, 'approval');
      // Check the timestamp shape only, never its relationship to the clock.
      assert.match(result.human_asks[0].answered_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.deepStrictEqual(result.human_asks[1], other);
      const rows = readRows(ledger);
      assert.strictEqual(rows.length, 2);
      assert.deepStrictEqual(rows[1], result);
      const eventRows = readRows(events);
      assert.strictEqual(eventRows.length, 1);
      assert.strictEqual(eventRows[0].type, 'mission_human_ask_answered');
      assert.strictEqual(eventRows[0].mission_id, mission.id);
      assert.deepStrictEqual(eventRows[0].payload, {
        ask_index: 0, text: 'Publish it?', answer: 'yes', note: 'Approved for review.',
      });
    });
});

test('normalizes a legacy string ask and defaults the note for a no answer', () => {
  withMission(['Proceed?'], ({ answerMissionHumanAsk, mission, ledger }) => {
    const result = answerMissionHumanAsk(mission.id, 0, 'no');
    assert.deepStrictEqual(result.human_asks, [{
      text: 'Proceed?', answered_at: result.human_asks[0].answered_at,
      answer: 'no', note: '',
    }]);
    assert.strictEqual(typeof result.human_asks[0].answered_at, 'string');
    assert.deepStrictEqual(readRows(ledger).at(-1).human_asks, result.human_asks);
    const saved = fs.readFileSync(ledger, 'utf8');
    assert.throws(() => answerMissionHumanAsk(mission.id, 0, 'yes'),
      { message: 'human ask is already answered' });
    assert.strictEqual(fs.readFileSync(ledger, 'utf8'), saved);
  });
});

test('rejects empty asks, invalid indices and invalid answers without saving', () => {
  withMission(['Proceed?', '   ', null], ({ answerMissionHumanAsk, mission, ledger, events }) => {
    const original = fs.readFileSync(ledger, 'utf8');
    for (const answer of ['', undefined, 'maybe', ' yes ']) {
      assert.throws(() => answerMissionHumanAsk(mission.id, 0, answer),
        { message: 'human ask answer must be yes or no' });
    }
    for (const index of [-1, 1, 2, 3]) {
      assert.throws(() => answerMissionHumanAsk(mission.id, index, 'yes'),
        { message: `human ask not found at index ${index}` });
    }
    assert.strictEqual(fs.readFileSync(ledger, 'utf8'), original);
    assert.strictEqual(fs.existsSync(events), false);
  });
});
