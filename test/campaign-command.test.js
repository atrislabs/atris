'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { campaignCommand } = require('../commands/campaign');
const { createMemoryStore, getCampaign } = require('../lib/campaign-store');

const CLI = path.resolve(__dirname, '..', 'bin', 'atris.js');

// Run a verb against an in-memory store with a judge that answers from a list.
async function run(store, args, readings = []) {
  const logs = [];
  const errors = [];
  const judged = [];
  const saved = { log: console.log, error: console.error };
  console.log = (line) => logs.push(String(line));
  console.error = (line) => errors.push(String(line));
  let code;
  try {
    code = await campaignCommand(args, {
      store,
      actor: 'human:keshav',
      runJudge: (command) => {
        judged.push(command);
        return readings.shift() || { passed: false, exit: 1, summary: 'not yet', seconds: 0 };
      },
    });
  } finally {
    console.log = saved.log;
    console.error = saved.error;
  }
  return { code, out: logs.join('\n'), err: errors.join('\n'), judged };
}

const startArgs = ['start', 'Ship campaigns', '--judge', 'npm run validate:campaign', '--budget', '500', '--id', 'cmp-ship'];

test('start runs the judge first and records the failing reading', async () => {
  const store = createMemoryStore({ origin: 'laptop' });
  const result = await run(store, [...startArgs, '--owner', 'mission-lead', '--seat', 'builder', '--seat', 'validator:reviewer', '--bet', 'mostly wiring']);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(result.judged, ['npm run validate:campaign']);
  const view = getCampaign(store, 'cmp-ship');
  assert.equal(view.state, 'resting');
  assert.equal(view.judge_runs, 1);
  assert.equal(view.judge_due, false);
  assert.deepEqual(view.seats, [{ member: 'builder', role: null }, { member: 'validator', role: 'reviewer' }]);
  assert.deepEqual(view.bet, { text: 'mostly wiring', wrong_if: null });
  assert.match(result.out, /next: plan and run the next missions: atris campaign run cmp-ship/);
});

test('a judge that already passes is refused: write a judge that fails first', async () => {
  const store = createMemoryStore();
  const result = await run(store, startArgs, [{ passed: true, exit: 0, summary: 'ok', seconds: 0 }]);
  assert.equal(result.code, 1);
  assert.match(result.err, /already done.*fails first/);
  assert.equal(getCampaign(store, 'cmp-ship'), null);
});

test('a standing campaign may pass at start, because passing means healthy', async () => {
  const store = createMemoryStore();
  const result = await run(store, [...startArgs, '--standing'], [{ passed: true, exit: 0, summary: 'healthy', seconds: 0 }]);
  assert.equal(result.code, 0, result.err);
  const view = getCampaign(store, 'cmp-ship');
  assert.equal(view.standing, true);
  assert.equal(view.state, 'resting');
  assert.equal(view.answer.confidence, 'leaning');
});

test('start explains what is missing in plain words', async () => {
  const store = createMemoryStore();
  const result = await run(store, ['start', 'No judge', '--budget', '0']);
  assert.equal(result.code, 2);
  assert.match(result.err, /--judge "<command>"/);
  assert.match(result.err, /--budget <dollars above 0>/);
  assert.deepEqual(result.judged, []);
});

test('a parent with its own parent is refused (one level only)', async () => {
  const store = createMemoryStore();
  await run(store, ['start', 'Top', '--judge', 'exit 1', '--budget', '10', '--id', 'cmp-top']);
  await run(store, ['start', 'Mid', '--judge', 'exit 1', '--budget', '10', '--id', 'cmp-mid', '--parent', 'cmp-top']);
  assert.equal(getCampaign(store, 'cmp-mid').parent, 'cmp-top');
  const result = await run(store, ['start', 'Low', '--judge', 'exit 1', '--budget', '10', '--parent', 'cmp-mid']);
  assert.equal(result.code, 2);
  assert.match(result.err, /one level only/);
});

test('bet with wrong-if, seat with the member job as its role, and added budget', async () => {
  const store = createMemoryStore();
  await run(store, startArgs);
  assert.equal((await run(store, ['bet', 'cmp-ship', 'screens only decode', '--wrong-if', 'a screen folds'])).code, 0);
  assert.equal((await run(store, ['seat', 'cmp-ship', 'scout'])).code, 0);
  assert.equal((await run(store, ['seat', 'cmp-ship', 'ios-engineer', '--role', 'builder'])).code, 0);
  assert.equal((await run(store, ['budget', 'cmp-ship', '--add', '250'])).code, 0);
  const view = getCampaign(store, 'cmp-ship');
  assert.deepEqual(view.bet, { text: 'screens only decode', wrong_if: 'a screen folds' });
  assert.deepEqual(view.seats, [{ member: 'scout', role: 'search' }, { member: 'ios-engineer', role: 'builder' }]);
  assert.equal(view.budget.total, 750);
});

