'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const tasks = require('../lib/task-db');
const { promisify } = require('node:util');
const { project } = require('./helpers/feed-project');

const exec = promisify(execFile);
const bin = path.resolve(__dirname, '../bin/atris.js');

async function fixture(t, { claim = true } = {}) {
  const ctx = project(t);
  const home = path.join(ctx.dir, 'home');
  fs.mkdirSync(home);
  const env = { ...ctx.agentEnv, HOME: home };
  const run = async (...args) => {
    const { stdout } = await exec(process.execPath, [bin, ...args, '--json'], { cwd: ctx.root, env });
    return JSON.parse(stdout);
  };
  await run('element', 'connect', '--as', 'reader');
  const task = await run('element', 'task', 'Check the sample value', '--as', 'scout', '--to', 'reader');
  const claimed = claim ? await run('element', 'claim', task.card_id, '--as', 'reader') : null;
  fs.writeFileSync(path.join(ctx.root, 'check.js'), [
    "require('node:fs').appendFileSync('verified.txt', 'once\\n');",
    'setTimeout(() => {}, 150);',
  ].join('\n'));
  const args = ['element', 'complete', task.card_id, '--as', 'reader', '--proof', 'The sample is right.',
    '--verify', 'node check.js', '--lesson', 'Check the sample.', 'The sample is right.'];
  return { ctx, env, run, task, args, claimed };
}

test('simultaneous completions and a restarted CLI return the same result once', async (t) => {
  const { ctx, run, task, args } = await fixture(t);
  const [a, b] = await Promise.all([run(...args), run(...args)]);
  const repeated = await run(...args);
  assert.equal(fs.readFileSync(path.join(ctx.root, 'verified.txt'), 'utf8'), 'once\n');
  assert.deepEqual(a.check, b.check);
  assert.deepEqual(a.check, repeated.check);
  assert.equal(a.result.event.id, repeated.result.event.id);
  const events = (await run('feed', 'events')).events.filter(e => e.card_id === task.card_id && e.type === 'result');
  assert.deepEqual(events.map(e => e.member), ['reader']);
  assert.equal(fs.readFileSync(path.join(ctx.root, 'atris/team/reader/lessons.md'), 'utf8').split('- Check the sample.').length, 2);
  const receipt = await run('element', 'receipt', task.card_id);
  assert.equal(receipt.complete, true);
  assert.deepEqual(receipt.check, a.check);
});

test('a changed completion cannot replace the saved proof', async (t) => {
  const { ctx, run, task, args } = await fixture(t);
  const first = await run(...args);
  const conflict = [...args];
  conflict[conflict.indexOf('--proof') + 1] = 'Different proof.';
  await assert.rejects(run(...conflict), (err) => {
    assert.match(JSON.parse(err.stdout).error.message, /different|changed|conflict/i);
    return true;
  });
  assert.equal(fs.readFileSync(path.join(ctx.root, 'verified.txt'), 'utf8'), 'once\n');
  assert.deepEqual((await run('element', 'receipt', task.card_id)).check, first.check);
});



