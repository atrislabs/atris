'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { addIdea, changeRefusal, ideaRefusal, readIdeas, updateIdea } = require('../lib/idea-inbox');
const { ideaScore, readOutcomes, recordOutcome, repeatedFailure, scoreLine } = require('../lib/idea-ledger');
const { runIdeaTick } = require('../lib/idea-tick');
const { ideaAtris } = require('../commands/idea');

const HOUR = 60 * 60 * 1000;

function tempRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atris-idea-ledger-')));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { 'test:fast': 'node --test' } }));
  return dir;
}

const signedOff = { passed: true, validator_result: { passed: true, independent: true, engine: 'codex', executor_engine: 'claude' } };

function doneLap(overrides = {}) {
  return { status: 'done', task_id: 'T-7', engine: 'claude', changed: 'Faster search', worktree: '/wt/t-7', result: signedOff, ...overrides };
}

// One tick with fake build, inspect, and land steps, on a clock the test sets.
function tick(repo, {
  lap = doneLap(),
  change = { ok: true, paths: ['lib/search.js'], addedLines: ['const fast = true;'] },
  shipOut = { status: 0, stdout: 'verify: npm run test:fast\nmerge_check: origin/master clean\npr: https://github.com/o/r/pull/9\nmerge: merged\ndone: worktree shipped\n', stderr: '' },
  loopRepo = null,
  at = Date.now(),
  minutes = 12,
} = {}) {
  const logs = [];
  const ships = [];
  let now = at;
  return runIdeaTick({
    root: repo,
    loopRepo,
    log: (line) => logs.push(line),
    clock: () => now,
    runLap: async (text, options) => {
      now += minutes * 60 * 1000;
      if (lap) options.onResult(typeof lap === 'function' ? lap(text) : lap);
      return 0;
    },
    ship: (worktree, args) => { ships.push(args); return shipOut; },
    inspectChange: () => change,
    landTarget: () => 'origin/master',
  }).then((outcome) => ({ outcome, logs, ships }));
}

test('every picked-up idea leaves one ledger row saying how it ended and where', async () => {
  const repo = tempRepo();
  const t0 = Date.parse('2026-10-23T10:00:00Z');
  addIdea(repo, 'make the inbox search faster', { now: new Date(t0 - 30 * 60 * 1000) });
  await tick(repo, { at: t0, minutes: 12 });

  const [row] = readOutcomes(repo);
  assert.equal(row.schema, 'atris.idea_outcome.v1');
  assert.equal(row.outcome, 'landed');
  assert.equal(row.stage, null);
  assert.equal(row.repo, repo);
  assert.equal(row.started, new Date(t0).toISOString());
  assert.equal(row.finished, new Date(t0 + 12 * 60 * 1000).toISOString());
  assert.equal(row.minutes, 12);
  assert.equal(row.attempt, 1);
  assert.equal(row.link, 'https://github.com/o/r/pull/9');
  assert.equal(row.task_id, 'T-7');

  const cases = [
    [{ lap: doneLap({ result: { passed: true, validator_result: { passed: true, independent: false, engine: 'claude', executor_engine: 'claude' } } }) }, 'failed', 'review', /no second engine signed off/],
    [{ lap: { status: 'stuck', task_id: 'T-8', reason: 'npm run test:fast exited 1', checked: 'npm run test:fast failed (exit 1)' } }, 'failed', 'checks', /exited 1/],
    [{ lap: { status: 'stuck', task_id: 'T-9', reason: 'the validator rejected it', checked: 'npm run test:fast passed (exit 0)' } }, 'failed', 'review', /validator rejected/],
    [{ lap: { status: 'stuck', task_id: 'T-10', reason: 'engine not ready' } }, 'failed', 'build', /engine not ready/],
    [{ shipOut: { status: 1, stdout: 'verify: npm run test:fast\n', stderr: 'Error: 3 tests failed\n' } }, 'failed', 'checks', /3 tests failed/],
    [{ shipOut: { status: 1, stdout: 'verify: npm run test:fast\nmerge_check: origin/master clean\npush: origin b\n', stderr: 'rejected: non-fast-forward\n' } }, 'failed', 'push', /non-fast-forward/],
    [{ change: { ok: true, paths: ['db/migrations/0042.sql'], addedLines: [] } }, 'refused', 'review', /database migrations/],
  ];
  for (const [options, outcome, stage, cause] of cases) {
    const fresh = tempRepo();
    addIdea(fresh, 'make the inbox search faster');
    await tick(fresh, options);
    const rows = readOutcomes(fresh);
    assert.equal(rows.length, 1, JSON.stringify(options));
    assert.equal(rows[0].outcome, outcome, JSON.stringify(options));
    assert.equal(rows[0].stage, stage, JSON.stringify(options));
    assert.match(rows[0].cause, cause);
  }

  // An intake refusal (the rules caught the idea after it was saved) is a
  // refused row at the intake stage, and it is not a build.
  const fresh = tempRepo();
  const stale = addIdea(fresh, 'tidy the help text');
  fs.appendFileSync(path.join(fresh, '.atris', 'state', 'ideas.jsonl'), `${JSON.stringify({ kind: 'update', id: stale.id, at: new Date().toISOString(), text: 'charge every customer twice' })}\n`);
  await tick(fresh);
  const [intake] = readOutcomes(fresh);
  assert.equal(intake.outcome, 'refused');
  assert.equal(intake.stage, 'intake');
  assert.match(intake.cause, /touches money/);
});

