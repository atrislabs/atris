'use strict';

// The rating picks the builder. lib/builder-pick.js reads each engine's real
// results (the plays the rating counts) and orders a job's candidates by a
// seeded draw from what those results say, so a strong record leads, a weak one
// rarely does, and an engine with no record gets tried. These tests pin the
// pure picker, the way plays are counted, and how the fleet's dealing uses it:
//
//   - a landing counts only when its commit is on origin's default branch, is no older than the claim it lands
//     (five minutes of clock skew allowed), and no other job recorded it first; misses always count
//   - "first to record" is read from every landing record in the whole store (every workspace, every later review
//     pass of a job), and records made at one moment are told apart by insertion order, not by event id
//   - a landing pays the engine that finished it, which the hand-in names; when the hand-in does not say who finished
//     and names more than one engine, the landing counts for nobody
//   - the folder is judged in one order: no git, no origin or no origin/HEAD deals jobs in turn with one line;
//     landings on record are fetched, and a failed fetch deals in turn with one line; misses alone steer without a fetch
//   - origin is fetched once before steering (its default branch, with an explicit refspec), so a merge from a minute
//     ago is known, and git is asked the same few questions however many landings there are
//   - a play's lane is the lane its job was in at the claim, saved on the claim itself (by a claim and by a task do);
//     a claim without it counts at half weight and is never rebuilt from the job's history
//   - explicit choices (a named engine, an assigned member's engine) are resolved first, and one this flight cannot
//     give leaves that job out of the flight with one line, never silently on some other engine; a job left out is
//     taken out before the flight is staffed (gives), and the words the pick went on are checked again inside the
//     claim's own transaction (guardClaim, claimTask's refuseIf)
//   - an engine the Claude spend guard would stop is never picked, judged on the --model the fleet itself passes
//     (through the model remaps and ANTHROPIC_MODEL of the worker's environment, and no settings file); a command
//     template somebody wrote is never read, so its model is one nobody can tell, which counts as paid
//   - an engine list a caller names is never filtered

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fleet = require('../lib/fleet');
const gmSeason = require('../lib/gm-season');
const registry = require('../lib/engine-registry');
const tasks = require('../lib/task-db');
const { launchFor } = require('../lib/runner-command');
const { unattendedStop } = require('../lib/claude-spend-guard');
const { historyStore, watchGit } = require('./helpers/pick-history');
const {
  CHOICE_CHANGED,
  STEERING_START,
  steeringStart,
  parsePickFlag,
  pickMode,
  pickSeed,
  laneTokens,
  pickBuilders,
  loadPlays,
  startSteering,
} = require('../lib/builder-pick');

const MINUTE = 60000;
const HOUR = 3600000;
const DAY = 24 * HOUR;
const START = Date.parse('2026-11-01T00:00:00Z');
const NOW = Date.parse('2026-11-05T12:00:00Z');

// One play the way the rating builds it, with the lane tokens of its job.
let playSeq = 0;
function play(member, kind, extra = {}) {
  playSeq += 1;
  return { member, kind, claimed_at: START + HOUR, task_id: `play-${playSeq}`, lane: [], ...extra };
}
const plays = (n, member, kind, extra) => Array.from({ length: n }, () => play(member, kind, extra));
const seedsOf = (n, prefix = 'job') => Array.from({ length: n }, (_, i) => `${prefix}-${i + 1}|2026-11-05`);
const pick = (args) => pickBuilders({ since: START, job: { id: 'job-1', lane: [] }, seed: 'job-1|2026-11-05', ...args });
const firsts = (seeds, args) => seeds.map((seed) => pick({ ...args, seed }).order[0]);
const count = (list, value) => list.filter((item) => item === value).length;

// ---------------------------------------------------------------------------
// The steering start and the switch.

test('the steering start is one named day, and ATRIS_PICK_SINCE moves it', () => {
  assert.equal(STEERING_START, '2026-11-01T00:00:00Z');
  const fallback = steeringStart({});
  assert.equal(fallback.ms, Date.parse('2026-11-01T00:00:00Z'));
  assert.equal(fallback.label, 'Nov 1');
  const moved = steeringStart({ ATRIS_PICK_SINCE: '2026-12-15' });
  assert.equal(moved.ms, Date.parse('2026-12-15T00:00:00Z'));
  assert.equal(moved.label, 'Dec 15');
  assert.equal(steeringStart({ ATRIS_PICK_SINCE: '2026-12-15T06:30:00Z' }).iso, '2026-12-15T06:30:00.000Z');
  assert.equal(steeringStart({ ATRIS_PICK_SINCE: 'last tuesday' }).ms, fallback.ms, 'a date nobody can read falls back to the named day');
  assert.equal(steeringStart({ ATRIS_PICK_SINCE: '  ' }).ms, fallback.ms);
});

test('--pick and ATRIS_PICK: only "turns" restores the old dealing, and the flag beats the environment', () => {
  assert.equal(parsePickFlag('turns'), 'turns');
  assert.equal(parsePickFlag('rating'), 'rating');
  assert.equal(parsePickFlag(' TURNS '), 'turns');
  assert.equal(parsePickFlag('random'), null);
  assert.equal(parsePickFlag(''), null);
  assert.equal(pickMode(undefined, {}), 'rating', 'steering is on unless someone turns it off');
  assert.equal(pickMode('turns', {}), 'turns');
  assert.equal(pickMode(undefined, { ATRIS_PICK: 'turns' }), 'turns');
  assert.equal(pickMode(undefined, { ATRIS_PICK: 'TURNS' }), 'turns');
  assert.equal(pickMode(undefined, { ATRIS_PICK: 'anything else' }), 'rating');
  assert.equal(pickMode('rating', { ATRIS_PICK: 'turns' }), 'rating', 'an explicit flag wins over the environment');
});

// ---------------------------------------------------------------------------
// Who gets tried, who rarely does.

test('a newcomer with no plays is picked at least once across 10 fixed seeds', () => {
  const history = [...plays(4, 'fleet-claude', 'landed'), ...plays(1, 'fleet-claude', 'dropped')];
  const leaders = firsts(seedsOf(10), { candidates: ['claude', 'codex'], plays: history });
  assert.ok(count(leaders, 'codex') >= 1, `the newcomer was never tried: ${leaders.join(' ')}`);
  assert.ok(count(leaders, 'claude') >= 1, 'a proven builder still leads sometimes');
});

test('a builder at 0 of 8 is picked under 2 times in 20 seeds against one at 4 of 5', () => {
  const history = [
    ...plays(8, 'fleet-codex', 'dropped'),
    ...plays(4, 'fleet-claude', 'landed'), ...plays(1, 'fleet-claude', 'sent_back'),
  ];
  const leaders = firsts(seedsOf(20), { candidates: ['codex', 'claude'], plays: history });
  assert.ok(count(leaders, 'codex') < 2, `the chronic misser led ${count(leaders, 'codex')} times: ${leaders.join(' ')}`);
});

test('the same job, day and history give the same pick, whatever order the plays arrive in', () => {
  const history = [...plays(3, 'fleet-claude', 'landed'), ...plays(2, 'fleet-codex', 'landed'), ...plays(1, 'fleet-codex', 'dropped')];
  const args = { candidates: ['claude', 'codex', 'cursor'], job: { id: 'job-7', lane: ['docs'] }, plays: history, seed: pickSeed('job-7', NOW) };
  const first = pickBuilders({ since: START, ...args });
  const again = pickBuilders({ since: START, ...args, plays: [...history].reverse() });
  assert.deepEqual(again.order, first.order);
  assert.equal(again.line, first.line);

  // The seed is the job's row id plus the UTC day: any hour of the day is the same draw.
  assert.equal(pickSeed('job-7', NOW), pickSeed('job-7', NOW + 3 * HOUR));
  assert.notEqual(pickSeed('job-7', NOW), pickSeed('job-7', NOW + DAY));
  assert.notEqual(pickSeed('job-7', NOW), pickSeed('job-8', NOW));
  assert.match(pickSeed('job-7', NOW), /job-7/);
  assert.match(pickSeed('job-7', NOW), /2026-11-05/);

  // It really is a draw: on close records both builders lead on some days.
  const close = [...plays(3, 'fleet-claude', 'landed'), ...plays(1, 'fleet-claude', 'dropped'), ...plays(2, 'fleet-codex', 'landed'), ...plays(1, 'fleet-codex', 'dropped')];
  const leaders = firsts(seedsOf(30), { candidates: ['claude', 'codex'], plays: close });
  assert.ok(count(leaders, 'claude') > 3 && count(leaders, 'codex') > 3, `one builder always led: ${leaders.join(' ')}`);
});

test('adding or dropping a candidate never reshuffles the others', () => {
  const history = [...plays(3, 'fleet-claude', 'landed'), ...plays(1, 'fleet-claude', 'dropped'), ...plays(2, 'fleet-codex', 'landed'), ...plays(2, 'fleet-codex', 'dropped')];
  for (const seed of seedsOf(25)) {
    const two = pick({ candidates: ['claude', 'codex'], plays: history, seed }).order;
    const three = pick({ candidates: ['claude', 'codex', 'cursor'], plays: history, seed }).order.filter((name) => name !== 'cursor');
    assert.deepEqual(three, two, `seed ${seed} reshuffled claude and codex when cursor joined`);
  }
});

test('a builder strong in security but weak overall wins security jobs more often than the others', () => {
  const specialist = [...plays(10, 'fleet-cursor', 'landed', { lane: ['security'] }), ...plays(6, 'fleet-cursor', 'dropped', { lane: ['docs'] })];
  const steady = [...plays(5, 'fleet-claude', 'landed', { lane: ['docs'] }), ...plays(3, 'fleet-claude', 'dropped', { lane: ['docs'] })];
  const decent = [...plays(3, 'fleet-codex', 'landed', { lane: ['docs'] }), ...plays(1, 'fleet-codex', 'dropped', { lane: ['docs'] })];
  const history = [...specialist, ...steady, ...decent];
  const seeds = seedsOf(120);
  const candidates = ['claude', 'codex', 'cursor'];
  const onSecurity = firsts(seeds, { candidates, plays: history, job: { id: 'job-s', lane: ['security'] } });
  const onDocs = firsts(seeds, { candidates, plays: history, job: { id: 'job-d', lane: ['docs'] } });
  assert.ok(count(onSecurity, 'cursor') > count(onSecurity, 'claude'), 'on a security job the specialist beats the steady builder');
  assert.ok(count(onSecurity, 'cursor') > count(onSecurity, 'codex'), 'on a security job the specialist beats the decent builder');
  assert.ok(count(onSecurity, 'cursor') > count(onDocs, 'cursor') + 20, 'the same builder leads far more often in its own lane than outside it');
  assert.ok(count(onDocs, 'cursor') < count(onDocs, 'claude') + count(onDocs, 'codex'), 'outside the lane the weak overall record shows');
});

// ---------------------------------------------------------------------------
// What counts.

test('held, could-not-start, not-needed and in-progress plays count for nothing', () => {
  const ignored = [
    ...plays(5, 'fleet-codex', 'held'),
    ...plays(5, 'fleet-codex', 'could_not_start'),
    ...plays(5, 'fleet-codex', 'not_needed'),
    ...plays(5, 'fleet-codex', 'took', { claimed_at: null }),
  ];
  const result = pick({ candidates: ['claude', 'codex'], plays: [...plays(2, 'fleet-claude', 'landed'), ...ignored] });
  const codex = result.records.find((record) => record.name === 'codex');
  assert.equal(codex.counted, 0);
  assert.equal(codex.landed, 0);
  assert.match(result.line, /fleet-codex new/, 'an engine whose only plays are held or unstarted is still new');
  // They move nothing: the same draw as if those plays were never there.
  const clean = pick({ candidates: ['claude', 'codex'], plays: plays(2, 'fleet-claude', 'landed') });
  assert.deepEqual(result.order, clean.order);
});

test('the rating decides what a miss is: dropped, sent back and abandoned are misses', () => {
  const result = pick({
    candidates: ['codex'],
    plays: [play('fleet-codex', 'landed'), play('fleet-codex', 'dropped'), play('fleet-codex', 'sent_back'), play('fleet-codex', 'abandoned')],
  });
  assert.deepEqual([result.records[0].landed, result.records[0].counted], [1, 4]);
});

test('plays whose claim began before the start do not count, and a claim at the start does', () => {
  const before = [...plays(6, 'fleet-codex', 'landed', { claimed_at: START - 1 }), play('fleet-codex', 'landed', { claimed_at: null })];
  const result = pick({ candidates: ['claude', 'codex'], plays: before });
  assert.equal(result.records.find((record) => record.name === 'codex').counted, 0, 'plays from before steering shipped start everyone even');
  const atStart = pick({ candidates: ['claude', 'codex'], plays: [play('fleet-codex', 'landed', { claimed_at: START })] });
  assert.equal(atStart.records.find((record) => record.name === 'codex').counted, 1);
  const moved = pick({ candidates: ['codex'], plays: [play('fleet-codex', 'landed', { claimed_at: START + HOUR })], since: START + 2 * HOUR });
  assert.equal(moved.records[0].counted, 0, 'a later start leaves out what came before it');
});

test('plays by other members, and other lanes, are told apart', () => {
  const history = [
    play('fleet-codex', 'landed', { lane: ['security', 'cli'] }),
    play('fleet-codex', 'dropped', { lane: ['docs'] }),
    play('fleet-codex', 'landed', { lane: [] }),
    play('keshav', 'landed', { lane: ['security'] }),
  ];
  const result = pick({ candidates: ['codex'], plays: history, job: { id: 'j', lane: ['cli', 'security'] } });
  const record = result.records[0];
  assert.deepEqual([record.laneLanded, record.laneMissed, record.otherLanded, record.otherMissed], [1, 0, 1, 1]);
  assert.deepEqual([record.landed, record.counted], [2, 3], 'a person\'s plays are nobody\'s engine record');
});

// ---------------------------------------------------------------------------
// The line.

test('the line says who was picked, for what, on what record, and how the others stand', () => {
  const history = [
    ...plays(3, 'fleet-claude', 'landed', { lane: ['docs'] }), ...plays(1, 'fleet-claude', 'dropped', { lane: ['docs'] }),
    ...plays(2, 'fleet-codex', 'dropped', { lane: ['docs'] }),
  ];
  // claude leads on the first of these fixed seeds
  const seed = seedsOf(40).find((candidate) => pick({ candidates: ['claude', 'codex', 'cursor'], plays: history, seed: candidate }).order[0] === 'claude');
  assert.ok(seed, 'a seed where the proven builder leads');
  const result = pick({ candidates: ['claude', 'codex', 'cursor'], plays: history, seed, job: { id: 'job-1', lane: ['security'] } });
  assert.equal(result.picked, 'claude');
  assert.equal(result.line, 'picked fleet-claude for this security job: landed 3 of 4 since Nov 1 (fleet-codex 0 of 2, fleet-cursor new)');
});

test('the line for a job with no lane, a newcomer, a lane record, and a full engine', () => {
  const plain = pick({ candidates: ['claude', 'codex'], plays: plays(3, 'fleet-claude', 'landed'), seed: 'a' });
  assert.match(plain.line, /^picked fleet-(claude|codex) for this job: /);

  // a newcomer picked says so instead of quoting a record
  const history = [...plays(1, 'fleet-claude', 'landed'), ...plays(5, 'fleet-claude', 'dropped')];
  const seed = seedsOf(60).find((candidate) => pick({ candidates: ['claude', 'codex'], plays: history, seed: candidate }).order[0] === 'codex');
  assert.ok(seed);
  const fresh = pick({ candidates: ['claude', 'codex'], plays: history, seed });
  assert.equal(fresh.line, 'picked fleet-codex for this job: no results yet since Nov 1 (fleet-claude 1 of 6)');

  // a lane record is quoted next to the overall one
  const lane = [...plays(2, 'fleet-claude', 'landed', { lane: ['security'] }), ...plays(1, 'fleet-claude', 'dropped', { lane: ['docs'] })];
  const leader = pick({ candidates: ['claude', 'codex'], plays: lane, job: { id: 'j', lane: ['security'] }, seed: seedsOf(40).find((candidate) => pick({ candidates: ['claude', 'codex'], plays: lane, job: { id: 'j', lane: ['security'] }, seed: candidate }).order[0] === 'claude') });
  assert.equal(leader.line, 'picked fleet-claude for this security job: landed 2 of 3 since Nov 1, 2 of 2 on jobs like it (fleet-codex new)');

  // ...and left out when every play the builder has is already in the job's lane, because it would say the same twice
  const specialist = [...plays(3, 'fleet-claude', 'landed', { lane: ['security'] }), ...plays(1, 'fleet-claude', 'dropped', { lane: ['security'] }), ...plays(2, 'fleet-codex', 'dropped', { lane: ['security'] })];
  const only = pick({ candidates: ['claude', 'codex', 'cursor'], plays: specialist, job: { id: 'j', lane: ['security'] }, seed: seedsOf(40).find((candidate) => pick({ candidates: ['claude', 'codex', 'cursor'], plays: specialist, job: { id: 'j', lane: ['security'] }, seed: candidate }).order[0] === 'claude') });
  assert.equal(only.line, 'picked fleet-claude for this security job: landed 3 of 4 since Nov 1 (fleet-codex 0 of 2, fleet-cursor new)');

  // when the preferred engine has no room, the next one is used and the line says so
  const crowded = pick({ candidates: ['claude', 'codex'], plays: [...plays(5, 'fleet-claude', 'landed'), ...plays(1, 'fleet-codex', 'dropped')], full: ['claude'] });
  assert.equal(crowded.order[0], 'claude', 'the order is the draw');
  assert.equal(crowded.picked, 'codex', 'the pick is the first engine with room');
  assert.equal(crowded.line, 'picked fleet-codex for this job: landed 0 of 1 since Nov 1 (fleet-claude 5 of 5 but has its share)');
});