test('the judge verb records each reading; a pass finishes the campaign', async () => {
  const store = createMemoryStore();
  await run(store, startArgs);
  await run(store, ['event', 'cmp-ship', 'mission_started', '--data', '{"mission_id":"m1","member":"builder"}']);
  await run(store, ['event', 'cmp-ship', 'mission_ended', '--data', '{"mission_id":"m1","outcome":"kept","cost_usd":2.22}']);
  assert.equal(getCampaign(store, 'cmp-ship').judge_due, true);
  const result = await run(store, ['judge', 'cmp-ship'], [{ passed: true, exit: 0, summary: 'judge passes: every surface agrees', seconds: 3 }]);
  assert.equal(result.code, 0);
  assert.match(result.out, /judge passed in 3s/);
  const view = getCampaign(store, 'cmp-ship');
  assert.equal(view.state, 'done');
  assert.equal(view.stop_reason, 'judge_passed');
  assert.deepEqual(view.answer, { text: 'judge passes: every surface agrees', confidence: 'answered' });
  assert.equal(view.budget.spent, 2.22);
});

test('pause, resume, and stop; the list puts what needs you first', async () => {
  const store = createMemoryStore();
  await run(store, startArgs);
  await run(store, ['start', 'Second', '--judge', 'exit 1', '--budget', '5', '--id', 'cmp-two']);
  await run(store, ['event', 'cmp-two', 'ask_opened', '--data', '{"ask_id":"a1","question":"Spend $40?"}']);
  await run(store, ['pause', 'cmp-ship']);
  assert.equal(getCampaign(store, 'cmp-ship').state, 'paused');
  await run(store, ['resume', 'cmp-ship']);
  const list = await run(store, []);
  assert.ok(list.out.indexOf('Second') < list.out.indexOf('Ship campaigns'), list.out);
  assert.match(list.out, /next: answer 1 open ask/);
  await run(store, ['stop', 'cmp-ship']);
  assert.equal(getCampaign(store, 'cmp-ship').stop_reason, 'stopped');
});

test('the event verb refuses events that break the schema', async () => {
  const store = createMemoryStore();
  await run(store, startArgs);
  const result = await run(store, ['event', 'cmp-ship', 'mission_ended', '--data', '{"mission_id":"m1","outcome":"kept"}']);
  assert.equal(result.code, 2);
  assert.match(result.err, /missing_cost/);
  assert.equal((await run(store, ['event', 'cmp-ship', 'step', '--data', 'not json'])).code, 2);
  assert.equal((await run(store, ['show', 'cmp-nope'])).code, 1);
});

test('the real command: json on every verb, store from ATRIS_CAMPAIGN_DB, a real judge command', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-campaign-cli-'));
  const env = { ...process.env, ATRIS_CAMPAIGN_DB: path.join(dir, 'atris.db') };
  const cli = (...args) => spawnSync(process.execPath, [CLI, 'campaign', ...args], { cwd: dir, env, encoding: 'utf8' });

  const refused = cli('start', 'Too easy', '--judge', 'true', '--budget', '5', '--json');
  assert.equal(refused.status, 1);
  assert.match(JSON.parse(refused.stdout).error, /fails first/);

  const started = cli('start', 'Real judge', '--judge', 'echo two of five; exit 1', '--budget', '5', '--id', 'cmp-real', '--json');
  assert.equal(started.status, 0, started.stderr);
  const body = JSON.parse(started.stdout);
  assert.equal(body.campaign.answer.text, 'two of five');
  assert.deepEqual(body.next, { action: 'propose', reason: 'no missions queued' });

  const shown = cli('show', 'cmp-real', '--json');
  assert.equal(JSON.parse(shown.stdout).campaign.id, 'cmp-real');
  const listed = cli('--json');
  assert.deepEqual(JSON.parse(listed.stdout).campaigns.map((c) => c.id), ['cmp-real']);
  assert.match(cli('help').stdout, /write a judge that fails first/);
});

