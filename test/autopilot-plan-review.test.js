const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  runPlanReview,
  parseVerdict,
  runTaskOnce,
} = require('../commands/autopilot');

function cleanup(cwd) {
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
}

// Build a workspace with TODO.md (endgame task), lessons.md, and today's journal.
// The journal is needed because appendPlanRejection writes to it.
function setupWorkspace({ verify = 'node --test test/real.test.js' } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-plan-review-'));
  const atrisDir = path.join(cwd, 'atris');
  fs.mkdirSync(atrisDir, { recursive: true });
  fs.writeFileSync(path.join(atrisDir, 'TODO.md'),
`# TODO.md

## Endgame
**Slug:** fixture
**Picked:** 2026-04-19
**Done when:** the fixture passes

## Backlog

- **T1:** Fixture task [endgame] [execute]
  **Files:** stub.txt
  **Exit:** fixture exit
  **Verify:** ${verify}
  **After:** none

## In Progress

## Completed
`);
  fs.writeFileSync(path.join(atrisDir, 'lessons.md'), '# lessons\n\n');
  // Create today's journal so appendPlanRejection has somewhere to write.
  // Use LOCAL time to match appendPlanRejection / getLogPath (production uses local).
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const dateStr = `${year}-${month}-${day}`;
  const logDir = path.join(atrisDir, 'logs', String(year));
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `${dateStr}.md`);
  fs.writeFileSync(logFile, `# ${dateStr}\n\n## Inbox\n\n## Notes\n`);
  return { cwd, logFile };
}

// --- runPlanReview: pure-function tests with stubbed executors ---

test('SIGNOFF → verdict SIGNOFF with validator-only signer', () => {
  const { cwd } = setupWorkspace();
  try {
    const result = runPlanReview({
      cwd,
      context: { task: 'Fixture task', kind: 'endgame', files: ['stub.txt'] },
      planOutput: 'ASCII plan with rollback and verify',
      options: {
        planReviewExec: () => 'Looks good.\n\nSIGNOFF: Verify points at a real test, files declared, rollback named.',
      },
    });
    assert.strictEqual(result.verdict, 'SIGNOFF');
    assert.deepStrictEqual(result.signers, ['validator']);
    assert.match(result.reason, /verify|files|rollback/i);
  } finally {
    cleanup(cwd);
  }
});

test('REJECT → verdict REJECT with reason and fix', () => {
  const { cwd } = setupWorkspace();
  try {
    const result = runPlanReview({
      cwd,
      context: { task: 'Fixture task', kind: 'endgame', files: [] },
      planOutput: 'No rollback. Verify is just `true`.',
      options: {
        planReviewExec: () =>
          'REJECT: Verify is trivial and Files are empty.\nFIX: Make Verify a rubric and declare files.',
      },
    });
    assert.strictEqual(result.verdict, 'REJECT');
    assert.match(result.reason, /trivial|empty/i);
    assert.match(result.fix, /rubric|declare/i);
    assert.deepStrictEqual(result.signers, ['validator']);
  } finally {
    cleanup(cwd);
  }
});

test('codex opted in but absent → skip gracefully with note', () => {
  const { cwd } = setupWorkspace();
  try {
    const result = runPlanReview({
      cwd,
      context: { task: 'Fixture task', kind: 'endgame', files: ['stub.txt'], tags: ['codex'] },
      planOutput: 'OK plan',
      options: {
        planReviewExec: () => 'SIGNOFF: Looks fine.',
        hasCodex: false,
      },
    });
    assert.strictEqual(result.verdict, 'SIGNOFF');
    assert.deepStrictEqual(result.signers, ['validator']);
    assert.match(result.notes || '', /codex.*not on PATH.*skipped/i);
  } finally {
    cleanup(cwd);
  }
});

test('codex disagreeing with validator → REJECT split verdict', () => {
  const { cwd } = setupWorkspace();
  try {
    const result = runPlanReview({
      cwd,
      context: { task: 'Fixture task', kind: 'endgame', files: ['stub.txt'], tags: ['codex'] },
      planOutput: 'Disputable plan',
      options: {
        planReviewExec: () => 'SIGNOFF: Seems reasonable.',
        hasCodex: true,
        codexExec: () => 'REJECT: Missing rollback plan for a schema change.\nFIX: Add explicit rollback.',
      },
    });
    assert.strictEqual(result.verdict, 'REJECT');
    assert.strictEqual(result.split, true);
    assert.deepStrictEqual(result.signers, ['validator', 'codex']);
    assert.match(result.reason, /validator.*SIGNOFF.*codex.*REJECT/i);
  } finally {
    cleanup(cwd);
  }
});

test('codex agrees with validator → SIGNOFF with both signers', () => {
  const { cwd } = setupWorkspace();
  try {
    const result = runPlanReview({
      cwd,
      context: { task: 'Fixture task', kind: 'endgame', files: ['stub.txt'], tags: ['codex'] },
      planOutput: 'Solid plan',
      options: {
        planReviewExec: () => 'SIGNOFF: All contract fields present.',
        hasCodex: true,
        codexExec: () => 'SIGNOFF: Agreed, plan is bounded and falsifiable.',
      },
    });
    assert.strictEqual(result.verdict, 'SIGNOFF');
    assert.deepStrictEqual(result.signers, ['validator', 'codex']);
  } finally {
    cleanup(cwd);
  }
});