test('the line uses the start the caller gives it', () => {
  const moved = pickBuilders({
    candidates: ['claude', 'codex'], job: { id: 'j', lane: [] }, seed: 's',
    since: Date.parse('2026-12-15T00:00:00Z'), plays: [play('fleet-claude', 'landed', { claimed_at: Date.parse('2026-12-16T00:00:00Z') })],
  });
  assert.match(moved.line, /since Dec 15/);
});

// ---------------------------------------------------------------------------
// A job's lane is read the way the protected-lane check reads its tags.

test('lane tokens come from the same places the protected-lane check reads', () => {
  const cases = [
    { title: 'fix it', tag: 'security' },
    { title: 'fix it', tags: ['Billing'] },
    { title: 'fix it', metadata: { tags: ['money'] } },
    { title: 'fix it #deploy' },
    { title: 'fix it', metadata: { todo_tags: [' Customer '] } },
    { title: 'fix it', tag: 'cli' },
    { title: 'fix it' },
    { title: 'fix it', metadata: { todo_tags: [null, ''] } },
  ];
  for (const task of cases) {
    const tokens = laneTokens(task);
    const protectedHere = fleet.protectedLaneOfTask(task);
    assert.equal(tokens.some((token) => fleet.DENIED_TAGS.includes(token)), Boolean(protectedHere), `lane tokens disagree with the protected-lane check for ${JSON.stringify(task)}`);
    if (protectedHere) assert.ok(tokens.includes(protectedHere));
  }
  assert.deepEqual(laneTokens({ title: 'x #docs', tag: 'CLI', tags: ['a'], metadata: { tags: ['b'], todo_tags: [' C '] } }), ['cli', 'a', 'b', 'docs', 'c']);
  assert.deepEqual(laneTokens(null), []);
  assert.deepEqual(laneTokens({ title: 'plain' }), []);
});

// ---------------------------------------------------------------------------
// The rating's own plays, read from a real task store.

test('loadPlays reads the rating\'s own plays and tags each with its job\'s lane', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-pick-root-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = historyStore(t, root);
  // The branch is made in the order it happened, oldest first: the landing from before the start is the oldest commit.
  store.play({ member: 'fleet-claude', outcome: 'landed', at: START - DAY });
  store.play({ member: 'fleet-claude', outcome: 'landed', at: START + HOUR, tag: 'security' });
  store.play({ member: 'fleet-claude', outcome: 'landed', at: START + 2 * HOUR, tag: 'docs' });
  store.play({ member: 'fleet-claude', outcome: 'dropped', at: START + 3 * HOUR, tag: 'security' });
  store.play({ member: 'fleet-claude', outcome: 'held', at: START + 4 * HOUR });
  store.play({ member: 'fleet-claude', outcome: 'could_not_start', at: START + 5 * HOUR });
  store.play({ member: 'fleet-codex', outcome: 'sent_back', at: START + HOUR, title: 'tidy the notes #security' });
  store.play({ member: 'fleet-codex', outcome: 'landed', at: START + 2 * HOUR, metadata: { tags: ['security'] } });

  const found = loadPlays(root, { since: START, now: NOW, dbPath: store.dbPath }).plays;
  assert.ok(found.length >= 6, 'the rating\'s plays come back');
  const result = pickBuilders({ candidates: ['claude', 'codex'], plays: found, since: START, job: { id: 'job-x', lane: ['security'] }, seed: 'x' });
  const claude = result.records.find((record) => record.name === 'claude');
  const codex = result.records.find((record) => record.name === 'codex');
  assert.deepEqual([claude.landed, claude.counted], [2, 3], 'held, unstarted and pre-start plays are not counted');
  assert.deepEqual([claude.laneLanded, claude.laneMissed, claude.otherLanded, claude.otherMissed], [1, 1, 1, 0]);
  assert.deepEqual([codex.landed, codex.counted], [1, 2]);
  assert.deepEqual([codex.laneLanded, codex.laneMissed], [1, 1], 'a hashtag in the title and a tag added later are both lanes');
});

test('the plays-only loader hands back exactly the plays the rating\'s own season holds', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-pick-same-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = historyStore(t, root);
  ['landed', 'dropped', 'sent_back', 'held', 'could_not_start', 'claimed', 'landed'].forEach((outcome, i) => {
    store.play({ member: 'fleet-claude', outcome, at: START + HOUR + i * 60000, tag: 'cli' });
  });
  store.play({ member: 'keshav', outcome: 'landed', at: START + 2 * HOUR });

  const options = { now: NOW, days: 30, dbPath: store.dbPath };
  const season = gmSeason.loadSeason(store.workspace, { ...options, lastSeen: null });
  const only = gmSeason.loadOutcomes(store.workspace, options);
  assert.ok(season.outcomes.length >= 5, 'the rating has plays to compare');
  assert.deepEqual(only.outcomes, season.outcomes, 'same plays, same order, same fields');
  assert.equal(only.error, undefined);
  // Another workspace's plays are not this one's.
  assert.deepEqual(gmSeason.loadOutcomes(path.join(root, 'elsewhere'), options).outcomes, []);
});

test('the plays-only loader says so when there is no store, and when the store cannot be read', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-pick-broken-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(gmSeason.loadOutcomes(root, { now: NOW, dbPath: path.join(root, 'nothing.db') }), { outcomes: [], no_history: true });

  const broken = path.join(root, 'broken.db');
  fs.writeFileSync(broken, 'this is not a database\n');
  const result = gmSeason.loadOutcomes(root, { now: NOW, dbPath: broken });
  assert.deepEqual(result.outcomes, []);
  assert.ok(result.error, 'the reason comes back');
  assert.throws(() => loadPlays(root, { since: START, now: NOW, dbPath: broken }), /./, 'the picker\'s loader refuses to guess from a store it cannot read');
});

test('loadPlays with no task store, or one with no history, is just no plays', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-pick-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(loadPlays(root, { since: START, now: NOW, dbPath: path.join(root, 'nothing.db') }), { plays: [], notes: [], cannot: '' });
});

// ---------------------------------------------------------------------------
// Dealing: the fleet's round-robin, steered.

const POOL = ['claude', 'codex'];
const job = (n, extra = {}) => ({ id: `row-${n}`, display_id: `F-${n}`, status: 'open', title: `edits lib/f${n}.js Done: x. Check: y.`, ...extra });
const turns = (list, pool = POOL) => fleet.assignEngines(list.map((task, slot) => ({ task, surface: [], slot })), pool);
const engines = (entries) => entries.map((entry) => entry.engine);
const steerWith = (history, extra = {}) => startSteering({ root: '/nowhere', env: { ATRIS_PICK_SINCE: '2026-11-01' }, now: NOW, plays: history, ...extra });
// Deal the way a flight does, over the pool the caller names (nothing is read from this computer's engine registry).
const dealOver = (steer, list, pool = POOL) => steer.deal(turns(list, pool), pool, { filter: false });

const CODEX_STRONG = [...plays(6, 'fleet-codex', 'landed'), ...plays(6, 'fleet-claude', 'dropped')];

test('dealing: with results, the strong builder leads and nobody takes more than their share', () => {
  const list = [job(1), job(2), job(3), job(4)];
  const dealt = dealOver(steerWith(CODEX_STRONG), list);
  assert.deepEqual(engines(dealt.entries), ['codex', 'codex', 'claude', 'claude'], 'today it would be claude, codex, claude, codex');
  assert.deepEqual(engines(turns(list)), ['claude', 'codex', 'claude', 'codex']);
  assert.deepEqual(dealt.entries.map((entry) => entry.task.display_id), ['F-1', 'F-2', 'F-3', 'F-4']);
  assert.match(dealt.entries[0].pick, /^picked fleet-codex for this job: landed 6 of 6 since Nov 1 \(fleet-claude 0 of 6\)$/);
  assert.match(dealt.entries[2].pick, /^picked fleet-claude for this job: landed 0 of 6 since Nov 1 \(fleet-codex 6 of 6 but has its share\)$/);
  assert.equal(dealt.picked, 4);
});

test('dealing: a share is ceil(jobs / engines), so one engine never takes every job', () => {
  const list = [job(1), job(2), job(3)];
  const dealt = dealOver(steerWith(CODEX_STRONG), list);
  const load = (name) => engines(dealt.entries).filter((engine) => engine === name).length;
  assert.deepEqual([load('codex'), load('claude')], [2, 1]);
});

test('dealing: with nobody having a result yet, jobs are dealt in turn and the flight says why', () => {
  const list = [job(1), job(2), job(3)];
  const dealt = dealOver(steerWith([]), list);
  assert.deepEqual(engines(dealt.entries), engines(turns(list)));
  assert.ok(dealt.entries.every((entry) => !entry.pick));
  assert.deepEqual(dealt.notes, ['steering on since Nov 1: no results yet, so jobs are dealt in turn']);
  assert.equal(dealt.picked, 0);
});

test('dealing: plays from before the start leave everyone even, so the old order holds', () => {
  const old = [...plays(6, 'fleet-codex', 'landed', { claimed_at: START - DAY }), ...plays(6, 'fleet-claude', 'dropped', { claimed_at: START - DAY })];
  const list = [job(1), job(2)];
  const dealt = dealOver(steerWith(old), list);
  assert.deepEqual(engines(dealt.entries), engines(turns(list)));
});

test('dealing: ATRIS_PICK=turns and --pick turns give exactly today\'s order, with no notes', () => {
  const list = [job(1), job(2), job(3), job(4)];
  const today = turns(list);
  for (const steer of [
    startSteering({ root: '/nowhere', env: { ATRIS_PICK: 'turns', ATRIS_PICK_SINCE: '2026-11-01' }, now: NOW, plays: CODEX_STRONG }),
    startSteering({ root: '/nowhere', pick: 'turns', env: { ATRIS_PICK_SINCE: '2026-11-01' }, now: NOW, plays: CODEX_STRONG }),
  ]) {
    assert.equal(steer.on, false);
    const dealt = steer.deal(today, POOL);
    assert.deepEqual(dealt.entries, today);
    assert.deepEqual(dealt.notes, []);
    assert.deepEqual(dealt.ready, POOL, 'nobody sits out when steering is off');
    assert.equal(dealt.picked, 0);
    assert.equal(steer.next(job(1), ['codex', 'cursor']), null);
  }
});

test('dealing: one engine in the pool means nothing to pick', () => {
  const list = [job(1), job(2)];
  const dealt = dealOver(steerWith(CODEX_STRONG), list, ['claude']);
  assert.deepEqual(engines(dealt.entries), ['claude', 'claude']);
  assert.ok(dealt.entries.every((entry) => !entry.pick));
  assert.deepEqual(dealt.notes, []);
});

test('a retry takes the best candidate for the job, in the job\'s own order', () => {
  const history = [...plays(20, 'fleet-claude', 'landed'), ...plays(2, 'fleet-cursor', 'landed'), ...plays(2, 'fleet-cursor', 'dropped'), ...plays(12, 'fleet-codex', 'dropped')];
  const steer = steerWith(history);
  const next = steer.next(job(1), ['codex', 'cursor']);
  assert.equal(next.engine, 'cursor', 'the proven candidate, not the first one listed');
  assert.match(next.pick, /^picked fleet-cursor for this job: landed 2 of 4 since Nov 1 \(fleet-codex 0 of 12\)$/);
  assert.equal(steerWith([]).next(job(1), ['codex', 'cursor']), null, 'no results yet: today\'s retry rule');

  // A longer list is ordered the same way, and the same job on the same day always gets the same answer.
  const wider = steer.next(job(1), ['codex', 'cursor', 'claude']);
  assert.equal(wider.engine, 'claude', 'the strongest record among the candidates');
  assert.deepEqual(steer.next(job(1), ['codex', 'cursor', 'claude']), wider);
  assert.equal(steer.next(job(1), []), null, 'nobody to pick from');
  assert.equal(steer.next(job(1), ['cursor']).engine, 'cursor', 'one candidate is the pick, with its line');
});

// ---------------------------------------------------------------------------
// A landing counts only when it belongs to its job: its commit is on origin's default branch, is no older than the
// claim it lands (five minutes of clock skew allowed), and no other job recorded it first.

const MADE_UP = 'deadbeef'.repeat(5); // forty hex digits that name no commit
const FIX = 'git remote set-head origin --auto';

// A scratch project folder that is a small git repository with a real origin, and a task store of its own.
function storeIn(t, options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-pick-land-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, store: historyStore(t, root, options) };
}
const loadFrom = (root, store) => loadPlays(root, { since: START, now: NOW, dbPath: store.dbPath });
const recordOf = (found, name = 'claude', lane = []) => pickBuilders({ candidates: [name], plays: found, since: START, job: { id: 'job-x', lane }, seed: 'x' }).records[0];
const shape = (r) => [r.laneLanded, r.laneMissed, r.otherLanded, r.otherMissed];
const landedOf = (found, name = 'claude') => [recordOf(found, name).landed, recordOf(found, name).counted];
const landed = (extra) => ({ member: 'fleet-claude', outcome: 'landed', ...extra });

// Set variables for one test and put them back after it.
function setEnv(t, vars) {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}

test('a landing counts only when its commit is on the default branch, and a miss always counts', (t) => {
  const { root, store } = storeIn(t);
  const side = store.side(START + 3 * HOUR);
  store.play(landed({ at: START + HOUR }));                       // a new commit on the default branch (on origin, not fetched yet)
  store.play(landed({ at: START + 2 * HOUR, commit: MADE_UP }));  // a commit that does not exist
  store.play(landed({ at: START + 3 * HOUR, commit: side }));     // a real commit that sits on a side branch only
  store.play(landed({ at: START + 4 * HOUR, commit: null }));     // accepted with no commit recorded
  store.play({ member: 'fleet-claude', outcome: 'dropped', at: START + 5 * HOUR });

  const got = loadFrom(root, store);
  assert.deepEqual(got.notes, [], 'the check could run, so there is nothing to say');
  assert.equal(got.cannot, '');
  assert.equal(got.plays.length, 2);
  assert.deepEqual(landedOf(got.plays), [1, 2], 'one checked landing and the miss');
  // The rating itself is not changed by any of this: it still counts all four landings.
  const rating = gmSeason.loadOutcomes(store.workspace, { now: NOW, days: 30, dbPath: store.dbPath });
  assert.equal(rating.outcomes.filter((one) => one.kind === 'landed').length, 4);
});

test('a merged pull request counts through its merge commit, wherever the record keeps it', (t) => {
  const { root, store } = storeIn(t);
  const first = store.merged(START + HOUR + 10 * MINUTE);
  const second = store.merged(START + 2 * HOUR + 10 * MINUTE);
  const third = store.merged(START + 3 * HOUR + 10 * MINUTE);
  store.play(landed({ at: START + HOUR, commit: first.merge }));                              // in the landing and the pull request
  store.play(landed({ at: START + 2 * HOUR, commit: second.merge, where: 'pull_request' }));  // in the pull request only
  store.play(landed({ at: START + 3 * HOUR, commit: third.branchCommit }));                   // the branch's own commit, behind the merge
  const got = loadFrom(root, store);
  assert.deepEqual(got.notes, []);
  assert.deepEqual(landedOf(got.plays), [3, 3]);
});

test('work already on the branch before the claim is not what the claim landed', (t) => {
  const { root, store } = storeIn(t);
  store.play(landed({ at: START + HOUR, commit: store.main }));   // October's commit, on the branch long before this claim
  store.play(landed({ at: START + 2 * HOUR }));                    // a commit made after its claim
  const got = loadFrom(root, store);
  assert.deepEqual(landedOf(got.plays), [1, 1], 'the old commit is a landing nobody can vouch for');
});

test('a commit made up to five minutes before its claim still counts, and one more second does not', (t) => {
  const { root, store } = storeIn(t);
  const a = START + 5 * HOUR;
  const b = START + 7 * HOUR;
  store.play(landed({ at: a, commit: store.land(a - 5 * MINUTE) }));
  store.play(landed({ at: b, commit: store.land(b - 5 * MINUTE - 1000) }));
  const got = loadFrom(root, store);
  assert.deepEqual(landedOf(got.plays), [1, 1], 'the first is on the edge of the skew, the second is a second past it');
  assert.deepEqual(got.plays.filter((one) => one.kind === 'landed').map((one) => one.claimed_at), [a]);
});

