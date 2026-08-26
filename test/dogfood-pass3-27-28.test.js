'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const { ACCOUNT_GLOBAL_MESSAGE } = require('../lib/account-bound');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const TIMEOUT_MS = 20000;

function makeTempDir(prefix = 'atris-dogfood-27-28-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, env, timeout = TIMEOUT_MS } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout,
    env: {
      ...scrubAgentEnv(),
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ...(env || {}),
    },
  });
  if (result.error && result.error.code === 'ETIMEDOUT') {
    assert.fail(`cli hung past ${timeout}ms (args: ${args.join(' ')})`);
  }
  if (result.error) throw result.error;
  return result;
}

test('27/28: unbound folder refuses inbox/gmail/slack/errors/truth without dumping account data', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.atris', 'heartbeat'), { recursive: true });
  fs.writeFileSync(path.join(home, '.atris', 'heartbeat', 'registry.json'), JSON.stringify({
    jobs: [{ id: 'web-guardian', cadence_minutes: 60 }],
  }));
  fs.writeFileSync(path.join(home, '.atris', 'heartbeat', 'state.json'), JSON.stringify({
    'web-guardian': { last_run: new Date().toISOString(), consecutive_fails: 0 },
  }));
  fs.writeFileSync(path.join(home, '.atris', 'credentials.json'), JSON.stringify({
    token: 'fake-token',
    email: 'dogfood@example.com',
  }));

  try {
    for (const args of [
      ['inbox'],
      ['gmail', 'inbox'],
      ['slack'],
      ['slack', 'channels'],
      ['slack', 'dms'],
      ['errors', '--json'],
      ['truth'],
    ]) {
      const result = runCli(args, {
        cwd: dir,
        env: { HOME: home, ATRIS_HOME: home, ATRIS_NONINTERACTIVE: '1' },
      });
      assert.equal(result.status, 2, `${args.join(' ')} status=${result.status}`);
      const out = `${result.stderr}${result.stdout}`;
      assert.match(out, /account-global; pass --account to continue/);
      assert.doesNotMatch(out, /web-guardian|dogfood@example|Conversations|Channels|payroll|502|Slack commands|Fetching Slack/);
      assert.equal(out.includes(ACCOUNT_GLOBAL_MESSAGE), true);
    }

    const slackHelp = runCli(['slack', '--help'], {
      cwd: dir,
      env: { HOME: home, ATRIS_HOME: home, ATRIS_NONINTERACTIVE: '1' },
    });
    assert.equal(slackHelp.status, 0, slackHelp.stderr + slackHelp.stdout);
    assert.match(slackHelp.stdout, /Slack commands/);
    assert.doesNotMatch(`${slackHelp.stderr}${slackHelp.stdout}`, /account-global|Fetching Slack/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('27: truth reads atris/loops only; --global unlocks machine heartbeats', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(dir, 'atris', 'loops'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'atris', 'loops', 'quality.md'), [
    '# Loop - Quality',
    '',
    '**Owner:** `team/validator`',
    '**Wiki:** [systems/loops.md](../wiki/systems/loops.md)',
    '**Runner:** `node --test`',
    '**Protects:** trust',
    '**Signal (green =):** tests pass',
    '**Cadence:** per commit',
    '',
    '## Log',
    '',
    `- ${new Date().toISOString().slice(0, 10)}: workspace loop only`,
    '',
  ].join('\n'));
  fs.mkdirSync(path.join(home, '.atris', 'heartbeat'), { recursive: true });
  fs.writeFileSync(path.join(home, '.atris', 'heartbeat', 'registry.json'), JSON.stringify({
    jobs: [{ id: 'youtube-watch-feeder', cadence_minutes: 60 }],
  }));
  fs.writeFileSync(path.join(home, '.atris', 'heartbeat', 'state.json'), JSON.stringify({
    'youtube-watch-feeder': { last_run: new Date().toISOString(), consecutive_fails: 0 },
  }));

  try {
    const scoped = runCli(['truth', '--json'], {
      cwd: dir,
      env: { HOME: home, ATRIS_HOME: home },
    });
    assert.equal(scoped.status, 0, scoped.stderr + scoped.stdout);
    const scopedBody = JSON.parse(scoped.stdout);
    assert.equal(scopedBody.scope.kind, 'workspace');
    const scopedIds = (scopedBody.loop_rows || []).map((row) => row.id);
    assert.ok(scopedIds.includes('quality'), `expected quality loop, got ${scopedIds}`);
    assert.ok(!scopedIds.includes('youtube-watch-feeder'), 'machine loop leaked into workspace truth');

    const global = runCli(['truth', '--global', '--json'], {
      cwd: dir,
      env: { HOME: home, ATRIS_HOME: home },
    });
    assert.equal(global.status, 0, global.stderr + global.stdout);
    const globalBody = JSON.parse(global.stdout);
    const globalIds = (globalBody.loop_rows || []).map((row) => row.id);
    assert.ok(globalIds.includes('youtube-watch-feeder'), `expected machine loop, got ${globalIds}`);
  } finally {
    cleanupTempDir(dir);
  }
});

test('27: study has no hardcoded personal path and says not installed', () => {
  const studySrc = fs.readFileSync(path.join(repoRoot, 'commands', 'study.js'), 'utf8');
  assert.doesNotMatch(studySrc, /\/Users\/keshavrao/);

  const dir = makeTempDir();
  try {
    const result = runCli(['study', 'spanish'], { cwd: dir });
    assert.equal(result.status, 2);
    assert.match(`${result.stderr}${result.stdout}`, /not installed/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('28: errors defaults to local and does not dump cloud json', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'business.json'), JSON.stringify({
      business_id: 'biz_dogfood',
      slug: 'dogfood-co',
    }));

    const result = runCli(['errors', '--json'], { cwd: dir });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const body = JSON.parse(result.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.scope, 'local');
    assert.doesNotMatch(result.stdout, /business_id|502|uuid/i);
  } finally {
    cleanupTempDir(dir);
  }
});

test('28: twitter post and slack send require --approved', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'business.json'), JSON.stringify({
      business_id: 'biz_dogfood',
      slug: 'dogfood-co',
    }));

    const twitter = runCli(['twitter', 'post', 'hello world'], { cwd: dir });
    assert.equal(twitter.status, 2);
    assert.match(`${twitter.stderr}${twitter.stdout}`, /--approved/);

    const slack = runCli(['slack', 'send', '#general', 'hello'], { cwd: dir });
    assert.equal(slack.status, 2);
    assert.match(`${slack.stderr}${slack.stdout}`, /--approved/);

    const help = runCli(['twitter'], { cwd: dir });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /--approved/);
  } finally {
    cleanupTempDir(dir);
  }
});
