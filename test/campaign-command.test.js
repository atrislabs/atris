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
  const pass = { passed: true, exit: 0, summary: 'judge passes: every surface agrees', seconds: 3 };
  const result = await run(store, ['judge', 'cmp-ship'], [pass, { ...pass }]);
  assert.equal(result.code, 0);
  assert.match(result.out, /judge passed in 6s/);
  const view = getCampaign(store, 'cmp-ship');
  assert.equal(view.state, 'done');
  assert.equal(view.stop_reason, 'judge_passed');
  assert.deepEqual(view.answer, { text: 'judge passes: every surface agrees', confidence: 'answered' });
  assert.equal(view.budget.spent, 2.22);
});

test('a lucky pass does not finish the campaign: a fresh second run must pass too', async () => {
  const store = createMemoryStore();
  await run(store, startArgs);
  const lucky = await run(store, ['judge', 'cmp-ship'], [
    { passed: true, exit: 0, summary: '3 of 3', seconds: 1 },
    { passed: false, exit: 1, summary: '2 of 3', seconds: 1 },
  ]);
  assert.equal(lucky.code, 1);
  let view = getCampaign(store, 'cmp-ship');
  assert.notEqual(view.state, 'done');
  assert.equal(view.stop_reason, null);
  assert.equal(view.judge_runs, 2, 'start reading plus one recorded reading, not one per run');
  assert.equal(view.answer.text, 'passed once, then failed a fresh run: 2 of 3');

  const real = await run(store, ['judge', 'cmp-ship'], [
    { passed: true, exit: 0, summary: '3 of 3', seconds: 1 },
    { passed: true, exit: 0, summary: '3 of 3', seconds: 1 },
  ]);
  assert.equal(real.code, 0);
  view = getCampaign(store, 'cmp-ship');
  assert.equal(view.state, 'done');
  assert.equal(view.stop_reason, 'judge_passed');
});

test('a failing reading runs the judge once; only a pass is run again', async () => {
  const store = createMemoryStore();
  await run(store, startArgs);
  const readings = [{ passed: false, exit: 1, summary: 'not yet', seconds: 1 }, { passed: true, exit: 0, summary: 'should stay unread', seconds: 1 }];
  await run(store, ['judge', 'cmp-ship'], readings);
  assert.equal(readings.length, 1);
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
  assert.match(list.out, /Second  \(cmp-two\)\n  needs you .*\n  next: plan and run the next missions/);
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

test('ask waits for a person; an agent cannot answer, a person can', async () => {
  const store = createMemoryStore();
  await run(store, startArgs);
  const asked = await run(store, ['ask', 'cmp-ship', 'Email the customer the launch note?', '--as', 'builder']);
  assert.equal(asked.code, 0);
  const askId = getCampaign(store, 'cmp-ship').asks[0].id;
  assert.match(asked.out, /needs you · next: plan and run the next missions/);
  assert.match(asked.out, /asks {6}\n  a-[0-9a-f]{6}: Email the customer the launch note\?/);
  const held = await run(store, ['ask', 'cmp-ship', 'Spend $40?', '--mission', 'm-ads', '--as', 'builder']);
  assert.equal(getCampaign(store, 'cmp-ship').asks[1].mission_id, 'm-ads');
  assert.equal(held.code, 0);
  const byAgent = await run(store, ['answer', 'cmp-ship', askId, 'yes', '--as', 'builder']);
  assert.match(byAgent.out, /not closed: only a person can answer/);
  assert.equal(getCampaign(store, 'cmp-ship').state, 'needs_you');
  assert.equal((await run(store, ['answer', 'cmp-ship', askId, 'yes, send it'])).code, 0);
  assert.deepEqual(getCampaign(store, 'cmp-ship').asks.map((a) => a.mission_id), ['m-ads']);
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

test('a local start without --budget succeeds and shows no money lines', async () => {
  const store = createMemoryStore();
  const local = await run(store, ['start', 'No limit', '--judge', 'exit 1', '--id', 'cmp-free']);
  assert.equal(local.code, 0, local.err);
  assert.deepEqual(local.judged, ['exit 1']);
  assert.equal(getCampaign(store, 'cmp-free').state, 'resting');
  assert.doesNotMatch(local.out, /budget|\$/);
  const shown = await run(store, ['show', 'cmp-free']);
  assert.equal(shown.code, 0, shown.err);
  assert.doesNotMatch(shown.out, /budget|\$/);
  const list = await run(store, []);
  assert.equal(list.code, 0, list.err);
  assert.doesNotMatch(list.out, /budget|\$/);
});

test('a cloud start without --budget is refused before running the judge or saving', async () => {
  const store = createMemoryStore();
  const cloud = await run(store, ['start', 'No limit', '--judge', 'exit 1', '--id', 'cmp-sky', '--cloud']);
  assert.equal(cloud.code, 2);
  assert.match(cloud.err, /cloud campaign needs --budget/);
  assert.deepEqual(cloud.judged, []);
  assert.equal(getCampaign(store, 'cmp-sky'), null);
});

test('the real command starts without --budget, persists it, and refuses cloud starts', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-campaign-no-budget-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, ATRIS_CAMPAIGN_DB: path.join(dir, 'atris.db'), ATRIS_SKIP_UPDATE_CHECK: '1' };
  const cli = (...args) => spawnSync(process.execPath, [CLI, 'campaign', ...args], { cwd: dir, env, encoding: 'utf8' });

  const started = cli('start', 'Local work', '--judge', 'exit 1', '--id', 'cmp-local');
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, /started Local work/);
  assert.doesNotMatch(started.stdout, /budget|\$/);
  for (const args of [['show', 'cmp-local'], []]) {
    const result = cli(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Local work/);
    assert.doesNotMatch(result.stdout, /budget|\$/);
  }

  const jsonStart = cli('start', 'Json work', '--judge', 'exit 1', '--id', 'cmp-json', '--json');
  assert.equal(jsonStart.status, 0, jsonStart.stderr);
  const body = JSON.parse(jsonStart.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.campaign.id, 'cmp-json');
  assert.equal(body.campaign.state, 'resting');
  const shown = cli('show', 'cmp-json', '--json');
  assert.equal(shown.status, 0, shown.stderr);
  assert.deepEqual(JSON.parse(shown.stdout).campaign, body.campaign);

  for (const flags of [[], ['--json']]) {
    const refused = cli('start', 'Cloud work', '--judge', 'exit 1', '--id', 'cmp-cloud', '--cloud', ...flags);
    assert.equal(refused.status, 2, refused.stderr);
    const error = flags.length ? JSON.parse(refused.stdout).error : refused.stderr;
    assert.match(error, /cloud campaign needs --budget/);
  }
  const listed = cli('--json');
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout).campaigns.map((c) => c.id).sort(), ['cmp-json', 'cmp-local']);
});

