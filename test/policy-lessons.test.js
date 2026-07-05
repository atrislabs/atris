const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { withTaskReadyResult } = require('./helpers/task-result');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');
const {
  mineProofPolicy,
  policyHintsForProof,
  writePolicyLessons,
  readPolicyLessons,
  syncLessonsMd,
} = require('../lib/policy-lessons');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-policy-lessons-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...withTaskReadyResult(args)], {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  if (result.error) throw result.error;
  return result;
}

function humanEpisode(label, proof) {
  return { rl: { label }, action: { actor: 'operator-jane' }, proof };
}

function agentEpisode(label, proof) {
  return { rl: { label }, action: { actor: 'codex-review' }, proof };
}

function fixtureHistory() {
  const episodes = [
    // 9 human accepts: all name a verify command, 2 also cite receipts.
    humanEpisode('accepted', 'commit abc1234; npm test 800/800 green; receipt atris/runs/a.json'),
    humanEpisode('accepted', 'npm test green; receipt atris/runs/b.json'),
    humanEpisode('accepted', 'npm test 12/12 green'),
    humanEpisode('accepted', 'node --test passed locally'),
    humanEpisode('accepted', 'pytest 44/44 green'),
    humanEpisode('accepted', 'cargo test all green'),
    humanEpisode('accepted', 'verified with npm test'),
    humanEpisode('accepted', 'node --check clean, npm test green'),
    humanEpisode('accepted', 'go test ./... green'),
    // 3 human bounces: none name a verify command; distinct causes.
    humanEpisode('revised', 'Superseded by CLI-999, packet refreshed elsewhere'),
    humanEpisode('revised', ''),
    humanEpisode('revised', 'Wrong owner: route this to the operator identity'),
    // Agent lane churn: excluded from the human gate entirely.
    agentEpisode('revised', 'needs receipt'),
    agentEpisode('revised', 'still missing evidence'),
    agentEpisode('revised', 'chat answered'),
    agentEpisode('revised', 'continue work'),
    agentEpisode('accepted', 'agent pass, not a human accept'),
  ];
  const receipts = [
    { actor: 'operator-jane', outcome: 'accepted' },
    { actor: 'operator-jane', outcome: 'accepted' },
    { actor: 'auto-accept-certified', outcome: 'accepted' },
  ];
  const scorecards = [
    { schema: 'atris.improve_tick.v1', reward: 4 },
    { schema: 'atris.improve_tick.v1', reward: 5 },
    { schema: 'atris.brain.scorecard.v1', reward: 1 },
  ];
  return { receipts, episodes, scorecards };
}

test('mineProofPolicy splits the human gate from agent lane and emits evidence-backed lessons', () => {
  const mined = mineProofPolicy(fixtureHistory(), { now: new Date('2026-06-10T00:00:00Z') });

  assert.equal(mined.schema, 'atris.policy_lessons.v1');
  assert.equal(mined.sources.task_episodes, 17);
  assert.equal(mined.sources.human_reviewed_episodes, 12);

  const gate = mined.stats.human_gate;
  assert.equal(gate.accepted, 9);
  assert.equal(gate.revised, 3);
  assert.deepEqual(gate.verify_command, {
    accepted_with: 9, accepted_without: 0, revised_with: 0, revised_without: 3,
  });
  assert.equal(gate.receipt_path.accepted_with, 2);
  assert.equal(gate.receipt_path.revised_with, 0);
  assert.deepEqual(gate.bounce_causes, { superseded: 1, empty_proof: 1, wrong_owner: 1 });

  assert.equal(mined.stats.agent_lane.revise_turns, 4);
  assert.equal(mined.stats.agent_lane.auto_certified_receipts, 1);
  assert.equal(mined.stats.scorecards.improve_ticks.avg_reward, 4.5);

  const ids = mined.lessons.map((lesson) => lesson.id);
  assert.deepEqual(ids, ['proof-verify-command', 'proof-live-receipt', 'bounce-causes-routing']);
  const verifyLesson = mined.lessons[0];
  assert.match(verifyLesson.lesson, /9\/9/);
  assert.match(verifyLesson.lesson, /3\/3/);
  assert.equal(verifyLesson.evidence.accepted_with, 9);
});

