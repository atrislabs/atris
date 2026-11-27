'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { lostAmount } = require('../lib/feed-plain-words');
const { campaignCommand } = require('../commands/campaign');
const { createMemoryStore, getCampaign } = require('../lib/campaign-store');

const CLI = path.resolve(__dirname, '..', 'bin', 'atris.js');

function tempEnv(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-lost-amount-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = path.join(dir, 'campaigns.db');
  const env = {
    ...process.env,
    ATRIS_CAMPAIGN_DB: db,
    ATRIS_SKIP_UPDATE_CHECK: '1',
    NODE_NO_WARNINGS: '1',
    ATRIS_HUMAN: '1',
  };
  return { dir, db, env };
}

test('lostAmount catches shell-stripped dollar shapes', () => {
  assert.equal(lostAmount('Published compute price is /month per instance'), 'price is /month');
  assert.equal(lostAmount('Approve plan that costs /seat before launch?'), 'that costs /seat');
  assert.equal(lostAmount('Renewal is /yr per student'), 'Renewal is /yr');
  assert.equal(lostAmount('Spend around /hour on GPU compute?'), 'Spend around /hour');
  assert.equal(lostAmount('Charged /mo for the backup tier?'), 'Charged /mo');
  assert.equal(lostAmount('Only /instance for small nodes?'), 'Only /instance');
  assert.equal(lostAmount('Approve ,000 for cloud compute?'), ',000');
  assert.equal(lostAmount('Budget (,500) for ads?'), ',500');
  assert.equal(lostAmount('Quote ",000" from the vendor'), ',000');
  assert.equal(lostAmount('Token cost is bash.075 per 1k'), 'bash.075');
  assert.equal(lostAmount('Rate is zsh.50 per call'), 'zsh.50');
  assert.equal(lostAmount('Rate is -zsh.50 per call'), '-zsh.50');
  assert.equal(lostAmount('Rate is /bin/zsh.50 per call'), '/bin/zsh.50');
  assert.equal(lostAmount('Spend sh.25 per request?'), 'sh.25');
});

test('lostAmount allows preserved dollar amounts and ordinary non-money prose', () => {
  const ok = [
    'Published compute price is $85/month per instance',
    'Approve $1,000 for cloud compute?',
    'Token cost is $0.075 per 1k',
    'Pay 85 dollars per month for the node?',
    'GET /users/me/messages',
    'The readiness check is /health',
    'Report path is /month/summary',
    'Release branch for /day-1',
    '1,000 seats in the school plan',
    'Run it in bash. 25 steps total.',
    'Check scripts/bash.075 or mybash.075',
    'Deploy the landing page to production?',
    '',
    null,
    undefined,
  ];
  for (const sample of ok) {
    assert.equal(lostAmount(sample), '', `unexpected match for ${JSON.stringify(sample)}`);
  }
});

test('campaign ask and campaign event ask_opened refuse shell-eaten amounts with exit 2 and advice', async () => {
  const store = createMemoryStore({ origin: 'laptop' });
  store.append({
    campaign_id: 'cmp-spend',
    type: 'campaign_started',
    actor: 'human:keshav',
    data: { title: 'Spend guard', judge: 'exit 1', budget: 10 },
  });

  const run = async (args) => {
    const out = [];
    const err = [];
    const saved = { log: console.log, error: console.error };
    console.log = (line) => out.push(String(line));
    console.error = (line) => err.push(String(line));
    try {
      const code = await campaignCommand(args, { store, actor: 'builder' });
      return { code, out: out.join('\n'), err: err.join('\n') };
    } finally {
      console.log = saved.log;
      console.error = saved.error;
    }
  };

  for (const [question, hole] of [
    ['Published compute price is /month per instance', 'price is /month'],
    ['Approve ,000 for ads?', ',000'],
    ['Spend bash.075 per request?', 'bash.075'],
    ['Rate is zsh.50 per call?', 'zsh.50'],
    ['Plan costs /seat?', 'costs /seat'],
  ]) {
    const refused = await run(['ask', 'cmp-spend', question]);
    assert.equal(refused.code, 2, question);
    assert.ok(refused.err.includes(hole), `expected hole ${hole} in: ${refused.err}`);
    assert.match(refused.err, /single quotes/i);
    assert.match(refused.err, /85 dollars/i);
  }

  const refusedEvent = await run([
    'event', 'cmp-spend', 'ask_opened', '--data',
    JSON.stringify({ ask_id: 'a-bad', question: 'Published compute price is /month per instance' }),
  ]);
  assert.equal(refusedEvent.code, 2);
  assert.ok(refusedEvent.err.includes('price is /month'), refusedEvent.err);
  assert.equal(getCampaign(store, 'cmp-spend').asks.length, 0);

  const okPrice = await run(['ask', 'cmp-spend', 'Published compute price is $85/month per instance']);
  assert.equal(okPrice.code, 0, okPrice.err);
  const okProse = await run(['ask', 'cmp-spend', 'Allow GET /users/me/messages for 1,000 seats?']);
  assert.equal(okProse.code, 0, okProse.err);
  assert.equal(getCampaign(store, 'cmp-spend').asks.length, 2);
});