test('a judge script outside the checkout is copied in, so deleting the original keeps it working', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-campaign-judge-copy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const checkout = path.join(dir, 'repo');
  const outside = path.join(dir, 'elsewhere');
  fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
  fs.mkdirSync(outside);
  const env = { ...process.env, ATRIS_CAMPAIGN_DB: path.join(dir, 'state', 'atris.db'), ATRIS_SKIP_UPDATE_CHECK: '1' };
  const cli = (...args) => spawnSync(process.execPath, [CLI, 'campaign', ...args], { cwd: checkout, env, encoding: 'utf8' });
  const script = (file, words) => {
    fs.writeFileSync(file, `#!/bin/sh\necho ${words}\nexit 1\n`);
    fs.chmodSync(file, 0o755);
  };

  const original = path.join(outside, 'check.sh');
  script(original, 'still four of nine');
  const started = cli('start', 'Judge copy', '--judge', original, '--id', 'cmp-copy');
  assert.equal(started.status, 0, started.stderr);
  const copy = path.join(dir, 'state', 'campaigns', 'cmp-copy', 'check.sh');
  assert.match(started.stderr, /copied the judge script/);
  assert.equal(JSON.parse(cli('show', 'cmp-copy', '--json').stdout).campaign.judge, copy);
  fs.rmSync(original);
  const judged = cli('judge', 'cmp-copy');
  assert.equal(judged.status, 1, judged.stderr);
  assert.match(judged.stdout, /judge failed in \d+s: still four of nine/);

  const inside = path.join(checkout, 'check.sh');
  script(inside, 'inside the checkout');
  const kept = cli('start', 'Judge inside', '--judge', inside, '--id', 'cmp-inside');
  assert.equal(kept.status, 0, kept.stderr);
  assert.equal(JSON.parse(cli('show', 'cmp-inside', '--json').stdout).campaign.judge, inside);
  assert.equal(fs.existsSync(path.join(dir, 'state', 'campaigns', 'cmp-inside')), false);
});

