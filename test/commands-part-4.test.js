const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const {
  acceptedInLastDay,
  writePolicy,
  taskStore,
  repoRoot,
  cliPath,
  makeTempDir,
  cleanupTempDir,
  runCli,
  hasNodeSqlite,
  waitForOutput,
} = require('./helpers/commands-shared');

test('task next scoped by tag does not surface unrelated Endgame fallback', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'onboarding' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), [
      '# TODO.md',
      '',
      '## Endgame',
      '',
      '**Slug:** runner-swap-safe',
      '**Horizon:** runner swaps should be config-only, not overnight outages',
      '',
      '## Backlog',
      '',
      '(empty)',
      '',
    ].join('\n'), 'utf8');

    const created = runCli(['task', 'new', 'Golden path certified checkpoint', '--tag', 'golden-path', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const ref = JSON.parse(created.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'onboarding'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'ready', ref, '--proof', 'node --check test/commands.test.js passed', '--as', 'onboarding'], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during certification',
    ], { cwd: dir, env }).status, 0);

    const scopedNext = runCli(['task', 'next', '--tag', 'golden-path', '--as', 'onboarding', '--json'], { cwd: dir, env });
    assert.equal(scopedNext.status, 0, scopedNext.stderr);
    const payload = JSON.parse(scopedNext.stdout);
    assert.equal(payload.action, 'accept');
    assert.equal(payload.command, `atris task accept ${ref}`);
    assert.equal(payload.scope.tag, 'golden-path');
    assert.equal(payload.task.display_id, ref);
    assert.equal(payload.task.tag, 'golden-path');

    const scopedText = runCli(['task', 'next', '--tag', 'golden-path', '--as', 'onboarding'], { cwd: dir, env });
    assert.equal(scopedText.status, 0, scopedText.stderr);
    assert.match(scopedText.stdout, new RegExp(`^next: atris task accept ${ref}$`, 'm'));
    assert.doesNotMatch(scopedText.stdout, /No open tasks for tag=golden-path/);
    assert.doesNotMatch(scopedText.stdout, /Create the next bounded task/);
    assert.doesNotMatch(scopedText.stdout, /runner swaps should be config-only/);
    assert.doesNotMatch(scopedText.stdout, /Create: atris task new/);

    const scopedCreate = runCli(['task', 'next', '--tag', 'golden-path', '--as', 'onboarding', '--create-next', '--json'], { cwd: dir, env });
    assert.notEqual(scopedCreate.status, 0);
    const createPayload = JSON.parse(scopedCreate.stdout);
    assert.equal(createPayload.reason, 'no_create_next_seed');
  } finally {
    cleanupTempDir(dir);
  }
});


test('task next does not repeat an Endgame seed that already exists', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex-executor' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), [
      '# TODO.md',
      '',
      '## Endgame',
      '',
      '**Slug:** runner-swap-safe',
      '**Horizon:** runner swaps should be config-only, not overnight outages',
      '',
      '## Backlog',
      '',
      '(empty)',
      '',
    ].join('\n'), 'utf8');

    const existing = runCli([
      'task', 'new', 'Audit and close next runner-agnostic heartbeat gap',
      '--tag', 'runner',
      '--json',
    ], { cwd: dir, env });
    assert.equal(existing.status, 0, existing.stderr);
    const existingTask = JSON.parse(existing.stdout).task;
    assert.equal(runCli(['task', 'claim', existingTask.display_id, '--as', 'auto-improver'], { cwd: dir, env }).status, 0);

    const created = runCli(['task', 'new', 'Certified checkpoint', '--tag', 'runner', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const ref = JSON.parse(created.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex-executor'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'ready', ref, '--proof', 'node --check test/commands.test.js passed', '--as', 'codex-executor'], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during certification',
    ], { cwd: dir, env }).status, 0);

    const next = runCli(['task', 'next', '--as', 'codex-executor', '--json'], { cwd: dir, env });
    assert.equal(next.status, 0, next.stderr);
    const payload = JSON.parse(next.stdout);
    assert.equal(payload.action, 'accept');
    assert.equal(payload.command, `atris task accept ${ref}`);
    assert.equal(payload.task.display_id, ref);

    const text = runCli(['task', 'next', '--as', 'codex-executor'], { cwd: dir, env });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, new RegExp(`^next: atris task accept ${ref}$`, 'm'));
    assert.doesNotMatch(text.stdout, /Create the next bounded task/);
    assert.doesNotMatch(text.stdout, /Create: atris task new/);

    const duplicate = runCli(['task', 'next', '--as', 'codex-executor', '--create-next', '--json'], { cwd: dir, env });
    assert.notEqual(duplicate.status, 0);
    const duplicatePayload = JSON.parse(duplicate.stdout);
    assert.equal(duplicatePayload.reason, 'no_create_next_seed');
  } finally {
    cleanupTempDir(dir);
  }
});


test('task review summary does not treat incidental XP wording as AgentXP work', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli([
      'task', 'add', 'Clean stale claimed task queue after XP review',
      '--tag', 'hygiene',
      '--json',
    ], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);

    const ready = runCli([
      'task', 'ready', ref,
      '--proof', 'closed stale duplicate scheduler claims; validation passed reward 0',
      '--as', 'codex',
      '--json',
    ], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);
    const readyPayload = JSON.parse(ready.stdout);
    assert.equal(readyPayload.task.review.summary, 'clean stale claimed task queue after XP review: review the completed result, then approve or ask for rework.');
    assert.deepEqual(readyPayload.task.review.landing, {
      happened: 'Operators can now understand completed test work faster.',
      reason: 'the result is named.',
      checked: 'I ran the validation check.',
      tested: 'I attached the proof below.',
      decision: 'Needs one more check; ask for rework if the receipt misses the point.',
    });
    assert.equal(readyPayload.task.review.result.changed, 'Operators can now understand completed test work faster.');
    assert.equal(readyPayload.task.review.result.checked, 'I ran the validation check.');
    assert.equal(readyPayload.task.review.proof, 'closed stale duplicate scheduler claims; validation passed reward 0');

    const readyShow = runCli(['task', 'show', ref], { cwd: dir, env });
    assert.equal(readyShow.status, 0, readyShow.stderr);
    assert.match(readyShow.stdout, /Result:/);
    assert.match(readyShow.stdout, /What happened: Operators can now understand completed test work faster\./);
    assert.match(readyShow.stdout, /How I checked: I ran the validation check\./);
    assert.match(readyShow.stdout, /What I tested: I attached the proof below\./);
    assert.match(readyShow.stdout, /Why it matters: the result is named\./);
    assert.match(readyShow.stdout, /Decision: Needs one more check; ask for rework if the receipt misses the point\./);
    assert.match(readyShow.stdout, /Short version: clean stale claimed task queue after XP review: review the completed result, then approve or ask for rework\./);
    assert.match(readyShow.stdout, /Details: closed stale duplicate scheduler claims; validation passed reward 0/);
    assert.doesNotMatch(readyShow.stdout, /AgentXP a real local scoreboard/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('task ready default landing describes completed work for unmapped titles', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli([
      'task', 'add', 'Explore review landing output',
      '--tag', 'cli',
      '--json',
    ], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);

    const ready = runCli([
      'task', 'ready', ref,
      '--proof', 'node --check test/commands.test.js passed',
      '--as', 'codex',
      '--json',
    ], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);
    const readyPayload = JSON.parse(ready.stdout);
    assert.equal(readyPayload.task.review.landing.happened, 'Operators can now understand completed test work faster.');
    assert.equal(readyPayload.task.review.landing.reason, 'the result is named.');
    assert.equal(readyPayload.task.review.result.changed, 'Operators can now understand completed test work faster.');

    const readyShow = runCli(['task', 'show', ref], { cwd: dir, env });
    assert.equal(readyShow.status, 0, readyShow.stderr);
    assert.match(readyShow.stdout, /What happened: Operators can now understand completed test work faster\./);
    assert.match(readyShow.stdout, /Why it matters: the result is named\./);
    assert.doesNotMatch(readyShow.stdout, /Explore review landing output is ready to review/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('task ready and finish accept landing capability sentences', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const readyAdd = runCli([
      'task', 'add', 'Add digest landing sentence',
      '--tag', 'cli',
      '--json',
    ], { cwd: dir, env });
    assert.equal(readyAdd.status, 0, readyAdd.stderr);
    const readyRef = JSON.parse(readyAdd.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', readyRef, '--as', 'codex'], { cwd: dir, env }).status, 0);

    const readySentence = 'Users can now trust the review queue to explain the result without opening the task.';
    const ready = runCli([
      'task', 'ready', readyRef,
      '--proof', 'node --check test/autoland.test.js passed',
      '--landing', readySentence,
      '--as', 'codex',
      '--json',
    ], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);
    assert.equal(ready.stderr, '');
    const readyPayload = JSON.parse(ready.stdout);
    assert.equal(readyPayload.landing_advisory, null);
    assert.equal(readyPayload.task.review.landing.happened, readySentence);

    const missingAdd = runCli([
      'task', 'add', 'Warn when landing is missing',
      '--tag', 'cli',
      '--json',
    ], { cwd: dir, env });
    assert.equal(missingAdd.status, 0, missingAdd.stderr);
    const missingRef = JSON.parse(missingAdd.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', missingRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const missingReady = runCli([
      'task', 'ready', missingRef,
      '--proof', 'node --check test/autoland.test.js passed',
      '--as', 'codex',
      '--json',
    ], { cwd: dir, env });
    assert.equal(missingReady.status, 0, missingReady.stderr);
    assert.match(missingReady.stderr, /new teammate would get/);
    assert.match(JSON.parse(missingReady.stdout).landing_advisory, /new teammate would get/);

    const finishAdd = runCli([
      'task', 'add', 'Finish digest landing sentence',
      '--tag', 'cli',
      '--json',
    ], { cwd: dir, env });
    assert.equal(finishAdd.status, 0, finishAdd.stderr);
    const finishRef = JSON.parse(finishAdd.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', finishRef, '--as', 'codex'], { cwd: dir, env }).status, 0);

    const finishSentence = 'Users can now trust the landed digest to explain the capability without opening the task.';
    const finish = runCli([
      'task', 'finish', finishRef,
      '--proof', 'node --test test/autoland.test.js passed',
      '--landing', finishSentence,
      '--as', 'codex',
      '--json',
    ], { cwd: dir, env });
    assert.equal(finish.status, 0, finish.stderr);
    assert.equal(finish.stderr, '');
    const finishPayload = JSON.parse(finish.stdout);
    assert.equal(finishPayload.landing_advisory, null);
    assert.equal(finishPayload.task.review.landing.happened, finishSentence);

    const finishProjection = JSON.parse(fs.readFileSync(finishPayload.projection_path, 'utf8'));
    const projectedFinishTask = finishProjection.tasks.find(task => task.id === finishPayload.task_id);
    const accepted = acceptedInLastDay([projectedFinishTask], Date.now());
    assert.equal(accepted.human.length, 1);
    assert.equal(accepted.human[0].happened, finishSentence);
  } finally {
    cleanupTempDir(dir);
  }
});


test('task ready rejects an explicit landing sentence a day-one PM cannot act on before review', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const added = runCli([
      'task', 'add', 'Make the team stream actionable for a new operator',
      '--tag', 'language',
      '--json',
    ], { cwd: dir, env });
    assert.equal(added.status, 0, added.stderr);
    const ref = JSON.parse(added.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);

    const brokenGrammar = runCli([
      'task', 'ready', ref,
      '--proof', 'node --check test/commands.test.js passed',
      '--result', 'Reviewers can now inspect saved artifact proof without opening machine logs, preventing slow approval checks.',
      '--landing', 'Read the artifact check as exists and not empty, preventing shell syntax from obscuring the proof.',
      '--as', 'codex',
    ], { cwd: dir, env });
    assert.equal(brokenGrammar.status, 2, brokenGrammar.stderr || brokenGrammar.stdout);
    assert.match(brokenGrammar.stderr, /landing needs one plain sentence saying what someone can do now and why it matters/);

    const weak = runCli([
      'task', 'ready', ref,
      '--proof', 'node --check test/commands.test.js passed',
      '--result', 'Operators can now see one worker without searching the whole team stream, saving time during handoffs.',
      '--landing', 'Run atris stream with an agent filter for one worker.',
      '--as', 'codex',
    ], { cwd: dir, env });
    assert.equal(weak.status, 2, weak.stderr || weak.stdout);
    assert.match(weak.stderr, /landing needs one plain sentence saying what someone can do now and why it matters/);

    const after = runCli(['task', 'show', ref, '--json'], { cwd: dir, env });
    assert.equal(after.status, 0, after.stderr);
    assert.equal(JSON.parse(after.stdout).status, 'claimed', 'weak landing must not move the task to review');
  } finally {
    cleanupTempDir(dir);
  }
});


test('task accept automatically projects accepted proof into durable local XP ledger', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli([
      'task', 'add', 'Ship local AgentXP projection',
      '--tag', 'agent-xp',
      '--goal-id', 'goal-agent-xp',
      '--goal-objective', 'Make XP collectible anywhere',
      '--json',
    ], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'ready', ref, '--proof', 'xp projection test passed', '--as', 'codex'], { cwd: dir, env }).status, 0);
    const accept = runCli(['task', 'accept', ref, '--reward', '2', '--as', 'keshavrao', '--json'], { cwd: dir, env });
    assert.equal(accept.status, 0, accept.stderr);
    const accepted = JSON.parse(accept.stdout);
    const projection = accepted.xp_projection;
    assert.equal(projection.schema, 'atris.career_xp_projection.v1');
    assert.equal(projection.collected_receipts, 1);
    assert.equal(projection.total_xp, 2);
    assert.equal(projection.today_xp, 2);
    assert.equal(projection.level, 1);
    assert.equal(projection.next_level_progress.current_xp, 2);
    assert.equal(projection.next_level_progress.required_xp, 1000);
    assert.equal(projection.next_level_progress.remaining_xp, 998);
    assert.equal(projection.receipts_count, 1);
    assert.equal(projection.latest_accepted_proof.source_task_id, accepted.task_id);
    assert.equal(projection.latest_accepted_proof.proof, 'xp projection test passed');
    assert.equal(projection.latest_accepted_proof.xp, 2);
    assert.equal(projection.latest_accepted_proof.goal.goal_id, 'goal-agent-xp');
    assert.equal(projection.integrity.status, 'verified');
    assert.equal(projection.integrity.local_trust, 'tamper_evident_not_attested');
    assert.equal(projection.leaderboard_eligible, false);
    assert.ok(projection.integrity.head_hash);
    assert.ok(projection.integrity.cursor.bytes_read > 0);

    const receiptsPath = path.join(dir, '.atris', 'state', 'career_xp_receipts.jsonl');
    const projectionPath = path.join(dir, '.atris', 'state', 'career_xp.projection.json');
    const cursorPath = path.join(dir, '.atris', 'state', 'career_xp.cursor.json');
    assert.ok(fs.existsSync(receiptsPath));
    assert.ok(fs.existsSync(projectionPath));
    assert.ok(fs.existsSync(cursorPath));
    const receipts = fs.readFileSync(receiptsPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].receipt_id, `task_review:${accepted.episode.episode_id}`);
    assert.equal(receipts[0].chain_version, 'atris.career_xp_receipt_chain.v1');
    assert.ok(receipts[0].source_episode_hash);
    assert.ok(receipts[0].receipt_hash);

    const collect = runCli(['xp', 'collect', '--json'], { cwd: dir, env });
    assert.equal(collect.status, 0, collect.stderr);
    assert.equal(JSON.parse(collect.stdout).collected_receipts, 0);
    assert.equal(fs.readFileSync(receiptsPath, 'utf8').trim().split(/\r?\n/).length, 1);

    const status = runCli(['xp', 'status', '--local', '--json'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).latest_accepted_proof.proof, 'xp projection test passed');
  } finally {
    cleanupTempDir(dir);
  }
});


test('task accept rejects non-positive rewards before marking done', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli(['task', 'add', 'Reject zero reward accept', '--tag', 'career-xp', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'ready', ref, '--proof', 'accept validation passed', '--as', 'codex'], { cwd: dir, env }).status, 0);

    const accept = runCli(['task', 'accept', ref, '--reward', '0', '--as', 'keshavrao', '--json'], { cwd: dir, env });
    assert.equal(accept.status, 2);
    assert.match(accept.stderr, /reward must be a positive number/);

    const show = runCli(['task', 'show', ref, '--json'], { cwd: dir, env });
    assert.equal(show.status, 0, show.stderr);
    const task = JSON.parse(show.stdout);
    assert.equal(task.status, 'review');
    assert.equal(task.metadata.approval_status, 'pending');
  } finally {
    cleanupTempDir(dir);
  }
});


test('task proof-only agent env blocks acceptance verbs', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = {
    ATRIS_TASKS_DB: dbPath,
    NODE_NO_WARNINGS: '1',
    ATRIS_AGENT_ID: 'codex',
    ATRIS_AGENT_PROOF_ONLY: '1',
  };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli(['task', 'add', 'Proof-only guard task', '--tag', 'agent-xp', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);

    const done = runCli(['task', 'done', ref, '--as', 'codex', '--proof', 'proof-only guard checked done command', '--json'], { cwd: dir, env });
    assert.equal(done.status, 2);
    assert.equal(JSON.parse(done.stdout).reason, 'agent_proof_only_human_accept_blocked');

    const finish = runCli(['task', 'finish', ref, '--as', 'codex', '--proof', 'proof-only guard checked finish command', '--json'], { cwd: dir, env });
    assert.equal(finish.status, 2);
    assert.equal(JSON.parse(finish.stdout).reason, 'agent_proof_only_human_accept_blocked');

    const positiveReview = runCli([
      'task', 'review', ref,
      '--reward', '1',
      '--as', 'codex-review',
      '--proof', 'proof-only guard checked positive review command',
      '--json',
    ], { cwd: dir, env });
    assert.equal(positiveReview.status, 2);
    assert.equal(JSON.parse(positiveReview.stdout).reason, 'agent_proof_only_human_accept_blocked');

    const ready = runCli([
      'task', 'ready', ref,
      '--as', 'codex',
      '--verify', `node --check ${path.join(repoRoot, 'commands', 'task.js')}`,
      '--json',
    ], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);

    const zeroReview = runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js proof-only guard passed and diff inspected',
      '--json',
    ], { cwd: dir, env });
    assert.equal(zeroReview.status, 0, zeroReview.stderr);

    const accept = runCli(['task', 'accept', ref, '--as', 'keshavrao', '--json'], { cwd: dir, env });
    assert.equal(accept.status, 2);
    assert.equal(JSON.parse(accept.stdout).reason, 'agent_proof_only_human_accept_blocked');

    const autoAccept = runCli([
      'task', 'auto-accept-certified',
      '--confirm-human-accept',
      '--as', 'keshavrao',
      '--json',
    ], { cwd: dir, env });
    assert.equal(autoAccept.status, 2);
    assert.equal(JSON.parse(autoAccept.stdout).reason, 'agent_proof_only_human_accept_blocked');

    const show = runCli(['task', 'show', ref, '--json'], { cwd: dir, env });
    assert.equal(show.status, 0, show.stderr);
    const task = JSON.parse(show.stdout);
    assert.equal(task.status, 'review');
    assert.equal(task.metadata.approval_status, 'pending');
  } finally {
    cleanupTempDir(dir);
  }
});


test('task auto-accept-certified requires explicit human confirmation', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    writePolicy(dir, { enabled: false, enabled_by: 'test' });
    const add = runCli(['task', 'add', 'Auto accept still needs a human', '--tag', 'agent-xp', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'ready', ref,
      '--proof', 'node --check test/commands.test.js passed and git status --porcelain passed',
      '--as', 'codex',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'validator',
      '--proof', 'node --test test/commands.test.js passed and diff inspected',
    ], { cwd: dir, env }).status, 0);

    const unconfirmed = runCli(['task', 'auto-accept-certified', '--json'], { cwd: dir, env });
    assert.equal(unconfirmed.status, 2);
    assert.equal(JSON.parse(unconfirmed.stdout).reason, 'human_accept_confirmation_required');
    assert.equal(JSON.parse(runCli(['task', 'show', ref, '--json'], { cwd: dir, env }).stdout).status, 'review');

    const missingActor = runCli(['task', 'auto-accept-certified', '--confirm-human-accept', '--json'], { cwd: dir, env });
    assert.equal(missingActor.status, 2);
    assert.equal(JSON.parse(missingActor.stdout).reason, 'human_actor_required');

    const flagActor = runCli(['task', 'auto-accept-certified', '--confirm-human-accept', '--as', '--json'], { cwd: dir, env });
    assert.equal(flagActor.status, 2);
    assert.equal(JSON.parse(flagActor.stdout).reason, 'human_actor_required');

    const preview = runCli(['task', 'auto-accept-certified', '--dry-run', '--json'], { cwd: dir, env });
    assert.equal(preview.status, 0, preview.stderr);
    const previewPayload = JSON.parse(preview.stdout);
    assert.equal(previewPayload.action, 'auto_accept_certified_dry_run');
    assert.equal(previewPayload.summary.would_accept, 0);
    assert.equal(previewPayload.scanned, previewPayload.summary.scanned);
    assert.equal(previewPayload.accepted, previewPayload.summary.accepted);
    assert.equal(previewPayload.would_accept, previewPayload.summary.would_accept);
    assert.equal(previewPayload.skipped, previewPayload.summary.skipped);
    assert.equal(previewPayload.failed, previewPayload.summary.failed);
    assert.equal(previewPayload.results[0].action, 'skipped');
    assert.equal(previewPayload.results[0].reason, 'strict_verify_missing');
    assert.match(previewPayload.results[0].next_action, /metadata\.verify/);
    assert.equal(previewPayload.results[0].review_chat_command, `atris task review-chat ${ref} --as codex-review`);
    assert.equal(JSON.parse(runCli(['task', 'show', ref, '--json'], { cwd: dir, env }).stdout).status, 'review');

    const strictText = runCli(['task', 'auto-accept-certified', '--dry-run'], { cwd: dir, env });
    assert.equal(strictText.status, 0, strictText.stderr);
    assert.match(strictText.stdout, /SKIPPED .*strict_verify_missing/);
    assert.match(strictText.stdout, /next_action=.*metadata\.verify/);
    assert.match(strictText.stdout, new RegExp(`review_chat=atris task review-chat ${ref} --as codex-review`));

    fs.writeFileSync(path.join(dir, 'verify.js'), 'const ok = true;\n', 'utf8');
    const verifyReview = runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --check verify.js passed and diff inspected',
      '--verify', 'node --check verify.js',
      '--json',
    ], { cwd: dir, env });
    assert.equal(verifyReview.status, 0, verifyReview.stderr);
    assert.equal(JSON.parse(verifyReview.stdout).task.metadata.verify, 'node --check verify.js');

    const strictVerifiedPreview = runCli(['task', 'auto-accept-certified', '--dry-run', '--strict-verify', '--json'], { cwd: dir, env });
    assert.equal(strictVerifiedPreview.status, 0, strictVerifiedPreview.stderr);
    const strictVerifiedPayload = JSON.parse(strictVerifiedPreview.stdout);
    assert.equal(strictVerifiedPayload.summary.would_accept, 1);
    assert.equal(strictVerifiedPayload.summary.skipped, 0);
    assert.equal(strictVerifiedPayload.results[0].action, 'would_accept');
    assert.equal(strictVerifiedPayload.results[0].reason, 'certified_strict_verify');

    const confirmed = runCli([
      'task', 'auto-accept-certified',
      '--confirm-human-accept',
      '--as', 'keshavrao',
      '--json',
    ], { cwd: dir, env });
    assert.equal(confirmed.status, 0, confirmed.stderr);
    const confirmedPayload = JSON.parse(confirmed.stdout);
    assert.equal(confirmedPayload.summary.accepted, 1);
    assert.equal(confirmedPayload.accepted, 1);
    assert.equal(confirmedPayload.failed, 0);
    assert.equal(confirmedPayload.results[0].action, 'accepted');
    const acceptedTask = JSON.parse(runCli(['task', 'show', ref, '--json'], { cwd: dir, env }).stdout);
    assert.equal(acceptedTask.status, 'done');
    assert.equal(acceptedTask.review.approval_status, 'accepted');
    assert.equal(acceptedTask.metadata.accepted_by, 'keshavrao');
  } finally {
    cleanupTempDir(dir);
  }
});