test('the score counts landings in 24h, first-try landings, and median minutes from idea to landed', () => {
  const now = Date.parse('2026-10-23T12:00:00Z');
  const at = (hoursAgo) => new Date(now - hoursAgo * HOUR).toISOString();
  const rows = [
    // a: landed first try, 20 minutes after it was dropped
    { id: 'a', idea_at: at(3 + 20 / 60), finished: at(3), outcome: 'landed', stage: null },
    // b: failed once, then landed 60 minutes after it was dropped
    { id: 'b', idea_at: at(5), finished: at(4.5), outcome: 'failed', stage: 'checks', cause: 'tests failed' },
    { id: 'b', idea_at: at(5), finished: at(4), outcome: 'landed', stage: null },
    // c: landed first try two days ago, 40 minutes after it was dropped
    { id: 'c', idea_at: at(48 + 40 / 60), finished: at(48), outcome: 'landed', stage: null },
    // d: refused at intake, which is not a build and does not count
    { id: 'd', idea_at: at(1), finished: at(1), outcome: 'refused', stage: 'intake', cause: 'touches money' },
    // e: landed first try 10 days ago, outside the 7 day window
    { id: 'e', idea_at: at(241), finished: at(240), outcome: 'landed', stage: null },
  ].map((row) => ({ schema: 'atris.idea_outcome.v1', ...row }));

  const score = ideaScore(rows, { now });
  assert.equal(score.landed_24h, 2);
  assert.equal(score.first_try_landed, 2);
  assert.equal(score.first_try_tried, 3);
  assert.equal(score.first_try_rate, 67);
  assert.equal(score.median_minutes_to_landed, 40);
  assert.equal(scoreLine(score), 'score: 2 landed in the last 24h. 2 of 3 landed first try (67%, last 7 days). median 40 min from idea to landed.');
  assert.equal(scoreLine(ideaScore([], { now })), 'score: nothing built yet.');
  assert.equal(
    scoreLine(ideaScore([{ id: 'x', finished: at(1), outcome: 'failed', stage: 'build', cause: 'crash' }], { now })),
    'score: 0 landed in the last 24h. 0 of 1 landed first try (0%, last 7 days). no landings yet to time.',
  );
});