test('mineProofPolicy stays silent below the human-data threshold', () => {
  const mined = mineProofPolicy(fixtureHistory(), { minHumanReviewed: 20 });
  assert.deepEqual(mined.lessons, []);
  assert.equal(mined.sources.human_reviewed_episodes, 12);
});

test('policyHintsForProof fires only on missing evidence and never without mined lessons', () => {
  const mined = mineProofPolicy(fixtureHistory());
  const dir = makeTempDir();
  try {
    const writeReceipt = (rel, passed) => {
      const file = path.join(dir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ schema: 'atris.mission_receipt.v1', result: { passed } }) + '\n', 'utf8');
    };
    writeReceipt('atris/runs/run.json', true);
    writeReceipt('atris/runs/failing.json', false);

    const bare = policyHintsForProof('refactored the loop, looks good to me', mined, dir);
    assert.deepEqual(bare.map((h) => h.id), ['proof-verify-command', 'proof-live-receipt']);

    const partial = policyHintsForProof('npm test 10/10 green', mined, dir);
    assert.deepEqual(partial.map((h) => h.id), ['proof-live-receipt']);

    const full = policyHintsForProof('npm test green; receipt atris/runs/run.json', mined, dir);
    assert.deepEqual(full, []);

    // grep/diff-style verifiers are runnable commands too (CLI-217 false positive).
    const grepStyle = policyHintsForProof("verify: grep -q 'last_verified' page.md passed; receipt atris/runs/run.json", mined, dir);
    assert.deepEqual(grepStyle, []);
    const grepExtendedStyle = policyHintsForProof("grep -qE 'pass|ok' atris/runs/run.json passed; receipt atris/runs/run.json", mined, dir);
    assert.deepEqual(grepExtendedStyle, []);
    const rgStyle = policyHintsForProof("rg -n 'VERIFY_COMMAND_PATTERN' lib/policy-lessons.js passed; receipt atris/runs/run.json", mined, dir);
    assert.deepEqual(rgStyle, []);
    const rgQuietStyle = policyHintsForProof("rg -q 'VERIFY_COMMAND_PATTERN' lib/policy-lessons.js passed; receipt atris/runs/run.json", mined, dir);
    assert.deepEqual(rgQuietStyle, []);
    const diffExitStyle = policyHintsForProof('git diff --exit-code -- lib/policy-lessons.js passed; receipt atris/runs/run.json', mined, dir);
    assert.deepEqual(diffExitStyle, []);
    const diffBriefStyle = policyHintsForProof('diff --brief expected.txt actual.txt passed; receipt atris/runs/run.json', mined, dir);
    assert.deepEqual(diffBriefStyle, []);
    const cmpStyle = policyHintsForProof('cmp -s expected.txt actual.txt passed; receipt atris/runs/run.json', mined, dir);
    assert.deepEqual(cmpStyle, []);

    // The hint mirrors the lane gate: receipts must exist and pass on disk.
    const ghost = policyHintsForProof('npm test green; receipt atris/runs/ghost.json', mined, dir);
    assert.deepEqual(ghost.map((h) => h.id), ['proof-live-receipt']);
    const failing = policyHintsForProof('npm test green; receipt atris/runs/failing.json', mined, dir);
    assert.deepEqual(failing.map((h) => h.id), ['proof-live-receipt']);

    assert.deepEqual(policyHintsForProof('anything', null, dir), []);
    assert.deepEqual(policyHintsForProof('anything', { lessons: [] }, dir), []);
  } finally {
    cleanupTempDir(dir);
  }
});

