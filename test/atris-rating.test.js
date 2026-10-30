'use strict';

// The Atris Rating: one scale, 25 to 99, for engines (the combine) and for
// members (the jobs they land). Pure functions and an injected season, so no
// task db, roster, or model is touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rating = require('../lib/atris-rating');
const season = require('../lib/gm-season');
const { bootTeamLine } = require('../lib/team-lineup');
const { ratingCommand } = require('../commands/rating');

test('99 means 99 of every 100, and the top takes a long clean run', () => {
  assert.equal(rating.atrisRating(0, 0), null);
  assert.equal(rating.atrisRating(1, null), null);
  assert.equal(rating.atrisRating(3, 3), 76, 'a short perfect run is not a 99');
  assert.equal(rating.atrisRating(30, 30), 95);
  assert.equal(rating.atrisRating(60, 60), 99);
  assert.equal(rating.atrisRating(990, 1000), 99);
  assert.equal(rating.atrisRating(980, 1000), 93, 'twice the misses of a 99');
  assert.equal(rating.atrisRating(960, 1000), 87, 'twice again');
  assert.equal(rating.atrisRating(500, 1000), 59, 'a coin flip');
  assert.equal(rating.atrisRating(0, 1000), 25, 'never below 25');
  assert.equal(rating.atrisRating(12, 3), 76, 'more finished than tried counts as all of them');
});

test('the team board rates members on the same scale', () => {
  const play = (kind, at) => ({ member: 'a', kind, at, task_id: `t${at}` });
  const plays = [...[1, 2, 3, 4, 5, 6, 7].map((at) => play('landed', at)), play('dropped', 8), play('abandoned', 9), play('took', 10)];
  assert.equal(season.ovr(plays), rating.atrisRating(7, 9));
  assert.equal(season.ovr(plays.slice(0, 2)), null, 'rookie under 3 finished');
});

test('the combine rates every engine, best first, and nobody is a 99', () => {
  const cards = rating.combineCards();
  assert.deepEqual(cards.map((c) => [c.label, c.ovr]), [['opus 5.5', 86], ['sonnet 5.5', 80], ['haiku 5.5', 76]]);
  for (const card of cards) {
    assert.ok(card.ovr < 99);
    assert.equal(card.ovr, rating.atrisRating(card.finished, card.tasks));
    assert.equal(card.clean, rating.atrisRating(card.tries - card.broke, card.tries));
    assert.ok(card.parts.python.tasks + card.parts.javascript.tasks === card.tasks);
  }
  const opus = rating.combineCardFor('opus');
  assert.equal(opus.model, 'claude-opus-5-5');
  assert.deepEqual(rating.combineCardFor('Opus 5.5'), opus);
  assert.deepEqual(rating.combineCardFor('claude-opus-5-5'), opus);
  assert.equal(rating.combineCardFor('gpt-9'), null);
  assert.equal(rating.combineCardFor(''), null);
});

test('the combine file is what the bench script prints, and nothing can change it', () => {
  const data = rating.COMBINE;
  assert.equal(data.bench, 'Loop Bench');
  assert.match(data.rated, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(data.engines.length >= 1);
  for (const row of data.engines) {
    for (const key of ['model', 'tasks', 'finished', 'python', 'javascript', 'unseen', 'tries', 'broke', 'timed_out', 'minutes_cap', 'median_minutes', 'cost_per_finish']) {
      assert.ok(key in row, `${row.model} has ${key}`);
    }
    assert.ok(row.finished <= row.tasks && row.unseen.tasks <= data.unseen);
    assert.ok(Math.abs(row.python.finished + row.javascript.finished - row.finished) < 0.15);
  }
  assert.ok(Object.isFrozen(data.engines[0].python));
  assert.throws(() => { data.engines[0].finished = 80; });
});

test('the league and a card say what each number means', () => {
  const text = rating.renderCombine();
  assert.match(text, /^how much real work a teammate finishes, 25 to 99\. 99 means 99 of every 100\.$/m);
  assert.match(text, /^ {2}86 +opus 5\.5 +77 of 80 +87 +84 +86 +94 +2\.2 min +91¢$/m);
  assert.match(text, /^ {2}76 +haiku 5\.5 +70\.5 of 80 /m);
  assert.match(text, /^no engine is a 99 yet\.$/m);
  assert.match(text, /^opus 5\.5 gets 20 minutes a task, the others 10\.$/m);
  const card = rating.renderCard(rating.combineCardFor('haiku'));
  assert.match(card, /^haiku 5\.5, builder +76 ovr$/m);
  assert.match(card, /^ {2}clean +95 +broke another test on 8 of 545 tries$/m);
  assert.match(card, /^ {2}8¢ per finished task on pay-per-use$/m);
  for (const line of [...text.split('\n'), ...card.split('\n')]) assert.ok(line.length <= 80, line);
  assert.doesNotMatch(text + card, /—/);
});

test('the boot line rates a build engine the combine knows, and nothing else', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-rating-boot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const line = bootTeamLine(root, {
    now: new Date('2026-10-29T12:00:00.000Z'),
    jobs: [
      { job: 'build', role: 'executor', now_runs: { engine: 'claude', model: 'claude-opus-5-5' } },
      { job: 'review', role: 'validator', now_runs: { engine: 'claude', model: 'claude-haiku-5-5' } },
      { job: 'search', role: 'navigator', now_runs: { engine: 'codex', model: 'gpt-6' } },
    ],
  });
  assert.equal(line, 'build opus 5.5 (86 ovr) · review haiku 5.5 · search codex gpt-6');
  assert.equal(rating.bootRatingText('gpt-6'), '');
  assert.equal(rating.bootRatingText(null), '');
});