test('task auto-accept-certified --all sweeps past the old 12-row cap', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  const ROW_COUNT = 20; // more than the old hardcoded max of 12
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const trustState = path.join(dir, '.atris', 'state');
    fs.mkdirSync(trustState, { recursive: true });
    const trustedCodex = Array.from({ length: 10 }, () => JSON.stringify({ claimed_by: 'codex', outcome: 'accepted' }));
    fs.writeFileSync(path.join(trustState, 'career_xp_receipts.jsonl'), `${trustedCodex.join('\n')}\n`);
    fs.writeFileSync(path.join(trustState, 'scorecards.jsonl'), '');
    writePolicy(dir, { enabled: false, enabled_by: 'test' });
    for (let i = 0; i < ROW_COUNT; i += 1) {
      const add = runCli(['task', 'add', `Row ${i} lands under --all`, '--tag', 'code', '--json'], { cwd: dir, env });
      assert.equal(add.status, 0, add.stderr);
      const ref = JSON.parse(add.stdout).task.display_id;
      assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);
      assert.equal(runCli([
        'task', 'ready', ref,
        '--proof', `Row ${i}: node --check test/commands.test.js passed and diff inspected end to end`,
        '--as', 'codex',
      ], { cwd: dir, env }).status, 0);
    }

    // Without --all, the certified-only queue is unchanged: none of these
    // rows carry a second review pass, so the default path certifies none.
    const defaultScan = runCli(['task', 'auto-accept-certified', '--dry-run', '--json'], { cwd: dir, env });
    assert.equal(defaultScan.status, 0, defaultScan.stderr);
    assert.equal(JSON.parse(defaultScan.stdout).summary.scanned, 0);

    // Under --all with no explicit --limit, the sweep must cover every
    // pending row, not just the first 12 — the bug this fix closes.
    const allScan = runCli(['task', 'auto-accept-certified', '--dry-run', '--all', '--json'], { cwd: dir, env });
    assert.equal(allScan.status, 0, allScan.stderr);
    const allPayload = JSON.parse(allScan.stdout);
    assert.equal(allPayload.summary.scanned, ROW_COUNT);
    assert.equal(allPayload.summary.would_accept, ROW_COUNT);
    assert.equal(allPayload.summary.undercounted, false);

    // An explicit --limit still wins over the --all safety cap.
    const limitedAllScan = runCli(['task', 'auto-accept-certified', '--dry-run', '--all', '--limit', '5', '--json'], { cwd: dir, env });
    assert.equal(limitedAllScan.status, 0, limitedAllScan.stderr);
    assert.equal(JSON.parse(limitedAllScan.stdout).summary.scanned, 5);
  } finally {
    cleanupTempDir(dir);
  }
});


test('task review after acceptance cannot mint duplicate AgentXP', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli(['task', 'add', 'Keep accepted XP idempotent', '--tag', 'agent-xp', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'ready', ref, '--proof', 'accepted once validation passed', '--as', 'codex'], { cwd: dir, env }).status, 0);

    const accept = runCli(['task', 'accept', ref, '--as', 'keshavrao', '--json'], { cwd: dir, env });
    assert.equal(accept.status, 0, accept.stderr);
    assert.equal(JSON.parse(accept.stdout).xp_projection.total_xp, 1);

    const extraReview = runCli(['task', 'review', ref, '--reward', '1', '--proof', 'duplicate review validation passed', '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(extraReview.status, 0, extraReview.stderr);
    const extraReviewPayload = JSON.parse(extraReview.stdout);
    assert.equal(extraReviewPayload.episode.career_xp.eligible, false);
    assert.equal(extraReviewPayload.xp_projection.compact, true);
    assert.equal(extraReviewPayload.xp_projection.total_xp, 1);
    assert.equal(extraReviewPayload.xp_projection.collected_receipts, 0);
    assert.equal(extraReviewPayload.xp_projection.contribution_graph, undefined);
    assert.equal(extraReviewPayload.xp_projection.local_activity, undefined);
    assert.ok(Buffer.byteLength(extraReview.stdout, 'utf8') < 12000, extraReview.stdout);

    const status = runCli(['xp', 'status', '--local', '--json'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr);
    const payload = JSON.parse(status.stdout);
    assert.equal(payload.total_xp, 1);
    assert.equal(payload.receipts_count, 1);
  } finally {
    cleanupTempDir(dir);
  }
});


test('xp status repairs exact duplicate local XP receipts', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli(['task', 'add', 'Repair duplicate XP receipt', '--tag', 'career-xp', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'ready', ref, '--proof', 'duplicate receipt repair validation passed', '--as', 'codex'], { cwd: dir, env }).status, 0);
    const accept = runCli(['task', 'accept', ref, '--reward', '1', '--as', 'keshavrao', '--json'], { cwd: dir, env });
    assert.equal(accept.status, 0, accept.stderr);

    const receiptsPath = path.join(dir, '.atris', 'state', 'career_xp_receipts.jsonl');
    const original = fs.readFileSync(receiptsPath, 'utf8').trim();
    fs.writeFileSync(receiptsPath, `${original}\n${original}\n`, 'utf8');

    const status = runCli(['xp', 'status', '--local', '--json'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr);
    const projection = JSON.parse(status.stdout);
    assert.equal(projection.integrity.status, 'verified');
    assert.equal(projection.total_xp, 1);
    assert.equal(projection.receipts_count, 1);
    assert.equal(fs.readFileSync(receiptsPath, 'utf8').trim().split(/\r?\n/).length, 1);
  } finally {
    cleanupTempDir(dir);
  }
});


test('xp status fails closed on conflicting duplicate receipts with readable labels', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const title = 'Detect conflicting XP receipt';
    const add = runCli(['task', 'add', title, '--tag', 'career-xp', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'ready', ref, '--proof', 'conflict validation passed', '--as', 'codex'], { cwd: dir, env }).status, 0);
    const accept = runCli(['task', 'accept', ref, '--reward', '1', '--as', 'keshavrao', '--json'], { cwd: dir, env });
    assert.equal(accept.status, 0, accept.stderr);

    const receiptsPath = path.join(dir, '.atris', 'state', 'career_xp_receipts.jsonl');
    const receipt = JSON.parse(fs.readFileSync(receiptsPath, 'utf8').trim());
    const conflicting = { ...receipt, proof: 'conflicting proof', xp: 2 };
    fs.writeFileSync(receiptsPath, `${JSON.stringify(receipt)}\n${JSON.stringify(conflicting)}\n`, 'utf8');

    const status = runCli(['xp', 'status', '--local', '--json'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr);
    const projection = JSON.parse(status.stdout);
    assert.equal(projection.integrity.status, 'tampered');
    assert.equal(projection.total_xp, 0);
    assert.match(projection.integrity.errors.join('\n'), new RegExp(`conflicting_duplicate_receipt:${title}`));
    assert.doesNotMatch(projection.integrity.errors.join('\n'), /task_review:[A-Z0-9]+/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('xp status fails closed when local receipt ledger is tampered', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli(['task', 'add', 'Detect XP tampering', '--tag', 'career-xp', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'ready', ref, '--proof', 'tamper test passed', '--as', 'codex'], { cwd: dir, env }).status, 0);
    const accept = runCli(['task', 'accept', ref, '--reward', '1', '--as', 'keshavrao', '--json'], { cwd: dir, env });
    assert.equal(accept.status, 0, accept.stderr);
    assert.equal(JSON.parse(accept.stdout).xp_projection.total_xp, 1);

    const receiptsPath = path.join(dir, '.atris', 'state', 'career_xp_receipts.jsonl');
    const tampered = fs.readFileSync(receiptsPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
    tampered[0].xp = 999;
    fs.writeFileSync(receiptsPath, `${JSON.stringify(tampered[0])}\n`, 'utf8');

    const status = runCli(['xp', 'status', '--local', '--json'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr);
    const projection = JSON.parse(status.stdout);
    assert.equal(projection.integrity.status, 'tampered');
    assert.equal(projection.total_xp, 0);
    assert.equal(projection.today_xp, 0);
    assert.equal(projection.leaderboard_eligible, false);
    assert.match(projection.integrity.errors.join('\n'), /receipt_hash_mismatch/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('task revise sends ready work back to claimed with revision count', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli(['task', 'add', 'Revise autonomous work', '--tag', 'agent', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'ready', ref, '--proof', 'smoke passed', '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'ready', ref, '--proof', 'second smoke passed', '--as', 'codex'], { cwd: dir, env }).status, 0);

    const revise = runCli([
      'task', 'revise', ref,
      '--note', 'Proof is good but the user-facing copy is too much.',
      '--as', 'keshavrao',
      '--json',
    ], { cwd: dir, env });
    assert.equal(revise.status, 0, revise.stderr);
    const payload = JSON.parse(revise.stdout);
    assert.equal(payload.action, 'revise');
    assert.equal(payload.task.status, 'claimed');
    assert.equal(payload.task.metadata.approval_status, 'revise');
    assert.equal(payload.task.metadata.human_revision_count, 1);
    assert.equal(payload.task.metadata.human_revision_note, 'Proof is good but the user-facing copy is too much.');
    assert.equal(payload.task.metadata.agent_review_pass_count, undefined);
    assert.equal(payload.task.metadata.agent_certified, undefined);
    assert.equal(payload.task.review.proof, undefined);
    assert.equal(payload.task.review.agent_review_pass_count, undefined);
    assert.equal(payload.task.review.agent_certified, undefined);

    const revisedShow = runCli(['task', 'show', ref, '--json'], { cwd: dir, env });
    assert.equal(revisedShow.status, 0, revisedShow.stderr);
    const revisedTask = JSON.parse(revisedShow.stdout);
    assert.equal(revisedTask.review.proof, null);
    assert.equal(revisedTask.review.agent_review_pass_count, null);
    assert.equal(revisedTask.review.agent_certified, false);

    const staleAccept = runCli(['task', 'accept', ref, '--as', 'keshavrao', '--json'], { cwd: dir, env });
    assert.equal(staleAccept.status, 2);
    assert.match(staleAccept.stderr, /fresh proof_ready proof/);

    const revisedReady = runCli(['task', 'ready', ref, '--proof', 'revised validation passed', '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(revisedReady.status, 0, revisedReady.stderr);
    const readyPayload = JSON.parse(revisedReady.stdout);
    assert.equal(readyPayload.review_pass_count, 1);
    assert.equal(readyPayload.agent_certified, false);
    assert.equal(readyPayload.handoff.next_action, 'agent_review_again');
  } finally {
    cleanupTempDir(dir);
  }
});


test('task revise returns unclaimed ready work to open so agents can claim it', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli(['task', 'add', 'Revise open ready task', '--tag', 'agent', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;
    assert.equal(runCli(['task', 'ready', ref, '--proof', 'open task validation passed', '--as', 'codex'], { cwd: dir, env }).status, 0);

    const revise = runCli(['task', 'revise', ref, '--note', 'tighten proof', '--as', 'keshavrao', '--json'], { cwd: dir, env });
    assert.equal(revise.status, 0, revise.stderr);
    const revisedPayload = JSON.parse(revise.stdout);
    assert.equal(revisedPayload.task.status, 'open');
    assert.equal(revisedPayload.task.claimed_by, undefined);

    const claim = runCli(['task', 'claim', ref, '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(claim.status, 0, claim.stderr);
    assert.equal(JSON.parse(claim.stdout).task.status, 'claimed');
  } finally {
    cleanupTempDir(dir);
  }
});


test('task revise refuses accepted tasks so XP is not stale', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const add = runCli(['task', 'add', 'Do not revise accepted XP', '--tag', 'career-xp', '--json'], { cwd: dir, env });
    assert.equal(add.status, 0, add.stderr);
    const ref = JSON.parse(add.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'ready', ref, '--proof', 'accepted validation passed', '--as', 'codex'], { cwd: dir, env }).status, 0);
    const accept = runCli(['task', 'accept', ref, '--as', 'keshavrao', '--json'], { cwd: dir, env });
    assert.equal(accept.status, 0, accept.stderr);
    assert.equal(JSON.parse(accept.stdout).xp_projection.total_xp, 1);

    const revise = runCli(['task', 'revise', ref, '--note', 'needs more work', '--as', 'keshavrao', '--json'], { cwd: dir, env });
    assert.equal(revise.status, 1);
    assert.match(revise.stderr, /not_reviewable_done/);

    const status = runCli(['xp', 'status', '--local', '--json'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).total_xp, 1);
  } finally {
    cleanupTempDir(dir);
  }
});


test('task setup initializes projection and can import TODO view', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), [
      '# TODO.md',
      '',
      '## Backlog',
      '',
      '- Make task setup one command',
      '  **Tag:** tasks',
      '',
    ].join('\n'), 'utf8');

    const setup = runCli(['task', 'setup', '--import-todo'], { cwd: dir, env });
    assert.equal(setup.status, 0, setup.stderr);
    assert.match(setup.stdout, /tasks ready: 1 task/);
    assert.match(setup.stdout, /imported 1 new, skipped 0/);

    const projectionPath = path.join(dir, '.atris', 'state', 'tasks.projection.json');
    const projection = JSON.parse(fs.readFileSync(projectionPath, 'utf8'));
    assert.equal(projection.schema, 'atris.task_projection.v1');
    assert.equal(projection.tasks.length, 1);
    assert.equal(projection.tasks[0].title, 'Make task setup one command');
  } finally {
    cleanupTempDir(dir);
  }
});


test('task natural flow creates, picks, talks, finishes, and refreshes projection', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const created = runCli(['task', 'new', 'Make tasks feel natural', '--tag', 'ux', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const createdPayload = JSON.parse(created.stdout);
    const id = createdPayload.task_id;
    const ref = createdPayload.task.display_id;
    const legacyRef = id.slice(0, 8);

    const desk = runCli(['task', 'desk'], { cwd: dir, env });
    assert.equal(desk.status, 0, desk.stderr);
    assert.match(desk.stdout, /TASK DESK/);
    assert.match(desk.stdout, new RegExp(`open\\s+${ref}`));
    assert.match(desk.stdout, new RegExp(`^next: atris task claim ${ref} --as `, 'm'));

    const next = runCli(['task', 'next', '--as', 'codex'], { cwd: dir, env });
    assert.equal(next.status, 0, next.stderr);
    assert.match(next.stdout, new RegExp(`^next: atris task claim ${ref} --as codex$`, 'm'));
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);

    const said = runCli(['task', 'say', legacyRef, 'This should feel like a tiny task chat', '--as', 'codex'], { cwd: dir, env });
    assert.equal(said.status, 0, said.stderr);
    assert.match(said.stdout, new RegExp(`noted ${ref} v3`));

    const finish = runCli([
      'task', 'finish', ref,
      '--proof', 'npm test',
      '--lesson', 'Natural task verbs reduce coordination tax',
      '--next', 'Show task cards in every surface',
      '--as', 'codex',
    ], { cwd: dir, env });
    assert.equal(finish.status, 0, finish.stderr);
    assert.match(finish.stdout, new RegExp(`finished ${ref} reward=1`));

    const projectionPath = path.join(dir, '.atris', 'state', 'tasks.projection.json');
    const projection = JSON.parse(fs.readFileSync(projectionPath, 'utf8'));
    assert.equal(projection.tasks[0].id, id);
    assert.equal(projection.tasks[0].display_id, ref);
    assert.equal(projection.tasks[0].legacy_ref, legacyRef);
    assert.equal(projection.tasks[0].status, 'done');
    assert.equal(projection.tasks[0].current_version, 5);
    assert.equal(projection.tasks[0].messages[0].content, 'This should feel like a tiny task chat');

    const episodePath = path.join(dir, '.atris', 'state', 'task_episodes.jsonl');
    const episode = JSON.parse(fs.readFileSync(episodePath, 'utf8').trim());
    assert.equal(episode.action.actor, 'codex');
    assert.equal(episode.lesson, 'Natural task verbs reduce coordination tax');
  } finally {
    cleanupTempDir(dir);
  }
});


test('task headless JSON contract supports create, claim, note, finish, and events', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const created = runCli(['task', 'new', 'Headless agents need JSON', '--tag', 'headless', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const createPayload = JSON.parse(created.stdout);
    assert.equal(createPayload.ok, true);
    assert.equal(createPayload.action, 'created');
    assert.equal(createPayload.task.title, 'Headless agents need JSON');
    assert.ok(fs.existsSync(createPayload.projection_path));
    const id = createPayload.task_id;
    const shortId = id.slice(0, 8);

    const desk = runCli(['task', '--json'], { cwd: dir, env });
    assert.equal(desk.status, 0, desk.stderr);
    const deskPayload = JSON.parse(desk.stdout);
    assert.equal(deskPayload.ok, true);
    assert.equal(deskPayload.active_count, 1);
    assert.equal(deskPayload.projection.tasks[0].id, id);

    const next = runCli(['task', 'next', '--as', 'bot', '--json'], { cwd: dir, env });
    assert.equal(next.status, 0, next.stderr);
    const nextPayload = JSON.parse(next.stdout);
    assert.equal(nextPayload.action, 'claim');
    assert.equal(nextPayload.command, `atris task claim ${createPayload.task.display_id} --as bot`);
    assert.equal(nextPayload.owner, 'bot');
    assert.equal(nextPayload.task.status, 'open');
    assert.equal(runCli(['task', 'claim', shortId, '--as', 'bot', '--json'], { cwd: dir, env }).status, 0);

    const claimConflict = runCli(['task', 'claim', shortId, '--as', 'other', '--json'], { cwd: dir, env });
    assert.equal(claimConflict.status, 1);
    assert.equal(claimConflict.stderr, '');
    const claimConflictPayload = JSON.parse(claimConflict.stdout);
    assert.equal(claimConflictPayload.ok, false);
    assert.equal(claimConflictPayload.command, 'atris task claim');
    assert.equal(claimConflictPayload.reason, 'already_claimed');
    assert.equal(claimConflictPayload.claimed_by, 'bot');
    assert.equal(claimConflictPayload.recovery_command, `atris task release ${shortId} --as bot`);

    const humanClaimConflict = runCli(['task', 'claim', shortId, '--as', 'other'], { cwd: dir, env });
    assert.equal(humanClaimConflict.status, 1);
    assert.equal(humanClaimConflict.stdout, '');
    assert.match(humanClaimConflict.stderr, /claim failed: already_claimed \(held by bot\)/);
    assert.match(humanClaimConflict.stderr, new RegExp(`Recovery: atris task release ${shortId} --as bot`));

    const releaseOther = runCli(['task', 'release', shortId, '--as', 'other', '--json'], { cwd: dir, env });
    assert.equal(releaseOther.status, 1);
    assert.equal(releaseOther.stderr, '');
    const releaseOtherPayload = JSON.parse(releaseOther.stdout);
    assert.equal(releaseOtherPayload.reason, 'held_by_other');
    assert.equal(releaseOtherPayload.claimed_by, 'bot');

    const release = runCli(['task', 'release', shortId, '--as', 'bot', '--json'], { cwd: dir, env });
    assert.equal(release.status, 0, release.stderr);
    const releasePayload = JSON.parse(release.stdout);
    assert.equal(releasePayload.ok, true);
    assert.equal(releasePayload.action, 'released');
    assert.equal(releasePayload.task.status, 'open');
    assert.equal(releasePayload.task.claimed_by || null, null);
    assert.equal(releasePayload.event_version, 3);

    const reclaim = runCli(['task', 'claim', shortId, '--as', 'bot', '--json'], { cwd: dir, env });
    assert.equal(reclaim.status, 0, reclaim.stderr);
    const reclaimPayload = JSON.parse(reclaim.stdout);
    assert.equal(reclaimPayload.action, 'claimed');
    assert.equal(reclaimPayload.task.claimed_by, 'bot');

    const note = runCli(['task', 'say', shortId, 'machine-readable context', '--as', 'bot', '--json'], { cwd: dir, env });
    assert.equal(note.status, 0, note.stderr);
    const notePayload = JSON.parse(note.stdout);
    assert.equal(notePayload.action, 'noted');
    assert.equal(notePayload.version, 5);
    assert.equal(notePayload.task.latest_event_type, 'message');

    const shown = runCli(['task', 'show', shortId, '--json'], { cwd: dir, env });
    assert.equal(shown.status, 0, shown.stderr);
    const shownPayload = JSON.parse(shown.stdout);
    assert.equal(shownPayload.messages[0].content, 'machine-readable context');

    const finish = runCli([
      'task', 'finish', shortId,
      '--proof', 'node --test',
      '--lesson', 'Headless workers need JSON, not terminal prose',
      '--next', 'Sync JSON task events to Supabase',
      '--as', 'bot',
      '--json',
    ], { cwd: dir, env });
    assert.equal(finish.status, 0, finish.stderr);
    const finishPayload = JSON.parse(finish.stdout);
    assert.equal(finishPayload.action, 'finished');
    assert.equal(finishPayload.reviewed, true);
    assert.equal(finishPayload.task.status, 'done');
    assert.equal(finishPayload.episode.action.actor, 'bot');

    const doneConflict = runCli(['task', 'done', shortId, '--json'], { cwd: dir, env });
    assert.equal(doneConflict.status, 1);
    assert.equal(doneConflict.stderr, '');
    const doneConflictPayload = JSON.parse(doneConflict.stdout);
    assert.equal(doneConflictPayload.ok, false);
    assert.equal(doneConflictPayload.command, 'atris task done');
    assert.equal(doneConflictPayload.reason, 'not_open_or_claimed');
    assert.equal(doneConflictPayload.task_id, id);

    const finishConflict = runCli(['task', 'finish', shortId, '--json'], { cwd: dir, env });
    assert.equal(finishConflict.status, 1);
    assert.equal(finishConflict.stderr, '');
    const finishConflictPayload = JSON.parse(finishConflict.stdout);
    assert.equal(finishConflictPayload.ok, false);
    assert.equal(finishConflictPayload.command, 'atris task finish');
    assert.equal(finishConflictPayload.reason, 'not_open_or_claimed');
    assert.equal(finishConflictPayload.task_id, id);

    const humanFinishConflict = runCli(['task', 'finish', shortId], { cwd: dir, env });
    assert.equal(humanFinishConflict.status, 1);
    assert.equal(humanFinishConflict.stdout, '');
    assert.match(humanFinishConflict.stderr, /finish failed: .* not in open\|claimed/);

    const events = runCli(['task', 'events', shortId, '--json'], { cwd: dir, env });
    assert.equal(events.status, 0, events.stderr);
    const eventsPayload = JSON.parse(events.stdout);
    assert.deepEqual(eventsPayload.events.map(e => e.event_type), ['created', 'claimed', 'claim_released', 'claimed', 'message', 'completed', 'reviewed']);

    const where = runCli(['task', 'where', '--json'], { cwd: dir, env });
    assert.equal(where.status, 0, where.stderr);
    const wherePayload = JSON.parse(where.stdout);
    assert.equal(wherePayload.ok, true);
    assert.equal(wherePayload.db, dbPath);
    assert.equal(wherePayload.workspace, fs.realpathSync(dir));

    const unknown = runCli(['task', 'not-a-subcommand', '--json'], { cwd: dir, env });
    assert.equal(unknown.status, 2);
    assert.equal(unknown.stderr, '');
    const unknownPayload = JSON.parse(unknown.stdout);
    assert.equal(unknownPayload.ok, false);
    assert.equal(unknownPayload.error, 'unknown task subcommand: not-a-subcommand');
    assert.ok(Array.isArray(unknownPayload.usage));
    assert.ok(unknownPayload.usage.some(line => line.includes('atris task add')));

    const humanUnknown = runCli(['task', 'not-a-subcommand'], { cwd: dir, env });
    assert.equal(humanUnknown.status, 2);
    assert.match(humanUnknown.stderr, /atris task: unknown subcommand "not-a-subcommand"/);
    assert.match(humanUnknown.stdout, /atris task - durable local task state/);

    const missingTitle = runCli(['task', 'add', '--json', '--full'], { cwd: dir, env });
    assert.equal(missingTitle.status, 2);
    assert.equal(missingTitle.stderr, '');
    const missingTitlePayload = JSON.parse(missingTitle.stdout);
    assert.equal(missingTitlePayload.ok, false);
    assert.equal(missingTitlePayload.command, 'atris task add');
    assert.equal(missingTitlePayload.reason, 'missing_title');

    const missingClaimId = runCli(['task', 'claim', '--json', '--full'], { cwd: dir, env });
    assert.equal(missingClaimId.status, 2);
    assert.equal(missingClaimId.stderr, '');
    const missingClaimPayload = JSON.parse(missingClaimId.stdout);
    assert.equal(missingClaimPayload.ok, false);
    assert.equal(missingClaimPayload.command, 'atris task claim');
    assert.equal(missingClaimPayload.reason, 'missing_id');

    const humanMissingTitle = runCli(['task', 'add'], { cwd: dir, env });
    assert.equal(humanMissingTitle.status, 2);
    assert.equal(humanMissingTitle.stdout, '');
    assert.match(humanMissingTitle.stderr, /title required/);

    const missing = runCli(['task', 'show', 'DOESNOTEXIST', '--json', '--full'], { cwd: dir, env });
    assert.equal(missing.status, 2);
    assert.equal(missing.stderr, '');
    const missingPayload = JSON.parse(missing.stdout);
    assert.equal(missingPayload.ok, false);
    assert.equal(missingPayload.command, 'atris task show');
    assert.equal(missingPayload.reason, 'not_found');
  } finally {
    cleanupTempDir(dir);
  }
});


