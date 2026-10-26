'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { signP } = require('../atris/experiments/ambitious-skill/gate.js');

test('sign test matches hand-computed binomial tails', () => {
  // 10 wins, 4 losses: (1001 + 364 + 91 + 14 + 1) / 2^14
  assert.equal(signP(10, 4), 1471 / 16384);
  // 15 of 20 is the first count that clears 0.05
  assert.ok(signP(15, 5) < 0.05);
  assert.ok(signP(14, 6) > 0.05);
  // no decided pairs means no evidence at all
  assert.equal(signP(0, 0), 1);
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PAIRS, verdictKey } = require('../atris/experiments/ambitious-skill/judge.js');

const GATE = path.join(__dirname, '..', 'atris', 'experiments', 'ambitious-skill', 'gate.js');

function fakeSet(ids, { stale = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amb-gate-'));
  const verdicts = [];
  for (const id of ids) {
    const skill = `a full and careful answer for ${id} `.repeat(10);
    const rec = { id, field: 'test', task: `task ${id}`, answers: { plain: `plain ${id}`, nudge: `nudge ${id}`, skill } };
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(rec));
    for (const [a, b] of PAIRS) {
      const key = stale.includes(id) ? 'old-answers' : verdictKey(rec, a, b);
      verdicts.push({ id, a, b, key, winner: a, split: false, grew: { [a]: false, [b]: false } });
    }
  }
  fs.writeFileSync(path.join(dir, 'verdicts.json'), JSON.stringify(verdicts));
  return dir;
}

const gate = (...dirs) => spawnSync(process.execPath, [GATE, ...dirs], { encoding: 'utf8' });

test('gate refuses the same folder twice and the same task in two folders', () => {
  const one = fakeSet(['t1', 't2']);
  assert.equal(gate(one, one).status, 2);
  assert.equal(gate(one, fakeSet(['t2', 't3'])).status, 2);
});

test('gate ignores verdicts for answers that changed since judging', () => {
  const run = gate(fakeSet(['m1', 'm2']), fakeSet(['w1'], { stale: ['w1'] }));
  assert.equal(run.status, 1);
  assert.match(run.stdout, /FAIL {2}all pairs judged\s+6\/9/);
});

test('gate passes a complete, fresh, clean set', () => {
  const ids = Array.from({ length: 6 }, (_, i) => `m${i}`);
  const run = gate(fakeSet(ids), fakeSet(['w1', 'w2']));
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

test('resume drops a verdict whose answer changed, even when another pair has the old text', () => {
  const { keepVerdicts } = require('../atris/experiments/ambitious-skill/judge.js');
  const before = { id: 'r1', task: 't', field: 'f', answers: { plain: 'p', nudge: 'same', skill: 'same' } };
  const saved = PAIRS.map(([a, b]) => ({ id: 'r1', a, b, key: verdictKey(before, a, b) }));
  const after = { ...before, answers: { ...before.answers, skill: 'new skill answer' } };
  const kept = keepVerdicts([after], saved).map((v) => `${v.a}|${v.b}`);
  assert.deepEqual(kept, ['nudge|plain']);
});

test('gate fails an answer made of fake command calls but not a correct short one', () => {
  const dir = fakeSet(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
  const short = JSON.parse(fs.readFileSync(path.join(dir, 'm1.json'), 'utf8'));
  short.answers.skill = 'Total miles: 42 + 58 + 31 + 104 + 17 = **252 miles**\n\nReimbursement: 252 × $0.67 = **$168.84**';
  fs.writeFileSync(path.join(dir, 'm1.json'), JSON.stringify(short));
  const fake = JSON.parse(fs.readFileSync(path.join(dir, 'm2.json'), 'utf8'));
  fake.answers.skill = '<invoke name="Bash"><parameter name="command">ls</parameter></invoke>';
  fs.writeFileSync(path.join(dir, 'm2.json'), JSON.stringify(fake));
  // rewrite keys so only the broken-answer line can fail
  const verdicts = JSON.parse(fs.readFileSync(path.join(dir, 'verdicts.json'), 'utf8'));
  for (const v of verdicts) {
    const rec = JSON.parse(fs.readFileSync(path.join(dir, `${v.id}.json`), 'utf8'));
    v.key = verdictKey(rec, v.a, v.b);
  }
  fs.writeFileSync(path.join(dir, 'verdicts.json'), JSON.stringify(verdicts));
  const run = gate(dir, fakeSet(['w1', 'w2']));
  assert.equal(run.status, 1);
  assert.match(run.stdout, /FAIL {2}5 nothing broken\s+m2$/m);
});
