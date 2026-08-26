'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const {
  ACCOUNT_GLOBAL_MESSAGE,
  looksLikeBusinessSlug,
} = require('../lib/account-bound');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const TIMEOUT_MS = 20000;

function makeTempDir(prefix = 'atris-unbound-live-') {
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
      ATRIS_NO_INTERACTIVE: '1',
      ATRIS_NONINTERACTIVE: '1',
      ...(env || {}),
    },
  });
  if (result.error && result.error.code === 'ETIMEDOUT') {
    assert.fail(`cli hung past ${timeout}ms (args: ${args.join(' ')})`);
  }
  if (result.error) throw result.error;
  return result;
}

function deadApiEnv(home) {
  return {
    HOME: home,
    ATRIS_HOME: home,
    ATRIS_API_URL: 'http://127.0.0.1:9',
    ATRIS_API_BASE_URL: 'http://127.0.0.1:9',
  };
}

test('looksLikeBusinessSlug refuses flags that used to parse as slugs', () => {
  assert.equal(looksLikeBusinessSlug('--json'), false);
  assert.equal(looksLikeBusinessSlug('--help'), false);
  assert.equal(looksLikeBusinessSlug('-h'), false);
  assert.equal(looksLikeBusinessSlug('json'), true);
  assert.equal(looksLikeBusinessSlug('demo-co'), true);
  assert.equal(looksLikeBusinessSlug(''), false);
});

test('31: unbound live writes refuse without --account and do not network', () => {
  const dir = makeTempDir();
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.atris'), { recursive: true });
  fs.writeFileSync(path.join(home, '.atris', 'credentials.json'), JSON.stringify({
    token: 'test-token',
    email: 'dogfood@example.com',
  }));
  const env = deadApiEnv(home);

  try {
    const ship = runCli(['business', 'ship', 'A neighborhood coffee cart'], { cwd: dir, env });
    assert.equal(ship.status, 2, ship.stdout + ship.stderr);
    assert.match(`${ship.stderr}${ship.stdout}`, /account-global; pass --account to continue/);
    assert.equal(`${ship.stderr}${ship.stdout}`.includes(ACCOUNT_GLOBAL_MESSAGE), true);
    assert.doesNotMatch(`${ship.stderr}${ship.stdout}`, /Shipping business|ECONNREFUSED/);

    const shipYes = runCli(['business', 'ship', 'A neighborhood coffee cart', '--yes'], {
      cwd: dir,
      env,
    });
    assert.equal(shipYes.status, 2, shipYes.stdout + shipYes.stderr);
    assert.match(`${shipYes.stderr}${shipYes.stdout}`, /account-global; pass --account to continue/);
    assert.doesNotMatch(`${shipYes.stderr}${shipYes.stdout}`, /Shipping business|ECONNREFUSED/);

    const shipAccount = runCli(['business', 'ship', 'A neighborhood coffee cart', '--account'], {
      cwd: dir,
      env,
    });
    assert.equal(shipAccount.status, 2, shipAccount.stdout + shipAccount.stderr);
    assert.match(`${shipAccount.stderr}${shipAccount.stdout}`, /Pass --yes to create a live business/);
    assert.doesNotMatch(`${shipAccount.stderr}${shipAccount.stdout}`, /Shipping business|ECONNREFUSED/);

    const terminal = runCli(['terminal', '--json'], { cwd: dir, env });
    assert.equal(terminal.status, 2, terminal.stdout + terminal.stderr);
    const terminalBody = JSON.parse(terminal.stdout);
    assert.equal(terminalBody.ok, false);
    assert.match(String(terminalBody.usage || ''), /atris terminal/);
    assert.doesNotMatch(terminal.stdout + terminal.stderr, /Waking EC2|ECONNREFUSED|--json not found/);

    const fleetJson = runCli(['fleet-report', '--json'], { cwd: dir, env });
    assert.equal(fleetJson.status, 2, fleetJson.stdout + fleetJson.stderr);
    const fleetBody = JSON.parse(fleetJson.stdout);
    assert.equal(fleetBody.ok, false);
    assert.match(String(fleetBody.usage || ''), /atris fleet-report/);
    assert.doesNotMatch(
      fleetJson.stdout + fleetJson.stderr,
      /Not logged in|ECONNREFUSED|Fleet daily report|--json not found/,
    );

    const fleetHelp = runCli(['fleet-report', '--help'], { cwd: dir, env });
    assert.equal(fleetHelp.status, 2, fleetHelp.stdout + fleetHelp.stderr);
    assert.match(fleetHelp.stdout + fleetHelp.stderr, /Usage: atris fleet-report/);
    assert.doesNotMatch(fleetHelp.stdout + fleetHelp.stderr, /Not logged in|ECONNREFUSED|Fleet daily report/);

    fs.mkdirSync(path.join(dir, 'dist'));
    fs.writeFileSync(path.join(dir, 'dist', 'index.html'), '<h1>demo</h1>');

    const site = runCli(['site', 'deploy', 'dist', '--name', 'demo-site'], { cwd: dir, env });
    assert.equal(site.status, 2, site.stdout + site.stderr);
    assert.match(`${site.stderr}${site.stdout}`, /account-global; pass --account to continue/);
    assert.doesNotMatch(`${site.stderr}${site.stdout}`, /deploying|ECONNREFUSED|live at/);

    const siteYes = runCli(['site', 'deploy', 'dist', '--name', 'demo-site', '--yes'], {
      cwd: dir,
      env,
    });
    assert.equal(siteYes.status, 2, siteYes.stdout + siteYes.stderr);
    assert.match(`${siteYes.stderr}${siteYes.stdout}`, /account-global; pass --account to continue/);
    assert.doesNotMatch(`${siteYes.stderr}${siteYes.stdout}`, /deploying|ECONNREFUSED|live at/);

    const siteAccount = runCli(['site', 'deploy', 'dist', '--name', 'demo-site', '--account'], {
      cwd: dir,
      env,
    });
    assert.equal(siteAccount.status, 2, siteAccount.stdout + siteAccount.stderr);
    assert.match(`${siteAccount.stderr}${siteAccount.stdout}`, /Pass --yes to publish/);
    assert.doesNotMatch(`${siteAccount.stderr}${siteAccount.stdout}`, /deploying|ECONNREFUSED|live at/);
  } finally {
    cleanupTempDir(dir);
  }
});
