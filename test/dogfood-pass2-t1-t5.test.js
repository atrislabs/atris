'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const { formatCliVersionLine, inspectInstallGitState } = require('../utils/update-check');
const { requireAccountBound, ACCOUNT_GLOBAL_MESSAGE } = require('../lib/account-bound');
const { collectSearchResults } = require('../commands/search');
const { isAtrisCliRepo } = require('../commands/bench');
const { printUsage } = require('../commands/spaceship');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const spaceshipScript = path.join(repoRoot, 'scripts', 'spaceship.sh');
const TIMEOUT_MS = 20000;

function makeTempDir(prefix = 'atris-dogfood-t1t5-') {
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

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

test('T1: unbound folder refuses account verbs without --account', () => {
  const dir = makeTempDir();
  try {
    for (const args of [
      ['business', 'list'],
      ['rainmaker'],
      ['avail'],
      ['feedback'],
      ['agent'],
    ]) {
      const result = runCli(args, { cwd: dir });
      assert.equal(result.status, 2, `${args.join(' ')} status`);
      assert.match(`${result.stderr}${result.stdout}`, /account-global; pass --account to continue/);
    }

    const help = runCli(['business', '--help'], { cwd: dir });
    assert.equal(help.status, 0);
    assert.doesNotMatch(`${help.stderr}${help.stdout}`, /account-global/);

    const gated = requireAccountBound(['list'], { cwd: dir });
    assert.equal(gated.ok, false);
    assert.equal(gated.message, ACCOUNT_GLOBAL_MESSAGE);

    fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.atris', 'business.json'), JSON.stringify({ slug: 'demo' }));
    const bound = requireAccountBound(['list'], { cwd: dir });
    assert.equal(bound.ok, true);
    assert.equal(bound.bound, true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('a provisioned agent workspace with a placed key is bound without business.json', () => {
  const dir = makeTempDir();
  try {
    const gated = requireAccountBound(['list'], { cwd: dir });
    assert.equal(gated.ok, false);

    fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.atris', 'agent-token.json'),
      JSON.stringify({ token: 't', expires_at: new Date(Date.now() + 60_000).toISOString(), scopes: ['gmail-read'] })
    );
    const bound = requireAccountBound(['list'], { cwd: dir });
    assert.equal(bound.ok, true);
    assert.equal(bound.bound, true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('T1: teach reads ./atris/teach only', () => {
  const dir = makeTempDir();
  try {
    const missing = runCli(['teach'], { cwd: dir });
    assert.equal(missing.status, 0);
    assert.match(missing.stdout, /no atris\/teach folder/);

    fs.mkdirSync(path.join(dir, 'atris', 'teach'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'teach', 'bad-turn.md'), '# bad turn\nrequire proof\n');
    const listed = runCli(['teach'], { cwd: dir });
    assert.equal(listed.status, 0);
    assert.match(listed.stdout, /bad-turn/);

    const shown = runCli(['teach', 'bad-turn'], { cwd: dir });
    assert.equal(shown.status, 0);
    assert.match(shown.stdout, /require proof/);

    const backend = runCli(['teach', 'add', '--id', 'x'], { cwd: dir });
    assert.equal(backend.status, 2);
    assert.match(`${backend.stderr}${backend.stdout}`, /only reads/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('T1: who and founder default to this workspace', () => {
  const dir = makeTempDir();
  try {
    git(dir, ['init', '-b', 'main', '-q']);
    git(dir, ['config', 'user.email', 't@t.com']);
    git(dir, ['config', 'user.name', 't']);
    fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
    git(dir, ['add', 'seed.txt']);
    git(dir, ['commit', '-qm', 'seed']);
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const who = runCli(['who', '--json'], { cwd: dir });
    assert.equal(who.status, 0, who.stderr);
    const presence = JSON.parse(who.stdout);
    assert.equal(presence.scope, 'workspace');

    const founder = runCli(['founder'], { cwd: dir });
    assert.equal(founder.status, 0, founder.stderr);
    assert.match(founder.stdout, /1 project|0 projects/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('T2: dirty git checkout version line and doctor warning', () => {
  const dir = makeTempDir();
  try {
    git(dir, ['init', '-b', 'main', '-q']);
    git(dir, ['config', 'user.email', 't@t.com']);
    git(dir, ['config', 'user.name', 't']);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'atris', version: '9.9.9' }));
    git(dir, ['add', 'package.json']);
    git(dir, ['commit', '-qm', 'seed']);
    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'x\n');

    const state = inspectInstallGitState(dir);
    assert.equal(state.dirty, true);
    const line = formatCliVersionLine('9.9.9', dir);
    assert.match(line, /^atris v9\.9\.9 \(git [0-9a-f]+ dirty main\)$/);

    const sealed = makeTempDir('atris-sealed-');
    try {
      fs.writeFileSync(path.join(sealed, 'package.json'), JSON.stringify({ name: 'atris', version: '9.9.9' }));
      assert.equal(formatCliVersionLine('9.9.9', sealed), 'atris v9.9.9');
    } finally {
      cleanupTempDir(sealed);
    }

    const doctor = runCli(['doctor', '--json'], { cwd: repoRoot });
    assert.equal(doctor.status, 0, doctor.stderr);
    const payload = JSON.parse(doctor.stdout);
    assert.ok(Array.isArray(payload.warnings));
    assert.ok(payload.version_line.includes('git'));
    if (inspectInstallGitState(repoRoot).dirty) {
      assert.ok(payload.warnings.some((w) => /dirty git checkout/.test(w)));
    }
  } finally {
    cleanupTempDir(dir);
  }
});

test('T3: search hits source + MAP; --memory-only keeps old path', () => {
  const full = collectSearchResults(repoRoot, 'benchCommand', { memoryOnly: false });
  assert.ok(full.layers.source);
  assert.ok(full.layers.map);
  assert.ok((full.layers.source.lineHits || []).length > 0);

  const memory = collectSearchResults(repoRoot, 'benchCommand', { memoryOnly: true });
  assert.equal(memory.layers.source, undefined);
  assert.equal(memory.layers.map, undefined);

  const cli = runCli(['search', 'benchCommand'], { cwd: repoRoot, timeout: 60000 });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /Source:/);
  assert.match(cli.stdout, /Map:/);
  assert.doesNotMatch(cli.stdout, /Source: none/);

  const memOnly = runCli(['search', 'benchCommand', '--memory-only'], { cwd: repoRoot, timeout: 60000 });
  assert.equal(memOnly.status, 0, memOnly.stderr);
  assert.doesNotMatch(memOnly.stdout, /^Source:/m);
  assert.doesNotMatch(memOnly.stdout, /^Map:/m);
});

test('T4: spaceship --help prints short usage, not script dump', () => {
  const logs = [];
  const original = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    printUsage();
  } finally {
    console.log = original;
  }
  const usage = logs.join('\n');
  assert.match(usage, /Usage: atris spaceship/);
  assert.match(usage, /Keep working here for a few hours/);
  assert.doesNotMatch(usage, /survives bad ticks|SES|spaceship_update\.py|BACKEND_DEFAULT/i);

  const cli = runCli(['spaceship', '--help'], { cwd: repoRoot });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /Usage: atris spaceship/);
  assert.doesNotMatch(cli.stdout, /SES helper|spaceship_update\.py/);

  const script = spawnSync('bash', [spaceshipScript, '--help'], { encoding: 'utf8' });
  assert.equal(script.status, 0, script.stderr);
  assert.match(script.stdout, /Usage: spaceship\.sh/);
  assert.doesNotMatch(script.stdout, /SES helper|spaceship_update\.py/);
});

test('T5: bench refuses outside the CLI repo unless --here', () => {
  assert.equal(isAtrisCliRepo(repoRoot), true);
  const dir = makeTempDir();
  try {
    assert.equal(isAtrisCliRepo(dir), false);
    const refused = runCli(['bench', 'packs'], { cwd: dir });
    assert.equal(refused.status, 2);
    assert.match(`${refused.stderr}${refused.stdout}`, /refuse outside the atris cli repo/);

    const allowed = runCli(['bench', 'packs', '--here'], { cwd: dir });
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.match(allowed.stdout, /core-v1/);

    const here = runCli(['bench', 'packs'], { cwd: repoRoot });
    assert.equal(here.status, 0, here.stderr);
    assert.match(here.stdout, /core-v1/);
  } finally {
    cleanupTempDir(dir);
  }
});
