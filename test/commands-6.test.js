// Part 6 of 8 of the commands suite, split so node --test runs them in parallel.
// Shared imports and fixture helpers live in test/helpers/commands-fixtures.js.
const test = require('node:test');
const {
  assert,
  fs,
  path,
  http,
  spawn,
  spawnSync,
  writePolicy,
  taskStore,
  repoRoot,
  cliPath,
  makeTempDir,
  cleanupTempDir,
  runCli,
  hasNodeSqlite,
  waitForOutput,
} = require('./helpers/commands-fixtures');

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
    const ready = await waitForOutput(child, /task board: (http:\/\/127\.0\.0\.1:\d+)\/\?t=([A-Za-z0-9_-]+)/);
    const base = ready.match[1];
    const fetch = (url, options = {}) => globalThis.fetch(url, { ...options, headers: { connection: 'close', 'x-atris-token': ready.match[2], ...options.headers } });

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
    const readyServer = await waitForOutput(child, /task board: (http:\/\/127\.0\.0\.1:\d+)\/\?t=([A-Za-z0-9_-]+)/);
    const base = readyServer.match[1];
    const fetch = (url, options = {}) => globalThis.fetch(url, { ...options, headers: { connection: 'close', 'x-atris-token': readyServer.match[2], ...options.headers } });

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
    const readyServer = await waitForOutput(child, /task board: (http:\/\/127\.0\.0\.1:\d+)\/\?t=([A-Za-z0-9_-]+)/);
    const base = readyServer.match[1];
    const fetch = (url, options = {}) => globalThis.fetch(url, { ...options, headers: { connection: 'close', 'x-atris-token': readyServer.match[2], ...options.headers } });

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
