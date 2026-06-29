const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  runPlanReview,
  buildPrompt,
  executePhaseDetailed,
  parseVerdict,
  runTaskOnce,
  suggestNextTask,
  shouldSkipAutoHumanGate,
} = require('../commands/autopilot');

const RUNNER_ENV_KEYS = [
  'ATRIS_RUNNER_PROFILE',
  'ATRIS_RUNNER_MODEL',
  'ATRIS_RUNNER_BIN',
  'ATRIS_RUNNER_COMMAND_TEMPLATE',
  'ATRIS_CLAUDE_MODEL',
  'ATRIS_CLAUDE_BIN',
  'ATRIS_CLAUDE_COMMAND_TEMPLATE',
];

function withRunnerEnv(values, fn) {
  const prev = new Map(RUNNER_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of RUNNER_ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values || {})) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const key of RUNNER_ENV_KEYS) {
      const value = prev.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

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

test('default codex plan-review runner fails non-zero output instead of signing partial stdout', () => {
  const { cwd } = setupWorkspace();
  try {
    const cmdPath = path.join(cwd, 'fake-codex.sh');
    fs.writeFileSync(cmdPath, '#!/bin/sh\necho codex-partial\nexit 7\n');
    fs.chmodSync(cmdPath, 0o755);
    const previous = process.env.ATRIS_CODEX_CMD;
    process.env.ATRIS_CODEX_CMD = cmdPath;
    try {
      const result = runPlanReview({
        cwd,
        context: { task: 'Fixture task', kind: 'endgame', files: ['stub.txt'], tags: ['codex'] },
        planOutput: 'candidate plan',
        options: {
          planReviewExec: () => 'SIGNOFF: Validator approves.',
          hasCodex: true,
        },
      });
      assert.strictEqual(result.verdict, 'SIGNOFF');
      assert.deepStrictEqual(result.signers, ['validator']);
      assert.match(result.notes || '', /codex invocation failed/);
      assert.match(result.notes || '', /codex exited with status 7/);
      assert.match(result.notes || '', /stdout:\ncodex-partial/);
    } finally {
      if (previous === undefined) delete process.env.ATRIS_CODEX_CMD;
      else process.env.ATRIS_CODEX_CMD = previous;
    }
  } finally {
    cleanup(cwd);
  }
});

test('executePhaseDetailed fails non-zero configured runner output instead of returning stdout', () => {
  assert.throws(
    () => executePhaseDetailed(
      'plan',
      { task: 'Fixture task', kind: 'endgame', files: ['stub.txt'] },
      { cmdOverride: 'sh -c "echo phase-partial; exit 7"', timeout: 5000 }
    ),
    /plan phase failed:[\s\S]*stdout:\nphase-partial/
  );
});

test('default plan-review runner fails non-zero output instead of signing partial stdout', () => {
  const { cwd } = setupWorkspace();
  try {
    withRunnerEnv({
      ATRIS_RUNNER_BIN: 'sh',
      ATRIS_RUNNER_COMMAND_TEMPLATE: 'sh -c "echo review-partial; exit 7"',
    }, () => {
      assert.throws(
        () => runPlanReview({
          cwd,
          context: { task: 'Fixture task', kind: 'endgame', files: ['stub.txt'] },
          planOutput: 'candidate plan',
        }),
        /plan-review runner failed:[\s\S]*stdout:\nreview-partial/
      );
    });
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

test('reactive maintenance task adopts planner-written explicit verify', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-reactive-verify-'));
  const original = process.cwd();
  try {
    const atrisDir = path.join(cwd, 'atris');
    fs.mkdirSync(atrisDir, { recursive: true });
    fs.writeFileSync(path.join(atrisDir, 'TODO.md'),
`# TODO.md

## Backlog

## In Progress

## Completed
`);
    fs.writeFileSync(path.join(atrisDir, 'lessons.md'), '# lessons\n\n');
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const logDir = path.join(atrisDir, 'logs', String(year));
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, `${year}-${month}-${day}.md`), `# log\n\n## Completed\n\n## Notes\n`);
    fs.writeFileSync(path.join(cwd, 'source.md'), 'needle\n');
    process.chdir(cwd);

    const verify = 'node -e "process.exit(0)"';
    const result = runTaskOnce(
      { task: 'Re-read sources and update atris/wiki/briefs/starter.md', kind: 'staleness', files: ['source.md'] },
      {
        cwd,
        verbose: false,
        phaseExec: (phase) => {
          if (phase === 'plan') {
            fs.writeFileSync(path.join(atrisDir, 'TODO.md'),
`# TODO.md

## Backlog

- **T1:** Refresh starter brief from source [execute]
  **Files:** source.md
  **Exit:** starter brief reflects source
  **Verify:** ${verify}
  **Rollback:** git checkout -- atris/wiki/briefs/starter.md

## In Progress

## Completed
`);
          }
          return { prompt: `${phase} prompt`, output: `${phase} ok` };
        },
        planReviewExec: () => 'SIGNOFF: Files, Exit, Verify, and Rollback are concrete.',
      }
    );

    assert.strictEqual(result.verifyCmd, verify);
    assert.strictEqual(result.verifyPass, true);
    assert.strictEqual(result.success, true);
  } finally {
    process.chdir(original);
    cleanup(cwd);
  }
});

test('reactive maintenance task rejects prose-shaped explicit verify before do', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-reactive-verify-prose-'));
  const original = process.cwd();
  try {
    const atrisDir = path.join(cwd, 'atris');
    fs.mkdirSync(atrisDir, { recursive: true });
    fs.writeFileSync(path.join(atrisDir, 'TODO.md'),
`# TODO.md

## Backlog

## In Progress

## Completed
`);
    fs.writeFileSync(path.join(atrisDir, 'lessons.md'), '# lessons\n\n');
    process.chdir(cwd);

    const verify = "`rg -c 'needle' source.md` returns 1 AND `rg 'updated:' page.md` shows today's date";
    const phases = [];
    const result = runTaskOnce(
      { task: 'Re-read sources and update page.md', kind: 'staleness', files: ['source.md'] },
      {
        cwd,
        verbose: false,
        phaseExec: (phase) => {
          phases.push(phase);
          if (phase === 'plan') {
            fs.writeFileSync(path.join(atrisDir, 'TODO.md'),
`# TODO.md

## Backlog

- **T1:** Refresh page [execute]
  **Files:** source.md, page.md
  **Exit:** page reflects source
  **Verify:** ${verify}
  **Rollback:** git checkout -- page.md

## In Progress

## Completed
`);
          }
          return { prompt: `${phase} prompt`, output: `${phase} ok` };
        },
        planReviewExec: () => 'SIGNOFF: Looks concrete.',
      }
    );

    assert.strictEqual(result.outcome, 'halted');
    assert.strictEqual(result.reason, 'verify-not-runnable');
    assert.deepStrictEqual(phases, ['plan']);
    const lessons = fs.readFileSync(path.join(atrisDir, 'lessons.md'), 'utf8');
    assert.match(lessons, /verify-not-runnable/);
  } finally {
    process.chdir(original);
    cleanup(cwd);
  }
});

