'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { hireCommand, hiresCommand, hireLine } = require('../commands/hire');
const { mailCommand, findInbox } = require('../commands/mail');
const { parseArgs, resolveBusiness } = require('../lib/business-target');
const { NOT_LOGGED_IN } = require('../lib/developer-api');
const { knownCommands } = require('../lib/known-commands');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-hire-'));
test.after(() => fs.rmSync(scratchCwd, { recursive: true, force: true }));

const NOW = Date.parse('2026-10-01T15:00:00Z');

function harness(handler, extra = {}) {
  const stdout = [];
  const stderr = [];
  const calls = [];
  return {
    stdout,
    stderr,
    calls,
    deps: {
      token: 'tok',
      findBusiness: () => ({ businessId: 'biz-uuid', name: 'Long Lake' }),
      apiRequestJson: async (pathname, options) => {
        calls.push({ pathname, options });
        return handler(pathname, options);
      },
      now: () => NOW,
      timezone: 'America/Los_Angeles',
      log: (l) => stdout.push(String(l)),
      err: (l) => stderr.push(String(l)),
      ...extra,
    },
  };
}

const HIRE_RESPONSE = {
  created: true,
  member: { agent_id: 'a1', slug: 'maya', name: 'Maya', job: 'Grow the HOA newsletter' },
  inbox: { id: 'i1', address: 'maya@atrismail.com' },
  allowance: { monthly_usd: 50, key_id: 'k1' },
  schedule: { cron: '0 2 * * *', timezone: 'America/Los_Angeles', label: 'every night at 2:00 AM America/Los_Angeles', enabled: true },
  next_run_at: '2026-10-02T09:00:00+00:00',
  outreach: { requested: false, note: null },
};

test('hire, hires, and mail are known commands listed in help', () => {
  for (const cmd of ['hire', 'hires', 'mail']) assert.ok(knownCommands.includes(cmd), cmd);
  const run = spawnSync(process.execPath, [cliPath, 'help', '--all'], {
    cwd: scratchCwd, encoding: 'utf8', env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /hire\s+- Hire an agent in one step/);
  assert.match(run.stdout, /hires\s+- Morning check-in/);
  assert.match(run.stdout, /mail\s+- Your agents' own inboxes/);
});

test('boolean flags never swallow the next word', () => {
  const { flags, pos } = parseArgs(['--outreach', 'Maya', '--job', 'grow it', '--budget=50'], ['outreach']);
  assert.deepEqual(pos, ['Maya']);
  assert.equal(flags.outreach, true);
  assert.equal(flags.job, 'grow it');
  assert.equal(flags.budget, '50');
});

test('atris hire posts one call and prints the hire in plain words', async () => {
  const h = harness(() => ({ ok: true, status: 200, data: HIRE_RESPONSE }));
  const code = await hireCommand(['Maya', '--job', 'Grow the HOA newsletter', '--budget', '50'], h.deps);
  assert.equal(code, 0, h.stderr.join('\n'));
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].pathname, '/business/biz-uuid/hire');
  assert.equal(h.calls[0].options.method, 'POST');
  assert.equal(h.calls[0].options.retries, 0);
  assert.deepEqual(h.calls[0].options.body, {
    name: 'Maya', job: 'Grow the HOA newsletter', outreach: false,
    monthly_allowance_usd: 50, timezone: 'America/Los_Angeles',
  });
  const out = h.stdout.join('\n');
  assert.match(out, /^Hired Maya\./);
  assert.match(out, /Inbox: maya@atrismail\.com/);
  assert.match(out, /Allowance: \$50 a month\. You still approve every purchase\./);
  assert.match(out, /Works every night at 2:00 AM America\/Los_Angeles\. First run in 18 h\./);
  assert.match(out, /Check in each morning: atris hires/);
});

