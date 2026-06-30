'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildAutopilotGlassLog,
  runTaskOnce,
  writeAutopilotGlassLog,
} = require('../commands/autopilot');

function setupWorkspace() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-autopilot-glass-'));
  const atrisDir = path.join(cwd, 'atris');
  fs.mkdirSync(atrisDir, { recursive: true });
  fs.writeFileSync(path.join(atrisDir, 'TODO.md'), `# TODO.md

## Backlog

- **T1:** Fixture autopilot task [endgame]
  **Files:** fixture.txt
  **Exit:** fixture verifier passes
  **Verify:** node -e "process.exit(0)"
  **Rollback:** rm -f fixture.txt

## In Progress

## Completed
`);
  fs.writeFileSync(path.join(atrisDir, 'lessons.md'), '# lessons\n');
  return cwd;
}

function cleanup(cwd) {
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
}

test('buildAutopilotGlassLog renders plan action result proof ladder', () => {
  const content = buildAutopilotGlassLog(
    { task: 'Fixture autopilot task', kind: 'endgame' },
    {
      success: true,
      verifyCmd: 'node test.js',
      verifyRan: true,
      verifyPass: true,
      phaseResults: {
        plan: { output: 'Plan the work', elapsedSeconds: 1 },
        'plan-review': { output: 'SIGNOFF: bounded', elapsedSeconds: 1 },
        do: { output: 'Changed fixture.txt', elapsedSeconds: 2 },
        review: { output: 'Looks good', elapsedSeconds: 1 },
        verify: { output: 'Verify passed (0s)', elapsedSeconds: 0 },
      },
    },
    { generatedAt: '2026-06-30T00:00:00.000Z' }
  );

  assert.match(content, /# Autopilot Glass Log/);
  assert.match(content, /## Plan/);
  assert.match(content, /## Plan Review/);
  assert.match(content, /## Action/);
  assert.match(content, /## Result/);
  assert.match(content, /## Proof/);
  assert.match(content, /PASS: Verify passed/);
});

test('writeAutopilotGlassLog writes under atris logs autopilot', () => {
  const cwd = setupWorkspace();
  try {
    const relPath = writeAutopilotGlassLog(
      cwd,
      { task: 'Fixture autopilot task', kind: 'endgame' },
      {
        success: true,
        verifyCmd: 'node test.js',
        verifyRan: true,
        verifyPass: true,
        phaseResults: {
          plan: { output: 'Plan output' },
          'plan-review': { output: 'SIGNOFF: ok' },
          do: { output: 'Action output' },
          review: { output: 'Result output' },
          verify: { output: 'Verify passed (0s)' },
        },
      },
      { now: new Date('2026-06-30T00:00:00.000Z') }
    );

    assert.match(relPath, /^atris\/logs\/autopilot\/2026-06-30T00-00-00-000Z-fixture-autopilot-task\.md$/);
    const body = fs.readFileSync(path.join(cwd, relPath), 'utf8');
    assert.match(body, /Action output/);
    assert.match(body, /## Proof/);
  } finally {
    cleanup(cwd);
  }
});

test('runTaskOnce writes a glass log for a successful autopilot tick', () => {
  const cwd = setupWorkspace();
  try {
    const execution = runTaskOnce(
      { task: 'Fixture autopilot task', kind: 'endgame', files: ['fixture.txt'] },
      {
        cwd,
        skipFalsifiability: true,
        phaseExec: (phase) => ({
          prompt: `${phase} prompt`,
          output: `${phase} output`,
        }),
        planReviewExec: () => 'SIGNOFF: plan is bounded and has rollback.',
      }
    );

    assert.equal(execution.success, true);
    assert.match(execution.glassLogPath, /^atris\/logs\/autopilot\//);

    const body = fs.readFileSync(path.join(cwd, execution.glassLogPath), 'utf8');
    assert.match(body, /Task: Fixture autopilot task/);
    assert.match(body, /## Plan\n\nplan output/);
    assert.match(body, /## Plan Review\n\nSIGNOFF: plan is bounded/);
    assert.match(body, /## Action\n\ndo output/);
    assert.match(body, /## Result\n\nreview output/);
    assert.match(body, /## Proof\n\nPASS: Verify passed/);
  } finally {
    cleanup(cwd);
  }
});