test('syncLessonsMd appends policy lines once and refreshes them on re-mine', () => {
  const dir = makeTempDir();
  try {
    const first = mineProofPolicy(fixtureHistory(), { now: new Date('2026-06-09T00:00:00Z') });
    const firstSync = syncLessonsMd(dir, first);
    assert.deepEqual(firstSync.written, ['proof-verify-command', 'proof-live-receipt', 'bounce-causes-routing']);

    const second = mineProofPolicy(fixtureHistory(), { now: new Date('2026-06-10T00:00:00Z') });
    syncLessonsMd(dir, second);

    const content = fs.readFileSync(path.join(dir, 'atris', 'lessons.md'), 'utf8');
    const verifyLines = content.split('\n').filter((line) => line.includes('policy-proof-verify-command'));
    assert.equal(verifyLines.length, 1, 're-mine must replace, not stack');
    assert.match(verifyLines[0], /\[2026-06-10\]/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris lesson mine --json writes the policy state file and lessons.md', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    const { receipts, episodes, scorecards } = fixtureHistory();
    const writeJsonl = (name, rows) => fs.writeFileSync(
      path.join(dir, '.atris', 'state', name),
      rows.map((row) => JSON.stringify(row)).join('\n') + '\n',
      'utf8',
    );
    writeJsonl('career_xp_receipts.jsonl', receipts);
    writeJsonl('task_episodes.jsonl', episodes);
    writeJsonl('scorecards.jsonl', scorecards);

    const result = runCli(['lesson', 'mine', '--json'], { cwd: dir });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.lessons.length, 3);
    assert.deepEqual(payload.lessons_md_written, ['proof-verify-command', 'proof-live-receipt', 'bounce-causes-routing']);

    const stored = readPolicyLessons(dir);
    assert.equal(stored.schema, 'atris.policy_lessons.v1');
    assert.equal(stored.lessons.length, 3);
    assert.ok(fs.existsSync(path.join(dir, 'atris', 'lessons.md')));

    const dry = runCli(['lesson', 'mine', '--dry-run'], { cwd: dir });
    assert.equal(dry.status, 0, dry.stderr || dry.stdout);
    assert.match(dry.stdout, /dry-run: nothing written/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('task ready surfaces policy hints on evidence-less proof and stays quiet on receipt-backed proof', () => {
  const dir = makeTempDir();
  try {
    writePolicyLessons(dir, mineProofPolicy(fixtureHistory()));

    const created = runCli(['task', 'new', 'policy hint probe', '--tag', 'probe'], { cwd: dir });
    assert.equal(created.status, 0, created.stderr || created.stdout);
    const ref = created.stdout.trim().split('\t')[0];
    runCli(['task', 'claim', ref, '--as', 'probe-agent'], { cwd: dir });

    // Passes the weak-proof floor (claims a verifier result) but names no
    // runnable command and no receipt path — the gap policy hints target.
    const bare = runCli(['task', 'ready', ref, '--proof', 'validated the loop refactor by hand; render diff reviewed and passed', '--json'], { cwd: dir });
    assert.equal(bare.status, 0, bare.stderr || bare.stdout);
    const barePayload = JSON.parse(bare.stdout);
    assert.deepEqual(
      (barePayload.handoff.policy_hints || []).map((h) => h.id),
      ['proof-verify-command', 'proof-live-receipt'],
    );

    const receiptRel = path.join('atris', 'runs', 'probe.json');
    fs.mkdirSync(path.join(dir, 'atris', 'runs'), { recursive: true });
    fs.writeFileSync(path.join(dir, receiptRel), JSON.stringify({
      schema: 'atris.mission_receipt.v1',
      result: { passed: true },
    }) + '\n', 'utf8');
    const second = runCli(['task', 'ready', ref, '--proof', 'npm test 12/12 green; receipt atris/runs/probe.json', '--json'], { cwd: dir });
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const secondPayload = JSON.parse(second.stdout);
    assert.equal(secondPayload.handoff.policy_hints, undefined, 'evidence-backed proof must not be nagged');
  } finally {
    cleanupTempDir(dir);
  }
});