test('atris hire leaves the budget out when not given, so a re-hire keeps it', async () => {
  const h = harness(() => ({ ok: true, status: 200, data: { ...HIRE_RESPONSE, created: false } }));
  await hireCommand(['Maya', '--job', 'x', '--outreach', '--business', 'long-lake'], h.deps);
  assert.equal(h.calls[0].pathname, '/business/long-lake/hire');
  assert.equal('monthly_allowance_usd' in h.calls[0].options.body, false);
  assert.equal(h.calls[0].options.body.outreach, true);
  assert.match(h.stdout.join('\n'), /Maya was already hired\. Same hire, nothing duplicated\./);
});

test('atris hire refuses bad input before calling the backend', async () => {
  for (const args of [[], ['Maya'], ['Maya', '--job', 'x', '--budget', '12.5'], ['Maya', '--job', 'x', '--budget', '5000']]) {
    const h = harness(() => { throw new Error('should not call'); });
    assert.equal(await hireCommand(args, h.deps), 1, args.join(' '));
    assert.equal(h.calls.length, 0);
  }
});

test('atris hire shows the backend reason when the hire fails', async () => {
  const h = harness(() => ({ ok: false, status: 503, data: { detail: 'Could not make an inbox for Maya right now.' } }));
  assert.equal(await hireCommand(['Maya', '--job', 'x'], h.deps), 1);
  assert.match(h.stderr.join('\n'), /Could not hire Maya: Could not make an inbox for Maya right now\./);
});

test('not logged in and no business are plain refusals', async () => {
  const noLogin = harness(() => ({ ok: true }), { token: '', ensureCredentials: async () => ({ error: 'not_logged_in' }) });
  assert.equal(await hiresCommand([], noLogin.deps), 1);
  assert.equal(noLogin.stderr[0], NOT_LOGGED_IN);
  const noBiz = harness(() => ({ ok: true }), { findBusiness: () => null });
  assert.equal(await hiresCommand([], noBiz.deps), 1);
  assert.match(noBiz.stderr[0], /no business here/);
});

test('atris hires prints one plain line per hire', async () => {
  const h = harness(() => ({
    ok: true,
    status: 200,
    data: {
      hires: [
        {
          name: 'Maya', status: 'active', emails_last_24h: { sent: 2, received: 1 },
          allowance: { monthly_usd: 50, spent_this_month_usd: 12.5, left_this_month_usd: 37.5 },
          last_run_at: '2026-10-01T09:00:00+00:00', last_result: 'Drafted 3 newsletter ideas',
          schedule: { enabled: true },
        },
        {
          name: 'Rex', status: 'needs_inbox', emails_last_24h: null,
          allowance: { monthly_usd: 0 }, last_run_at: null, schedule: { enabled: false },
        },
      ],
    },
  }));
  assert.equal(await hiresCommand([], h.deps), 0);
  assert.equal(h.calls[0].pathname, '/business/biz-uuid/hires');
  assert.deepEqual(h.stdout.join('\n').split('\n'), [
    'Maya: sent 2, got 1 emails today · spent $12.50 of $50 · last ran 6 h ago: Drafted 3 newsletter ideas',
    'Rex: paused, no inbox yet · no inbox · asleep, has not run',
  ]);
});

test('atris hires shows each hire its 24h and 7 day scoreboard under its line', async () => {
  const scoreboard = {
    last_24h: { sent: 2, replies: 1, reply_rate: 0.5, bounces: 0, complaints: 0, spend_cents: 0 },
    last_7d: { sent: 14, replies: 3, reply_rate: 0.214, bounces: 1, complaints: 0, spend_cents: 1550 },
    last_action_at: '2026-10-01T13:00:00+00:00',
    capped: false,
  };
  const h = harness(() => ({
    ok: true,
    status: 200,
    data: {
      hires: [{
        name: 'Maya', status: 'active', emails_last_24h: { sent: 2, received: 1 },
        allowance: { monthly_usd: 50, spent_this_month_usd: 12.5 },
        last_run_at: '2026-10-01T09:00:00+00:00', last_result: 'Drafted 3 newsletter ideas',
        schedule: { enabled: true }, scoreboard,
      }],
    },
  }));
  assert.equal(await hiresCommand([], h.deps), 0);
  assert.deepEqual(h.stdout.join('\n').split('\n'), [
    'Maya: sent 2, got 1 emails today · spent $12.50 of $50 · last ran 6 h ago: Drafted 3 newsletter ideas',
    '  last 24h: sent 2, 1 reply (50%), 0 bounced, spent $0 · '
      + 'last 7 days: sent 14, 3 replies (21%), 1 bounced, spent $15.50 · last action 2 h ago',
  ]);
});