test('atris idea prints the score line above the list', async () => {
  const repo = tempRepo();
  addIdea(repo, 'make the inbox search faster');
  addIdea(repo, 'speed up the test runner');
  const lines = [];
  ideaAtris([], { cwd: repo, log: (line) => lines.push(line), keepDeps: { spawn: () => ({ status: 1, stdout: '' }), plan: { platform: 'linux', homeDir: repo } } });
  assert.doesNotMatch(lines.join('\n'), /^score:/m, 'no score before anything was built');

  await tick(repo);
  const after = [];
  ideaAtris([], { cwd: repo, log: (line) => after.push(line), keepDeps: { spawn: () => ({ status: 1, stdout: '' }), plan: { platform: 'linux', homeDir: repo } } });
  const out = after.join('\n');
  assert.match(out.split('\n')[0], /^score: 1 landed in the last 24h\. 1 of 1 landed first try \(100%, last 7 days\)\. median \d+ min from idea to landed\.$/);

  const json = [];
  ideaAtris(['--json'], { cwd: repo, log: (line) => json.push(line) });
  const parsed = JSON.parse(json.join('\n'));
  assert.equal(parsed.score.landed_24h, 1);
  assert.match(parsed.score.line, /^score: 1 landed/);
});

test('a failure that repeats twice in a day files one loop idea, and only one is open at a time', async () => {
  const repo = tempRepo();
  const loopRepo = tempRepo();
  const t0 = Date.parse('2026-10-23T08:00:00Z');
  const stuck = (file) => ({ status: 'stuck', task_id: 'T-1', reason: `engine could not start in ${file}: exit 71`, checked: '' });

  addIdea(repo, 'make the inbox search faster');
  await tick(repo, { lap: stuck('/tmp/a'), loopRepo, at: t0 });
  assert.equal(readIdeas(loopRepo).length, 0, 'one failure is not a pattern');

  addIdea(repo, 'speed up the test runner');
  const second = await tick(repo, { lap: stuck('/var/b'), loopRepo, at: t0 + HOUR });
  const loopIdeas = readIdeas(loopRepo);
  assert.equal(loopIdeas.length, 1, 'the same stage and the same cause, paths aside, is a pattern');
  assert.equal(loopIdeas[0].tag, 'loop');
  assert.equal(loopIdeas[0].status, 'waiting');
  assert.match(loopIdeas[0].text, /^make the idea loop handle "engine could not start in/);
  assert.match(loopIdeas[0].text, /at the build stage \(seen 2 times in 24h\)$/);
  assert.equal(second.outcome.loop_idea, loopIdeas[0].id);
  assert.ok(second.logs.some((line) => /filed loop idea 1 in /.test(line)));

  addIdea(repo, 'tidy the help text');
  await tick(repo, { lap: stuck('/c'), loopRepo, at: t0 + 2 * HOUR });
  addIdea(repo, 'trim the readme');
  await tick(repo, { lap: { status: 'stuck', reason: 'different trouble', checked: 'x failed (exit 1)' }, loopRepo, at: t0 + 3 * HOUR });
  addIdea(repo, 'trim the changelog');
  await tick(repo, { lap: { status: 'stuck', reason: 'different trouble', checked: 'x failed (exit 1)' }, loopRepo, at: t0 + 4 * HOUR });
  assert.equal(readIdeas(loopRepo).length, 1, 'never more than one open loop idea');

  // Once the loop idea is no longer open, a new repeating cause can file one,
  // but the cause it already filed for waits a day.
  updateIdea(loopRepo, loopIdeas[0].id, { status: 'refused', reason: 'the build did not pass' });
  addIdea(repo, 'shorten the intro');
  await tick(repo, { lap: stuck('/d'), loopRepo, at: t0 + 5 * HOUR });
  assert.equal(readIdeas(loopRepo).length, 1, 'the same cause is not filed twice in a day');
  addIdea(repo, 'shorten the outro');
  await tick(repo, { lap: { status: 'stuck', reason: 'different trouble', checked: 'x failed (exit 1)' }, loopRepo, at: t0 + 6 * HOUR });
  const now = readIdeas(loopRepo);
  assert.equal(now.length, 2);
  assert.match(now[1].text, /handle "different trouble" at the checks stage \(seen 3 times in 24h\)/);
});

test('loop ideas pass the same refuse rules and show as loop work in the list', async () => {
  const repo = tempRepo();
  const t0 = Date.parse('2026-10-23T08:00:00Z');
  const lap = { status: 'stuck', reason: 'Not logged in. Please run /login', checked: '' };
  addIdea(repo, 'make the inbox search faster');
  await tick(repo, { lap, at: t0 });
  addIdea(repo, 'speed up the test runner');
  await tick(repo, { lap, at: t0 + HOUR });
  const loopIdea = readIdeas(repo).find((idea) => idea.tag === 'loop');
  assert.ok(loopIdea, 'filed in the same repo when no loop repo is given');
  assert.equal(loopIdea.status, 'refused');
  assert.match(loopIdea.reason, /touches auth/);

  const lines = [];
  ideaAtris([], { cwd: repo, log: (line) => lines.push(line), keepDeps: { spawn: () => ({ status: 1, stdout: '' }), plan: { platform: 'linux', homeDir: repo } } });
  assert.match(lines.join('\n'), /3\. refused\s+\[loop\] make the idea loop handle/);
});

test('repeats count only failures from the last 24 hours, not refusals', () => {
  const now = Date.parse('2026-10-23T12:00:00Z');
  const row = (hoursAgo, outcome, cause = 'tests failed in lib/a.js') => ({ id: `i${hoursAgo}`, finished: new Date(now - hoursAgo * HOUR).toISOString(), outcome, stage: 'checks', cause });
  assert.equal(repeatedFailure([row(30, 'failed'), row(1, 'failed')], { now }), null);
  assert.equal(repeatedFailure([row(2, 'refused'), row(1, 'refused')], { now }), null);
  const hit = repeatedFailure([row(2, 'failed', 'tests failed in lib/a.js'), row(1, 'failed', 'tests failed in lib/b.js')], { now });
  assert.equal(hit.count, 2);
  assert.equal(hit.stage, 'checks');
});

test('the loop never lands a change to the rules that judge it', async () => {
  for (const file of ['lib/idea-inbox.js', 'lib/idea-ledger.js', 'lib/idea-gate.js', 'test/idea-ledger.test.js']) {
    assert.match(changeRefusal({ paths: ['lib/search.js', file] }), /rules that judge the idea loop/, file);
  }
  assert.match(ideaRefusal('loosen the refuse list so more ideas land'), /rules that judge the idea loop/);
  assert.match(ideaRefusal('count more in the idea score'), /rules that judge the idea loop/);
  assert.equal(ideaRefusal('make the idea loop handle "engine could not start" at the build stage (seen 2 times in 24h)'), '');

  const repo = tempRepo();
  addIdea(repo, 'make the idea loop handle slow builds');
  const { outcome, ships } = await tick(repo, { change: { ok: true, paths: ['lib/idea-tick.js', 'lib/idea-ledger.js'], addedLines: [] } });
  assert.equal(ships.length, 0, 'nothing lands');
  assert.equal(outcome.outcome, 'refused');
  assert.match(readIdeas(repo)[0].reason, /edits the rules that judge the idea loop \(lib\/idea-ledger\.js\)/);
});

test('recordOutcome rejects outcomes and stages outside the ledger vocabulary', () => {
  const repo = tempRepo();
  const idea = addIdea(repo, 'x y z');
  assert.throws(() => recordOutcome(repo, { idea, outcome: 'great' }), /unknown idea outcome/);
  assert.throws(() => recordOutcome(repo, { idea, outcome: 'failed', stage: 'vibes' }), /unknown idea stage/);
  const reverted = recordOutcome(repo, { idea, outcome: 'reverted', stage: 'push', cause: 'reverted on master' });
  assert.equal(reverted.outcome, 'reverted');
});
