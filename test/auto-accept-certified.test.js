'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { evaluateAutoAccept, parseVerifyCommand, runVerifyCommand } = require('../lib/auto-accept-certified');

function reviewTask(overrides = {}) {
  return {
    id: 'task-1',
    display_id: 'OBL-TEST',
    status: 'review',
    tag: 'self-improve',
    workspace_root: process.cwd(),
    metadata: {
      approval_status: 'pending',
      agent_certified: true,
      agent_review_pass_count: 2,
      latest_agent_proof: 'npm run test:team-overall passed; git diff --check passed',
      verify: 'node --check lib/auto-accept-certified.js',
      ...overrides.metadata,
    },
    review: {
      approval_status: 'pending',
      agent_certified: true,
      agent_review_pass_count: 2,
      proof: 'npm run test:team-overall passed; git diff --check passed',
      ...overrides.review,
    },
    events: overrides.events || [
      { event_type: 'proof_ready', actor: 'codex' },
      { event_type: 'reviewed', actor: 'validator' },
    ],
    ...(overrides.tag ? { tag: overrides.tag } : {}),
  };
}

test('accepts certified review with two actors and meaningful proof', () => {
  const result = evaluateAutoAccept(reviewTask());
  assert.equal(result.eligible, true);
  assert.equal(result.policy, 'strict_verify');
});

test('strict verify missing points agents back to review chat', () => {
  const result = evaluateAutoAccept(reviewTask({
    metadata: { verify: '' },
  }));
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'strict_verify_missing');
  assert.match(result.next_action, /metadata\.verify/);
  assert.equal(result.review_chat_command, 'atris task review-chat OBL-TEST --as codex-review');
});

test('rejects three passes from a single actor: passes alone never land work', () => {
  const base = reviewTask();
  const result = evaluateAutoAccept({
    ...base,
    metadata: { ...base.metadata, agent_review_pass_count: 3 },
    review: { ...base.review, agent_review_pass_count: 3 },
    events: [{ event_type: 'proof_ready', actor: 'codex' }],
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'needs_independent_reviewer');
  assert.equal(result.builder, 'codex');
});

test('rejects denied tags and weak proof', () => {
  assert.equal(evaluateAutoAccept(reviewTask({ tag: 'voice' })).eligible, false);
  assert.equal(evaluateAutoAccept(reviewTask({
    metadata: { latest_agent_proof: 'done' },
    review: { proof: 'done' },
  })).eligible, false);
});

test('rejects proof that names an open draft PR boundary', () => {
  const proof = 'PR #1611 is still OPEN and draft=true, mergedAt=null. git diff --check passed.';
  const result = evaluateAutoAccept(reviewTask({
    metadata: { latest_agent_proof: proof },
    review: { proof },
  }));
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'proof_unmerged_or_draft_pr_boundary');
  assert.match(result.next_action, /revise/);
});

test('rejects proof that names a closed unmerged PR boundary', () => {
  const proof = 'PR #1585 is CLOSED with mergedAt=null after json.tool passed and git diff --check passed.';
  const result = evaluateAutoAccept(reviewTask({
    metadata: { latest_agent_proof: proof, agent_review_pass_count: 3 },
    review: { proof, agent_review_pass_count: 3 },
    events: [{ event_type: 'proof_ready', actor: 'codex' }],
  }));
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'proof_unmerged_or_draft_pr_boundary');
});

test('rejects stale proof that uses a bare PR number reference', () => {
  const proof = 'Verified #1600 remains OPEN/draft/CLEAN at head be8797f. git diff --check passed.';
  const result = evaluateAutoAccept(reviewTask({
    metadata: { latest_agent_proof: proof },
    review: { proof },
  }));
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'proof_unmerged_or_draft_pr_boundary');
});

test('reports PR boundary before generic weak proof', () => {
  const proof = 'Verified #1595 remains OPEN draft CLEAN for the canonical replacement.';
  const result = evaluateAutoAccept(reviewTask({
    metadata: { latest_agent_proof: proof },
    review: { proof },
  }));
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'proof_unmerged_or_draft_pr_boundary');
});