test('auto picker skips owner-gated in-progress tasks', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-auto-owner-gate-'));
  try {
    const atrisDir = path.join(cwd, 'atris');
    fs.mkdirSync(atrisDir, { recursive: true });
    fs.writeFileSync(path.join(atrisDir, 'TODO.md'),
`# TODO.md

## Backlog

- **T2:** Run local code health check

## In Progress

- **BCK-427:** Confirm customer destination before AEO owner approval
  **Claimed by:** keshavrao at 2026-05-22T07:15:00Z

## Completed
`);
    fs.writeFileSync(path.join(atrisDir, 'lessons.md'), '# lessons\n\n');

    const suggestion = await suggestNextTask(cwd, new Set(), { auto: true });
    assert.equal(suggestion.task, 'Run local code health check');
    assert.equal(suggestion.kind, 'backlog');
  } finally {
    cleanup(cwd);
  }
});

test('auto picker trusts clean repo MAP audit over healer false positives', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-auto-map-audit-'));
  try {
    const atrisDir = path.join(cwd, 'atris');
    fs.mkdirSync(atrisDir, { recursive: true });
    fs.mkdirSync(path.join(cwd, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(atrisDir, 'TODO.md'),
`# TODO.md

## Backlog

- **T2:** Run local code health check

## In Progress

## Completed
`);
    fs.writeFileSync(path.join(atrisDir, 'MAP.md'),
`# MAP

\`\`\`
RL Stack (backend/rl/)
  core.py:17    TaskType enum
\`\`\`
`);
    fs.writeFileSync(path.join(cwd, 'scripts', 'audit_map_refs.py'),
`#!/usr/bin/env python3
print("Total broken references: 0")
`);
    fs.writeFileSync(path.join(atrisDir, 'lessons.md'), '# lessons\n\n');

    const suggestion = await suggestNextTask(cwd, new Set(), { auto: true });
    assert.equal(suggestion.task, 'Run local code health check');
    assert.equal(suggestion.kind, 'backlog');
  } finally {
    cleanup(cwd);
  }
});

test('auto human-gate classifier keeps normal agent work runnable', () => {
  assert.equal(shouldSkipAutoHumanGate({
    title: 'Confirm customer destination before AEO owner approval',
    claimed: 'keshavrao at 2026-05-22T07:15:00Z',
  }), true);
  assert.equal(shouldSkipAutoHumanGate({
    title: 'Fix mission selector regression',
    claimed: 'codex at 2026-05-22T07:15:00Z',
  }), false);
});

test('staleness planning prompt requires executable verify and rollback fields', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-staleness-prompt-'));
  const original = process.cwd();
  try {
    fs.mkdirSync(path.join(cwd, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'atris', 'TODO.md'), '# TODO\n');
    fs.writeFileSync(path.join(cwd, 'atris', 'PERSONA.md'), '# persona\n');
    fs.writeFileSync(path.join(cwd, 'atris', 'MAP.md'), '# map\n');
    fs.writeFileSync(path.join(cwd, 'atris', 'lessons.md'), '# lessons\n');
    process.chdir(cwd);
    const prompt = buildPrompt('plan', {
      task: 'Re-read sources and update atris/wiki/briefs/starter.md',
      kind: 'staleness',
      files: [
        'atris/wiki/briefs/starter.md',
        'atris/context/_ingest/onboarding/intake.md',
      ],
    });

    assert.match(prompt, /atris\/wiki\/briefs\/starter\.md/);
    assert.match(prompt, /atris\/context\/_ingest\/onboarding\/intake\.md/);
    assert.match(prompt, /\*\*Files:\*\*/);
    assert.match(prompt, /\*\*Exit:\*\*/);
    assert.match(prompt, /\*\*Verify:\*\*/);
    assert.match(prompt, /\*\*Rollback:\*\*/);
    assert.match(prompt, /Do not write tasks without Verify and Rollback/);
    assert.match(prompt, /one raw shell command/);
    assert.match(prompt, /not Markdown backticks or English/);
  } finally {
    process.chdir(original);
    cleanup(cwd);
  }
});
