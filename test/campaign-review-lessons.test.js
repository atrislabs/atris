'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const children = require('node:child_process');
const denied = [];
const originals = new Map(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']
  .map(name => [name, children[name]]));
for (const name of originals.keys()) children[name] = () => {
  denied.push(name);
  throw new Error(`unexpected native child: ${name}`);
};
test.after(() => {
  for (const [name, original] of originals) children[name] = original;
  assert.deepEqual(denied, [], 'even a caught unexpected native call remains a failure');
});
const environment = () => createHash('sha256').update(JSON.stringify(Object.entries(process.env).sort())).digest('hex');
const caller = { environment: environment(), cwd: process.cwd() };
const { makeCadence, lessonsPath, readLessons } = require('../lib/campaign-cadence');
const { makeLoop } = require('../lib/campaign-loop');
const { createMemoryStore, getCampaign } = require('../lib/campaign-store');

const ID = 'cmp-review-lessons';
const NOTE = '- (no review written this round)';

function workspace(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'rvl-'));
  const root = path.join(parent, 'work');
  const sentinel = path.join(parent, 'foreign.txt');
  let store;
  t.after(() => {
    try {
      if (store) store.close();
      fs.rmSync(root, { recursive: true, force: true });
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'foreign fixture stays\n');
      assert.equal(environment(), caller.environment, 'parent environment digest stays unchanged');
      assert.equal(process.cwd(), caller.cwd);
    } finally { fs.rmSync(parent, { recursive: true, force: true }); }
  });
  fs.mkdirSync(root);
  fs.writeFileSync(sentinel, 'foreign fixture stays\n');
  store = createMemoryStore({ origin: 'review-lessons', now: () => '2026-10-17T00:00:00Z' });
  const addReading = reading => store.append({ campaign_id: ID, type: 'judge_ran', actor: 'judge',
    data: { passed: false, reading, summary: `recorded reading ${reading}` } });
  store.append({ campaign_id: ID, type: 'campaign_started', actor: 'owner',
    data: { title: 'Owned lesson review', judge: 'false', owner: 'owner', budget: 10 } });
  addReading(0.5);
  const local = lessonsPath(root, ID);
  const global = path.join(root, 'atris', 'campaigns', 'lessons.md');
  const seed = (localText, globalText = '') => {
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, localText);
    fs.writeFileSync(global, globalText);
  };
  const reviewPrompts = [];
  const planPrompts = [];
  const review = (before, text) => makeCadence(root, null, {}, {
    store, log: () => {}, now: () => Date.UTC(2026, 9, 17),
    ask: async (actualRoot, view, prompt) => {
      reviewPrompts.push(prompt);
      assert.equal(actualRoot, root);
      assert.equal(view.id, ID);
      assert.match(prompt, /^You review/);
      return { ok: true, text };
    },
  }).review(ID, before);
  const propose = () => makeLoop(root, {}, {
    store, log: () => {}, lessons: id => readLessons(root, id),
    ask: async (actualRoot, view, prompt) => {
      planPrompts.push(prompt);
      assert.equal(actualRoot, root);
      assert.equal(view.id, ID);
      assert.match(prompt, /^You plan/);
      return { ok: true, text: '[]' };
    },
  }).propose(ID);
  return { root, store, local, global, seed, addReading, review, propose, reviewPrompts, planPrompts };
}