test('allows merged proof that explains the rejected PR boundary terms', () => {
  const proof = [
    'Merged PR #78 at origin/master commit 7944f271.',
    'Changed evaluator tests to reject proof text that names open draft, draft=true, isDraft=true, mergedAt=null, or closed-unmerged PR boundaries.',
    'git diff --check passed.',
  ].join(' ');
  const result = evaluateAutoAccept(reviewTask({
    metadata: { latest_agent_proof: proof, agent_review_pass_count: 3 },
    review: { proof, agent_review_pass_count: 3 },
    events: [
      { event_type: 'proof_ready', actor: 'codex' },
      { event_type: 'reviewed', actor: 'validator' },
    ],
  }));
  assert.equal(result.eligible, true);
  assert.equal(result.policy, 'strict_verify');
});

test('rejects single actor with only two passes', () => {
  const result = evaluateAutoAccept(reviewTask({
    events: [{ event_type: 'proof_ready', actor: 'codex' }],
  }));
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'needs_independent_reviewer');
});

test('casing and spacing tricks do not fake a second reviewer', () => {
  const result = evaluateAutoAccept(reviewTask({
    events: [
      { event_type: 'proof_ready', actor: 'codex' },
      { event_type: 'reviewed', actor: ' Codex ' },
    ],
  }));
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'needs_independent_reviewer');
});

test('strict verify rejects compound shell commands', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-verify-'));
  const target = path.join(dir, 'pwned');
  const result = runVerifyCommand(`node --check lib/auto-accept-certified.js; echo pwned > ${target}`, process.cwd());
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'verify_command_not_allowed');
  assert.equal(fs.existsSync(target), false);
});

test('strict verify parser rejects path and npm config escapes', () => {
  assert.deepEqual(parseVerifyCommand('node --check lib/auto-accept-certified.js'), {
    ok: true,
    argv: ['node', '--check', 'lib/auto-accept-certified.js'],
  });
  assert.deepEqual(parseVerifyCommand('node --test --test-name-pattern=lineage test/commands.test.js'), {
    ok: true,
    argv: ['node', '--test', '--test-name-pattern=lineage', 'test/commands.test.js'],
  });
  assert.deepEqual(parseVerifyCommand('node bin/atris.js clean --dry-run --json'), {
    ok: true,
    argv: ['node', 'bin/atris.js', 'clean', '--dry-run', '--json'],
  });
  assert.equal(parseVerifyCommand('node bin/atris.js clean --json').ok, false);
  assert.equal(parseVerifyCommand('node bin/atris.js task accept CLI-1').ok, false);
  assert.equal(parseVerifyCommand('node scripts/../../tmp/pwn.js').ok, false);
  assert.equal(parseVerifyCommand('node --test ../../tmp/pwn.js').ok, false);
  assert.equal(parseVerifyCommand('npm run --script-shell=/bin/sh').ok, false);
  assert.equal(parseVerifyCommand('npm run test --prefix=/tmp/evil').ok, false);
  assert.equal(parseVerifyCommand('npm test --script-shell=scripts/malsh').ok, false);
  assert.equal(parseVerifyCommand('tsc --project=/tmp/evil/tsconfig.json').ok, false);
  assert.equal(parseVerifyCommand('git diff --check --output=/tmp/x').ok, false);
  assert.equal(parseVerifyCommand('node --test --test-reporter-destination=/tmp/x').ok, false);
  assert.equal(parseVerifyCommand('node --check --require=/tmp/pwn.js').ok, false);
  assert.equal(parseVerifyCommand('node --check file:///tmp/pwn.js').ok, false);
});

test('strict verify parser accepts quoted node test filters without enabling shell operators', () => {
  const command = "node --test --test-name-pattern='update and sync --help|upgrade --help|help invocations skip background' test/commands.test.js";
  assert.deepEqual(parseVerifyCommand(command), {
    ok: true,
    argv: [
      'node',
      '--test',
      '--test-name-pattern=update and sync --help|upgrade --help|help invocations skip background',
      'test/commands.test.js',
    ],
  });
  assert.equal(parseVerifyCommand("node --test --test-name-pattern='safe' | touch pwned test/commands.test.js").ok, false);
  assert.equal(parseVerifyCommand("node --test --test-name-pattern='unterminated test/commands.test.js").ok, false);
});