test('real zsh double-quote stripping is caught by atris campaign ask while single quotes pass', (t) => {
  const { dir, env } = tempEnv(t);
  const started = spawnSync(
    process.execPath,
    [CLI, 'campaign', 'start', 'Shell ask test', '--judge', 'exit 1', '--budget', '10', '--id', 'cmp-zsh'],
    { cwd: dir, env, encoding: 'utf8' },
  );
  assert.equal(started.status, 0, started.stderr);

  const zshCmd = (script) => spawnSync('/bin/zsh', ['-c', script], { cwd: dir, env, encoding: 'utf8' });
  const bin = `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)}`;

  // Double-quoted $9/month: zsh expands $9 to empty -> "price is /month"
  const strippedUnit = zshCmd(`${bin} campaign ask cmp-zsh "Published compute price is $9/month per instance"`);
  assert.equal(strippedUnit.status, 2, strippedUnit.stdout + strippedUnit.stderr);
  assert.match(strippedUnit.stderr, /price is \/month/);
  assert.match(strippedUnit.stderr, /single quotes/i);

  // Double-quoted $1,000: zsh expands $1 to empty -> ",000"
  const strippedComma = zshCmd(`${bin} campaign ask cmp-zsh "Approve $1,000 for compute?"`);
  assert.equal(strippedComma.status, 2, strippedComma.stdout + strippedComma.stderr);
  assert.match(strippedComma.stderr, /,000/);

  // Double-quoted $0.50: /bin/zsh expands $0 to "/bin/zsh" -> "/bin/zsh.50", bare zsh expands $0 to "zsh" -> "zsh.50"
  const strippedZeroPath = zshCmd(`${bin} campaign ask cmp-zsh "Token price is $0.50 per call?"`);
  assert.equal(strippedZeroPath.status, 2, strippedZeroPath.stdout + strippedZeroPath.stderr);
  assert.match(strippedZeroPath.stderr, /\/bin\/zsh\.50/);

  const strippedZeroBare = spawnSync('zsh', ['-c', `${bin} campaign ask cmp-zsh "Token price is $0.50 per call?"`], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(strippedZeroBare.status, 2, strippedZeroBare.stdout + strippedZeroBare.stderr);
  assert.match(strippedZeroBare.stderr, /zsh\.50/);

  // Single-quoted $85/month survives zsh intact and succeeds.
  const preserved = zshCmd(`${bin} campaign ask cmp-zsh 'Published compute price is $85/month per instance' --json`);
  assert.equal(preserved.status, 0, preserved.stderr);
  const body = JSON.parse(preserved.stdout);
  assert.equal(body.campaign.asks.length, 1);
  assert.equal(body.campaign.asks[0].question, 'Published compute price is $85/month per instance');
});

test('lostAmount avoids false positives on route/endpoint paths and catches bash/zsh stripped shapes', (t) => {
  // False-positive guards: ordinary route/endpoint questions with generic prepositions must pass.
  const safeRoutes = [
    'Should we add a redirect for /month?',
    'Move traffic from /instance to the new endpoint?',
    'Allow unauthenticated access for /student?',
    'Is the route at /day ready to deploy?',
    'Is /hour rate limiting enabled?',
  ];
  for (const sample of safeRoutes) {
    assert.equal(lostAmount(sample), '', `false positive for route question: ${JSON.stringify(sample)}`);
  }

  // Additional stripped shapes from bash and zsh double-quoted strings.
  assert.equal(lostAmount('Budget [,000] for ads?'), ',000');
  assert.equal(lostAmount('Approve 0,000 for cloud compute?'), '0,000');
  assert.equal(lostAmount('Approve 00,000 for cloud compute?'), '00,000');
  assert.equal(lostAmount('Published compute price is 00/month per instance'), 'is 00/month');
  assert.equal(lostAmount('Plan costs 000/yr for the enterprise tier'), 'costs 000/yr');
  assert.equal(lostAmount('Approve .50 per call?'), '.50');
  assert.equal(lostAmount('Token costs .99 per 1k'), '.99');

  // Real /bin/bash and /bin/zsh integration checks.
  const { dir, env } = tempEnv(t);
  const started = spawnSync(
    process.execPath,
    [CLI, 'campaign', 'start', 'Bash and Zsh ask test', '--judge', 'exit 1', '--budget', '10', '--id', 'cmp-shells'],
    { cwd: dir, env, encoding: 'utf8' },
  );
  assert.equal(started.status, 0, started.stderr);

  const bin = `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)}`;
  const bashCmd = (script) => spawnSync('/bin/bash', ['-c', script], { cwd: dir, env, encoding: 'utf8' });
  const zshCmd = (script) => spawnSync('/bin/zsh', ['-c', script], { cwd: dir, env, encoding: 'utf8' });

  for (const [label, res] of [
    ['bash $100/month', bashCmd(`${bin} campaign ask cmp-shells "Published compute price is $100/month per instance"`)],
    ['bash $10,000', bashCmd(`${bin} campaign ask cmp-shells "Approve $10,000 for compute?"`)],
    ['bash $1.50', bashCmd(`${bin} campaign ask cmp-shells "Approve $1.50 per call?"`)],
    ['bash $0.50', bashCmd(`${bin} campaign ask cmp-shells "Token price is $0.50 per call?"`)],
    ['zsh [$1,000]', zshCmd(`${bin} campaign ask cmp-shells "Budget [$1,000] for compute?"`)],
    ['zsh $1.50', zshCmd(`${bin} campaign ask cmp-shells "Approve $1.50 per call?"`)],
  ]) {
    assert.equal(res.status, 2, `${label}: ${res.stdout}${res.stderr}`);
    assert.match(res.stderr, /single quotes/i, `${label}: ${res.stderr}`);
  }

  // Non-money route question succeeds through real shell.
  const routeOk = bashCmd(`${bin} campaign ask cmp-shells "Should we add a redirect for /month?" --json`);
  assert.equal(routeOk.status, 0, routeOk.stderr);
  assert.equal(JSON.parse(routeOk.stdout).ok, true);
});
