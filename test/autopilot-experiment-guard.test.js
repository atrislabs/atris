const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Seen live 2026-07-07: a pulse autopilot tick hand-applied two queued
// experiment patches, its verify failed, and the dirty targets locked the
// gated keep/revert loop out. The do-phase prompt must name pending
// experiment targets as do-not-touch, and the guard must vanish once the
// queue entries have run.

const { buildPrompt, pendingExperimentTargets } = require('../commands/autopilot');

function seedWorkspace(dir, { history = [] } = {}) {
  fs.mkdirSync(path.join(dir, 'atris', 'experiments', 'daily'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'atris', 'experiments', 'daily', 'queue.jsonl'),
    [
      JSON.stringify({ id: 'exp-pending', target_files: ['commands/mission.js'], apply: 'x.js' }),
      JSON.stringify({ id: 'exp-done', target_files: ['commands/autopilot.js'], apply: 'y.js' }),
    ].join('\n') + '\n',
  );
  fs.writeFileSync(
    path.join(dir, '.atris', 'state', 'experiments-daily.json'),
    JSON.stringify({ history, last_run_date: '2026-07-07' }),
  );
}

test('pendingExperimentTargets lists only targets of entries not yet run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-guard-'));
  try {
    seedWorkspace(dir, { history: ['exp-done'] });
    assert.deepEqual(pendingExperimentTargets(dir), ['commands/mission.js']);
    seedWorkspace(dir, { history: ['exp-done', 'exp-pending'] });
    assert.deepEqual(pendingExperimentTargets(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('do-phase prompt names pending experiment targets as do-not-touch', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-guard-'));
  const originalCwd = process.cwd();
  try {
    seedWorkspace(dir, { history: ['exp-done'] });
    process.chdir(dir);
    const prompt = buildPrompt('do', { task: 'fix something small', kind: 'task' });
    assert.match(prompt, /gated experiment loop owns pending patches/);
    assert.match(prompt, /commands\/mission\.js/);
    assert.doesNotMatch(prompt, /commands\/autopilot\.js.*pending patches/);

    seedWorkspace(dir, { history: ['exp-done', 'exp-pending'] });
    const cleanPrompt = buildPrompt('do', { task: 'fix something small', kind: 'task' });
    assert.doesNotMatch(cleanPrompt, /gated experiment loop/);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
