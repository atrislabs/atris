'use strict';

// resolveNotesJob answers who writes YouTube notes from saved state only: the
// roster layers in order, else the built-in default. These tests pin a saved
// registry for every engine so nothing probes this machine for installed
// tools, and they pass the roster layers in directly so no roster file is read.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveNotesJob } = require('../lib/engine-registry');
const { RUNNER_PROFILE_DEFS } = require('../lib/runner-command');

// Fixed clock. Every date in these tests is written out, never read from the
// machine, so the answers hold in any time zone.
const NOW = '2026-10-23T12:00:00.000Z';
const FAR_FUTURE = '2099-12-31';
const LONG_AGO = '2000-01-01';
const NO_ROSTER = Object.freeze({
  session: Object.freeze({ picks: Object.freeze({}) }),
  project: Object.freeze({ picks: Object.freeze({}) }),
  machine: Object.freeze({ picks: Object.freeze({}) }),
});

// Scratch HOME and no ATRIS_* settings, so the environment never leaks in.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ATRIS_')) delete process.env[key];
}
const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-notes-job-home-'));
process.env.HOME = scratchHome;
process.on('exit', () => fs.rmSync(scratchHome, { recursive: true, force: true }));

function scratchRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-notes-job-root-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// Saves a registry where every engine is installed and ready, except the
// ones in `health`, which get the health block given (for example a recent
// failure that benches the engine).
function saveRegistry(root, health = {}) {
  const engines = Object.keys(RUNNER_PROFILE_DEFS).map((id) => ({
    id,
    name: id,
    installed: true,
    health: health[id] || { status: 'ready' },
  }));
  const file = path.join(root, '.atris', 'state', 'engines.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ engines }, null, 2)}\n`, 'utf8');
}

// A benched agy: it failed ten minutes before NOW, inside the 30 minute cooldown.
const AGY_BENCHED = { agy: { status: 'error', last_failure_ts: '2026-10-23T11:50:00.000Z' } };

test('with nothing saved, the built-in default leads with agy and backs up with haiku', (t) => {
  const root = scratchRoot(t);
  saveRegistry(root);
  const answer = resolveNotesJob(root, { now: NOW, rosterState: NO_ROSTER });
  assert.deepStrictEqual(answer, {
    job: 'notes',
    engine: 'agy',
    model: 'gemini-3.8-flash',
    effort: 'low',
    installed: true,
    backup: [{ engine: 'haiku', model: 'haiku', effort: null, installed: true }],
    source: 'default',
  });
});

test('a machine-wide roster pick decides and is reported as all projects', (t) => {
  const root = scratchRoot(t);
  saveRegistry(root);
  const answer = resolveNotesJob(root, {
    now: NOW,
    rosterState: {
      ...NO_ROSTER,
      machine: { picks: { notes: { engine: 'haiku', model: 'haiku', until: FAR_FUTURE } } },
    },
  });
  assert.strictEqual(answer.source, 'roster');
  assert.strictEqual(answer.from, 'all projects');
  assert.strictEqual(answer.engine, 'haiku');
  assert.strictEqual(answer.model, 'haiku');
  assert.deepStrictEqual(answer.backup, []);
});

test('the session layer beats the project layer, and the project beats all projects', (t) => {
  const root = scratchRoot(t);
  saveRegistry(root);
  const pick = (engine) => ({ engine, model: '', until: FAR_FUTURE });
  const both = resolveNotesJob(root, {
    now: NOW,
    rosterState: {
      session: { picks: {} },
      project: { picks: { notes: pick('haiku') } },
      machine: { picks: { notes: pick('agy') } },
    },
  });
  assert.strictEqual(both.engine, 'haiku');
  assert.strictEqual(both.from, 'this project');

  const withSession = resolveNotesJob(root, {
    now: NOW,
    rosterState: {
      session: { picks: { notes: pick('agy') } },
      project: { picks: { notes: pick('haiku') } },
      machine: { picks: {} },
    },
  });
  assert.strictEqual(withSession.engine, 'agy');
  assert.strictEqual(withSession.from, 'this session');
});

test('a pick whose lead is benched hands the job to its backup', (t) => {
  const root = scratchRoot(t);
  saveRegistry(root, AGY_BENCHED);
  const answer = resolveNotesJob(root, {
    now: NOW,
    rosterState: {
      ...NO_ROSTER,
      machine: { picks: { notes: { engine: 'agy', model: '', until: FAR_FUTURE, backup: 'haiku', backup_model: 'haiku' } } },
    },
  });
  assert.strictEqual(answer.source, 'roster');
  assert.strictEqual(answer.engine, 'haiku');
  assert.deepStrictEqual(answer.backup, []);
});

test('an expired pick with no ready worker falls back to the default and says why', (t) => {
  const root = scratchRoot(t);
  saveRegistry(root);
  const answer = resolveNotesJob(root, {
    now: NOW,
    rosterState: {
      ...NO_ROSTER,
      machine: { picks: { notes: { engine: 'haiku', model: 'haiku', until: LONG_AGO } } },
    },
  });
  assert.strictEqual(answer.source, 'default');
  assert.strictEqual(answer.skipped, 'the notes roster pick (all projects) has no worker ready now');
});

test('a string where a pick should be reads as no pick at all', (t) => {
  const root = scratchRoot(t);
  saveRegistry(root);
  const answer = resolveNotesJob(root, {
    now: NOW,
    rosterState: { ...NO_ROSTER, machine: { picks: { notes: 'haiku' } } },
  });
  assert.strictEqual(answer.source, 'default');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(answer, 'skipped'), false);
});