for (const answer of ['empty', 'known']) {
  test(`an ${answer} nonquiet review cannot replace a real planning lesson with its operator note`, async t => {
    const h = workspace(t);
    const notes = Array.from({ length: 30 }, (_, i) => `- verify owned check ${String(i + 1).padStart(2, '0')} before retrying`);
    h.seed('# Fixture lessons\n' + notes.join('\n') + '\n');
    const before = getCampaign(h.store, ID);
    const snapshot = JSON.stringify(before);
    h.addReading(0.6);
    const events = h.store.read(ID);
    const review = await h.review(before, answer === 'known' ? notes[0] : '');
    const learned = readLessons(h.root, ID);
    const proposals = await h.propose();
    const prompt = h.planPrompts[0];
    const raw = fs.readFileSync(h.local, 'utf8');
    assert.equal(review.quiet, false);
    assert.deepEqual(review.lessons, []);
    assert.match(raw, /- \(no review written this round\)/, 'the actual operator record is retained');
    assert.deepEqual(proposals, []);
    assert.equal(h.reviewPrompts.length, 1);
    assert.equal(h.planPrompts.length, 1);
    assert.match(prompt, /Lessons from earlier rounds \(follow them\):/);
    assert.deepEqual(h.store.read(ID), events);
    assert.equal(JSON.stringify(before), snapshot);
    assert.deepEqual(denied, []);
    assert.deepEqual(learned.split('\n'), notes, `actual next planning prompt:\n${prompt}`);
    for (const note of notes) assert.ok(prompt.split('\n').includes(note), note);
    assert.ok(!prompt.split('\n').includes(NOTE));
  });
}

test('historical exact notes are excluded while genuine text, spelling, dedup, order and cap survive', async t => {
  const h = workspace(t);
  const first = '- Retain the first authored spelling';
  const phrase = '- explain why (no review written this round) belongs in the operator record';
  const variation = '- (No review written this round)';
  const global = '- check the global fixture before retrying';
  const localText = `# Local\n${NOTE}\n${first}\n${phrase}\n${variation}\n`;
  const globalText = `# Global\n${NOTE}\n${first.toLowerCase()}\n${global}\n`;
  h.seed(localText, globalText);
  const events = h.store.read(ID);
  const learned = readLessons(h.root, ID);
  const capped = readLessons(h.root, ID, 3);
  const proposals = await h.propose();
  const prompt = h.planPrompts[0];
  assert.deepEqual(proposals, []);
  assert.deepEqual(h.store.read(ID), events);
  assert.equal(fs.readFileSync(h.local, 'utf8'), localText);
  assert.equal(fs.readFileSync(h.global, 'utf8'), globalText);
  assert.deepEqual(learned.split('\n'), [first, phrase, variation, global], `actual next planning prompt:\n${prompt}`);
  assert.deepEqual(capped.split('\n'), [phrase, variation, global]);
  assert.ok(prompt.split('\n').includes(variation));
  assert.ok(prompt.split('\n').includes(phrase));
  assert.ok(!prompt.split('\n').includes(NOTE));
});

test('a meaningful new lesson feeds the actual next plan and a quiet review remains only a record', async t => {
  const h = workspace(t);
  const old = '- check the owned fixture before changing it';
  const fresh = '- compare the measured result before broadening scope';
  h.seed(old + '\n');
  const before = getCampaign(h.store, ID);
  h.addReading(0.6);
  const events = h.store.read(ID);
  const review = await h.review(before, fresh);
  const proposals = await h.propose();
  const quiet = await h.review(getCampaign(h.store, ID), '- this answer must never be requested');
  const afterQuiet = readLessons(h.root, ID);
  const next = await h.propose();
  assert.deepEqual(review.lessons, [fresh]);
  assert.deepEqual(proposals, []);
  assert.deepEqual(next, []);
  assert.equal(quiet.quiet, true);
  assert.deepEqual(quiet.lessons, []);
  assert.equal(h.reviewPrompts.length, 1);
  assert.equal(h.planPrompts.length, 2);
  assert.equal(afterQuiet, old + '\n' + fresh);
  for (const prompt of h.planPrompts) {
    assert.ok(prompt.split('\n').includes(old));
    assert.ok(prompt.split('\n').includes(fresh));
    assert.ok(!prompt.split('\n').includes(NOTE));
  }
  assert.match(fs.readFileSync(h.local, 'utf8'), /nothing ended and the reading held/);
  assert.deepEqual(h.store.read(ID), events);
});