test('the scoreboard line leaves out what the backend does not share', () => {
  const { scoreLine } = require('../commands/hire');
  assert.equal(scoreLine(undefined, NOW), '');  // an older backend: no second line
  assert.equal(scoreLine({ last_24h: { sent: null }, last_7d: { sent: null } }, NOW), '');  // no inbox
  const line = scoreLine({
    last_24h: { sent: 0, replies: 0, reply_rate: null, bounces: 0, spend_cents: null },
    last_7d: { sent: 3, replies: 0, reply_rate: 0, bounces: 0, spend_cents: null },
    capped: true,
  }, NOW);
  assert.equal(line, '  last 24h: sent 0, 0 replies, 0 bounced · last 7 days: sent 3, 0 replies (0%), 0 bounced'
    + ' · counts cover only the newest mail');  // someone else's spending key: no spend shown
});

test('the reply percent shows only for a real number', () => {
  const { scoreLine } = require('../commands/hire');
  for (const bad of ['abc', 'NaN', Infinity, -Infinity, {}, [1, 2], '']) {
    const line = scoreLine({ last_24h: { sent: 4, replies: 1, reply_rate: bad, bounces: 0 } }, NOW);
    assert.equal(line, '  last 24h: sent 4, 1 reply, 0 bounced', String(bad));
  }
  assert.equal(scoreLine({ last_24h: { sent: 4, replies: 1, reply_rate: '0.25', bounces: 0 } }, NOW),
    '  last 24h: sent 4, 1 reply (25%), 0 bounced');
});

test('a hire that has not run yet says when it will', () => {
  const line = hireLine({ name: 'Ada', emails_last_24h: { sent: 0, received: 0 }, allowance: {},
    next_run_at: '2026-10-02T09:00:00Z', schedule: { enabled: true } }, NOW);
  assert.equal(line, 'Ada: sent 0, got 0 emails today · first run in 18 h');
});

test('atris hires with nobody hired points at atris hire', async () => {
  const h = harness(() => ({ ok: true, status: 200, data: { hires: [] } }));
  await hiresCommand([], h.deps);
  assert.match(h.stdout[0], /No hires yet\. Start one: atris hire/);
});

// ------------------------------------------------------------------ mail

const INBOXES = [
  { id: 'i1', email_address: 'maya@atrismail.com', display_name: 'Maya' },
  { id: 'i2', email_address: 'rex@atrismail.com', display_name: 'Rex' },
];

function mailHarness(extra = {}, messages = []) {
  return harness((pathname, options) => {
    if (pathname.endsWith('/mail/inboxes')) return { ok: true, status: 200, data: INBOXES };
    if (pathname.includes('/messages?')) return { ok: true, status: 200, data: messages };
    if (pathname.endsWith('/messages/send')) return { ok: true, status: 200, data: { id: 'm9', status: 'sent' } };
    return { ok: false, status: 500, data: { detail: `unexpected ${options.method} ${pathname}` } };
  }, extra);
}

test('an inbox can be named by address, the part before the @, or id', () => {
  assert.equal(findInbox(INBOXES, 'MAYA@atrismail.com').id, 'i1');
  assert.equal(findInbox(INBOXES, 'rex').id, 'i2');
  assert.equal(findInbox(INBOXES, 'i1').id, 'i1');
  assert.equal(findInbox(INBOXES, 'nobody'), null);
});