test('one commit lands one job: the first job to record it keeps it, and the later job\'s landing does not count', (t) => {
  const { root, store } = storeIn(t);
  const shared = store.land(START + HOUR + MINUTE);
  store.play(landed({ member: 'fleet-claude', at: START + HOUR, commit: shared }));
  store.play(landed({ member: 'fleet-codex', at: START + HOUR + 2 * MINUTE, commit: shared }));
  const got = loadFrom(root, store);
  assert.deepEqual(landedOf(got.plays, 'claude'), [1, 1], 'claude recorded it first');
  assert.deepEqual(landedOf(got.plays, 'codex'), [0, 0], 'codex named the same commit later');
});

test('first to record is first by the record, not by the claim', (t) => {
  const { root, store } = storeIn(t);
  const shared = store.land(START + HOUR + MINUTE);
  const early = store.play(landed({ member: 'fleet-claude', at: START + HOUR, commit: shared }));
  const late = store.play(landed({ member: 'fleet-codex', at: START + HOUR + 2 * MINUTE, commit: shared }));
  // The job that claimed first records last.
  const stamp = store.db.prepare("UPDATE task_events SET created_at = ? WHERE task_id = ? AND event_type = 'proof_ready'");
  stamp.run(START + 4 * HOUR, early);
  stamp.run(START + 3 * HOUR, late);
  const got = loadFrom(root, store);
  assert.deepEqual(landedOf(got.plays, 'claude'), [0, 0]);
  assert.deepEqual(landedOf(got.plays, 'codex'), [1, 1]);
});

test('a commit that anyone else recorded first is theirs: a person\'s job counts as a recorder too', (t) => {
  const { root, store } = storeIn(t);
  const shared = store.land(START + HOUR + MINUTE);
  store.play(landed({ member: 'keshav', at: START + HOUR, commit: shared }));
  store.play(landed({ member: 'fleet-codex', at: START + HOUR + 2 * MINUTE, commit: shared }));
  const got = loadFrom(root, store);
  assert.deepEqual(landedOf(got.plays, 'codex'), [0, 0]);
});

test('a short spelling is the same commit, and a second record of it by the same job takes nothing away', (t) => {
  const { root, store } = storeIn(t);
  const made = store.land(START + HOUR + MINUTE);
  const id = store.play(landed({ at: START + HOUR, commit: made.slice(0, 12) }));
  // The same job records the same commit again, in full, later. The rating counts one landing per claim.
  store.db.prepare('INSERT INTO task_events (event_id, task_id, version, workspace_root, actor, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('again-1', id, 99, store.workspace, 'autoland', 'proof_ready', JSON.stringify({ landing: { merge_commit: made } }), START + 3 * HOUR);
  const got = loadFrom(root, store);
  assert.deepEqual(landedOf(got.plays), [1, 1], 'the first record names the commit by twelve digits, and git knows which commit that is');
});

test('one commit under two spellings is one commit across jobs: whoever recorded it first keeps it, in the short spelling or the full one', (t) => {
  const { root, store } = storeIn(t);
  const a = store.land(START + HOUR + MINUTE);
  const b = store.land(START + 2 * HOUR + MINUTE);
  const c = store.land(START + 3 * HOUR + MINUTE);
  // A person records A by twelve digits, and claude records it in full five minutes later.
  store.play({ member: 'keshav', outcome: 'landed', at: START + HOUR, commit: a.slice(0, 12) });
  store.play(landed({ member: 'fleet-claude', at: START + HOUR + 5 * MINUTE, commit: a }));
  // A job in another workspace records B in full, and codex records it by nine digits five minutes later.
  store.play({ member: 'someone', outcome: 'landed', at: START + 2 * HOUR, commit: b, workspace: '/elsewhere/other-project' });
  store.play(landed({ member: 'fleet-codex', at: START + 2 * HOUR + 5 * MINUTE, commit: b.slice(0, 9) }));
  // A control: claude records C first, and a person records it by twelve digits later, so claude keeps it.
  store.play(landed({ member: 'fleet-claude', at: START + 3 * HOUR, commit: c }));
  store.play({ member: 'keshav', outcome: 'landed', at: START + 3 * HOUR + 5 * MINUTE, commit: c.slice(0, 12) });
  const got = loadFrom(root, store);
  assert.deepEqual(landedOf(got.plays, 'claude'), [1, 1], 'A was the person\'s first; C is claude\'s');
  assert.deepEqual(landedOf(got.plays, 'codex'), [0, 0], 'B was recorded first, in full, in another workspace');
});

test('a recent commit nobody recorded as a landing can still be claimed by a job that did not make it: accepted, and pinned here', (t) => {
  const { root, store } = storeIn(t);
  const someoneElses = store.land(START + HOUR + MINUTE);   // pushed by a person, never recorded by any job
  store.play(landed({ at: START + HOUR, commit: someoneElses }));
  const got = loadFrom(root, store);
  assert.deepEqual(landedOf(got.plays), [1, 1]);
});

// ---------------------------------------------------------------------------
// "First to record" is read from every landing record in the whole store: every workspace that shares it, and every
// later review pass of a job. The rating keeps one landing per claim, so its plays are not enough.

test('a commit a job recorded in a later review pass is that job\'s: another job that names it afterwards does not keep it', (t) => {
  const { root, store } = storeIn(t);
  const a = store.land(START + HOUR + MINUTE);
  const b = store.land(START + 2 * HOUR + MINUTE);
  // codex's job records commit A, and in a later review pass commit B. The rating keeps only its first record.
  const codexJob = store.play(landed({ member: 'fleet-codex', at: START + HOUR, commit: a }));
  store.record(codexJob, { commit: b, at: START + 2 * HOUR + 30 * MINUTE });
  // claude's job names B, and records it half an hour after codex's review pass did.
  store.play(landed({ member: 'fleet-claude', at: START + 2 * HOUR, commit: b }));
  const got = loadFrom(root, store);
  assert.deepEqual(landedOf(got.plays, 'codex'), [1, 1], 'its first record, commit A, is its own');
  assert.deepEqual(landedOf(got.plays, 'claude'), [0, 0], 'commit B was recorded by codex\'s job first');
  const rating = gmSeason.loadOutcomes(store.workspace, { now: NOW, days: 30, dbPath: store.dbPath });
  assert.equal(rating.outcomes.filter((one) => one.kind === 'landed' && one.task_id === codexJob).length, 1, 'the rating keeps one landing for that job: the record this has to look past');
});

test('a control: a job that recorded a commit first keeps it against a later review pass of another job', (t) => {
  const { root, store } = storeIn(t);
  const a = store.land(START + HOUR + MINUTE);
  const b = store.land(START + 2 * HOUR + MINUTE);
  store.play(landed({ member: 'fleet-claude', at: START + 2 * HOUR, commit: b }));                          // records B at START + 3h
  const codexJob = store.play(landed({ member: 'fleet-codex', at: START + HOUR, commit: a }));             // records A at START + 2h
  store.record(codexJob, { commit: b, at: START + 4 * HOUR });                                               // and B, later than claude did
  const got = loadFrom(root, store);
  assert.deepEqual(landedOf(got.plays, 'claude'), [1, 1]);
  assert.deepEqual(landedOf(got.plays, 'codex'), [1, 1], 'codex keeps commit A, so its landing stands; B was never its to claim');
});

test('a record in another workspace of the same store is a first record too', (t) => {
  const { root, store } = storeIn(t);
  const shared = store.land(START + HOUR + MINUTE);
  store.play({ member: 'someone', outcome: 'landed', at: START + 30 * MINUTE, commit: shared, workspace: '/elsewhere/other-project' });
  store.play(landed({ at: START + HOUR, commit: shared }));       // records the same commit half an hour later, in this workspace
  store.play(landed({ at: START + 3 * HOUR }));                   // a commit nobody else recorded
  const got = loadFrom(root, store);
  assert.deepEqual(landedOf(got.plays), [1, 1], 'only the commit nobody else recorded counts');
});

test('records made at one moment are told apart by insertion order, not by event id', (t) => {
  const { root, store } = storeIn(t);
  const shared = store.land(START + HOUR + MINUTE);
  const first = store.play(landed({ member: 'fleet-claude', at: START + HOUR, commit: shared }));
  const second = store.play(landed({ member: 'fleet-codex', at: START + HOUR + MINUTE, commit: shared }));
  // Both are recorded at one moment. The ids are chosen so that the record inserted first has the id that sorts last.
  const stamp = store.db.prepare("UPDATE task_events SET created_at = ?, event_id = ? WHERE task_id = ? AND event_type = 'proof_ready'");
  stamp.run(START + 3 * HOUR, 'zzzz-inserted-first', first);
  stamp.run(START + 3 * HOUR, 'aaaa-inserted-second', second);
  const row = (id) => store.db.prepare("SELECT rowid AS n, event_id FROM task_events WHERE task_id = ? AND event_type = 'proof_ready'").get(id);
  assert.ok(row(first).n < row(second).n && row(first).event_id > row(second).event_id, 'the first was inserted first, and its id sorts last');
  const got = loadFrom(root, store);
  assert.deepEqual(landedOf(got.plays, 'claude'), [1, 1], 'inserted first, so it keeps the commit');
  assert.deepEqual(landedOf(got.plays, 'codex'), [0, 0]);

  // And the other way: the one inserted second has the earlier time, so it keeps it.
  store.db.prepare("UPDATE task_events SET created_at = ? WHERE event_id = 'aaaa-inserted-second'").run(START + 2 * HOUR);
  const again = loadFrom(root, store);
  assert.deepEqual(landedOf(again.plays, 'claude'), [0, 0]);
  assert.deepEqual(landedOf(again.plays, 'codex'), [1, 1]);
});

// A commit counts once, for the first claim that recorded it. The record belongs to the claim it was made under, not to
// the job: a job that is reopened and claimed again is a new attempt, and the commit the first attempt recorded is not
// something the new one can land again, even inside the five minutes the age check allows.

test('a commit counts once, for the first claim that recorded it: a job reopened and claimed by another engine cannot land it again', (t) => {
  const { root, store } = storeIn(t);
  const made = START + HOUR + 10 * MINUTE;
  const shared = store.land(made);
  // claude claims the job, merges the commit and records it. The job is reopened, and two minutes after the commit was
  // made codex claims it and hands in the very same commit: well inside the five minutes the age check allows.
  const job = store.play(landed({ member: 'fleet-claude', at: START + HOUR, commit: shared, took: 12 * MINUTE }));
  store.play(landed({ member: 'fleet-codex', at: made + 2 * MINUTE, commit: shared, job, reopen: true, took: 5 * MINUTE }));

  const rating = gmSeason.loadOutcomes(store.workspace, { now: NOW, days: 30, dbPath: store.dbPath });
  assert.deepEqual(rating.outcomes.filter((one) => one.kind === 'landed').map((one) => one.member).sort(), ['fleet-claude', 'fleet-codex'], 'the rating counts both attempts: the picker has to look past that');
  const got = loadFrom(root, store);
  assert.deepEqual(landedOf(got.plays, 'claude'), [1, 1], 'the first claim recorded it');
  assert.deepEqual(landedOf(got.plays, 'codex'), [0, 0], 'a later claim on the same job does not get it again');
});

test('a commit counts once, for the first claim that recorded it: the same engine claiming the job again gets nothing more', (t) => {
  const { root, store } = storeIn(t);
  const made = START + HOUR + 10 * MINUTE;
  const shared = store.land(made);
  const job = store.play(landed({ member: 'fleet-claude', at: START + HOUR, commit: shared, took: 12 * MINUTE }));
  store.play(landed({ member: 'fleet-claude', at: made + 2 * MINUTE, commit: shared, job, reopen: true, took: 5 * MINUTE }));
  const got = loadFrom(root, store);
  assert.deepEqual(landedOf(got.plays, 'claude'), [1, 1], 'one commit is one landing, however many times the job is claimed');
});

test('a commit counts once, for the first claim that recorded it: the attempt that came first keeps it when a later attempt of the same job records it too, in any spelling', (t) => {
  const { root, store } = storeIn(t);
  const made = START + HOUR + 10 * MINUTE;
  const shared = store.land(made);
  const job = store.play(landed({ member: 'fleet-codex', at: START + HOUR, commit: shared.slice(0, 12), took: 12 * MINUTE }));
  store.play(landed({ member: 'fleet-claude', at: made + MINUTE, commit: shared, job, reopen: true, took: 5 * MINUTE }));
  store.play(landed({ member: 'fleet-cursor', at: made + 3 * MINUTE, commit: shared.slice(0, 9), job, reopen: true, took: 5 * MINUTE }));
  const got = loadFrom(root, store);
  assert.deepEqual(landedOf(got.plays, 'codex'), [1, 1]);
  assert.deepEqual(landedOf(got.plays, 'claude'), [0, 0]);
  assert.deepEqual(landedOf(got.plays, 'cursor'), [0, 0]);
});

test('a control: a job claimed again counts for the new commit its new claim lands, and keeps the old one for the first claim', (t) => {
  const { root, store } = storeIn(t);
  const first = store.land(START + HOUR + 10 * MINUTE);
  const second = store.land(START + 2 * HOUR + 10 * MINUTE);
  const job = store.play(landed({ member: 'fleet-claude', at: START + HOUR, commit: first, took: 12 * MINUTE }));
  store.play(landed({ member: 'fleet-codex', at: START + 2 * HOUR, commit: second, job, reopen: true, took: 12 * MINUTE }));
  const got = loadFrom(root, store);
  assert.deepEqual(landedOf(got.plays, 'claude'), [1, 1]);
  assert.deepEqual(landedOf(got.plays, 'codex'), [1, 1], 'a different commit is a different landing');
});

test('a commit counts once, for the first claim that recorded it: a job claimed again does not take it from a person\'s job either, and a person\'s first record before any claim is that attempt\'s', (t) => {
  const { root, store } = storeIn(t);
  const made = START + HOUR + 10 * MINUTE;
  const shared = store.land(made);
  // A person's job records the commit with no claim in its history; the same job is then opened and claimed by claude
  // inside the age allowance and hands in the same commit.
  const job = store.play({ member: 'keshav', outcome: 'landed', at: START + HOUR, commit: shared, took: 12 * MINUTE });
  store.play(landed({ member: 'fleet-claude', at: made + 2 * MINUTE, commit: shared, job, reopen: true, took: 5 * MINUTE }));
  const got = loadFrom(root, store);
  assert.deepEqual(landedOf(got.plays, 'claude'), [0, 0]);
});

const FETCH_MAIN = 'fetch origin +refs/heads/main:refs/remotes/origin/main';

test('origin is fetched once, with an explicit refspec for its default branch only, before the landings are read; the commits come in two calls', (t) => {
  const { root, store } = storeIn(t);
  store.plays(4, landed({ at: START + HOUR }));    // four commits that exist on origin and nowhere else yet
  const watch = watchGit(t);
  watch.clear();
  const got = loadFrom(root, store);
  assert.deepEqual(landedOf(got.plays), [4, 4], 'what a minute-old merge needs: the fetch found them');
  assert.deepEqual(watch.startingWith('fetch'), [FETCH_MAIN], 'the ref that is checked is the ref that was fetched');
  assert.equal(watch.startingWith('rev-list').length, 2, `one call for the commits asked about and one listing the branch: ${watch.calls().join(' | ')}`);
  assert.deepEqual(watch.startingWith('merge-base'), [], 'no process is started for any one landing');
});

test('git is asked the same questions in the same order however many landings there are', (t) => {
  const { root, store } = storeIn(t);
  store.plays(2, landed({ at: START + HOUR }));
  const watch = watchGit(t);
  watch.clear();
  assert.deepEqual(landedOf(loadFrom(root, store).plays), [2, 2]);
  const few = watch.calls();
  store.plays(25, landed({ at: START + 2 * HOUR }));
  watch.clear();
  assert.deepEqual(landedOf(loadFrom(root, store).plays), [27, 27]);
  assert.deepEqual(watch.calls(), few, 'the same calls with 27 landings as with 2');
  assert.ok(few.length <= 8, `a fixed few: ${few.join(' | ')}`);
});

test('git never prompts a person: standard input is closed, the terminal prompt is off, and ssh runs in batch mode', (t) => {
  const { root, store } = storeIn(t);
  store.plays(2, landed({ at: START + HOUR }));
  const watch = watchGit(t);
  watch.clear();
  assert.deepEqual(landedOf(loadFrom(root, store).plays), [2, 2]);
  const seen = watch.environments();
  assert.ok(seen.length >= 5, 'every question git was asked is here');
  assert.ok(seen.every((one) => one.prompt === '0'), `GIT_TERMINAL_PROMPT is 0 for every question: ${JSON.stringify(seen)}`);
  assert.ok(seen.every((one) => one.terminal === false), 'standard input is never a terminal, so git cannot ask a person anything');
  const fetch = seen.filter((one) => one.line.startsWith('fetch '));
  assert.equal(fetch.length, 1);
  assert.match(fetch[0].ssh, /(^| )-o BatchMode=yes( |$)/, 'ssh cannot wait for a password or a host-key answer');
  assert.deepEqual(seen.filter((one) => !one.line.startsWith('fetch ') && one.ssh !== 'unset'), [], 'only the fetch can reach for ssh');
});

test('a person\'s own ssh command is left alone, and the flight says so in one line', (t) => {
  const { root, store } = storeIn(t);
  store.plays(3, landed({ at: START + HOUR }));
  setEnv(t, { GIT_SSH_COMMAND: 'ssh -i /keys/mine' });
  const watch = watchGit(t);
  watch.clear();
  const steer = startSteering({ root, env: ENV, now: NOW });
  const dealt = dealOver(steer, [job(1), job(2)]);
  const fetch = watch.environments().filter((one) => one.line.startsWith('fetch '));
  assert.equal(fetch.length, 1);
  assert.equal(fetch[0].ssh, 'ssh -i /keys/mine', 'their command, not ours');
  assert.equal(fetch[0].prompt, '0', 'and git still never prompts');
  assert.deepEqual(dealt.notes, ['steering on since Nov 1: your own ssh command (GIT_SSH_COMMAND) was left as it is, so ssh may stop to ask for a password; the fetch gives up after five seconds either way']);
  assert.equal(dealt.picked, 2, 'the landings were checked and steered on');
});

test('nothing is fetched when there is no landing to look at, and nothing is asked of git when there are no plays', (t) => {
  const { root, store } = storeIn(t);
  const watch = watchGit(t);
  watch.clear();
  assert.deepEqual(loadFrom(root, store).plays, []);
  assert.deepEqual(watch.calls(), [], 'no plays, no questions');
  store.plays(3, { member: 'fleet-claude', outcome: 'dropped', at: START + HOUR });
  watch.clear();
  const got = loadFrom(root, store);
  assert.equal(got.plays.length, 3, 'misses count');
  assert.deepEqual(watch.startingWith('fetch'), [], 'a miss needs no commit, so there is nothing to fetch for');
});

test('with no origin branch to check against, nothing can be counted and the reason comes back', (t) => {
  const { root, store } = storeIn(t, { origin: false });
  store.plays(3, landed({ at: START + HOUR }));
  store.plays(2, { member: 'fleet-claude', outcome: 'sent_back', at: START + 2 * HOUR });
  const got = loadFrom(root, store);
  assert.deepEqual(got.plays, [], 'the misses do not steer by themselves: the folder cannot say what landed');
  assert.equal(got.cannot, 'no origin branch');
});

test('with only misses in a folder that has no origin, the folder still cannot be checked', (t) => {
  const { root, store } = storeIn(t, { origin: false });
  store.plays(5, { member: 'fleet-claude', outcome: 'dropped', at: START + HOUR });
  const got = loadFrom(root, store);
  assert.deepEqual(got.plays, []);
  assert.equal(got.cannot, 'no origin branch');
});

test('with no git repository in the folder, nothing can be counted and the reason comes back', (t) => {
  const { root, store } = storeIn(t, { git: false });
  store.plays(3, landed({ at: START + HOUR, commit: MADE_UP }));
  store.play({ member: 'fleet-claude', outcome: 'dropped', at: START + 2 * HOUR });
  const got = loadFrom(root, store);
  assert.deepEqual(got.plays, []);
  assert.equal(got.cannot, 'this folder is not a git repository');
});

test('with git missing from this computer, nothing can be counted and the reason says so', (t) => {
  const { root, store } = storeIn(t);
  store.plays(3, landed({ at: START + HOUR }));
  const nothingHere = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-pick-nopath-'));
  t.after(() => fs.rmSync(nothingHere, { recursive: true, force: true }));
  setEnv(t, { PATH: nothingHere });
  const got = loadFrom(root, store);
  assert.deepEqual(got.plays, []);
  assert.equal(got.cannot, 'git is not installed here');
});

test('the default branch is origin/HEAD and nothing else: with it missing, origin/main is not guessed, and the reason names the fix', (t) => {
  const { root, store } = storeIn(t);
  store.plays(3, landed({ at: START + HOUR }));
  store.dropOriginHead();
  const got = loadFrom(root, store);
  assert.deepEqual(got.plays, []);
  assert.ok(got.cannot.includes(FIX), got.cannot);
  assert.match(got.cannot, /default branch/);
});

test('an origin/HEAD that points at a branch that is not here is the same case, and names the fix too', (t) => {
  const { root, store } = storeIn(t);
  store.plays(3, landed({ at: START + HOUR }));
  store.dangleOriginHead();
  const got = loadFrom(root, store);
  assert.deepEqual(got.plays, []);
  assert.match(got.cannot, /origin\/gone/);
  assert.ok(got.cannot.includes(FIX), got.cannot);
});

test('when origin cannot be fetched, nothing can be counted and the reason says so', (t) => {
  const { root, store } = storeIn(t);
  store.plays(3, landed({ at: START + HOUR }));
  store.breakRemote();
  const got = loadFrom(root, store);
  assert.deepEqual(got.plays, []);
  assert.match(got.cannot, /^could not fetch origin/);
});

test('a stand-in for the landing check is given the claim time, the commits and the owner test of each landing, and is asked again once all are judged', (t) => {
  const { root, store } = storeIn(t);
  store.play(landed({ at: START + HOUR }));
  const calls = [];
  let judged = false;
  const landing = {
    cannotCheck: () => (judged ? 'git did not answer in time' : ''),
    refresh: () => '',
    read: () => new Map(),
    landed: (commits, options) => { judged = true; calls.push({ commits, claimedAt: options.claimedAt, owns: typeof options.owns }); return true; },
  };
  const got = loadPlays(root, { since: START, now: NOW, dbPath: store.dbPath, landing });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].claimedAt, START + HOUR);
  assert.equal(calls[0].owns, 'function');
  assert.equal(calls[0].commits.length, 1);
  assert.deepEqual(got, { plays: [], notes: [], cannot: 'git did not answer in time' }, 'a check that stalled partway leaves the history half judged, so nothing counts and jobs are dealt in turn');
});