// --- parseVerdict: format resilience ---

test('parseVerdict handles trailing verdict after preamble prose', () => {
  const out = 'Thinking about this...\n\nI checked the contract.\n\nSIGNOFF: All good.';
  assert.strictEqual(parseVerdict(out).verdict, 'SIGNOFF');
});

test('parseVerdict handles REJECT without FIX line as a soft pass-through', () => {
  const out = 'REJECT: Something is wrong.';
  const r = parseVerdict(out);
  assert.strictEqual(r.verdict, 'REJECT');
  assert.strictEqual(r.fix, '');
});

test('parseVerdict treats garbage output as REJECT with parse-fail reason', () => {
  const out = 'The plan is fine I guess.';
  const r = parseVerdict(out);
  assert.strictEqual(r.verdict, 'REJECT');
  assert.match(r.reason, /did not contain.*SIGNOFF|did not contain.*REJECT/i);
});

test('parseVerdict extracts PROPOSED block fields on REJECT', () => {
  const out =
    'Reviewing...\n\n' +
    'REJECT: Verify is trivial and Rollback is missing.\n' +
    'FIX: Point Verify at a runnable rubric and name a rollback.\n' +
    'PROPOSED:\n' +
    '  Files: commands/foo.js, test/foo.test.js\n' +
    '  Verify: atris verify foo --section preflight\n' +
    '  Rollback: git revert <sha>\n';
  const r = parseVerdict(out);
  assert.strictEqual(r.verdict, 'REJECT');
  assert.ok(r.proposed, 'proposed block must be captured');
  assert.strictEqual(r.proposed.files, 'commands/foo.js, test/foo.test.js');
  assert.strictEqual(r.proposed.verify, 'atris verify foo --section preflight');
  assert.strictEqual(r.proposed.rollback, 'git revert <sha>');
  assert.strictEqual(r.proposed.exit, undefined, 'Exit was not proposed; should be absent');
});

test('parseVerdict returns null proposed when REJECT has no PROPOSED block', () => {
  const out = 'REJECT: Scope is unclear.\nFIX: Split into two tasks.';
  const r = parseVerdict(out);
  assert.strictEqual(r.verdict, 'REJECT');
  assert.strictEqual(r.proposed, null);
});

test('SIGNOFF never carries a proposed block', () => {
  const out = 'SIGNOFF: Looks good.';
  const r = parseVerdict(out);
  assert.strictEqual(r.verdict, 'SIGNOFF');
  assert.strictEqual(r.proposed, null);
});

// --- runTaskOnce integration: REJECT halts with plan-rejected-at-review ---

test('REJECT from plan-review halts runTaskOnce before do phase', () => {
  const { cwd, logFile } = setupWorkspace();
  try {
    const result = runTaskOnce(
      { task: 'Fixture task', kind: 'endgame', files: ['stub.txt'] },
      {
        cwd,
        verbose: false,
        skipFalsifiability: true,
        phaseExec: (phase) => ({ prompt: `stub ${phase}`, output: `stub output for ${phase}` }),
        planReviewExec: () => 'REJECT: Plan missing rollback.\nFIX: Add rollback field.',
      }
    );
    assert.strictEqual(result.outcome, 'halted');
    assert.strictEqual(result.reason, 'plan-rejected-at-review');
    // Rejection goes to journal Notes, not lessons.md.
    const journal = fs.readFileSync(logFile, 'utf8');
    assert.match(journal, /Plan rejected/);
    assert.match(journal, /Fixture task/);
    const lessons = fs.readFileSync(path.join(cwd, 'atris', 'lessons.md'), 'utf8');
    assert.doesNotMatch(lessons, /plan-rejected/i);
  } finally {
    cleanup(cwd);
  }
});

test('REJECT with PROPOSED draft journals the proposed fields', () => {
  const { cwd, logFile } = setupWorkspace();
  try {
    const result = runTaskOnce(
      { task: 'Fixture task', kind: 'endgame', files: ['stub.txt'] },
      {
        cwd,
        verbose: false,
        skipFalsifiability: true,
        phaseExec: (phase) => ({ prompt: `stub ${phase}`, output: `stub output for ${phase}` }),
        planReviewExec: () =>
          'REJECT: Verify is trivial.\n' +
          'FIX: Point at a rubric.\n' +
          'PROPOSED:\n' +
          '  Verify: atris verify fixture --section preflight\n' +
          '  Rollback: git revert <sha>\n',
      }
    );
    assert.strictEqual(result.outcome, 'halted');
    const journal = fs.readFileSync(logFile, 'utf8');
    assert.match(journal, /Proposed draft/);
    assert.match(journal, /atris verify fixture --section preflight/);
    assert.match(journal, /git revert <sha>/);
  } finally {
    cleanup(cwd);
  }
});
