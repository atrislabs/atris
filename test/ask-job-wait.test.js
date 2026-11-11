'use strict';

// `atris chat --personal` used to stop at "I understood: ... I'm starting now."
// when the server started a job. These pin the new behavior: wait for the job,
// then print what it found, and say plainly when it cannot.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const api = require('../utils/api');
const auth = require('../utils/auth');
const ask = require('../commands/ask');

const JOB = 'bff7c9d5-8953-5b5f-9660-faa388d99005';
const EXIT = new Error('process exit');

function reply(status, body) {
  return { status, body: Buffer.from(JSON.stringify(body)) };
}

function startedJob(extra = {}) {
  return reply(200, {
    success: true,
    intent: 'mission_start',
    response: "I understood: run date on my computer I'm starting now.",
    card: { mission_id: JOB, state: 'ready', needs: null },
    ...extra,
  });
}

function working(label = 'Working through your request') {
  return reply(200, { task_id: JOB, status: 'in_progress', state: 'working', working_on: label });
}

function done(response, extra = {}) {
  return reply(200, {
    task_id: JOB,
    status: 'completed',
    state: 'done',
    proof: { summary: String(response).slice(0, 40) },
    result: { response },
    ...extra,
  });
}

// Runs one one-shot ask against a scripted server. `steps` are the replies to
// the first POST and then each poll, in order; a function step may throw to
// act like a dropped connection.
async function run(t, steps, { message = 'run date on my computer', capMs, clock } = {}) {
  const calls = [];
  const out = [];
  const err = [];
  let exitCode = null;
  const mocks = [
    t.mock.method(auth, 'ensureValidCredentials', async () => ({ credentials: { token: 'tok' } })),
    t.mock.method(api, 'httpRequest', async (url, options) => {
      calls.push({ url, method: options.method, headers: options.headers });
      const step = steps[Math.min(calls.length - 1, steps.length - 1)];
      return typeof step === 'function' ? step() : step;
    }),
    t.mock.method(process.stdout, 'write', (chunk) => { out.push(String(chunk)); return true; }),
    t.mock.method(console, 'error', (...values) => err.push(values.join(' '))),
    t.mock.method(process, 'exit', (code) => { exitCode = code; throw EXIT; }),
  ];
  const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
  const sleeps = [];
  const wait = {
    sleep: async (ms) => { sleeps.push(ms); if (clock) clock.advance(ms); },
    ...(clock ? { now: clock.now } : {}),
    ...(capMs ? { capMs } : {}),
  };
  try {
    await ask.askAtris([message], wait);
  } catch (error) {
    if (error !== EXIT) throw error;
  } finally {
    // Restore now, not at test end: the test reporter prints through stdout.
    for (const mock of mocks) mock.mock.restore();
    if (ttyDescriptor) Object.defineProperty(process.stdout, 'isTTY', ttyDescriptor);
    else delete process.stdout.isTTY;
  }
  return { calls, out: out.join(''), err: err.join('\n'), exitCode, sleeps };
}