test('what the landing check did that a person should hear about comes back as notes, and a stand-in that has none is fine', (t) => {
  const { root, store } = storeIn(t);
  store.play(landed({ at: START + HOUR }));
  const landing = (extra) => ({ cannotCheck: () => '', refresh: () => '', read: () => new Map(), landed: () => true, ...extra });
  const said = loadPlays(root, { since: START, now: NOW, dbPath: store.dbPath, landing: landing({ notes: () => ['something to hear'] }) });
  assert.deepEqual(said.notes, ['something to hear']);
  assert.equal(said.plays.length, 1);
  assert.deepEqual(loadPlays(root, { since: START, now: NOW, dbPath: store.dbPath, landing: landing() }).notes, []);
  const failed = loadPlays(root, { since: START, now: NOW, dbPath: store.dbPath, landing: landing({ refresh: () => 'could not fetch origin in time', notes: () => ['something to hear'] }) });
  assert.deepEqual(failed, { plays: [], notes: ['something to hear'], cannot: 'could not fetch origin in time' }, 'a failure still says what was left alone');
});

// ---------------------------------------------------------------------------
// A landing pays the engine that finished it. A flight claims a job for the engine it dealt it to; when that engine
// dies and another finishes the retry, the hand-in is made under the finisher's name (handed_in_by, with the others
// that ran in built_with). The claim holder is whom the rating credits, and the rating's display stays as it is.

const handedInBy = (handIn, extra = {}) => landed({ member: 'fleet-claude', at: START + HOUR, handIn, ...extra });
const creditOf = (found) => ['claude', 'codex', 'cursor'].map((name) => landedOf(found, name));

test('a rescued landing pays the engine that finished it, and the engine that died gets nothing for it', (t) => {
  const { root, store } = storeIn(t);
  store.play(handedInBy({ by: 'fleet-cursor' }));     // claimed for claude, finished by cursor
  const got = loadFrom(root, store);
  assert.deepEqual(creditOf(got.plays), [[0, 0], [0, 0], [1, 1]]);
  const rating = gmSeason.loadOutcomes(store.workspace, { now: NOW, days: 30, dbPath: store.dbPath });
  assert.deepEqual(rating.outcomes.filter((one) => one.kind === 'landed').map((one) => one.member), ['fleet-claude'], 'the rating\'s own display still credits the claim holder');
});

test('the engine that finished is the one that handed the work in, however many engines ran and however the hand-in and the merge were made', (t) => {
  const { root, store } = storeIn(t);
  store.play(handedInBy({ by: 'fleet-cursor', builtWith: ['fleet-codex'] }));      // three engines ran; cursor finished
  store.play(handedInBy({ by: 'fleet-codex', separate: true }, { at: START + 2 * HOUR }));   // handed in with a pull request left open, merged by a person later
  store.play(handedInBy({ by: 'fleet-claude', builtWith: ['fleet-codex'] }, { at: START + 3 * HOUR }));   // claude finished its own job after codex's attempt
  const got = loadFrom(root, store);
  assert.deepEqual(creditOf(got.plays), [[1, 1], [1, 1], [1, 1]], 'cursor, codex and claude each finished one');
});

test('a hand-in that does not say who finished and names more than one engine counts for nobody\'s steering', (t) => {
  const { root, store } = storeIn(t);
  store.play(handedInBy({ builtWith: ['fleet-codex'] }));                                      // claude claimed; codex built with it; nobody says who finished
  store.play(handedInBy({ builtWith: ['fleet-codex', 'fleet-cursor'] }, { at: START + 2 * HOUR }));
  store.play(handedInBy({ by: 'keshav', builtWith: ['fleet-codex'] }, { at: START + 3 * HOUR }));   // a person handed it in
  store.play(handedInBy({}, { at: START + 4 * HOUR, member: 'fleet-claude' }));                     // a control: no names at all, so the claim holder
  const got = loadFrom(root, store);
  assert.deepEqual(creditOf(got.plays), [[1, 1], [0, 0], [0, 0]], 'only the control counts, for the engine that claimed it');
});

test('a landing whose hand-in names no engine but the one that claimed it stays with that engine', (t) => {
  const { root, store } = storeIn(t);
  store.play(handedInBy(null));                                                          // no names (the way the rating's own tests record a landing)
  store.play(handedInBy({ by: 'fleet-claude' }, { at: START + 2 * HOUR }));              // it finished its own job
  store.play(handedInBy({ by: 'keshav' }, { at: START + 3 * HOUR }));                    // a person handed in its work
  store.play(handedInBy({ by: 'keshav', builtWith: ['fleet-claude'] }, { at: START + 4 * HOUR }));
  store.play(handedInBy({ builtWith: ['keshav', 7, ''] }, { at: START + 5 * HOUR }));    // names that are not engines
  const got = loadFrom(root, store);
  assert.deepEqual(creditOf(got.plays), [[5, 5], [0, 0], [0, 0]]);
});

test('only the hand-ins of the claim that landed count: an earlier claim\'s hand-in on the same job names nobody for this one', (t) => {
  const { root, store } = storeIn(t);
  // The first claim (claude) was handed in by codex with a pull request left open, and a person merged it.
  const id = store.play(handedInBy({ by: 'fleet-codex', separate: true }));
  // The job is claimed again, by claude, and that claim lands with a hand-in that names no one.
  const second = tasks.claimTask(store.db, { id, claimedBy: 'fleet-claude' });
  store.db.prepare('UPDATE task_events SET created_at = ? WHERE event_id = ?').run(START + 5 * HOUR, second.event.event_id);
  store.record(id, { commit: store.land(START + 5 * HOUR + MINUTE), at: START + 6 * HOUR });
  const got = loadFrom(root, store);
  assert.deepEqual(got.plays.map((one) => [one.member, one.claimed_at]).sort(), [['fleet-claude', START + 5 * HOUR], ['fleet-codex', START + HOUR]], 'each landing is paid to the engine its own claim\'s hand-in names');
  assert.deepEqual(creditOf(got.plays), [[1, 1], [1, 1], [0, 0]]);
});

// ---------------------------------------------------------------------------
// A play's lane is the lane its job was in at the claim, saved on the claim itself.

test('a claim saves the job\'s title and tags as they are at that moment, and nothing done to the job later changes them', (t) => {
  const { store } = storeIn(t);
  const id = store.play({
    member: 'fleet-claude', outcome: 'dropped', at: START + HOUR, tag: 'cli', title: 'tidy the notes #docs',
    metadata: { tags: ['Billing'], todo_tags: ['Customer'], verify: 'node --test test/x.test.js' },
  });
  const saved = () => store.db.prepare("SELECT payload FROM task_events WHERE task_id = ? AND event_type = 'claimed'").all(id).map((row) => JSON.parse(row.payload));
  const want = { title: 'tidy the notes #docs', tag: 'cli', tags: ['Billing'], todo_tags: ['Customer'] };
  assert.equal(saved().length, 1);
  assert.deepEqual(saved()[0].job_at_claim, want);
  assert.equal(saved()[0].claimed_by, 'fleet-claude', 'what the claim always said is still there');
  store.tag(id, { add: ['security'] });
  store.retitle(id, 'something else');
  store.backlog(id, 'capture');
  assert.deepEqual(saved()[0].job_at_claim, want, 'tagging, renaming and moving the job afterwards leave the claim as it was');
});

test('a claim that does not go through saves nothing', (t) => {
  const { store } = storeIn(t);
  const id = store.play({ member: 'fleet-claude', outcome: 'claimed', at: START + HOUR });
  const events = () => store.db.prepare("SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND event_type = 'claimed'").get(id).n;
  assert.equal(events(), 1);
  const second = tasks.claimTask(store.db, { id, claimedBy: 'fleet-codex' });
  assert.equal(second.claimed, false);
  assert.equal(events(), 1, 'the claim that lost wrote no history entry');
});

// A claim can ask a question of the job it is about to take, inside its own transaction (refuseIf). The flight uses it
// to ask whether the member and engine its pick went on are still what the job says.
test('a claim can be refused by a check made on the job inside the claim itself: nothing is written, and the job stays open', (t) => {
  const { store } = storeIn(t);
  const make = (metadata) => tasks.addTask(store.db, { title: 'tidy the notes', workspaceRoot: store.workspace, metadata }).id;
  const id = make({ assigned_to: 'closer' });
  const everything = () => JSON.stringify([
    store.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id),
    store.db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY version').all(id),
  ]);
  const before = everything();

  const seen = [];
  const refused = tasks.claimTask(store.db, { id, claimedBy: 'fleet-claude', refuseIf: (job) => { seen.push(job); return 'not today'; } });
  assert.deepEqual(refused, { claimed: false, reason: 'not today' });
  assert.equal(everything(), before, 'no claim, no history entry, no change of any kind');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].id, id);
  assert.equal(seen[0].status, 'open');
  assert.equal(seen[0].metadata.assigned_to, 'closer', 'asked with the job as the store holds it, its metadata read');

  // An empty answer lets the claim go on, exactly as a claim without the check does.
  const allowed = tasks.claimTask(store.db, { id, claimedBy: 'fleet-claude', refuseIf: () => '' });
  assert.equal(allowed.claimed, true);
  assert.equal(allowed.row.claimed_by, 'fleet-claude');
  assert.ok(allowed.event && allowed.event.event_id, 'and the claim is named by its event as always');
  const bare = tasks.claimTask(store.db, { id: make({}), claimedBy: 'fleet-claude' });
  assert.deepEqual(Object.keys(bare).sort(), Object.keys(allowed).sort());
});

test('the check is made with the write lock held, so the job cannot change between the look and the claim', (t) => {
  const { store } = storeIn(t);
  const id = tasks.addTask(store.db, { title: 'tidy the notes', workspaceRoot: store.workspace, metadata: { assigned_to: 'closer' } }).id;
  const { DatabaseSync } = require('node:sqlite');
  const apart = new DatabaseSync(store.dbPath);
  t.after(() => apart.close());
  apart.exec('PRAGMA busy_timeout = 0');
  const edit = () => apart.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(JSON.stringify({ assigned_to: 'someone-else' }), id);

  let during = null;
  const claimed = tasks.claimTask(store.db, {
    id,
    claimedBy: 'fleet-claude',
    refuseIf: () => {
      try { edit(); during = 'changed'; } catch (error) { during = String(error.message); }
      return '';
    },
  });
  assert.equal(claimed.claimed, true);
  assert.match(during, /locked|busy/i, `another writer was kept out while the check ran: ${during}`);
  assert.deepEqual(JSON.parse(store.db.prepare('SELECT metadata FROM tasks WHERE id = ?').get(id).metadata).assigned_to, 'closer');
  // Control: once the claim is made the same write goes through, so it was the claim that kept it out.
  assert.doesNotThrow(edit);
});

