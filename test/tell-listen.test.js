'use strict';

// atris tell listen: the open line. Every test talks to a fake server; nothing
// touches the network and nothing really sleeps.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { tellCommand } = require('../commands/tell');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-tell-listen-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const TOKEN = 'secret-tok-9z8y7x6w5v';
const LABS_ID = '5db129d0-aa32-46eb-81ae-29bb86f67b0f';
const WAIT = `/swarlo/${LABS_ID}/inbox/wait?agent_id=agent-walsh-id&timeout=25`;
const REGISTRY = { 'atris-labs': { business_id: LABS_ID, name: 'Atris Labs', slug: 'atris-labs' } };

function home() {
  const dir = fs.mkdtempSync(path.join(scratch, 'home-'));
  fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.atris', 'businesses.json'), JSON.stringify(REGISTRY));
  return dir;
}

const NOTE = { seq: 41, post_id: '6c0b6823', channel: 'general', author_name: 'Keshav', content: 'check the\nsignup page' };

// replies: one entry per wait call, in order.
function harness(replies, { env = {}, rounds = replies.length } = {}) {
  const stdout = [];
  const stderr = [];
  const waits = [];
  const pauses = [];
  let next = 0;
  return {
    stdout, stderr, waits, pauses,
    all: () => stdout.concat(stderr).join('\n'),
    deps: {
      token: TOKEN,
      ensureCredentials: async () => ({ error: 'none' }),
      env: { ATRIS_BUSINESS: 'atris-labs', ...env },
      cwd: fs.mkdtempSync(path.join(scratch, 'cwd-')),
      homeDir: home(),
      rounds,
      sleep: async (ms) => { pauses.push(ms); },
      apiRequestJson: async (pathname, options = {}) => {
        const team = pathname.match(/^\/business\/[^/]+\/team\/([^/]+)$/);
        if (team) {
          return team[1] === 'walsh'
            ? { ok: true, status: 200, data: { agent_id: 'agent-walsh-id', name: 'walsh' } }
            : { ok: false, status: 404, data: { detail: 'Team member not found' } };
        }
        waits.push({ pathname, token: options.token, timeoutMs: options.timeoutMs, retries: options.retries });
        const reply = replies[next];
        next += 1;
        return typeof reply === 'function' ? reply() : reply;
      },
      log: (l) => stdout.push(String(l)),
      err: (l) => stderr.push(String(l)),
    },
  };
}

const ok = (data) => ({ ok: true, status: 200, data });

test('listen prints each note as it lands and waits again from the last number', async () => {
  const h = harness([
    ok({ items: [NOTE], after_seq: 41, ended: 'note' }),
    ok({ items: [], after_seq: 41, ended: 'timeout' }),
    ok({ items: [{ ...NOTE, seq: 42, post_id: 'p2', author_name: 'Arjun', content: 'done' }], after_seq: 42, ended: 'note' }),
  ]);
  const code = await tellCommand(['listen', '--as', 'walsh'], h.deps);
  assert.equal(code, 0, h.all());
  assert.deepEqual(h.stdout, [
    'listening for notes to walsh in atris-labs. ctrl-c to stop',
    'Keshav in #general: check the signup page  (post 6c0b6823)',
    'Arjun in #general: done  (post p2)',
  ]);
  assert.deepEqual(h.waits.map((w) => w.pathname), [WAIT, `${WAIT}&after_seq=41`, `${WAIT}&after_seq=41`]);
  assert.ok(h.waits.every((w) => w.token === TOKEN && w.retries === 0 && w.timeoutMs > 25000));
  assert.deepEqual(h.pauses, []); // a timeout reconnects at once
});

test('listen --json prints one note per line', async () => {
  const h = harness([ok({ items: [NOTE], after_seq: 41, ended: 'note' })]);
  assert.equal(await tellCommand(['listen', '--as', 'walsh', '--json'], h.deps), 0, h.all());
  assert.deepEqual(h.stdout.map((l) => JSON.parse(l)), [NOTE]);
});

test('listen reconnects quietly after network errors with a growing pause', async () => {
  const down = { ok: false, status: 0, data: null, error: 'socket hang up' };
  const h = harness([down, { ok: false, status: 502, data: null }, down, ok({ items: [NOTE], after_seq: 41 }), down]);
  assert.equal(await tellCommand(['listen', '--as', 'walsh'], h.deps), 0, h.all());
  assert.deepEqual(h.pauses, [1000, 2000, 4000, 1000]); // reset once the line came back
  assert.equal(h.stderr.length, 0);
  assert.equal(h.stdout.length, 2);
});

test('listen uses ATRIS_AGENT and stops when no member is named', async () => {
  const h = harness([ok({ items: [], after_seq: 0, ended: 'timeout' })], { env: { ATRIS_AGENT: 'walsh' } });
  assert.equal(await tellCommand(['listen'], h.deps), 0, h.all());
  const none = harness([]);
  assert.equal(await tellCommand(['listen'], none.deps), 1);
  assert.match(none.all(), /say whose notes to listen for/);
  const extra = harness([]);
  assert.equal(await tellCommand(['listen', 'walsh'], extra.deps), 1);
  assert.match(extra.all(), /--as/);
});

test('listen stops plainly on an unknown member, a refusal, a server without the line, or a second listener', async () => {
  const unknown = harness([]);
  assert.equal(await tellCommand(['listen', '--as', 'ghost'], unknown.deps), 1);
  assert.match(unknown.all(), /no member called "ghost" in atris-labs/);
  assert.equal(unknown.waits.length, 0);

  const refused = harness([{ ok: false, status: 404, data: { detail: 'Agent not found.' } }]);
  assert.equal(await tellCommand(['listen', '--as', 'walsh'], refused.deps), 1);
  assert.match(refused.all(), /stopped listening: Agent not found/);

  const old = harness([{ ok: false, status: 404, data: { detail: 'Not Found' } }]);
  assert.equal(await tellCommand(['listen', '--as', 'walsh'], old.deps), 1);
  assert.match(old.all(), /does not have the open line yet/);

  const taken = harness([ok({ items: [], after_seq: 0, ended: 'replaced' })], { rounds: 5 });
  assert.equal(await tellCommand(['listen', '--as', 'walsh'], taken.deps), 1);
  assert.match(taken.all(), /another listener took the line for walsh/);
  assert.equal(taken.waits.length, 1);
  assert.ok(!taken.all().includes(TOKEN));
});

test('help names the listen verb', async () => {
  const h = harness([]);
  await tellCommand(['--help'], h.deps);
  assert.match(h.stdout.join('\n'), /atris tell listen --as <member> +hear each note to that member the moment it is sent/);
});
