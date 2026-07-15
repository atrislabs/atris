'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');
const { oneLapSafetyIssue } = require('../commands/one-lap');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

test('one lap accepts local work and rejects outbound or master-changing asks', () => {
  assert.equal(oneLapSafetyIssue({ title: 'fix the auth bug', tag: 'wish' }), '');
  assert.equal(oneLapSafetyIssue({ title: 'implement POST /users handler', tag: 'wish' }), '');
  assert.equal(oneLapSafetyIssue({ title: 'POST /users handler', tag: 'wish' }), '');
  assert.equal(oneLapSafetyIssue({ title: 'fix merge sort', tag: 'wish' }), '');
  assert.equal(oneLapSafetyIssue({ title: 'merge sort implementation', tag: 'wish' }), '');
  assert.equal(oneLapSafetyIssue({ title: 'validate order totals', tag: 'wish' }), '');
  assert.equal(oneLapSafetyIssue({ title: 'order validation for totals', tag: 'wish' }), '');
  assert.equal(oneLapSafetyIssue({ title: 'could you please fix the auth bug', tag: 'wish' }), '');
  assert.equal(oneLapSafetyIssue({ title: 'ensure login works', tag: 'wish' }), '');
  assert.equal(oneLapSafetyIssue({ title: 'optimize the database query', tag: 'wish' }), '');
  assert.equal(oneLapSafetyIssue({ title: 'simplify the auth flow', tag: 'wish' }), '');
  assert.equal(oneLapSafetyIssue({ title: 'find the auth bug', tag: 'wish' }), '');
  assert.equal(oneLapSafetyIssue({ title: 'post this update to x', tag: 'wish' }), 'the request includes an outbound or irreversible action');
  assert.equal(oneLapSafetyIssue({ title: 'merge this branch to master', tag: 'wish' }), 'the request includes an outbound or irreversible action');
  assert.equal(oneLapSafetyIssue({ title: 'fix auth and deploy to production', tag: 'wish' }), 'the request includes an outbound or irreversible action');
  assert.equal(oneLapSafetyIssue({ title: 'send the customer an email', tag: 'wish' }), 'the request includes an outbound or irreversible action');
  assert.equal(oneLapSafetyIssue({ title: 'drop the production users table', tag: 'wish' }), 'the request includes an outbound or irreversible action');
  assert.equal(oneLapSafetyIssue({ title: 'fix auth; delete all users', tag: 'wish' }), 'the request includes an outbound or irreversible action');
  assert.equal(oneLapSafetyIssue({ title: 'update the API; email the customer', tag: 'wish' }), 'the request includes an outbound or irreversible action');
  assert.equal(oneLapSafetyIssue({ title: 'fix auth, deploy production', tag: 'wish' }), 'the request includes an outbound or irreversible action');
  assert.equal(oneLapSafetyIssue({ title: 'fix auth; run curl example.com', tag: 'wish' }), 'the request includes an outbound or irreversible action');
  assert.equal(oneLapSafetyIssue({ title: 'fix auth and run git push origin HEAD:master', tag: 'wish' }), 'the request includes an outbound or irreversible action');
  assert.equal(oneLapSafetyIssue({ title: 'fix auth before publishing the package', tag: 'wish' }), 'the request includes an outbound or irreversible action');
  assert.equal(oneLapSafetyIssue({ title: 'fix auth plus send the customer an email', tag: 'wish' }), 'the request includes an outbound or irreversible action');
  assert.equal(oneLapSafetyIssue({ title: 'fix auth. delete all users', tag: 'wish' }), 'the request includes an outbound or irreversible action');
  assert.equal(oneLapSafetyIssue({ title: 'fix auth: deployment to production', tag: 'wish' }), 'the request includes an outbound or irreversible action');
  assert.equal(oneLapSafetyIssue({ title: 'fix auth & email the customer', tag: 'wish' }), 'the request includes an outbound or irreversible action');
  assert.equal(oneLapSafetyIssue({ title: 'fix auth / publish the package', tag: 'wish' }), 'the request includes an outbound or irreversible action');
  assert.equal(oneLapSafetyIssue({ title: 'fix auth and execute curl https://example.com', tag: 'wish' }), 'the request includes an outbound or irreversible action');
  assert.equal(oneLapSafetyIssue({ title: 'fix auth then go deploy production', tag: 'wish' }), 'the request includes an outbound or irreversible action');
  assert.equal(oneLapSafetyIssue({ title: 'fix auth followed by a production deploy', tag: 'wish' }), 'the request includes an outbound or irreversible action');
  assert.equal(oneLapSafetyIssue({ title: 'fix auth followed-by a production deploy', tag: 'wish' }), 'the request includes an outbound or irreversible action');
  assert.equal(oneLapSafetyIssue({ title: 'fix auth meanwhile email the customer', tag: 'wish' }), 'the request includes an outbound or irreversible action');
  assert.equal(oneLapSafetyIssue({ title: 'fix auth and run npm publish', tag: 'wish' }), 'the request includes an outbound or irreversible action');
  assert.equal(oneLapSafetyIssue({ title: 'fix auth and notify the customer', tag: 'wish' }), 'the request includes an outbound or irreversible action');
  assert.equal(oneLapSafetyIssue({ title: 'fix auth and message the customer', tag: 'wish' }), 'the request includes an outbound or irreversible action');
  assert.equal(oneLapSafetyIssue({ title: 'celebrate the release', tag: 'wish' }), 'one lap only dispatches local build, test, review, or research work');
});

