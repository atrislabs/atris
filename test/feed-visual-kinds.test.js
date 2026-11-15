'use strict';

// Pictures that make a card clear at a glance: code shown as code, picture
// files from the project, members told to bring one, and finished code work
// showing its real changed lines.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const tasks = require('../lib/task-db');
const feed = require('../lib/feed-core');
const team = require('../lib/feed-team');
const visuals = require('../lib/feed-visuals');
const { project } = require('./helpers/feed-project');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

test('visuals: code is shown as code, held to size and plain text, its caption to plain words', () => {
  const ok = visuals.checkVisual({ kind: 'code', language: 'JS', code: 'if (price < 0) throw new Error("no");\n// merged the branch', caption: 'Prices can no longer go below zero' });
  assert.equal(ok.language, 'js');
  assert.match(ok.code, /merged the branch/, 'the code itself is not held to the plain-words check');
  assert.equal(visuals.checkVisual({ kind: 'code', code: 'x = 1' }).language, undefined);
  for (const bad of [
    { kind: 'code', code: '' },
    { kind: 'code', code: 'a'.repeat(visuals.CODE_MAX_BYTES + 1) },
    { kind: 'code', code: 'a\u0007b' },
    { kind: 'code', code: 'x', language: 'java script!' },
    { kind: 'code', code: 'x', caption: 'Merged the PR into the repo' },
    { kind: 'code', code: 'x', html: '<b>' },
  ]) assert.throws(() => visuals.checkVisual(bad), visuals.VisualRejected, JSON.stringify(bad).slice(0, 60));
});

test('visuals: a code visual never becomes the card\'s title, why or story', (t) => {
  const ctx = project(t);
  const code = { kind: 'code', language: 'js', code: 'function total(items) { return items.length; }', caption: 'The new total' };
  const card = feed.proposeCard(ctx.root, { as: 'scout', title: 'Count items in the basket', why: 'Fewer wrong totals', visual: code, env: ctx.env }).card;
  assert.equal(card.title, 'Count items in the basket');
  assert.equal(card.why, 'Fewer wrong totals');
  assert.deepEqual(card.story, []);
  assert.deepEqual(card.visual, code);
});

test('visuals: a picture file inside the project or ~/.atris; escapes, links out, fakes and big files are refused', (t) => {
  const ctx = project(t);
  const inside = path.join(ctx.root, 'shots', 'basket.png');
  fs.mkdirSync(path.dirname(inside), { recursive: true });
  fs.writeFileSync(inside, PNG);
  const image = visuals.checkVisual({ kind: 'image', path: 'shots/basket.png', alt: 'The basket page' }, { root: ctx.root });
  assert.equal(image.path, fs.realpathSync(inside));
  const home = require('../lib/state-home').atrisHome();
  fs.mkdirSync(home, { recursive: true });
  const fromHome = path.join(home, `feed-test-${process.pid}.png`);
  fs.writeFileSync(fromHome, PNG);
  t.after(() => fs.rmSync(fromHome, { force: true }));
  assert.ok(visuals.checkVisual({ kind: 'image', path: fromHome, alt: 'A chart' }, { root: ctx.root }));
  const outside = path.join(ctx.dir, 'outside.png');
  fs.writeFileSync(outside, PNG);
  fs.symlinkSync(outside, path.join(ctx.root, 'shots', 'link.png'));
  fs.writeFileSync(path.join(ctx.root, 'shots', 'fake.png'), 'not a picture');
  fs.writeFileSync(path.join(ctx.root, 'shots', 'page.html'), '<html>');
  const big = path.join(ctx.root, 'shots', 'big.png');
  const fd = fs.openSync(big, 'w');
  fs.writeSync(fd, PNG, 0, PNG.length, 0);
  fs.ftruncateSync(fd, visuals.IMAGE_FILE_MAX_BYTES + 1);
  fs.closeSync(fd);
  for (const [name, raw] of [
    ['escape', { kind: 'image', path: '../outside.png', alt: 'x' }],
    ['absolute outside', { kind: 'image', path: outside, alt: 'x' }],
    ['link out', { kind: 'image', path: 'shots/link.png', alt: 'x' }],
    ['fake', { kind: 'image', path: 'shots/fake.png', alt: 'x' }],
    ['not a picture type', { kind: 'image', path: 'shots/page.html', alt: 'x' }],
    ['too big', { kind: 'image', path: 'shots/big.png', alt: 'x' }],
    ['missing', { kind: 'image', path: 'shots/none.png', alt: 'x' }],
    ['both', { kind: 'image', path: 'shots/basket.png', url: 'https://atris-uploads.s3.amazonaws.com/a.png', alt: 'x' }],
  ]) assert.throws(() => visuals.checkVisual(raw, { root: ctx.root }), visuals.VisualRejected, name);
  assert.throws(() => visuals.checkVisual({ kind: 'image', path: 'shots/basket.png', alt: 'x' }), visuals.VisualRejected, 'no project, no file');
  // On a card: checked again on every read.
  const card = feed.proposeCard(ctx.root, { as: 'scout', title: 'Show the basket page', why: 'Easier to judge', visual: { kind: 'image', path: 'shots/basket.png', alt: 'The basket page' }, env: ctx.env }).card;
  assert.equal(card.visual.path, fs.realpathSync(inside));
  fs.rmSync(inside);
  assert.equal(feed.listCards(ctx.root, { env: ctx.env }).cards[0].visual, null, 'a picture that is gone is dropped');
});

