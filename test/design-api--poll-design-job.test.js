'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-poll-design-job-'));
const savedEnv = {};
for (const name of Object.keys(process.env)) {
  if (name === 'HOME' || name.startsWith('ATRIS_')) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
}
process.env.HOME = home;

const { pollDesignJob } = require('../lib/design-api');

after(() => {
  for (const name of Object.keys(process.env)) {
    if (name === 'HOME' || name.startsWith('ATRIS_')) delete process.env[name];
  }
  Object.assign(process.env, savedEnv);
  fs.rmSync(home, { recursive: true, force: true });
});

test('polls pending jobs in order and returns the completed job', async (t) => {
  t.mock.method(Date, 'now', () => 1700000000000);
  const queued = { status: 'queued' };
  const running = { status: 'running' };
  const completed = { status: 'completed', result: { colors: ['#123456'] } };
  const jobs = [queued, running, completed];
  const events = [];
  let calls = 0;

  const result = await pollDesignJob(async () => {
    assert.ok(calls < jobs.length, 'must stop fetching after completion');
    events.push(['fetch', calls]);
    return jobs[calls++];
  }, {
    intervalMs: 17,
    sleep: async (ms) => { events.push(['sleep', ms]); },
    onTick: (elapsed, job) => { events.push(['tick', elapsed, job]); },
  });

  assert.deepStrictEqual(result, { ok: true, job: completed, timedOut: false });
  assert.strictEqual(result.job, completed);
  assert.strictEqual(calls, 3);
  assert.deepStrictEqual(events, [
    ['fetch', 0], ['tick', 0, queued], ['sleep', 17],
    ['fetch', 1], ['tick', 0, running], ['sleep', 17],
    ['fetch', 2],
  ]);
});

test('terminal jobs return immediately without waiting or ticking', async () => {
  for (const job of [
    { status: 'completed', result: [] },
    { status: 'failed', error: 'extraction failed' },
    { status: 'error' },
    { status: 'completed', error: 'invalid result' },
    { status: 'succeeded' },
    { status: 'COMPLETED' },
  ]) {
    let calls = 0;
    const result = await pollDesignJob(async () => { calls++; return job; }, {
      sleep: async () => { assert.fail('terminal jobs must not wait'); },
      onTick: () => { assert.fail('terminal jobs must not tick'); },
    });
    assert.deepStrictEqual(result, {
      ok: job.status === 'completed' && !job.error,
      job,
      timedOut: false,
    });
    assert.strictEqual(calls, 1);
  }
});

test('empty jobs and jobs without a status return an unsuccessful result', async () => {
  for (const job of [null, undefined, {}, { status: '' }]) {
    const result = await pollDesignJob(async () => job, {
      sleep: async () => { assert.fail('empty jobs must not wait'); },
    });
    assert.deepStrictEqual(result, { ok: false, job, timedOut: false });
  }
});

test('fetch failures propagate to the caller', async () => {
  const error = new Error('job unavailable');
  await assert.rejects(pollDesignJob(async () => { throw error; }),
    (actual) => actual === error);
});
