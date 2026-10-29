'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { engineVerifierLineup, runEngineVerifier } = require('../commands/mission');
const { setEngineHealth, readEngineRegistry } = require('../lib/engine-registry');

// Member lab 10/26: codex hung on every review and each job waited out the
// full five minutes. The roster's review backup now steps in, a benched
// reviewer goes behind it, and the builder never grades its own work.
test('the review backup steps in, never as the builder grading itself', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-review-backup-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-review-home-'));
  const previous = process.env.ATRIS_MACHINE_ROSTER_PATH;
  process.env.ATRIS_MACHINE_ROSTER_PATH = path.join(home, '.atris', 'roster.json');
  try {
    spawnSync('git', ['init', '-q'], { cwd: root });
    fs.mkdirSync(path.join(root, 'atris'));
    fs.mkdirSync(path.join(home, '.atris'));
    fs.writeFileSync(path.join(home, '.atris', 'ROSTER.md'), [
      '# roster', '',
      '## review',
      '- codex, model: gpt-6.1-sol',
      '- claude code, model: opus 5.5', '',
    ].join('\n'));
    setEngineHealth('codex', 'ready', root);
    setEngineHealth('claude', 'ready', root);
    const lineup = (mission, named = '') => engineVerifierLineup(mission, root, named, { healthRoot: root })
      .map(({ engine, model }) => `${engine} ${model}`.trim());

    // The builder runs the model the spend gate lets it run, so each builder
    // model here carries the owner's yes for that exact model.
    const withYes = (yes, fn) => {
      const before = process.env.ATRIS_SPEND_OK;
      process.env.ATRIS_SPEND_OK = yes;
      try { return fn(); } finally {
        if (before === undefined) delete process.env.ATRIS_SPEND_OK;
        else process.env.ATRIS_SPEND_OK = before;
      }
    };
    assert.deepEqual(withYes('claude-sonnet-5-5', () => lineup({ runner: 'claude', model: 'claude-sonnet-5-5' })), ['codex', 'claude claude-opus-5-5']);
    // Opus built it, so opus may not review it, however the model is spelled.
    assert.deepEqual(withYes('claude-opus-5-5', () => lineup({ runner: 'claude', model: 'claude-opus-5-5' })), ['codex']);
    assert.deepEqual(withYes('opus', () => lineup({ runner: 'claude', model: 'opus' })), ['codex']);
    assert.deepEqual(withYes('claude-opus-5-5[1m]', () => lineup({ runner: 'claude', model: 'claude-opus-5-5[1m]' })), ['codex']);
    assert.deepEqual(withYes('opus', () => lineup({ model: 'opus' })), ['codex']);
    // A named reviewer is never swapped.
    assert.deepEqual(lineup({ runner: 'claude', model: 'claude-sonnet-5-5' }, 'codex'), ['codex']);
    // A benched reviewer is skipped while its backup can run.
    setEngineHealth('codex', 'cooling', root);
    assert.deepEqual(withYes('claude-sonnet-5-5', () => lineup({ runner: 'claude', model: 'claude-sonnet-5-5' })), ['claude claude-opus-5-5']);
    assert.deepEqual(withYes('claude-opus-5-5', () => lineup({ runner: 'claude', model: 'claude-opus-5-5' })), ['codex']);
  } finally {
    if (previous === undefined) delete process.env.ATRIS_MACHINE_ROSTER_PATH;
    else process.env.ATRIS_MACHINE_ROSTER_PATH = previous;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a reviewer timeout is shared across projects and a successful review clears it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-review-shared-'));
  const projectA = path.join(home, 'project-a');
  const projectB = path.join(home, 'project-b');
  const previous = { HOME: process.env.HOME, ATRIS_MACHINE_ROSTER_PATH: process.env.ATRIS_MACHINE_ROSTER_PATH, ATRIS_RUNNER_COMMAND_TEMPLATE: process.env.ATRIS_RUNNER_COMMAND_TEMPLATE };
  try {
    process.env.HOME = home;
    process.env.ATRIS_MACHINE_ROSTER_PATH = path.join(home, '.atris', 'roster.json');
    fs.mkdirSync(path.join(home, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(home, '.atris', 'ROSTER.md'), '# roster\n\n## review\n- codex, model: gpt-6.1-sol\n- claude code, model: opus 5.5\n');
    for (const project of [projectA, projectB]) {
      fs.mkdirSync(path.join(project, 'atris'), { recursive: true });
      spawnSync('git', ['init', '-q'], { cwd: project });
      setEngineHealth('codex', 'ready', project);
      setEngineHealth('claude', 'ready', project);
    }
    const runner = path.join(home, 'reviewer.js');
    fs.writeFileSync(runner, "if (process.env.REVIEW_TEST_PASS) console.log('VERDICT: PASS'); else setTimeout(() => {}, 10000);\n");
    process.env.ATRIS_RUNNER_COMMAND_TEMPLATE = `node ${runner}`;
    const mission = { id: 'review-test', runner: 'claude', model: 'claude-sonnet-5-5', objective: 'check work' };
    const lineup = () => engineVerifierLineup(mission, projectB).map((entry) => entry.engine);
    assert.deepEqual(lineup(), ['codex', 'claude']);
    const timedOut = await runEngineVerifier(mission, { cwd: projectA, refereeEngine: 'codex', timeoutMs: 100 });
    assert.equal(timedOut.timed_out, true);
    assert.equal(readEngineRegistry(projectA, { persist: false }).engines.find((entry) => entry.id === 'codex').health.status, 'cooling');
    assert.deepEqual(lineup(), ['claude']);
    process.env.REVIEW_TEST_PASS = '1';
    const passed = await runEngineVerifier(mission, { cwd: projectA, refereeEngine: 'codex', timeoutMs: 5000 });
    assert.equal(passed.passed, true);
    assert.equal(readEngineRegistry(projectA, { persist: false }).engines.find((entry) => entry.id === 'codex').health.status, 'ready');
    assert.deepEqual(lineup(), ['codex', 'claude']);
  } finally {
    delete process.env.REVIEW_TEST_PASS;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
