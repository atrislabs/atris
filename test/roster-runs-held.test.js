'use strict';

// A held run is a build whose pull request waits for a person to land it. It is
// not a landing and it is not a miss, so everything that reads the run history
// has to leave it out of both counts.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { OUTCOMES, appendRosterRun, readRosterRuns, summarizeRuns, renderRunLine, runView } = require('../lib/roster-runs');
const { attachSuggestions } = require('../lib/roster-suggest');
const { loadRouterHistory } = require('../lib/router-brain');
const { memberEngineChoices } = require('../lib/roster-swap');

const PR_URL = 'https://github.example/repo/pull/77';
const WAITING = `waiting for a person to land ${PR_URL}`;
const NOW = Date.parse('2026-10-30T12:00:00.000Z');
const at = (minutes) => new Date(NOW - minutes * 60000).toISOString();

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-held-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('held is a recorded outcome; an outcome nobody knows is still a failure', (t) => {
  const root = tempRoot(t);
  assert.ok(OUTCOMES.includes('held'));
  appendRosterRun(root, { at: at(10), job: 'build', engine: 'codex', outcome: 'held', task: 'BCK-1', detail: WAITING, seconds: 90 });
  appendRosterRun(root, { at: at(5), job: 'build', engine: 'codex', outcome: 'mystery', task: 'BCK-2' });
  const runs = readRosterRuns(root, { now: NOW });
  assert.deepEqual(runs.map((run) => [run.task, run.outcome]), [['BCK-1', 'held'], ['BCK-2', 'failed']]);
  assert.equal(runs[0].detail, WAITING);
});

test('the summary counts a held run as a run, but as neither landed nor failed, and says it is waiting', () => {
  const runs = [
    { outcome: 'landed', engine: 'codex', seconds: 60 },
    { outcome: 'held', engine: 'codex', seconds: 60 },
    { outcome: 'held', engine: 'codex', seconds: 60 },
    { outcome: 'failed', engine: 'codex', seconds: 60 },
  ];
  const summary = summarizeRuns(runs);
  assert.equal(summary.runs, 4);
  assert.equal(summary.landed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.held, 2);
  assert.match(summary.text, /4 runs, 1 landed, 1 failed, 2 waiting for a person to land/);
  // No held runs: the summary is exactly what it was.
  const plain = summarizeRuns(runs.filter((run) => run.outcome !== 'held'));
  assert.equal(plain.held, undefined);
  assert.doesNotMatch(plain.text, /waiting/);
});

test('a held run reads as waiting on its line and in the json, with its own reason', () => {
  const run = { at: at(10), job: 'build', engine: 'codex', outcome: 'held', task: 'BCK-1', detail: WAITING, seconds: 90 };
  assert.match(renderRunLine(run), new RegExp(`, held, ${WAITING.replace(/[.]/g, '\\.')}$`));
  assert.equal(runView(run).reason, WAITING);
  assert.equal(runView({ ...run, detail: undefined }).reason, 'waiting for a person to land it');
});

// roster-suggest: a worker is judged on runs that ended.

function suggestionFor(leadOutcomes) {
  const row = { job: 'build', pick: { engine: 'codex' }, workers: [{ engine: 'codex', model: 'lead-model' }, { engine: 'claude', model: 'challenger-model' }] };
  const runs = (engine, model, outcomes) => outcomes.map((outcome, index) => ({ at: `2024-01-${String(index + 1).padStart(2, '0')}T12:00:00.000Z`, job: 'build', engine, model, outcome }));
  attachSuggestions([row], [...runs('codex', 'lead-model', leadOutcomes), ...runs('claude', 'challenger-model', ['landed', 'landed'])]);
  return row.suggestion || null;
}

test('a lead with builds waiting for a person is not suggested away for them', () => {
  // Stalled twice and landed once is a lead to replace...
  assert.ok(suggestionFor(['stalled', 'stalled', 'landed']));
  // ...but two builds that are only waiting for a person are not misses.
  assert.equal(suggestionFor(['held', 'held', 'landed']), null);
});

// router-brain: each run is one pass or one miss when ranking engines.

test('the router does not score a held run as a pass or as a miss', (t) => {
  const root = tempRoot(t);
  appendRosterRun(root, { at: at(30), job: 'build', engine: 'cursor', outcome: 'held', task: 'BCK-1', seconds: 60 });
  appendRosterRun(root, { at: at(20), job: 'build', engine: 'cursor', outcome: 'landed', task: 'BCK-2', seconds: 60 });
  appendRosterRun(root, { at: at(10), job: 'build', engine: 'cursor', outcome: 'failed', task: 'BCK-3', seconds: 60 });
  const history = loadRouterHistory(root, { now: NOW });
  assert.deepEqual(history.map((row) => row.verified_passed), [true, false], 'only the landed and the failed run count');
});

// roster-swap: the owner's card says how many of a model's runs finished.

test('the swap card does not count a held run as finished, and says it is waiting', (t) => {
  const root = tempRoot(t);
  const keys = ['HOME', 'ATRIS_MACHINE_ROSTER_MD_PATH', 'ATRIS_MACHINE_ROSTER_PATH', 'ATRIS_ROSTER_SESSION', 'ATRIS_ROSTER_SESSIONS_DIR'];
  const saved = keys.map((key) => [key, process.env[key]]);
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  for (const key of keys) delete process.env[key];
  process.env.HOME = root;
  const roster = path.join(root, '.atris', 'ROSTER.md');
  fs.mkdirSync(path.dirname(roster), { recursive: true });
  fs.writeFileSync(roster, '# roster\n\n## build\n- fable, model: claude-haiku-5-5\n\n## team\n- builder: fable, model: claude-haiku-5-5\n');
  process.env.ATRIS_MACHINE_ROSTER_MD_PATH = roster;
  const member = path.join(root, 'atris', 'team', 'builder');
  fs.mkdirSync(member, { recursive: true });
  fs.writeFileSync(path.join(member, 'MEMBER.md'), '---\nname: builder\nrole: builder\n---\n');
  fs.mkdirSync(path.join(root, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, '.atris', 'state', 'engines.json'), JSON.stringify({
    engines: Object.keys(require('../lib/runner-command').RUNNER_PROFILE_DEFS).map((id) => ({ id, ...(id === 'fable' ? { models: ['claude-haiku-5-5'], models_set_by_owner: true } : {}), health: { status: 'ready' } })),
  }));
  const now = new Date('2026-01-15T12:00:00Z');
  const run = (hoursAgo, outcome) => appendRosterRun(root, { at: new Date(now.getTime() - hoursAgo * 3600000).toISOString(), job: 'build', engine: 'fable', model: 'claude-haiku-5-5', outcome, task: `BCK-${hoursAgo}` });
  run(1, 'landed');
  run(2, 'failed');
  run(3, 'held');
  const card = memberEngineChoices(root, 'builder', { now });
  const model = card.groups.find((group) => group.engine === 'fable').models.find((entry) => entry.model === 'claude-haiku-5-5');
  assert.equal(model.record, '1 of 2 finished this week, 1 waiting for a person');
});