function seasonOf(plays) {
  return { workspace_name: 'demo', outcomes: plays.map(([member, kind], i) => ({ member, kind, at: i + 1, task_id: `t${i}` })) };
}

const PLAYS = [
  ...Array.from({ length: 9 }, () => ['builder', 'landed']), ['builder', 'dropped'],
  ['scout', 'landed'], ['scout', 'abandoned'], ['scout', 'sent_back'],
  ['fresh', 'landed'],
];
const LINEUP = {
  ok: true,
  jobs: [{ job: 'build', role: 'executor', now_runs: { engine: 'claude', model: 'claude-haiku-5-5' } }],
  team: [
    { member: 'builder', job: 'build', model: 'claude-haiku-5-5' },
    { member: 'scout', job: 'search', model: null },
    { member: 'fresh', job: 'build', model: 'claude-haiku-5-5' },
  ],
};

function runRating(args, deps = {}) {
  let out = '';
  let err = '';
  const code = ratingCommand(args, { root: '/nowhere', season: seasonOf(PLAYS), lineup: LINEUP, write: (s) => { out += s; }, error: (s) => { err += s; }, ...deps });
  return { code, out, err };
}

test('atris rating shows the combine, then each member here on the same scale', () => {
  const { code, out } = runRating([]);
  assert.equal(code, 0);
  assert.match(out, /^the combine: 80 atris tasks, each graded by the tests that shipped with it$/m);
  assert.match(out, /^here: demo, last 30 days, the same ratings as atris gm$/m);
  assert.match(out, new RegExp(`^ {2}${rating.atrisRating(9, 10)} +builder +9 of 10 +build +haiku 5\\.5$`, 'm'));
  assert.match(out, new RegExp(`^ {2}${rating.atrisRating(1, 3)} +scout +1 of 3 +search$`, 'm'));
  assert.match(out, /^new, under 3 finished jobs \(1\): fresh$/m);
  // build runs haiku: its combine number next to what build members landed here
  assert.match(out, /^build runs haiku 5\.5, a 76 in the combine\.$/m);
  assert.match(out, new RegExp(`^members doing build here landed 10 of 11 jobs, an? ${rating.atrisRating(10, 11)}\\.$`, 'm'));
  for (const line of out.split('\n')) assert.ok(line.length <= 80, line);
});

test('atris rating <engine> and <member> print one card; an unknown name exits 1', () => {
  const engine = runRating(['sonnet']);
  assert.equal(engine.code, 0);
  assert.match(engine.out, /^sonnet 5\.5, builder +80 ovr$/m);
  const member = runRating(['builder']);
  assert.equal(member.code, 0);
  assert.match(member.out, new RegExp(`^builder, build on haiku 5\\.5 +${rating.atrisRating(9, 10)} ovr here$`, 'm'));
  assert.match(member.out, /its engine, haiku 5\.5, is a 76 in the combine: atris rating haiku/);
  const missing = runRating(['nobody']);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /no engine or member called "nobody" is rated\. engines: opus 5\.5, sonnet 5\.5, haiku 5\.5\./);
});

test('atris rating --json carries the scale, every engine, and the members here', () => {
  const { code, out } = runRating(['--json']);
  assert.equal(code, 0);
  const data = JSON.parse(out);
  assert.equal(data.schema, 'atris.rating.v1');
  assert.deepEqual([data.scale.floor, data.scale.top], [25, 99]);
  assert.deepEqual(data.combine.engines.map((e) => e.model), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  assert.deepEqual(data.here.members.find((m) => m.member === 'builder'), { member: 'builder', ovr: rating.atrisRating(9, 10), landed: 9, finished: 10, job: 'build', model: 'claude-haiku-5-5' });
  assert.deepEqual(data.here.build, { model: 'claude-haiku-5-5', combine_ovr: 76, landed: 10, finished: 11, ovr: rating.atrisRating(10, 11) });
});

test('with no task history, atris rating shows the combine alone', () => {
  const { code, out } = runRating([], { season: { no_history: true, outcomes: [] } });
  assert.equal(code, 0);
  assert.match(out, /^no engine is a 99 yet\.$/m);
  assert.doesNotMatch(out, /^here/m);
});