test('a plain sentence with no verb starts a campaign; verbs stay verbs and one-word typos are refused', async () => {
  const store = createMemoryStore();
  const started = await run(store, ['Make the moon landing replay load fast', '--judge', 'exit 1', '--seat', 'builder', '--id', 'cmp-moon']);
  assert.equal(started.code, 0, started.err);
  assert.deepEqual(started.judged, ['exit 1']);
  const view = getCampaign(store, 'cmp-moon');
  assert.equal(view.title, 'Make the moon landing replay load fast');
  assert.deepEqual(view.seats, [{ member: 'builder', role: null }]);
  const shown = await run(store, ['show', 'cmp-moon']);
  assert.equal(shown.code, 0);
  assert.equal((await run(store, ['show', 'cmp-missing'])).code, 1);
  const typo = await run(store, ['shwo', 'cmp-moon']);
  assert.equal(typo.code, 2);
  assert.match(typo.err, /unknown verb shwo/);
  assert.equal(getCampaign(store, 'cmp-shwo'), null);
});

test('start --run keeps going into the loop after the start', async () => {
  const store = createMemoryStore({ origin: 'laptop' });
  const asks = [];
  const logs = [];
  const saved = { log: console.log, error: console.error };
  console.log = (line) => logs.push(String(line));
  console.error = () => {};
  let code;
  try {
    code = await campaignCommand([...startArgs, '--run', '--max-steps', '1'], {
      store,
      actor: 'human:keshav',
      runJudge: () => ({ passed: false, exit: 1, summary: 'not yet', seconds: 0 }),
      loopDeps: { skipReconcile: true, cli: async () => ({ code: 0, out: '', err: '' }), ask: async (root, view, prompt) => { asks.push(prompt); return { ok: true, text: '[]' }; } },
    });
  } finally {
    console.log = saved.log;
    console.error = saved.error;
  }
  assert.ok(getCampaign(store, 'cmp-ship'), 'the campaign started');
  assert.equal(asks.length, 1, `the loop asked the owner for missions: ${logs.join('\n')}`);
  assert.equal(typeof code, 'number');
});

test('a judge that prints no counts saves its last line, not a bare exit code', () => {
  const { judgeRanData } = require('../lib/campaign-reading');
  assert.equal(judgeRanData({ passed: false, exit: 1, output_tail: 'checking\nstill four of nine\n\n', seconds: 1 }).summary, 'still four of nine');
  assert.equal(judgeRanData({ passed: false, exit: 3, output_tail: '', seconds: 1 }).summary, 'exit 3');
  assert.equal(judgeRanData({ passed: true, exit: 0, summary: '9 of 9', output_tail: 'x', seconds: 1 }).summary, '9 of 9');
});

test('start saves HEAD as the start commit without --protect, and every judge run reads it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-campaign-start-commit-'));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const seen = path.join(dir, 'seen.txt');
  const env = { ...process.env, ATRIS_CAMPAIGN_DB: path.join(dir, 'state', 'atris.db'), ATRIS_SKIP_UPDATE_CHECK: '1' };
  const sh = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  const cli = (...args) => spawnSync(process.execPath, [CLI, 'campaign', ...args], { cwd: repo, env, encoding: 'utf8' });
  sh('init', '-q');
  sh('config', 'user.email', 'j@j');
  sh('config', 'user.name', 'j');
  fs.writeFileSync(path.join(repo, 'n.md'), 'a\n');
  sh('add', '-A');
  sh('commit', '-qm', 'base');
  const base = sh('rev-parse', 'HEAD').stdout.trim();
  const judge = `echo "$ATRIS_CAMPAIGN_START_COMMIT" >> ${JSON.stringify(seen)}; exit 1`;

  assert.equal(cli('start', 'S', '--judge', judge, '--budget', '5', '--id', 'cmp-s').status, 0);
  fs.appendFileSync(path.join(repo, 'n.md'), 'b\n');
  sh('commit', '-qam', 'move');
  assert.equal(cli('judge', 'cmp-s').status, 1);
  assert.deepEqual(fs.readFileSync(seen, 'utf8').trim().split('\n'), [base, base], 'start and the later judge both see the start commit, not the new HEAD');

  // Outside git there is no commit to save, so the judge gets nothing.
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-campaign-no-git-'));
  const none = path.join(dir, 'none.txt');
  const out = spawnSync(process.execPath, [CLI, 'campaign', 'start', 'N', '--judge', `echo "[\${ATRIS_CAMPAIGN_START_COMMIT-unset}]" > ${JSON.stringify(none)}; exit 1`, '--budget', '5', '--id', 'cmp-n'], { cwd: plain, env, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(fs.readFileSync(none, 'utf8').trim(), '[unset]');
});
