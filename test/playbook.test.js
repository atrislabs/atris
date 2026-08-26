'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { playbookCommand, readPlaybook, gradeText } = require('../commands/playbook');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-playbook-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lines = [];
  let nextId = 1;
  const run = (args) => playbookCommand(args, {
    root,
    output: (line) => lines.push(line),
    makeId: () => `rule-${nextId++}`,
    now: () => '2026-08-25T00:00:00.000Z',
  });
  return { root, lines, run };
}

function shellArg(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function fakeEngine(script) {
  return `${shellArg(process.execPath)} -e ${shellArg(script)}`;
}

test('add stores a rule and show groups it by family', (t) => {
  const item = fixture(t);
  assert.equal(item.run(['add', 'voice', 'use plain words', '--source', 'gate']), 0);
  item.lines.length = 0;
  assert.equal(item.run(['show']), 0);
  assert.deepEqual(item.lines, ['voice:', '- rule-1: use plain words']);
  assert.deepEqual(readPlaybook(item.root).rules[0], {
    id: 'rule-1', family: 'voice', rule: 'use plain words', source: 'gate', verified: null,
    created_at: '2026-08-25T00:00:00.000Z',
  });
});

test('add deduplicates exact family and rule matches', (t) => {
  const item = fixture(t);
  item.run(['add', 'voice', 'use plain words']);
  item.lines.length = 0;
  item.run(['add', 'voice', 'use plain words']);
  assert.deepEqual(item.lines, ['rule already exists: rule-1']);
  assert.equal(readPlaybook(item.root).rules.length, 1);
});

test('inject filters by family', (t) => {
  const item = fixture(t);
  item.run(['add', 'voice', 'use plain words']);
  item.run(['add', 'code', 'keep functions small']);
  item.lines.length = 0;
  item.run(['inject', '--family', 'code']);
  assert.deepEqual(item.lines, [
    'Workspace style rules (follow every rule that applies):',
    '- keep functions small',
  ]);
});

test('verify quarantines a regressing rule and inject skips it', (t) => {
  const item = fixture(t);
  item.run(['add', 'voice', 'use plain words']);
  item.run(['add', 'voice', 'keep sentences short']);
  item.lines.length = 0;
  item.run(['verify', 'rule-1', '--with', '71', '--without', '88', '--method', 'replay']);
  assert.deepEqual(item.lines, ['rule quarantined: rule-1']);
  item.lines.length = 0;
  item.run(['inject']);
  assert.deepEqual(item.lines, [
    'Workspace style rules (follow every rule that applies):',
    '- keep sentences short',
  ]);
});

test('remove deletes a rule by id', (t) => {
  const item = fixture(t);
  item.run(['add', 'voice', 'use plain words']);
  item.lines.length = 0;
  item.run(['remove', 'rule-1']);
  assert.deepEqual(item.lines, ['rule removed: rule-1']);
  assert.deepEqual(readPlaybook(item.root).rules, []);
});

test('trial gate scores each plain-writing rule', () => {
  assert.equal(gradeText('plain update.'), 1);
  assert.equal(gradeText(`plain${String.fromCharCode(0x2014)}update.`), 0.8);
  assert.equal(gradeText('one. two. three.'), 0.8);
  assert.equal(gradeText('robust update.'), 0.8);
  assert.equal(gradeText('LOUD update.'), 0.8);
  assert.equal(gradeText('plain update!'), 0.8);
  assert.equal(gradeText('one. two.\n\nthree. four.'), 1);
});

test('trial quarantines a rule that makes every gate worse', async (t) => {
  const item = fixture(t);
  item.run(['add', 'voice', 'write in all caps']);
  item.lines.length = 0;
  const engine = fakeEngine('const p=process.argv[1]||"";process.stdout.write(p.includes("- write in all caps")?"ROBUST SYNERGY! \\u2014 DELVE! LOUD!":"plain update.")');

  assert.equal(await item.run(['trial', '--engine', engine]), 0);

  const rule = readPlaybook(item.root).rules[0];
  assert.equal(rule.quarantined, true);
  assert.equal(rule.verified.method, 'paired-trial');
  assert.equal(rule.verified.score_with, 0);
  assert.equal(rule.verified.score_without, 1);
  assert.ok(rule.verified.kill_evidence >= rule.verified.evidence_threshold);
  assert.ok(rule.trial_diffs.length <= 30);
  assert.match(item.lines.at(-1), /^rule quarantined: rule-1 after \d+ pairs$/);
});

test('trial certifies a rule that keeps every gate clean', async (t) => {
  const item = fixture(t);
  item.run(['add', 'voice', 'use plain words']);
  item.lines.length = 0;
  const engine = fakeEngine('const p=process.argv[1]||"";process.stdout.write(p.includes("- use plain words")?"plain update.":"ROBUST SYNERGY! \\u2014 DELVE! LOUD!")');

  assert.equal(await item.run(['trial', '--engine', engine]), 0);

  const rule = readPlaybook(item.root).rules[0];
  assert.equal(rule.quarantined, false);
  assert.equal(rule.verified.method, 'paired-trial');
  assert.equal(rule.verified.score_with, 1);
  assert.equal(rule.verified.score_without, 0);
  assert.ok(rule.verified.certify_evidence >= rule.verified.evidence_threshold);
  assert.ok(rule.trial_diffs.length <= 30);
  assert.match(item.lines.at(-1), /^rule certified: rule-1 after \d+ pairs$/);
});

test('trial resumes from persisted paired differences', async (t) => {
  const item = fixture(t);
  item.run(['add', 'voice', 'keep the update readable']);
  item.lines.length = 0;
  const callsFile = path.join(item.root, 'engine-calls');
  const engine = fakeEngine(`require("fs").appendFileSync(${JSON.stringify(callsFile)},"x");process.stdout.write("plain update.")`);

  assert.equal(await item.run(['trial', '--engine', engine, '--max-pairs', '3']), 0);
  assert.equal(readPlaybook(item.root).rules[0].trial_diffs.length, 3);
  assert.equal(fs.readFileSync(callsFile, 'utf8').length, 12);

  item.lines.length = 0;
  assert.equal(await item.run(['trial', '--engine', engine, '--max-pairs', '6']), 0);
  const rule = readPlaybook(item.root).rules[0];
  assert.equal(rule.trial_diffs.length, 6);
  assert.deepEqual(rule.trial_diffs, [0, 0, 0, 0, 0, 0]);
  assert.equal(fs.readFileSync(callsFile, 'utf8').length, 24);
  assert.deepEqual(item.lines, [
    'on trial: rule-1 (3 prior pairs)',
    'rule undecided after 6 pairs: rule-1',
  ]);
});

test('trial keeps the better of two drafts for each arm', async (t) => {
  const item = fixture(t);
  item.run(['add', 'voice', 'keep the update readable']);
  item.lines.length = 0;
  const statePrefix = path.join(item.root, 'draft-count-');
  const engine = fakeEngine(`const fs=require("fs");const p=process.argv[1]||"";const f=${JSON.stringify(statePrefix)}+(p.includes("- keep the update readable")?"with":"without");const n=fs.existsSync(f)?Number(fs.readFileSync(f,"utf8")):0;fs.writeFileSync(f,String(n+1));process.stdout.write(n%2===0?"ROBUST!":"plain update.")`);

  assert.equal(await item.run(['trial', '--engine', engine, '--max-pairs', '1']), 0);

  const rule = readPlaybook(item.root).rules[0];
  assert.deepEqual(rule.trial_scores_with, [1]);
  assert.deepEqual(rule.trial_scores_without, [1]);
  assert.deepEqual(rule.trial_diffs, [0]);
});

test('help lists paired trials', () => {
  const lines = [];
  assert.equal(playbookCommand(['--help'], { output: (line) => lines.push(line) }), 0);
  assert.ok(lines.includes('       atris playbook trial [--engine <cmd>] [--max-pairs <n>] [--alpha <a>]'));
});