test('ask stops the campaign for a person; an agent cannot answer, a person can', async () => {
  const store = createMemoryStore();
  await run(store, startArgs);
  const asked = await run(store, ['ask', 'cmp-ship', 'Email the customer the launch note?', '--as', 'builder']);
  assert.equal(asked.code, 0);
  const askId = getCampaign(store, 'cmp-ship').asks[0].id;
  assert.match(asked.out, /next: answer 1 open ask: atris campaign answer cmp-ship a-[0-9a-f]{6}/);
  const byAgent = await run(store, ['answer', 'cmp-ship', askId, 'yes', '--as', 'builder']);
  assert.match(byAgent.out, /not closed: only a person can answer/);
  assert.equal(getCampaign(store, 'cmp-ship').state, 'needs_you');
  assert.equal((await run(store, ['answer', 'cmp-ship', askId, 'yes, send it'])).code, 0);
  assert.deepEqual(getCampaign(store, 'cmp-ship').asks, []);
});

test('set-judge: only the owner or a person, and the new judge must fail first', async () => {
  const store = createMemoryStore();
  await run(store, startArgs);
  const byAgent = await run(store, ['set-judge', 'cmp-ship', 'true', '--as', 'builder']);
  assert.equal(byAgent.code, 2);
  assert.match(byAgent.err, /only the owner \(mission-lead\) or a person/);
  const passing = await run(store, ['set-judge', 'cmp-ship', 'true'], [{ passed: true, exit: 0, summary: 'ok', seconds: 0 }]);
  assert.equal(passing.code, 1);
  assert.match(passing.err, /already passes/);
  const changed = await run(store, ['set-judge', 'cmp-ship', 'node scripts/campaign-live-check.js'], [{ passed: false, exit: 1, summary: '0 of 4 live', seconds: 0 }]);
  assert.equal(changed.code, 0, changed.err);
  const view = getCampaign(store, 'cmp-ship');
  assert.equal(view.judge, 'node scripts/campaign-live-check.js');
  assert.equal(view.judge_due, false);
  assert.equal(view.answer.text, '0 of 4 live');
});

test('--holdout moves the file out of the repo, hands it to the judge, and show and export never print it', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-campaign-holdout-'));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-campaign-state-'));
  fs.mkdirSync(path.join(repo, '.git'));
  fs.writeFileSync(path.join(repo, 'heldout.jsonl'), '{"q":"secret question one"}\n{"q":"secret question two"}\n');
  const env = { ...process.env, ATRIS_CAMPAIGN_DB: path.join(state, 'atris.db'), ATRIS_SKIP_UPDATE_CHECK: '1' };
  const cli = (...args) => spawnSync(process.execPath, [CLI, 'campaign', ...args], { cwd: repo, env, encoding: 'utf8' });
  const judge = 'cat "$ATRIS_CAMPAIGN_HOLDOUT" && echo "read $(wc -l < "$ATRIS_CAMPAIGN_HOLDOUT") lines"';

  const refused = cli('start', 'Too easy', '--judge', judge, '--budget', '5', '--holdout', 'heldout.jsonl', '--id', 'cmp-easy');
  assert.equal(refused.status, 1);
  assert.ok(fs.existsSync(path.join(repo, 'heldout.jsonl')), 'a refused start puts the file back');

  const started = cli('start', 'Held out', '--judge', `${judge}; exit 1`, '--budget', '5', '--holdout', 'heldout.jsonl', '--id', 'cmp-held');
  assert.equal(started.status, 0, started.stderr);
  assert.equal(fs.existsSync(path.join(repo, 'heldout.jsonl')), false);
  const moved = path.join(state, 'campaigns', 'cmp-held', 'holdout', 'heldout.jsonl');
  assert.match(fs.readFileSync(moved, 'utf8'), /secret question two/);

  const shown = cli('show', 'cmp-held', '--json');
  const view = JSON.parse(shown.stdout).campaign;
  assert.match(view.answer.text, /read\s+2 lines/, 'the judge found the file through ATRIS_CAMPAIGN_HOLDOUT');
  const exported = cli('export', 'cmp-held', '--trace', '--full');
  assert.equal(exported.status, 0, exported.stderr);
  for (const out of [started, shown, cli('show', 'cmp-held'), cli('judge', 'cmp-held', '--json'), exported]) {
    assert.doesNotMatch(out.stdout + out.stderr, /secret question/);
  }
  assert.match(cli('judge', 'cmp-held', '--json').stdout, /\[held out\]/);
});