test('an outbound ask is refused before wish or engine state is created', () => {
  const setup = setupRouter();
  try {
    const result = runCli(['post this update to x', '--engine', 'codex', '--json'], setup.workspace, setup.env);
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.match(JSON.parse(result.stdout).reason, /outbound or irreversible/);
    const wishes = path.join(setup.workspace, '.atris', 'state', 'wishes.jsonl');
    assert.ok(!fs.existsSync(wishes) || !fs.readFileSync(wishes, 'utf8').trim());
    assert.ok(!fs.existsSync(setup.engineMarker));
  } finally {
    fs.rmSync(setup.root, { recursive: true, force: true });
  }
});

function runCli(args, cwd, env) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 20000,
  });
  if (result.error) throw result.error;
  return result;
}

function setupRouter() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-one-lap-router-'));
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  const engineMarker = path.join(root, 'engine-ran.txt');
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nprintf ran > "${engineMarker}"\nexit 1\n`, { mode: 0o755 });
  const env = {
    ...scrubAgentEnv(),
    HOME: home,
    PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
    ATRIS_TASKS_DB: path.join(root, 'tasks.db'),
    ATRIS_NO_INTERACTIVE: '1',
    ATRIS_SKIP_UPDATE_CHECK: '1',
    NODE_NO_WARNINGS: '1',
    USER: 'router-test',
  };
  delete env.NODE_TEST_CONTEXT;
  const initialized = runCli(['init', '--yes'], workspace, env);
  assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
  fs.writeFileSync(path.join(workspace, 'atris', 'MAP.md'), '# MAP.md\n\n- router: bin/atris.js:1\n');
  const profile = path.join(workspace, '.atris', 'state', 'context_profile.json');
  fs.mkdirSync(path.dirname(profile), { recursive: true });
  fs.writeFileSync(profile, JSON.stringify({ schema: 'atris.context_profile.v1', first_answer: 'test the natural router' }) + '\n');
  return { root, workspace, env, engineMarker };
}

test('multiword natural routes and explicit atris alias share clean one-lap JSON', () => {
  const setup = setupRouter();
  try {
    const direct = runCli(['make it better', '--engine', 'codex', '--json'], setup.workspace, setup.env);
    assert.equal(direct.status, 0, direct.stderr || direct.stdout);
    const first = JSON.parse(direct.stdout);
    assert.equal(first.schema, 'atris.one_lap.v1');
    assert.equal(first.status, 'waiting_input');
    assert.equal(first.ask, 'make it better');
    assert.match(first.next_action, new RegExp(`^atris wish answer ${first.wish_id} '<answer>'$`));
    assert.doesNotMatch(direct.stdout, /CONTEXT LOADED|DIRECT REQUEST/);

    const alias = runCli(['atris', 'make', 'it', 'better', '--engine=codex', '--json'], setup.workspace, setup.env);
    assert.equal(alias.status, 0, alias.stderr || alias.stdout);
    const resumed = JSON.parse(alias.stdout);
    assert.equal(resumed.wish_id, first.wish_id);
    assert.equal(resumed.ask, 'make it better');
    assert.equal(resumed.resumed, true);
    assert.ok(!fs.existsSync(setup.engineMarker), 'a waiting interview must not dispatch an engine');
  } finally {
    fs.rmSync(setup.root, { recursive: true, force: true });
  }
});

test('natural one-lap option errors stay machine readable', () => {
  const setup = setupRouter();
  try {
    const result = runCli(['fix the tests', '--engine', '--json'], setup.workspace, setup.env);
    assert.equal(result.status, 2, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.schema, 'atris.one_lap.v1');
    assert.equal(payload.status, 'stuck');
    assert.match(payload.reason, /--engine needs a value/);
  } finally {
    fs.rmSync(setup.root, { recursive: true, force: true });
  }
});

test('meta questions with --json return one overview object', () => {
  const setup = setupRouter();
  try {
    const result = runCli(['what is atris', '--json'], setup.workspace, setup.env);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.schema, 'atris.overview.v1');
    assert.equal(payload.product, 'Atris');
    assert.doesNotMatch(result.stdout, /Atris is an AI computer\n/);
  } finally {
    fs.rmSync(setup.root, { recursive: true, force: true });
  }
});

test('an unverifiable local ask pauses for one exact proof command', () => {
  const setup = setupRouter();
  try {
    const result = runCli(['fix the auth bug', '--engine', 'codex', '--json'], setup.workspace, setup.env);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'waiting_input');
    assert.equal(payload.question, 'what exact command proves this request works?');
    assert.match(payload.next_action, /--verify '<command>' --json$/);
    assert.ok(!fs.existsSync(setup.engineMarker));
  } finally {
    fs.rmSync(setup.root, { recursive: true, force: true });
  }
});

test('one-word work intents route to clean one-lap JSON while unknown command JSON stays an error', () => {
  const setup = setupRouter();
  try {
    const direct = runCli(['fix', '--engine', 'codex', '--json'], setup.workspace, setup.env);
    assert.equal(direct.status, 0, direct.stderr || direct.stdout);
    const payload = JSON.parse(direct.stdout);
    assert.equal(payload.schema, 'atris.one_lap.v1');
    assert.equal(payload.ask, 'fix');
    assert.equal(payload.status, 'waiting_input');

    const typo = runCli(['statsu', '--json'], setup.workspace, setup.env);
    assert.equal(typo.status, 2, typo.stderr || typo.stdout);
    assert.equal(JSON.parse(typo.stdout).error, 'unknown command: statsu');
  } finally {
    fs.rmSync(setup.root, { recursive: true, force: true });
  }
});

test('displayed verifier retry commands quote the original ask for a shell', () => {
  const setup = setupRouter();
  try {
    const ask = "fix the user's auth bug";
    const result = runCli([ask, '--engine', 'codex', '--json'], setup.workspace, setup.env);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, 'waiting_input');
    assert.equal(payload.question, 'what exact command proves this request works?');
    assert.match(payload.next_action, /^atris 'fix the user'"'"'s auth bug' --engine codex --verify '<command>' --json$/);
    const parsed = spawnSync('/bin/sh', ['-n', '-c', payload.next_action], { encoding: 'utf8' });
    assert.equal(parsed.status, 0, parsed.stderr);
  } finally {
    fs.rmSync(setup.root, { recursive: true, force: true });
  }
});
