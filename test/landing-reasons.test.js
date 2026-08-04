// Landing refusals speak in plain sentences.
//
// The autoland/review lane refuses work with machine reason codes
// (verify_command_not_allowed, probation_needs_review, ...). Those codes are
// for JSON receipts; a human reading `autoland status`, `land status`, or
// `task reviews` gets one plain sentence per reason: what happened and what
// unblocks it. lib/voice-gate.js plainLandingReason is the one table.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const { plainLandingReason } = require('../lib/voice-gate');
const { withTaskReadyResult } = require('./helpers/task-result');

const SNAKE_CASE = /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/;

// Every static reason literal the accept gate can emit, read from its source
// so a new refusal code added without a sentence fails this test.
function acceptGateReasonCodes() {
  const source = fs.readFileSync(path.join(repoRoot, 'lib', 'auto-accept-certified.js'), 'utf8');
  const codes = new Set();
  for (const match of source.matchAll(/\breason: '([a-z][a-z0-9_]*)'/g)) codes.add(match[1]);
  return [...codes].sort();
}

// Codes from the review lane in commands/task.js that reach blocked_accept_reason
// or the blocked-review lines, plus samples of the dynamic families.
const REVIEW_LANE_CODES = [
  'mission_xp_requires_end_to_end_receipt',
  'needs_second_actor_review',
  'proof_required',
  'verification_pending',
  'weak_proof',
];
const DYNAMIC_SAMPLES = [
  'denied_tag_billing',
  'denied_tag_deploy',
  'denied_tag_security',
  'denied_tag_customer',
  'denied_tag_external',
  'denied_tag_feedback',
  'denied_tag_some_new_lane',
  'approval_denied',
];

test('every landing refusal reason code has a plain sentence, not a de-underscored code', () => {
  const codes = [...acceptGateReasonCodes(), ...REVIEW_LANE_CODES, ...DYNAMIC_SAMPLES];
  assert.ok(codes.length >= 20, `expected a real code inventory, got ${codes.length}`);
  for (const code of codes) {
    const sentence = plainLandingReason(code);
    assert.ok(sentence && typeof sentence === 'string', `${code}: no sentence`);
    assert.doesNotMatch(sentence, SNAKE_CASE, `${code}: snake_case leaks into "${sentence}"`);
    assert.notEqual(sentence, code.replace(/_/g, ' '),
      `${code}: falls through to the mechanical de-underscore; add a real sentence to LANDING_REASON_SENTENCES`);
    assert.ok(!sentence.includes(String.fromCharCode(0x2014)), `${code}: em dash in "${sentence}"`);
    assert.doesNotMatch(sentence, /[A-Z]/, `${code}: sentence should be lowercase, got "${sentence}"`);
    assert.doesNotMatch(sentence, /\b[0-9A-HJKMNP-TV-Z]{26}\b/, `${code}: ULID in "${sentence}"`);
    assert.ok(sentence.includes(' '), `${code}: "${sentence}" is not a sentence`);
  }
});

test('the exact status line shapes stay snake_case free for every code', () => {
  const codes = [...acceptGateReasonCodes(), ...REVIEW_LANE_CODES, ...DYNAMIC_SAMPLES];
  for (const code of codes) {
    const stays = `tsk-1 stays put; ${plainLandingReason(code)}.`;
    const waits = `tsk-1 waits for you; ${plainLandingReason(code)}.`;
    const blocked = `   approve: blocked; ${plainLandingReason(code)}`;
    for (const line of [stays, waits, blocked]) {
      assert.doesNotMatch(line, SNAKE_CASE, `rendered line leaks a code: "${line}"`);
    }
  }
});

// ── live surfaces: autoland status / land status / task reviews ─────────────