// CLI-865: claiming an already-done task burns a whole dispatch when a
// rendered view (atris/TODO.md) is stale, as it did twice live: the agent
// claims, builds, then discovers the work was already done. On an
// already_done claim failure, point straight at a real open task from the
// live projection instead of just reporting the failure.
test('claiming an already-done task suggests the next open task from the same tag, in JSON and human output', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const doneTask = runCli(['task', 'add', 'Ship the widget', '--tag', 'speedy', '--json'], { cwd: dir, env });
    assert.equal(doneTask.status, 0, doneTask.stderr);
    const doneRef = JSON.parse(doneTask.stdout).task.display_id;
    const sameTagOpen = runCli(['task', 'add', 'Ship the other widget', '--tag', 'speedy', '--json'], { cwd: dir, env });
    assert.equal(sameTagOpen.status, 0, sameTagOpen.stderr);
    const sameTagRef = JSON.parse(sameTagOpen.stdout).task.display_id;
    const otherTagOpen = runCli(['task', 'add', 'Unrelated open task', '--tag', 'other', '--json'], { cwd: dir, env });
    assert.equal(otherTagOpen.status, 0, otherTagOpen.stderr);

    assert.equal(runCli(['task', 'claim', doneRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const finish = runCli(['task', 'finish', doneRef, '--proof', 'node --test', '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(finish.status, 0, finish.stderr);
    assert.equal(JSON.parse(finish.stdout).task.status, 'done');

    // Stale render: an agent still holding an old atris/TODO.md tries to
    // claim the now-done task.
    const claimJson = runCli(['task', 'claim', doneRef, '--as', 'sonnet', '--json'], { cwd: dir, env });
    assert.equal(claimJson.status, 1);
    const claimPayload = JSON.parse(claimJson.stdout);
    assert.equal(claimPayload.ok, false);
    assert.equal(claimPayload.reason, 'already_done');
    assert.ok(claimPayload.next_claimable, 'already_done must suggest a next claimable task');
    assert.equal(claimPayload.next_claimable.ref, sameTagRef, 'same tag beats a different-tag open task');

    const claimHuman = runCli(['task', 'claim', doneRef, '--as', 'sonnet'], { cwd: dir, env });
    assert.equal(claimHuman.status, 1);
    assert.match(claimHuman.stderr, /claim failed: already_done/);
    assert.match(claimHuman.stderr, new RegExp(`next claimable: ${sameTagRef} .*atris task claim ${sameTagRef} --as sonnet`));

    // Once the same-tag task is also gone, fall back to any open task.
    assert.equal(runCli(['task', 'claim', sameTagRef, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const finish2 = runCli(['task', 'finish', sameTagRef, '--proof', 'node --test', '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(finish2.status, 0, finish2.stderr);
    const claimFallback = runCli(['task', 'claim', doneRef, '--as', 'sonnet', '--json'], { cwd: dir, env });
    const fallbackPayload = JSON.parse(claimFallback.stdout);
    assert.equal(fallbackPayload.next_claimable.ref, JSON.parse(otherTagOpen.stdout).task.display_id);

    // Once every task is claimed/done, there is nothing left to suggest.
    assert.equal(runCli(['task', 'claim', JSON.parse(otherTagOpen.stdout).task.display_id, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const claimNoneLeft = runCli(['task', 'claim', doneRef, '--as', 'sonnet', '--json'], { cwd: dir, env });
    assert.equal(JSON.parse(claimNoneLeft.stdout).next_claimable, null);
  } finally {
    cleanupTempDir(dir);
  }
});


test('claiming a task that is only already_claimed (not already_done) never suggests a next task', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const created = runCli(['task', 'add', 'Ship the widget', '--tag', 'speedy', '--json'], { cwd: dir, env });
    const ref = JSON.parse(created.stdout).task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const conflict = runCli(['task', 'claim', ref, '--as', 'sonnet', '--json'], { cwd: dir, env });
    assert.equal(JSON.parse(conflict.stdout).reason, 'already_claimed');
    assert.equal(JSON.parse(conflict.stdout).next_claimable, null);
  } finally {
    cleanupTempDir(dir);
  }
});


test('task status gives web and Swarlo a compact live contract', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'goals.md'), [
      '# Goals',
      '',
      '- Connect tasks to Swarlo and web command surfaces',
      '',
    ].join('\n'), 'utf8');

    const created = runCli(['task', 'new', 'Show live task status in Atris Web', '--tag', 'swarlo', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const id = JSON.parse(created.stdout).task_id;

    const parked = runCli(['task', 'new', 'Old imported TODO record', '--json'], { cwd: dir, env });
    assert.equal(parked.status, 0, parked.stderr);

    const explicitNext = runCli(['task', 'new', 'Shape explicit agent goal', '--tag', 'agent', '--json'], { cwd: dir, env });
    assert.equal(explicitNext.status, 0, explicitNext.stderr);
    const explicitNextId = JSON.parse(explicitNext.stdout).task_id;

    const claimed = runCli(['task', 'claim', id, '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(claimed.status, 0, claimed.stderr);

    const status = runCli(['task', 'status', '--json'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr);
    const payload = JSON.parse(status.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.action, 'status');
    assert.equal(payload.status.schema, 'atris.task_status.v1');
    assert.equal(payload.status.counts.active, 2);
    assert.equal(payload.status.counts.backlog, 1);
    assert.equal(payload.status.counts.plan, 1);
    assert.equal(payload.status.counts.do, 1);
    assert.equal(payload.status.current.id, id);
    assert.equal(Object.hasOwn(payload.status.current, 'events'), false);
    assert.equal(Object.hasOwn(payload.status.current, 'messages'), false);
    assert.equal(Object.hasOwn(payload.status.current, 'review'), false);
    assert.equal(Object.hasOwn(payload.status.current, 'lineage'), false);
    assert.equal(Object.hasOwn(payload.status.current, 'metadata'), false);
    assert.equal(Object.hasOwn(payload.status.current, 'workspace_root'), false);
    assert.equal(payload.status.next.id, explicitNextId);
    assert.equal(payload.status.goals.items[0], 'Connect tasks to Swarlo and web command surfaces');
    assert.equal(Object.hasOwn(payload.status, 'last_event'), false);
    assert.equal(Object.hasOwn(payload.status, 'swarlo'), false);

    const text = runCli(['task', 'status'], { cwd: dir, env });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /TASK STATUS/);
    assert.match(text.stdout, /plan 1 \/ do 1 \/ review 0 \/ backlog 1 \/ done 0/);
    assert.doesNotMatch(text.stdout, /swarlo feed/);

    const history = runCli(['task', 'status', '--json', '--history'], { cwd: dir, env });
    assert.equal(history.status, 0, history.stderr);
    const historyPayload = JSON.parse(history.stdout);
    assert.equal(historyPayload.status.last_event.task.id, id);
    assert.equal(Object.hasOwn(historyPayload.status.last_event.task, 'events'), false);
    assert.equal(historyPayload.status.last_event.event.event_type, 'claimed');
    assert.equal(historyPayload.status.swarlo.feed[0].kind, 'claim');
    assert.equal(historyPayload.status.swarlo.feed[0].metadata.swarlo.task_key, id);
    assert.match(historyPayload.status.swarlo.realtime_contract.web, /atrisos-web/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('task status closes long current titles at a clause', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, 'tasks.db'), NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const title = 'The current status sentence now explains the operator consequence in one complete clause; this second clause is deliberately long enough that a character slice would end it in the middle of a word and append an ellipsis';
    const created = runCli(['task', 'new', title, '--tag', 'voice', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr || created.stdout);
    const ref = JSON.parse(created.stdout).task.display_id;
    const claimed = runCli(['task', 'claim', ref, '--as', 'linguist'], { cwd: dir, env });
    assert.equal(claimed.status, 0, claimed.stderr || claimed.stdout);

    const json = runCli(['task', 'status', '--json'], { cwd: dir, env });
    assert.equal(json.status, 0, json.stderr || json.stdout);
    const currentTitle = JSON.parse(json.stdout).status.current.title;
    assert.equal(currentTitle, 'The current status sentence now explains the operator consequence in one complete clause');
    assert.doesNotMatch(currentTitle, /\.\.\.|…|second clause/);

    const text = runCli(['task', 'status'], { cwd: dir, env });
    assert.equal(text.status, 0, text.stderr || text.stdout);
    assert.match(text.stdout, /current .*The current status sentence now explains the operator consequence in one complete clause$/m);
    assert.doesNotMatch(text.stdout, /\.\.\.|…|second clause/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('task status stream tasks use latest agent proof fallback', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const db = taskStore.open(dbPath);
    const proof = 'agent-only proof is visible in stream rows';
    const objective = 'Make proof visible in stream status';
    const added = taskStore.addTask(db, {
      title: 'Expose stream proof fallback',
      tag: 'tasks',
      workspaceRoot: taskStore.workspaceRoot(dir),
      status: 'claimed',
      claimedBy: 'codex',
      metadata: {
        goal_objective: objective,
        latest_agent_proof: proof,
      },
    });
    assert.ok(added.id);
    taskStore.close();

    const status = runCli(['task', 'status', '--json'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr);
    const payload = JSON.parse(status.stdout);
    const stream = payload.status.streams.find(row => row.objective === objective);
    assert.ok(stream);
    const task = stream.tasks.find(row => row.id === added.id);
    assert.ok(task);
    assert.equal(task.proof, proof);
  } finally {
    taskStore.close();
    cleanupTempDir(dir);
  }
});


test('task status separates review continue-work from human accept waiting', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const continuationCreated = runCli(['task', 'new', 'Certified row with concrete continuation', '--tag', 'task', '--json'], { cwd: dir, env });
    assert.equal(continuationCreated.status, 0, continuationCreated.stderr);
    const continuationTask = JSON.parse(continuationCreated.stdout).task;
    assert.equal(runCli([
      'task', 'ready', continuationTask.display_id,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before status continuation split',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', continuationTask.display_id,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during status continuation split',
      '--next', 'Build the next concrete continuation slice',
    ], { cwd: dir, env }).status, 0);

    const waitingCreated = runCli(['task', 'new', 'Certified row waiting on human accept', '--tag', 'task', '--json'], { cwd: dir, env });
    assert.equal(waitingCreated.status, 0, waitingCreated.stderr);
    const waitingTask = JSON.parse(waitingCreated.stdout).task;
    assert.equal(runCli([
      'task', 'ready', waitingTask.display_id,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before human accept split',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', waitingTask.display_id,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during human accept split',
    ], { cwd: dir, env }).status, 0);

    const blockingCreated = runCli(['task', 'new', 'Review row still needs second agent check', '--tag', 'task', '--json'], { cwd: dir, env });
    assert.equal(blockingCreated.status, 0, blockingCreated.stderr);
    const blockingTask = JSON.parse(blockingCreated.stdout).task;
    assert.equal(runCli([
      'task', 'ready', blockingTask.display_id,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before status blocking split',
    ], { cwd: dir, env }).status, 0);

    const status = runCli(['task', 'status', '--json'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr);
    const payload = JSON.parse(status.stdout);
    assert.equal(payload.status.counts.review, 3);
    assert.equal(payload.status.counts.review_blocking, 1);
    assert.equal(payload.status.counts.review_certified, 2);
    assert.equal(payload.status.counts.review_continue_work, 1);
    assert.equal(payload.status.counts.review_human_accept_waiting, 1);
    assert.equal(payload.status.counts.active, 1);
    assert.equal(payload.status.review_actions.continue_work.count, 1);
    assert.equal(payload.status.review_actions.continue_work.first.id, continuationTask.id);
    assert.equal(payload.status.review_actions.continue_work.first.ref, continuationTask.display_id);
    assert.equal(payload.status.review_actions.continue_work.first.next_action, 'continue_work');
    assert.equal(payload.status.review_actions.continue_work.first.next_task, 'Build the next concrete continuation slice');
    assert.equal(payload.status.review_actions.continue_work.first.command, `atris task continue-work ${continuationTask.display_id} --as codex --json`);
    assert.equal(payload.status.review_actions.human_accept_waiting.count, 1);
    assert.equal(payload.status.review_actions.human_accept_waiting.first.id, waitingTask.id);
    assert.equal(payload.status.review_actions.human_accept_waiting.first.ref, waitingTask.display_id);
    assert.equal(payload.status.review_actions.human_accept_waiting.first.next_action, 'human_accept_waiting');
    assert.equal(payload.status.review_actions.human_accept_waiting.first.next_task, null);
    assert.equal(payload.status.review_actions.human_accept_waiting.first.command, null);
  } finally {
    cleanupTempDir(dir);
  }
});


test('task reviews gives a compact certified accept queue', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const certifiedCreated = runCli(['task', 'new', 'Ship certified proof packet', '--tag', 'review', '--json'], { cwd: dir, env });
    assert.equal(certifiedCreated.status, 0, certifiedCreated.stderr);
    const certifiedTask = JSON.parse(certifiedCreated.stdout).task;
    assert.equal(runCli(['task', 'claim', certifiedTask.display_id, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const certifiedProof = `Product proof: Human approval queue shows a compact certified packet without stale objective text. ${'context '.repeat(35)}Verifiers: node --check test/commands.test.js passed, focused review queue behavior checked, live atris task reviews json showing rows, git status --porcelain -- commands/task.js test/commands.test.js clean`;
    assert.equal(runCli([
      'task', 'ready', certifiedTask.display_id,
      '--proof', certifiedProof,
      '--happened', 'Operators can now review one compact certified proof packet, reducing the risk of approving against stale context.',
      '--checked', 'I checked the verifier claims and review thread.',
      '--tested', 'I ran the focused review queue test.',
      '--decision', 'Accept if the packet is readable; rework if proof is vague.',
      '--as', 'codex',
    ], { cwd: dir, env }).status, 0);
    const db = taskStore.open(dbPath);
    try {
      const row = taskStore.getTask(db, certifiedTask.id);
      const metadata = {
        ...(row.metadata || {}),
        goal_objective: 'Stale mission objective from another task',
        objective: 'Stale metadata objective from another task',
      };
      db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), certifiedTask.id);
    } finally {
      taskStore.close();
    }
    assert.equal(runCli(['task', 'review', certifiedTask.display_id, '--reward', '0', '--as', 'validator'], { cwd: dir, env }).status, 0);

    const blockingCreated = runCli(['task', 'new', 'Needs another agent review', '--tag', 'review', '--json'], { cwd: dir, env });
    assert.equal(blockingCreated.status, 0, blockingCreated.stderr);
    const blockingTask = JSON.parse(blockingCreated.stdout).task;
    assert.equal(runCli(['task', 'claim', blockingTask.display_id, '--as', 'codex'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'ready', blockingTask.display_id, '--proof', 'one review validation passed', '--as', 'codex'], { cwd: dir, env }).status, 0);

    const unsafeCreated = runCli(['task', 'new', 'Used a check outside the allowlist', '--tag', 'review', '--json'], { cwd: dir, env });
    assert.equal(unsafeCreated.status, 0, unsafeCreated.stderr);
    const unsafeTask = JSON.parse(unsafeCreated.stdout).task;
    assert.equal(runCli(['task', 'claim', unsafeTask.display_id, '--as', 'codex'], { cwd: dir, env }).status, 0);
    const unsafeReady = runCli([
      'task', 'ready', unsafeTask.display_id,
      '--verify', 'ls atris',
      '--result', 'Operators can now confirm finished work with a familiar file check, reducing the risk of approving missing proof.',
      '--as', 'codex',
    ], { cwd: dir, env });
    assert.equal(unsafeReady.status, 0, unsafeReady.stderr);

    const queue = runCli(['task', 'reviews', '--json'], { cwd: dir, env });
    assert.equal(queue.status, 0, queue.stderr);
    const payload = JSON.parse(queue.stdout);
    assert.equal(payload.action, 'review_queue');
    assert.equal(payload.queue.schema, 'atris.task_review_queue.v1');
    assert.equal(payload.queue.counts.review, 3);
    assert.equal(payload.queue.counts.certified, 1);
    assert.equal(payload.queue.counts.blocking, 2);
    assert.equal(payload.queue.items.length, 3);
    assert.equal(payload.queue.items[0].display_id, certifiedTask.display_id);
    const blockedQueueItem = payload.queue.items.find(item => item.display_id === blockingTask.display_id);
    assert.equal(blockedQueueItem.queue_role, 'blocked');
    assert.equal(blockedQueueItem.reason, 'needs_second_actor_review');
    assert.equal(blockedQueueItem.next_command, `atris task review-chat ${blockingTask.display_id} --as codex-review`);
    const unsafeQueueItem = payload.queue.items.find(item => item.display_id === unsafeTask.display_id);
    assert.equal(unsafeQueueItem.queue_role, 'blocked');
    assert.equal(unsafeQueueItem.reason, 'verify_command_not_allowed');
    assert.equal(unsafeQueueItem.next_command, `atris task review-chat ${unsafeTask.display_id} --as codex-review`);
	    assert.deepEqual(payload.queue.items[0].landing, {
	      happened: 'Operators can now review one compact certified proof packet, reducing the risk of approving against stale context.',
	      reason: 'Human approval queue shows a compact certified packet without stale objective text.',
	      checked: 'I checked the verifier claims and review thread.',
	      tested: 'I ran the focused review queue test.',
	      decision: 'Accept if the packet is readable; rework if proof is vague.',
    });
    assert.equal(payload.queue.items[0].result.saved, `Result is ready for human approval as ${certifiedTask.display_id}.`);
    assert.equal(payload.queue.items[0].accept_command, `atris task accept ${certifiedTask.display_id}`);
    assert.equal(payload.queue.items[0].land_command, `atris task accept ${certifiedTask.display_id}`);
    assert.equal(payload.queue.items[0].revise_command, `atris task revise ${certifiedTask.display_id} --note "<what must change>"`);
    assert.equal(payload.queue.items[0].send_back_command, `atris task revise ${certifiedTask.display_id} --note "<what must change>"`);
    assert.equal(payload.queue.items[0].review_chat_command, `atris task review-chat ${certifiedTask.display_id} --as codex-review`);
    assert.match(payload.queue.items[0].codex_prompt, new RegExp(`/codex review ${certifiedTask.display_id}`));
    assert.equal(payload.queue.items[0].verification_focus.objective, 'Ship certified proof packet');
    assert.doesNotMatch(payload.queue.items[0].codex_prompt, /Stale mission objective|Stale metadata objective/);
    assert.match(payload.queue.items[0].verification_focus.proof_claim, /node --check test\/commands\.test\.js passed/);
    assert.deepEqual(payload.queue.items[0].verification_focus.commands_to_verify, [
      'node --check test/commands.test.js',
      'git status --porcelain -- commands/task.js test/commands.test.js',
    ]);
    assert.ok(payload.queue.items[0].verification_focus.commands_to_verify.some(command => command.includes('node --check test/commands.test.js')));

    const text = runCli(['task', 'reviews'], { cwd: dir, env });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /one finished thing is waiting for your ok\. it passed both checks\./);
    assert.match(text.stdout, /two more are almost ready; second checks are still running\./);
    assert.match(text.stdout, /1\. Ship certified proof packet/);
    assert.match(text.stdout, /what's new: Operators can now review one compact certified proof packet, reducing the risk of approving against stale context\./);
    assert.match(text.stdout, /why it matters: Human approval queue shows a compact certified packet without stale objective text\./);
    assert.match(text.stdout, /checked: I checked the verifier claims and review thread; tested: I ran the focused review queue test\./);
    assert.doesNotMatch(text.stdout, /saved:/i);
    assert.doesNotMatch(text.stdout, /decision:/i);
    assert.match(text.stdout, new RegExp(`${blockingTask.display_id} needs a second reviewer before it can land; next: atris task review-chat ${blockingTask.display_id} --as codex-review`));
    assert.match(text.stdout, new RegExp(`${unsafeTask.display_id} used a check command the system does not allow; rerun with an approved check; next: atris task review-chat ${unsafeTask.display_id} --as codex-review`));
    assert.match(text.stdout, /still being checked:/);
    assert.doesNotMatch(text.stdout, /needs_second_actor_review|verify_command_not_allowed/);
    assert.doesNotMatch(text.stdout, /   details:/);
    assert.doesNotMatch(text.stdout, /   receipt:/);
    assert.doesNotMatch(text.stdout, /   \/codex:/);
    assert.match(text.stdout, new RegExp(`say yes: atris task accept ${certifiedTask.display_id}`));
    assert.doesNotMatch(text.stdout, new RegExp(`say yes: atris task accept ${blockingTask.display_id}`));

    const verbose = runCli(['task', 'reviews', '--verbose'], { cwd: dir, env });
    assert.equal(verbose.status, 0, verbose.stderr);
    assert.ok(verbose.stdout.indexOf("   what's new:") < verbose.stdout.indexOf('   details:'), 'summary should appear before raw details');
    assert.match(verbose.stdout, /saved: Result is ready for human approval as .*?\./);
    assert.match(verbose.stdout, new RegExp(`/codex: atris task review-chat ${certifiedTask.display_id} --as codex-review`));

    const grouped = runCli(['task', 'reviews', '--group-by', 'tag'], { cwd: dir, env });
    assert.equal(grouped.status, 0, grouped.stderr);
    assert.match(grouped.stdout, /one finished things are waiting, grouped by tag\./);
    assert.match(grouped.stdout, /1\. review - one task/);
    assert.match(grouped.stdout, /approve this group: atris task accept-group tag="review" --spot-check 3 --confirm-human-accept --as <you>/);
    assert.doesNotMatch(grouped.stdout, /CERTIFIED REVIEW|review then accept/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('task review groups are capped by default for human scan', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    for (let index = 1; index <= 12; index += 1) {
      const tag = `tag-${String(index).padStart(2, '0')}`;
      const created = runCli(['task', 'new', `Grouped approval ${index}`, '--tag', tag, '--json'], { cwd: dir, env });
      assert.equal(created.status, 0, created.stderr);
      const task = JSON.parse(created.stdout).task;
      assert.equal(runCli(['task', 'claim', task.display_id, '--as', 'codex'], { cwd: dir, env }).status, 0);
      assert.equal(runCli(['task', 'ready', task.display_id, '--proof', 'node --check test/commands.test.js passed', '--as', 'codex'], { cwd: dir, env }).status, 0);
      assert.equal(runCli(['task', 'review', task.display_id, '--reward', '0', '--as', 'validator'], { cwd: dir, env }).status, 0);
    }

    const grouped = runCli(['task', 'reviews', '--group-by', 'tag'], { cwd: dir, env });
    assert.equal(grouped.status, 0, grouped.stderr);
    assert.match(grouped.stdout, /twelve finished things are waiting, grouped by tag\./);
    assert.match(grouped.stdout, /1\. tag-01/);
    assert.match(grouped.stdout, /10\. tag-10/);
    assert.doesNotMatch(grouped.stdout, /11\. tag-11/);
    assert.match(grouped.stdout, /showing ten of twelve groups; rerun with --all for every group or --limit N to adjust\./);

    const ungrouped = runCli(['task', 'reviews'], { cwd: dir, env });
    assert.equal(ungrouped.status, 0, ungrouped.stderr);
    assert.match(ungrouped.stdout, /twelve finished things are waiting for your ok\. all of them passed both checks\./);

    const limited = runCli(['task', 'reviews', '--group-by', 'tag', '--limit', '3'], { cwd: dir, env });
    assert.equal(limited.status, 0, limited.stderr);
    assert.match(limited.stdout, /3\. tag-03/);
    assert.doesNotMatch(limited.stdout, /4\. tag-04/);
    assert.match(limited.stdout, /showing three of twelve groups/);

    const all = runCli(['task', 'reviews', '--group-by', 'tag', '--all'], { cwd: dir, env });
    assert.equal(all.status, 0, all.stderr);
    assert.match(all.stdout, /12\. tag-12/);
    assert.doesNotMatch(all.stdout, /Showing 10\/12 groups/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('task status resolves goal_id display refs to parent task objectives', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'goals.md'), [
      '# Goals',
      '',
      '- **Owned by:** chief-of-staff should not become the task objective',
      '',
    ].join('\n'), 'utf8');

    const parentCreated = runCli(['task', 'add', 'GM Desk v0: make Acme Co open to one playable daily rep', '--tag', 'gm-desk', '--json'], { cwd: dir, env });
    assert.equal(parentCreated.status, 0, parentCreated.stderr);
    const parent = JSON.parse(parentCreated.stdout).task;

    const childCreated = runCli(['task', 'add', 'GM Desk v0 step 2: route Acme Co open to daily surface, no /flow', '--tag', 'gm-desk', '--goal-id', parent.display_id, '--json'], { cwd: dir, env });
    assert.equal(childCreated.status, 0, childCreated.stderr);
    const child = JSON.parse(childCreated.stdout).task;

    const claimed = runCli(['task', 'claim', child.id, '--as', 'builder', '--json'], { cwd: dir, env });
    assert.equal(claimed.status, 0, claimed.stderr);

    const status = runCli(['task', 'status', '--json'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr);
    const payload = JSON.parse(status.stdout);
    assert.equal(payload.status.current.id, child.id);
    assert.equal(payload.status.current.objective, parent.title);
    assert.equal(payload.status.current.lineage.parent_task_id, parent.id);
    assert.equal(payload.status.current.lineage.parent_title, parent.title);
    assert.ok(payload.status.streams.some(stream => stream.objective === parent.title));
  } finally {
    cleanupTempDir(dir);
  }
});


test('task status treats reviewed failures as closed task health', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    const created = runCli(['task', 'new', 'Goal: who r u', '--tag', 'goal', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const id = JSON.parse(created.stdout).task_id;
    const claimed = runCli(['task', 'claim', id, '--as', 'command-leader', '--json'], { cwd: dir, env });
    assert.equal(claimed.status, 0, claimed.stderr);
    const failed = runCli(['task', 'done', id, '--failed', '--proof', 'Misrouted small talk; validation failed in intake triage.', '--json'], { cwd: dir, env });
    assert.equal(failed.status, 0, failed.stderr);
    const failedPayload = JSON.parse(failed.stdout);
    assert.equal(failedPayload.reviewed, true);

    const status = runCli(['task', 'status', '--json', '--history'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr);
    const payload = JSON.parse(status.stdout);
    assert.equal(payload.status.counts.active, 0);
    assert.equal(payload.status.counts.review, 0);
    assert.equal(payload.status.counts.done, 1);
    assert.equal(payload.status.current, null);
    assert.deepEqual(payload.status.needs_review, []);
    assert.equal(payload.status.swarlo.feed[0].metadata.swarlo.status, 'done');
  } finally {
    cleanupTempDir(dir);
  }
});


test('task status keeps failed blockers out of review handoff', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    const created = runCli(['task', 'new', 'Owner-gated route decision', '--tag', 'business-gm', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const id = JSON.parse(created.stdout).task_id;
    const claimed = runCli(['task', 'claim', id, '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(claimed.status, 0, claimed.stderr);
    const failed = runCli(['task', 'done', id, '--failed', '--json'], { cwd: dir, env });
    assert.equal(failed.status, 0, failed.stderr);

    const status = runCli(['task', 'status', '--json'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr);
    const payload = JSON.parse(status.stdout);
    assert.equal(payload.status.counts.review, 0);
    assert.equal(payload.status.counts.blocked, 1);
    assert.deepEqual(payload.status.needs_review, []);

    const text = runCli(['task', 'status'], { cwd: dir, env });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /review 0/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('task status keeps history out of the default live card', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const created = runCli(['task', 'new', 'Keep operator status compact', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const id = JSON.parse(created.stdout).task_id;
    const claimed = runCli(['task', 'claim', id, '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(claimed.status, 0, claimed.stderr);

    for (let i = 0; i < 8; i += 1) {
      const noted = runCli(['task', 'say', id, `status note ${i}`, '--as', 'codex', '--json'], { cwd: dir, env });
      assert.equal(noted.status, 0, noted.stderr);
    }

    const status = runCli(['task', 'status', '--json'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr);
    const payload = JSON.parse(status.stdout);
    assert.equal(Object.hasOwn(payload.status, 'swarlo'), false);
    assert.equal(Object.hasOwn(payload.status, 'last_event'), false);

    const history = runCli(['task', 'status', '--json', '--history'], { cwd: dir, env });
    assert.equal(history.status, 0, history.stderr);
    const historyPayload = JSON.parse(history.stdout);
    assert.equal(historyPayload.status.swarlo.feed.length, 10);
  } finally {
    cleanupTempDir(dir);
  }
});


test('task render archives old completed records from TODO view', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    for (let i = 0; i < 12; i += 1) {
      const created = runCli(['task', 'new', `Completed task ${i}`, '--tag', 'agent', '--json'], { cwd: dir, env });
      assert.equal(created.status, 0, created.stderr);
      const id = JSON.parse(created.stdout).task_id;
      const done = runCli(['task', 'done', id, '--proof', `node --test test/commands.test.js passed for archive ${i}`, '--json'], { cwd: dir, env });
      assert.equal(done.status, 0, done.stderr);
    }

    const render = runCli(['task', 'render', '--out', 'atris/TODO.md'], { cwd: dir, env });
    assert.equal(render.status, 0, render.stderr);
    const regenerated = fs.readFileSync(path.join(dir, 'atris', 'TODO.md'), 'utf8');
    const completedLines = regenerated.match(/\*\*\[[^\]]+\]\*\* Completed task/g) || [];
    assert.equal(completedLines.length, 8);
    assert.match(regenerated, /4 older completed tasks archived/);

    const exportOut = path.join(dir, '.atris', 'state', 'tasks.projection.json');
    const exported = runCli(['task', 'export', '--out', exportOut], { cwd: dir, env });
    assert.equal(exported.status, 0, exported.stderr);
    const projection = JSON.parse(fs.readFileSync(exportOut, 'utf8'));
    assert.equal(projection.tasks.length, 8);
    assert.equal(projection.surface.full_task_count, 12);
    assert.equal(projection.surface.visible_task_count, 8);
    assert.equal(projection.surface.hidden_done_count, 4);

    const status = runCli(['task', 'status', '--json'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr);
    const statusPayload = JSON.parse(status.stdout);
    assert.equal(statusPayload.status.counts.total, 12);
    assert.equal(statusPayload.status.counts.done, 12);

    const tightRender = runCli(['task', 'render', '--out', 'atris/TODO.md', '--done-limit', '2'], { cwd: dir, env });
    assert.equal(tightRender.status, 0, tightRender.stderr);
    const tight = fs.readFileSync(path.join(dir, 'atris', 'TODO.md'), 'utf8');
    const tightCompletedLines = tight.match(/\*\*\[[^\]]+\]\*\* Completed task/g) || [];
    assert.equal(tightCompletedLines.length, 2);
    assert.match(tight, /10 older completed tasks archived/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('mutating task commands regenerate TODO.md from task db', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const env = { ATRIS_TASKS_DB: path.join(dir, 'tasks.db'), NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# stale view\n', 'utf8');
    const created = runCli(['task', 'new', 'Rendered task from the database', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const todo = fs.readFileSync(path.join(dir, 'atris', 'TODO.md'), 'utf8');
    assert.match(todo, /Rendered task from the database/);
    assert.doesNotMatch(todo, /# stale view/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('task render archives old blocked records from TODO view', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    for (let i = 0; i < 16; i += 1) {
      const created = runCli(['task', 'new', `Blocked task ${i}`, '--tag', 'agent', '--json'], { cwd: dir, env });
      assert.equal(created.status, 0, created.stderr);
      const id = JSON.parse(created.stdout).task_id;
      const failed = runCli(['task', 'done', id, '--failed', '--proof', `node --test test/commands.test.js passed for blocked archive ${i}`, '--json'], { cwd: dir, env });
      assert.equal(failed.status, 0, failed.stderr);
    }

    const render = runCli(['task', 'render', '--out', 'atris/TODO.md'], { cwd: dir, env });
    assert.equal(render.status, 0, render.stderr);
    const regenerated = fs.readFileSync(path.join(dir, 'atris', 'TODO.md'), 'utf8');
    const blockedLines = regenerated.match(/\*\*\[[^\]]+\]\*\* Blocked task/g) || [];
    assert.equal(blockedLines.length, 12);
    assert.match(regenerated, /4 older blocked tasks archived/);

    const tightRender = runCli(['task', 'render', '--out', 'atris/TODO.md', '--failed-limit', '3'], { cwd: dir, env });
    assert.equal(tightRender.status, 0, tightRender.stderr);
    const tight = fs.readFileSync(path.join(dir, 'atris', 'TODO.md'), 'utf8');
    const tightBlockedLines = tight.match(/\*\*\[[^\]]+\]\*\* Blocked task/g) || [];
    assert.equal(tightBlockedLines.length, 3);
    assert.match(tight, /13 older blocked tasks archived/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('task review create-next preserves goal scope', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const created = runCli(['task', 'new', 'Improve task loop', '--tag', 'rsi', '--goal-id', 'OBL-928', '--json'], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const id = JSON.parse(created.stdout).task_id;

    const finished = runCli([
      'task', 'finish', id,
      '--proof', 'node --test',
      '--lesson', 'Each task review can seed the next sharper task',
      '--next', 'Make the next task editable from UI',
      '--create-next',
      '--as', 'codex',
      '--json',
    ], { cwd: dir, env });
    assert.equal(finished.status, 0, finished.stderr);
    const payload = JSON.parse(finished.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.task.status, 'done');
    assert.equal(Object.hasOwn(payload, 'projection'), false);
    assert.equal(Object.hasOwn(payload.task, 'events'), false);
    assert.equal(payload.episode.career_xp.eligible, false);
    assert.equal(payload.xp_projection.total_xp, 0);
    assert.ok(payload.next_task_id);
    const next = payload.next_task;
    assert.equal(next.title, 'Make the next task editable from UI');
    assert.equal(next.status, 'open');
    assert.equal(next.tag, 'rsi');
    assert.equal(next.lineage.parent_task_id, id);
    assert.equal(next.metadata.goal_id, 'OBL-928');

    const scopedCurrent = runCli(['task', 'current', '--goal-id', 'OBL-928', '--json'], { cwd: dir, env });
    assert.equal(scopedCurrent.status, 0, scopedCurrent.stderr);
    const scopedPayload = JSON.parse(scopedCurrent.stdout);
    assert.equal(scopedPayload.current.selected_task_id, payload.next_task_id);
    assert.equal(scopedPayload.current.selected_reason, 'backlog_idea');
  } finally {
    cleanupTempDir(dir);
  }
});


test('task continue-work creates the certified review next task', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const created = runCli([
      'task', 'new', 'Certify the task continuation path',
      '--tag', 'task',
      '--goal-id', 'OBL-928',
      '--json',
    ], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const parent = JSON.parse(created.stdout).task;
    const ref = parent.display_id;

    const ready = runCli([
      'task', 'ready', ref,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before continue-work certification',
      '--json',
    ], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);

    const certified = runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during continue-work certification',
      '--next', 'Expose the follow-up task in the scoped current queue',
      '--json',
    ], { cwd: dir, env });
    assert.equal(certified.status, 0, certified.stderr);
    const certifiedPayload = JSON.parse(certified.stdout);
    assert.equal(certifiedPayload.task.status, 'review');
    assert.equal(certifiedPayload.task.review.agent_certified, true);
    assert.equal(certifiedPayload.task.review.approval_status, 'pending');

    const continued = runCli(['task', 'continue-work', ref, '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(continued.status, 0, continued.stderr);
    const continuedPayload = JSON.parse(continued.stdout);
    assert.equal(continuedPayload.ok, true);
    assert.equal(continuedPayload.action, 'continue_work');
    assert.equal(continuedPayload.parent_task_id, parent.id);
    assert.equal(continuedPayload.created, true);
    assert.equal(continuedPayload.safety.human_accept, false);
    assert.equal(continuedPayload.safety.accepts_parent, false);
    assert.equal(continuedPayload.parent.status, 'review');
    assert.equal(continuedPayload.parent.review.approval_status, 'pending');
    assert.equal(continuedPayload.next_task.title, 'Expose the follow-up task in the scoped current queue');
    assert.equal(continuedPayload.next_task.status, 'open');
    assert.equal(continuedPayload.next_task.tag, 'task');
    assert.equal(continuedPayload.next_task.metadata.goal_id, 'OBL-928');
    assert.equal(continuedPayload.next_task.lineage.parent_task_id, parent.id);

    const reused = runCli(['task', 'continue-work', ref, '--as', 'codex', '--json'], { cwd: dir, env });
    assert.equal(reused.status, 0, reused.stderr);
    const reusedPayload = JSON.parse(reused.stdout);
    assert.equal(reusedPayload.next_task_id, continuedPayload.next_task_id);
    assert.equal(reusedPayload.created, false);

    const current = runCli(['task', 'current', '--goal-id', 'OBL-928', '--json'], { cwd: dir, env });
    assert.equal(current.status, 0, current.stderr);
    const currentPayload = JSON.parse(current.stdout);
    assert.equal(currentPayload.current.selected_task_id, continuedPayload.next_task_id);
    assert.equal(currentPayload.current.selected_reason, 'backlog_idea');

    const xp = runCli(['xp', 'status', '--local', '--json'], { cwd: dir, env });
    assert.equal(xp.status, 0, xp.stderr);
    assert.equal(JSON.parse(xp.stdout).total_xp, 0);
  } finally {
    cleanupTempDir(dir);
  }
});


test('task continue-work rejects generic human-accept continuation titles', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const created = runCli([
      'task', 'new', 'Certified row with generic continuation text',
      '--tag', 'task',
      '--goal-id', 'OBL-928',
      '--json',
    ], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const parent = JSON.parse(created.stdout).task;
    const ref = parent.display_id;

    const ready = runCli([
      'task', 'ready', ref,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before generic continue-work guard',
      '--next', 'Human accept remains pending for XP; next agent-actionable work can continue from OBL-1008.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);
    const readyPayload = JSON.parse(ready.stdout);
    assert.equal(readyPayload.review_next_task_ignored.reason, 'non_specific_next_task');
    assert.equal(readyPayload.task.review.next_task, undefined);

    const certified = runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during generic continue-work guard',
      '--next', 'Human accept remains pending for XP; next agent-actionable work can continue from OBL-1008.',
      '--json',
    ], { cwd: dir, env });
    assert.equal(certified.status, 0, certified.stderr);
    const certifiedPayload = JSON.parse(certified.stdout);
    assert.equal(certifiedPayload.review_next_task_ignored.reason, 'non_specific_next_task');
    assert.equal(certifiedPayload.task.review.agent_certified, true);
    assert.equal(certifiedPayload.task.review.next_task, undefined);

    const current = runCli(['task', 'current', '--goal-id', 'OBL-928', '--json'], { cwd: dir, env });
    assert.equal(current.status, 0, current.stderr);
    const currentPayload = JSON.parse(current.stdout);
    assert.equal(currentPayload.current.selected_task_id, parent.id);
    assert.equal(currentPayload.current.selected_reason, 'review_certified_waiting_human');
    assert.equal(currentPayload.current.next.key, 'human_accept_waiting');
    assert.equal(currentPayload.current.next.command, null);
    assert.equal(currentPayload.current.next.api, null);
    assert.equal(currentPayload.selected.continue_work_command, undefined);

    const reviews = runCli(['task', 'reviews', '--json'], { cwd: dir, env });
    assert.equal(reviews.status, 0, reviews.stderr);
    const reviewItem = JSON.parse(reviews.stdout).queue.items[0];
    assert.equal(reviewItem.id, parent.id);
    assert.equal(reviewItem.continue_work_command, undefined);
    assert.equal(reviewItem.continue_work_api, undefined);

    const continued = runCli(['task', 'continue-work', ref, '--as', 'codex', '--json'], { cwd: dir, env });
    assert.notEqual(continued.status, 0);
    const continuedPayload = JSON.parse(continued.stdout);
    assert.equal(continuedPayload.ok, false);
    assert.equal(continuedPayload.reason, 'no_next_task');
    assert.match(continuedPayload.detail, /no specific next_task suggestion/);
  } finally {
    cleanupTempDir(dir);
  }
});


test('task review hygiene reports generic continuation debt without mutation', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const created = runCli([
      'task', 'new', 'Certified row with stale generic review-next debt',
      '--tag', 'task',
      '--goal-id', 'OBL-928',
      '--json',
    ], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const parent = JSON.parse(created.stdout).task;
    const ref = parent.display_id;

    const ready = runCli([
      'task', 'ready', ref,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before review hygiene',
      '--json',
    ], { cwd: dir, env });
    assert.equal(ready.status, 0, ready.stderr);

    const certified = runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during review hygiene',
      '--json',
    ], { cwd: dir, env });
    assert.equal(certified.status, 0, certified.stderr);

    const seeded = spawnSync(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite');
      const sqlite = new DatabaseSync(process.argv[1]);
      try {
        const row = sqlite.prepare('SELECT metadata FROM tasks WHERE id = ?').get(process.argv[2]);
        const metadata = JSON.parse(row.metadata || '{}');
        metadata.latest_agent_next_task = 'Human accept remains pending for XP; next agent-actionable work can continue from OBL-1008.';
        sqlite.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), process.argv[2]);
      } finally {
        sqlite.close();
      }
    `, dbPath, parent.id], {
      encoding: 'utf8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    assert.equal(seeded.status, 0, seeded.stderr);

    const reviews = runCli(['task', 'reviews', '--json'], { cwd: dir, env });
    assert.equal(reviews.status, 0, reviews.stderr);
    const queue = JSON.parse(reviews.stdout).queue;
    assert.equal(queue.hygiene.generic_continuation_count, 1);
    assert.equal(queue.hygiene.generic_continuations[0].id, parent.id);
    assert.equal(queue.hygiene.generic_continuations[0].issues[0].field, 'review.next_task');
    assert.equal(queue.items[0].id, parent.id);
    assert.equal(queue.items[0].hygiene.generic_continuation_issues[0].field, 'review.next_task');
    assert.equal(queue.items[0].continue_work_command, undefined);
    assert.equal(queue.items[0].continue_work_api, undefined);

    const continued = runCli(['task', 'continue-work', ref, '--as', 'codex', '--json'], { cwd: dir, env });
    assert.notEqual(continued.status, 0);
    const continuedPayload = JSON.parse(continued.stdout);
    assert.equal(continuedPayload.ok, false);
    assert.equal(continuedPayload.reason, 'no_next_task');
  } finally {
    cleanupTempDir(dir);
  }
});


test('task current exposes continue-work for certified review suggestions', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const created = runCli([
      'task', 'new', 'Surface the certified continuation command',
      '--tag', 'task',
      '--goal-id', 'OBL-928',
      '--json',
    ], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const parent = JSON.parse(created.stdout).task;
    const ref = parent.display_id;

    assert.equal(runCli([
      'task', 'ready', ref,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before current continue-work',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during current continue-work review',
      '--next', 'Queue the command-backed follow-up',
    ], { cwd: dir, env }).status, 0);

    const current = runCli(['task', 'current', '--goal-id', 'OBL-928', '--json'], { cwd: dir, env });
    assert.equal(current.status, 0, current.stderr);
    const currentPayload = JSON.parse(current.stdout);
    const command = `atris task continue-work ${ref} --as codex --json`;
    assert.equal(currentPayload.current.selected_task_id, parent.id);
    assert.equal(currentPayload.current.selected_reason, 'review_certified_waiting_human');
    assert.equal(currentPayload.current.next.key, 'continue_work');
    assert.equal(currentPayload.current.next.command, command);
    assert.equal(currentPayload.current.next.human_accept_command, `atris task accept ${ref}`);
    assert.equal(currentPayload.page.review.verification_chat.human_accept_command, `atris task accept ${ref}`);
    assert.deepEqual(currentPayload.current.next.api, { method: 'POST', path: `/api/tasks/${parent.id}/continue-work` });
    assert.equal(currentPayload.page.stage.next_action.command, command);
    assert.equal(currentPayload.selected.continue_work_command, command);
    assert.equal(currentPayload.queue.columns.find(column => column.key === 'review').items[0].continue_work_command, command);

    const reviews = runCli(['task', 'reviews', '--json'], { cwd: dir, env });
    assert.equal(reviews.status, 0, reviews.stderr);
    const reviewItem = JSON.parse(reviews.stdout).queue.items[0];
    assert.equal(reviewItem.id, parent.id);
    assert.equal(reviewItem.continue_work_command, command);
    assert.deepEqual(reviewItem.continue_work_api, { method: 'POST', path: `/api/tasks/${parent.id}/continue-work` });

    const clearedReview = runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed while clearing stale next_task',
      '--next', '',
      '--json',
    ], { cwd: dir, env });
    assert.equal(clearedReview.status, 0, clearedReview.stderr);
    const clearedPayload = JSON.parse(clearedReview.stdout);
    assert.equal(clearedPayload.episode.next_task_suggestion, null);
    assert.equal(clearedPayload.episode.action.event_type, 'reviewed');
    assert.equal(clearedPayload.episode.rl.has_next_task, false);
    assert.equal(clearedPayload.task.review.next_task, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(clearedPayload.task.metadata, 'latest_agent_next_task'), false);

    const waitingCurrent = runCli(['task', 'current', '--goal-id', 'OBL-928', '--review-state', 'human-accept-waiting', '--json'], { cwd: dir, env });
    assert.equal(waitingCurrent.status, 0, waitingCurrent.stderr);
    const waitingCurrentPayload = JSON.parse(waitingCurrent.stdout);
    assert.equal(waitingCurrentPayload.current.review_state_actions.human_accept_waiting.ref, ref);
    assert.equal(waitingCurrentPayload.current.review_state_actions.human_accept_waiting.command, null);
    assert.equal(waitingCurrentPayload.current.review_state_actions.continue_work, null);
  } finally {
    cleanupTempDir(dir);
  }
});


test('task queue filters certified review rows by continue-work and human-accept waiting state', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const continueCreated = runCli([
      'task', 'new', 'Certified task with executable continuation',
      '--tag', 'task',
      '--goal-id', 'OBL-928',
      '--json',
    ], { cwd: dir, env });
    assert.equal(continueCreated.status, 0, continueCreated.stderr);
    const continueTask = JSON.parse(continueCreated.stdout).task;
    const continueRef = continueTask.display_id;
    assert.equal(runCli([
      'task', 'ready', continueRef,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before continue-work filter review',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', continueRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during continue-work filter review',
      '--next', 'Add the next queue lane filter regression',
    ], { cwd: dir, env }).status, 0);

    const waitingCreated = runCli([
      'task', 'new', 'Certified task waiting for human accept only',
      '--tag', 'task',
      '--goal-id', 'OBL-928',
      '--json',
    ], { cwd: dir, env });
    assert.equal(waitingCreated.status, 0, waitingCreated.stderr);
    const waitingTask = JSON.parse(waitingCreated.stdout).task;
    const waitingRef = waitingTask.display_id;
    assert.equal(runCli([
      'task', 'ready', waitingRef,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before human-accept filter review',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', waitingRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during human-accept filter review',
    ], { cwd: dir, env }).status, 0);

    const continueQueue = runCli([
      'task', 'queue',
      '--goal-id', 'OBL-928',
      '--review-state', 'continue-work',
      '--json',
    ], { cwd: dir, env });
    assert.equal(continueQueue.status, 0, continueQueue.stderr);
    const continuePayload = JSON.parse(continueQueue.stdout);
    const continueCommand = `atris task continue-work ${continueRef} --as codex --json`;
    assert.equal(continuePayload.current.scope.review_state, 'continue-work');
    assert.equal(continuePayload.current.selected_task_id, continueTask.id);
    assert.equal(continuePayload.current.next.key, 'continue_work');
    assert.equal(continuePayload.current.next.command, continueCommand);
    assert.deepEqual(continuePayload.current.capabilities, continuePayload.queue.capabilities);
    assert.equal(continuePayload.queue.capabilities.commands.current_step, 'atris task current-step --review-state <lane> --json');
    assert.equal(continuePayload.queue.capabilities.current_step.api.path, '/api/tasks/current/step?review_state=<lane>');
    assert.equal(continuePayload.queue.capabilities.current_step.lanes['continue-work'].step_action, 'continue_work');
    assert.equal(continuePayload.queue.capabilities.current_step.lanes['human-accept-waiting'].safe_for_agent, false);
    assert.equal(continuePayload.queue.counts.total, 1);
    assert.equal(continuePayload.queue.counts.review, 1);
    assert.equal(continuePayload.queue.review_state_counts.active_filter, 'continue-work');
    assert.equal(continuePayload.queue.review_state_counts.scope.goal_id, 'OBL-928');
    assert.equal(continuePayload.queue.review_state_counts.scope.review_state, null);
    assert.equal(continuePayload.queue.review_state_counts.total, 2);
    assert.equal(continuePayload.queue.review_state_counts.continue_work, 1);
    assert.equal(continuePayload.queue.review_state_counts.human_accept_waiting, 1);
    assert.equal(continuePayload.queue.review_state_counts.certified, 2);
    assert.deepEqual(continuePayload.current.review_state_counts, continuePayload.queue.review_state_counts);
    assert.deepEqual(continuePayload.current.review_state_actions, continuePayload.queue.review_state_actions);
    assert.equal(continuePayload.queue.review_state_actions.active_filter, 'continue-work');
    assert.equal(continuePayload.queue.review_state_actions.scope.goal_id, 'OBL-928');
    assert.equal(continuePayload.queue.review_state_actions.scope.review_state, null);
    assert.equal(continuePayload.queue.review_state_actions.needs_agent, null);
    assert.equal(continuePayload.queue.review_state_actions.continue_work.id, continueTask.id);
    assert.equal(continuePayload.queue.review_state_actions.continue_work.next_action, 'continue_work');
    assert.equal(continuePayload.queue.review_state_actions.continue_work.command, continueCommand);
    assert.deepEqual(continuePayload.queue.review_state_actions.continue_work.api, { method: 'POST', path: `/api/tasks/${continueTask.id}/continue-work` });
    assert.equal(continuePayload.queue.review_state_actions.continue_work.continue_work_command, continueCommand);
    assert.equal(continuePayload.queue.review_state_actions.continue_work.human_accept.human_only, true);
    assert.equal(continuePayload.queue.review_state_actions.human_accept_waiting.id, waitingTask.id);
    assert.equal(continuePayload.queue.review_state_actions.human_accept_waiting.next_action, 'human_accept_waiting');
    assert.equal(continuePayload.queue.review_state_actions.human_accept_waiting.command, null);
    assert.equal(continuePayload.queue.review_state_actions.human_accept_waiting.api, null);
    assert.equal(continuePayload.queue.review_state_actions.human_accept_waiting.continue_work_command, undefined);
    assert.equal(continuePayload.queue.review_state_actions.human_accept_waiting.human_accept.human_only, true);
    const continueQueueItem = continuePayload.queue.columns.find(column => column.key === 'review').items[0];
    assert.equal(continueQueueItem.id, continueTask.id);
    assert.equal(continueQueueItem.ref, continueTask.display_id);
    assert.equal(continueQueueItem.display_id, continueTask.display_id);
    assert.ok(continueQueueItem.legacy_ref);
    assert.equal(continueQueueItem.continue_work_command, continueCommand);

    const waitingQueue = runCli([
      'task', 'queue',
      '--goal-id', 'OBL-928',
      '--review-state', 'human-accept-waiting',
      '--json',
    ], { cwd: dir, env });
    assert.equal(waitingQueue.status, 0, waitingQueue.stderr);
    const waitingPayload = JSON.parse(waitingQueue.stdout);
    assert.equal(waitingPayload.current.scope.review_state, 'human-accept-waiting');
    assert.equal(waitingPayload.current.selected_task_id, waitingTask.id);
    assert.equal(waitingPayload.current.next.key, 'human_accept_waiting');
    assert.equal(waitingPayload.current.next.command, null);
    assert.equal(waitingPayload.selected.continue_work_command, undefined);
    assert.equal(waitingPayload.queue.counts.total, 1);
    assert.equal(waitingPayload.queue.counts.review, 1);
    assert.equal(waitingPayload.queue.review_state_counts.active_filter, 'human-accept-waiting');
    assert.equal(waitingPayload.queue.review_state_counts.total, 2);
    assert.equal(waitingPayload.queue.review_state_counts.continue_work, 1);
    assert.equal(waitingPayload.queue.review_state_counts.human_accept_waiting, 1);
    assert.equal(waitingPayload.queue.review_state_counts.certified, 2);
    assert.deepEqual(waitingPayload.current.review_state_counts, waitingPayload.queue.review_state_counts);
    assert.deepEqual(waitingPayload.current.review_state_actions, waitingPayload.queue.review_state_actions);
    assert.equal(waitingPayload.queue.review_state_actions.active_filter, 'human-accept-waiting');
    assert.equal(waitingPayload.queue.review_state_actions.continue_work.id, continueTask.id);
    assert.equal(waitingPayload.queue.review_state_actions.continue_work.command, continueCommand);
    assert.equal(waitingPayload.queue.review_state_actions.human_accept_waiting.id, waitingTask.id);
    assert.equal(waitingPayload.queue.review_state_actions.human_accept_waiting.next_action, 'human_accept_waiting');
    assert.equal(waitingPayload.queue.review_state_actions.human_accept_waiting.command, null);
    assert.equal(waitingPayload.queue.review_state_actions.human_accept_waiting.api, null);
    const waitingQueueItem = waitingPayload.queue.columns.find(column => column.key === 'review').items[0];
    assert.equal(waitingQueueItem.id, waitingTask.id);
    assert.equal(waitingQueueItem.ref, waitingTask.display_id);
    assert.equal(waitingQueueItem.display_id, waitingTask.display_id);
    assert.ok(waitingQueueItem.legacy_ref);
    assert.equal(waitingQueueItem.continue_work_command, undefined);

    const waitingCurrent = runCli([
      'task', 'current',
      '--goal-id', 'OBL-928',
      '--review-state', 'no_next_task',
      '--json',
    ], { cwd: dir, env });
    assert.equal(waitingCurrent.status, 0, waitingCurrent.stderr);
    const waitingCurrentPayload = JSON.parse(waitingCurrent.stdout);
    assert.equal(waitingCurrentPayload.current.scope.review_state, 'no_next_task');
    assert.equal(waitingCurrentPayload.current.selected_task_id, waitingTask.id);
    assert.equal(waitingCurrentPayload.current.next.key, 'human_accept_waiting');
    assert.equal(waitingCurrentPayload.current.review_state_counts.active_filter, 'no_next_task');
    assert.equal(waitingCurrentPayload.current.review_state_counts.total, 2);
    assert.equal(waitingCurrentPayload.current.review_state_counts.continue_work, 1);
    assert.equal(waitingCurrentPayload.current.review_state_counts.human_accept_waiting, 1);
    assert.equal(waitingCurrentPayload.current.review_state_actions.active_filter, 'no_next_task');
    assert.equal(waitingCurrentPayload.current.review_state_actions.continue_work.id, continueTask.id);
    assert.equal(waitingCurrentPayload.current.review_state_actions.human_accept_waiting.id, waitingTask.id);
    assert.equal(waitingCurrentPayload.current.review_state_actions.human_accept_waiting.command, null);
    assert.deepEqual(waitingCurrentPayload.current.capabilities.filters.review_state.aliases['human-accept-waiting'], ['human-accept', 'accept-waiting', 'waiting-accept', 'no-next-task']);
  } finally {
    cleanupTempDir(dir);
  }
});


test('task review lanes route stale PR proof out of human accept waiting', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const created = runCli([
      'task', 'new', 'Certified stale PR proof boundary',
      '--tag', 'task',
      '--goal-id', 'OBL-928',
      '--json',
    ], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const task = JSON.parse(created.stdout).task;
    const ref = task.display_id;
    const stalePrVerify = `node --check ${path.join(repoRoot, 'commands', 'task.js')}`;
    const stalePrProof = `Verified #1600 remains OPEN/draft/CLEAN at head be8797f. ${stalePrVerify} passed.`;

    assert.equal(runCli([
      'task', 'ready', ref,
      '--as', 'codex',
      '--proof', stalePrProof,
      '--verify', stalePrVerify,
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', ref,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', stalePrProof,
    ], { cwd: dir, env }).status, 0);

    const status = runCli(['task', 'status', '--json'], { cwd: dir, env });
    assert.equal(status.status, 0, status.stderr);
    const statusPayload = JSON.parse(status.stdout).status;
    assert.equal(statusPayload.counts.review, 1);
    assert.equal(statusPayload.counts.review_certified, 1);
    assert.equal(statusPayload.counts.review_proof_boundary_blocked, 1);
    assert.equal(statusPayload.counts.review_human_accept_waiting, 0);
    assert.equal(statusPayload.counts.active, 1);
    assert.equal(statusPayload.review_actions.proof_boundary_blocked.count, 1);
    assert.equal(statusPayload.review_actions.proof_boundary_blocked.first.ref, ref);
    assert.equal(statusPayload.review_actions.proof_boundary_blocked.first.next_action, 'proof_boundary_blocked');
    assert.equal(statusPayload.review_actions.proof_boundary_blocked.first.reason, 'proof_unmerged_or_draft_pr_boundary');
    assert.match(statusPayload.review_actions.proof_boundary_blocked.first.command, new RegExp(`atris task revise ${ref}`));
    assert.equal(statusPayload.review_actions.human_accept_waiting.count, 0);
    assert.equal(statusPayload.review_actions.human_accept_waiting.first, null);

    const current = runCli([
      'task', 'current',
      '--goal-id', 'OBL-928',
      '--review-state', 'proof-boundary-blocked',
      '--json',
    ], { cwd: dir, env });
    assert.equal(current.status, 0, current.stderr);
    const currentPayload = JSON.parse(current.stdout);
    assert.equal(currentPayload.current.selected_task_id, task.id);
    assert.equal(currentPayload.current.selected_reason, 'review_proof_boundary_blocked');
    assert.equal(currentPayload.current.next.key, 'proof_boundary_blocked');
    assert.equal(currentPayload.current.next.reason, 'proof_boundary_blocked_requires_revision');
    assert.match(currentPayload.current.next.command, new RegExp(`atris task revise ${ref}`));
    assert.equal(currentPayload.current.next.human_accept_command, null);
    assert.equal(currentPayload.current.review_state_counts.proof_boundary_blocked, 1);
    assert.equal(currentPayload.current.review_state_counts.human_accept_waiting, 0);
    assert.equal(currentPayload.current.review_state_counts.certified, 1);
    assert.equal(currentPayload.current.review_state_actions.proof_boundary_blocked.id, task.id);
    assert.equal(currentPayload.current.review_state_actions.proof_boundary_blocked.human_accept.enabled, false);
    assert.equal(currentPayload.current.review_state_actions.proof_boundary_blocked.human_accept.command, null);
    assert.equal(currentPayload.selected.commands.human_accept, undefined);
    assert.equal(currentPayload.page.review.verification_chat.human_accept_command, null);
    assert.doesNotMatch(JSON.stringify(currentPayload.page.review.verification_chat), new RegExp(`atris task accept ${ref}`));

    const waiting = runCli([
      'task', 'current',
      '--goal-id', 'OBL-928',
      '--review-state', 'human-accept-waiting',
      '--json',
    ], { cwd: dir, env });
    assert.equal(waiting.status, 0, waiting.stderr);
    const waitingPayload = JSON.parse(waiting.stdout);
    assert.equal(waitingPayload.current.selected_task_id, null);
    assert.equal(waitingPayload.current.selected_ref, null);

    const reviews = runCli(['task', 'reviews', '--json'], { cwd: dir, env });
    assert.equal(reviews.status, 0, reviews.stderr);
    const reviewItem = JSON.parse(reviews.stdout).queue.items[0];
    assert.equal(reviewItem.id, task.id);
    assert.equal(reviewItem.next_action, 'proof_boundary_blocked');
    assert.equal(reviewItem.accept_command, null);
    assert.equal(reviewItem.blocked_accept_reason, 'proof_unmerged_or_draft_pr_boundary');
    assert.match(reviewItem.revise_command, new RegExp(`atris task revise ${ref}`));

    const reviewText = runCli(['task', 'reviews'], { cwd: dir, env });
    assert.equal(reviewText.status, 0, reviewText.stderr);
    assert.match(reviewText.stdout, /approve: blocked; its proof points at an unmerged draft, merge it or prove the work another way/);
    assert.doesNotMatch(reviewText.stdout, /proof_unmerged_or_draft_pr_boundary/);
    assert.doesNotMatch(reviewText.stdout, new RegExp(`approve: atris task accept ${ref}`));

    const dryRun = runCli(['task', 'auto-accept-certified', '--dry-run', '--json'], { cwd: dir, env });
    assert.equal(dryRun.status, 0, dryRun.stderr);
    const dryRunResult = JSON.parse(dryRun.stdout).results[0];
    assert.equal(dryRunResult.action, 'skipped');
    assert.equal(dryRunResult.reason, 'proof_unmerged_or_draft_pr_boundary');

    const currentStep = runCli([
      'task', 'current-step',
      '--goal-id', 'OBL-928',
      '--review-state', 'proof-boundary-blocked',
      '--json',
    ], { cwd: dir, env });
    assert.notEqual(currentStep.status, 0);
    assert.equal(JSON.parse(currentStep.stdout).reason, 'proof_boundary_blocked_requires_revision');
  } finally {
    cleanupTempDir(dir);
  }
});


test('task current-step rejects bookkeeping receipts for golden-path mission XP', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'onboarding', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'runs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'runs', 'bookkeeping.json'), JSON.stringify({
      schema: 'atris.mission_receipt.v1',
      mission_id: 'mission-golden-path',
      result: {
        landing: {
          changed: 'Review-row bookkeeping now has a receipt.',
          checked: 'Tick recorded; no verifier was run.',
        },
      },
    }, null, 2), 'utf8');

    const created = runCli([
      'task', 'new',
      'Mission XP: Golden path zero-knowledge fresh-laptop pass',
      '--tag', 'agent-xp',
      '--goal-id', 'mission-golden-path',
      '--json',
    ], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const task = JSON.parse(created.stdout).task;
    const ref = task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'onboarding', '--json'], { cwd: dir, env }).status, 0);

    const weakProof = 'atris/runs/bookkeeping.json';
    const blocked = runCli([
      'task', 'current-step',
      '--goal-id', 'mission-golden-path',
      '--as', 'onboarding',
      '--proof', weakProof,
      '--json',
    ], { cwd: dir, env });
    assert.notEqual(blocked.status, 0);
    const blockedPayload = JSON.parse(blocked.stdout);
    assert.equal(blockedPayload.reason, 'mission_xp_requires_end_to_end_receipt');
    assert.match(blockedPayload.detail, /zero-papercut end-to-end fresh-laptop pass/);

    const ready = runCli(['task', 'ready', ref, '--as', 'onboarding', '--proof', weakProof, '--json'], { cwd: dir, env });
    assert.notEqual(ready.status, 0);
    assert.equal(JSON.parse(ready.stdout).reason, 'mission_xp_requires_end_to_end_receipt');

    const strongProof = 'zero-papercut end-to-end fresh install -> init -> first mission -> first self-landed task receipt: atris/runs/bookkeeping.json';
    const passed = runCli([
      'task', 'current-step',
      '--goal-id', 'mission-golden-path',
      '--as', 'onboarding',
      '--proof', strongProof,
      '--json',
      '--full',
    ], { cwd: dir, env });
    assert.equal(passed.status, 0, passed.stderr);
    const passedPayload = JSON.parse(passed.stdout);
    assert.equal(passedPayload.step.step_action, 'ready');
    assert.equal(passedPayload.task.status, 'review');
  } finally {
    cleanupTempDir(dir);
  }
});


test('task review lanes block weak golden-path mission XP proof from accept', () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'onboarding', ATRIS_SKIP_UPDATE_CHECK: '1' };
  try {
    fs.mkdirSync(path.join(dir, 'atris', 'runs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'runs', 'bookkeeping.json'), JSON.stringify({
      schema: 'atris.mission_receipt.v1',
      mission_id: 'mission-golden-path',
      result: {
        landing: {
          changed: 'Review-row bookkeeping now has a receipt.',
          checked: 'Tick recorded; no verifier was run.',
        },
      },
    }, null, 2), 'utf8');

    const strongProof = 'zero-papercut end-to-end fresh install -> init -> first mission -> first self-landed task receipt: atris/runs/bookkeeping.json';
    const created = runCli([
      'task', 'new',
      'Mission XP: Golden path zero-knowledge fresh-laptop pass',
      '--tag', 'agent-xp',
      '--goal-id', 'mission-golden-path',
      '--json',
    ], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const task = JSON.parse(created.stdout).task;
    const ref = task.display_id;
    assert.equal(runCli(['task', 'claim', ref, '--as', 'onboarding', '--json'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'ready', ref, '--as', 'onboarding', '--proof', strongProof, '--json'], { cwd: dir, env }).status, 0);
    assert.equal(runCli(['task', 'review', ref, '--reward', '0', '--as', 'codex-review', '--proof', strongProof, '--json'], { cwd: dir, env }).status, 0);

    const weakProof = 'atris/runs/bookkeeping.json';
    const seeded = spawnSync(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite');
      const sqlite = new DatabaseSync(process.argv[1]);
      try {
        const row = sqlite.prepare('SELECT metadata FROM tasks WHERE id = ?').get(process.argv[2]);
        const metadata = JSON.parse(row.metadata || '{}');
        metadata.latest_agent_proof = process.argv[3];
        metadata.agent_certified = true;
        metadata.approval_status = 'pending';
        metadata.agent_review_pass_count = 2;
        metadata.stop_condition = 'a full fresh-environment pass completes with zero new papercuts';
        sqlite.prepare('UPDATE tasks SET metadata = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(metadata), Date.now(), process.argv[2]);
      } finally {
        sqlite.close();
      }
    `, dbPath, task.id, weakProof], {
      encoding: 'utf8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    assert.equal(seeded.status, 0, seeded.stderr);

    const reviews = runCli(['task', 'reviews', '--json'], { cwd: dir, env });
    assert.equal(reviews.status, 0, reviews.stderr);
    const reviewItem = JSON.parse(reviews.stdout).queue.items[0];
    assert.equal(reviewItem.id, task.id);
    assert.equal(reviewItem.next_action, 'proof_boundary_blocked');
    assert.equal(reviewItem.accept_command, null);
    assert.equal(reviewItem.blocked_accept_reason, 'mission_xp_requires_end_to_end_receipt');

    const current = runCli([
      'task', 'current',
      '--goal-id',
      'mission-golden-path',
      '--review-state',
      'proof-boundary-blocked',
      '--json',
    ], { cwd: dir, env });
    assert.equal(current.status, 0, current.stderr);
    const currentPayload = JSON.parse(current.stdout);
    assert.equal(currentPayload.current.selected_task_id, task.id);
    assert.equal(currentPayload.current.next.key, 'proof_boundary_blocked');
    assert.equal(currentPayload.current.next.human_accept_command, null);

    const accept = runCli(['task', 'accept', ref, '--as', 'keshav', '--json'], { cwd: dir, env });
    assert.notEqual(accept.status, 0);
    assert.equal(JSON.parse(accept.stdout).reason, 'mission_xp_requires_end_to_end_receipt');

    const dryRun = runCli(['task', 'auto-accept-certified', '--dry-run', '--json'], { cwd: dir, env });
    assert.equal(dryRun.status, 0, dryRun.stderr);
    const dryRunResult = JSON.parse(dryRun.stdout).results[0];
    assert.equal(dryRunResult.action, 'skipped');
    assert.equal(dryRunResult.reason, 'mission_xp_requires_end_to_end_receipt');
  } finally {
    cleanupTempDir(dir);
  }
});


test('task serve continue-work creates scoped follow-up', async () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  let child = null;
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });

    const created = runCli([
      'task', 'add', 'API certified continuation parent',
      '--tag', 'factory',
      '--goal-id', 'OBL-933',
      '--json',
    ], { cwd: dir, env });
    assert.equal(created.status, 0, created.stderr);
    const parent = JSON.parse(created.stdout).task;
    assert.equal(runCli([
      'task', 'ready', parent.display_id,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before API continue-work',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', parent.display_id,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during API continue-work review',
      '--next', 'API scoped continuation child',
    ], { cwd: dir, env }).status, 0);

    child = spawn(process.execPath, [cliPath, 'task', 'serve', '--host', '127.0.0.1', '--port', '0'], {
      cwd: dir,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const ready = await waitForOutput(child, /Task board: (http:\/\/127\.0\.0\.1:\d+)/);
    const base = ready.match[1];

    const detail = await fetch(`${base}/api/tasks/${parent.id}`).then(r => r.json());
    assert.equal(detail.ok, true);
    assert.equal(detail.page.stage.next_action.key, 'continue_work');
    assert.equal(detail.page.stage.next_action.command, `atris task continue-work ${parent.display_id} --as codex --json`);
    assert.deepEqual(detail.page.stage.next_action.api, { method: 'POST', path: `/api/tasks/${parent.id}/continue-work` });

    const continued = await fetch(`${base}/api/tasks/${parent.id}/continue-work`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex' }),
    }).then(r => r.json());
    assert.equal(continued.ok, true);
    assert.equal(continued.action, 'continue_work');
    assert.equal(continued.created, true);
    assert.equal(continued.parent.status, 'review');
    assert.equal(continued.parent.review.approval_status, 'pending');
    assert.equal(continued.next_task.title, 'API scoped continuation child');
    assert.equal(continued.next_task.status, 'open');
    assert.equal(continued.next_task.metadata.goal_id, 'OBL-933');
    assert.equal(continued.next_task.lineage.parent_task_id, parent.id);
    assert.equal(continued.safety.human_accept, false);

    const reused = await fetch(`${base}/api/tasks/${parent.id}/continue-work`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex' }),
    }).then(r => r.json());
    assert.equal(reused.ok, true);
    assert.equal(reused.next_task_id, continued.next_task_id);
    assert.equal(reused.created, false);
  } finally {
    if (child) child.kill('SIGTERM');
    cleanupTempDir(dir);
  }
});


test('task serve rejects generic review next continuation', async () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  let child = null;
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    child = spawn(process.execPath, [cliPath, 'task', 'serve', '--host', '127.0.0.1', '--port', '0'], {
      cwd: dir,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const readyServer = await waitForOutput(child, /Task board: (http:\/\/127\.0\.0\.1:\d+)/);
    const base = readyServer.match[1];

    const created = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'API certified row with generic continuation text', tag: 'factory' }),
    }).then(r => r.json());
    assert.equal(created.ok, true);

    const genericNext = 'Human accept remains pending for XP; next agent-actionable work can continue from OBL-1008.';
    const ready = await fetch(`${base}/api/tasks/${created.task_id}/ready`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex',
        proof: 'node --check test/commands.test.js passed before API generic continue-work guard',
        next: genericNext,
      }),
    }).then(r => r.json());
    assert.equal(ready.ok, true);
    assert.equal(ready.review_next_task_ignored.reason, 'non_specific_next_task');
    assert.equal(ready.task.review.next_task, null);

    const reviewed = await fetch(`${base}/api/tasks/${created.task_id}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex-review',
        reward: 0,
        proof: 'node --test test/commands.test.js passed during API generic continue-work guard',
        next: genericNext,
      }),
    }).then(r => r.json());
    assert.equal(reviewed.ok, true);
    assert.equal(reviewed.review_next_task_ignored.reason, 'non_specific_next_task');
    assert.equal(reviewed.task.review.agent_certified, true);
    assert.equal(reviewed.task.review.next_task, null);

    const detail = await fetch(`${base}/api/tasks/${created.task_id}`).then(r => r.json());
    assert.equal(detail.ok, true);
    assert.equal(detail.page.stage.next_action.key, 'human_accept_waiting');
    assert.equal(detail.page.stage.next_action.command, null);
    assert.equal(detail.page.stage.next_action.api, null);

    const continuedResponse = await fetch(`${base}/api/tasks/${created.task_id}/continue-work`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex' }),
    });
    assert.equal(continuedResponse.status, 409);
    const continued = await continuedResponse.json();
    assert.equal(continued.ok, false);
    assert.equal(continued.reason, 'no_next_task');
    assert.match(continued.detail, /no specific next_task suggestion/);
  } finally {
    if (child) child.kill('SIGTERM');
    cleanupTempDir(dir);
  }
});


test('task serve exposes review-lane-drain API', async () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_AGENT_ID: 'codex', ATRIS_SKIP_UPDATE_CHECK: '1' };
  let child = null;
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    const continueCreated = runCli([
      'task', 'new', 'API drain row with executable continuation',
      '--tag', 'task',
      '--goal-id', 'OBL-930',
      '--json',
    ], { cwd: dir, env });
    assert.equal(continueCreated.status, 0, continueCreated.stderr);
    const continueTask = JSON.parse(continueCreated.stdout).task;
    const continueRef = continueTask.display_id;
    assert.equal(runCli([
      'task', 'ready', continueRef,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before API review lane drain',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', continueRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during API review lane drain',
      '--next', 'Add a scoped API review drain follow-up',
    ], { cwd: dir, env }).status, 0);

    const waitingCreated = runCli([
      'task', 'new', 'API drain row waiting on human accept',
      '--tag', 'task',
      '--goal-id', 'OBL-930',
      '--json',
    ], { cwd: dir, env });
    assert.equal(waitingCreated.status, 0, waitingCreated.stderr);
    const waitingTask = JSON.parse(waitingCreated.stdout).task;
    const waitingRef = waitingTask.display_id;
    assert.equal(runCli([
      'task', 'ready', waitingRef,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before API human accept wait drain',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', waitingRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during API human accept wait drain',
    ], { cwd: dir, env }).status, 0);

    const humanOnlyCreated = runCli([
      'task', 'new', 'API act row waiting on human accept',
      '--tag', 'task',
      '--goal-id', 'OBL-931',
      '--json',
    ], { cwd: dir, env });
    assert.equal(humanOnlyCreated.status, 0, humanOnlyCreated.stderr);
    const humanOnlyRef = JSON.parse(humanOnlyCreated.stdout).task.display_id;
    assert.equal(runCli([
      'task', 'ready', humanOnlyRef,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before API review-lane-act human block',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', humanOnlyRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during API review-lane-act human block',
    ], { cwd: dir, env }).status, 0);

    const runContinueCreated = runCli([
      'task', 'new', 'API run should continue one certified task',
      '--tag', 'task',
      '--goal-id', 'OBL-932',
      '--json',
    ], { cwd: dir, env });
    assert.equal(runContinueCreated.status, 0, runContinueCreated.stderr);
    const runContinueRef = JSON.parse(runContinueCreated.stdout).task.display_id;
    assert.equal(runCli([
      'task', 'ready', runContinueRef,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before API review-lane-run continuation',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', runContinueRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during API review-lane-run continuation',
      '--next', 'Add a follow-up created by API review lane run',
    ], { cwd: dir, env }).status, 0);

    const runWaitingCreated = runCli([
      'task', 'new', 'API run should stop on human accept wait',
      '--tag', 'task',
      '--goal-id', 'OBL-932',
      '--json',
    ], { cwd: dir, env });
    assert.equal(runWaitingCreated.status, 0, runWaitingCreated.stderr);
    const runWaitingRef = JSON.parse(runWaitingCreated.stdout).task.display_id;
    assert.equal(runCli([
      'task', 'ready', runWaitingRef,
      '--as', 'codex',
      '--proof', 'node --check test/commands.test.js passed before API review-lane-run human gate',
    ], { cwd: dir, env }).status, 0);
    assert.equal(runCli([
      'task', 'review', runWaitingRef,
      '--reward', '0',
      '--as', 'codex-review',
      '--proof', 'node --test test/commands.test.js passed during API review-lane-run human gate',
    ], { cwd: dir, env }).status, 0);

    child = spawn(process.execPath, [cliPath, 'task', 'serve', '--host', '127.0.0.1', '--port', '0'], {
      cwd: dir,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const readyServer = await waitForOutput(child, /Task board: (http:\/\/127\.0\.0\.1:\d+)/);
    const base = readyServer.match[1];

    const capabilities = await fetch(`${base}/api/tasks/capabilities`).then(r => r.json());
    assert.equal(capabilities.ok, true);
    assert.equal(capabilities.capabilities.commands.review_lane_drain, 'atris task review-lane-drain --json');
    assert.equal(capabilities.capabilities.commands.review_lane_act, 'atris task review-lane-act --json');
    assert.equal(capabilities.capabilities.commands.review_lane_loop, 'atris task review-lane-loop --json');
    assert.equal(capabilities.capabilities.commands.review_lane_run, 'atris task review-lane-run --json');
    assert.deepEqual(capabilities.capabilities.surfaces.review_lane_drain.api, { method: 'GET', path: '/api/tasks/review-lane-drain' });
    assert.deepEqual(capabilities.capabilities.surfaces.review_lane_act.api, { method: 'POST', path: '/api/tasks/review-lane-act' });
    assert.deepEqual(capabilities.capabilities.surfaces.review_lane_loop.api, { method: 'POST', path: '/api/tasks/review-lane-loop' });
    assert.deepEqual(capabilities.capabilities.surfaces.review_lane_run.api, { method: 'POST', path: '/api/tasks/review-lane-run' });

    const response = await fetch(`${base}/api/tasks/review-lane-drain?goal_id=OBL-930`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    const continueCommand = `atris task continue-work ${continueRef} --as codex --json`;
    assert.equal(payload.ok, true);
    assert.equal(payload.action, 'review_lane_drain');
    assert.equal(payload.capabilities_check.ok, true);
    assert.equal(payload.drain.next_action, 'continue_work');
    assert.equal(payload.drain.safe_for_agent, true);
    assert.equal(payload.drain.command, continueCommand);
    assert.deepEqual(payload.drain.api, { method: 'POST', path: `/api/tasks/${continueTask.id}/continue-work` });
    assert.equal(payload.review_state_actions.human_accept_waiting.id, waitingTask.id);
    assert.equal(payload.review_state_actions.human_accept_waiting.command, null);
    assert.equal(payload.review_state_actions.human_accept_waiting.api, null);
    assert.equal(payload.drain.human_accept_waiting.command, null);
    assert.equal(payload.drain.human_accept_waiting.api, null);
    assert.equal(payload.safety.human_accept, false);

    const actDryRun = await fetch(`${base}/api/tasks/review-lane-act?goal_id=OBL-930`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', dry_run: true }),
    }).then(r => r.json());
    assert.equal(actDryRun.ok, true);
    assert.equal(actDryRun.action, 'review_lane_act');
    assert.equal(actDryRun.dry_run, true);
    assert.equal(actDryRun.acted, false);
    assert.equal(actDryRun.decision.step_action, 'continue_work');
    assert.equal(actDryRun.safety.human_accept, false);

    const loopDryRun = await fetch(`${base}/api/tasks/review-lane-loop?goal_id=OBL-930`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', dry_run: true, max_steps: 3 }),
    }).then(r => r.json());
    assert.equal(loopDryRun.ok, true);
    assert.equal(loopDryRun.action, 'review_lane_loop');
    assert.equal(loopDryRun.dry_run, true);
    assert.equal(loopDryRun.acted_count, 0);
    assert.equal(loopDryRun.stopped_reason, 'dry_run_preview');
    assert.equal(loopDryRun.steps[0].decision.step_action, 'continue_work');
    assert.equal(loopDryRun.safety.human_accept, false);

    const loopResponse = await fetch(`${base}/api/tasks/review-lane-loop?goal_id=OBL-930`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', max_steps: 3 }),
    });
    assert.equal(loopResponse.status, 200);
    const loopPayload = await loopResponse.json();
    assert.equal(loopPayload.ok, true);
    assert.equal(loopPayload.acted_count, 1);
    assert.equal(loopPayload.steps[0].selected_action, 'continue_work');
    assert.ok(loopPayload.steps[0].result.next_task_id);
    assert.equal(loopPayload.stopped_reason, 'human_accept_waiting_is_human_only');
    assert.equal(loopPayload.final_drain.next_action, 'human_accept_waiting');
    assert.equal(loopPayload.final_drain.command, null);
    assert.equal(loopPayload.final_drain.api, null);
    assert.equal(loopPayload.safety.human_accept, false);

    const apiRealDir = fs.realpathSync(dir);
    const apiRunReceiptPath = path.join(apiRealDir, '.atris', 'state', 'review-lane-runs.jsonl');
    const apiRunLatestPath = path.join(apiRealDir, '.atris', 'state', 'review-lane-run.latest.json');
    const runDryRun = await fetch(`${base}/api/tasks/review-lane-run?goal_id=OBL-932`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', dry_run: true, max_runs: 2, max_steps: 1 }),
    }).then(r => r.json());
    assert.equal(runDryRun.ok, true);
    assert.equal(runDryRun.action, 'review_lane_run');
    assert.equal(runDryRun.dry_run, true);
    assert.equal(runDryRun.run_count, 1);
    assert.equal(runDryRun.total_acted_count, 0);
    assert.equal(runDryRun.stopped_reason, 'dry_run_preview');
    assert.equal(runDryRun.receipt_written, false);
    assert.equal(runDryRun.would_write_receipt_path, apiRunReceiptPath);
    assert.equal(fs.existsSync(apiRunReceiptPath), false);

    const beforeRunWaiting = JSON.parse(runCli(['task', 'show', runWaitingRef, '--json'], { cwd: dir, env }).stdout);
    const runResponse = await fetch(`${base}/api/tasks/review-lane-run?goal_id=OBL-932`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', max_runs: 2, max_steps: 1 }),
    });
    assert.equal(runResponse.status, 200);
    const runPayload = await runResponse.json();
    assert.equal(runPayload.ok, true);
    assert.equal(runPayload.run_count, 2);
    assert.equal(runPayload.total_acted_count, 1);
    assert.equal(runPayload.runs[0].stopped_reason, 'max_steps_reached');
    assert.equal(runPayload.runs[0].steps[0].selected_action, 'continue_work');
    assert.equal(runPayload.stopped_reason, 'human_accept_waiting_is_human_only');
    assert.equal(runPayload.receipt_written, true);
    assert.equal(runPayload.receipt_path, apiRunReceiptPath);
    assert.equal(runPayload.latest_receipt_path, apiRunLatestPath);
    assert.equal(runPayload.safety.human_accept, false);
    assert.equal(fs.existsSync(apiRunReceiptPath), true);
    assert.equal(fs.existsSync(apiRunLatestPath), true);
    const afterRunWaiting = JSON.parse(runCli(['task', 'show', runWaitingRef, '--json'], { cwd: dir, env }).stdout);
    assert.equal(afterRunWaiting.current_version, beforeRunWaiting.current_version);

    const actResponse = await fetch(`${base}/api/tasks/review-lane-act?goal_id=OBL-930`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex' }),
    });
    assert.equal(actResponse.status, 409);
    const actPayload = await actResponse.json();
    assert.equal(actPayload.ok, false);
    assert.equal(actPayload.acted, false);
    assert.equal(actPayload.reason, 'human_accept_waiting_is_human_only');
    assert.equal(actPayload.drain.command, null);
    assert.equal(actPayload.drain.api, null);
    assert.equal(actPayload.safety.human_accept, false);

    const blockedResponse = await fetch(`${base}/api/tasks/review-lane-act?goal_id=OBL-931`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex' }),
    });
    assert.equal(blockedResponse.status, 409);
    const blockedPayload = await blockedResponse.json();
    assert.equal(blockedPayload.ok, false);
    assert.equal(blockedPayload.acted, false);
    assert.equal(blockedPayload.reason, 'human_accept_waiting_is_human_only');
    assert.equal(blockedPayload.drain.command, null);
    assert.equal(blockedPayload.drain.api, null);
    assert.equal(blockedPayload.safety.human_accept, false);

    const blockedLoopResponse = await fetch(`${base}/api/tasks/review-lane-loop?goal_id=OBL-931`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', max_steps: 3 }),
    });
    assert.equal(blockedLoopResponse.status, 200);
    const blockedLoop = await blockedLoopResponse.json();
    assert.equal(blockedLoop.ok, true);
    assert.equal(blockedLoop.acted_count, 0);
    assert.equal(blockedLoop.stopped_reason, 'human_accept_waiting_is_human_only');
    assert.equal(blockedLoop.final_drain.command, null);
    assert.equal(blockedLoop.final_drain.api, null);
    assert.equal(blockedLoop.safety.human_accept, false);
  } finally {
    if (child) child.kill('SIGTERM');
    cleanupTempDir(dir);
  }
});


test('task serve exposes a local task factory API', async () => {
  if (!hasNodeSqlite()) return;
  const dir = makeTempDir();
  const dbPath = path.join(dir, 'tasks.db');
  const env = { ATRIS_TASKS_DB: dbPath, NODE_NO_WARNINGS: '1', ATRIS_SKIP_UPDATE_CHECK: '1' };
  let child = null;
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    child = spawn(process.execPath, [cliPath, 'task', 'serve', '--host', '127.0.0.1', '--port', '0'], {
      cwd: dir,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const ready = await waitForOutput(child, /Task board: (http:\/\/127\.0\.0\.1:\d+)/);
    const base = ready.match[1];

	    const html = await fetch(base).then(r => r.text());
	    assert.match(html, /Atris Task Factory/);
	    // heartbeat strip + live activity stream (replaced the old smoke placeholder)
	    assert.match(html, /class="beat" id="heartbeat"/);
	    assert.match(html, /class="activity" id="activity"/);
	    assert.match(html, /async function loadStream\(\)/);
	    assert.match(html, /\/api\/tasks\/' \+ task\.id \+ '\/ready/);
	    assert.match(html, /\/api\/tasks\/' \+ task\.id \+ '\/accept/);
	    assert.match(html, /if \(lesson\) payload\.lesson = lesson/);
	    assert.match(html, /if \(nextTask\) payload\.next = nextTask/);
	    assert.match(html, /task\.review && task\.review\.next_task/);
	    assert.doesNotMatch(html, /\/api\/tasks\/' \+ task\.id \+ '\/finish/);

    // the activity stream endpoint returns a heartbeat + an events array
    const stream = await fetch(`${base}/api/stream`).then(r => r.json());
    assert.equal(stream.ok, true);
    assert.ok(stream.heartbeat && typeof stream.heartbeat.state === 'string');
    assert.ok(Array.isArray(stream.events));

    const created = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Ship the task factory board', tag: 'factory' }),
    }).then(r => r.json());
    assert.equal(created.ok, true);
    assert.equal(created.task.title, 'Ship the task factory board');

    const claimed = await fetch(`${base}/api/tasks/${created.task_id.slice(0, 8)}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: 'swarlo' }),
    }).then(r => r.json());
    assert.equal(claimed.ok, true);
    assert.equal(claimed.task.claimed_by, 'swarlo');

	    const noted = await fetch(`${base}/api/tasks/${created.task_id}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'operator', content: 'Looks good in the board' }),
    }).then(r => r.json());
	    assert.equal(noted.ok, true);
	    assert.equal(noted.task.messages[0].content, 'Looks good in the board');

	    const missingFinishProofResponse = await fetch(`${base}/api/tasks/${created.task_id}/finish`, {
	      method: 'POST',
	      headers: { 'content-type': 'application/json' },
	      body: JSON.stringify({ actor: 'operator' }),
	    });
	    assert.equal(missingFinishProofResponse.status, 400);
	    const missingFinishProof = await missingFinishProofResponse.json();
	    assert.equal(missingFinishProof.reason, 'proof_required');

	    const weakFinishProofResponse = await fetch(`${base}/api/tasks/${created.task_id}/finish`, {
	      method: 'POST',
	      headers: { 'content-type': 'application/json' },
	      body: JSON.stringify({ actor: 'operator', proof: 'done' }),
	    });
	    assert.equal(weakFinishProofResponse.status, 400);
	    const weakFinishProof = await weakFinishProofResponse.json();
	    assert.equal(weakFinishProof.reason, 'weak_proof');

	    const finished = await fetch(`${base}/api/tasks/${created.task_id}/finish`, {
	      method: 'POST',
	      headers: { 'content-type': 'application/json' },
	      body: JSON.stringify({
	        actor: 'operator',
	        proof: 'node --test test/commands.test.js passed for task serve API',
	        lesson: 'Task factory API can drive the board',
	        next: 'Connect the board to Swarlo leases',
	        createNext: true,
      }),
    }).then(r => r.json());
    assert.equal(finished.ok, true);
    assert.equal(finished.task.status, 'done');
    assert.equal(finished.episode.career_xp.eligible, false);
    assert.equal(finished.xp_projection.total_xp, 0);
    assert.ok(finished.next_task_id);

    const apiReview = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Reject stale API proof after revise', tag: 'factory' }),
    }).then(r => r.json());
    assert.equal(apiReview.ok, true);
    const apiReviewId = apiReview.task_id;
    const earlyApiReviewChatResponse = await fetch(`${base}/api/tasks/${apiReviewId}/review-chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex-review' }),
    });
    assert.equal(earlyApiReviewChatResponse.status, 409);
    assert.equal((await earlyApiReviewChatResponse.json()).reason, 'not_reviewable_open');

    const apiStage = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Drive plan do review through API', tag: 'factory' }),
    }).then(r => r.json());
    assert.equal(apiStage.ok, true);
    const apiStageId = apiStage.task_id;

    const apiChatTask = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Refine API task chat', tag: 'capture' }),
    }).then(r => r.json());
    assert.equal(apiChatTask.ok, true);
    const apiEmptyChatResponse = await fetch(`${base}/api/tasks/${apiChatTask.task_id}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'operator' }),
    });
    assert.equal(apiEmptyChatResponse.status, 400);
    assert.equal((await apiEmptyChatResponse.json()).reason, 'content_required');
    const apiChat = await fetch(`${base}/api/tasks/${apiChatTask.task_id}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'operator',
        content: 'Make this task useful before planning',
        goal: 'API chat seeds the task goal',
        summary: 'chat narrowed the task',
      }),
    }).then(r => r.json());
    assert.equal(apiChat.ok, true);
    assert.equal(apiChat.action, 'chatted');
    assert.equal(apiChat.task.objective, 'API chat seeds the task goal');
    assert.equal(apiChat.task.metadata.task_goal, 'API chat seeds the task goal');
    assert.ok(apiChat.task.messages.some(message => message.content.includes('TASK_CHAT_UPDATE')));
    const apiChatPlan = await fetch(`${base}/api/tasks/${apiChatTask.task_id}/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex',
        exit: 'API chat plan can use the refined goal',
        proof_needed: 'node --test API chat coverage passes',
      }),
    }).then(r => r.json());
    assert.equal(apiChatPlan.ok, true);
    assert.match(apiChatPlan.stage_packet, /goal: API chat seeds the task goal/);
    const apiChatBacklog = await fetch(`${base}/api/tasks/${apiChatTask.task_id}/backlog`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', reason: 'preserve task goal while clearing plan' }),
    }).then(r => r.json());
    assert.equal(apiChatBacklog.ok, true);
    assert.equal(apiChatBacklog.task.metadata.task_goal, 'API chat seeds the task goal');
    assert.equal(apiChatBacklog.task.metadata.goal_objective, undefined);

    const apiStepTask = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Drive API task step', tag: 'capture' }),
    }).then(r => r.json());
    assert.equal(apiStepTask.ok, true);
    const apiStepPlanned = await fetch(`${base}/api/tasks/${apiStepTask.task_id}/step`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex',
        message: 'Refine this API step task before plan',
        goal: 'API step drives Plan Do Review',
        summary: 'step includes chat before plan',
        exit: 'API step returns the next page action',
        proof_needed: 'node --test test/commands.test.js passes API step coverage',
      }),
    }).then(r => r.json());
    assert.equal(apiStepPlanned.ok, true);
    assert.equal(apiStepPlanned.action, 'stepped');
    assert.equal(apiStepPlanned.step_action, 'planned');
    assert.equal(apiStepPlanned.chat.action, 'chatted');
    assert.equal(apiStepPlanned.page.stage.current, 'plan');
    assert.equal(apiStepPlanned.page.stage.next_action.key, 'do');
    assert.equal(apiStepPlanned.page.api.step, `/api/tasks/${apiStepTask.task_id}/step`);

    const apiStepDoing = await fetch(`${base}/api/tasks/${apiStepTask.task_id}/step`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', first_move: 'run API step smoke' }),
    }).then(r => r.json());
    assert.equal(apiStepDoing.ok, true);
    assert.equal(apiStepDoing.step_action, 'doing');
    assert.equal(apiStepDoing.page.stage.current, 'do');

    const apiStepReady = await fetch(`${base}/api/tasks/${apiStepTask.task_id}/step`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex',
        proof: 'node --check test/commands.test.js passed for API task step',
        lesson: 'API step keeps accept human-only',
      }),
    }).then(r => r.json());
    assert.equal(apiStepReady.ok, true);
    assert.equal(apiStepReady.step_action, 'ready');
    assert.equal(apiStepReady.page.stage.current, 'review');
    assert.equal(apiStepReady.page.stage.next_action.key, 'review_chat');
    assert.notEqual(apiStepReady.page.stage.next_action.command, apiStepReady.page.review.human_accept.command);

    const apiStepReviewChat = await fetch(`${base}/api/tasks/${apiStepTask.task_id}/step`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reviewer: 'codex-review' }),
    }).then(r => r.json());
	    assert.equal(apiStepReviewChat.ok, true);
	    assert.equal(apiStepReviewChat.step_action, 'review_chat');
	    assert.equal(apiStepReviewChat.contract.schema, 'atris.task_review_chat.v1');
	    assert.equal(apiStepReviewChat.page.task.status, 'review');

	    const apiScopedAdd = runCli([
	      'task', 'add', 'Scoped API current task',
	      '--tag', 'api-scope',
	      '--goal-id', 'OBL-928',
	      '--json',
	    ], { cwd: dir, env });
	    assert.equal(apiScopedAdd.status, 0, apiScopedAdd.stderr);
	    const apiScopedTask = JSON.parse(apiScopedAdd.stdout).task;

	    const apiCurrent = await fetch(`${base}/api/tasks/current?owner=codex&reviewer=codex-review`).then(r => r.json());
	    assert.equal(apiCurrent.ok, true);
	    assert.equal(apiCurrent.action, 'current');
	    assert.equal(apiCurrent.current.schema, 'atris.task_current.v1');
	    assert.equal(apiCurrent.current.safety.read_only, true);
	    assert.equal(apiCurrent.current.safety.claims_work, false);
	    assert.equal(apiCurrent.current.safety.human_accept, false);
	    assert.equal(apiCurrent.current.selected_task_id, apiStepTask.task_id);
	    assert.equal(apiCurrent.page.stage.current, 'review');
	    assert.equal(apiCurrent.current.next.key, 'review_chat');
	    assert.equal(apiCurrent.current.next.step_api, `/api/tasks/${apiStepTask.task_id}/step`);
	    assert.equal(apiCurrent.queue.schema, 'atris.task_queue.v1');
	    assert.ok(apiCurrent.queue.counts.review >= 1);

	    const apiCapabilities = await fetch(`${base}/api/tasks/capabilities`).then(r => r.json());
	    assert.equal(apiCapabilities.ok, true);
	    assert.equal(apiCapabilities.action, 'capabilities');
	    assert.deepEqual(apiCapabilities.capabilities, apiCurrent.current.capabilities);
	    assert.equal(apiCapabilities.safety.read_only, true);
	    assert.equal(apiCapabilities.safety.claims_work, false);
	    assert.equal(apiCapabilities.safety.human_accept, false);
	    assert.equal(apiCapabilities.safety.xp_after_human_accept, true);
	    assert.equal(apiCapabilities.projection_path, undefined);

	    const apiCapabilitiesCheck = await fetch(`${base}/api/tasks/capabilities/check?owner=codex`).then(r => r.json());
	    assert.equal(apiCapabilitiesCheck.ok, true);
	    assert.equal(apiCapabilitiesCheck.action, 'capabilities_check');
	    assert.equal(apiCapabilitiesCheck.schema, 'atris.task_capabilities_check.v1');
	    assert.deepEqual(apiCapabilitiesCheck.capabilities, apiCurrent.current.capabilities);
	    assert.equal(apiCapabilitiesCheck.summary.failed, 0);
	    assert.equal(apiCapabilitiesCheck.safety.mutates_task_db, false);
	    assert.equal(apiCapabilitiesCheck.safety.writes_projection, true);
	    assert.ok(apiCapabilitiesCheck.checks.some(check => check.name === 'current_queue_capabilities_match' && check.ok));
	    assert.ok(apiCapabilitiesCheck.checks.some(check => check.name === 'read_only_projection_semantics_declared' && check.ok));
	    assert.ok(apiCapabilitiesCheck.checks.some(check => check.name === 'capabilities_check_surface_declared' && check.ok));

	    assert.equal(runCli(['task', 'claim', apiScopedTask.display_id, '--as', 'codex'], { cwd: dir, env }).status, 0);
	    const apiScopedCurrent = await fetch(`${base}/api/tasks/current?owner=codex&goal_id=OBL-928`).then(r => r.json());
	    assert.equal(apiScopedCurrent.ok, true);
	    assert.equal(apiScopedCurrent.current.scope.goal_id, 'OBL-928');
	    assert.equal(apiScopedCurrent.current.selected_task_id, apiScopedTask.id);
	    assert.equal(apiScopedCurrent.current.selected_reason, 'claimed_by_owner');
	    assert.equal(apiScopedCurrent.queue.counts.total, 1);
	    assert.equal(apiScopedCurrent.queue.counts.review, 0);
	    assert.equal(apiScopedCurrent.page.task.ref, apiScopedTask.display_id);

	    const apiScopedQueue = await fetch(`${base}/api/tasks/queue?goal_id=OBL-928&tag=api-scope`).then(r => r.json());
	    assert.equal(apiScopedQueue.ok, true);
	    assert.equal(apiScopedQueue.queue.scope.goal_id, 'OBL-928');
	    assert.equal(apiScopedQueue.queue.scope.tag, 'api-scope');
	    assert.equal(apiScopedQueue.queue.counts.total, 1);
	    assert.equal(apiScopedQueue.queue.columns.find(column => column.key === 'do').items[0].id, apiScopedTask.id);

	    const apiStatusCurrent = await fetch(`${base}/api/tasks/current?status=review&review_state=needs-agent`).then(r => r.json());
		    assert.equal(apiStatusCurrent.ok, true);
		    assert.equal(apiStatusCurrent.current.scope.status, 'review');
		    assert.equal(apiStatusCurrent.current.scope.review_state, 'needs-agent');
			    assert.equal(apiStatusCurrent.current.selected_task_id, apiStepTask.task_id);
			    assert.equal(apiStatusCurrent.current.next.key, 'review_chat');
			    assert.equal(apiStatusCurrent.selected.continue_work_command, undefined);
			    assert.equal(apiStatusCurrent.selected.commands.continue_work, undefined);
			    assert.deepEqual(apiStatusCurrent.current.capabilities, apiStatusCurrent.queue.capabilities);
			    assert.equal(apiStatusCurrent.current.capabilities.schema, 'atris.task_capabilities.v1');
			    assert.deepEqual(apiStatusCurrent.current.capabilities.filters.review_state.accepted, ['needs-agent', 'continue-work', 'proof-boundary-blocked', 'human-accept-waiting', 'certified']);
			    assert.equal(apiStatusCurrent.current.capabilities.current_step.lanes['needs-agent'].step_action, 'review_chat');
			    assert.equal(apiStatusCurrent.current.capabilities.current_step.safety.claims_work, 'conditional');
			    assert.equal(apiStatusCurrent.current.capabilities.current_step.stage_safety.plan.claims_work, true);
			    assert.equal(apiStatusCurrent.current.review_state_counts.active_filter, 'needs-agent');
			    assert.equal(apiStatusCurrent.current.review_state_counts.scope.status, 'review');
			    assert.equal(apiStatusCurrent.current.review_state_counts.scope.review_state, null);
		    assert.equal(apiStatusCurrent.current.review_state_counts.total, 1);
		    assert.equal(apiStatusCurrent.current.review_state_counts.needs_agent, 1);
		    assert.deepEqual(apiStatusCurrent.current.review_state_actions, apiStatusCurrent.queue.review_state_actions);
		    assert.equal(apiStatusCurrent.current.review_state_actions.active_filter, 'needs-agent');
		    assert.equal(apiStatusCurrent.current.review_state_actions.scope.status, 'review');
		    assert.equal(apiStatusCurrent.current.review_state_actions.scope.review_state, null);
			    assert.equal(apiStatusCurrent.current.review_state_actions.needs_agent, null);
			    assert.equal(apiStatusCurrent.current.review_state_actions.pending_review_chat_count, 1);
			    assert.equal(apiStatusCurrent.current.review_state_actions.pending_review_chat[0].id, apiStepTask.task_id);
			    assert.equal(apiStatusCurrent.current.review_state_actions.pending_review_chat[0].next_action, 'pending_review_chat');
			    assert.equal(apiStatusCurrent.current.review_state_actions.pending_review_chat[0].command, null);
			    assert.equal(apiStatusCurrent.current.review_state_actions.pending_review_chat[0].api, null);
			    assert.equal(apiStatusCurrent.current.review_state_actions.continue_work, null);
			    assert.equal(apiStatusCurrent.current.review_state_actions.human_accept_waiting, null);

		    const apiNeedsAgentQueue = await fetch(`${base}/api/tasks/queue?status=review&review_state=needs-agent`).then(r => r.json());
		    assert.equal(apiNeedsAgentQueue.ok, true);
		    assert.equal(apiNeedsAgentQueue.action, 'queue');
		    assert.equal(apiNeedsAgentQueue.current.scope.status, 'review');
		    assert.equal(apiNeedsAgentQueue.current.scope.review_state, 'needs-agent');
		    assert.equal(apiNeedsAgentQueue.current.selected_task_id, apiStepTask.task_id);
		    assert.equal(apiNeedsAgentQueue.current.next.key, 'review_chat');
		    assert.equal(apiNeedsAgentQueue.queue.scope.status, 'review');
		    assert.equal(apiNeedsAgentQueue.queue.scope.review_state, 'needs-agent');
		    assert.equal(apiNeedsAgentQueue.queue.counts.total, 1);
		    assert.equal(apiNeedsAgentQueue.queue.counts.review, 1);
		    assert.deepEqual(apiNeedsAgentQueue.current.review_state_counts, apiNeedsAgentQueue.queue.review_state_counts);
		    assert.equal(apiNeedsAgentQueue.queue.review_state_counts.total, 1);
		    assert.equal(apiNeedsAgentQueue.queue.review_state_counts.needs_agent, 1);
		    assert.deepEqual(apiNeedsAgentQueue.current.review_state_actions, apiNeedsAgentQueue.queue.review_state_actions);
		    assert.equal(apiNeedsAgentQueue.queue.review_state_actions.active_filter, 'needs-agent');
			    assert.equal(apiNeedsAgentQueue.queue.review_state_actions.needs_agent, null);
			    assert.equal(apiNeedsAgentQueue.queue.review_state_actions.pending_review_chat_count, 1);
			    assert.equal(apiNeedsAgentQueue.queue.review_state_actions.pending_review_chat[0].id, apiStepTask.task_id);
			    assert.equal(apiNeedsAgentQueue.queue.review_state_actions.pending_review_chat[0].next_action, 'pending_review_chat');
			    assert.equal(apiNeedsAgentQueue.queue.review_state_actions.pending_review_chat[0].command, null);
		    const apiNeedsAgentItem = apiNeedsAgentQueue.queue.columns.find(column => column.key === 'review').items[0];
		    assert.equal(apiNeedsAgentItem.id, apiStepTask.task_id);
		    assert.equal(apiNeedsAgentItem.continue_work_command, undefined);
		    assert.equal(apiNeedsAgentItem.commands.continue_work, undefined);

	    const apiContinueCreated = runCli([
	      'task', 'add', 'API certified task with continuation action',
	      '--tag', 'api-review-state',
	      '--goal-id', 'OBL-934',
	      '--json',
	    ], { cwd: dir, env });
	    assert.equal(apiContinueCreated.status, 0, apiContinueCreated.stderr);
	    const apiContinueTask = JSON.parse(apiContinueCreated.stdout).task;
	    assert.equal(runCli(['task', 'claim', apiContinueTask.display_id, '--as', 'codex'], { cwd: dir, env }).status, 0);
	    assert.equal(runCli([
	      'task', 'ready', apiContinueTask.display_id,
	      '--as', 'codex',
	      '--proof', 'node --check test/commands.test.js passed before API continue-work filter',
	    ], { cwd: dir, env }).status, 0);
	    assert.equal(runCli([
	      'task', 'review', apiContinueTask.display_id,
	      '--reward', '0',
	      '--as', 'codex-review',
	      '--proof', 'node --test test/commands.test.js passed during API continue-work filter',
	      '--next', 'Run the API continuation follow-up',
	    ], { cwd: dir, env }).status, 0);

	    const apiWaitingCreated = runCli([
	      'task', 'add', 'API certified task waiting for human accept',
	      '--tag', 'api-review-state',
	      '--goal-id', 'OBL-934',
	      '--json',
	    ], { cwd: dir, env });
	    assert.equal(apiWaitingCreated.status, 0, apiWaitingCreated.stderr);
	    const apiWaitingTask = JSON.parse(apiWaitingCreated.stdout).task;
	    assert.equal(runCli(['task', 'claim', apiWaitingTask.display_id, '--as', 'codex'], { cwd: dir, env }).status, 0);
	    assert.equal(runCli([
	      'task', 'ready', apiWaitingTask.display_id,
	      '--as', 'codex',
	      '--proof', 'node --check test/commands.test.js passed before API human-accept filter',
	    ], { cwd: dir, env }).status, 0);
	    assert.equal(runCli([
	      'task', 'review', apiWaitingTask.display_id,
	      '--reward', '0',
	      '--as', 'codex-review',
	      '--proof', 'node --test test/commands.test.js passed during API human-accept filter',
	    ], { cwd: dir, env }).status, 0);

	    const apiContinueCommand = `atris task continue-work ${apiContinueTask.display_id} --as codex --json`;
	    const apiContinueCurrent = await fetch(`${base}/api/tasks/current?owner=codex&goal_id=OBL-934&review_state=continue-work`).then(r => r.json());
	    assert.equal(apiContinueCurrent.ok, true);
	    assert.equal(apiContinueCurrent.current.scope.goal_id, 'OBL-934');
	    assert.equal(apiContinueCurrent.current.scope.review_state, 'continue-work');
	    assert.equal(apiContinueCurrent.current.selected_task_id, apiContinueTask.id);
	    assert.equal(apiContinueCurrent.current.next.key, 'continue_work');
	    assert.equal(apiContinueCurrent.current.next.command, apiContinueCommand);
	    assert.deepEqual(apiContinueCurrent.current.next.api, { method: 'POST', path: `/api/tasks/${apiContinueTask.id}/continue-work` });
	    assert.equal(apiContinueCurrent.selected.continue_work_command, apiContinueCommand);
		    assert.deepEqual(apiContinueCurrent.selected.api.next_action, { method: 'POST', path: `/api/tasks/${apiContinueTask.id}/continue-work` });
		    assert.equal(apiContinueCurrent.current.safety.read_only, true);
		    assert.equal(apiContinueCurrent.current.safety.human_accept, false);
		    assert.deepEqual(apiContinueCurrent.current.capabilities, apiContinueCurrent.queue.capabilities);
		    assert.equal(apiContinueCurrent.current.capabilities.current_step.lanes['continue-work'].creates_or_reuses_follow_up, true);
		    assert.equal(apiContinueCurrent.current.capabilities.current_step.lanes['human-accept-waiting'].reason, 'agent_certified_waiting_human');
		    assert.equal(apiContinueCurrent.current.review_state_counts.active_filter, 'continue-work');
		    assert.equal(apiContinueCurrent.current.review_state_counts.scope.goal_id, 'OBL-934');
		    assert.equal(apiContinueCurrent.current.review_state_counts.scope.review_state, null);
	    assert.equal(apiContinueCurrent.current.review_state_counts.total, 2);
	    assert.equal(apiContinueCurrent.current.review_state_counts.continue_work, 1);
	    assert.equal(apiContinueCurrent.current.review_state_counts.human_accept_waiting, 1);
	    assert.equal(apiContinueCurrent.current.review_state_counts.certified, 2);
	    assert.deepEqual(apiContinueCurrent.current.review_state_actions, apiContinueCurrent.queue.review_state_actions);
	    assert.equal(apiContinueCurrent.current.review_state_actions.active_filter, 'continue-work');
	    assert.equal(apiContinueCurrent.current.review_state_actions.scope.goal_id, 'OBL-934');
	    assert.equal(apiContinueCurrent.current.review_state_actions.scope.review_state, null);
	    assert.equal(apiContinueCurrent.current.review_state_actions.continue_work.id, apiContinueTask.id);
	    assert.equal(apiContinueCurrent.current.review_state_actions.continue_work.next_action, 'continue_work');
	    assert.equal(apiContinueCurrent.current.review_state_actions.continue_work.command, apiContinueCommand);
	    assert.deepEqual(apiContinueCurrent.current.review_state_actions.continue_work.api, { method: 'POST', path: `/api/tasks/${apiContinueTask.id}/continue-work` });
	    assert.equal(apiContinueCurrent.current.review_state_actions.continue_work.continue_work_command, apiContinueCommand);
	    assert.equal(apiContinueCurrent.current.review_state_actions.human_accept_waiting.id, apiWaitingTask.id);
	    assert.equal(apiContinueCurrent.current.review_state_actions.human_accept_waiting.next_action, 'human_accept_waiting');
	    assert.equal(apiContinueCurrent.current.review_state_actions.human_accept_waiting.command, null);
	    assert.equal(apiContinueCurrent.current.review_state_actions.human_accept_waiting.api, null);
	    assert.equal(apiContinueCurrent.current.review_state_actions.human_accept_waiting.human_accept.human_only, true);

		    const apiContinueQueue = await fetch(`${base}/api/tasks/queue?goal_id=OBL-934&review_state=continue-work`).then(r => r.json());
		    assert.equal(apiContinueQueue.ok, true);
		    assert.equal(apiContinueQueue.action, 'queue');
		    assert.equal(apiContinueQueue.current.scope.review_state, 'continue-work');
		    assert.equal(apiContinueQueue.current.selected_task_id, apiContinueTask.id);
		    assert.equal(apiContinueQueue.current.next.key, 'continue_work');
		    assert.equal(apiContinueQueue.current.next.command, apiContinueCommand);
		    assert.equal(apiContinueQueue.queue.scope.review_state, 'continue-work');
		    assert.equal(apiContinueQueue.queue.counts.total, 1);
		    assert.equal(apiContinueQueue.queue.counts.review, 1);
		    assert.deepEqual(apiContinueQueue.current.review_state_counts, apiContinueQueue.queue.review_state_counts);
		    assert.equal(apiContinueQueue.queue.review_state_counts.total, 2);
		    assert.equal(apiContinueQueue.queue.review_state_counts.continue_work, 1);
		    assert.equal(apiContinueQueue.queue.review_state_counts.human_accept_waiting, 1);
		    assert.deepEqual(apiContinueQueue.current.review_state_actions, apiContinueQueue.queue.review_state_actions);
		    assert.equal(apiContinueQueue.queue.review_state_actions.active_filter, 'continue-work');
		    assert.equal(apiContinueQueue.queue.review_state_actions.continue_work.id, apiContinueTask.id);
		    assert.equal(apiContinueQueue.queue.review_state_actions.continue_work.command, apiContinueCommand);
		    assert.equal(apiContinueQueue.queue.review_state_actions.human_accept_waiting.id, apiWaitingTask.id);
		    assert.equal(apiContinueQueue.queue.review_state_actions.human_accept_waiting.command, null);
		    assert.equal(apiContinueQueue.queue.columns.find(column => column.key === 'review').items[0].id, apiContinueTask.id);
		    assert.equal(apiContinueQueue.queue.columns.find(column => column.key === 'review').items[0].continue_work_command, apiContinueCommand);
		    assert.deepEqual(apiContinueQueue.queue.columns.find(column => column.key === 'review').items[0].api.next_action, { method: 'POST', path: `/api/tasks/${apiContinueTask.id}/continue-work` });

	    const apiWaitingCurrent = await fetch(`${base}/api/tasks/current?owner=codex&goal_id=OBL-934&review_state=human-accept-waiting`).then(r => r.json());
	    assert.equal(apiWaitingCurrent.ok, true);
	    assert.equal(apiWaitingCurrent.current.scope.review_state, 'human-accept-waiting');
	    assert.equal(apiWaitingCurrent.current.selected_task_id, apiWaitingTask.id);
	    assert.equal(apiWaitingCurrent.current.next.key, 'human_accept_waiting');
	    assert.equal(apiWaitingCurrent.current.next.command, null);
	    assert.equal(apiWaitingCurrent.current.next.api, null);
	    assert.equal(apiWaitingCurrent.selected.continue_work_command, undefined);
	    assert.equal(apiWaitingCurrent.selected.commands.continue_work, undefined);
	    assert.equal(apiWaitingCurrent.selected.api.next_action, undefined);
	    assert.equal(apiWaitingCurrent.current.safety.read_only, true);
	    assert.equal(apiWaitingCurrent.current.safety.human_accept, false);
	    assert.equal(apiWaitingCurrent.current.review_state_counts.active_filter, 'human-accept-waiting');
	    assert.equal(apiWaitingCurrent.current.review_state_counts.total, 2);
	    assert.equal(apiWaitingCurrent.current.review_state_counts.continue_work, 1);
	    assert.equal(apiWaitingCurrent.current.review_state_counts.human_accept_waiting, 1);
	    assert.deepEqual(apiWaitingCurrent.current.review_state_actions, apiWaitingCurrent.queue.review_state_actions);
	    assert.equal(apiWaitingCurrent.current.review_state_actions.active_filter, 'human-accept-waiting');
	    assert.equal(apiWaitingCurrent.current.review_state_actions.continue_work.id, apiContinueTask.id);
	    assert.equal(apiWaitingCurrent.current.review_state_actions.continue_work.command, apiContinueCommand);
	    assert.equal(apiWaitingCurrent.current.review_state_actions.human_accept_waiting.id, apiWaitingTask.id);
	    assert.equal(apiWaitingCurrent.current.review_state_actions.human_accept_waiting.next_action, 'human_accept_waiting');
	    assert.equal(apiWaitingCurrent.current.review_state_actions.human_accept_waiting.command, null);
	    assert.equal(apiWaitingCurrent.current.review_state_actions.human_accept_waiting.api, null);

		    const apiWaitingQueue = await fetch(`${base}/api/tasks/queue?goal_id=OBL-934&review_state=human-accept-waiting`).then(r => r.json());
		    assert.equal(apiWaitingQueue.ok, true);
		    assert.equal(apiWaitingQueue.action, 'queue');
		    assert.equal(apiWaitingQueue.current.scope.review_state, 'human-accept-waiting');
		    assert.equal(apiWaitingQueue.current.selected_task_id, apiWaitingTask.id);
		    assert.equal(apiWaitingQueue.current.next.key, 'human_accept_waiting');
		    assert.equal(apiWaitingQueue.current.next.command, null);
		    assert.equal(apiWaitingQueue.queue.scope.review_state, 'human-accept-waiting');
		    assert.equal(apiWaitingQueue.queue.counts.total, 1);
		    assert.equal(apiWaitingQueue.queue.counts.review, 1);
		    assert.deepEqual(apiWaitingQueue.current.review_state_counts, apiWaitingQueue.queue.review_state_counts);
		    assert.equal(apiWaitingQueue.queue.review_state_counts.total, 2);
		    assert.equal(apiWaitingQueue.queue.review_state_counts.certified, 2);
		    assert.deepEqual(apiWaitingQueue.current.review_state_actions, apiWaitingQueue.queue.review_state_actions);
		    assert.equal(apiWaitingQueue.queue.review_state_actions.active_filter, 'human-accept-waiting');
		    assert.equal(apiWaitingQueue.queue.review_state_actions.human_accept_waiting.id, apiWaitingTask.id);
		    assert.equal(apiWaitingQueue.queue.review_state_actions.human_accept_waiting.command, null);
		    const apiWaitingItem = apiWaitingQueue.queue.columns.find(column => column.key === 'review').items[0];
		    assert.equal(apiWaitingItem.id, apiWaitingTask.id);
		    assert.equal(apiWaitingItem.continue_work_command, undefined);
		    assert.equal(apiWaitingItem.commands.continue_work, undefined);
		    assert.equal(apiWaitingItem.api.next_action, undefined);

		    const apiNoNextCurrent = await fetch(`${base}/api/tasks/current?owner=codex&goal_id=OBL-934&review_state=no_next_task`).then(r => r.json());
		    assert.equal(apiNoNextCurrent.ok, true);
		    assert.equal(apiNoNextCurrent.current.scope.review_state, 'no_next_task');
		    assert.equal(apiNoNextCurrent.current.selected_task_id, apiWaitingTask.id);
		    assert.equal(apiNoNextCurrent.current.next.key, 'human_accept_waiting');
		    assert.equal(apiNoNextCurrent.current.next.command, null);
		    assert.equal(apiNoNextCurrent.current.review_state_counts.active_filter, 'no_next_task');
		    assert.equal(apiNoNextCurrent.current.review_state_counts.total, 2);
		    assert.equal(apiNoNextCurrent.current.review_state_counts.human_accept_waiting, 1);
		    assert.equal(apiNoNextCurrent.current.review_state_actions.active_filter, 'no_next_task');
		    assert.equal(apiNoNextCurrent.current.review_state_actions.continue_work.id, apiContinueTask.id);
		    assert.equal(apiNoNextCurrent.current.review_state_actions.human_accept_waiting.id, apiWaitingTask.id);
		    assert.equal(apiNoNextCurrent.current.review_state_actions.human_accept_waiting.command, null);

		    const apiNoNextQueue = await fetch(`${base}/api/tasks/queue?goal_id=OBL-934&review_state=no_next_task`).then(r => r.json());
		    assert.equal(apiNoNextQueue.ok, true);
		    assert.equal(apiNoNextQueue.action, 'queue');
		    assert.equal(apiNoNextQueue.current.scope.review_state, 'no_next_task');
		    assert.equal(apiNoNextQueue.current.selected_task_id, apiWaitingTask.id);
		    assert.equal(apiNoNextQueue.current.next.key, 'human_accept_waiting');
		    assert.equal(apiNoNextQueue.current.next.command, null);
		    assert.equal(apiNoNextQueue.queue.scope.review_state, 'no_next_task');
		    assert.equal(apiNoNextQueue.queue.counts.total, 1);
		    assert.equal(apiNoNextQueue.queue.counts.review, 1);
		    assert.deepEqual(apiNoNextQueue.current.review_state_counts, apiNoNextQueue.queue.review_state_counts);
		    assert.equal(apiNoNextQueue.queue.review_state_counts.total, 2);
		    assert.equal(apiNoNextQueue.queue.review_state_counts.continue_work, 1);
		    assert.equal(apiNoNextQueue.queue.review_state_counts.human_accept_waiting, 1);
		    assert.deepEqual(apiNoNextQueue.current.review_state_actions, apiNoNextQueue.queue.review_state_actions);
		    assert.equal(apiNoNextQueue.queue.review_state_actions.active_filter, 'no_next_task');
		    assert.equal(apiNoNextQueue.queue.review_state_actions.continue_work.id, apiContinueTask.id);
		    assert.equal(apiNoNextQueue.queue.review_state_actions.human_accept_waiting.id, apiWaitingTask.id);
		    assert.equal(apiNoNextQueue.queue.review_state_actions.human_accept_waiting.command, null);
		    const apiNoNextItem = apiNoNextQueue.queue.columns.find(column => column.key === 'review').items[0];
		    assert.equal(apiNoNextItem.id, apiWaitingTask.id);
		    assert.equal(apiNoNextItem.continue_work_command, undefined);
		    assert.equal(apiNoNextItem.commands.continue_work, undefined);

		    const apiCertifiedStepMessageResponse = await fetch(`${base}/api/tasks/${apiContinueTask.id}/step`, {
		      method: 'POST',
		      headers: { 'content-type': 'application/json' },
		      body: JSON.stringify({
		        actor: 'codex',
		        message: 'should not write API certified review',
		        goal: 'API certified review should not be refined by step',
		      }),
		    });
		    assert.equal(apiCertifiedStepMessageResponse.status, 409);
		    const apiCertifiedStepMessage = await apiCertifiedStepMessageResponse.json();
		    assert.equal(apiCertifiedStepMessage.reason, 'agent_certified_continue_work');
		    const apiContinueAfterGenericStep = await fetch(`${base}/api/tasks/${apiContinueTask.id}`).then(r => r.json());
		    assert.equal(apiContinueAfterGenericStep.task.status, 'review');
		    assert.equal(apiContinueAfterGenericStep.task.messages.some(m => m.content.includes('should not write API certified review')), false);

		    const apiCurrentStepContinue = await fetch(`${base}/api/tasks/current/step?owner=codex&goal_id=OBL-934&review_state=continue-work`, {
		      method: 'POST',
		      headers: { 'content-type': 'application/json' },
		      body: JSON.stringify({ actor: 'codex' }),
		    }).then(r => r.json());
		    assert.equal(apiCurrentStepContinue.ok, true);
		    assert.equal(apiCurrentStepContinue.action, 'current_step');
		    assert.equal(apiCurrentStepContinue.before_current.scope.review_state, 'continue-work');
		    assert.equal(apiCurrentStepContinue.before_current.selected_task_id, apiContinueTask.id);
		    assert.equal(apiCurrentStepContinue.selected_next_key, 'continue_work');
		    assert.equal(apiCurrentStepContinue.step.step_action, 'continue_work');
		    assert.equal(apiCurrentStepContinue.step.continue_work.action, 'continue_work');
		    assert.equal(apiCurrentStepContinue.step.continue_work.parent_task_id, apiContinueTask.id);
		    assert.equal(apiCurrentStepContinue.step.continue_work.created, true);
		    assert.equal(apiCurrentStepContinue.step.next_task.title, 'Run the API continuation follow-up');
		    assert.equal(apiCurrentStepContinue.page.task.id, apiCurrentStepContinue.step.next_task.id);
		    assert.equal(apiCurrentStepContinue.safety.human_accept, false);
		    assert.equal(apiCurrentStepContinue.safety.claims_work, false);
		    const apiContinueParentAfterStep = await fetch(`${base}/api/tasks/${apiContinueTask.id}`).then(r => r.json());
		    assert.equal(apiContinueParentAfterStep.task.status, 'review');
		    assert.equal(apiContinueParentAfterStep.task.review.approval_status, 'pending');

		    const apiCurrentStepWaitingResponse = await fetch(`${base}/api/tasks/current/step?owner=codex&goal_id=OBL-934&review_state=human-accept-waiting`, {
		      method: 'POST',
		      headers: { 'content-type': 'application/json' },
		      body: JSON.stringify({ actor: 'codex' }),
		    });
		    assert.equal(apiCurrentStepWaitingResponse.status, 409);
		    const apiCurrentStepWaiting = await apiCurrentStepWaitingResponse.json();
		    assert.equal(apiCurrentStepWaiting.reason, 'agent_certified_waiting_human');
		    assert.equal(apiCurrentStepWaiting.selected_task_id, apiWaitingTask.id);
		    assert.equal(apiCurrentStepWaiting.selected_next_key, 'human_accept_waiting');
		    assert.equal(apiCurrentStepWaiting.current.selected_task_id, apiWaitingTask.id);
		    assert.equal(apiCurrentStepWaiting.current.next.key, 'human_accept_waiting');
		    assert.equal(apiCurrentStepWaiting.page.stage.next_action.command, null);
		    assert.equal(apiCurrentStepWaiting.page.stage.next_action.api, null);
		    const apiWaitingAfterStep = await fetch(`${base}/api/tasks/${apiWaitingTask.id}`).then(r => r.json());
		    assert.equal(apiWaitingAfterStep.task.status, 'review');
		    assert.equal(apiWaitingAfterStep.task.review.approval_status, 'pending');

	    const apiQueue = await fetch(`${base}/api/tasks/queue?owner=codex&limit=1`).then(r => r.json());
	    assert.equal(apiQueue.ok, true);
	    assert.equal(apiQueue.action, 'queue');
	    assert.equal(apiQueue.current.schema, 'atris.task_current.v1');
	    assert.equal(apiQueue.queue.columns.some(column => column.key === 'review'), true);
	    const apiStepDetailAfterCurrent = await fetch(`${base}/api/tasks/${apiStepTask.task_id}`).then(r => r.json());
	    assert.equal(apiStepDetailAfterCurrent.task.status, 'review');
	    assert.equal(apiStepDetailAfterCurrent.task.review.approval_status, 'pending');

	    const apiCurrentStepReady = await fetch(`${base}/api/tasks/current/step?goal_id=OBL-928`, {
	      method: 'POST',
	      headers: { 'content-type': 'application/json' },
	      body: JSON.stringify({
	        actor: 'codex',
	        proof: 'node --check test/commands.test.js passed for API current-step ready',
	        lesson: 'API current-step keeps current and step together',
	      }),
	    }).then(r => r.json());
	    assert.equal(apiCurrentStepReady.ok, true);
	    assert.equal(apiCurrentStepReady.action, 'current_step');
	    assert.equal(apiCurrentStepReady.before_current.scope.goal_id, 'OBL-928');
	    assert.equal(apiCurrentStepReady.before_current.selected_task_id, apiScopedTask.id);
	    assert.equal(apiCurrentStepReady.before_current.selected_reason, 'claimed_by_owner');
	    assert.equal(apiCurrentStepReady.selected_next_key, apiCurrentStepReady.before_current.next.key);
	    assert.equal(apiCurrentStepReady.step.step_action, 'ready');
	    assert.equal(apiCurrentStepReady.current.selected_task_id, apiScopedTask.id);
	    assert.equal(apiCurrentStepReady.current.next.key, 'review_chat');
	    assert.equal(apiCurrentStepReady.after_current.selected_task_id, apiScopedTask.id);
	    assert.equal(apiCurrentStepReady.after_current.next.key, 'review_chat');
	    assert.equal(apiCurrentStepReady.after.current.next.key, 'review_chat');
	    assert.equal(apiCurrentStepReady.safety.read_only, false);
	    assert.equal(apiCurrentStepReady.safety.human_accept, false);

	    const apiCurrentStepReviewChat = await fetch(`${base}/api/tasks/current/step?owner=codex&goal_id=OBL-928`, {
	      method: 'POST',
	      headers: { 'content-type': 'application/json' },
	      body: JSON.stringify({ reviewer: 'codex-review' }),
	    }).then(r => r.json());
	    assert.equal(apiCurrentStepReviewChat.ok, true);
	    assert.equal(apiCurrentStepReviewChat.step.step_action, 'review_chat');
	    assert.equal(apiCurrentStepReviewChat.step.contract.schema, 'atris.task_review_chat.v1');
	    assert.match(apiCurrentStepReviewChat.step.contract.codex_prompt, /\/codex review/);
	    assert.equal(apiCurrentStepReviewChat.page.review.human_accept.enabled, true);
	    assert.equal(apiCurrentStepReviewChat.safety.human_accept, false);

	    const apiOtherReviewAdd = runCli([
	      'task', 'add', 'API other owner review stays untouched',
	      '--tag', 'api-scope',
	      '--goal-id', 'OBL-930',
	      '--json',
	    ], { cwd: dir, env });
	    assert.equal(apiOtherReviewAdd.status, 0, apiOtherReviewAdd.stderr);
	    const apiOtherReviewTask = JSON.parse(apiOtherReviewAdd.stdout).task;
	    assert.equal(runCli(['task', 'claim', apiOtherReviewTask.display_id, '--as', 'alice'], { cwd: dir, env }).status, 0);
	    assert.equal(runCli([
	      'task', 'ready', apiOtherReviewTask.display_id,
	      '--as', 'alice',
	      '--proof', 'node --check test/commands.test.js passed before API other owner review',
	    ], { cwd: dir, env }).status, 0);
	    const apiOtherReviewStepResponse = await fetch(`${base}/api/tasks/current/step?goal_id=OBL-930`, {
	      method: 'POST',
	      headers: { 'content-type': 'application/json' },
	      body: JSON.stringify({ actor: 'codex', reviewer: 'codex-review' }),
	    });
	    assert.equal(apiOtherReviewStepResponse.status, 409);
	    const apiOtherReviewStep = await apiOtherReviewStepResponse.json();
	    assert.equal(apiOtherReviewStep.reason, 'claimed_by_other');
	    assert.equal(apiOtherReviewStep.current.selected_task_id, apiOtherReviewTask.id);
	    assert.equal(apiOtherReviewStep.current.selected_reason, 'review_needs_agent_verification');
	    const apiOtherReviewDetail = await fetch(`${base}/api/tasks/${apiOtherReviewTask.id}`).then(r => r.json());
	    assert.equal(apiOtherReviewDetail.task.status, 'review');
	    assert.equal(apiOtherReviewDetail.task.claimed_by, 'alice');
	    assert.equal(apiOtherReviewDetail.task.messages.some(m => m.content.includes('TASK_REVIEW_CHAT')), false);

	    const apiScopedDetailAfterCurrentStep = await fetch(`${base}/api/tasks/${apiScopedTask.id}`).then(r => r.json());
	    assert.equal(apiScopedDetailAfterCurrentStep.task.status, 'review');
	    assert.equal(apiScopedDetailAfterCurrentStep.task.review.approval_status, 'pending');
	    assert.ok(apiScopedDetailAfterCurrentStep.task.messages.some(m => m.content.includes('TASK_REVIEW_CHAT')));

	    const apiOwnerQueryAdd = runCli([
	      'task', 'add', 'API owner query current-step task',
	      '--tag', 'api-owner',
	      '--goal-id', 'OBL-929',
	      '--json',
	    ], { cwd: dir, env });
	    assert.equal(apiOwnerQueryAdd.status, 0, apiOwnerQueryAdd.stderr);
	    const apiOwnerQueryTask = JSON.parse(apiOwnerQueryAdd.stdout).task;
	    assert.equal(runCli([
	      'task', 'plan', apiOwnerQueryTask.display_id,
	      '--as', 'alice',
	      '--goal', 'API current-step honors query owner',
	      '--exit', 'owner query steps the owner current task',
	      '--proof-needed', 'node --test test/commands.test.js passes API current-step owner query coverage',
	    ], { cwd: dir, env }).status, 0);
	    assert.equal(runCli([
	      'task', 'do', apiOwnerQueryTask.display_id,
	      '--as', 'alice',
	      '--first-move', 'alice owns API current-step query work',
	    ], { cwd: dir, env }).status, 0);
	    const apiOwnerQueryCurrent = await fetch(`${base}/api/tasks/current?owner=alice&goal_id=OBL-929`).then(r => r.json());
	    assert.equal(apiOwnerQueryCurrent.ok, true);
	    assert.equal(apiOwnerQueryCurrent.current.owner, 'alice');
	    assert.equal(apiOwnerQueryCurrent.current.selected_reason, 'claimed_by_owner');
	    assert.equal(apiOwnerQueryCurrent.current.selected_task_id, apiOwnerQueryTask.id);
	    const apiOwnerQueryStep = await fetch(`${base}/api/tasks/current/step?owner=alice&goal_id=OBL-929`, {
	      method: 'POST',
	      headers: { 'content-type': 'application/json' },
	      body: JSON.stringify({
	        proof: 'node --check test/commands.test.js passed for API current-step owner query',
	        lesson: 'POST current-step uses the same query owner as GET current',
	      }),
	    }).then(r => r.json());
	    assert.equal(apiOwnerQueryStep.ok, true);
	    assert.equal(apiOwnerQueryStep.before_current.owner, 'alice');
	    assert.equal(apiOwnerQueryStep.before_current.selected_reason, 'claimed_by_owner');
	    assert.equal(apiOwnerQueryStep.before_current.selected_task_id, apiOwnerQueryTask.id);
	    assert.equal(apiOwnerQueryStep.step.step_action, 'ready');
	    assert.equal(apiOwnerQueryStep.step.task.id, apiOwnerQueryTask.id);
	    assert.equal(apiOwnerQueryStep.safety.human_accept, false);

	    const apiOwnerPrecedenceAliceAdd = runCli([
	      'task', 'add', 'API owner precedence Alice task',
	      '--tag', 'api-owner',
	      '--goal-id', 'OBL-931',
	      '--json',
	    ], { cwd: dir, env });
	    assert.equal(apiOwnerPrecedenceAliceAdd.status, 0, apiOwnerPrecedenceAliceAdd.stderr);
	    const apiOwnerPrecedenceAliceTask = JSON.parse(apiOwnerPrecedenceAliceAdd.stdout).task;
	    const apiOwnerPrecedenceCodexAdd = runCli([
	      'task', 'add', 'API owner precedence Codex task',
	      '--tag', 'api-owner',
	      '--goal-id', 'OBL-931',
	      '--json',
	    ], { cwd: dir, env });
	    assert.equal(apiOwnerPrecedenceCodexAdd.status, 0, apiOwnerPrecedenceCodexAdd.stderr);
	    const apiOwnerPrecedenceCodexTask = JSON.parse(apiOwnerPrecedenceCodexAdd.stdout).task;
	    assert.equal(runCli([
	      'task', 'plan', apiOwnerPrecedenceAliceTask.display_id,
	      '--as', 'alice',
	      '--goal', 'Alice owns the query-selected task',
	      '--exit', 'query owner cannot be overridden by body actor',
	      '--proof-needed', 'node --test test/commands.test.js passes API current-step owner precedence coverage',
	    ], { cwd: dir, env }).status, 0);
	    assert.equal(runCli([
	      'task', 'do', apiOwnerPrecedenceAliceTask.display_id,
	      '--as', 'alice',
	      '--first-move', 'alice owns the query-selected work',
	    ], { cwd: dir, env }).status, 0);
	    assert.equal(runCli([
	      'task', 'plan', apiOwnerPrecedenceCodexTask.display_id,
	      '--as', 'codex',
	      '--goal', 'Codex owns a different same-scope task',
	      '--exit', 'query owner still selects Alice',
	      '--proof-needed', 'node --test test/commands.test.js passes API current-step owner precedence coverage',
	    ], { cwd: dir, env }).status, 0);
	    assert.equal(runCli([
	      'task', 'do', apiOwnerPrecedenceCodexTask.display_id,
	      '--as', 'codex',
	      '--first-move', 'codex owns separate same-scope work',
	    ], { cwd: dir, env }).status, 0);
	    const apiOwnerPrecedenceCurrent = await fetch(`${base}/api/tasks/current?owner=alice&goal_id=OBL-931`).then(r => r.json());
	    assert.equal(apiOwnerPrecedenceCurrent.current.selected_task_id, apiOwnerPrecedenceAliceTask.id);
	    const apiOwnerPrecedenceResponse = await fetch(`${base}/api/tasks/current/step?owner=alice&goal_id=OBL-931`, {
	      method: 'POST',
	      headers: { 'content-type': 'application/json' },
	      body: JSON.stringify({
	        actor: 'codex',
	        proof: 'node --check test/commands.test.js passed for API current-step owner precedence',
	      }),
	    });
	    assert.equal(apiOwnerPrecedenceResponse.status, 409);
	    const apiOwnerPrecedenceStep = await apiOwnerPrecedenceResponse.json();
	    assert.equal(apiOwnerPrecedenceStep.reason, 'claimed_by_other');
	    assert.equal(apiOwnerPrecedenceStep.current.selected_task_id, apiOwnerPrecedenceAliceTask.id);
	    const apiOwnerPrecedenceCodexDetail = await fetch(`${base}/api/tasks/${apiOwnerPrecedenceCodexTask.id}`).then(r => r.json());
	    assert.equal(apiOwnerPrecedenceCodexDetail.task.status, 'claimed');

	    const apiUnplannedDo = await fetch(`${base}/api/tasks/${apiStageId}/do`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', first_move: 'start too early' }),
    });
    assert.equal(apiUnplannedDo.status, 409);
    assert.equal((await apiUnplannedDo.json()).reason, 'goal_required');

    const apiInlineDo = await fetch(`${base}/api/tasks/${apiStageId}/do`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex',
        goal: 'Skip API plan',
        proof_needed: 'should still need a plan event',
        first_move: 'start too early',
      }),
    });
    assert.equal(apiInlineDo.status, 409);
    assert.equal((await apiInlineDo.json()).reason, 'plan_required');

    const apiPlan = await fetch(`${base}/api/tasks/${apiStageId}/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex',
        goal: 'Prove API Plan Do Review',
        summary: 'Use API stage endpoints before review',
        owner: 'codex',
        exit: 'ready endpoint receives specific proof',
        proof_needed: 'node --test command API stage coverage passes',
        first_move: 'call the do endpoint',
      }),
    }).then(r => r.json());
    assert.equal(apiPlan.ok, true);
    assert.equal(apiPlan.action, 'planned');
    assert.equal(apiPlan.task.metadata.stage, 'plan');
    assert.match(apiPlan.stage_packet, /stage: plan/);
    assert.match(apiPlan.stage_packet, /goal: Prove API Plan Do Review/);

    const apiExitRewriteDo = await fetch(`${base}/api/tasks/${apiStageId}/do`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex',
        exit: 'different API review boundary',
        first_move: 'start from rewritten API exit',
      }),
    });
    assert.equal(apiExitRewriteDo.status, 409);
    assert.equal((await apiExitRewriteDo.json()).reason, 'plan_exit_mismatch');

    const apiRewriteDo = await fetch(`${base}/api/tasks/${apiStageId}/do`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex',
        goal: 'Replace API plan',
        proof_needed: 'weaker API proof',
        first_move: 'start from rewritten API text',
      }),
    });
    assert.equal(apiRewriteDo.status, 409);
    assert.equal((await apiRewriteDo.json()).reason, 'plan_goal_mismatch');

    const apiDo = await fetch(`${base}/api/tasks/${apiStageId}/do`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', first_move: 'run the API stage smoke' }),
    }).then(r => r.json());
    assert.equal(apiDo.ok, true);
    assert.equal(apiDo.action, 'doing');
    assert.equal(apiDo.task.status, 'claimed');
    assert.equal(apiDo.task.claimed_by, 'codex');
    assert.equal(apiDo.task.metadata.stage, 'do');
    assert.match(apiDo.stage_packet, /stage: do/);

    const apiBacklogTask = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Move API plan row back to backlog', tag: 'plan' }),
    }).then(r => r.json());
    assert.equal(apiBacklogTask.ok, true);
    const apiBacklogTaskId = apiBacklogTask.task_id;
    const apiBacklogPlan = await fetch(`${base}/api/tasks/${apiBacklogTaskId}/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex',
        goal: 'API backlog has a plan',
        exit: 'API backlog endpoint clears it',
        proof_needed: 'node --test API backlog coverage passes',
      }),
    }).then(r => r.json());
    assert.equal(apiBacklogPlan.ok, true);

    const apiBacklog = await fetch(`${base}/api/tasks/${apiBacklogTaskId}/backlog`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', reason: 'operator changed priority', tag: 'feature' }),
    }).then(r => r.json());
    assert.equal(apiBacklog.ok, true);
    assert.equal(apiBacklog.action, 'backlogged');
    assert.equal(apiBacklog.task.tag, 'capture');
    assert.equal(apiBacklog.task.metadata.stage, undefined);
    assert.equal(apiBacklog.task.latest_event_type, 'task_backlogged');

    const apiBacklogDo = await fetch(`${base}/api/tasks/${apiBacklogTaskId}/do`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', first_move: 'start after API backlog' }),
    });
    assert.equal(apiBacklogDo.status, 409);
    assert.equal((await apiBacklogDo.json()).reason, 'goal_required');

    const apiBulkA = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'API clear plan A', tag: 'feature' }),
    }).then(r => r.json());
    const apiBulkB = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'API clear plan B', tag: 'capture' }),
    }).then(r => r.json());
    assert.equal(apiBulkA.ok, true);
    assert.equal(apiBulkB.ok, true);
    for (const taskId of [apiBulkA.task_id, apiBulkB.task_id]) {
      const planned = await fetch(`${base}/api/tasks/${taskId}/plan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          actor: 'codex',
          owner: 'codex',
          goal: `API bulk goal ${taskId}`,
          exit: `API bulk exit ${taskId}`,
          proof_needed: `API bulk proof ${taskId}`,
        }),
      }).then(r => r.json());
      assert.equal(planned.ok, true);
    }
    const apiClearMissingConfirm = await fetch(`${base}/api/tasks/clear-plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex' }),
    });
    assert.equal(apiClearMissingConfirm.status, 400);
    assert.equal((await apiClearMissingConfirm.json()).reason, 'confirm_required');

    const apiClearPlan = await fetch(`${base}/api/tasks/clear-plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', confirm: true, reason: 'operator cleared Plan' }),
    }).then(r => r.json());
    assert.equal(apiClearPlan.ok, true);
    assert.equal(apiClearPlan.action, 'clear_plan');
    assert.equal(apiClearPlan.cleared_count, 2);
    assert.deepEqual(apiClearPlan.tasks.map(task => task.id).sort(), [apiBulkA.task_id, apiBulkB.task_id].sort());
    assert.ok(apiClearPlan.tasks.every(task => task.tag === 'capture'));

    const missingReadyProofResponse = await fetch(`${base}/api/tasks/${apiReviewId}/ready`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex' }),
    });
    assert.equal(missingReadyProofResponse.status, 400);
    const missingReadyProof = await missingReadyProofResponse.json();
    assert.equal(missingReadyProof.reason, 'proof_required');

    const weakReadyProofResponse = await fetch(`${base}/api/tasks/${apiReviewId}/ready`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', proof: 'done' }),
    });
    assert.equal(weakReadyProofResponse.status, 400);
    const weakReadyProof = await weakReadyProofResponse.json();
    assert.equal(weakReadyProof.reason, 'weak_proof');

    const apiReady = await fetch(`${base}/api/tasks/${apiReviewId}/ready`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', proof: 'node --check test/commands.test.js passed before revise' }),
    }).then(r => r.json());
    assert.equal(apiReady.ok, true);

    const prematureApiFinishResponse = await fetch(`${base}/api/tasks/${apiReviewId}/finish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex', proof: 'node --check test/commands.test.js passed while blocked in review' }),
    });
    assert.equal(prematureApiFinishResponse.status, 409);
    const prematureApiFinish = await prematureApiFinishResponse.json();
    assert.equal(prematureApiFinish.reason, 'not_open_or_claimed');

    const apiRevise = await fetch(`${base}/api/tasks/${apiReviewId}/revise`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'operator', note: 'needs another pass' }),
    }).then(r => r.json());
    assert.equal(apiRevise.ok, true);
    assert.equal(apiRevise.task.status, 'open');

    const staleApiAcceptResponse = await fetch(`${base}/api/tasks/${apiReviewId}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'operator' }),
    });
    assert.equal(staleApiAcceptResponse.status, 400);
    const staleApiAccept = await staleApiAcceptResponse.json();
    assert.equal(staleApiAccept.reason, 'proof_required');

    const freshApiReady = await fetch(`${base}/api/tasks/${apiReviewId}/ready`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex',
        proof: 'node --check test/commands.test.js passed after API ready',
        lesson: 'API accept keeps the ready lesson',
        next: 'Create the API follow-up task',
      }),
    }).then(r => r.json());
    assert.equal(freshApiReady.ok, true);

    const apiDetail = await fetch(`${base}/api/tasks/${apiReviewId}`).then(r => r.json());
    assert.equal(apiDetail.ok, true);
    assert.equal(apiDetail.action, 'detail');
    assert.equal(apiDetail.task.id, apiReviewId);
    assert.equal(apiDetail.task.review.verification_chat.schema, 'atris.task_review_chat.v1');
    assert.match(apiDetail.task.review.verification_chat.command, /atris task review-chat /);
    assert.match(apiDetail.task.review.verification_chat.codex_prompt, /\/codex review/);
    assert.equal(apiDetail.page.schema, 'atris.task_page.v1');
    assert.equal(apiDetail.page.stage.current, 'review');
    assert.equal(apiDetail.page.stage.next_action.key, 'review_chat');
    assert.equal(apiDetail.page.review.human_accept.enabled, true);
    assert.notEqual(apiDetail.page.stage.next_action.command, apiDetail.page.review.human_accept.command);

    const apiPage = await fetch(`${base}/api/tasks/${apiReviewId}/page`).then(r => r.json());
    assert.equal(apiPage.ok, true);
    assert.equal(apiPage.action, 'page');
    assert.equal(apiPage.page.task.id, apiReviewId);
    assert.equal(apiPage.page.review.verification_chat.schema, 'atris.task_review_chat.v1');
    assert.equal(apiPage.page.chat.can_chat, true);

    const apiReviewChat = await fetch(`${base}/api/tasks/${apiReviewId}/review-chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex-review' }),
    }).then(r => r.json());
    assert.equal(apiReviewChat.ok, true);
    assert.equal(apiReviewChat.action, 'review_chat');
    assert.equal(apiReviewChat.appended, true);
    assert.ok(apiReviewChat.version);
    assert.equal(apiReviewChat.contract.schema, 'atris.task_review_chat.v1');
    assert.match(apiReviewChat.contract.codex_prompt, /\/codex review/);
    assert.match(apiReviewChat.contract.codex_prompt, /Reject stale API proof after revise/);
    assert.match(apiReviewChat.contract.pass_command, /atris task review /);
    assert.equal(apiReviewChat.contract.verification_focus.proof_claim, 'node --check test/commands.test.js passed after API ready');
    assert.ok(apiReviewChat.contract.verification_focus.commands_to_verify.some(command => command.includes('node --check test/commands.test.js')));
    assert.ok(apiReviewChat.contract.verification_focus.files_to_inspect.includes('test/commands.test.js'));
    assert.match(apiReviewChat.contract.required_checks.join('\n'), /Re-run or inspect these proof commands/);
    assert.match(apiReviewChat.contract.required_checks.join('\n'), /Inspect these named files\/artifacts/);
    assert.ok(apiReviewChat.task.messages.some(m => m.content.includes('TASK_REVIEW_CHAT')));

    const apiDetailAfterReviewChat = await fetch(`${base}/api/tasks/${apiReviewId}`).then(r => r.json());
    assert.equal(apiDetailAfterReviewChat.ok, true);
    assert.ok(apiDetailAfterReviewChat.task.messages.some(m => m.content.includes('TASK_REVIEW_CHAT')));

    const apiDefaultReviewTask = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'API default review is verifier-only', tag: 'factory' }),
    }).then(r => r.json());
    assert.equal(apiDefaultReviewTask.ok, true);
    const apiDefaultReviewId = apiDefaultReviewTask.task_id;
    const apiDefaultReady = await fetch(`${base}/api/tasks/${apiDefaultReviewId}/ready`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex',
        proof: 'node --check test/commands.test.js passed before default API review',
      }),
    }).then(r => r.json());
    assert.equal(apiDefaultReady.ok, true);
    const apiDefaultReview = await fetch(`${base}/api/tasks/${apiDefaultReviewId}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'validator',
        proof: 'node --check test/commands.test.js passed during default API review',
      }),
    }).then(r => r.json());
    assert.equal(apiDefaultReview.ok, true);
    assert.equal(apiDefaultReview.episode.reward.value, 0);
    const apiDefaultDetail = await fetch(`${base}/api/tasks/${apiDefaultReviewId}`).then(r => r.json());
    assert.equal(apiDefaultDetail.task.review.approval_status, 'pending');
    assert.equal(apiDefaultDetail.task.review.agent_review_pass_count, 2);
    assert.equal(apiDefaultDetail.task.review.agent_certified, true);
    assert.equal(apiDefaultDetail.task.review.verification_chat, undefined);
    assert.equal(apiDefaultDetail.page.stage.next_action.key, 'human_accept_waiting');
    assert.equal(apiDefaultDetail.page.stage.next_action.command, null);
    assert.equal(apiDefaultDetail.page.review.verification_chat.schema, 'atris.task_review_chat.v1');
    assert.match(apiDefaultDetail.page.actions.review_chat_command, /atris task review-chat /);
    assert.equal(apiDefaultDetail.page.review.human_accept.enabled, true);

    const apiCertifiedReviewChatResponse = await fetch(`${base}/api/tasks/${apiDefaultReviewId}/review-chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex-review' }),
    });
    assert.equal(apiCertifiedReviewChatResponse.status, 200);
    const apiCertifiedReviewChat = await apiCertifiedReviewChatResponse.json();
    assert.equal(apiCertifiedReviewChat.ok, true);
    assert.equal(apiCertifiedReviewChat.action, 'review_chat');
    assert.equal(apiCertifiedReviewChat.contract.review.agent_certified, true);

    const weakApiAcceptResponse = await fetch(`${base}/api/tasks/${apiReviewId}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'operator', proof: 'done' }),
    });
    assert.equal(weakApiAcceptResponse.status, 400);
    const weakApiAccept = await weakApiAcceptResponse.json();
    assert.equal(weakApiAccept.reason, 'weak_proof');

    const invalidRewardResponse = await fetch(`${base}/api/tasks/${apiReviewId}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'operator', reward: 0 }),
    });
    assert.equal(invalidRewardResponse.status, 400);
    const invalidReward = await invalidRewardResponse.json();
    assert.equal(invalidReward.reason, 'invalid_reward');

    const freshApiAccept = await fetch(`${base}/api/tasks/${apiReviewId}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'operator', createNext: true }),
    }).then(r => r.json());
    assert.equal(freshApiAccept.ok, true);
    assert.equal(freshApiAccept.episode.proof, 'node --check test/commands.test.js passed after API ready');
    assert.equal(freshApiAccept.episode.lesson, 'API accept keeps the ready lesson');
    assert.equal(freshApiAccept.episode.next_task_suggestion, 'Create the API follow-up task');
    assert.ok(freshApiAccept.next_task_id);

    const apiReviewGate = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Reject weak API review proof', tag: 'factory' }),
    }).then(r => r.json());
    assert.equal(apiReviewGate.ok, true);
    const weakReviewProofResponse = await fetch(`${base}/api/tasks/${apiReviewGate.task_id}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'validator', reward: 1, proof: 'done' }),
    });
    assert.equal(weakReviewProofResponse.status, 400);
    const weakReviewProof = await weakReviewProofResponse.json();
    assert.equal(weakReviewProof.reason, 'weak_proof');

    const clearReview = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Clear stale review guidance', tag: 'factory' }),
    }).then(r => r.json());
    assert.equal(clearReview.ok, true);
    const clearReviewId = clearReview.task_id;

    const clearReady = await fetch(`${base}/api/tasks/${clearReviewId}/ready`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex',
        proof: 'node --check test/commands.test.js passed for clear review',
        lesson: 'stale ready lesson',
        next: 'stale ready next',
      }),
    }).then(r => r.json());
    assert.equal(clearReady.ok, true);

    const omittedApiReview = await fetch(`${base}/api/tasks/${clearReviewId}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'validator', reward: 0 }),
    }).then(r => r.json());
    assert.equal(omittedApiReview.ok, true);
    assert.equal(omittedApiReview.task.review.proof, 'node --check test/commands.test.js passed for clear review');
    assert.equal(omittedApiReview.task.review.lesson, 'stale ready lesson');
    assert.equal(omittedApiReview.task.review.next_task, 'stale ready next');

    const clearAccept = await fetch(`${base}/api/tasks/${clearReviewId}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'operator', lesson: '', next: '' }),
    }).then(r => r.json());
    assert.equal(clearAccept.ok, true);
    assert.equal(clearAccept.episode.proof, 'node --check test/commands.test.js passed for clear review');
    assert.equal(clearAccept.episode.lesson, '');
    assert.equal(clearAccept.episode.next_task_suggestion, null);
    assert.equal(clearAccept.task.review.proof, 'node --check test/commands.test.js passed for clear review');
    assert.equal(clearAccept.task.review.lesson, null);
    assert.equal(clearAccept.task.review.next_task, null);

    const scopedApiCreateNext = runCli([
      'task', 'add', 'Scoped API create-next parent',
      '--tag', 'factory',
      '--goal-id', 'OBL-932',
      '--json',
    ], { cwd: dir, env });
    assert.equal(scopedApiCreateNext.status, 0, scopedApiCreateNext.stderr);
    const scopedApiParent = JSON.parse(scopedApiCreateNext.stdout).task;
    const scopedApiReady = await fetch(`${base}/api/tasks/${scopedApiParent.id}/ready`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex',
        proof: 'node --check test/commands.test.js passed for scoped API createNext',
        next: 'Scoped API follow-up task',
      }),
    }).then(r => r.json());
    assert.equal(scopedApiReady.ok, true);
    const scopedApiAccept = await fetch(`${base}/api/tasks/${scopedApiParent.id}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'operator', createNext: true }),
    }).then(r => r.json());
    assert.equal(scopedApiAccept.ok, true);
    assert.ok(scopedApiAccept.next_task_id);

    const listed = await fetch(`${base}/api/tasks`).then(r => r.json());
    assert.equal(listed.ok, true);
    assert.ok(listed.projection.tasks.some(t => t.id === finished.next_task_id && t.title === 'Connect the board to Swarlo leases'));
    assert.ok(listed.projection.tasks.some(t => t.id === freshApiAccept.next_task_id && t.title === 'Create the API follow-up task'));
    assert.ok(listed.projection.tasks.some(t => t.id === scopedApiAccept.next_task_id
      && t.title === 'Scoped API follow-up task'
      && t.metadata.goal_id === 'OBL-932'
      && t.lineage.parent_task_id === scopedApiParent.id));
  } finally {
    if (child) child.kill('SIGTERM');
    cleanupTempDir(dir);
  }
});