test('the check is asked only about an open job, and one that throws takes the claim with it', (t) => {
  const { store } = storeIn(t);
  const id = tasks.addTask(store.db, { title: 'tidy the notes', workspaceRoot: store.workspace }).id;
  const state = () => ({ ...store.db.prepare('SELECT status, claimed_by FROM tasks WHERE id = ?').get(id) });
  const claims = () => store.db.prepare("SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND event_type = 'claimed'").get(id).n;

  assert.throws(() => tasks.claimTask(store.db, { id, claimedBy: 'fleet-claude', refuseIf: () => { throw new Error('could not look'); } }), /could not look/);
  assert.deepEqual(state(), { status: 'open', claimed_by: null }, 'a check that cannot answer claims nothing');
  assert.equal(claims(), 0);
  // ...and the store is not left holding the lock.
  assert.equal(tasks.claimTask(store.db, { id, claimedBy: 'fleet-codex' }).claimed, true);

  let asked = 0;
  const late = tasks.claimTask(store.db, { id, claimedBy: 'fleet-claude', refuseIf: () => { asked += 1; return 'not today'; } });
  assert.deepEqual(late, { claimed: false, reason: 'already_claimed', claimed_by: 'fleet-codex' }, 'a job someone holds answers as it always did');
  assert.equal(asked, 0);
  assert.deepEqual(tasks.claimTask(store.db, { id: 'no-such-job', claimedBy: 'fleet-claude', refuseIf: () => { asked += 1; return 'not today'; } }), { claimed: false, reason: 'not_found' });
  assert.equal(asked, 0);
});

test('a task do claim saves the job as it stood, the way a claim does, for an open job and for one nobody owns', (t) => {
  const { store } = storeIn(t);
  const make = (extra = {}) => tasks.addTask(store.db, {
    title: 'tidy the notes #docs', tag: 'cli', workspaceRoot: store.workspace, metadata: { tags: ['Billing'], todo_tags: ['Customer'] }, ...extra,
  }).id;
  const plan = (id) => {
    const planned = tasks.stageTask(store.db, { id, actor: 'fleet-claude', stage: 'plan', owner: 'fleet-claude', goal: 'tidy the notes', exit: 'the notes are tidy', proofNeeded: 'node --test test/x.test.js' });
    assert.equal(planned.staged, true, planned.reason);
  };
  const start = (id) => {
    const doing = tasks.stageTask(store.db, { id, actor: 'fleet-claude', stage: 'do', firstMove: 'begin' });
    assert.equal(doing.staged, true, doing.reason);
  };
  const lastClaim = (id) => JSON.parse(store.db.prepare("SELECT payload FROM task_events WHERE task_id = ? AND event_type = 'claimed' ORDER BY version DESC LIMIT 1").get(id).payload);

  // The reference: the same job claimed the ordinary way.
  const ordinary = make();
  assert.equal(tasks.claimTask(store.db, { id: ordinary, claimedBy: 'fleet-claude' }).claimed, true);
  const want = lastClaim(ordinary).job_at_claim;
  assert.equal(want.title, 'tidy the notes #docs');
  assert.equal(want.tag, 'cli');

  const open = make();
  plan(open);
  start(open);                                    // an open job, claimed by task do
  assert.equal(lastClaim(open).claimed_by, 'fleet-claude');
  assert.deepEqual(lastClaim(open).job_at_claim, want, 'an open job taken by task do');

  const unowned = make({ status: 'claimed' });    // a claimed job with no claimant
  plan(unowned);
  start(unowned);
  assert.equal(lastClaim(unowned).claimed_by, 'fleet-claude');
  assert.deepEqual(lastClaim(unowned).job_at_claim, want, 'a job nobody owned, taken over by task do');

  store.tag(open, { add: ['security'] });
  store.retitle(open, 'something else');
  assert.deepEqual(lastClaim(open).job_at_claim, want, 'tagging and renaming afterwards change nothing');
});

test('a task do claim that does not go through saves nothing', (t) => {
  const { store } = storeIn(t);
  const id = tasks.addTask(store.db, { title: 'tidy the notes', tag: 'cli', workspaceRoot: store.workspace }).id;
  const refused = tasks.stageTask(store.db, { id, actor: 'fleet-claude', stage: 'do', firstMove: 'begin' });   // no plan yet
  assert.equal(refused.staged, false);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND event_type = 'claimed'").get(id).n, 0);
});

test('tagging a finished job afterwards does not move its play into a lane', (t) => {
  const { root, store } = storeIn(t);
  const landedId = store.play(landed({ at: START + HOUR, tag: 'cli' }));
  const missed = store.play({ member: 'fleet-claude', outcome: 'dropped', at: START + 2 * HOUR, tag: 'cli' });
  const before = recordOf(loadFrom(root, store).plays, 'claude', ['security']);
  assert.deepEqual(shape(before), [0, 0, 1, 1], 'cli jobs are outside a security job\'s lane');

  store.tag(landedId, { add: ['security'] });
  store.tag(missed, { add: ['security'] });
  assert.deepEqual(recordOf(loadFrom(root, store).plays, 'claude', ['security']), before, 'the later tag did not make them security jobs');
  assert.deepEqual(shape(recordOf(loadFrom(root, store).plays, 'claude', ['cli'])), [1, 1, 0, 0], 'the lane they were in at the claim still counts');
});

test('removing a tag from a finished job afterwards does not take its play out of the lane', (t) => {
  const { root, store } = storeIn(t);
  const landedId = store.play(landed({ at: START + HOUR, metadata: { tags: ['security'] } }));
  const missed = store.play({ member: 'fleet-claude', outcome: 'dropped', at: START + 2 * HOUR, metadata: { tags: ['security'] } });
  const before = recordOf(loadFrom(root, store).plays, 'claude', ['security']);
  assert.deepEqual(shape(before), [1, 1, 0, 0]);
  store.tag(landedId, { remove: ['security'] });
  store.tag(missed, { remove: ['security'] });
  assert.deepEqual(recordOf(loadFrom(root, store).plays, 'claude', ['security']), before);
});

test('renaming a finished job afterwards changes nothing either, because a #hashtag in a title is a lane', (t) => {
  const { root, store } = storeIn(t);
  const tagged = store.play(landed({ at: START + HOUR, title: 'tidy the notes #security' }));
  const plain = store.play({ member: 'fleet-claude', outcome: 'dropped', at: START + 2 * HOUR, title: 'tidy the notes' });
  const before = recordOf(loadFrom(root, store).plays, 'claude', ['security']);
  assert.deepEqual(shape(before), [1, 0, 0, 1]);
  store.retitle(tagged, 'tidy the notes');
  store.retitle(plain, 'tidy the notes #security');
  assert.deepEqual(recordOf(loadFrom(root, store).plays, 'claude', ['security']), before);
});

test('moving a finished job to the backlog afterwards changes nothing', (t) => {
  const { root, store } = storeIn(t);
  const landedId = store.play(landed({ at: START + HOUR, tag: 'cli', metadata: { verify: 'node --test test/x.test.js' } }));
  const missed = store.play({ member: 'fleet-claude', outcome: 'dropped', at: START + 2 * HOUR, tag: 'cli', metadata: { verify: 'node --test test/x.test.js' } });
  const before = recordOf(loadFrom(root, store).plays, 'claude', ['cli']);
  assert.deepEqual(shape(before), [1, 1, 0, 0]);
  store.backlog(landedId, 'capture');
  store.backlog(missed, 'capture');
  assert.deepEqual(recordOf(loadFrom(root, store).plays, 'claude', ['cli']), before, 'cli, not capture, is the lane they were in');
  assert.deepEqual(shape(recordOf(loadFrom(root, store).plays, 'claude', ['capture'])), [0, 0, 1, 1]);
});

test('a change made before the claim is part of the lane the play had, and a later one is not', (t) => {
  const { root, store } = storeIn(t);
  const id = store.play(landed({
    at: START + HOUR, tag: 'cli',
    before: (jobId) => store.tag(jobId, { add: ['security'] }),
  }));
  assert.deepEqual(shape(recordOf(loadFrom(root, store).plays, 'claude', ['security'])), [1, 0, 0, 0], 'tagged security before the claim');
  assert.deepEqual(shape(recordOf(loadFrom(root, store).plays, 'claude', ['cli'])), [1, 0, 0, 0]);
  store.tag(id, { remove: ['security'], add: ['docs'] });
  assert.deepEqual(shape(recordOf(loadFrom(root, store).plays, 'claude', ['security'])), [1, 0, 0, 0], 'removing it afterwards changes nothing');
  assert.deepEqual(shape(recordOf(loadFrom(root, store).plays, 'claude', ['docs'])), [0, 0, 1, 0], 'adding docs afterwards changes nothing');
});

test('a claim made without the saved job counts at half weight on both sides, and is never rebuilt from the job\'s history', (t) => {
  const { root, store } = storeIn(t);
  const landedId = store.play(landed({ at: START + HOUR, tag: 'security', snapshot: false }));
  const missed = store.play({ member: 'fleet-claude', outcome: 'dropped', at: START + 2 * HOUR, tag: 'security', snapshot: false });
  store.play(landed({ at: START + 3 * HOUR, tag: 'security' }));    // a claim that did save the job
  const read = () => loadFrom(root, store).plays;
  assert.deepEqual(read().map((one) => one.lane === null), [true, true, false]);
  assert.deepEqual(shape(recordOf(read(), 'claude', ['security'])), [1, 0, 1, 1], 'the saved claim is in the lane; the two without are outside it');
  assert.deepEqual(shape(recordOf(read(), 'claude', [])), [0, 0, 2, 1], 'a job with no lane does not claim them as its own');
  assert.deepEqual(landedOf(read()), [2, 3], 'they still count in the overall record');

  // Recorded edits and a "previous title" note are exactly what a rebuild would have read. It does not read them.
  store.tag(landedId, { add: ['docs'] });
  store.retitle(missed, 'tidy #docs');
  assert.deepEqual(read().map((one) => one.lane === null), [true, true, false]);
  assert.deepEqual(shape(recordOf(read(), 'claude', ['docs'])), [0, 0, 2, 1]);
});

test('a job whose tags never changed keeps its tags as its lane, whatever shape they were given in', (t) => {
  const { root, store } = storeIn(t);
  store.play(landed({ at: START + HOUR, tag: 'cli', metadata: { tags: ['Billing'], todo_tags: ['Customer'] }, title: 'fix it #deploy' }));
  const [one] = loadFrom(root, store).plays;
  assert.deepEqual(one.lane.slice().sort(), ['billing', 'cli', 'customer', 'deploy']);
});

test('lanes at the claim steer the draw: retagging a finished job afterwards cannot buy it a lane', (t) => {
  const { root, store } = storeIn(t);
  const ids = store.plays(6, landed({ member: 'fleet-cursor', at: START + HOUR, tag: 'docs' }));
  store.plays(6, landed({ member: 'fleet-codex', at: START + HOUR + 10 * MINUTE, tag: 'security' }));
  const orders = () => {
    const found = loadFrom(root, store).plays;
    return seedsOf(40).map((seed) => pickBuilders({ candidates: ['cursor', 'codex'], plays: found, since: START, job: { id: 'job-s', lane: ['security'] }, seed }).order.join());
  };
  const before = orders();
  for (const id of ids) store.tag(id, { add: ['security'] });
  assert.deepEqual(orders(), before, 'every seed gives the same order as before the retag');
});

// ---------------------------------------------------------------------------
// When no landing can be checked here at all, jobs are dealt in turn, and the flight says why.

const CAN_NOT = (why) => `steering on since Nov 1: dealing in turn: landings cannot be checked here (${why})`;

// A history of nothing but misses: claude missed eight, codex missed two.
function missesOnly(store) {
  store.plays(8, { member: 'fleet-claude', outcome: 'dropped', at: START + HOUR });
  store.plays(2, { member: 'fleet-codex', outcome: 'sent_back', at: START + 2 * HOUR });
}

test('dealing: with no origin branch and a history of misses, jobs are dealt in turn and the flight says why', (t) => {
  const { root, store } = storeIn(t, { origin: false });
  missesOnly(store);
  const steer = startSteering({ root, env: ENV, now: NOW });
  const list = [job(1), job(2), job(3), job(4)];
  const dealt = dealOver(steer, list);
  assert.deepEqual(engines(dealt.entries), engines(turns(list)), 'exactly the turns, as when nobody has a result');
  assert.ok(dealt.entries.every((entry) => !entry.pick));
  assert.deepEqual(dealt.notes, [CAN_NOT('no origin branch')]);
  assert.equal(dealt.picked, 0);
  assert.equal(steer.next(job(5), ['claude', 'codex']), null, 'a retry deals the way a first pick does');
  assert.deepEqual(steer.notes(), [], 'said once');
});

test('dealing: with an origin and the very same history of misses, jobs are steered', (t) => {
  const { root, store } = storeIn(t);
  missesOnly(store);
  const steer = startSteering({ root, env: ENV, now: NOW });
  const dealt = dealOver(steer, [job(1), job(2), job(3), job(4)]);
  assert.deepEqual(dealt.notes, []);
  assert.equal(dealt.picked, 4);
  assert.ok(dealt.entries.every((entry) => /^picked fleet-/.test(entry.pick)));
  assert.equal(dealt.entries.filter((entry) => entry.engine === 'codex').length, 2, 'the engine that missed less takes its share first');
  assert.deepEqual(steer.next(job(5), ['claude', 'codex']) !== null, true);
});

test('dealing: no git repository at all is the same case, with its own reason', (t) => {
  const { root, store } = storeIn(t, { git: false });
  missesOnly(store);
  const dealt = dealOver(startSteering({ root, env: ENV, now: NOW }), [job(1), job(2)]);
  assert.deepEqual(dealt.notes, [CAN_NOT('this folder is not a git repository')]);
  assert.equal(dealt.picked, 0);
});

test('dealing: with origin/HEAD missing the line names the fix, and origin/main is not guessed', (t) => {
  const { root, store } = storeIn(t);
  missesOnly(store);
  store.dropOriginHead();
  const dealt = dealOver(startSteering({ root, env: ENV, now: NOW }), [job(1), job(2)]);
  assert.equal(dealt.notes.length, 1);
  assert.match(dealt.notes[0], /^steering on since Nov 1: dealing in turn: landings cannot be checked here \(.*default branch.*\)$/);
  assert.ok(dealt.notes[0].includes(FIX), dealt.notes[0]);
  assert.equal(dealt.picked, 0);
});