test('strict verify runtime passes a quoted alternation directly to node without a shell', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-node-pattern-'));
  const testsDir = path.join(workspace, 'test');
  const target = path.join(workspace, 'pwned');
  fs.mkdirSync(testsDir, { recursive: true });
  fs.writeFileSync(
    path.join(testsDir, 'sample.test.js'),
    "const test = require('node:test'); test('safe', () => {});\n",
  );
  const result = runVerifyCommand(
    `node --test --test-name-pattern='safe|touch ${target}' test/sample.test.js`,
    workspace,
  );
  assert.equal(result.ok, true, result.stderr);
  assert.equal(fs.existsSync(target), false);
});

test('strict verify parser allows safe backend python commands with cd and env', () => {
  const commands = [
    'cd backend && OFFLINE_MODE=1 ../venv/bin/python -m pytest tests/test_api_tracking_service.py tests/test_api_key_usage.py -q',
    'cd backend && OFFLINE_MODE=1 ../venv/bin/python -m pytest tests/test_api_tracking_service.py -q',
    'cd backend && /Users/keshavrao/arena/atrisos-backend/venv/bin/python -m pytest tests/test_org_decision_loop.py -q',
    '/Users/keshavrao/arena/atrisos-backend/venv/bin/python scripts/measure_reward_ab.py',
  ];

  for (const command of commands) {
    assert.equal(parseVerifyCommand(command).ok, true, command);
  }

  assert.deepEqual(parseVerifyCommand(commands[0]), {
    ok: true,
    cwd: 'backend',
    env: { OFFLINE_MODE: '1' },
    argv: [
      '../venv/bin/python',
      '-m',
      'pytest',
      'tests/test_api_tracking_service.py',
      'tests/test_api_key_usage.py',
      '-q',
    ],
  });
});

test('strict verify parser rejects unsafe python command forms', () => {
  const denied = [
    'python -c "print(1)"',
    'cd .. && python -m pytest x',
    'cd backend; python -m pytest x',
    'python -m pytest tests/a.py && rm -rf /',
    'FOO=$(whoami) python -m pytest t.py',
    'python -m pytest tests/a.py `whoami`',
    'python -m pytest tests/a.py | cat',
    'python -m pytest tests/a.py; rm -rf /',
    '/usr/bin/python -m pytest tests/a.py',
  ];

  for (const command of denied) {
    assert.equal(parseVerifyCommand(command).ok, false, command);
  }
});

test('strict verify runtime uses cd cwd and env assignments without a shell', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-verify-workspace-'));
  const scriptsDir = path.join(workspace, 'backend', 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(
    path.join(scriptsDir, 'check-env.js'),
    'if (process.env.OFFLINE_MODE !== "1") process.exit(7);\n',
  );

  const result = runVerifyCommand('cd backend && OFFLINE_MODE=1 node scripts/check-env.js', workspace);
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'verify_passed');
});

test('strict verify runtime rejects absolute venv python outside the workspace arena', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-verify-workspace-'));
  const outsidePython = path.join(os.homedir(), '.atris-verify-outside', 'venv', 'bin', 'python');
  const command = `${outsidePython} -m pytest tests/a.py`;

  assert.equal(parseVerifyCommand(command).ok, true);
  const result = runVerifyCommand(command, workspace);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'verify_command_not_allowed');
});

test('strict verify parser allows bounded git worktree diff checks', () => {
  const sibling = path.join(os.tmpdir(), 'sibling-worktree');
  const parsed = parseVerifyCommand(`git -C ${sibling} diff --check origin/master^ origin/master`);
  assert.deepEqual(parsed, {
    ok: true,
    argv: ['git', '-C', sibling, 'diff', '--check', 'origin/master^', 'origin/master'],
  });
  assert.deepEqual(parseVerifyCommand('git diff --check HEAD~1 HEAD'), {
    ok: true,
    argv: ['git', 'diff', '--check', 'HEAD~1', 'HEAD'],
  });
  assert.equal(parseVerifyCommand('git -C ../../outside diff --check').ok, false);
  assert.equal(parseVerifyCommand('git -C /tmp/evil diff --check --output=/tmp/x').ok, false);
});