test('a started job is waited on and its answer is printed', async (t) => {
  const r = await run(t, [startedJob(), working(), working(), done('Wed Nov 11 13:29:02 UTC 2026')]);
  assert.equal(r.out, 'Wed Nov 11 13:29:02 UTC 2026\n');
  assert.equal(r.exitCode, null);
  assert.equal(r.calls.filter((c) => c.method === 'POST').length, 1, 'the message is sent exactly once');
  const polls = r.calls.filter((c) => c.method === 'GET');
  assert.equal(polls.length, 3);
  assert.ok(polls.every((c) => c.url.includes(`/atris2/missions/${JOB}`) && c.url.includes('details=true')));
  assert.ok(polls.every((c) => c.headers.Authorization === 'Bearer tok'));
  assert.doesNotMatch(r.out, /I'm starting now/);
});

test('polling slows down but stays sane', async (t) => {
  const r = await run(t, [startedJob(), working(), working(), working(), working(), working(), done('ok')]);
  assert.deepEqual(r.sleeps, [1500, 2000, 2500, 3000, 3000]);
});

test('a job that finished before the first poll prints at once with no wait', async (t) => {
  const r = await run(t, [startedJob({ card: { mission_id: JOB, state: 'working' } }), done('hello')]);
  assert.equal(r.out, 'hello\n');
  assert.deepEqual(r.sleeps, []);
});

test('the full answer beats the shortened proof summary', async (t) => {
  const long = 'line '.repeat(200).trim();
  const r = await run(t, [startedJob(), done(long, { proof: { summary: 'line line' } })]);
  assert.equal(r.out, `${long}\n`);
});

test('the proof summary is used when the full answer is missing', async (t) => {
  const r = await run(t, [startedJob(), reply(200, {
    task_id: JOB, status: 'completed', state: 'done', proof: { summary: 'Created the file.' },
  })]);
  assert.equal(r.out, 'Created the file.\n');
});

test('a finished job with no written answer says so', async (t) => {
  const r = await run(t, [startedJob(), reply(200, { task_id: JOB, status: 'completed', state: 'done' })]);
  assert.match(r.out, /finished, but it did not leave a written answer/);
});

test('a job that failed is reported plainly and exits 1', async (t) => {
  const r = await run(t, [startedJob(), reply(200, {
    task_id: JOB, status: 'failed', state: 'ready', result: { error: 'The model could not be reached.' },
  })]);
  assert.equal(r.out, '');
  assert.match(r.err, /The job did not finish: The model could not be reached\./);
  assert.match(r.err, /Say it a little differently/);
  assert.equal(r.exitCode, 1);
  assert.equal(r.calls.filter((c) => c.method === 'GET').length, 1, 'a failed job is not polled again');
});

test('a stopped job is reported plainly and exits 1', async (t) => {
  const r = await run(t, [startedJob(), reply(200, { task_id: JOB, status: 'cancelled', state: 'stopped' })]);
  assert.match(r.err, /That job was stopped before it finished\./);
  assert.equal(r.exitCode, 1);
});

test('a job that asks a question prints the question, the choices and how to answer', async (t) => {
  const r = await run(t, [startedJob(), reply(200, {
    task_id: JOB, status: 'in_progress', state: 'your_turn',
    needs: { question: 'Delete the old report?', options: ['Yes', 'No'] },
  })]);
  assert.match(r.out, /The job needs your answer: Delete the old report\?/);
  assert.match(r.out, /Choices: Yes, No/);
  assert.match(r.out, /Answer with: atris chat --personal "<your answer>"/);
  assert.equal(r.exitCode, null);
});

test('a job waiting for a computer says so', async (t) => {
  const r = await run(t, [startedJob(), reply(200, {
    task_id: JOB, status: 'pending', state: 'waiting_for_computer', needs: { computer: true },
  })]);
  assert.match(r.out, /waiting for a computer to run on/);
});

test('one dropped connection mid-wait is survived', async (t) => {
  const drop = () => { throw new Error('socket hang up'); };
  const r = await run(t, [startedJob(), working(), drop, done('made it')]);
  assert.equal(r.out, 'made it\n');
  assert.equal(r.exitCode, null);
});

test('a connection that stays down gives up with a way to check later', async (t) => {
  const drop = () => { throw new Error('socket hang up'); };
  const r = await run(t, [startedJob(), working(), drop]);
  assert.match(r.err, /Lost the connection while the job was running\. It may still be working\./);
  assert.match(r.err, /atris chat --personal "how is it going"/);
  assert.equal(r.exitCode, 1);
  assert.equal(r.calls.filter((c) => c.method === 'GET').length, 5, 'one good poll, then four failed ones');
});

test('server errors count as a dropped connection, not a failed job', async (t) => {
  const r = await run(t, [startedJob(), reply(502, { detail: 'bad gateway' })]);
  assert.match(r.err, /Lost the connection/);
  assert.doesNotMatch(r.err, /did not finish/);
});

test('a job that is gone gets one retry, then a plain message', async (t) => {
  const gone = reply(404, { detail: 'Mission not found' });
  const lost = await run(t, [startedJob(), gone]);
  assert.match(lost.err, /I lost track of that job/);
  assert.equal(lost.exitCode, 1);
  assert.equal(lost.calls.filter((c) => c.method === 'GET').length, 2);
});

test('a single 404 right after the start does not end the wait', async (t) => {
  const r = await run(t, [startedJob(), reply(404, { detail: 'Mission not found' }), done('fine')]);
  assert.equal(r.out, 'fine\n');
});

test('an expired sign-in during the wait says to log in again', async (t) => {
  const r = await run(t, [startedJob(), reply(401, { detail: 'expired' })]);
  assert.match(r.err, /Run "atris login"/);
  assert.equal(r.exitCode, 1);
});

test('after the wait cap it prints one plain line and does not hang', async (t) => {
  let nowMs = 0;
  const clock = { now: () => nowMs, advance: (ms) => { nowMs += ms; } };
  const r = await run(t, [startedJob(), working()], { clock });
  assert.equal(r.exitCode, null);
  const lines = r.out.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Still working after 5 minutes, and it keeps running\. Check on it with: atris chat --personal "how is it going"/);
  assert.ok(nowMs >= 5 * 60 * 1000 && nowMs < 5 * 60 * 1000 + 1, `waited exactly the cap, not past it (${nowMs}ms)`);
});