test('start --protect saves paths and the start commit outside the repo; guard names any changed since', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-campaign-protect-'));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const env = { ...process.env, ATRIS_CAMPAIGN_DB: path.join(dir, 'state', 'atris.db'), ATRIS_SKIP_UPDATE_CHECK: '1' };
  const sh = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  const cli = (...args) => spawnSync(process.execPath, [CLI, 'campaign', ...args], { cwd: repo, env, encoding: 'utf8' });
  sh('init', '-q');
  sh('config', 'user.email', 'j@j');
  sh('config', 'user.name', 'j');
  fs.writeFileSync(path.join(repo, 'questions.txt'), 'q1\n');
  fs.mkdirSync(path.join(repo, 'evals'));
  fs.writeFileSync(path.join(repo, 'evals', 'a.json'), '{}\n');
  fs.writeFileSync(path.join(repo, 'notes.md'), 'a\n');
  sh('add', '-A');
  sh('commit', '-qm', 'base');
  const base = sh('rev-parse', 'HEAD').stdout.trim();

  const outside = cli('start', 'P', '--judge', 'exit 1', '--budget', '5', '--protect', '../elsewhere', '--id', 'cmp-out');
  assert.equal(outside.status, 2);
  assert.match(outside.stderr, /not inside this checkout/);

  const started = cli('start', 'P', '--judge', 'exit 1', '--budget', '5', '--protect', 'questions.txt', '--protect', 'evals', '--id', 'cmp-p');
  assert.equal(started.status, 0, started.stderr);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'state', 'campaigns', 'cmp-p', 'protect.json'), 'utf8'));
  assert.deepEqual(saved, { paths: ['questions.txt', 'evals'], base_commit: base });
  assert.equal(fs.existsSync(path.join(repo, 'atris')), false);

  fs.appendFileSync(path.join(repo, 'notes.md'), 'b\n');
  sh('commit', '-qam', 'fine');
  assert.equal(cli('guard', 'cmp-p').status, 0);

  fs.appendFileSync(path.join(repo, 'questions.txt'), 'q2\n');
  const dirty = cli('guard', 'cmp-p');
  assert.equal(dirty.status, 1);
  assert.match(dirty.stderr, /questions\.txt/);

  sh('commit', '-qam', 'sneak');
  fs.writeFileSync(path.join(repo, 'evals', 'new.json'), '{}\n');
  const both = cli('guard', 'cmp-p', '--json');
  assert.equal(both.status, 1);
  assert.deepEqual(JSON.parse(both.stdout).changed, ['evals/new.json', 'questions.txt']);

  assert.equal(cli('start', 'Q', '--judge', 'exit 1', '--budget', '5', '--id', 'cmp-q').status, 0);
  assert.match(cli('guard', 'cmp-q').stdout, /protects nothing/);
});

test('a judge that passes still reads failed once a protected file changed, at start and after', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-campaign-protect-judge-'));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const env = { ...process.env, ATRIS_CAMPAIGN_DB: path.join(dir, 'state', 'atris.db'), ATRIS_SKIP_UPDATE_CHECK: '1' };
  const sh = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  const cli = (...args) => spawnSync(process.execPath, [CLI, 'campaign', ...args], { cwd: repo, env, encoding: 'utf8' });
  sh('init', '-q');
  sh('config', 'user.email', 'j@j');
  sh('config', 'user.name', 'j');
  fs.writeFileSync(path.join(repo, 'q.txt'), 'no\n');
  fs.writeFileSync(path.join(repo, 'work.txt'), 'no\n');
  sh('add', '-A');
  sh('commit', '-qm', 'base');

  assert.equal(cli('start', 'G', '--judge', 'grep -q yes work.txt', '--budget', '5', '--protect', 'q.txt', '--id', 'cmp-g').status, 0);
  fs.writeFileSync(path.join(repo, 'work.txt'), 'yes\n');
  fs.writeFileSync(path.join(repo, 'q.txt'), 'yes\n');
  sh('commit', '-qam', 'edit both');
  const judged = cli('judge', 'cmp-g', '--json');
  assert.equal(judged.status, 1);
  const body = JSON.parse(judged.stdout);
  assert.equal(body.passed, false);
  assert.equal(body.reading.summary, 'protected file changed: q.txt');
  assert.equal(body.campaign.last_judge.passed, false);

  sh('checkout', '-q', 'HEAD~1', '--', 'q.txt');
  assert.equal(cli('judge', 'cmp-g').status, 0, 'putting the file back lets the judge count again');

  // start's must-fail-first check counts a dirty protected file as a failure.
  fs.writeFileSync(path.join(repo, 'q.txt'), 'changed\n');
  const dirty = cli('start', 'H', '--judge', 'exit 0', '--budget', '5', '--protect', 'q.txt', '--id', 'cmp-h', '--json');
  assert.equal(dirty.status, 0, dirty.stdout + dirty.stderr);
  assert.match(JSON.parse(dirty.stdout).campaign.answer.text, /protected file changed: q\.txt/);
});