test('atris mail inboxes lists agent inboxes', async () => {
  const h = mailHarness();
  assert.equal(await mailCommand(['inboxes'], h.deps), 0);
  assert.equal(h.calls[0].pathname, '/business/biz-uuid/mail/inboxes');
  assert.deepEqual(h.stdout, ['maya@atrismail.com  (Maya)\nrex@atrismail.com  (Rex)']);
});

test('atris mail read shows newest messages with the limit passed through', async () => {
  const h = mailHarness({}, [
    { direction: 'inbound', from_address: 'pat@example.com', subject: 'Re: newsletter', body_text: 'Love it', created_at: '2026-10-01T08:00:00Z' },
    { direction: 'outbound', to_addresses: '["pat@example.com"]', subject: 'Newsletter idea', body_text: 'Hi Pat', created_at: '2026-10-01T07:00:00Z' },
  ]);
  assert.equal(await mailCommand(['read', 'maya', '--limit', '5'], h.deps), 0);
  assert.equal(h.calls[1].pathname, '/business/biz-uuid/mail/inboxes/i1/messages?limit=5');
  const out = h.stdout.join('\n');
  assert.match(out, /2026-10-01 08:00 {2}got {3}from pat@example\.com\n {2}Re: newsletter\n {2}Love it/);
  assert.match(out, /2026-10-01 07:00 {2}sent {2}to pat@example\.com/);
});

test('atris mail send asks first and sends nothing on no', async () => {
  const h = mailHarness({ confirm: async () => false });
  const code = await mailCommand(['send', 'maya', '--to', 'pat@example.com', '--subject', 'Hi', '--body', 'Hello Pat'], h.deps);
  assert.equal(code, 1);
  assert.equal(h.calls.some((c) => c.pathname.endsWith('/send')), false);
  assert.match(h.stdout.join('\n'), /From: {4}maya@atrismail\.com\nTo: {6}pat@example\.com/);
  assert.match(h.stdout.join('\n'), /Not sent\./);
});

test('atris mail send --yes sends once with no retry', async () => {
  const h = mailHarness({ confirm: async () => { throw new Error('should not ask'); } });
  const code = await mailCommand(['send', 'maya@atrismail.com', '--to', 'pat@example.com', '--subject', 'Hi', '--body', 'Hello Pat', '--yes'], h.deps);
  assert.equal(code, 0, h.stderr.join('\n'));
  const send = h.calls.find((c) => c.pathname.endsWith('/send'));
  assert.equal(send.pathname, '/business/biz-uuid/mail/inboxes/i1/messages/send');
  assert.equal(send.options.retries, 0);
  assert.deepEqual(send.options.body, { to: 'pat@example.com', subject: 'Hi', text: 'Hello Pat' });
  assert.match(h.stdout.join('\n'), /Sent from maya@atrismail\.com to pat@example\.com\./);
});

test('atris mail send needs every field and a real inbox', async () => {
  const missing = mailHarness();
  assert.equal(await mailCommand(['send', 'maya', '--to', 'pat@example.com', '--yes'], missing.deps), 1);
  assert.match(missing.stderr[0], /send needs --to, --subject, and --body/);
  const unknown = mailHarness();
  assert.equal(await mailCommand(['read', 'ghost'], unknown.deps), 1);
  assert.match(unknown.stderr[0], /No inbox matches "ghost"/);
});

// ------------------------------------------------------------------ send safety

const SEND = ['send', 'maya', '--to', 'pat@example.com', '--subject', 'Hi', '--body', 'Hello Pat'];

test('--yes=false (or any value on --yes) is refused and nothing is sent', async () => {
  for (const flag of ['--yes=false', '--yes=true', '--yes=0', '--dry-run=no']) {
    const h = mailHarness({ confirm: async () => { throw new Error('should not ask'); } });
    assert.equal(await mailCommand([...SEND, flag], h.deps), 1, flag);
    assert.equal(h.calls.length, 0, `${flag} made a request`);
    assert.match(h.stderr[0], /is a switch and takes no value/);
  }
});