test('dealing: when origin cannot be fetched, jobs are dealt in turn and the line says why', (t) => {
  const { root, store } = storeIn(t);
  store.plays(4, landed({ at: START + HOUR }));
  store.plays(4, { member: 'fleet-codex', outcome: 'dropped', at: START + 2 * HOUR });
  store.breakRemote();
  const dealt = dealOver(startSteering({ root, env: ENV, now: NOW }), [job(1), job(2)]);
  assert.equal(dealt.picked, 0);
  assert.equal(dealt.notes.length, 1);
  assert.match(dealt.notes[0], /^steering on since Nov 1: dealing in turn: landings cannot be checked here \(could not fetch origin/);
});

test('dealing: one engine ready, or every job named, never reads the results and so never fetches', (t) => {
  const { root, store } = storeIn(t);
  store.plays(2, landed({ at: START + HOUR }));
  const watch = watchGit(t);
  watch.clear();
  const one = dealOver(startSteering({ root, env: ENV, now: NOW }), [job(1), job(2)], ['claude']);
  assert.deepEqual(one.notes, []);
  const allNamed = dealOver(startSteering({ root, env: ENV, now: NOW }), [named(1, 'codex'), named(2, 'claude')]);
  assert.deepEqual(allNamed.notes, []);
  assert.deepEqual(watch.startingWith('fetch'), []);
  assert.deepEqual(watch.calls(), []);
});

// ---------------------------------------------------------------------------
// The folder is judged in one exact order.
//   One. No git, no origin, or no origin/HEAD for the folder: no landing can be checked, whatever the history holds. Jobs
//        are dealt in turn, with one line.
//   Two. Landings are on record (an engine's own, since steering began): origin's default branch is fetched. A fetch that
//        fails deals jobs in turn with one line; one that works checks the landings and steers.
//   Three. Only misses are on record: they steer, without a fetch. A newcomer is tried and the engine that missed gets
//        fewer jobs.

const CANNOT_WAYS = [
  { label: 'no git repository in the folder', room: (t) => storeIn(t, { git: false }), why: /^this folder is not a git repository$/ },
  { label: 'no origin', room: (t) => storeIn(t, { origin: false }), why: /^no origin branch$/ },
  { label: 'origin/HEAD not set', room: (t) => { const room = storeIn(t); room.store.dropOriginHead(); return room; }, why: /default branch is not set/ },
  { label: 'origin/HEAD naming a branch that is not here', room: (t) => { const room = storeIn(t); room.store.dangleOriginHead(); return room; }, why: /origin\/gone/ },
  {
    label: 'git missing from this computer',
    room: (t) => {
      const room = storeIn(t);
      const nothingHere = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-pick-nopath-'));
      t.after(() => fs.rmSync(nothingHere, { recursive: true, force: true }));
      setEnv(t, { PATH: nothingHere });
      return room;
    },
    why: /^git is not installed here$/,
  },
];
const HISTORIES = [
  ['only misses', (store) => missesOnly(store)],
  ['misses and landings', (store) => { missesOnly(store); store.plays(3, landed({ at: START + 3 * HOUR, commit: MADE_UP })); }],
];

for (const way of CANNOT_WAYS) {
  for (const [history, seed] of HISTORIES) {
    test(`a folder that cannot be checked deals in turn with one line, whatever is on record: ${way.label}, ${history}`, (t) => {
      const { root, store } = way.room(t);
      seed(store);
      const got = loadFrom(root, store);
      assert.deepEqual(got.plays, []);
      assert.deepEqual(got.notes, []);
      assert.match(got.cannot, way.why);

      const list = [job(1), job(2), job(3)];
      const steer = startSteering({ root, env: ENV, now: NOW });
      const dealt = dealOver(steer, list);
      assert.deepEqual(engines(dealt.entries), engines(turns(list)), 'exactly the turns');
      assert.ok(dealt.entries.every((entry) => !entry.pick));
      assert.equal(dealt.picked, 0);
      assert.equal(dealt.notes.length, 1, dealt.notes.join('\n'));
      assert.match(dealt.notes[0], /^steering on since Nov 1: dealing in turn: landings cannot be checked here \(/);
      assert.equal(steer.next(job(4), ['claude', 'codex']), null, 'a retry deals the same way');
      assert.deepEqual(steer.notes(), [], 'and the line is said once');
    });
  }
}

test('landings on record are fetched for once for the whole flight, and a fetch that fails deals in turn with one line', (t) => {
  const { root, store } = storeIn(t);
  store.plays(4, landed({ at: START + HOUR }));
  missesOnly(store);
  store.breakRemote();
  const watch = watchGit(t);
  watch.clear();
  const steer = startSteering({ root, env: ENV, now: NOW });
  const list = [job(1), job(2), job(3)];
  const dealt = dealOver(steer, list);
  assert.deepEqual(engines(dealt.entries), engines(turns(list)));
  assert.equal(dealt.notes.length, 1, dealt.notes.join('\n'));
  assert.match(dealt.notes[0], /^steering on since Nov 1: dealing in turn: landings cannot be checked here \(could not fetch origin/);
  assert.equal(steer.next(job(4), ['claude', 'codex']), null);
  assert.deepEqual(watch.startingWith('fetch'), [FETCH_MAIN], 'one try for the whole flight, retries included');
});

test('landings on record are fetched for, and when the fetch works they are checked and steered on', (t) => {
  const { root, store } = storeIn(t);
  store.plays(6, landed({ member: 'fleet-codex', at: START + HOUR }));
  store.plays(6, { member: 'fleet-claude', outcome: 'dropped', at: START + HOUR });
  const watch = watchGit(t);
  watch.clear();
  const dealt = dealOver(startSteering({ root, env: ENV, now: NOW }), [job(1), job(2), job(3), job(4)]);
  assert.deepEqual(watch.startingWith('fetch'), [FETCH_MAIN]);
  assert.deepEqual(dealt.notes, []);
  assert.equal(dealt.picked, 4);
  assert.deepEqual(engines(dealt.entries), ['codex', 'codex', 'claude', 'claude']);
});

test('misses alone steer without a fetch: origin out of reach changes nothing, a newcomer is tried and the engine that missed gets fewer jobs', (t) => {
  const { root, store } = storeIn(t);
  store.plays(8, { member: 'fleet-claude', outcome: 'dropped', at: START + HOUR });
  store.breakRemote();
  const watch = watchGit(t);
  watch.clear();
  const pool = ['claude', 'codex', 'cursor'];
  const list = Array.from({ length: 4 }, (_, i) => job(i + 1));
  const dealt = dealOver(startSteering({ root, env: ENV, now: NOW }), list, pool);
  assert.deepEqual(dealt.notes, []);
  assert.equal(dealt.picked, 4);
  assert.deepEqual(watch.startingWith('fetch'), [], 'a miss needs no commit, so there is nothing to fetch for');
  const load = (name) => engines(dealt.entries).filter((engine) => engine === name).length;
  assert.ok(load('codex') >= 1 && load('cursor') >= 1, `the newcomers are tried: ${engines(dealt.entries)}`);
  assert.ok(load('claude') < load('codex') && load('claude') < load('cursor'), `the engine that missed gets fewer jobs: ${engines(dealt.entries)}`);
});

test('the picker fetches for the engines\' own landings only: a person\'s landing on record, with the engines holding only misses, steers without a fetch', (t) => {
  const { root, store } = storeIn(t);
  store.play(landed({ member: 'keshav', at: START + HOUR }));
  missesOnly(store);
  store.breakRemote();
  const watch = watchGit(t);
  watch.clear();
  const dealt = dealOver(startSteering({ root, env: ENV, now: NOW }), [job(1), job(2), job(3), job(4)]);
  assert.deepEqual(dealt.notes, []);
  assert.equal(dealt.picked, 4);
  assert.deepEqual(watch.startingWith('fetch'), []);
});

// ---------------------------------------------------------------------------
// Explicit choices are resolved first, before any early return or filter.

const ENV = { ATRIS_PICK_SINCE: '2026-11-01' };
const named = (n, engine, extra = {}) => job(n, { metadata: { executed_by: engine }, ...extra });
const assigned = (n, member) => job(n, { metadata: { assigned_to: member } });
const CLAUDE_STRONG = [...plays(6, 'fleet-claude', 'landed'), ...plays(6, 'fleet-codex', 'dropped')];

// A scratch project, with a scratch home, whose roster gives these members these engines (null: a member the
// roster says nothing about). The owner's real roster, engine registry and home folder are never read.
function projectRoom(t, team = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-pick-team-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-pick-team-home-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  setEnv(t, {
    HOME: home,
    ATRIS_MACHINE_ROSTER_PATH: path.join(home, '.atris', 'roster.json'),
    ATRIS_MACHINE_ROSTER_MD_PATH: path.join(home, '.atris', 'ROSTER.md'),
    ATRIS_ROSTER_SESSION: undefined,
    ATRIS_ROSTER_SESSIONS_DIR: path.join(home, 'sessions'),
    ATRIS_ROUTER_EXPLAIN: '0',
    ATRIS_RUNNER_MODEL: undefined,
    ATRIS_CLAUDE_SPEND_OK: undefined,
  });
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  for (const member of Object.keys(team)) {
    fs.mkdirSync(path.join(root, 'atris', 'team', member), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'team', member, 'MEMBER.md'), `---\nname: ${member}\nrole: ${member}\ndescription: test member\n---\n\n# ${member}\n`);
  }
  const lines = Object.entries(team).filter(([, engine]) => engine).map(([member, engine]) => `${member}: ${engine}`);
  fs.writeFileSync(path.join(root, 'atris', 'ROSTER.md'), `# roster\n\n## team\n${lines.join('\n')}\n`);
  return { root, home };
}

test('explicit: a job that names its engine goes there, whether or not anyone has a result', () => {
  const pool = ['claude', 'codex', 'cursor'];
  const list = [named(1, 'codex'), job(2, { executed_by: 'claude' }), named(3, 'claude-code'), named(4, 'cursor-agent', { executed_by: undefined }), job(5)];
  assert.deepEqual(engines(turns(list, pool)), ['claude', 'codex', 'cursor', 'claude', 'codex'], 'what the turns would give');
  for (const history of [[], CODEX_STRONG, CLAUDE_STRONG]) {
    const dealt = dealOver(steerWith(history), list, pool);
    assert.deepEqual(engines(dealt.entries).slice(0, 4), ['codex', 'claude', 'claude', 'cursor'], 'the engine each job names, however the engine is spelled');
    assert.ok(dealt.entries.slice(0, 4).every((entry) => !entry.pick), 'a named job carries no pick line');
    assert.deepEqual(dealt.entries.map((entry) => entry.task.display_id), ['F-1', 'F-2', 'F-3', 'F-4', 'F-5'], 'every job, in its own order');
  }
  // With nobody having a result the one free job takes its turn and the flight says so; named jobs need no results.
  const quiet = dealOver(steerWith([]), list, pool);
  assert.equal(quiet.entries[4].engine, 'codex');
  assert.deepEqual(quiet.notes, ['steering on since Nov 1: no results yet, so jobs are dealt in turn']);
  assert.deepEqual(dealOver(steerWith([]), list.slice(0, 4), pool).notes, [], 'a flight of named jobs has nothing to say about results');
});

test('explicit: a job assigned to a member goes to that member\'s own engine; a member the roster does not decide keeps its turn', (t) => {
  const { root } = projectRoom(t, { closer: 'codex', ghost: null });
  const list = [assigned(1, 'ghost'), assigned(2, 'closer'), named(3, 'closer'), job(4)];
  assert.deepEqual(engines(turns(list)), ['claude', 'codex', 'claude', 'codex']);
  for (const history of [[], CODEX_STRONG]) {
    const dealt = dealOver(steerWith(history, { root }), list);
    // ghost has no engine the roster decided, so its job keeps the engine the turns gave it, strong record or not.
    assert.deepEqual(engines(dealt.entries).slice(0, 3), ['claude', 'codex', 'codex'], 'closer\'s jobs go to codex, ghost\'s keeps its turn');
    assert.ok(dealt.entries.slice(0, 3).every((entry) => !entry.pick), 'none of them is the picker\'s');
  }
});

test('explicit: a named engine this flight does not have leaves the job out of the flight, with one line naming the job and the engine', () => {
  const list = [named(1, 'devin'), named(2, 'nobody-at-all'), job(3), job(4)];
  assert.deepEqual(engines(turns(list)), ['claude', 'codex', 'claude', 'codex']);
  const dealt = dealOver(steerWith(CODEX_STRONG), list);
  assert.deepEqual(dealt.entries.map((entry) => entry.task.display_id), ['F-3', 'F-4'], 'neither job goes to an engine the person did not choose');
  assert.deepEqual(dealt.notes, [
    'left out F-1: it names devin, which this flight does not have (claude, codex)',
    'left out F-2: it names nobody-at-all, which this flight does not have (claude, codex)',
  ]);
  // The two jobs that stay share the two engines: a share of one each, whatever the left-out jobs would have made it.
  assert.deepEqual(engines(dealt.entries), ['codex', 'claude']);
  assert.equal(dealt.picked, 2);
  assert.deepEqual(dealt.ready, POOL);
});

test('explicit: the engine a job names decides: a member it is also assigned to never takes the place of an engine this flight does not have', (t) => {
  const { root } = projectRoom(t, { closer: 'codex' });
  const both = (n, engine) => job(n, { metadata: { executed_by: engine, assigned_to: 'closer' } });
  const dealt = dealOver(steerWith(CODEX_STRONG, { root }), [both(1, 'devin'), both(2, 'claude'), job(3)]);
  assert.deepEqual(dealt.notes, ['left out F-1: it names devin, which this flight does not have (claude, codex)']);
  assert.deepEqual(dealt.entries.map((entry) => [entry.task.display_id, entry.engine]).slice(0, 1), [['F-2', 'claude']], 'the named engine is here, so the job goes there and not to the member\'s engine');
  assert.deepEqual(dealt.entries.map((entry) => entry.task.display_id), ['F-2', 'F-3']);
});

test('explicit: leaving a job out moves no other job: each keeps the engine its own turn gave it', () => {
  const list = [job(1), named(2, 'devin'), job(3), job(4)];
  assert.deepEqual(engines(turns(list)), ['claude', 'codex', 'claude', 'codex']);
  const dealt = dealOver(steerWith([]), list);
  assert.deepEqual(dealt.entries.map((entry) => [entry.task.display_id, entry.engine]), [['F-1', 'claude'], ['F-3', 'claude'], ['F-4', 'codex']]);
  assert.deepEqual(dealt.notes, [
    'left out F-2: it names devin, which this flight does not have (claude, codex)',
    'steering on since Nov 1: no results yet, so jobs are dealt in turn',
  ]);
});

test('explicit: a left-out job counts toward nobody\'s share', () => {
  const list = [named(1, 'devin'), named(2, 'devin'), named(3, 'devin'), job(4), job(5)];
  const dealt = dealOver(steerWith(CODEX_STRONG), list);
  assert.equal(dealt.notes.length, 3);
  // Two jobs over two engines is a share of one each. Counted with the left-out jobs it would be three, and the strong
  // engine would take both.
  assert.deepEqual(engines(dealt.entries).sort(), ['claude', 'codex']);
});

test('explicit: when every job is left out, nothing is dealt and every job is named once', () => {
  const dealt = dealOver(steerWith(CODEX_STRONG), [named(1, 'devin'), named(2, 'grok')]);
  assert.deepEqual(dealt.entries, []);
  assert.equal(dealt.picked, 0);
  assert.deepEqual(dealt.notes, [
    'left out F-1: it names devin, which this flight does not have (claude, codex)',
    'left out F-2: it names grok, which this flight does not have (claude, codex)',
  ]);
});

test('explicit: a job assigned to a member, or naming one, whose engine this flight does not have is left out too; a member the roster does not decide keeps its turn', (t) => {
  // cursor counts as installed because a stand-in for its program is on the path, not because of this computer's tools.
  const tools = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-pick-tools-'));
  t.after(() => fs.rmSync(tools, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tools, 'cursor-agent'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  setEnv(t, { PATH: `${tools}${path.delimiter}${process.env.PATH}` });
  const { root } = projectRoom(t, { closer: 'cursor', ghost: null });
  const { memberRosterEngine } = require('../lib/member-engine');
  assert.equal(memberRosterEngine('closer', root).engine.id, 'cursor', 'the roster really sends closer to cursor');
  const list = [assigned(1, 'closer'), named(2, 'closer'), assigned(3, 'ghost'), job(4)];
  assert.deepEqual(engines(turns(list)), ['claude', 'codex', 'claude', 'codex']);
  const dealt = dealOver(steerWith(CODEX_STRONG, { root }), list);
  assert.deepEqual(dealt.notes, [
    'left out F-1: it is assigned to closer, whose engine is cursor, which this flight does not have (claude, codex)',
    'left out F-2: it names closer, whose engine is cursor, which this flight does not have (claude, codex)',
  ]);
  assert.deepEqual(dealt.entries.map((entry) => entry.task.display_id), ['F-3', 'F-4']);
  assert.equal(dealt.entries[0].engine, 'claude', 'ghost has no engine the roster decided, so its job keeps the engine its turn gave it');
  assert.ok(!dealt.entries[0].pick);
  assert.equal(dealt.entries[1].engine, 'codex', 'the free job takes the engine with room');
});

test('explicit: a member whose engine this flight does have still gets the job', (t) => {
  const { root } = projectRoom(t, { closer: 'codex' });
  const list = [assigned(1, 'closer'), named(2, 'closer'), job(3)];
  const dealt = dealOver(steerWith(CODEX_STRONG, { root }), list);
  assert.deepEqual(engines(dealt.entries).slice(0, 2), ['codex', 'codex']);
  assert.ok(!dealt.notes.some((note) => /^left out F-/.test(note)), dealt.notes.join('\n'));
});

test('explicit: gives(roster) is asked before staffing: a job whose choice the roster cannot give is turned down with its line, said once; every other job may go', () => {
  const steer = steerWith(CODEX_STRONG);
  const may = steer.gives(POOL);
  assert.deepEqual([named(1, 'devin'), named(2, 'codex'), job(3), assigned(4, 'ghost')].map((task) => may(task)), [false, true, true, true]);
  assert.deepEqual(steer.notes(), ['left out F-1: it names devin, which this flight does not have (claude, codex)']);
  assert.equal(may(named(1, 'devin')), false);
  assert.deepEqual(steer.notes(), [], 'the line is not said twice');
  // deal keeps its own handling of the same thing, and does not say it again.
  const dealt = dealOver(steer, [named(1, 'devin'), job(3)]);
  assert.deepEqual(dealt.entries.map((entry) => entry.task.display_id), ['F-3']);
  assert.deepEqual(dealt.notes, []);
});

test('explicit: gives(roster) turns down a member\'s job too when the member\'s engine is not in the roster, and lets everything go when steering is off', (t) => {
  const tools = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-pick-tools-'));
  t.after(() => fs.rmSync(tools, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tools, 'cursor-agent'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  setEnv(t, { PATH: `${tools}${path.delimiter}${process.env.PATH}` });
  const { root } = projectRoom(t, { closer: 'cursor', owner: 'codex' });
  const steer = steerWith(CODEX_STRONG, { root });
  const may = steer.gives(POOL);
  assert.deepEqual([assigned(1, 'closer'), named(2, 'closer'), assigned(3, 'owner'), named(4, 'owner')].map((task) => may(task)), [false, false, true, true]);
  assert.deepEqual(steer.notes(), [
    'left out F-1: it is assigned to closer, whose engine is cursor, which this flight does not have (claude, codex)',
    'left out F-2: it names closer, whose engine is cursor, which this flight does not have (claude, codex)',
  ]);

  // A list the caller names is the pool, so a job outside it is turned down too.
  const callerNamed = startSteering({ root: '/nowhere', env: ENV, now: NOW, plays: CODEX_STRONG, named: true });
  assert.equal(callerNamed.gives(POOL)(named(1, 'cursor')), false);

  // Steering off (--pick turns): nothing is turned down and nothing is said, the job keeps its turn.
  const off = startSteering({ root: '/nowhere', pick: 'turns', env: ENV, now: NOW, plays: CODEX_STRONG });
  assert.equal(off.gives(POOL)(named(1, 'devin')), true);
  assert.deepEqual(off.notes(), []);
});

test('explicit: guardClaim(task) answers for a claim: the same words (spelled any way the pick reads them) let it go on, a different member or engine refuses it, and steering off checks nothing', () => {
  const steer = steerWith([]);
  const check = steer.guardClaim(job(1, { metadata: { assigned_to: 'closer', executed_by: 'Cursor-Agent ' } }));
  assert.equal(typeof check, 'function');
  // Read from the store the way a claim reads it: the metadata parsed, the engine named under either key, any spelling.
  assert.equal(check({ id: 'row-1', status: 'open', metadata: { assigned_to: ' closer ', engine: 'cursor' } }), '');
  assert.equal(check({ id: 'row-1', status: 'open', metadata: { executed_by: 'cursor', assigned_to: 'closer', notes: 'anything else may change' } }), '');
  assert.equal(check({ id: 'row-1', status: 'open', metadata: { assigned_to: 'someone-else', executed_by: 'cursor' } }), CHOICE_CHANGED, 'given to another member');
  assert.equal(check({ id: 'row-1', status: 'open', metadata: { assigned_to: 'closer', executed_by: 'codex' } }), CHOICE_CHANGED, 'another engine named');
  assert.equal(check({ id: 'row-1', status: 'open', metadata: { assigned_to: 'closer' } }), CHOICE_CHANGED, 'the engine taken off');
  assert.equal(check({ id: 'row-1', status: 'open', metadata: null }), CHOICE_CHANGED, 'all of it taken off');

  // A job that chose nothing is refused when it is given a choice, and not otherwise.
  const bare = steer.guardClaim(job(2));
  assert.equal(bare({ id: 'row-2', status: 'open', metadata: { priority: 'high' } }), '');
  assert.equal(bare({ id: 'row-2', status: 'open', metadata: { executed_by: 'codex' } }), CHOICE_CHANGED);
  assert.equal(bare({ id: 'row-2', status: 'open', metadata: { assigned_to: 'closer' } }), CHOICE_CHANGED);

  const off = startSteering({ root: '/nowhere', pick: 'turns', env: ENV, now: NOW, plays: [] });
  assert.equal(off.guardClaim(job(1, { metadata: { assigned_to: 'closer' } })), null, 'the turns went on neither, so nothing is compared');
});

test('explicit: a list the caller names is the pool, so a job naming an engine outside it is left out too', () => {
  const list = [named(1, 'cursor'), job(2), job(3)];
  const dealt = startSteering({ root: '/nowhere', env: ENV, now: NOW, plays: CODEX_STRONG, named: true }).deal(turns(list), POOL);
  assert.deepEqual(dealt.entries.map((entry) => entry.task.display_id), ['F-2', 'F-3']);
  assert.deepEqual(dealt.notes, ['left out F-1: it names cursor, which this flight does not have (claude, codex)']);
  assert.deepEqual(dealt.ready, POOL);
});

test('explicit: an engine that is resting is still in the pool, so a job that names it is not left out', (t) => {
  const { root } = projectRoom(t);
  registry.setEngineHealth('codex', 'credit_out', root);
  const dealt = startSteering({ root, env: ENV, now: NOW, plays: CODEX_STRONG }).deal(turns([named(1, 'codex'), job(2)]), POOL);
  assert.equal(dealt.entries[0].engine, 'codex');
  assert.deepEqual(dealt.notes, ['left out, not ready: codex (out of credit)']);
});

test('explicit: a member the roster does not decide leaves the job on its turn, unless that engine is stopped, and then the job is picked like any other', (t) => {
  const { root } = projectRoom(t, { ghost: null });
  const list = [assigned(1, 'ghost'), job(2)];
  assert.deepEqual(engines(turns(list)), ['claude', 'codex']);
  const dealt = (env = ENV) => startSteering({ root, env, now: NOW, plays: CODEX_STRONG }).deal(turns(list), POOL);
  assert.deepEqual(engines(dealt().entries), ['claude', 'codex'], 'claude is fine, so the job stays on its turn');

  const stopped = dealt({ ...ENV, ATRIS_RUNNER_MODEL: 'claude-mystery-9' });
  assert.deepEqual(stopped.ready, ['codex']);
  assert.deepEqual(engines(stopped.entries), ['codex', 'codex'], 'the guard would stop claude, so the job nobody chose an engine for goes to an engine that is ready');
});

test('explicit: --pick turns and ATRIS_PICK=turns leave nothing out: a job naming an engine this flight does not have keeps its turn, as it always did', () => {
  const list = [named(1, 'devin'), assigned(2, 'closer'), job(3)];
  const today = turns(list);
  const flagged = startSteering({ root: '/nowhere', pick: 'turns', env: ENV, now: NOW, plays: CODEX_STRONG }).deal(today, POOL);
  assert.deepEqual(flagged, { entries: today, ready: POOL, notes: [], picked: 0 });
  const habit = startSteering({ root: '/nowhere', env: { ...ENV, ATRIS_PICK: 'turns' }, now: NOW, plays: CODEX_STRONG }).deal(today, POOL);
  assert.deepEqual(habit, { entries: today, ready: POOL, notes: [], picked: 0 });
});

test('explicit: choices count against a share but are never refused by it', () => {
  const list = [named(1, 'codex'), named(2, 'codex'), named(3, 'codex'), job(4)];
  const dealt = dealOver(steerWith(CODEX_STRONG), list);
  assert.deepEqual(engines(dealt.entries), ['codex', 'codex', 'codex', 'claude'], 'three named jobs all get codex although a share is two');
  assert.match(dealt.entries[3].pick, /^picked fleet-claude for this job: landed 0 of 6 since Nov 1 \(fleet-codex 6 of 6 but has its share\)$/);
  assert.equal(dealt.picked, 1, 'one job was picked; the three named ones were not');
});

test('explicit: --pick turns ignores the marks and deals exactly the turns', () => {
  const list = [named(1, 'codex'), assigned(2, 'closer'), job(3)];
  const today = turns(list);
  const steer = startSteering({ root: '/nowhere', pick: 'turns', env: ENV, now: NOW, plays: CODEX_STRONG });
  assert.deepEqual(steer.deal(today, POOL), { entries: today, ready: POOL, notes: [], picked: 0 });
});

test('explicit: a named engine that is out of credit still gets its job, and the other jobs are picked from the engines that are ready', (t) => {
  const { root } = projectRoom(t);
  registry.setEngineHealth('codex', 'credit_out', root);
  const pool = ['claude', 'codex', 'cursor'];
  const history = [...plays(6, 'fleet-claude', 'landed'), ...plays(6, 'fleet-cursor', 'landed'), ...plays(6, 'fleet-codex', 'landed')];
  const list = [named(1, 'codex'), job(2), job(3), job(4)];
  const dealt = startSteering({ root, env: ENV, now: NOW, plays: history }).deal(turns(list, pool), pool);
  assert.deepEqual(dealt.ready, ['claude', 'cursor'], 'codex sits out the picking');
  assert.equal(dealt.entries[0].engine, 'codex', 'the job that names codex still goes to codex');
  assert.ok(!dealt.entries[0].pick);
  assert.ok(dealt.entries.slice(1).every((entry) => dealt.ready.includes(entry.engine) && entry.pick), 'every other job is picked from the ready engines');
  assert.deepEqual(dealt.notes, ['left out, not ready: codex (out of credit)']);
});

test('explicit: an assigned member\'s job goes where the roster sends that member now, even when the picker would not use that engine', (t) => {
  const { root } = projectRoom(t, { closer: 'codex' });
  const list = [job(1), assigned(2, 'closer'), job(3)];
  const steer = () => startSteering({ root, env: ENV, now: NOW, plays: CODEX_STRONG });
  assert.equal(steer().deal(turns(list), POOL).entries[1].engine, 'codex', 'the member\'s own engine');

  // Codex runs out of credit. The roster moves its member to claude, and the job follows the roster: the turns
  // would have sent it to the engine that is out of credit, and the picker would have kept it away from claude.
  registry.setEngineHealth('codex', 'credit_out', root);
  const dealt = steer().deal(turns(list), POOL);
  assert.deepEqual(dealt.ready, ['claude']);
  assert.equal(dealt.entries[1].engine, 'claude');
  assert.ok(!dealt.entries[1].pick);
});

test('explicit: with one engine ready, a named engine that is cooling still gets its job', (t) => {
  const { root } = projectRoom(t);
  registry.setEngineHealth('codex', 'cooling', root);
  const list = [named(1, 'codex'), job(2)];
  // A cooling engine rests for a while from the moment it stalled, so this one asks at the real time.
  const dealt = startSteering({ root, env: ENV, now: Date.now(), plays: CODEX_STRONG }).deal(turns(list), POOL);
  assert.deepEqual(engines(dealt.entries), ['codex', 'claude']);
  assert.deepEqual(dealt.ready, ['claude']);
});

// ---------------------------------------------------------------------------
// An engine the Claude spend guard would stop is never picked. The model judged is the one the engine's launch
// will carry (lib/runner-command.js launchFor), decided from the environment the picker is given; the verdict is
// the guard's, given for the environment the worker will run in.

const PAID = 'claude-mystery-9'; // a model the runner's own cheap-model rule does not catch by name, so claude would really run on it
const paid = (extra = {}) => ({ ...ENV, ATRIS_RUNNER_MODEL: PAID, ...extra });
const STOPPED = `left out, not ready: claude (paid model ${PAID}, no spend approval)`;

// Every variable the launch reads, cleared, so a launch built in this process sees only what a test sets.
const NO_RUNNER_VARS = Object.fromEntries(['ATRIS_RUNNER_MODEL', 'ATRIS_CLAUDE_MODEL', 'ATRIS_RUNNER_BIN', 'ATRIS_CLAUDE_BIN',
  'ATRIS_RUNNER_COMMAND_TEMPLATE', 'ATRIS_CLAUDE_COMMAND_TEMPLATE', 'ATRIS_CLAUDE_SPEND_OK', 'ATRIS_RUNNER_PROFILE'].map((key) => [key, undefined]));

// Run `fn` with these variables set in this process, then put every one back. Synchronous on purpose.
function underEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  const apply = (values) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  };
  apply(vars);
  try {
    return fn();
  } finally {
    apply(saved);
  }
}

// What the fleet really launches claude, fable or haiku with: the --model on the command it builds, in this process.
function launchedModel(engine, env) {
  const realWrite = process.stderr.write;
  process.stderr.write = () => true; // the launch warns once about a paid model nobody approved
  try {
    const command = underEnv({ ...NO_RUNNER_VARS, ...env }, () => fleet.buildEngineCommand(engine, '/tmp/prompt.md'));
    return (/--model (\S+)/.exec(command) || [])[1] || '';
  } finally {
    process.stderr.write = realWrite;
  }
}

test('spend guard: an unattended run with no approval never picks a paid Claude model, and one line names the engine and why', (t) => {
  const { root } = projectRoom(t);
  const list = [job(1), job(2), job(3), job(4)];
  const steer = startSteering({ root, env: paid(), now: NOW, plays: CLAUDE_STRONG });
  const dealt = steer.deal(turns(list), POOL);
  assert.deepEqual(dealt.ready, ['codex']);
  assert.deepEqual(engines(dealt.entries), ['codex', 'codex', 'codex', 'codex'], 'claude has the best record and still gets nothing');
  assert.deepEqual(dealt.notes, [STOPPED]);
  assert.deepEqual(steer.rest(['claude', 'codex', 'cursor']).ready, ['codex', 'cursor'], 'a retry asks the same question');
  assert.equal(steer.next(job(9), steer.rest(['claude', 'codex']).ready).engine, 'codex', 'a retry never lands on claude');
  assert.equal(steer.next(job(9), steer.rest(['claude']).ready), null, 'with nobody ready there is nobody to pick');
});

test('spend guard: the legacy ATRIS_CLAUDE_MODEL alone is a model the launch carries, so it stops claude too', (t) => {
  const { root } = projectRoom(t);
  const legacy = { ...ENV, ATRIS_CLAUDE_MODEL: PAID };
  const steer = startSteering({ root, env: legacy, now: NOW, plays: CLAUDE_STRONG });
  const dealt = steer.deal(turns([job(1), job(2), job(3), job(4)]), POOL);
  assert.deepEqual(dealt.ready, ['codex'], 'with only the legacy variable set, the picker used to see Haiku and keep claude');
  assert.deepEqual(dealt.notes, [STOPPED]);
  assert.deepEqual(engines(dealt.entries), ['codex', 'codex', 'codex', 'codex']);
  // The variable really does reach the launch: built the way the fleet builds it, claude carries that model.
  assert.equal(launchedModel('claude', { ATRIS_CLAUDE_MODEL: PAID }), PAID);
  // ATRIS_RUNNER_MODEL beats it, the way it does at the launch.
  const beaten = { ...legacy, ATRIS_RUNNER_MODEL: 'claude-haiku-5-5' };
  assert.deepEqual(startSteering({ root, env: beaten, now: NOW, plays: [] }).rest(['claude', 'codex']).ready, ['claude', 'codex']);
  assert.equal(launchedModel('claude', { ATRIS_CLAUDE_MODEL: PAID, ATRIS_RUNNER_MODEL: 'claude-haiku-5-5' }), 'claude-haiku-5-5');
});

test('spend guard: the picker judges the model the launch carries, for every claude engine and every environment', (t) => {
  const { root } = projectRoom(t);
  const cases = [
    {},
    { ATRIS_CLAUDE_MODEL: PAID },
    { ATRIS_RUNNER_MODEL: 'claude-mystery-8', ATRIS_CLAUDE_MODEL: PAID },
    { ATRIS_RUNNER_MODEL: PAID, ATRIS_CLAUDE_SPEND_OK: PAID },
    { ATRIS_RUNNER_MODEL: PAID, ATRIS_CLAUDE_SPEND_OK: 'claude-mystery-8' },
    { ATRIS_RUNNER_MODEL: 'claude-opus-5-5' },
    { ATRIS_RUNNER_MODEL: 'claude-opus-5-5', ATRIS_CLAUDE_SPEND_OK: 'claude-opus-5-5' },
    { ATRIS_RUNNER_MODEL: 'claude-haiku-5-5', ANTHROPIC_API_KEY: 'sk-test-not-real' },
    { ATRIS_RUNNER_MODEL: 'claude-haiku-5-5', ANTHROPIC_API_KEY: 'sk-test-not-real', ATRIS_CLAUDE_KEY_OK: '1' },
  ];
  for (const engine of ['claude', 'fable', 'haiku']) {
    for (const extra of cases) {
      const carried = launchedModel(engine, extra);
      assert.equal(launchFor(engine, { env: extra }).model, carried, `${engine} ${JSON.stringify(extra)}: the model the launch names`);
      const stopped = startSteering({ root, env: { ...ENV, ...extra }, now: NOW, plays: [] }).rest([engine]).resting.length > 0;
      assert.equal(stopped, Boolean(unattendedStop({ model: carried, env: extra })), `${engine} ${JSON.stringify(extra)}: the guard's verdict on what the launch carries`);
    }
  }
});

test('spend guard: an engine with an approved model, or a Haiku engine, can be picked', (t) => {
  const { root } = projectRoom(t);
  const list = [job(1), job(2), job(3), job(4)];
  const steered = (env) => startSteering({ root, env: { ...ENV, ...env }, now: NOW, plays: CLAUDE_STRONG }).deal(turns(list), POOL);

  const approved = steered({ ATRIS_RUNNER_MODEL: PAID, ATRIS_CLAUDE_SPEND_OK: PAID });
  assert.deepEqual(approved.ready, ['claude', 'codex']);
  assert.deepEqual(approved.notes, []);
  assert.equal(approved.entries[0].engine, 'claude', 'the strong record leads again');
  assert.deepEqual(steered({ ATRIS_RUNNER_MODEL: PAID, ATRIS_CLAUDE_SPEND_OK: 'some-other-model' }).ready, ['codex'], 'a yes for another model is not a yes for this one');

  const free = steered({ ATRIS_RUNNER_MODEL: 'claude-haiku-5-5' });
  assert.deepEqual(free.ready, ['claude', 'codex']);
  assert.equal(free.entries[0].engine, 'claude');

  // A paid model the launch itself drops to Haiku when nobody approved it is not a spend: the launch runs Haiku.
  assert.deepEqual(steered({ ATRIS_RUNNER_MODEL: 'claude-opus-5-5' }).ready, ['claude', 'codex'], 'the launch falls back to the cheap model, so there is nothing to stop');
});

test('spend guard: a pay-per-use Claude key stops every claude engine, whatever the model, unless the key is approved', (t) => {
  const { root, home } = projectRoom(t);
  const rest = (env) => startSteering({ root, env: { ...ENV, ATRIS_RUNNER_MODEL: 'claude-haiku-5-5', ...env }, now: NOW, plays: [] }).rest(['claude', 'codex', 'cursor']);
  const keyed = rest({ ANTHROPIC_API_KEY: 'sk-test-not-real' });
  assert.deepEqual(keyed.ready, ['codex', 'cursor'], 'engines that are not the claude program are not asked');
  assert.deepEqual(keyed.resting, [{ name: 'claude', why: 'a pay-per-use Claude key is set' }]);
  assert.equal(keyed.note, 'left out, not ready: claude (a pay-per-use Claude key is set)');
  assert.deepEqual(rest({ ANTHROPIC_AUTH_TOKEN: 'token-not-real' }).ready, ['codex', 'cursor']);
  assert.deepEqual(rest({ ANTHROPIC_API_KEY: 'sk-test-not-real', ATRIS_CLAUDE_KEY_OK: '1' }).ready, ['claude', 'codex', 'cursor']);
  assert.deepEqual(rest({}).ready, ['claude', 'codex', 'cursor']);
  assert.equal(fs.existsSync(path.join(home, '.atris', 'spend')), false, 'asking is not a block: nothing is written to the guard\'s ledger');
});

test('spend guard: it is judged with the resting engines in one line, and steering off never asks', (t) => {
  const { root } = projectRoom(t);
  registry.setEngineHealth('cursor', 'cooling', root);
  const both = startSteering({ root, env: paid(), now: Date.now(), plays: [] }).rest(['claude', 'codex', 'cursor']);
  assert.deepEqual(both.ready, ['codex']);
  assert.equal(both.note, `left out, not ready: cursor (cooling), claude (paid model ${PAID}, no spend approval)`);
  const off = startSteering({ root, pick: 'turns', env: paid(), now: NOW, plays: [] }).rest(['claude', 'codex', 'cursor']);
  assert.deepEqual(off, { ready: ['claude', 'codex', 'cursor'], resting: [], note: '' });
});

test('spend guard: the model is judged in the launch\'s environment and the verdict in the worker\'s, which can be a sealed one with no approvals and no key', (t) => {
  const { root } = projectRoom(t);
  const rest = (env, workerEnv) => startSteering({ root, env: { ...ENV, ...env }, workerEnv, now: NOW, plays: [] }).rest(['claude', 'codex']);

  // The launching side approves a paid model. A sealed worker carries no approval, so its hook would stop the run.
  const approvedHere = { ATRIS_RUNNER_MODEL: PAID, ATRIS_CLAUDE_SPEND_OK: PAID };
  assert.deepEqual(rest(approvedHere).ready, ['claude', 'codex'], 'a worker that inherits the approval may run it');
  const sealedNoApproval = rest(approvedHere, {});
  assert.deepEqual(sealedNoApproval.ready, ['codex'], 'a worker with no approval would be stopped');
  assert.equal(sealedNoApproval.note, STOPPED);

  // The launching side has a pay-per-use key. A sealed worker has it stripped, so nothing would stop it.
  const keyedHere = { ATRIS_RUNNER_MODEL: 'claude-haiku-5-5', ANTHROPIC_API_KEY: 'sk-test-not-real' };
  assert.deepEqual(rest(keyedHere).ready, ['codex'], 'a worker that inherits the key is stopped');
  assert.deepEqual(rest(keyedHere, { ANTHROPIC_API_KEY: '' }).ready, ['claude', 'codex'], 'a worker with the key stripped is not');

  // The model still comes from the launching side: the worker's environment has none of it.
  assert.deepEqual(rest({ ATRIS_RUNNER_MODEL: PAID }, { ATRIS_RUNNER_MODEL: 'claude-haiku-5-5' }).ready, ['codex'], 'what the worker could be told does not change the --model the launch builds');
});

test('spend guard: the fleet\'s own launch is judged by the --model it passes, through the model remaps the worker really gets', (t) => {
  const { root } = projectRoom(t);
  const REMAP = { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-opus-5-5' };
  const ask = (env, workerEnv) => startSteering({ root, env: { ...ENV, ...env }, ...(workerEnv ? { workerEnv } : {}), now: NOW, plays: [] }).rest(['claude', 'codex']);
  const OPUS_LINE = 'left out, not ready: claude (paid model claude-opus-5-5, no spend approval)';

  // The fleet really does pass the bare name, and the program reads `haiku` through ANTHROPIC_DEFAULT_HAIKU_MODEL.
  assert.equal(launchedModel('claude', { ATRIS_RUNNER_MODEL: 'haiku' }), 'haiku');
  assert.deepEqual(ask({ ATRIS_RUNNER_MODEL: 'haiku' }).ready, ['claude', 'codex'], '--model haiku is free');
  const remapped = ask({ ATRIS_RUNNER_MODEL: 'haiku', ...REMAP });
  assert.deepEqual(remapped.ready, ['codex'], 'but not where the worker maps haiku to Opus');
  assert.equal(remapped.note, OPUS_LINE);
  // The environment the worker gets decides, not the launching side's.
  assert.equal(ask({ ATRIS_RUNNER_MODEL: 'haiku' }, REMAP).note, OPUS_LINE, 'a remap only the worker has');
  assert.deepEqual(ask({ ATRIS_RUNNER_MODEL: 'haiku', ...REMAP }, fleet.SEALED_WORKER_GUARD_ENV).ready, ['claude', 'codex'], 'a sealed worker is given none, whatever the launching side has');
  // The yes is for the model it maps to.
  assert.deepEqual(ask({ ATRIS_RUNNER_MODEL: 'haiku', ...REMAP, ATRIS_CLAUDE_SPEND_OK: 'claude-opus-5-5' }).ready, ['claude', 'codex']);
  assert.equal(ask({ ATRIS_RUNNER_MODEL: 'haiku', ...REMAP, ATRIS_CLAUDE_SPEND_OK: 'claude-opus-5-5' }, fleet.SEALED_WORKER_GUARD_ENV).note, '', 'and the sealed worker has no remap to approve');
});

test('spend guard: a launch with no --model is judged on ANTHROPIC_MODEL in the worker\'s environment, never on a setting of the operator\'s', (t) => {
  const { root, home } = projectRoom(t);
  // A launch of the claude program with no --model: another engine's own launch, with claude as the runner program.
  const NO_FLAG = { ATRIS_RUNNER_BIN: 'claude' };
  assert.equal(launchedModel('devin', NO_FLAG), '', 'the launch really carries no model');
  assert.deepEqual(launchFor('devin', { env: { ...ENV, ...NO_FLAG } }), { engine: 'devin', bin: 'claude', model: '' });
  const ask = (env, workerEnv) => startSteering({ root, env: { ...ENV, ...NO_FLAG, ...env }, ...(workerEnv ? { workerEnv } : {}), now: NOW, plays: [] }).rest(['devin']);
  const stopped = (model) => `left out, not ready: devin (paid model ${model}, no spend approval)`;
  const SEALED = fleet.SEALED_WORKER_GUARD_ENV;

  // The worker's environment names Haiku, so that is the model.
  assert.deepEqual(ask({}, { ANTHROPIC_MODEL: 'claude-haiku-5-5' }).ready, ['devin']);
  assert.deepEqual(ask({ ANTHROPIC_MODEL: 'claude-haiku-5-5' }).ready, ['devin'], 'a plain worker has the launching side\'s environment');
  // An operator setting alone is not the worker's: a sealed worker is given none, and falls back to the paid default.
  const operator = ask({ ANTHROPIC_MODEL: 'claude-haiku-5-5' }, SEALED);
  assert.deepEqual(operator.ready, []);
  assert.equal(operator.note, stopped('default'));
  assert.equal(ask({}, SEALED).note, stopped('default'), 'and with nothing set anywhere, the same');
  // A paid model in the worker's environment is that model, and a yes for it lets it through.
  assert.equal(ask({}, { ANTHROPIC_MODEL: PAID }).note, stopped(PAID));
  assert.deepEqual(ask({}, { ANTHROPIC_MODEL: PAID, ATRIS_CLAUDE_SPEND_OK: PAID }).ready, ['devin']);
  // The name haiku is read through the remap the worker has.
  assert.deepEqual(ask({}, { ANTHROPIC_MODEL: 'haiku' }).ready, ['devin']);
  assert.equal(ask({}, { ANTHROPIC_MODEL: 'haiku', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-opus-5-5' }).note, stopped('claude-opus-5-5'));

  // No settings file is read, from any home: the operator's say Haiku, and neither a plain worker nor a sealed one gets that.
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'claude-haiku-5-5' }));
  assert.equal(ask({ HOME: home }).note, stopped('default'), 'a plain worker whose home says Haiku');
  assert.equal(ask({ HOME: home }, { HOME: home }).note, stopped('default'));
  assert.equal(ask({ HOME: home }, SEALED).note, stopped('default'), 'a sealed worker, from a launching side whose home says Haiku');
  assert.equal(ask({}, { HOME: home, ANTHROPIC_MODEL: PAID }).note, stopped(PAID), 'and the environment is still read first');
});

// A command template somebody wrote is never read for its model. It can start anything with anything: a model in it may
// be a flag, a word of the prompt, another command's, or one the shell works out only when it runs. The picker counts
// it as a model nobody can tell, and a model nobody can tell counts as paid, so claude sits out of an unattended flight
// unless the paid default is approved, and one line says it could not tell. The guard's hook stays the real guard on
// the run; the picker only avoids choosing an engine the hook would refuse.
const CANNOT_TELL = 'left out, not ready: claude (could not tell which model its custom launch template uses, so it counts as paid, and there is no spend approval)';
const templated = (template, extra = {}) => ({ ATRIS_RUNNER_COMMAND_TEMPLATE: template, ...extra });

test('spend guard: a custom launch template is never read for its model, so claude sits out and one line says it could not tell', (t) => {
  const { root, home } = projectRoom(t);
  // The operator's own Claude settings say Haiku. A worker with a home of its own does not get them.
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'haiku' }));
  const ask = (env, workerEnv) => startSteering({ root, env: { ...ENV, HOME: home, ...env }, ...(workerEnv ? { workerEnv } : {}), now: NOW, plays: [] }).rest(['claude', 'codex']);
  const out = (said, why) => {
    assert.deepEqual(said.ready, ['codex'], why);
    assert.equal(said.note, CANNOT_TELL, why);
  };

  // One: the shell works out the model when the command runs, and it is Opus. The environment says Haiku.
  out(ask(templated('{bin} -p x --model $(printf %s op us)', { ANTHROPIC_MODEL: 'haiku' })), 'a model the shell works out');
  // Two: the word after -p is the prompt, not a model.
  out(ask(templated('{bin} -p {model}')), 'a slot that is a prompt word');
  // Three: no model flag at all. A sealed worker falls back to the paid default whatever the operator's settings say.
  out(ask(templated('{bin} -p {prompt}'), fleet.SEALED_WORKER_GUARD_ENV), 'a sealed worker with no model flag');
  out(ask(templated('{bin} -p {prompt}')), 'and a plain one');
  // A model typed into the template is not read either: paid or Haiku, and the line does not name one.
  for (const rest of [`--model ${PAID}`, '--model claude-haiku-5-5', `--model=${PAID}`, '--model haiku', `--model ${PAID}; echo --model claude-haiku-5-5`, '--model "$MODEL"']) {
    out(ask(templated(`{bin} -p {prompt} ${rest}`)), rest);
    out(ask(templated(`{bin} -p {prompt} ${rest}`, { ATRIS_RUNNER_MODEL: 'claude-haiku-5-5', ANTHROPIC_MODEL: 'claude-haiku-5-5' })), `${rest}, with Haiku everywhere else`);
  }
  // The older variable is a custom template too.
  out(ask({ ATRIS_CLAUDE_COMMAND_TEMPLATE: '{bin} -p {prompt} --model claude-haiku-5-5' }), 'the older variable');
  // Engines that are not the claude program are not asked: codex has the same template and stays.
  assert.deepEqual(ask(templated('{bin} -p {prompt}')).resting.map((entry) => entry.name), ['claude']);
  // Without the template the same environment is free.
  assert.deepEqual(ask({ ATRIS_RUNNER_MODEL: 'claude-haiku-5-5' }).ready, ['claude', 'codex']);
});

test('spend guard: only an approval of the paid default covers a launch nobody can read, and a pay-per-use key still stops it for its own reason', (t) => {
  const { root } = projectRoom(t);
  const ask = (extra, workerEnv) => startSteering({ root, env: { ...ENV, ...templated('{bin} -p {prompt} --model claude-haiku-5-5', extra) }, ...(workerEnv ? { workerEnv } : {}), now: NOW, plays: [] }).rest(['claude', 'codex']);

  // An approval is for a model. A model nobody can tell is covered by none of the ones named.
  assert.deepEqual(ask({ ATRIS_CLAUDE_SPEND_OK: PAID }).ready, ['codex']);
  assert.deepEqual(ask({ ATRIS_CLAUDE_SPEND_OK: 'claude-opus-5-5,claude-sonnet-5-5,claude-fable-5-1' }).ready, ['codex']);
  assert.equal(ask({ ATRIS_CLAUDE_SPEND_OK: PAID }).note, CANNOT_TELL);
  // What it counts as is the paid default, so an owner who approves that has covered it.
  assert.deepEqual(ask({ ATRIS_CLAUDE_SPEND_OK: 'default' }).ready, ['claude', 'codex']);
  assert.deepEqual(ask({ ATRIS_CLAUDE_SPEND_OK: `${PAID},default` }).ready, ['claude', 'codex']);
  // A sealed worker is given no approval, whatever the launching side has.
  assert.deepEqual(ask({ ATRIS_CLAUDE_SPEND_OK: 'default' }, fleet.SEALED_WORKER_GUARD_ENV).ready, ['codex']);
  assert.deepEqual(ask({}, { ATRIS_CLAUDE_SPEND_OK: 'default' }).ready, ['claude', 'codex'], 'the worker\'s environment is the one that counts');
  // The worker's own ANTHROPIC_MODEL says nothing about a launch that may carry its own flag.
  assert.deepEqual(ask({ ANTHROPIC_MODEL: 'claude-haiku-5-5' }).ready, ['codex']);
  assert.deepEqual(ask({}, { ANTHROPIC_MODEL: 'claude-haiku-5-5' }).ready, ['codex']);
  // A pay-per-use key stops the engine whatever the template says, and the template is not blamed for it.
  const keyed = ask({ ATRIS_CLAUDE_SPEND_OK: 'default', ANTHROPIC_API_KEY: 'sk-test-not-real' });
  assert.deepEqual(keyed.ready, ['codex']);
  assert.equal(keyed.note, 'left out, not ready: claude (a pay-per-use Claude key is set)');
  assert.deepEqual(ask({ ATRIS_CLAUDE_SPEND_OK: 'default', ANTHROPIC_API_KEY: 'sk-test-not-real', ATRIS_CLAUDE_KEY_OK: '1' }).ready, ['claude', 'codex']);
});

// ---------------------------------------------------------------------------
// Engine lists a caller names are never filtered: not on the first pick, not on a retry.

test('a list a caller names is never filtered: resting and spend-stopped engines stay, on the first pick and on a retry', (t) => {
  const { root } = projectRoom(t);
  registry.setEngineHealth('codex', 'credit_out', root);
  const env = paid();
  const open = startSteering({ root, env, now: NOW, plays: CLAUDE_STRONG });
  assert.deepEqual(open.rest(['claude', 'codex']).ready, [], 'an open list drops claude (paid model) and codex (out of credit)');

  const list = [job(1), job(2)];
  const held = startSteering({ root, env, now: NOW, plays: CLAUDE_STRONG, named: true });
  assert.deepEqual(held.rest(['claude', 'codex']), { ready: ['claude', 'codex'], resting: [], note: '' }, 'a retry asks and nothing is dropped');
  assert.deepEqual(held.rest(['codex']).ready, ['codex'], 'the only permitted backup stays');
  const dealt = held.deal(turns(list), POOL);
  assert.deepEqual(dealt.ready, POOL, 'the first pick keeps every engine too');
  assert.deepEqual(dealt.notes, []);
  assert.equal(held.next(job(3), held.rest(['codex']).ready).engine, 'codex', 'a retry can land on the engine the caller listed');

  // A list that is not named is dealt over the ready engines, and a caller can still ask for either behavior.
  assert.deepEqual(open.deal(turns(list), POOL).ready, []);
  assert.deepEqual(startSteering({ root, env, now: NOW, plays: CLAUDE_STRONG, named: true }).deal(turns(list), POOL, { filter: true }).ready, [], 'filter: true is still a choice a caller can make');
});

// ---------------------------------------------------------------------------
// A job assigned to a member goes where the member commands' own resolver sends that member.

test('explicit: the engine for an assigned member is exactly what the member commands\' resolver names, whatever state the roster is in', (t) => {
  const { root } = projectRoom(t, { closer: 'codex' });
  const { memberRosterEngine } = require('../lib/member-engine');
  const list = [assigned(1, 'closer')];
  const ask = () => startSteering({ root, env: ENV, now: Date.now(), plays: CODEX_STRONG }).deal(turns(list), POOL).entries[0].engine;
  const states = [[], [['codex', 'credit_out']], [['codex', 'ready'], ['claude', 'credit_out']], [['claude', 'ready']]];
  const seen = new Set();
  for (const changes of states) {
    for (const [engine, health] of changes) registry.setEngineHealth(engine, health, root);
    const theirs = memberRosterEngine('closer', root);
    assert.ok(theirs && theirs.engine && theirs.engine.id, 'the resolver names an engine');
    assert.equal(ask(), theirs.engine.id, `${JSON.stringify(changes)}: the fleet agrees with the rest of the CLI`);
    seen.add(theirs.engine.id);
  }
  assert.deepEqual([...seen].sort(), ['claude', 'codex'], 'the roster did move the member, and the job followed it both ways');
});
