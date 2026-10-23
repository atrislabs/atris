'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { handoffYesCards } = require('../lib/yes-lock');

// The text every lock under the handoff seal carries (HANDOFF_SEAL_TEXT in lib/yes-lock.js).
const HANDOFF_TEXT = 'a handed-off job asks before anything goes out or lands on master';

// A state folder in a fresh temp dir, handed to the test and removed after it.
function withStateDir(run) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-cards-'));
  try {
    run(stateDir);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

// One lock record, written where lib/yes-lock.js keeps it.
function writeRecord(stateDir, file, record) {
  fs.mkdirSync(path.join(stateDir, 'yes-locks'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'yes-locks', file), JSON.stringify(record, null, 2));
}

// One held command on a step, asked at a fixed time and not yet answered.
function request(command, hash, extra = {}) {
  return { key: `key-${hash}`, hash, command, asked_at: '2026-10-23T09:00:00.000Z', approved_at: null, used_at: null, ...extra };
}

test('lists one card per waiting held command, with its step and parent job', () => {
  withStateDir(stateDir => {
    writeRecord(stateDir, 'run-1.json', {
      mission_id: 'run-1',
      parent_mission_id: 'job-9',
      locks: [
        { step: 1, text: HANDOFF_TEXT, categories: ['publish'], requests: [request('npm publish', 'aaaa1111')] },
        { step: 2, text: HANDOFF_TEXT, categories: ['send'], requests: [request('atris msg ada hi', 'bbbb2222')] },
      ],
    });

    assert.deepStrictEqual(handoffYesCards(stateDir), [
      { mission_id: 'run-1', parent_mission_id: 'job-9', step: 1, hash: 'aaaa1111', command: 'npm publish', ask: 'a handed-off job wants to npm publish' },
      { mission_id: 'run-1', parent_mission_id: 'job-9', step: 2, hash: 'bbbb2222', command: 'atris msg ada hi', ask: 'a handed-off job wants to atris msg ada hi' },
    ]);
  });
});

test('leaves out answered and used commands, and records that are not handoff runs', () => {
  withStateDir(stateDir => {
    writeRecord(stateDir, 'answered.json', {
      mission_id: 'answered',
      locks: [{ step: 1, text: HANDOFF_TEXT, categories: ['post'], requests: [request('gh pr comment 1', 'cccc3333', { approved_at: '2026-10-23T09:05:00.000Z' })] }],
    });
    writeRecord(stateDir, 'used.json', {
      mission_id: 'used',
      locks: [{ step: 1, text: HANDOFF_TEXT, categories: ['publish'], requests: [request('gh release create v2', 'dddd4444', { approved_at: '2026-10-23T09:05:00.000Z', used_at: '2026-10-23T09:06:00.000Z' })] }],
    });
    writeRecord(stateDir, 'owner.json', {
      mission_id: 'owner',
      locks: [{ step: 1, text: 'publish the release notes', categories: ['publish'], requests: [request('npm publish', 'eeee5555')] }],
    });
    // one lock under the handoff seal and one owner lock: not every lock is the handoff text, so it is skipped
    writeRecord(stateDir, 'mixed.json', {
      mission_id: 'mixed',
      locks: [
        { step: 1, text: HANDOFF_TEXT, categories: ['publish'], requests: [request('npm publish', 'ffff6666')] },
        { step: 2, text: 'publish', categories: ['publish'], requests: [] },
      ],
    });
    writeRecord(stateDir, 'waiting.json', {
      mission_id: 'waiting',
      locks: [{ step: 1, text: HANDOFF_TEXT, categories: ['merge'], requests: [request('git push origin feat', '1111aaaa')] }],
    });

    // only the one waiting card survives, and with no parent_mission_id on the record it reads as null
    assert.deepStrictEqual(handoffYesCards(stateDir), [
      { mission_id: 'waiting', parent_mission_id: null, step: 1, hash: '1111aaaa', command: 'git push origin feat', ask: 'a handed-off job wants to git push origin feat' },
    ]);
  });
});

test('a waiting command with no recorded text still gets a card, with a generic ask', () => {
  withStateDir(stateDir => {
    writeRecord(stateDir, 'bare.json', {
      mission_id: 'bare',
      parent_mission_id: 'job-2',
      locks: [{ step: 3, text: HANDOFF_TEXT, categories: ['deploy'], requests: [{ key: 'key-9999ffff', hash: '9999ffff', asked_at: '2026-10-23T09:00:00.000Z', approved_at: null, used_at: null }] }],
    });

    assert.deepStrictEqual(handoffYesCards(stateDir), [
      { mission_id: 'bare', parent_mission_id: 'job-2', step: 3, hash: '9999ffff', command: null, ask: 'a handed-off job wants to run a held command' },
    ]);
  });
});

test('a missing folder, an empty folder, or unreadable files give an empty list, never a throw', () => {
  withStateDir(stateDir => {
    // no yes-locks folder yet
    assert.deepStrictEqual(handoffYesCards(stateDir), []);
    // a state folder that does not exist at all
    assert.deepStrictEqual(handoffYesCards(path.join(stateDir, 'never-made')), []);

    fs.mkdirSync(path.join(stateDir, 'yes-locks'));
    fs.writeFileSync(path.join(stateDir, 'yes-locks', 'broken.json'), '{not json');
    fs.writeFileSync(path.join(stateDir, 'yes-locks', 'notes.txt'), 'not a lock record');
    writeRecord(stateDir, 'empty.json', { mission_id: 'empty', locks: [] });
    writeRecord(stateDir, 'nameless.json', { locks: [{ step: 1, text: HANDOFF_TEXT, categories: ['publish'], requests: [request('npm publish', 'a1a1a1a1')] }] });

    assert.deepStrictEqual(handoffYesCards(stateDir), []);
  });
});