test('only a bare --yes skips the question', async () => {
  const asked = [];
  const h = mailHarness({ confirm: async (q) => { asked.push(q); return false; } });
  assert.equal(await mailCommand(SEND, h.deps), 1);
  assert.equal(asked.length, 1);
  assert.equal(h.calls.some((c) => c.pathname.endsWith('/send')), false);
  const y = mailHarness({ confirm: async () => { throw new Error('should not ask'); } });
  assert.equal(await mailCommand([...SEND, '-y'], y.deps), 0, y.stderr.join('\n'));
  assert.equal(y.calls.filter((c) => c.pathname.endsWith('/send')).length, 1);
});

test('unknown flags are refused before any request, on every command', async () => {
  const cases = [
    [mailCommand, [...SEND, '--yes', '--dryrun']],
    [mailCommand, [...SEND, '--yes', '--cc', 'boss@example.com']],
    [mailCommand, ['read', 'maya', '--limt', '5']],
    [mailCommand, ['read', 'maya', '--yes']],
    [mailCommand, ['inboxes', '--to', 'x']],
    [mailCommand, [...SEND, '--yes', '--to', 'other@example.com']],
    [mailCommand, ['send', 'maya', 'oops', '--to', 'pat@example.com', '--subject', 'Hi', '--body', 'x', '--yes']],
    [hireCommand, ['Maya', '--job', 'x', '--budjet', '50']],
    [hireCommand, ['Maya', '--job', 'x', '--outreach=false']],
    [hireCommand, ['Maya', '--job', 'x', '-n']],
    [hiresCommand, ['--all']],
    [hiresCommand, ['extra']],
  ];
  for (const [command, args] of cases) {
    const h = mailHarness({ confirm: async () => true });
    assert.equal(await command(args, h.deps), 1, args.join(' '));
    assert.equal(h.calls.length, 0, `${args.join(' ')} made a request`);
    assert.ok(h.stderr[0], args.join(' '));
  }
});

test('send --dry-run prints the email and sends nothing, even with --yes', async () => {
  const h = mailHarness({ confirm: async () => { throw new Error('should not ask'); } });
  assert.equal(await mailCommand([...SEND, '--yes', '--dry-run'], h.deps), 0, h.stderr.join('\n'));
  assert.equal(h.calls.some((c) => c.options.method === 'POST'), false);
  const out = h.stdout.join('\n');
  assert.match(out, /From: {4}maya@atrismail\.com\nTo: {6}pat@example\.com\nSubject: Hi\n\nHello Pat/);
  assert.match(out, /Dry run: nothing was sent\./);
});

test('a given --business must be valid and never falls back to this folder', async () => {
  for (const args of [['--business'], ['--business', ''], ['--business=  '], ['--business', '--json']]) {
    const h = harness(() => { throw new Error('should not call'); });
    assert.equal(await hiresCommand(args, h.deps), 1, JSON.stringify(args));
    assert.equal(h.calls.length, 0);
    assert.match(h.stderr[0], /--business needs a value/);
  }
  const send = mailHarness();
  assert.equal(await mailCommand([...SEND, '--yes', '--business='], send.deps), 1);
  assert.equal(send.calls.length, 0);
  const hire = harness(() => { throw new Error('should not call'); });
  assert.equal(await hireCommand(['Maya', '--job', 'x', '--business'], hire.deps), 1);
  assert.equal(hire.calls.length, 0);
  // resolveBusiness itself refuses an empty value instead of using the folder.
  const folder = () => ({ businessId: 'folder-biz' });
  assert.deepEqual(resolveBusiness({ business: '' }, { findBusiness: folder }), { error: '--business needs a business slug or id' });
  assert.deepEqual(resolveBusiness({ business: true }, { findBusiness: folder }), { error: '--business needs a business slug or id' });
  assert.deepEqual(resolveBusiness({}, { findBusiness: folder }), { id: 'folder-biz', name: 'this business' });
});