test('a new claim by the original member can hand in a different result', async (t) => {
  const { ctx, run, task, args, claimed } = await fixture(t);
  function issued(claim) {
    const match = claim.handoff.report_with.complete.match(/--claim-id ([0-9a-f]+)/);
    assert.ok(match, 'issued completion must identify its claim generation');
    assert.equal(match[1], claim.handoff.claim_id);
    return [...args, '--claim-id', match[1]];
  }
  const original = issued(claimed);
  const first = await run(...original);
  assert.deepEqual((await run(...original)).check, first.check);
  const id = (await run('element', 'receipt', task.card_id)).task_id;
  const reopened = tasks.reopenTask(ctx.db, { id, actor: 'fixture-owner', reason: 'Check again', fromReview: true });
  assert.ok(reopened.reopened);
  const newClaim = await run('element', 'claim', task.card_id, '--as', 'reader');
  assert.notEqual(newClaim.handoff.claim_id, claimed.handoff.claim_id);
  await assert.rejects(run(...original), err => {
    assert.match(JSON.parse(err.stdout).error.message, /earlier claim/i);
    return true;
  });
  await assert.rejects(run(...args), err => {
    assert.match(JSON.parse(err.stdout).error.message, /earlier claim/i);
    return true;
  });
  assert.equal(fs.readFileSync(path.join(ctx.root, 'verified.txt'), 'utf8'), 'once\n');
  const revised = issued(newClaim);
  revised[revised.indexOf('--proof') + 1] = 'Checked the revised sample.';
  const second = await run(...revised);
  assert.notEqual(first.result.event.id, second.result.event.id);
  assert.deepEqual((await run(...revised)).check, second.check);
  assert.equal((await run('element', 'receipt', task.card_id)).proof, 'Checked the revised sample.');
  assert.equal(fs.readFileSync(path.join(ctx.root, 'verified.txt'), 'utf8'), 'once\nonce\n');

  assert.ok(tasks.reopenTask(ctx.db, { id, actor: 'fixture-owner', reason: 'Repeat the original check', fromReview: true }).reopened);
  const third = await run('element', 'claim', task.card_id, '--as', 'reader');
  await assert.rejects(run(...args), err => {
    assert.match(JSON.parse(err.stdout).error.message, /earlier claim/i);
    return true;
  });
  const independent = await run(...issued(third));
  assert.notEqual(independent.result.event.id, first.result.event.id);
  assert.equal(fs.readFileSync(path.join(ctx.root, 'verified.txt'), 'utf8'), 'once\nonce\nonce\n');
});

test('a completion saved by an older CLI stays readable and is not verified again', async (t) => {
  const { ctx, run, task, args } = await fixture(t);
  await run(...args);
  const old = await run('element', 'receipt', task.card_id);
  tasks.updateTaskMetadata(ctx.db, old.task_id, (metadata) => { delete metadata.feed.completion; });
  await assert.rejects(run(...args), err => {
    assert.match(JSON.parse(err.stdout).error.message, /already has a result.*receipt/i);
    return true;
  });
  const reread = await run('element', 'receipt', task.card_id);
  assert.deepEqual(reread, old);
  assert.equal(fs.readFileSync(path.join(ctx.root, 'verified.txt'), 'utf8'), 'once\n');
});

test('a killed verifier owner leaves an uncertain check that a retry cannot repeat', async (t) => {
  const { ctx, env, run, task, args } = await fixture(t);
  const marker = path.join(ctx.root, 'verified.txt');
  fs.writeFileSync(path.join(ctx.root, 'check.js'), [
    "require('node:fs').appendFileSync('verified.txt', 'once\\n');",
    'setTimeout(() => {}, 800);',
  ].join('\n'));
  const completing = exec(process.execPath, [bin, ...args, '--json'], { cwd: ctx.root, env });
  const stopped = assert.rejects(completing, err => err.signal === 'SIGKILL');
  const until = Date.now() + 3000;
  while (!fs.existsSync(marker) && Date.now() < until) await delay(15);
  assert.ok(fs.existsSync(marker), 'the verifier should have started');
  completing.child.kill('SIGKILL');
  await stopped;
  await assert.rejects(run(...args), err => {
    assert.match(JSON.parse(err.stdout).error.message, /stopped before its receipt/);
    return true;
  });
  await assert.rejects(run('element', 'receipt', task.card_id), err => {
    assert.equal(JSON.parse(err.stdout).completion_status, 'uncertain');
    return true;
  });
  assert.equal(fs.readFileSync(marker, 'utf8'), 'once\n');
  assert.equal((await run('feed', 'events')).events.filter(e => e.type === 'result').length, 0);
});

test('a tagged helper must claim an open card before running its check', async (t) => {
  const { ctx, run, task, args } = await fixture(t, { claim: false });
  await assert.rejects(run(...args), err => {
    assert.match(JSON.parse(err.stdout).error.message, /claim.*first/i);
    return true;
  });
  assert.equal(fs.existsSync(path.join(ctx.root, 'verified.txt')), false);
  const events = (await run('feed', 'events')).events;
  assert.equal(events.filter(event => event.type === 'result' && event.card_id === task.card_id).length, 0);
});