function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr || result.stdout}`);
  return result;
}

function makeTempRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-landing-reasons-'));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  runGit(['init', '-b', 'master'], repo);
  runGit(['config', 'user.email', 'test@example.com'], repo);
  runGit(['config', 'user.name', 'Test'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  runGit(['add', '.'], repo);
  runGit(['commit', '-m', 'init'], repo);
  fs.mkdirSync(path.join(repo, '.atris', 'state'), { recursive: true });
  return { base, repo };
}

function runCli(args, cwd) {
  const env = {
    ...process.env,
    ATRIS_SKIP_UPDATE_CHECK: '1',
    CI: 'true',
    ATRIS_TASKS_DB: path.join(cwd, '.atris', 'fixture-tasks.db'),
  };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_CODE_SSE_PORT;
  delete env.CODEX_SANDBOX;
  delete env.CURSOR_AGENT;
  delete env.DEVIN_SESSION_ID;
  delete env.ATRIS_AGENT_PROOF_ONLY;
  const result = spawnSync(process.execPath, [cliPath, ...withTaskReadyResult(args)], {
    cwd, encoding: 'utf8', timeout: 30000, env,
  });
  if (result.error) throw result.error;
  return result;
}

function assertNoSnakeCase(output, label) {
  for (const rawLine of String(output || '').split('\n')) {
    // Filesystem paths legitimately contain underscores; the prose must not.
    const line = rawLine.replace(/(?:~|\.{0,2})?\/[^\s)]+/g, '');
    assert.doesNotMatch(line, SNAKE_CASE, `${label} leaks a machine code: "${rawLine}"`);
  }
}

test('autoland status, land status, and task reviews speak without snake_case', () => {
  const { base, repo } = makeTempRepo();
  try {
    // A certified task in a protected lane so autoland status renders a real
    // refusal, and a single-pass review so a needs-work line renders too.
    const created = runCli(['task', 'new', 'Rotate the billing key so charges keep clearing', '--tag', 'billing', '--json'], repo);
    assert.equal(created.status, 0, created.stderr || created.stdout);
    const parsed = JSON.parse(created.stdout);
    const ref = String(parsed.task?.display_id || parsed.task?.id || parsed.display_id || parsed.id);
    assert.equal(runCli(['task', 'claim', ref, '--as', 'builder'], repo).status, 0);
    const proof = 'Command passed: git diff --check. Evidence inspected: clean tree, change verified in place.';
    assert.equal(runCli(['task', 'ready', ref, '--proof', proof, '--as', 'builder'], repo).status, 0);
    assert.equal(runCli(['task', 'ready', ref, '--proof', proof, '--as', 'codex-review'], repo).status, 0);

    const single = runCli(['task', 'new', 'Tighten the retry sentence so operators trust the pause', '--tag', 'code', '--json'], repo);
    assert.equal(single.status, 0, single.stderr || single.stdout);
    const singleParsed = JSON.parse(single.stdout);
    const singleRef = String(singleParsed.task?.display_id || singleParsed.task?.id || singleParsed.display_id || singleParsed.id);
    assert.equal(runCli(['task', 'claim', singleRef, '--as', 'builder'], repo).status, 0);
    assert.equal(runCli(['task', 'ready', singleRef, '--proof', proof, '--as', 'builder'], repo).status, 0);

    const autolandStatus = runCli(['autoland', 'status'], repo);
    assert.equal(autolandStatus.status, 0, autolandStatus.stderr || autolandStatus.stdout);
    assertNoSnakeCase(autolandStatus.stdout, 'autoland status');

    const landStatus = runCli(['land', 'status'], repo);
    assert.equal(landStatus.status, 0, landStatus.stderr || landStatus.stdout);
    assertNoSnakeCase(landStatus.stdout, 'land status');

    const reviews = runCli(['task', 'reviews'], repo);
    assert.equal(reviews.status, 0, reviews.stderr || reviews.stdout);
    assertNoSnakeCase(reviews.stdout, 'task reviews');

    // The JSON lane keeps the raw machine codes untouched.
    const json = runCli(['autoland', 'status', '--json'], repo);
    assert.equal(json.status, 0, json.stderr || json.stdout);
    const payload = JSON.parse(json.stdout);
    const reasons = [...(payload.blocked || []), ...(payload.ready_for_recheck || [])].map((r) => r.reason);
    assert.ok(reasons.some((r) => /_/.test(String(r || ''))), `expected raw codes in JSON, got: ${reasons.join(', ')}`);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