test('visuals: members are told to bring one, from real content, when proposing, revising and finishing', async (t) => {
  const ctx = project(t);
  assert.match(team.pingBrief(ctx.root, 'scout', 'scroll'), /Bring one visual whenever it makes the card faster to understand/);
  assert.match(team.pingBrief(ctx.root, 'scout', 'scroll'), /never invented/);
  const card = feed.proposeCard(ctx.root, { as: 'scout', title: 'Count items in the basket', why: 'Fewer wrong totals', env: ctx.env }).card;
  await feed.talk(ctx.root, card.id, 'Smaller?', { env: ctx.env, deps: ctx.deps });
  assert.match(ctx.turns[0].prompt, /"visual": \{\.\.\.\}/);
  assert.match(ctx.turns[0].prompt, /No visual is better than a decorative one/);
  feed.decide(ctx.root, card.id, 'approve', { env: ctx.env, deps: ctx.deps });
  const objective = tasks.getTask(ctx.db, card.source.id).metadata.objective;
  assert.match(objective, /add one visual to the result/);
  assert.match(objective, /code visual with the key changed lines/);
  // A revision can bring a visual too, through the same checks.
  const second = feed.proposeCard(ctx.root, { as: 'writer', title: 'Write the spring price note', why: 'Buyers ask', env: ctx.env }).card;
  ctx.deps.answer = () => 'Here is the change.\nREVISE {"visual": {"kind": "before_after", "before": "Ten dollars", "after": "Eight dollars"}}';
  const out = await feed.talk(ctx.root, second.id, 'Show me the change', { env: ctx.env, deps: ctx.deps });
  assert.equal(out.card.visual.kind, 'before_after');
});

test('visuals: a finished result carries the member\'s own picture, else its real changed lines', async (t) => {
  const ctx = project(t);
  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: ctx.root, encoding: 'utf8' });
  git('init', '-q');
  fs.writeFileSync(path.join(ctx.root, 'total.js'), 'function total(items) {\n  return 0;\n}\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'start');
  const card = feed.proposeCard(ctx.root, { as: 'scout', title: 'Make the total add up', why: 'Wrong totals lose buyers', env: ctx.env }).card;
  feed.decide(ctx.root, card.id, 'approve', { env: ctx.env, deps: ctx.deps });
  const entry = feed.readRuns(ctx.root).find((e) => e.card_id === card.id);
  await feed.runEntry(ctx.root, entry.id, {
    ...ctx.deps,
    spawnSync: (_cmd, _args, opts) => {
      assert.match(opts.env.PATH.split(path.delimiter)[0], /\.atris\/state\/feed\/bin$/, 'this atris comes first for the member');
      fs.writeFileSync(path.join(ctx.root, 'total.js'), 'function total(items) {\n  return items.reduce((sum, i) => sum + i.price * i.qty, 0);\n}\n');
      git('commit', '-qam', 'add it up');
      team.emit(ctx.root, { as: 'scout', type: 'result', card: card.id, proof: 'The total test passes', env: ctx.env });
      return { status: 0 };
    },
  });
  const accept = feed.listCards(ctx.root, { env: ctx.env }).cards.find((c) => c.source.id === card.source.id && /:accept$/.test(c.id));
  assert.equal(accept.visual.kind, 'code');
  assert.equal(accept.visual.language, 'diff');
  assert.match(accept.visual.code, /\+ {2}return items\.reduce/);
  assert.match(accept.visual.code, /- {2}return 0;/);
  // The member's own picture wins, and can be added after the run handed the work over.
  team.emit(ctx.root, { as: 'scout', type: 'result', card: card.id, text: 'Totals now add up',
    visual: { kind: 'before_after', before: 'Every basket showed zero', after: 'Baskets show the real total' }, env: ctx.env });
  const again = feed.listCards(ctx.root, { env: ctx.env }).cards.find((c) => c.source.id === card.source.id && /:accept$/.test(c.id));
  assert.equal(again.visual.kind, 'before_after');
  assert.deepEqual(again.story, ['Totals now add up']);
});