test('strict verify runtime blocks git -C outside the workspace parent', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-verify-parent-'));
  const workspace = path.join(parent, 'workspace');
  const sibling = path.join(parent, 'sibling');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-verify-outside-'));
  fs.mkdirSync(workspace);
  fs.mkdirSync(sibling);

  const allowed = runVerifyCommand(`git -C ${sibling} diff --check`, workspace);
  assert.notEqual(allowed.reason, 'verify_command_not_allowed');

  const denied = runVerifyCommand(`git -C ${outside} diff --check`, workspace);
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'verify_command_not_allowed');
});

test('acceptAll: only protected lanes and hard evidence block; certification does not', () => {
  // no certification, one actor, weak proof, no verify command — lands
  const bare = reviewTask({
    metadata: { agent_certified: false, agent_review_pass_count: 1, latest_agent_proof: '', verify: undefined },
    review: { agent_certified: false, agent_review_pass_count: 1, proof: '' },
  });
  delete bare.metadata.verify;
  const landed = evaluateAutoAccept(bare, { acceptAll: true });
  assert.equal(landed.eligible, true);
  assert.equal(landed.policy, 'all_but_protected');

  // protected lane still waits for a human
  const billing = evaluateAutoAccept({ ...bare, tag: 'billing' }, { acceptAll: true });
  assert.equal(billing.eligible, false);
  assert.equal(billing.reason, 'denied_tag_billing');

  // a proof naming an unmerged draft PR still blocks
  const draft = evaluateAutoAccept(reviewTask({
    metadata: { latest_agent_proof: 'Opened PR #42, currently open draft awaiting review.', verify: undefined },
  }), { acceptAll: true });
  assert.equal(draft.eligible, false);
  assert.equal(draft.reason, 'proof_unmerged_or_draft_pr_boundary');

  // a recorded check that FAILS still blocks (absence of one does not)
  const failing = evaluateAutoAccept(reviewTask({
    metadata: { verify: 'node --check does-not-exist.js' },
  }), { acceptAll: true });
  assert.equal(failing.eligible, false);
  assert.equal(failing.reason, 'verify_failed');
});

test('denied lanes match tag variants: plurals, compounds, whitespace', () => {
  for (const [tag, lane] of [['deploys', 'deploy'], ['infra-deploy', 'deploy'], [' Billing ', 'billing'], ['customer-facing', 'customer']]) {
    const loose = evaluateAutoAccept({ ...reviewTask(), tag }, { acceptAll: true });
    assert.equal(loose.eligible, false, `acceptAll should deny tag '${tag}'`);
    assert.equal(loose.reason, `denied_tag_${lane}`);
    const strict = evaluateAutoAccept({ ...reviewTask(), tag });
    assert.equal(strict.eligible, false, `certified mode should deny tag '${tag}'`);
    assert.equal(strict.reason, `denied_tag_${lane}`);
  }
  // an unrelated compound is not swallowed by the word matcher
  const fine = evaluateAutoAccept({ ...reviewTask(), tag: 'self-improve' }, { acceptAll: true });
  assert.equal(fine.eligible, true);
});

test('acceptAll: a check pointing at a vanished worktree blocks; an un-runnable check does not', () => {
  const gone = evaluateAutoAccept(reviewTask({
    metadata: { verify: 'git -C reaped-away-worktree diff --check' },
  }), { acceptAll: true });
  assert.equal(gone.eligible, false);
  assert.equal(gone.reason, 'verify_worktree_missing');

  const notAllowed = evaluateAutoAccept(reviewTask({
    metadata: { verify: 'pytest tests/' },
  }), { acceptAll: true });
  assert.equal(notAllowed.eligible, true);
});
