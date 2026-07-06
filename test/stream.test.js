'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  collectStreamEvents,
  createStreamState,
  parseSince,
  pollStreamOnce,
  renderJsonLine,
  renderRecords,
  renderTextLine,
} = require('../commands/stream');

const ULID_RE = /\b[0-9A-HJKMNP-TV-Z]{20,26}\b/;

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, value) {
  mkdirp(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeJsonl(file, rows) {
  mkdirp(path.dirname(file));
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-stream-test-'));
  const stateDir = path.join(root, '.atris', 'state');
  const runsDir = path.join(root, 'atris', 'runs');
  mkdirp(stateDir);
  mkdirp(runsDir);

  writeJson(path.join(stateDir, 'tasks.projection.json'), {
    schema: 'atris.tasks_projection.v1',
    generated_at: '2026-07-06T08:06:30.000Z',
    tasks: [
      {
        id: '01JZ9Q8W7E6R5T4Y3U2I1O0PAS',
        display_id: 'CLI-899',
        title: 'stream command 01JZ9Q8W7E6R5T4Y3U2I1O0PAS',
        status: 'review',
        claimed_by: 'codex',
        updated_at: Date.parse('2026-07-06T08:03:00.000Z'),
        events: [
          {
            event_id: '01JZ9Q8W7E6R5T4Y3U2I1O0PAA',
            actor: 'codex',
            event_type: 'claimed',
            created_at: Date.parse('2026-07-06T08:00:00.000Z'),
            payload: { title: 'stream command' },
          },
          {
            event_id: '01JZ9Q8W7E6R5T4Y3U2I1O0PAB',
            actor: 'validator',
            event_type: 'revision_requested',
            created_at: Date.parse('2026-07-06T08:03:00.000Z'),
            payload: { lesson: 'proof missing at /tmp/private/proof.json' },
          },
        ],
      },
    ],
  });

  writeJsonl(path.join(stateDir, 'mission_events.jsonl'), [
    {
      type: 'mission_started',
      at: '2026-07-06T08:01:00.000Z',
      actor: 'codex',
      payload: { objective: 'watch team work live' },
    },
  ]);

  writeJsonl(path.join(stateDir, 'missions.jsonl'), [
    {
      id: 'mission-watch-team-live-01JZ9Q8W7E6R5T4Y3U2I1O0PAC',
      owner: 'codex',
      status: 'running',
      objective: 'watch team work live',
      created_at: '2026-07-06T08:01:00.000Z',
      last_tick_at: '2026-07-06T08:05:00.000Z',
    },
  ]);

  writeJsonl(path.join(stateDir, 'scorecards.jsonl'), [
    {
      schema: 'atris.improve_scorecard.v1',
      ts: '2026-07-06T08:02:00.000Z',
      member: 'codex',
      reward: 1,
      verify_passed: true,
      what_shipped: 'building the wish command',
    },
  ]);

  writeJsonl(path.join(stateDir, 'task_episodes.jsonl'), [
    {
      schema: 'atris.task_episode.v1',
      episode_id: '01JZ9Q8W7E6R5T4Y3U2I1O0PAD',
      created_at: '2026-07-06T08:04:00.000Z',
      state: { title: 'stream command', status: 'review', claimed_by: 'codex' },
      action: { event_type: 'reviewed', actor: 'validator' },
      reward: { value: 1 },
      lesson: 'proof is now clear',
    },
  ]);

  writeJson(path.join(runsDir, 'mission-watch-team-live-2026-07-06T08-06-00.json'), {
    schema: 'atris.mission_receipt.v1',
    mission_id: 'mission-watch-team-live-01JZ9Q8W7E6R5T4Y3U2I1O0PAC',
    objective: 'watch team work live',
    owner: 'codex',
    at: '2026-07-06T08:06:00.000Z',
    result: {
      kind: 'mission_run_tick',
      tick: {
        status: 'ran',
        summary: 'finished building stream; tests green',
        verifier_passed: true,
        started_at: '2026-07-06T08:05:30.000Z',
        finished_at: '2026-07-06T08:06:00.000Z',
      },
    },
  });

  return root;
}

test('collectStreamEvents merges sources in chronological order', () => {
  const root = fixtureRoot();
  const events = collectStreamEvents({
    root,
    sinceMs: Date.parse('2026-07-06T07:59:00.000Z'),
    nowMs: Date.parse('2026-07-06T08:06:30.000Z'),
  });

  assert.ok(events.length >= 6);
  assert.deepEqual(events.map((event) => event.ms), events.map((event) => event.ms).sort((a, b) => a - b));
  assert.match(events[0].summary, /started stream command/);
  assert.match(events.at(-1).summary, /tests green/);
});

test('agent filter keeps one agent stream', () => {
  const root = fixtureRoot();
  const events = collectStreamEvents({
    root,
    agent: 'validator',
    sinceMs: Date.parse('2026-07-06T07:59:00.000Z'),
    nowMs: Date.parse('2026-07-06T08:06:30.000Z'),
  });

  assert.ok(events.length >= 2);
  assert.equal(events.every((event) => event.agent === 'validator'), true);
  assert.match(events.map((event) => event.summary).join('\n'), /bounced/);
  assert.match(events.map((event) => event.summary).join('\n'), /validated/);
});

test('NDJSON shape is stable and includes raw source record', () => {
  const root = fixtureRoot();
  const event = collectStreamEvents({
    root,
    sinceMs: Date.parse('2026-07-06T08:05:00.000Z'),
    nowMs: Date.parse('2026-07-06T08:06:30.000Z'),
  }).find((item) => item.event === 'mission_run_tick');

  const row = JSON.parse(renderJsonLine(event));
  assert.deepEqual(Object.keys(row).sort(), ['agent', 'event', 'raw', 'summary', 'ts']);
  assert.equal(row.agent, 'codex');
  assert.equal(row.event, 'mission_run_tick');
  assert.equal(row.raw.schema, 'atris.mission_receipt.v1');
});

test('default rendering hides ULIDs, branch names, and file paths', () => {
  const root = fixtureRoot();
  const events = collectStreamEvents({
    root,
    sinceMs: Date.parse('2026-07-06T07:59:00.000Z'),
    nowMs: Date.parse('2026-07-06T08:06:30.000Z'),
  });
  const output = renderRecords(events, {});

  assert.doesNotMatch(output, ULID_RE);
  assert.doesNotMatch(output, /\/tmp\/private/);
  assert.doesNotMatch(output, /codex\/[A-Za-z0-9._/-]+/);
});

test('--since backfills recent history only', () => {
  const root = fixtureRoot();
  const sinceMs = parseSince('2026-07-06T08:03:30.000Z', Date.parse('2026-07-06T08:06:30.000Z'));
  const events = collectStreamEvents({
    root,
    sinceMs,
    nowMs: Date.parse('2026-07-06T08:06:30.000Z'),
  });
  const text = renderRecords(events, {});

  assert.equal(events.every((event) => event.ms >= sinceMs), true);
  assert.doesNotMatch(text, /proof missing/);
  assert.match(text, /validated stream command/);
  assert.match(text, /tests green/);
  assert.equal(parseSince('1h', Date.parse('2026-07-06T08:06:30.000Z')), Date.parse('2026-07-06T07:06:30.000Z'));
});

test('pollStreamOnce returns one iteration without hanging', () => {
  const root = fixtureRoot();
  const state = createStreamState({
    root,
    sinceMs: Date.parse('2026-07-06T07:59:00.000Z'),
    nowMs: Date.parse('2026-07-06T08:06:30.000Z'),
  });

  const first = pollStreamOnce(state, {
    root,
    sinceMs: Date.parse('2026-07-06T07:59:00.000Z'),
    nowMs: Date.parse('2026-07-06T08:06:30.000Z'),
  });
  const second = pollStreamOnce(state, {
    root,
    sinceMs: Date.parse('2026-07-06T07:59:00.000Z'),
    nowMs: Date.parse('2026-07-06T08:06:30.000Z'),
  });

  assert.ok(first.length > 0);
  assert.equal(second.length, 0);
  assert.match(renderTextLine(first[0]), /^\d{4}-\d{2}-\d{2} /);
});