test('a plain answer is printed as before and never polls', async (t) => {
  const r = await run(t, [reply(200, { success: true, intent: 'chat', response: 'You have two meetings.', card: null })]);
  assert.equal(r.out, 'You have two meetings.\n');
  assert.equal(r.calls.length, 1);
});

test('replies that only report on a job do not start a wait', async (t) => {
  for (const intent of ['mission_status', 'mission_stop']) {
    const r = await run(t, [reply(200, {
      success: true, intent, response: 'Stopped. I won\'t do any more work on this.', card: { mission_id: JOB, state: 'stopped' },
    })]);
    assert.match(r.out, /Stopped\./);
    assert.equal(r.calls.length, 1, intent);
  }
});

test('a job that could not be started is not waited on', async (t) => {
  const r = await run(t, [reply(200, {
    success: false, intent: 'mission_start', response: "I couldn't start that work.", card: { mission_id: JOB },
  })]);
  assert.equal(r.out, "I couldn't start that work.\n");
  assert.equal(r.calls.length, 1);
});

test('answering a job that asked a question waits for the rest of it', async (t) => {
  const r = await run(t, [
    reply(200, { success: true, intent: 'mission_answer', response: 'Thanks.', card: { mission_id: JOB, state: 'working' } }),
    done('All cleaned up.'),
  ], { message: 'yes' });
  assert.equal(r.out, 'All cleaned up.\n');
});

test('asking the same thing again says the answer is the earlier one', async (t) => {
  const r = await run(t, [startedJob({ card: { mission_id: JOB, state: 'done' } }), done('Wed Nov 11 13:29:02 UTC 2026')]);
  assert.equal(r.out, 'Wed Nov 11 13:29:02 UTC 2026\n');
  assert.match(r.err, /answer from the last time you asked this/);
  assert.equal(r.exitCode, null);
});

test('readJob maps every state the server reports', () => {
  assert.deepEqual(ask.readJob({ status: 'in_progress', state: 'checking' }).kind, 'working');
  assert.deepEqual(ask.readJob({ status: 'pending', state: 'ready' }).kind, 'working');
  assert.deepEqual(ask.readJob({ status: 'failed', state: 'stopped' }).kind, 'stopped');
  assert.deepEqual(ask.readJob({ status: 'failed', state: 'ready' }).kind, 'failed');
  assert.deepEqual(ask.readJob({ status: 'in_progress', state: 'your_turn', needs: null, next: 'Reconnect it.' }),
    { kind: 'needs', question: 'Reconnect it.', options: [] });
  assert.equal(ask.startedJobId({ intent: 'mission_start', card: { mission_id: '' } }), null);
  assert.equal(ask.startedJobId(null), null);
});
