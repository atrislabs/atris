'use strict';
require('./helpers/clean-temp');

// One screen for the owner: atris brief prints what needs a person, what landed
// this week, and the team, all read from the task store without writing to it.
//
// The scratch workspace below has its own task db, a GitHub origin, and one job
// of every kind the screen has to sort. The db keeps the default journal mode,
// so a read-only look cannot leave a side file behind and the whole store
// folder can be compared before and after.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createScratchCli } = require('./helpers/scratch-cli');
const { hasNodeSqlite } = require('./helpers/node-sqlite');
const { atrisRating } = require('../lib/atris-rating');
const {
  buildBriefData,
  briefCommand,
  handleBriefAnswer,
  renderBriefHtml,
  shouldPromptBrief,
} = require('../commands/brief');

const runCli = createScratchCli(60000);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.now();
const ago = (days, hours = 0) => NOW - days * DAY - hours * HOUR;
const iso = (ms) => new Date(ms).toISOString();
const sha = (seed) => crypto.createHash('sha1').update(seed).digest('hex');
const HAS_SQLITE = hasNodeSqlite({ NODE_NO_WARNINGS: '1' });

const REPO = 'https://github.com/acme/widgets';
const pullUrl = (n) => `${REPO}/pull/${n}`;
const commitUrl = (seed) => `${REPO}/commit/${sha(seed)}`;

// ---- a scratch store ---------------------------------------------------------

function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
}

function makeWorkspace(prefix, origin) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const ws = path.join(root, 'widgets');
  fs.mkdirSync(ws);
  fs.mkdirSync(path.join(root, 'home'));
  git(ws, ['init', '-q']);
  if (origin) git(ws, ['remote', 'add', 'origin', origin]);
  return { root, ws, home: path.join(root, 'home'), dbPath: path.join(root, 'store', 'tasks.db'), stateDir: path.join(root, 'state') };
}

function openStore(dbPath, ws) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', tag TEXT,
      workspace_root TEXT NOT NULL, source_key TEXT, claimed_by TEXT, claimed_at INTEGER, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, done_at INTEGER, metadata TEXT);
    CREATE TABLE task_events (event_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, version INTEGER NOT NULL,
      workspace_root TEXT NOT NULL, actor TEXT, event_type TEXT NOT NULL, payload TEXT, created_at INTEGER NOT NULL);
  `);
  const insertTask = db.prepare('INSERT INTO tasks (id, title, status, tag, workspace_root, claimed_by, claimed_at, created_at, updated_at, done_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insertEvent = db.prepare('INSERT INTO task_events (event_id, task_id, version, workspace_root, actor, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const versions = new Map();
  let seq = 0;
  return {
    task({ id, title, status = 'open', tag = null, claimedBy = null, claimedAt = null, createdAt, updatedAt, doneAt = null, metadata = {} }) {
      insertTask.run(id, title, status, tag, ws, claimedBy, claimedBy ? (claimedAt || createdAt) : null, createdAt, updatedAt || createdAt, doneAt, JSON.stringify(metadata));
    },
    event(taskId, type, actor, payload, at) {
      const version = (versions.get(taskId) || 0) + 1;
      versions.set(taskId, version);
      seq += 1;
      insertEvent.run(`E${seq}`, taskId, version, ws, actor, type, JSON.stringify(payload || {}), at);
    },
    close() { db.close(); },
  };
}

// A job that landed. The builder's own ready names the merge on the job and on
// its proof: a merged pull request keeps its number and link, a direct commit
// keeps only the commit. `old` is the shape older data used, a bare merge commit
// with no pull request record.
function landed(store, { id, title, member, tag, at, status = 'done', pr = null, prUrl = true, old = false, commit = sha(id) }) {
  const merge = { state: 'merged', merge_commit: commit, merged_at: iso(at), ...(pr ? { number: pr, ...(prUrl ? { url: pullUrl(pr) } : {}) } : {}) };
  store.task({
    id, title, status, tag, claimedBy: member, claimedAt: at - 6 * HOUR, createdAt: at - 7 * HOUR, updatedAt: at, doneAt: status === 'done' ? at : null,
    metadata: old ? { merge_commit: commit } : { merge_commit: commit, pull_request: merge },
  });
  store.event(id, 'claimed', member, { claimed_by: member }, at - 6 * HOUR);
  store.event(id, 'proof_ready', member, old
    ? { proof: 'checks pass', landing: { merge_commit: commit } }
    : { proof: 'checks pass', landing: { merge_commit: commit }, pull_request: merge }, at);
}

// A job a person accepted with no merge on record. The rating counts that as a landing.
function accepted(store, { id, title, member, tag, at }) {
  store.task({ id, title, status: 'done', tag, claimedBy: member, claimedAt: at - 6 * HOUR, createdAt: at - 7 * HOUR, updatedAt: at, doneAt: at });
  store.event(id, 'claimed', member, { claimed_by: member }, at - 6 * HOUR);
  store.event(id, 'completed', 'keshavrao', { status: 'done', action: 'accepted' }, at);
}

// A job a builder let go, with the reason it gave.
function dropped(store, { id, title, member, tag = null, at, reason }) {
  store.task({ id, title, status: 'open', tag, createdAt: at - 3 * HOUR, updatedAt: at });
  store.event(id, 'claimed', member, { claimed_by: member }, at - 2 * HOUR);
  store.event(id, 'claim_released', member, { released_by: member, previous_claimed_by: member, ...(reason ? { reason } : {}) }, at);
}

// Work that is finished and waits for a person: status review, a pull request open.
function held(store, { id, title, member, tag = null, at, pullRequest }) {
  store.task({
    id, title, status: 'review', tag, claimedBy: member, claimedAt: at - 4 * HOUR, createdAt: at - 5 * HOUR, updatedAt: at,
    metadata: { pull_request: pullRequest, approval_status: 'pending' },
  });
  store.event(id, 'claimed', member, { claimed_by: member }, at - 4 * HOUR);
  store.event(id, 'proof_ready', member, { proof: 'checks pass', pull_request: pullRequest }, at - 1000);
}

// A landing written by hand: `payload` is what the builder's ready event carries.
function landedWith(store, { id, title, member = 'fleet-codex', tag = 'x', at, payload }) {
  store.task({ id, title, status: 'done', tag, claimedBy: member, claimedAt: at - HOUR, createdAt: at - 2 * HOUR, updatedAt: at, doneAt: at });
  store.event(id, 'claimed', member, { claimed_by: member }, at - HOUR);
  store.event(id, 'proof_ready', member, { proof: 'checks pass', ...payload }, at);
}

// A finished job whose proof could not be saved: the flight let go of the claim and
// kept the open pull request on the release, so the job itself is back to open.
function proofNotSaved(store, { id, title, member, tag = null, at, pullRequest, status = 'open', claimedBy = null }) {
  store.task({ id, title, status, tag, claimedBy, createdAt: at - 5 * HOUR, updatedAt: at });
  store.event(id, 'claimed', member, { claimed_by: member }, at - 4 * HOUR);
  store.event(id, 'claim_released', member, {
    released_by: member,
    previous_claimed_by: member,
    reason: `The pull request is open but its proof could not be saved (${id})`,
    kind: 'proof_not_saved',
    pull_request: pullRequest,
  }, at);
}

// A claim the flight let go before the engine ran, because the build machine could
// not start the job. Nothing was built.
function couldNotStart(store, { id, title, member, tag = null, at }) {
  store.task({ id, title, status: 'open', tag, createdAt: at - 3 * HOUR, updatedAt: at });
  store.event(id, 'claimed', member, { claimed_by: member }, at - 2 * HOUR);
  store.event(id, 'claim_released', 'fleet-flight', {
    released_by: 'fleet-flight', previous_claimed_by: member, reason: 'the build machine had no room left', kind: 'could_not_start',
  }, at);
}

// A job a person sent back once per note, the last note at the last `at`.
function sentBack(store, { id, title, member, claimedAt, notes, status = 'claimed' }) {
  const lastAt = notes[notes.length - 1].at;
  store.task({
    id, title, status, claimedBy: member, claimedAt, createdAt: claimedAt - HOUR, updatedAt: lastAt,
    metadata: { human_revision_count: notes.length, human_revision_note: notes[notes.length - 1].note },
  });
  store.event(id, 'claimed', member, { claimed_by: member }, claimedAt);
  notes.forEach(({ at, note }, i) => {
    store.event(id, 'proof_ready', member, { proof: 'checks pass' }, at - 12 * HOUR);
    store.event(id, 'revision_requested', 'keshavrao', { note, approval_status: 'revise', revision_count: i + 1 }, at);
  });
}

const TITLES = {
  heldOpen: 'Add a refund button to the orders page',
  heldNumberOnly: 'Show order totals in the email receipt',
  sentBackTwice: 'Make the nightly report faster',
  sentBackOnce: 'Update the onboarding copy',
  refusedReleased: 'Change how invoices are rounded',
  refusedFailed: 'Rotate the payments webhook secret',
  protectedInProgress: 'Update the deploy checklist',
  decision: 'Approve the refund policy wording',
  landedPr: 'Fix the checkout total rounding',
  landedPrTwo: 'Speed up the report export',
  landedPrThree: 'Add dark mode to the settings page',
  landedCommit: 'Tidy the release notes script',
  landedOldShape: 'Cut the signup form to three fields',
  landedAccepted: 'Reword the welcome email',
  landedJustOutside: 'Remove the old promo banner',
  landedOld: 'Retire the legacy importer',
  doneNotAccepted: 'Archive the old exports',
};

const MISS_TESTS = 'tests failed';
const MISS_BUILD = 'the build broke';
const PAUSED = 'paused at ship: the branch was pushed, but no pull request link came back for the protected billing lane';

function seedScenario(store) {
  // landed in the last 7 days
  landed(store, { id: 'L2', title: TITLES.landedCommit, member: 'fleet-sonnet', tag: 'tooling', at: ago(1) });
  accepted(store, { id: 'A1', title: TITLES.landedAccepted, member: 'fleet-cursor', tag: 'email', at: ago(1, 12) });
  landed(store, { id: 'L1', title: TITLES.landedPr, member: 'fleet-codex', tag: 'backend', at: ago(2), status: 'review', pr: 40 });
  landed(store, { id: 'C5', title: TITLES.landedPrTwo, member: 'fleet-codex', tag: 'backend', at: ago(3), pr: 38 });
  landed(store, { id: 'C6', title: TITLES.landedPrThree, member: 'fleet-codex', tag: 'frontend', at: ago(4), pr: 37, prUrl: false });
  landed(store, { id: 'C7', title: TITLES.landedOldShape, member: 'fleet-codex', tag: 'backend', at: ago(6, 23), old: true });
  // landed just outside the week, and 9 days ago
  landed(store, { id: 'L4', title: TITLES.landedJustOutside, member: 'fleet-gemini', tag: 'docs', at: ago(7, 1) });
  landed(store, { id: 'L3', title: TITLES.landedOld, member: 'fleet-gemini', tag: 'backend', at: ago(9), pr: 31 });
  landed(store, { id: 'G1', title: 'Clean up unused flags', member: 'fleet-gemini', tag: 'docs', at: ago(12) });
  landed(store, { id: 'G2', title: 'Rename the sync helper', member: 'fleet-gemini', tag: 'docs', at: ago(15) });
  // older history, so the rating a week ago was different
  landed(store, { id: 'C1', title: 'Add retry to the uploader', member: 'fleet-codex', tag: 'backend', at: ago(22) });
  dropped(store, { id: 'C2', title: 'Trim the log noise', member: 'fleet-codex', at: ago(21), reason: MISS_TESTS });
  dropped(store, { id: 'C3', title: 'Cache the price list', member: 'fleet-codex', at: ago(20), reason: MISS_TESTS });
  dropped(store, { id: 'C4', title: 'Split the big settings file', member: 'fleet-codex', at: ago(19), reason: MISS_TESTS });
  ['one', 'two', 'three', 'four'].forEach((word, i) => landed(store, { id: `SN${i + 1}`, title: `Add the ${word} report column`, member: 'fleet-sonnet', tag: 'api', at: ago(20 - i) }));
  // misses since then
  dropped(store, { id: 'D1', title: 'Bump the image size limit', member: 'fleet-sonnet', at: ago(5), reason: MISS_BUILD });
  dropped(store, { id: 'D2', title: 'Fix the date picker', member: 'fleet-sonnet', at: ago(4), reason: MISS_BUILD });
  dropped(store, { id: 'D3', title: 'Move the cron schedule', member: 'fleet-sonnet', at: ago(3), reason: MISS_BUILD });

  // waiting on a person
  held(store, { id: 'H2', title: TITLES.heldNumberOnly, member: 'fleet-sonnet', tag: 'email', at: ago(1, 6), pullRequest: { state: 'open', number: 13 } });
  held(store, { id: 'H1', title: TITLES.heldOpen, member: 'fleet-codex', tag: 'frontend', at: ago(3), pullRequest: { state: 'open', number: 12, url: pullUrl(12) } });
  sentBack(store, {
    id: 'S1', title: TITLES.sentBackTwice, member: 'fleet-cursor', claimedAt: ago(11),
    notes: [{ at: ago(8), note: 'numbers look wrong' }, { at: ago(5), note: 'still wrong' }],
  });
  sentBack(store, { id: 'S3', title: TITLES.sentBackOnce, member: 'fleet-sonnet', claimedAt: ago(6), notes: [{ at: ago(2), note: 'shorter please' }] });
  dropped(store, { id: 'P1', title: TITLES.refusedReleased, member: 'fleet-cursor', tag: 'billing', at: ago(4), reason: PAUSED });
  store.task({ id: 'P2', title: TITLES.refusedFailed, status: 'failed', tag: 'payments', claimedBy: 'fleet-sonnet', claimedAt: ago(3), createdAt: ago(3, 2), updatedAt: ago(2) });
  store.event('P2', 'claimed', 'fleet-sonnet', { claimed_by: 'fleet-sonnet' }, ago(3));
  store.event('P2', 'blocked', 'fleet-sonnet', { status: 'failed', action: 'failed' }, ago(2));
  // a protected job a builder is still working on: nobody has refused it and it waits on no one
  store.task({ id: 'P3', title: TITLES.protectedInProgress, status: 'claimed', tag: 'deploy', claimedBy: 'fleet-codex', claimedAt: ago(1), createdAt: ago(1, 2), updatedAt: ago(1) });
  store.event('P3', 'claimed', 'fleet-codex', { claimed_by: 'fleet-codex' }, ago(1));
  // finished by the builder and never accepted: not a landing
  store.task({ id: 'X1', title: TITLES.doneNotAccepted, status: 'done', claimedBy: 'fleet-cursor', claimedAt: ago(2, 3), createdAt: ago(2, 4), updatedAt: ago(2), doneAt: ago(2) });
  store.event('X1', 'claimed', 'fleet-cursor', { claimed_by: 'fleet-cursor' }, ago(2, 3));
  store.event('X1', 'completed', 'fleet-cursor', { status: 'done', action: 'done' }, ago(2));
}

// The decision items brief already shows come from the task projection file.
function writeProjection(ws, tasks) {
  const dir = path.join(ws, '.atris', 'state');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'tasks.projection.json'), JSON.stringify({ tasks }));
}

let scenarioCache = null;
function scenario() {
  if (scenarioCache) return scenarioCache;
  const scn = makeWorkspace('atris-brief-owner-', 'git@github.com:acme/widgets.git');
  const store = openStore(scn.dbPath, scn.ws);
  seedScenario(store);
  store.close();
  writeProjection(scn.ws, [
    { id: 'D-decision', display_id: 'CLI-9', title: TITLES.decision, status: 'review', tag: 'customer', updated_at: iso(ago(3, 12)) },
    { id: 'H1', display_id: 'CLI-1', title: TITLES.heldOpen, status: 'review', updated_at: iso(ago(3)), metadata: { pull_request: { state: 'open', number: 12, url: pullUrl(12) } } },
  ]);
  scenarioCache = scn;
  return scn;
}

// ---- running the command -----------------------------------------------------

async function withEnv(env, fn) {
  const saved = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    process.env[key] = env[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

async function captured(fn) {
  const originalLog = console.log;
  let out = '';
  console.log = (...args) => { out += `${args.join(' ')}\n`; };
  try {
    const code = await fn();
    return { code, out };
  } finally {
    console.log = originalLog;
  }
}

function runBrief(scn, args = [], extraEnv = {}) {
  return withEnv({ ATRIS_TASKS_DB: scn.dbPath, ATRIS_TEST_STATE_DIR: scn.stateDir, ...extraEnv }, () =>
    captured(() => briefCommand(['--no-input', ...args], scn.ws, { stdin: { isTTY: false }, stdout: { isTTY: false } })));
}

function spawnBrief(scn, args) {
  return runCli(['brief', '--no-input', ...args], {
    cwd: scn.ws,
    env: { HOME: scn.home, ATRIS_TASKS_DB: scn.dbPath, ATRIS_TEST_STATE_DIR: scn.stateDir },
  });
}

function sections(text) {
  const out = {};
  let current = null;
  for (const line of text.split('\n')) {
    const heading = line.match(/^(Needs you|Done this week|Team)\b/);
    if (heading) { current = heading[1]; out[current] = []; continue; }
    if (current) out[current].push(line);
  }
  return Object.fromEntries(Object.entries(out).map(([name, lines]) => [name, lines.join('\n')]));
}

// Everything in the store folder: names and content hashes.
function snapshot(dir) {
  return fs.readdirSync(dir).sort().map((name) => `${name}:${crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex')}`);
}

function positions(text, titles) {
  return titles.map((title) => text.indexOf(title));
}

// One item's lines on the screen: its title line down to the next item or blank line.
function itemLines(section, title) {
  const lines = section.split('\n');
  const start = lines.findIndex((line) => line.includes(title));
  assert.ok(start >= 0, `${title} is on the screen`);
  let end = start + 1;
  while (end < lines.length && lines[end].trim() !== '' && !/^(\d+\.|-) /.test(lines[end])) end += 1;
  return lines.slice(start, end).join('\n');
}

// A store in its own workspace, filled in by `fill`, with a GitHub origin unless told otherwise.
function workspaceWith(prefix, fill, origin = 'git@github.com:acme/widgets.git') {
  const scn = makeWorkspace(prefix, origin);
  const store = openStore(scn.dbPath, scn.ws);
  fill(store);
  store.close();
  return scn;
}

// What the owner screen says for a store, as json, read through the real builder.
function ownerData(scn, { now = NOW } = {}) {
  return withEnv({ ATRIS_TASKS_DB: scn.dbPath, ATRIS_TEST_STATE_DIR: scn.stateDir }, () => {
    const { buildOwnerBrief } = require('../lib/owner-brief');
    return buildOwnerBrief(scn.ws, { now });
  });
}

// ---- the screen --------------------------------------------------------------

test('the screen sorts every kind of job into the right part with the right link', { skip: !HAS_SQLITE }, async () => {
  const scn = scenario();
  const trap = path.join(scn.root, 'trap-bin');
  const marker = path.join(scn.root, 'network-was-touched');
  fs.mkdirSync(trap, { recursive: true });
  for (const tool of ['gh', 'curl', 'wget']) {
    fs.writeFileSync(path.join(trap, tool), `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o755 });
  }
  const { code, out } = await runBrief(scn, [], { PATH: `${trap}${path.delimiter}${process.env.PATH}` });
  assert.equal(code, 0);
  const part = sections(out);
  assert.deepEqual(Object.keys(part), ['Needs you', 'Done this week', 'Team']);
  const needs = part['Needs you'];
  const done = part['Done this week'];
  const team = part.Team;

  // held in review with a pull request open: the pull request link, once
  assert.match(needs, new RegExp(TITLES.heldOpen));
  assert.equal(out.split(TITLES.heldOpen).length - 1, 1, 'a job the projection and the store both know is listed once');
  assert.ok(needs.includes(pullUrl(12)));
  assert.match(needs, /waiting for you to merge/i);
  // a pull request with a number and no saved link is not guessed into a link: its number is printed
  assert.match(needs, new RegExp(TITLES.heldNumberOnly));
  assert.ok(!needs.includes(pullUrl(13)), 'a number alone is not turned into a link');
  assert.match(itemLines(needs, TITLES.heldNumberOnly), /pull request 13, but its link was not saved/);
  // sent back twice is listed, sent back once is not
  assert.match(needs, new RegExp(TITLES.sentBackTwice));
  assert.match(needs, /sent back 2 times/i);
  assert.match(needs, /still wrong/);
  assert.ok(!out.includes(TITLES.sentBackOnce));
  // protected jobs a builder let go of or gave up on
  assert.match(needs, new RegExp(TITLES.refusedReleased));
  assert.match(needs, /no pull request link came back/);
  assert.match(needs, /fleet-cursor let go of this protected billing job/);
  const reasonLine = needs.split('\n').find((line) => line.includes('Reason given:'));
  assert.ok(reasonLine.length < 130 && reasonLine.endsWith('..."'), `a long reason is cut at a word and says so: ${reasonLine}`);
  assert.match(needs, new RegExp(TITLES.refusedFailed));
  assert.match(needs, /fleet-sonnet gave up on this protected payments job/);
  assert.ok(!out.includes(TITLES.protectedInProgress), 'a protected job a builder still holds waits on no one');
  // the decision items brief already showed
  assert.match(needs, new RegExp(TITLES.decision));
  assert.match(needs, /protected customer/i);
  // nothing that landed or that a builder merely dropped
  for (const title of [TITLES.landedPr, TITLES.landedCommit, TITLES.landedOld, 'Trim the log noise', 'Fix the date picker']) {
    assert.ok(!needs.includes(title), `${title} does not need a person`);
  }

  // newest first
  const order = positions(needs, [TITLES.heldNumberOnly, TITLES.refusedFailed, TITLES.heldOpen, TITLES.decision, TITLES.refusedReleased, TITLES.sentBackTwice]);
  assert.ok(order.every((at) => at >= 0), `all six are listed: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order);

  // done this week: the merged pull request link, else the commit link, newest first
  assert.match(done, new RegExp(TITLES.landedPr));
  assert.ok(done.includes(pullUrl(40)));
  assert.match(done, /fleet-codex/);
  assert.match(done, new RegExp(TITLES.landedCommit));
  assert.ok(done.includes(commitUrl('L2')));
  assert.match(done, /fleet-sonnet/);
  assert.ok(done.includes(pullUrl(38)));
  assert.ok(!done.includes(pullUrl(37)), 'a pull request number alone is not turned into a link');
  assert.ok(done.includes(commitUrl('C6')), 'its merge commit still gets a link');
  assert.match(itemLines(done, TITLES.landedPrThree), /Pull request 37 has no saved link/);
  assert.match(done, new RegExp(TITLES.landedOldShape));
  assert.ok(done.includes(commitUrl('C7')), 'a job that only saved its merge commit gets a commit link');
  assert.match(done, new RegExp(TITLES.landedAccepted), 'a person accepting a job is a landing in the rating');
  assert.ok(!done.includes(pullUrl(31)));
  for (const title of [TITLES.landedOld, TITLES.landedJustOutside, TITLES.doneNotAccepted]) assert.ok(!done.includes(title), `${title} is not part of this week`);
  const doneOrder = positions(done, [TITLES.landedCommit, TITLES.landedAccepted, TITLES.landedPr, TITLES.landedPrTwo, TITLES.landedPrThree, TITLES.landedOldShape]);
  assert.ok(doneOrder.every((at) => at >= 0), `all six landings are listed: ${doneOrder}`);
  assert.deepEqual([...doneOrder].sort((a, b) => a - b), doneOrder);

  // team: one line per member, arrows against the same rating seven days back
  const lineOf = (name) => team.split('\n').find((line) => line.trimStart().startsWith(name));
  const codex = lineOf('fleet-codex');
  const sonnet = lineOf('fleet-sonnet');
  const gemini = lineOf('fleet-gemini');
  const cursor = lineOf('fleet-cursor');
  for (const line of [codex, sonnet, gemini, cursor]) assert.ok(line, 'every member has a line');
  assert.equal(team.split('\n').filter((line) => /^\s+fleet-/.test(line)).length, 4);
  const codexNow = atrisRating(5, 8);
  const codexThen = atrisRating(1, 4);
  const sonnetNow = atrisRating(5, 9);
  const sonnetThen = atrisRating(4, 4);
  assert.ok(codexNow > codexThen && sonnetNow < sonnetThen);
  assert.match(codex, new RegExp(`\\b${codexNow} ↑${codexNow - codexThen}\\b`));
  assert.match(sonnet, new RegExp(`\\b${sonnetNow} ↓${sonnetThen - sonnetNow}\\b`));
  assert.match(gemini, new RegExp(`\\b${atrisRating(4, 4)} =`));
  // no rating a week ago, so a number and no arrow
  assert.match(cursor, new RegExp(`\\b${atrisRating(1, 3)}\\b`));
  assert.ok(!/[↑↓=]/.test(cursor));
  // best lane is the tag with the most landings, top miss is what atris rating shows
  assert.match(codex, /backend/);
  assert.match(codex, new RegExp(`${MISS_TESTS} \\(3\\)`));
  assert.match(sonnet, /api/);
  assert.match(sonnet, new RegExp(`${MISS_BUILD} \\(3\\)`));
  assert.match(gemini, /docs/);
  assert.match(cursor, /numbers look wrong/);

  // nothing reached for the network
  assert.equal(fs.existsSync(marker), false);
});

test('the same screen comes out of the real command from a scratch folder', { skip: !HAS_SQLITE }, () => {
  const scn = scenario();
  const res = spawnBrief(scn, []);
  assert.equal(res.status, 0, res.stderr);
  const part = sections(res.stdout);
  assert.deepEqual(Object.keys(part), ['Needs you', 'Done this week', 'Team']);
  assert.ok(part['Needs you'].includes(pullUrl(12)));
  assert.ok(part['Done this week'].includes(commitUrl('L2')));
  assert.ok(!res.stdout.includes(TITLES.landedOld));
});

test('--json adds needs_you, done_this_week, and team after the keys it always had', { skip: !HAS_SQLITE }, async () => {
  const scn = scenario();
  const { code, out } = await runBrief(scn, ['--json']);
  assert.equal(code, 0);
  const data = JSON.parse(out);
  const keys = Object.keys(data);
  assert.deepEqual(keys.slice(0, 6), ['schema', 'days', 'landed', 'waiting', 'moves', 'week']);
  for (const added of ['needs_you', 'done_this_week', 'team']) assert.ok(keys.includes(added), `${added} is in the json`);
  assert.equal(data.schema, 'atris.brief.v1');
  assert.equal(data.days, 1);
  // what the projection showed is still there, with the same shape
  assert.deepEqual(data.waiting.map((item) => item.id).sort(), ['CLI-1', 'CLI-9']);
  assert.deepEqual(Object.keys(data.waiting[0]), ['id', 'title', 'why', 'age']);

  assert.deepEqual(data.needs_you.map((item) => item.title), [
    TITLES.heldNumberOnly, TITLES.refusedFailed, TITLES.heldOpen, TITLES.decision, TITLES.refusedReleased, TITLES.sentBackTwice,
  ]);
  const byTitle = (list, title) => list.find((item) => item.title === title);
  assert.equal(byTitle(data.needs_you, TITLES.heldOpen).kind, 'held');
  assert.equal(byTitle(data.needs_you, TITLES.heldOpen).link, pullUrl(12));
  assert.equal(byTitle(data.needs_you, TITLES.heldNumberOnly).link, null);
  assert.equal(byTitle(data.needs_you, TITLES.heldNumberOnly).pull_request, 13);
  assert.equal(byTitle(data.needs_you, TITLES.heldOpen).pull_request, null);
  assert.equal(byTitle(data.needs_you, TITLES.sentBackTwice).kind, 'sent_back');
  assert.equal(byTitle(data.needs_you, TITLES.sentBackTwice).link, null);
  assert.equal(byTitle(data.needs_you, TITLES.refusedReleased).kind, 'refused');
  assert.equal(byTitle(data.needs_you, TITLES.refusedFailed).kind, 'refused');
  assert.equal(byTitle(data.needs_you, TITLES.decision).kind, 'decision');
  assert.equal(byTitle(data.needs_you, TITLES.decision).accept_id, 'CLI-9');
  assert.equal(byTitle(data.needs_you, TITLES.heldOpen).accept_id, null);
  for (const item of data.needs_you) {
    assert.equal(typeof item.why, 'string');
    assert.ok(item.why.length > 0);
    assert.ok(Number.isFinite(item.since));
  }

  assert.deepEqual(data.done_this_week.map((item) => item.title), [
    TITLES.landedCommit, TITLES.landedAccepted, TITLES.landedPr, TITLES.landedPrTwo, TITLES.landedPrThree, TITLES.landedOldShape,
  ]);
  assert.deepEqual(data.done_this_week.map((item) => item.link), [
    commitUrl('L2'), null, pullUrl(40), pullUrl(38), commitUrl('C6'), commitUrl('C7'),
  ]);
  // a pull request with no saved link is named by number instead
  assert.deepEqual(data.done_this_week.map((item) => item.pull_request), [null, null, null, null, 37, null]);
  assert.deepEqual(data.done_this_week.map((item) => item.built_by), [
    'fleet-sonnet', 'fleet-cursor', 'fleet-codex', 'fleet-codex', 'fleet-codex', 'fleet-codex',
  ]);

  const member = (name) => data.team.find((row) => row.member === name);
  assert.equal(member('fleet-codex').rating, atrisRating(5, 8));
  assert.equal(member('fleet-codex').rating_a_week_ago, atrisRating(1, 4));
  assert.equal(member('fleet-codex').trend, 'up');
  assert.equal(member('fleet-sonnet').trend, 'down');
  assert.equal(member('fleet-gemini').trend, 'same');
  assert.equal(member('fleet-cursor').trend, null);
  assert.equal(member('fleet-cursor').rating_a_week_ago, null);
  assert.equal(member('fleet-codex').landed, 5);
  assert.equal(member('fleet-codex').best_lane, 'backend');
  assert.deepEqual(member('fleet-codex').top_miss, { reason: MISS_TESTS, count: 3 });
  assert.equal(member('fleet-gemini').top_miss, null);

  // asked for with no owner option, the builder still returns only what it always did
  assert.deepEqual(Object.keys(buildBriefData(scn.ws, { now: NOW })), ['schema', 'days', 'landed', 'waiting', 'moves', 'week']);
});

test('--days sets the older landed list and leaves this week alone', { skip: !HAS_SQLITE }, async () => {
  const scn = scenario();
  const data = JSON.parse((await runBrief(scn, ['--json', '--days', '3'])).out);
  assert.equal(data.days, 3);
  assert.equal(data.done_this_week.length, 6);
});

test('brief never writes to the task store, in text, json, or html', { skip: !HAS_SQLITE }, async () => {
  const scn = scenario();
  const before = snapshot(path.dirname(scn.dbPath));
  assert.deepEqual(before.map((entry) => entry.split(':')[0]), ['tasks.db']);
  const text = await runBrief(scn);
  assert.ok(text.out.includes(TITLES.heldNumberOnly), 'the screen read the store, not only the projection file');
  const json = await runBrief(scn, ['--json']);
  assert.ok(JSON.parse(json.out).done_this_week.length > 0);
  const html = await runBrief(scn, ['--html']);
  assert.ok(html.out.includes(TITLES.heldNumberOnly));
  assert.equal(spawnBrief(scn, []).status, 0);
  assert.equal(spawnBrief(scn, ['--json']).status, 0);
  assert.deepEqual(snapshot(path.dirname(scn.dbPath)), before, 'the store folder is byte for byte what it was');
});

test('more than ten things waiting prints ten and then and N more', { skip: !HAS_SQLITE }, async () => {
  const scn = makeWorkspace('atris-brief-owner-many-');
  const store = openStore(scn.dbPath, scn.ws);
  for (let i = 1; i <= 12; i += 1) {
    const n = String(i).padStart(2, '0');
    sentBack(store, {
      id: `SB${n}`, title: `Sent back job ${n}`, member: 'fleet-codex', claimedAt: ago(20),
      notes: [{ at: ago(14 - i / 2), note: 'redo' }, { at: ago(13 - i / 2), note: 'redo again' }],
    });
  }
  store.close();
  const { out } = await runBrief(scn);
  const needs = sections(out)['Needs you'];
  assert.equal((needs.match(/^\d+\. /gm) || []).length, 10);
  assert.match(needs, /and 2 more/);
  assert.ok(needs.includes('Sent back job 12'));
  assert.ok(!needs.includes('Sent back job 02'));
  const json = JSON.parse((await runBrief(scn, ['--json'])).out);
  assert.equal(json.needs_you.length, 12);

  // the lines under an item line up with its title, whether the number has one digit or two
  const lines = needs.split('\n');
  const detailIndents = (number) => {
    const at = lines.findIndex((line) => line.startsWith(`${number}. `));
    const titleColumn = lines[at].indexOf('Sent back job');
    const detail = [];
    for (let i = at + 1; i < lines.length && lines[i].trim() !== ''; i += 1) detail.push(lines[i].length - lines[i].trimStart().length);
    return { titleColumn, detail };
  };
  for (const number of [1, 9, 10]) {
    const { titleColumn, detail } = detailIndents(number);
    assert.ok(detail.length >= 2, `item ${number} has detail lines`);
    assert.deepEqual([...new Set(detail)], [titleColumn], `item ${number}: detail lines start under the title`);
  }
  assert.equal(detailIndents(9).titleColumn, 3);
  assert.equal(detailIndents(10).titleColumn, 4);
});

test('an empty workspace gets a plain empty screen and no task store is made', { skip: !HAS_SQLITE }, async () => {
  const scn = makeWorkspace('atris-brief-owner-empty-');
  const { out } = await runBrief(scn);
  const part = sections(out);
  assert.deepEqual(Object.keys(part), ['Needs you', 'Done this week', 'Team']);
  assert.match(part['Needs you'], /nothing is waiting on you/i);
  assert.match(part['Done this week'], /nothing landed/i);
  assert.equal(fs.existsSync(path.dirname(scn.dbPath)), false);
});

test('a store that cannot be read is said plainly instead of shown as a quiet week', { skip: !HAS_SQLITE }, async () => {
  const scn = makeWorkspace('atris-brief-owner-broken-', 'git@github.com:acme/widgets.git');
  fs.mkdirSync(path.dirname(scn.dbPath), { recursive: true });
  fs.writeFileSync(scn.dbPath, 'this is not a database');
  const { code, out } = await runBrief(scn);
  assert.equal(code, 0);
  assert.match(out, /could not read the task list/i);
  const json = JSON.parse((await runBrief(scn, ['--json'])).out);
  assert.equal(typeof json.owner_error, 'string');
  assert.deepEqual(json.needs_you, []);
  assert.equal(fs.readFileSync(scn.dbPath, 'utf8'), 'this is not a database');
});

test('without a GitHub origin only the links a job saved are shown', { skip: !HAS_SQLITE }, async () => {
  const scn = makeWorkspace('atris-brief-owner-nolink-', 'https://gitlab.com/acme/widgets.git');
  const store = openStore(scn.dbPath, scn.ws);
  const saved = 'https://git.example.com/acme/widgets/-/merge_requests/9';
  held(store, { id: 'NA', title: 'Held with a number only', member: 'fleet-codex', at: ago(1), pullRequest: { state: 'open', number: 5 } });
  held(store, { id: 'UA', title: 'Held with a saved link', member: 'fleet-codex', at: ago(2), pullRequest: { state: 'open', url: saved } });
  landed(store, { id: 'LC', title: 'Landed with a commit only', member: 'fleet-codex', tag: 'x', at: ago(1) });
  landed(store, { id: 'LU', title: 'Landed with a saved link', member: 'fleet-codex', tag: 'x', at: ago(2), pr: 8 });
  store.close();
  const data = JSON.parse((await runBrief(scn, ['--json'])).out);
  const link = (list, title) => list.find((item) => item.title === title).link;
  assert.equal(link(data.needs_you, 'Held with a number only'), null);
  assert.equal(link(data.needs_you, 'Held with a saved link'), saved);
  assert.equal(link(data.done_this_week, 'Landed with a commit only'), null);
  assert.equal(link(data.done_this_week, 'Landed with a saved link'), pullUrl(8));
});

test('a saved link never shows a login, and older merge records keep only the link they saved', { skip: !HAS_SQLITE }, async () => {
  const scn = makeWorkspace('atris-brief-owner-links-', 'git@github.com:acme/widgets.git');
  const store = openStore(scn.dbPath, scn.ws);
  held(store, {
    id: 'HL', title: 'Held with a login in its link', member: 'fleet-codex', at: ago(1),
    pullRequest: { state: 'open', url: 'https://someone:s3cret@git.example.com/acme/widgets/pull/9' },
  });
  // older records name the merged pull request on merged_pr: a number, a link, or a record
  const merged = (id, title, mergedPr, at) => {
    store.task({ id, title, status: 'done', tag: 'x', claimedBy: 'fleet-codex', claimedAt: at - HOUR, createdAt: at - 2 * HOUR, updatedAt: at, doneAt: at });
    store.event(id, 'claimed', 'fleet-codex', { claimed_by: 'fleet-codex' }, at - HOUR);
    store.event(id, 'proof_ready', 'fleet-codex', { proof: 'checks pass', merged_pr: mergedPr }, at);
  };
  merged('M1', 'Merged by number', 77, ago(1));
  merged('M2', 'Merged by link', pullUrl(78), ago(2));
  merged('M3', 'Merged by record', { merged: true, number: 79 }, ago(3));
  store.close();
  const raw = (await runBrief(scn, ['--json'])).out;
  assert.ok(!raw.includes('s3cret'), 'a password in a saved link does not reach the screen');
  const data = JSON.parse(raw);
  const link = (list, title) => list.find((item) => item.title === title).link;
  assert.equal(link(data.needs_you, 'Held with a login in its link'), 'https://git.example.com/acme/widgets/pull/9');
  const pullOf = (title) => data.done_this_week.find((item) => item.title === title).pull_request;
  // a number with no saved link and no recorded repository stays a number
  assert.equal(link(data.done_this_week, 'Merged by number'), null);
  assert.equal(pullOf('Merged by number'), 77);
  assert.equal(link(data.done_this_week, 'Merged by link'), pullUrl(78));
  assert.equal(pullOf('Merged by link'), null);
  assert.equal(link(data.done_this_week, 'Merged by record'), null);
  assert.equal(pullOf('Merged by record'), 79);
});

test('words that come from jobs cannot move the cursor or print a long dash', () => {
  const { renderBrief } = require('../commands/brief');
  const esc = String.fromCharCode(27);
  const dash = String.fromCharCode(0x2014);
  const text = renderBrief({
    needs_you: [{ title: `Fix ${esc}[2J the page ${dash} now`, why: `Sent back 2 times and still not done. Last note: "no ${esc}[31m red"`, age: '2 days', link: null, accept_id: null }],
    done_this_week: [{ title: `Ship it ${dash} done`, built_by: 'fleet-codex', age: '1 day', link: null }],
    team: [{ member: 'fleet-codex', rating: 50, trend: null, landed: 1, best_lane: null, top_miss: { reason: `bad ${esc}[1m reason ${dash} here`, count: 1 } }],
  });
  assert.match(text, /^Needs you/);
  const bad = [...text].filter((ch) => {
    const code = ch.charCodeAt(0);
    return (code < 32 && code !== 10) || (code >= 127 && code <= 159) || code === 0x2013 || code === 0x2014;
  });
  assert.deepEqual(bad, []);
});

// ---- titles with a link or a branch name ---------------------------------------

// A person reads a title short and without job plumbing (task codes, file names, shell
// commands). The json is not read that way: it carries each title as the cleaner leaves it (up to 300
// characters, see below). To the shortener a link or a path is one word, kept whole or dropped whole, so a title never
// ends in `feature/` or in `Review https`.
const LINK_TITLE = 'Review https://github.com/acme/node.js/pull/12';
const BRANCH_TITLE = 'Merge feature/ABC-123';
const CODE_TITLE = 'BCK-1234 Tidy the order emails';
const LONG_TITLE = 'Make the nightly export of every customer invoice run in the background so the finance team can keep working while it finishes';
const DONE_LINK_TITLE = 'Close https://github.com/acme/node.js/pull/16';
const DONE_BRANCH_TITLE = 'Ship hotfix/ABC-124';
const DONE_CODE_TITLE = 'BCK-1235 Tidy the invoice emails';

// The text brief --send hands to the phone, caught by a stand-in for the atris binary in the workspace.
function textSentBy(scn) {
  fs.mkdirSync(path.join(scn.ws, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(scn.ws, 'bin', 'atris.js'), "require('fs').writeFileSync(`${process.argv[1]}.sent.json`, JSON.stringify(process.argv.slice(2)));\n");
  fs.mkdirSync(path.join(scn.ws, '.atris', 'policy'), { recursive: true });
  fs.writeFileSync(path.join(scn.ws, '.atris', 'policy', 'autoland.json'), JSON.stringify({ imessage_to: '+15550100' }));
  return runBrief(scn, ['--send']).then(({ code }) => {
    assert.equal(code, 0);
    const argv = JSON.parse(fs.readFileSync(path.join(scn.ws, 'bin', 'atris.js.sent.json'), 'utf8'));
    return argv[argv.indexOf('--text') + 1];
  });
}

test('a title with a link or a branch name is never cut in two, in the text, the json, the page, or the text sent', { skip: !HAS_SQLITE }, async () => {
  const scn = workspaceWith('atris-brief-owner-longtitles-', (store) => {
    const open = (n) => ({ state: 'open', number: n, url: pullUrl(n) });
    held(store, { id: 'TT1', title: LINK_TITLE, member: 'fleet-codex', at: ago(1), pullRequest: open(12) });
    held(store, { id: 'TT2', title: BRANCH_TITLE, member: 'fleet-codex', at: ago(1, 2), pullRequest: open(13) });
    held(store, { id: 'TT3', title: CODE_TITLE, member: 'fleet-sonnet', at: ago(1, 4), pullRequest: open(14) });
    held(store, { id: 'TT4', title: LONG_TITLE, member: 'fleet-sonnet', at: ago(1, 6), pullRequest: open(15) });
    landed(store, { id: 'TT5', title: DONE_LINK_TITLE, member: 'fleet-codex', tag: 'x', at: ago(1), pr: 16 });
    landed(store, { id: 'TT6', title: DONE_BRANCH_TITLE, member: 'fleet-codex', tag: 'x', at: ago(2), pr: 17 });
    landed(store, { id: 'TT7', title: DONE_CODE_TITLE, member: 'fleet-sonnet', tag: 'x', at: ago(3), pr: 18 });
  });
  const data = await briefDataOf(scn);

  // the json carries every title as the cleaner leaves it, a task code and all
  const needTitles = data.needs_you.map((item) => item.title);
  const doneTitles = data.done_this_week.map((item) => item.title);
  for (const title of [LINK_TITLE, BRANCH_TITLE, CODE_TITLE, LONG_TITLE]) assert.ok(needTitles.includes(title), `${title} is whole under needs_you: ${needTitles}`);
  for (const title of [DONE_LINK_TITLE, DONE_BRANCH_TITLE, DONE_CODE_TITLE]) assert.ok(doneTitles.includes(title), `${title} is whole under done_this_week: ${doneTitles}`);

  // the screen, the page, and the text sent show them short and in one piece
  const { out } = await runBrief(scn);
  const sent = await textSentBy(scn);
  const outputs = [['the screen', out], ['the page', renderBriefHtml(data)], ['the text sent', sent]];
  for (const [where, body] of outputs) {
    for (const whole of [LINK_TITLE, BRANCH_TITLE, DONE_LINK_TITLE, DONE_BRANCH_TITLE, 'Tidy the order emails', 'Tidy the invoice emails']) {
      assert.ok(body.includes(whole), `${whole} reached ${where} in one piece`);
    }
    assert.ok(!/Review https(?!:\/\/github\.com\/acme\/node\.js\/pull\/12)/.test(body), `a cut-off scheme reached ${where}`);
    assert.ok(!/Close https(?!:\/\/github\.com\/acme\/node\.js\/pull\/16)/.test(body), `a cut-off scheme reached ${where}`);
    assert.ok(!/(?:feature|hotfix)\/(?!ABC-12[34])/.test(body), `a cut-off branch name reached ${where}`);
    assert.ok(!body.includes('BCK-1234') && !body.includes('BCK-1235'), `a task code on its own reached ${where}`);
    // a long title is kept short
    assert.ok(body.includes('Make the nightly export of every customer'), `the long title reached ${where}`);
    assert.ok(!body.includes(LONG_TITLE), `the long title was not shortened in ${where}`);
  }
  const longLine = out.split('\n').find((line) => line.includes('Make the nightly export'));
  assert.ok(longLine.replace(/^\d+\. /, '').length <= 90, `the long title is on one short line: ${longLine}`);
  assert.ok(LONG_TITLE.startsWith(longLine.replace(/^\d+\. /, '')), 'the short form is the start of the title');
});

// How the screen shows one title: the first line of the first item under Needs you.
function shortOf(title) {
  const { renderBrief } = require('../commands/brief');
  const text = renderBrief({ needs_you: [{ title, why: 'Sent back 2 times.', age: '1 day', link: null, accept_id: null }], done_this_week: [], team: [] });
  return text.split('\n').find((line) => line.startsWith('1. ')).slice(3);
}

test('the shortener keeps or drops a link or a slash path as one word, never a piece of one', () => {
  const { renderBrief } = require('../commands/brief');
  const longLink = `https://github.com/acme/widgets/pull/12/files#diff-${'a'.repeat(100)}`;
  const cases = [
    // a link, a branch, and a path are kept whole
    [LINK_TITLE, LINK_TITLE],
    [BRANCH_TITLE, BRANCH_TITLE],
    ['Merge feature/ABC-123: add the retry', 'Merge feature/ABC-123'],
    ['Merge feature/ABC-123 into release/2.0', 'Merge feature/ABC-123 into release/2.0'],
    ['Review the change at github.com/acme/node.js/pull/12 today', 'Review the change at github.com/acme/node.js/pull/12 today'],
    ['See (https://github.com/acme/node.js/pull/12).', 'See (https://github.com/acme/node.js/pull/12).'],
    ['Upload s3://backups/2026/ABC-123.json tonight', 'Upload s3://backups/2026/ABC-123.json tonight'],
    ['Fix save/load and read/write', 'Fix save/load and read/write'],
    // what is plumbing on its own still goes, the way it always did
    [CODE_TITLE, 'Tidy the order emails'],
    ['Tidy the order emails (BCK-1234)', 'Tidy the order emails'],
    ['Fix the retry in lib/retry.js', 'Fix the retry in'],
    ['Fix the retry in lib/retry.js:42 today', 'Fix the retry in'],
    ['Fix the retry: node --test test/retry.test.js', 'Fix the retry'],
    ['Update data/status.json today', 'Update today'],
    ['Fix the crash in dashboard/code/page.tsx', 'Fix the crash in'],
    ['Fix the crash in App.tsx', 'Fix the crash in'],
    ['Fix src/App.tsx:42:7 now', 'Fix'],
    ['Produce data/a.json, data/b.json, data/c.json, and logs', 'Produce, and logs'],
    ['Update (docs/BCK-1/notes.md) today', 'Update today'],
    ['Check it (lib/engine.js binInstalled and normalize) today', 'Check it (binInstalled and normalize) today'],
    // a file name goes whole, even with a colon or a task code in the middle of it
    ['Update docs/ABC-123:notes/README.md today', 'Update today'],
    ['Fix C:/Users/me/app.js now', 'Fix now'],
    // plumbing inside a link or a path still marks what follows a colon as detail, and a colon inside one is not that colon
    ['Review https://github.com/acme/node.js/pull/12: please check the diff', LINK_TITLE],
    ['Loop health: spawns duplicate ticks (OBL-1471/1473/1474/1475 identical) - add a guard', 'Loop health'],
    ['qa-loop TypeScript type-check: app/start/page.tsx(11,5): error TS1128', 'qa-loop TypeScript type-check'],
    // a link inside plumbing that goes is dropped with it, whole
    ['Retry git push https://github.com/acme/widgets.git, then rebase', 'Retry, then rebase'],
    // a link too long for the line is dropped whole, unless it is all the title there is and fits in twice the room
    [`Review ${longLink}`, 'Review'],
    [longLink, longLink],
    [`https://example.com/${'a'.repeat(300)}`, 'untitled'],
  ];
  for (const [title, expected] of cases) assert.equal(shortOf(title), expected, title);
  for (const [title] of cases) {
    const shown = shortOf(title);
    assert.ok(!shown.endsWith('/') && !/\bhttps?:?$/.test(shown), `${title} ends in a piece of a link or a path: ${shown}`);
  }
  // the older one-line-per-thing brief has the same shortener and never prints a blank title
  const older = renderBrief({ landed: [{ title: `https://example.com/${'a'.repeat(400)}`, proof: 'checks pass', age: '1 day' }], waiting: [], moves: [] });
  assert.ok(older.includes('- untitled | size: 1 task'), older);
});

// ---- a title longer than 300 characters ------------------------------------------------------
//
// The json keeps at most 300 characters of a title, the most the shared scrubber (scrub in
// utils/agent-client.js) lets any text through with. That used to be a cut anywhere, so a link or a path
// that stood across it came out as a piece, and once the task codes before it were taken out on the
// screen the piece was all that showed of it. The cut is made at the last whole word that fits: a word
// that would reach past 300 characters is dropped whole, and so is everything after it.

const CAP = 300;

// The words of a text, single-spaced, as many as fit in the cap: what the json should carry for it.
function wholeWordsWithin(text) {
  let out = '';
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    const next = out ? `${out} ${word}` : word;
    if (next.length > CAP) break;
    out = next;
  }
  return out;
}

// Exactly `length` characters of ordinary words with one space between them.
function prose(length) {
  const words = 'tidy the order emails and check every invoice report before the finance team sees them'.split(' ');
  let out = '';
  for (let i = 0; ; i += 1) {
    const next = out ? `${out} ${words[i % words.length]}` : words[i % words.length];
    if (next.length > length) break;
    out = next;
  }
  if (!out) return 'x'.repeat(length);
  const rest = length - out.length;
  if (rest === 0) return out;
  return rest === 1 ? `${out}x` : `${out} ${'x'.repeat(rest - 1)}`;
}

// A link of 182 characters, and one of 181.
const FAR_LINK = `https://example.org/reports/${'quarterly-numbers/'.repeat(8)}index.html`;
const OTHER_FAR_LINK = `https://example.org/archive/${'invoice-batches/'.repeat(9)}done.html`;
// Task codes in front of a title, 233 and 215 characters of them.
const HELD_CODES = Array.from({ length: 26 }, (_, i) => `BCK-${2000 + i}`).join(' ');
const DONE_CODES = Array.from({ length: 24 }, (_, i) => `OBL-${3000 + i}`).join(' ');
const HELD_ACROSS = `${HELD_CODES} Tidy the order emails ${FAR_LINK} and check the totals`;
const DONE_ACROSS = `${DONE_CODES} Close the invoice run ${OTHER_FAR_LINK} and archive it`;

test('a link that stands across the 300-character cut leaves no piece of itself once the task codes before it are taken out, in the text, the json, the page, and the text sent', { skip: !HAS_SQLITE }, async () => {
  // the link starts before the cut and reaches past it: the codes put it there, and the screen takes them out
  for (const [title, link] of [[HELD_ACROSS, FAR_LINK], [DONE_ACROSS, OTHER_FAR_LINK]]) {
    const at = title.indexOf(link);
    assert.ok(at > 200 && at < CAP && at + link.length > CAP, `the link stands across the cut: it starts at ${at}`);
  }
  const scn = workspaceWith('atris-brief-owner-cap-', (store) => {
    held(store, { id: 'CAP1', title: HELD_ACROSS, member: 'fleet-codex', at: ago(1), pullRequest: { state: 'open', number: 41, url: pullUrl(41) } });
    landed(store, { id: 'CAP2', title: DONE_ACROSS, member: 'fleet-codex', tag: 'x', at: ago(1), pr: 42 });
  });
  const json = (await runBrief(scn, ['--json'])).out;
  const data = JSON.parse(json);
  const screen = (await runBrief(scn)).out;
  const page = renderBriefHtml(data);
  const sent = await textSentBy(scn);

  // the json keeps the words before the link, to the last whole word that fits, and not a piece of the link
  assert.equal(data.needs_you[0].title, `${HELD_CODES} Tidy the order emails`);
  assert.equal(data.done_this_week[0].title, `${DONE_CODES} Close the invoice run`);
  for (const [where, body] of [['the screen', screen], ['the json', json], ['the page', page], ['the text sent', sent]]) {
    assert.ok(!body.includes('example.org'), `a piece of the link reached ${where}`);
  }
  // and the screen shows what is left of the title once the codes are out
  for (const [where, body] of [['the screen', screen], ['the page', page], ['the text sent', sent]]) {
    assert.ok(body.includes('Tidy the order emails') && body.includes('Close the invoice run'), `the words reached ${where}`);
    assert.ok(!body.includes('BCK-2000') && !body.includes('OBL-3000'), `a task code reached ${where}`);
  }
  assert.ok(screen.split('\n').includes('1. Tidy the order emails'), screen);

  // the real command, run from the scratch folder, says the same
  const realScreen = spawnBrief(scn, []);
  assert.equal(realScreen.status, 0, realScreen.stderr);
  assert.ok(!realScreen.stdout.includes('example.org') && realScreen.stdout.split('\n').includes('1. Tidy the order emails'), realScreen.stdout);
  const realJson = spawnBrief(scn, ['--json']);
  assert.equal(realJson.status, 0, realJson.stderr);
  assert.equal(JSON.parse(realJson.stdout).needs_you[0].title, `${HELD_CODES} Tidy the order emails`);
});

test('a title of 290 characters followed by a long link keeps its 290 characters and none of the link', { skip: !HAS_SQLITE }, async () => {
  const words = prose(290);
  const scn = workspaceWith('atris-brief-owner-cap290-', (store) => {
    held(store, { id: 'C29', title: `${words} ${FAR_LINK}`, member: 'fleet-codex', at: ago(1), pullRequest: { state: 'open', number: 43, url: pullUrl(43) } });
    landed(store, { id: 'C30', title: `${words} ${OTHER_FAR_LINK}`, member: 'fleet-codex', tag: 'x', at: ago(1), pr: 44 });
  });
  const json = (await runBrief(scn, ['--json'])).out;
  const data = JSON.parse(json);
  assert.equal(words.length, 290);
  assert.equal(data.needs_you[0].title, words);
  assert.equal(data.done_this_week[0].title, words);
  const outputs = [['the screen', (await runBrief(scn)).out], ['the json', json], ['the page', renderBriefHtml(data)], ['the text sent', await textSentBy(scn)]];
  for (const [where, body] of outputs) assert.ok(!body.includes('https://e'), `a piece of the link reached ${where}`);
});

test('every title in the json is at most 300 characters and ends at a whole word, wherever a link, a path, a secret, or a long word stands at the cut', { skip: !HAS_SQLITE }, async () => {
  const near = 'https://example.org/a/b';
  // [what is said, the title, the title as the cleaner leaves it before the cut when it hides something]
  const cases = [
    ['plain words, exactly at the cap', prose(CAP)],
    ['plain words, one past the cap', prose(CAP + 1)],
    ['plain words, far past the cap', prose(900)],
    ['a link that ends exactly at the cap', `${prose(CAP - 1 - near.length)} ${near}`],
    ['a link that ends one past the cap', `${prose(CAP - near.length)} ${near}`],
    ['a link across the cap', `${prose(270)} ${FAR_LINK}`],
    ['290 characters and then a long link', `${prose(290)} ${FAR_LINK}`],
    ['a path across the cap', `${prose(285)} src/${'deep/'.repeat(10)}file`],
    ['a branch name across the cap', `${prose(292)} feature/ABC-123-add-the-retry`],
    ['one word longer than the cap', 'a'.repeat(400)],
    ['a long word after some words', `${prose(20)} ${'b'.repeat(400)}`],
    ['values that grow when they are hidden', 'atcs_a '.repeat(50).trim(), '[redacted] '.repeat(50).trim()],
    ['a password pair across the cap', `${prose(285)} password=hunter2hunter2 and more`, `${prose(285)} password=[redacted] and more`],
    ['a key across the cap', `${prose(280)} ${PROVIDER_KEYS.ghp} and then more words`, `${prose(280)} [redacted] and then more words`],
  ];
  const scn = workspaceWith('atris-brief-owner-capall-', (store) => {
    cases.forEach(([, title], i) => {
      held(store, { id: `CH${i}`, title, member: 'fleet-codex', at: ago(1, i), pullRequest: { state: 'open', number: 100 + i, url: pullUrl(100 + i) } });
      landed(store, { id: `CL${i}`, title, member: 'fleet-sonnet', tag: 'x', at: ago(1, i), pr: 200 + i });
    });
  });
  // the older lists come from the task projection: finished jobs under landed, jobs waiting for review under waiting and needs_you
  writeProjection(scn.ws, cases.flatMap(([, title], i) => [
    { id: `PD${i}`, display_id: `CLI-D${i}`, title, status: 'done', done_at: iso(ago(0, 2)), updated_at: iso(ago(0, 2)) },
    { id: `PW${i}`, display_id: `CLI-W${i}`, title, status: 'review', updated_at: iso(ago(0, 3)) },
  ]));
  const data = await briefDataOf(scn);
  const byTaskId = (list, id) => list.find((item) => item.task_id === id).title;
  const byId = (list, id) => list.find((item) => item.id === id).title;
  cases.forEach(([label, title, hidden = title], i) => {
    const words = wholeWordsWithin(hidden);
    const shownIn = [
      ['needs_you (held)', byTaskId(data.needs_you, `CH${i}`), words || 'untitled'],
      ['needs_you (waiting for review)', byTaskId(data.needs_you, `PW${i}`), words || 'untitled'],
      ['done_this_week', byTaskId(data.done_this_week, `CL${i}`), words || 'untitled'],
      ['landed', byId(data.landed, `CLI-D${i}`), words || 'done task'],
      ['waiting', byId(data.waiting, `CLI-W${i}`), words || 'review task'],
    ];
    for (const [where, shown, expected] of shownIn) {
      assert.equal(shown, expected, `${label}, under ${where}`);
      assert.ok(shown.length <= CAP, `${label}, under ${where}: ${shown.length} characters`);
      // it is the start of the title and it ends where a word ends
      if (words) assert.ok(hidden.startsWith(shown) && (hidden.length === shown.length || /\s/.test(hidden[shown.length])), `${label}, under ${where}: ends inside a word`);
    }
  });
  for (const [where, body] of everyOutput(data)) {
    for (const part of windowsOf(PROVIDER_KEYS.ghp)) assert.ok(!body.includes(part), `"${part}" of the key reached ${where}`);
  }
});

test('a dotted word inside a shell command goes with the command, like a word without a dot', () => {
  // The shortener drops a command to the end of its clause, so master turns `Fix npm install foo and test`
  // into `Fix`. It turned `Fix npm install foo.bar and test` into `Fix.bar and test` only because it took
  // the dot in foo.bar for the end of the clause and kept what came after, the same junk piece as the `x` it
  // left of App.tsx. A dotted word is part of the command like any other, so both read the same.
  assert.equal(shortOf('Fix npm install foo and test'), 'Fix');
  assert.equal(shortOf('Fix npm install foo.bar and test'), 'Fix');
  assert.equal(shortOf('Fix npm install foo.bar and test'), shortOf('Fix npm install foo and test'));
  assert.equal(shortOf('Tidy the emails, then node scripts.build and test'), shortOf('Tidy the emails, then node scripts and test'));
});

test('the html page carries the same three parts', { skip: !HAS_SQLITE }, () => {
  const scn = scenario();
  return withEnv({ ATRIS_TASKS_DB: scn.dbPath, ATRIS_TEST_STATE_DIR: scn.stateDir }, () => {
    const html = renderBriefHtml(buildBriefData(scn.ws, { now: NOW, owner: true }));
    assert.match(html, /Needs you/);
    assert.ok(html.includes(TITLES.heldOpen));
    assert.ok(html.includes(pullUrl(12)));
    assert.match(html, /Done this week/);
    assert.ok(html.includes(TITLES.landedPr));
    assert.match(html, /Team/);
    assert.ok(html.includes('fleet-codex'));
  });
});

// ---- the rating a week ago ---------------------------------------------------

// One member's history around a week ago. The same jobs are written twice: once
// with only what had happened by then, once with two events that came later.
function seedWeekAgo(store, { withLater }) {
  const member = 'fleet-asof';
  [20, 19, 18].forEach((days, i) => landed(store, { id: `AW${i + 1}`, title: `Landed early ${i + 1}`, member, tag: 'api', at: ago(days) }));
  // sent back ten days ago; it landed two days ago, after the look a week ago
  sentBack(store, { id: 'AWS', title: 'Sent back, then landed', member, claimedAt: ago(12), notes: [{ at: ago(10), note: 'needs work' }] });
  // dropped ten days ago; a person called it not needed five days ago, also after that look
  dropped(store, { id: 'AWD', title: 'Dropped, then called not needed', member, at: ago(10), reason: 'tests failed' });
  if (withLater) {
    const merge = { state: 'merged', number: 70, url: pullUrl(70), merge_commit: sha('AWS'), merged_at: iso(ago(2)) };
    store.event('AWS', 'proof_ready', member, { proof: 'checks pass', landing: { merge_commit: sha('AWS') }, pull_request: merge }, ago(2));
    store.event('AWD', 'not_needed', 'keshavrao', { reason: 'nobody wants this any more' }, ago(5));
  }
}

test('the rating a week ago is made from what had happened by then, not from what came later', { skip: !HAS_SQLITE }, async () => {
  const untilThen = workspaceWith('atris-brief-owner-then-', (store) => seedWeekAgo(store, { withLater: false }));
  const withLater = workspaceWith('atris-brief-owner-later-', (store) => seedWeekAgo(store, { withLater: true }));
  const rowOf = (data) => data.team.find((row) => row.member === 'fleet-asof');
  const then = rowOf(await ownerData(untilThen));
  const later = rowOf(await ownerData(withLater));

  // what atris rating would have printed that day: the store as it was, looked at a week ago
  const gm = require('../lib/gm-season');
  const weekAgo = NOW - 7 * DAY;
  const printedThen = await withEnv({ ATRIS_TASKS_DB: untilThen.dbPath, ATRIS_TEST_STATE_DIR: untilThen.stateDir }, () =>
    gm.memberRatings(gm.loadSeason(untilThen.ws, { now: weekAgo, lastSeen: null }).outcomes).get('fleet-asof').ovr);
  assert.equal(printedThen, atrisRating(3, 5), 'three landings, one send-back, one drop');

  assert.equal(then.rating_a_week_ago, printedThen);
  assert.equal(later.rating_a_week_ago, printedThen, 'a landing and a not-needed note that came later change nothing about last week');
  assert.equal(then.rating, atrisRating(3, 5));
  assert.equal(then.trend, 'same');
  assert.equal(later.rating, atrisRating(4, 4), 'they do count today');
  assert.equal(later.trend, 'up');

  // the helper itself: a store that has the later events, read as of a week ago, gives the same plays
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(withLater.dbPath, { readOnly: true });
  try {
    const asOf = gm.outcomesAsOf(db, withLater.ws, weekAgo).map((play) => [play.task_id, play.member, play.kind, play.at, play.reason]);
    const control = await withEnv({ ATRIS_TASKS_DB: untilThen.dbPath, ATRIS_TEST_STATE_DIR: untilThen.stateDir }, () =>
      gm.loadSeason(untilThen.ws, { now: weekAgo, lastSeen: null }).outcomes.map((play) => [play.task_id, play.member, play.kind, play.at, play.reason]));
    assert.deepEqual(asOf, control);
  } finally {
    db.close();
  }
});

// A job nobody held was sent back ten days ago. The member who took it two days ago did
// nothing about that send-back a week ago, so last week's rating must not carry it.
function seedLateClaim(store, { later }) {
  const member = 'fleet-late';
  [20, 19, 18].forEach((days, i) => landed(store, { id: `LT${i + 1}`, title: `Landed early ${i + 1}`, member, tag: 'api', at: ago(days) }));
  store.task({
    id: 'LTS', title: 'Sent back before anyone took it', status: later ? 'claimed' : 'open', claimedBy: later ? member : null,
    claimedAt: later ? ago(2) : null, createdAt: ago(12), updatedAt: later ? ago(2) : ago(10),
  });
  store.event('LTS', 'reopened', 'keshavrao', { previous_status: 'review', reason: 'not what I asked for' }, ago(10));
  if (later) store.event('LTS', 'claimed', member, { claimed_by: member }, ago(2));
}

test('the rating a week ago never gives a send-back to a member who took the job later', { skip: !HAS_SQLITE }, async () => {
  const untilThen = workspaceWith('atris-brief-owner-latethen-', (store) => seedLateClaim(store, { later: false }));
  const withLater = workspaceWith('atris-brief-owner-latelater-', (store) => seedLateClaim(store, { later: true }));
  const rowOf = (data) => data.team.find((row) => row.member === 'fleet-late');
  const gm = require('../lib/gm-season');
  const weekAgo = NOW - 7 * DAY;
  const printedThen = await withEnv({ ATRIS_TASKS_DB: untilThen.dbPath, ATRIS_TEST_STATE_DIR: untilThen.stateDir }, () =>
    gm.memberRatings(gm.loadSeason(untilThen.ws, { now: weekAgo, lastSeen: null }).outcomes).get('fleet-late').ovr);
  assert.equal(printedThen, atrisRating(3, 3), 'a week ago it was three landings and nothing else');
  assert.notEqual(atrisRating(3, 4), atrisRating(3, 3));

  const later = rowOf(await ownerData(withLater));
  assert.equal(later.rating_a_week_ago, printedThen, 'the job was nobody\'s a week ago');
  // today is worked out as atris rating works it out, and that is unchanged
  const printedNow = await withEnv({ ATRIS_TASKS_DB: withLater.dbPath, ATRIS_TEST_STATE_DIR: withLater.stateDir }, () =>
    gm.memberRatings(gm.loadSeason(withLater.ws, { now: NOW, lastSeen: null }).outcomes).get('fleet-late').ovr);
  assert.equal(later.rating, printedNow);
  assert.equal(later.rating, atrisRating(3, 4));
  assert.equal(later.trend, 'down');

  // the helper itself: no claim at or before the day, so the send-back belongs to no one
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(withLater.dbPath, { readOnly: true });
  try {
    const asOf = gm.outcomesAsOf(db, withLater.ws, weekAgo);
    assert.deepEqual(asOf.filter((play) => play.task_id === 'LTS'), []);
    assert.equal(asOf.filter((play) => play.kind === 'landed').length, 3);
  } finally {
    db.close();
  }
});

// ---- done this week: one line per landing --------------------------------------

test('a job that landed, was reopened, and landed again is listed twice, each with its own builder', { skip: !HAS_SQLITE }, async () => {
  const merge = (n, at) => ({ state: 'merged', number: n, url: pullUrl(n), merge_commit: sha(`RL${n}`), merged_at: iso(at) });
  const scn = workspaceWith('atris-brief-owner-twice-', (store) => {
    store.task({
      id: 'RL', title: 'Speed up the importer', status: 'done', tag: 'backend', claimedBy: 'fleet-sonnet', claimedAt: ago(2),
      createdAt: ago(6), updatedAt: ago(1), doneAt: ago(1), metadata: { pull_request: merge(52, ago(1)) },
    });
    store.event('RL', 'claimed', 'fleet-codex', { claimed_by: 'fleet-codex' }, ago(5));
    store.event('RL', 'proof_ready', 'fleet-codex', { proof: 'checks pass', landing: { merge_commit: sha('RL51') }, pull_request: merge(51, ago(4)) }, ago(4));
    store.event('RL', 'reopened', 'keshavrao', { previous_status: 'done', reason: 'needs another pass' }, ago(3));
    store.event('RL', 'claimed', 'fleet-sonnet', { claimed_by: 'fleet-sonnet' }, ago(2));
    store.event('RL', 'proof_ready', 'fleet-sonnet', { proof: 'checks pass', landing: { merge_commit: sha('RL52') }, pull_request: merge(52, ago(1)) }, ago(1));
  });
  const data = await ownerData(scn);
  assert.deepEqual(data.done_this_week.map((item) => [item.title, item.built_by, item.link]), [
    ['Speed up the importer', 'fleet-sonnet', pullUrl(52)],
    ['Speed up the importer', 'fleet-codex', pullUrl(51)],
  ]);

  // one line per landing, the way the rating counts them
  const gm = require('../lib/gm-season');
  const landings = await withEnv({ ATRIS_TASKS_DB: scn.dbPath, ATRIS_TEST_STATE_DIR: scn.stateDir }, () =>
    gm.loadSeason(scn.ws, { now: NOW, lastSeen: null }).outcomes.filter((play) => play.kind === 'landed' && play.at >= NOW - 7 * DAY));
  assert.equal(landings.length, 2);
  assert.equal(data.done_this_week.length, landings.length);
  const { renderOwnerText } = require('../lib/owner-brief');
  const text = renderOwnerText(data);
  assert.match(text, /Done this week \(2\)/);
  assert.equal(text.split('- Speed up the importer, by ').length - 1, 2);
  assert.match(text, /by fleet-sonnet/);
  assert.match(text, /by fleet-codex/);
});

test('each landing takes its link from its own history entry, never from the first landing of a reopened job', { skip: !HAS_SQLITE }, async () => {
  // Reopening a job removes its pull request from the job's record and keeps its merge commit,
  // so the record still points at the first landing.
  const reopened = (store, { id, title, secondBy, second }) => {
    store.task({
      id, title, status: 'done', tag: 'backend', claimedBy: secondBy, claimedAt: ago(2), createdAt: ago(6), updatedAt: ago(1), doneAt: ago(1),
      metadata: { merge_commit: sha(`${id}-first`) },
    });
    const first = { state: 'merged', number: 51, url: pullUrl(51), merge_commit: sha(`${id}-first`), merged_at: iso(ago(4)) };
    store.event(id, 'claimed', 'fleet-codex', { claimed_by: 'fleet-codex' }, ago(5));
    store.event(id, 'proof_ready', 'fleet-codex', { proof: 'checks pass', landing: { merge_commit: first.merge_commit }, pull_request: first }, ago(4));
    store.event(id, 'reopened', 'keshavrao', { previous_status: 'done', reason: 'needs another pass' }, ago(3));
    store.event(id, 'claimed', secondBy, { claimed_by: secondBy }, ago(2));
    second(store, id, secondBy);
  };
  const scn = workspaceWith('atris-brief-owner-reland-', (store) => {
    // the second landing is a person accepting it: its entry names no link
    reopened(store, { id: 'RO', title: 'Tighten the signup checks', secondBy: 'fleet-sonnet', second: (s, id, by) => s.event(id, 'completed', 'keshavrao', { status: 'done', action: 'accepted' }, ago(1)) });
    // the second landing names a merge commit of its own and no pull request
    reopened(store, {
      id: 'RP', title: 'Speed up the search box', secondBy: 'fleet-gemini',
      second: (s, id, by) => s.event(id, 'proof_ready', by, { proof: 'checks pass', landing: { merge_commit: sha(`${id}-second`) } }, ago(1)),
    });
  });
  const data = await ownerData(scn);
  const rows = (title) => data.done_this_week.filter((item) => item.title === title).map((item) => [item.built_by, item.link, item.pull_request]);
  assert.deepEqual(rows('Tighten the signup checks'), [['fleet-sonnet', null, null], ['fleet-codex', pullUrl(51), null]]);
  assert.deepEqual(rows('Speed up the search box'), [['fleet-gemini', commitUrl('RP-second'), null], ['fleet-codex', pullUrl(51), null]]);
  for (const item of data.done_this_week) assert.notEqual(item.link, commitUrl(`${item.task_id}-first`), 'no landing links to the first landing\'s commit');
});

// ---- finished work whose proof could not be saved -------------------------------

test('finished work whose proof could not be saved needs a person, with the link from its release', { skip: !HAS_SQLITE }, async () => {
  const scn = workspaceWith('atris-brief-owner-unsaved-', (store) => {
    proofNotSaved(store, { id: 'UP1', title: 'Finish the invoice export', member: 'fleet-codex', at: ago(2), pullRequest: { state: 'open', number: 61, url: pullUrl(61) } });
    proofNotSaved(store, { id: 'UP2', title: 'Add the shipping estimate', member: 'fleet-sonnet', at: ago(3), pullRequest: { state: 'open', number: 62 } });
    // the build machine could not start the job: nothing was built, and the next run tries again
    couldNotStart(store, { id: 'CS1', title: 'Rebuild the search index', member: 'fleet-codex', at: ago(1) });
    // released with an open pull request and taken again since: a builder has it now
    proofNotSaved(store, { id: 'UP3', title: 'Cache the product images', member: 'fleet-codex', at: ago(4), pullRequest: { state: 'open', number: 63, url: pullUrl(63) }, status: 'claimed', claimedBy: 'fleet-sonnet' });
    store.event('UP3', 'claimed', 'fleet-sonnet', { claimed_by: 'fleet-sonnet' }, ago(1));
    // released with an open pull request and landed since
    proofNotSaved(store, { id: 'UP4', title: 'Tidy the order emails', member: 'fleet-codex', at: ago(5), pullRequest: { state: 'open', number: 64, url: pullUrl(64) }, status: 'done' });
    store.event('UP4', 'claimed', 'fleet-sonnet', { claimed_by: 'fleet-sonnet' }, ago(3));
    store.event('UP4', 'proof_ready', 'fleet-sonnet', { proof: 'checks pass', landing: { merge_commit: sha('UP4') }, pull_request: { state: 'merged', number: 64, url: pullUrl(64), merge_commit: sha('UP4'), merged_at: iso(ago(2)) } }, ago(2));
  });
  const data = await ownerData(scn);
  const titles = data.needs_you.map((item) => item.title);
  assert.deepEqual(titles, ['Finish the invoice export', 'Add the shipping estimate']);
  const [withLink, numberOnly] = data.needs_you;
  assert.equal(withLink.kind, 'held');
  assert.equal(withLink.link, pullUrl(61), 'the link comes from the release');
  assert.equal(withLink.built_by, 'fleet-codex');
  assert.match(withLink.why, /finished this and opened a pull request/);
  assert.match(withLink.why, /proof could not be saved/);
  assert.equal(numberOnly.link, null);
  assert.equal(numberOnly.pull_request, 62);
  assert.match(numberOnly.why, /pull request 62, but its link was not saved/);
  assert.match(numberOnly.why, /proof could not be saved/);
  assert.ok(data.done_this_week.some((item) => item.title === 'Tidy the order emails'), 'the landed one shows as done instead');

  const { out } = await runBrief(scn);
  const needs = sections(out)['Needs you'];
  const block = itemLines(needs, 'Finish the invoice export');
  assert.ok(block.includes(pullUrl(61)));
  assert.match(block, /proof could not be saved/);
  for (const left of ['Rebuild the search index', 'Cache the product images', 'Tidy the order emails']) {
    assert.ok(!needs.includes(left), `${left} is not waiting on a person`);
  }
});

test('finished work whose proof could not be saved stays on the screen however long ago it was left', { skip: !HAS_SQLITE }, async () => {
  const scn = workspaceWith('atris-brief-owner-unsavedold-', (store) => {
    proofNotSaved(store, { id: 'OU1', title: 'Finish the tax export', member: 'fleet-codex', at: ago(45), pullRequest: { state: 'open', number: 71, url: pullUrl(71) } });
    proofNotSaved(store, { id: 'OU2', title: 'Add the audit trail', member: 'fleet-sonnet', at: ago(120), pullRequest: { state: 'open', number: 72 } });
    // one inside the season too, so the old and the recent sit side by side
    proofNotSaved(store, { id: 'OU3', title: 'Finish the invoice export', member: 'fleet-codex', at: ago(2), pullRequest: { state: 'open', number: 73, url: pullUrl(73) } });
    // taken again since, so a builder has it
    proofNotSaved(store, { id: 'OU4', title: 'Cache the product images', member: 'fleet-codex', at: ago(60), pullRequest: { state: 'open', number: 74, url: pullUrl(74) }, status: 'claimed', claimedBy: 'fleet-sonnet' });
    store.event('OU4', 'claimed', 'fleet-sonnet', { claimed_by: 'fleet-sonnet' }, ago(50));
    // landed since
    proofNotSaved(store, { id: 'OU5', title: 'Tidy the order emails', member: 'fleet-codex', at: ago(70), pullRequest: { state: 'open', number: 75, url: pullUrl(75) }, status: 'done' });
    store.event('OU5', 'completed', 'keshavrao', { status: 'done', action: 'accepted' }, ago(65));
    // taken and let go again the ordinary way: the latest release is not the proof-not-saved kind
    proofNotSaved(store, { id: 'OU6', title: 'Rename the export columns', member: 'fleet-codex', at: ago(90), pullRequest: { state: 'open', number: 76, url: pullUrl(76) } });
    store.event('OU6', 'claimed', 'fleet-gemini', { claimed_by: 'fleet-gemini' }, ago(80));
    store.event('OU6', 'claim_released', 'fleet-gemini', { released_by: 'fleet-gemini', previous_claimed_by: 'fleet-gemini', reason: 'ran out of time' }, ago(79));
  });
  const data = await ownerData(scn);
  assert.deepEqual(data.needs_you.map((item) => item.title), ['Finish the invoice export', 'Finish the tax export', 'Add the audit trail']);
  const [recent, old, oldest] = data.needs_you;
  assert.equal(old.kind, 'held');
  assert.equal(old.link, pullUrl(71), 'the link still comes from the release');
  assert.equal(old.built_by, 'fleet-codex');
  assert.equal(old.age, '45 days');
  assert.equal(oldest.link, null);
  assert.equal(oldest.pull_request, 72);
  assert.equal(oldest.age, '120 days');
  assert.equal(recent.link, pullUrl(73));
  const { out } = await runBrief(scn);
  const needs = sections(out)['Needs you'];
  assert.match(itemLines(needs, 'Finish the tax export'), /Waiting 45 days/);
  for (const left of ['Cache the product images', 'Tidy the order emails', 'Rename the export columns']) {
    assert.ok(!needs.includes(left), `${left} is not waiting on a person`);
  }
});

test('a job released with a pull request, then archived and reopened, does not show under Needs you because of that old release', { skip: !HAS_SQLITE }, async () => {
  const pull = (n) => ({ state: 'open', number: n, url: pullUrl(n) });
  const waiting = (id, ref, title, tag, updated) => ({ id, display_id: ref, title, status: 'open', tag, updated_at: iso(updated) });
  const scn = workspaceWith('atris-brief-owner-reopened-', (store) => {
    // released with its pull request, archived by a person, then reopened for new work
    proofNotSaved(store, { id: 'RO1', title: 'Finish the invoice export', member: 'fleet-codex', at: ago(6), pullRequest: pull(81) });
    store.event('RO1', 'archived', 'keshavrao', { reason: 'not needed this quarter' }, ago(5));
    store.event('RO1', 'reopened', 'keshavrao', { previous_status: 'archived', reason: 'needed after all, with new scope' }, ago(2));
    // released with its pull request, marked done by a person without accepting it, then reopened
    proofNotSaved(store, { id: 'RO2', title: 'Add the shipping estimate', member: 'fleet-sonnet', at: ago(6), pullRequest: pull(82) });
    store.event('RO2', 'completed', 'keshavrao', { status: 'done', action: 'done' }, ago(5));
    store.event('RO2', 'reopened', 'keshavrao', { previous_status: 'done', reason: 'more to do' }, ago(2));
    // archived and reopened, taken again, and released again with a new pull request: that release is newer than the reopen, so it counts
    proofNotSaved(store, { id: 'RO3', title: 'Cache the product images', member: 'fleet-codex', at: ago(8), pullRequest: pull(83) });
    store.event('RO3', 'archived', 'keshavrao', { reason: 'paused' }, ago(7));
    store.event('RO3', 'reopened', 'keshavrao', { previous_status: 'archived', reason: 'back on' }, ago(6));
    store.event('RO3', 'claimed', 'fleet-sonnet', { claimed_by: 'fleet-sonnet' }, ago(5));
    store.event('RO3', 'claim_released', 'fleet-sonnet', {
      released_by: 'fleet-sonnet', previous_claimed_by: 'fleet-sonnet', reason: 'The pull request is open but its proof could not be saved (RO3)', kind: 'proof_not_saved', pull_request: pull(84),
    }, ago(3));
    // released with its pull request and left alone: still waiting on a person
    proofNotSaved(store, { id: 'RO4', title: 'Tidy the order emails', member: 'fleet-codex', at: ago(4), pullRequest: pull(85) });
    // archived after the release, and open again with no record of a reopen (older data): the archive alone is enough
    proofNotSaved(store, { id: 'RO9', title: 'Update the signup copy', member: 'fleet-sonnet', at: ago(6), pullRequest: pull(86) });
    store.event('RO9', 'archived', 'keshavrao', { reason: 'not needed this quarter' }, ago(5));
    // a protected job a builder let go of, then archived and reopened for new work
    dropped(store, { id: 'RO5', title: 'Change how invoices are rounded', member: 'fleet-codex', tag: 'billing', at: ago(6), reason: 'stopped at the billing check' });
    store.event('RO5', 'archived', 'keshavrao', { reason: 'not needed this quarter' }, ago(5));
    store.event('RO5', 'reopened', 'keshavrao', { previous_status: 'archived', reason: 'needed after all' }, ago(2));
    // the same job left alone: still a refusal
    dropped(store, { id: 'RO6', title: 'Change the tax table', member: 'fleet-codex', tag: 'billing', at: ago(3), reason: 'stopped at the billing check' });
    // a job the build machine could not start, archived, then reopened: the old release no longer hides it from the older waiting list
    couldNotStart(store, { id: 'RO7', title: 'Review the vendor contract', member: 'fleet-codex', tag: 'human-review', at: ago(6) });
    store.event('RO7', 'archived', 'keshavrao', { reason: 'not needed this quarter' }, ago(5));
    store.event('RO7', 'reopened', 'keshavrao', { previous_status: 'archived', reason: 'needed after all' }, ago(2));
    // the same job left alone: still nothing waiting on a person
    couldNotStart(store, { id: 'RO8', title: 'Rebuild the search index', member: 'fleet-codex', tag: 'human-review', at: ago(3) });
  });
  writeProjection(scn.ws, [
    waiting('RO7', 'CLI-57', 'Review the vendor contract', 'human-review', ago(2)),
    waiting('RO8', 'CLI-58', 'Rebuild the search index', 'human-review', ago(3)),
  ]);
  const data = await briefDataOf(scn);
  const titles = data.needs_you.map((item) => item.title);
  for (const left of ['Finish the invoice export', 'Add the shipping estimate', 'Update the signup copy', 'Change how invoices are rounded', 'Rebuild the search index']) {
    assert.ok(!titles.includes(left), `${left} was reopened or could not be started, so its old release is not what it waits on: ${titles}`);
  }
  for (const kept of ['Cache the product images', 'Tidy the order emails', 'Change the tax table', 'Review the vendor contract']) {
    assert.ok(titles.includes(kept), `${kept} is still waiting on a person: ${titles}`);
  }
  const item = (title) => data.needs_you.find((found) => found.title === title);
  assert.equal(item('Cache the product images').link, pullUrl(84), 'the release after the reopen is the one that counts');
  assert.equal(item('Cache the product images').built_by, 'fleet-sonnet');
  assert.equal(item('Tidy the order emails').link, pullUrl(85));
  assert.equal(item('Change the tax table').kind, 'refused');
  assert.equal(item('Review the vendor contract').kind, 'decision');
  // the screen and the page say the same
  for (const [where, body] of everyOutput(data)) {
    for (const left of ['Finish the invoice export', 'Add the shipping estimate', 'Update the signup copy', 'Change how invoices are rounded']) assert.ok(!body.includes(left), `${left} reached ${where}`);
    assert.ok(!body.includes(pullUrl(81)) && !body.includes(pullUrl(82)) && !body.includes(pullUrl(86)), `an old pull request reached ${where}`);
  }
});

test('a job the build machine could not start does not reach Needs you through the older waiting list', { skip: !HAS_SQLITE }, async () => {
  const waiting = (id, ref, title, tag, updated) => ({ id, display_id: ref, title, status: 'open', tag, updated_at: iso(updated) });
  const scn = workspaceWith('atris-brief-owner-notstarted-', (store) => {
    couldNotStart(store, { id: 'NS1', title: 'Change the invoice template', member: 'fleet-codex', tag: 'billing', at: ago(2) });
    couldNotStart(store, { id: 'NS2', title: 'Review the vendor contract', member: 'fleet-codex', tag: 'human-review', at: ago(3) });
    // the same, left alone for longer than the season
    couldNotStart(store, { id: 'NS3', title: 'Move the payout schedule', member: 'fleet-sonnet', tag: 'payments', at: ago(50) });
    // never claimed: a person still has to decide it
    store.task({ id: 'NS4', title: 'Approve the new pricing page', status: 'open', tag: 'customer', createdAt: ago(5), updatedAt: ago(5) });
    // the engine was asked before it let go, so the rating reads this release as a drop like any other
    store.task({ id: 'NS5', title: 'Rotate the signing keys', status: 'open', tag: 'security', createdAt: ago(5), updatedAt: ago(4) });
    store.event('NS5', 'claimed', 'fleet-codex', { claimed_by: 'fleet-codex' }, ago(4, 2));
    store.event('NS5', 'build_started', 'fleet-flight', {}, ago(4, 1));
    store.event('NS5', 'claim_released', 'fleet-flight', { released_by: 'fleet-flight', previous_claimed_by: 'fleet-codex', reason: 'the engine stopped', kind: 'could_not_start' }, ago(4));
    // could not be started once, and a builder has it again now
    store.task({ id: 'NS6', title: 'Update the card form', status: 'claimed', tag: 'billing', claimedBy: 'fleet-sonnet', claimedAt: ago(1), createdAt: ago(4), updatedAt: ago(1) });
    store.event('NS6', 'claimed', 'fleet-codex', { claimed_by: 'fleet-codex' }, ago(3, 2));
    store.event('NS6', 'claim_released', 'fleet-flight', { released_by: 'fleet-flight', previous_claimed_by: 'fleet-codex', reason: 'the build machine had no room left', kind: 'could_not_start' }, ago(3));
    store.event('NS6', 'claimed', 'fleet-sonnet', { claimed_by: 'fleet-sonnet' }, ago(1));
  });
  writeProjection(scn.ws, [
    waiting('NS1', 'CLI-41', 'Change the invoice template', 'billing', ago(2)),
    waiting('NS2', 'CLI-42', 'Review the vendor contract', 'human-review', ago(3)),
    waiting('NS3', 'CLI-43', 'Move the payout schedule', 'payments', ago(50)),
    waiting('NS4', 'CLI-44', 'Approve the new pricing page', 'customer', ago(5)),
    waiting('NS5', 'CLI-45', 'Rotate the signing keys', 'security', ago(4)),
    waiting('NS6', 'CLI-46', 'Update the card form', 'billing', ago(1)),
  ]);
  const data = await briefDataOf(scn);
  const titles = data.needs_you.map((item) => item.title);
  for (const left of ['Change the invoice template', 'Review the vendor contract', 'Move the payout schedule']) {
    assert.ok(!titles.includes(left), `${left} could not be started, so nothing is waiting on a person: ${titles}`);
  }
  assert.ok(titles.includes('Approve the new pricing page'), 'a protected job nobody has touched still needs a person');
  assert.ok(titles.includes('Update the card form'), 'once a builder has it again it is back on the list');
  const dropped = data.needs_you.find((item) => item.title === 'Rotate the signing keys');
  assert.ok(dropped, 'a release the rating counts as a drop is not a could-not-start job');
  assert.equal(dropped.kind, 'refused');
  assert.equal(titles.filter((title) => title === 'Rotate the signing keys').length, 1);
  // the older lists in the json keep every entry they always had
  assert.equal(data.waiting.length, 6);
});

// ---- links -------------------------------------------------------------------

test('a pull request is linked only when its link is saved or its repository is recorded', { skip: !HAS_SQLITE }, async () => {
  const other = 'https://github.com/other-org/other-repo';
  const scn = workspaceWith('atris-brief-owner-repo-', (store) => {
    held(store, { id: 'R1', title: 'Held, number only', member: 'fleet-codex', at: ago(1), pullRequest: { state: 'open', number: 13 } });
    held(store, { id: 'R2', title: 'Held, repository recorded', member: 'fleet-codex', at: ago(2), pullRequest: { state: 'open', number: 14, repository: 'other-org/other-repo' } });
    held(store, { id: 'R3', title: 'Held, repository link recorded', member: 'fleet-codex', at: ago(3), pullRequest: { state: 'open', number: 15, repository: `${other}.git` } });
    held(store, { id: 'R4', title: 'Held, repository not usable', member: 'fleet-codex', at: ago(4), pullRequest: { state: 'open', number: 16, repository: 'somewhere else entirely' } });
    held(store, { id: 'R5', title: 'Held, link saved', member: 'fleet-codex', at: ago(5), pullRequest: { state: 'open', number: 17, url: pullUrl(17), repository: 'other-org/other-repo' } });
    const merged = { state: 'merged', merged_at: iso(ago(1)) };
    landedWith(store, { id: 'D1', title: 'Landed, repository recorded', at: ago(1), payload: { pull_request: { ...merged, number: 80, repository: 'other-org/other-repo', merge_commit: sha('D1') } } });
    landedWith(store, { id: 'D2', title: 'Landed, number and commit', at: ago(2), payload: { pull_request: { ...merged, number: 81, merge_commit: sha('D2') } } });
    landedWith(store, { id: 'D3', title: 'Landed, number only', at: ago(3), payload: { merged_pr: 82 } });
  });
  const data = await ownerData(scn);
  const need = (title) => data.needs_you.find((item) => item.title === title);
  const done = (title) => data.done_this_week.find((item) => item.title === title);
  assert.equal(need('Held, number only').link, null);
  assert.equal(need('Held, number only').pull_request, 13);
  assert.equal(need('Held, repository recorded').link, `${other}/pull/14`, 'the recorded repository, not the workspace origin');
  assert.equal(need('Held, repository recorded').pull_request, null);
  assert.equal(need('Held, repository link recorded').link, `${other}/pull/15`);
  assert.equal(need('Held, repository not usable').link, null);
  assert.equal(need('Held, repository not usable').pull_request, 16);
  assert.equal(need('Held, link saved').link, pullUrl(17), 'a saved link wins');
  assert.equal(done('Landed, repository recorded').link, `${other}/pull/80`);
  assert.equal(done('Landed, repository recorded').pull_request, null);
  assert.equal(done('Landed, number and commit').link, commitUrl('D2'), 'the job\'s own merge commit still gets a link');
  assert.equal(done('Landed, number and commit').pull_request, 81);
  assert.equal(done('Landed, number only').link, null);
  assert.equal(done('Landed, number only').pull_request, 82);

  const { renderOwnerText } = require('../lib/owner-brief');
  const text = renderOwnerText(data);
  assert.ok(!text.includes('/pull/13') && !text.includes('/pull/16') && !text.includes('/pull/82'));
  assert.match(itemLines(text, 'Landed, number only'), /Pull request 82 has no saved link/);
});

// ---- secrets -----------------------------------------------------------------

// Secret-shaped strings, put together here so this file holds none of them whole.
const FAKE = {
  github: ['ghp', 'aB3dE5gH7jK9mN1pQ3sT5vX7zA9cD1fG3hJ5'].join('_'),
  openai: ['sk', 'proj', 'Zq8Lm2Vx'.repeat(5)].join('-'),
  jwt: ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJlLWJ5dGVz'].join('.'),
  bearer: 'q9X7mK2p'.repeat(4),
  inline: 'r7KpW3nZ'.repeat(2),
  password: 'T0pS3cretValue',
  login: 'l0g1nS3cretPw',
  webhook: ['https://hooks.slack.com/services/T0000/B0000', 'Xy7'.repeat(8)].join('/'),
  // the two shapes the security scan's patterns miss and the client scrubber catches
  client: ['atcs', 'Qm4Zp7Kd2Wx9Lr5Tn8'].join('_'),
  shortJwt: ['eyJhbGc', 'eyJzdWI', 'c2ln'].join('.'),
};

// The whole json the command builds, read through the real builder.
function briefDataOf(scn, { now = NOW } = {}) {
  return withEnv({ ATRIS_TASKS_DB: scn.dbPath, ATRIS_TEST_STATE_DIR: scn.stateDir }, () => buildBriefData(scn.ws, { now, owner: true }));
}

// Every way the data can reach a reader: the screen (also the text sent), the json, the page.
function everyOutput(data) {
  const { renderBrief } = require('../commands/brief');
  return [['the screen and the text sent', renderBrief(data)], ['the json', JSON.stringify(data, null, 2)], ['the page', renderBriefHtml(data)]];
}

test('a token in a note, a reason, or a link never reaches the screen, the json, the page, or the text sent', { skip: !HAS_SQLITE }, async () => {
  const scn = workspaceWith('atris-brief-owner-secrets-', (store) => {
    sentBack(store, {
      id: 'LKS', title: 'Fix the deploy script', member: 'fleet-codex', claimedAt: ago(11),
      notes: [{ at: ago(8), note: 'the first try was wrong' }, { at: ago(2), note: `the log shows ${FAKE.github} and the header Bearer ${FAKE.bearer}` }],
    });
    dropped(store, {
      id: 'LKP', title: 'Rotate the billing credentials', member: 'fleet-cursor', tag: 'billing', at: ago(2),
      reason: `push to https://deploy:${FAKE.login}@git.example.com/acme/widgets.git failed, password: ${FAKE.password}`,
    });
    [3, 4, 5].forEach((days, i) => dropped(store, {
      id: `LKM${i}`, title: `Leaky job ${i}`, member: 'fleet-leaky', at: ago(days),
      reason: `retry failed: token=${FAKE.inline} was rejected, jwt ${FAKE.jwt} see https://ci.example.com/run/9?sig=${FAKE.inline}#log`,
    }));
    held(store, { id: 'LKH', title: 'Held with a token in its link', member: 'fleet-codex', at: ago(1), pullRequest: { state: 'open', number: 21, url: `${pullUrl(21)}?access_token=${FAKE.github}#frag` } });
    held(store, { id: 'LKW', title: 'Held with a token in the path of its link', member: 'fleet-codex', at: ago(1, 3), pullRequest: { state: 'open', number: 24, url: FAKE.webhook } });
    landedWith(store, { id: 'LKL', title: 'Landed with a token in its link', at: ago(1), payload: { merged_pr: `${pullUrl(23)}?token=${FAKE.inline}#top` } });
    landedWith(store, {
      id: 'LKR', title: 'Landed with a signed link', at: ago(2),
      payload: { pull_request: { state: 'merged', number: 22, url: `${pullUrl(22)}?sig=${FAKE.openai}`, merge_commit: sha('LKR'), merged_at: iso(ago(2)) } },
    });
  });
  const { renderBrief } = require('../commands/brief');
  const shown = await withEnv({ ATRIS_TASKS_DB: scn.dbPath, ATRIS_TEST_STATE_DIR: scn.stateDir }, () => {
    const data = buildBriefData(scn.ws, { now: NOW, owner: true });
    return { data, text: renderBrief(data), json: JSON.stringify(data, null, 2), html: renderBriefHtml(data) };
  });
  for (const [where, body] of [['the screen and the text sent', shown.text], ['the json', shown.json], ['the page', shown.html]]) {
    for (const [name, secret] of Object.entries(FAKE)) assert.ok(!body.includes(secret), `${name} reached ${where}`);
    assert.ok(!body.includes('access_token') && !body.includes('?token=') && !body.includes('?sig=') && !body.includes('#frag') && !body.includes('#log'), `a query string or fragment reached ${where}`);
  }
  assert.match(shown.text, /Last note: "the log shows \[redacted\] and the header \[redacted\]"/);
  assert.match(shown.text, /Reason given: .*\[redacted\]/);
  const link = (list, title) => list.find((item) => item.title === title).link;
  assert.equal(link(shown.data.needs_you, 'Held with a token in its link'), pullUrl(21));
  assert.equal(link(shown.data.needs_you, 'Held with a token in the path of its link'), null);
  assert.equal(link(shown.data.done_this_week, 'Landed with a token in its link'), pullUrl(23));
  assert.equal(link(shown.data.done_this_week, 'Landed with a signed link'), pullUrl(22));
  const leaky = shown.data.team.find((row) => row.member === 'fleet-leaky');
  assert.equal(leaky.top_miss.count, 3);
  assert.equal(leaky.top_miss.reason, 'retry failed: token=[redacted] was rejected, jwt [redacted] see https://ci.example.com/run/9');
});

test('a link the redactor would change is not printed, whatever shape the secret has', { skip: !HAS_SQLITE }, async () => {
  const scn = workspaceWith('atris-brief-owner-linksecrets-', (store) => {
    held(store, { id: 'KA', title: 'Held, client secret in the path', member: 'fleet-codex', at: ago(1), pullRequest: { state: 'open', number: 31, url: `${pullUrl(31)}/${FAKE.client}` } });
    held(store, { id: 'KB', title: 'Held, short token in the path', member: 'fleet-codex', at: ago(2), pullRequest: { state: 'open', number: 32, url: `https://ci.example.com/runs/${FAKE.shortJwt}` } });
    held(store, { id: 'KC', title: 'Held, a plain link', member: 'fleet-codex', at: ago(3), pullRequest: { state: 'open', number: 33, url: pullUrl(33) } });
    landedWith(store, {
      id: 'KD', title: 'Landed, client secret in the path', at: ago(1),
      payload: { pull_request: { state: 'merged', number: 34, url: `${pullUrl(34)}/${FAKE.client}`, merge_commit: sha('KD'), merged_at: iso(ago(1)) } },
    });
    landedWith(store, { id: 'KE', title: 'Landed, short token in the link', at: ago(2), payload: { merged_pr: `https://ci.example.com/runs/${FAKE.shortJwt}` } });
  });
  const data = await briefDataOf(scn);
  const need = (title) => data.needs_you.find((item) => item.title === title);
  const done = (title) => data.done_this_week.find((item) => item.title === title);
  assert.equal(need('Held, client secret in the path').link, null);
  assert.equal(need('Held, client secret in the path').pull_request, 31);
  assert.equal(need('Held, short token in the path').link, null);
  assert.equal(need('Held, short token in the path').pull_request, 32);
  assert.equal(need('Held, a plain link').link, pullUrl(33), 'a clean link is untouched');
  // the merged pull request link is dropped, and the job's own merge commit still gets one
  assert.equal(done('Landed, client secret in the path').link, commitUrl('KD'));
  assert.equal(done('Landed, client secret in the path').pull_request, 34);
  assert.equal(done('Landed, short token in the link').link, null);
  for (const [where, body] of everyOutput(data)) {
    for (const secret of [FAKE.client, FAKE.shortJwt]) assert.ok(!body.includes(secret), `a secret in a link reached ${where}`);
  }
});

test('a title or a proof pointer carries no login, query string, or token into any output', { skip: !HAS_SQLITE }, async () => {
  const leaky = `https://deploy:${FAKE.login}@app.example.com/login?next=${FAKE.inline}#top`;
  const scn = workspaceWith('atris-brief-owner-titles-', (store) => {
    held(store, { id: 'TH', title: `Fix the login page at ${leaky}`, member: 'fleet-codex', at: ago(1), pullRequest: { state: 'open', number: 41, url: pullUrl(41) } });
    landedWith(store, {
      id: 'TL', title: `Check ${FAKE.webhook} still posts`, at: ago(1),
      payload: { pull_request: { state: 'merged', number: 42, url: pullUrl(42), merge_commit: sha('TL'), merged_at: iso(ago(1)) } },
    });
  });
  // the older lists come from the task projection file
  writeProjection(scn.ws, [
    { id: 'TW', display_id: 'CLI-31', title: `Review ${leaky}`, status: 'review', tag: 'customer', updated_at: iso(ago(0, 5)) },
    { id: 'TD1', display_id: 'CLI-32', title: `Shipped, see ${leaky}`, status: 'done', done_at: iso(ago(0, 2)), metadata: { landing_url: leaky } },
    { id: 'TD2', display_id: 'CLI-33', title: 'Shipped with a signed receipt', status: 'done', done_at: iso(ago(0, 3)), metadata: { latest_agent_proof: `verified, receipt at ${pullUrl(43)}/${FAKE.client}` } },
    { id: 'TD3', display_id: 'CLI-34', title: 'Shipped with a plain link', status: 'done', done_at: iso(ago(0, 4)), metadata: { latest_agent_proof: `verified, see ${pullUrl(44)}` } },
  ]);
  const data = await briefDataOf(scn);

  // the same key, a cleaned value: the login, query string, and fragment are gone, a link with a secret in its path is not a pointer
  assert.deepEqual(data.landed.map((item) => item.proof), ['https://app.example.com/login', 'proof on file', pullUrl(44)]);
  for (const [where, body] of everyOutput(data)) {
    for (const [name, secret] of Object.entries(FAKE)) assert.ok(!body.includes(secret), `${name} reached ${where}`);
    assert.ok(!body.includes('?next=') && !body.includes('#top') && !body.includes('Xy7Xy7'), `a query string, a fragment, or a webhook reached ${where}`);
  }
  // the titles are still readable
  const titles = [...data.needs_you, ...data.done_this_week, ...data.landed, ...data.waiting].map((item) => item.title);
  assert.ok(titles.some((title) => title.startsWith('Fix the login page at ')), titles.join(' | '));
  assert.ok(titles.some((title) => /^Check .* still posts$/.test(title)));
  assert.ok(titles.some((title) => title.startsWith('Shipped, see ')));
  assert.ok(titles.some((title) => title.startsWith('Review ')));
});

test('a link that could not be printed leaves no piece of itself in the older proof field', { skip: !HAS_SQLITE }, async () => {
  const proofs = {
    PX1: ['https://ci.example.com/runs/token=pr123', 'task projection'],
    PX2: ['pr #12 passed, log https://ci.example.com/runs/token=pr123', 'pr #12'],
    PX3: ['verified https://ci.example.com/runs/api_key=pr456', 'proof on file'],
    PX4: ['s3://bucket/builds/token=pr789', 'task projection'],
    PX5: ['the log had token=pr123 in it', 'task projection'],
    PX6: ['https://ci.example.com/merged/token=abc', 'task projection'],
    PX7: ['see pr 45 at https://ci.example.com/x/secret=pr9?z=1', 'pr 45'],
    PX8: [`passed, see ${pullUrl(46)}`, pullUrl(46)],
    PX9: ['atris/receipts/token=pr123.json', 'task projection'],
    PX10: [`https://x.example.com/${'a'.repeat(300)}/pr77`, 'task projection'],
    PX11: ['(see https://ci.example.com/x/token=pr55)', 'task projection'],
  };
  const scn = workspaceWith('atris-brief-owner-proofs-', () => {});
  writeProjection(scn.ws, Object.entries(proofs).map(([id, [proof]], i) => ({
    id, display_id: id, title: `Shipped ${id}`, status: 'done', done_at: iso(ago(0, i + 1)), metadata: { latest_agent_proof: proof },
  })));
  const data = await briefDataOf(scn);
  for (const [id, [proof, expected]] of Object.entries(proofs)) {
    const item = data.landed.find((entry) => entry.id === id);
    assert.ok(item, `${id} is in the older list`);
    assert.equal(item.proof, expected, proof);
  }
  for (const [where, body] of everyOutput(data)) {
    for (const piece of ['pr123', 'pr456', 'pr789', 'pr9', 'pr77', 'pr55']) assert.ok(!body.includes(piece), `${piece} reached ${where}`);
  }
});

test('a link is printable only when the redactor leaves it as it is', () => {
  const { printableLink } = require('../lib/owner-brief');
  assert.equal(printableLink(pullUrl(7)), pullUrl(7));
  assert.equal(printableLink(`${pullUrl(7)}?x=1#top`), pullUrl(7));
  assert.equal(printableLink(`https://deploy:${FAKE.login}@git.example.com/acme/widgets/pull/7`), 'https://git.example.com/acme/widgets/pull/7');
  for (const bad of [`${pullUrl(7)}/${FAKE.client}`, `https://ci.example.com/runs/${FAKE.shortJwt}`, FAKE.webhook, `https://ci.example.com/${FAKE.github}`, `https://x.example.com/${'a'.repeat(300)}`]) {
    assert.equal(printableLink(bad), null, bad);
  }
  for (const notALink of ['', null, undefined, 'github.com/acme/widgets', 'ftp://example.com/x', 'see https://example.com/x']) {
    assert.equal(printableLink(notALink), null, String(notALink));
  }
});

// ---- a secret in a name, a tag, or after a key name, of any length -----------------

// A builder name comes from `task claim --as` and a tag from `task add --tag`, so either can
// carry a token the way a note can. The values here are short on purpose: none of them is
// shaped like a provider key, and the name before the value is all that gives them away.
const NAMED = {
  tokenName: 'token=tk4829',
  authName: 'auth: au5502',
  sessionName: 'session=ss7413',
  keyName: 'x-api-key=ky6620',
  secretName: 'client_secret=sc1187',
  passwordTag: 'password=hunter2',
  sigTag: 'sig=sg3095',
  moveName: 'token=tm2204',
  moveTitle: 'pwd: pw8830',
};
const NAMED_VALUES = ['tk4829', 'au5502', 'ss7413', 'ky6620', 'sc1187', 'hunter2', 'sg3095', 'tm2204', 'pw8830'];

test('a token in a builder name or a tag never reaches the screen, the json, the page, or the text sent', { skip: !HAS_SQLITE }, async () => {
  const scn = workspaceWith('atris-brief-owner-names-', (store) => {
    landed(store, { id: 'NL1', title: 'Landed by one builder', member: NAMED.tokenName, tag: NAMED.passwordTag, at: ago(1) });
    landed(store, { id: 'NL2', title: 'Landed by the same builder again', member: NAMED.tokenName, tag: NAMED.passwordTag, at: ago(2) });
    landed(store, { id: 'NL3', title: 'Landed by a builder named with a provider key', member: FAKE.github, tag: FAKE.openai, at: ago(2, 3) });
    landed(store, { id: 'NL4', title: 'Landed in a signed lane', member: NAMED.keyName, tag: NAMED.sigTag, at: ago(3) });
    held(store, { id: 'NH1', title: 'Held by a builder with a session in its name', member: NAMED.sessionName, at: ago(1, 3), pullRequest: { state: 'open', number: 51, url: pullUrl(51) } });
    proofNotSaved(store, { id: 'NU1', title: 'Finished by a builder with an auth in its name', member: NAMED.authName, at: ago(1, 5), pullRequest: { state: 'open', number: 52, url: pullUrl(52) } });
    sentBack(store, {
      id: 'NS1', title: 'Sent back twice to a builder named with a secret', member: NAMED.secretName, claimedAt: ago(11),
      notes: [{ at: ago(8), note: 'not yet' }, { at: ago(2), note: 'still not' }],
    });
    // protected lanes: one job a builder gave up on, one it let go of
    store.task({ id: 'NF1', title: 'Payments job a builder gave up on', status: 'failed', tag: 'payments', claimedBy: NAMED.tokenName, claimedAt: ago(3), createdAt: ago(3, 2), updatedAt: ago(2, 6) });
    store.event('NF1', 'claimed', NAMED.tokenName, { claimed_by: NAMED.tokenName }, ago(3));
    store.event('NF1', 'blocked', NAMED.tokenName, { status: 'failed', action: 'failed' }, ago(2, 6));
    dropped(store, { id: 'NR1', title: 'Billing job a builder let go of', member: NAMED.keyName, tag: 'billing', at: ago(2, 8), reason: 'ran out of time' });
  });
  // the older list of next moves names whoever holds a job in flight
  writeProjection(scn.ws, [{ id: 'NM1', title: `Job in flight ${NAMED.moveTitle}`, status: 'claimed', claimed_by: NAMED.moveName, updated_at: iso(ago(0, 2)) }]);
  const data = await briefDataOf(scn);

  const need = (id) => data.needs_you.find((item) => item.task_id === id);
  const done = (id) => data.done_this_week.find((item) => item.task_id === id);
  assert.equal(need('NH1').built_by, 'session=[redacted]');
  assert.match(need('NH1').why, /^session=\[redacted\] finished this and opened a pull request/);
  assert.equal(need('NU1').built_by, 'auth: [redacted]');
  assert.match(need('NU1').why, /^auth: \[redacted\] finished this and opened a pull request/);
  assert.equal(need('NS1').built_by, 'client_secret=[redacted]');
  assert.equal(need('NF1').built_by, 'token=[redacted]');
  assert.match(need('NF1').why, /^token=\[redacted\] gave up on this protected payments job/);
  assert.equal(need('NR1').built_by, 'x-api-key=[redacted]');
  assert.match(need('NR1').why, /^x-api-key=\[redacted\] let go of this protected billing job/);
  assert.equal(done('NL1').built_by, 'token=[redacted]');
  assert.equal(done('NL3').built_by, '[redacted]');
  const member = (name) => data.team.find((row) => row.member === name);
  assert.equal(member('token=[redacted]').best_lane, 'password=[redacted]');
  assert.equal(member('[redacted]').best_lane, '[redacted]');
  assert.equal(member('x-api-key=[redacted]').best_lane, 'sig=[redacted]');
  assert.equal(data.team.filter((row) => row.member === 'token=[redacted]').length, 1, 'a cleaned name is still one row for the builder');
  // the job in flight is still listed as a next move, with the name cleaned
  const move = data.moves.find((item) => item.title.startsWith('Job in flight'));
  assert.ok(move, 'the job in flight is a next move');
  assert.match(move.why, /^task in flight \(claimed, token=\[redacted\]/);

  const { renderBrief } = require('../commands/brief');
  const outputs = [...everyOutput(data), ['the older screen', renderBrief({ ...data, needs_you: undefined })]];
  for (const [where, body] of outputs) {
    for (const value of [...NAMED_VALUES, FAKE.github, FAKE.openai]) assert.ok(!body.includes(value), `${value} reached ${where}`);
  }
});

// The sensitive names the review listed. The strong ones are credentials wherever they
// appear. The weak ones are also ordinary words (auth, key, session, sig, signature), so
// a sentence that uses one is left alone unless what follows looks like a token.
const SENSITIVE_NAMES = {
  strong: ['token', 'access_token', 'refresh_token', 'id_token', 'secret', 'client_secret', 'password', 'passwd', 'pwd', 'api_key', 'apikey', 'authorization'],
  weak: ['auth', 'key', 'session', 'sig', 'signature'],
};

// Each name in dash, underscore, camel-case, and capital spellings, alone and as part of a longer name.
function spellingsOf(names) {
  const camel = (name) => name.split('_').map((part, i) => (i ? part[0].toUpperCase() + part.slice(1) : part)).join('');
  const out = new Set();
  for (const name of names) {
    const dashed = name.replace(/_/g, '-');
    for (const spelled of [name, dashed, camel(name), name.toUpperCase(), dashed.toUpperCase(), name[0].toUpperCase() + name.slice(1), `x-${dashed}`, `my_${name}`, `${camel(name)}2`]) out.add(spelled);
  }
  return [...out];
}

test('in a name=value or json pair, the value after any sensitive name is hidden whatever its length', () => {
  const { redacted, printableLink } = require('../lib/owner-brief');
  const spellings = spellingsOf([...SENSITIVE_NAMES.strong, ...SENSITIVE_NAMES.weak]);
  assert.ok(spellings.length > 100, 'a long list of spellings is tried');
  for (const spelled of spellings) {
    for (const op of ['=', ' = ', ':=', '=>']) {
      for (const value of ['ab1', 'x', '"ab1"', "'ab1'", 'ab1cd2ef3', 'redirect']) {
        const text = `see ${spelled}${op}${value} here`;
        assert.equal(redacted(text), `see ${spelled}${op}[redacted] here`, text);
      }
    }
    assert.equal(redacted(`{"${spelled}":"x","n":1}`), `{"${spelled}":[redacted],"n":1}`, 'json, double quotes');
    assert.equal(redacted(`{'${spelled}': 'x', 'n': 1}`), `{'${spelled}': [redacted], 'n': 1}`, 'json, single quotes');
    assert.equal(printableLink(`https://ci.example.com/runs/${spelled}=x`), null, `${spelled}= in the path of a link`);
  }
  // the case in the review, and the shapes around it
  assert.equal(redacted('token=abc123'), 'token=[redacted]');
  assert.equal(printableLink('https://ci.example.com/runs/token=abc123'), null);
  assert.equal(redacted('https://ci.example.com/runs/token=abc123'), 'https://ci.example.com/runs/token=[redacted]');
  assert.equal(redacted('{"api_key": "k9", "ok": true}'), '{"api_key": [redacted], "ok": true}');
  assert.equal(redacted('GITHUB_TOKEN=ab1 and NPM_TOKEN=cd2'), 'GITHUB_TOKEN=[redacted] and NPM_TOKEN=[redacted]');
  assert.equal(redacted('password="correct horse"'), 'password=[redacted]');
  assert.equal(redacted("password=it's fine"), 'password=[redacted] fine', 'a quote inside a value does not end it');
  assert.equal(redacted('token=[redacted]'), 'token=[redacted]', 'cleaning twice changes nothing');
  // whole words only: a name that merely contains one of these letters is not a key
  for (const calm of ['monkey=banana', 'keyboard: us', 'author: ada', 'authority=admin', 'secretary: bob', 'tokenizer=bpe', 'design=flat', 'sigma=3', 'passenger: window', 'keynote: slides', 'status: open', 'sessions are long', 'token expired']) {
    assert.equal(redacted(calm), calm);
  }
});

test('in a plain sentence, the names that are always credentials hide what follows, and auth, key, session, sig, and signature only when it looks like a token', () => {
  const { redacted } = require('../lib/owner-brief');
  // the sentences from the review
  for (const title of ['Fix auth: redirect loop', 'Key: the cache is stale', 'session: rename the button']) assert.equal(redacted(title), title);
  assert.equal(redacted('session: 4f9a8b7c6d5e4f3a2b1c'), 'session: [redacted]');
  assert.equal(redacted('auth: abc123'), 'auth: [redacted]');
  assert.equal(redacted('password: secret'), 'password: [redacted]');
  assert.equal(redacted('token=abc123'), 'token=[redacted]');

  // the names that are always credentials: any value, in a sentence
  for (const spelled of spellingsOf(SENSITIVE_NAMES.strong)) {
    for (const value of ['ab1', 'x', 'secret', 'redirect', '"two words"']) {
      assert.equal(redacted(`see ${spelled}: ${value} here`), `see ${spelled}: [redacted] here`, `${spelled}: ${value}`);
    }
  }
  assert.equal(redacted('Authorization: Bearer abc123'), 'Authorization: [redacted]');
  assert.equal(redacted('Authorization: Basic dXNlcjpw'), 'Authorization: [redacted]');
  assert.equal(redacted('password: "correct horse"'), 'password: [redacted]');
  assert.equal(redacted("password: it's fine"), 'password: [redacted] fine', 'a quote inside a value does not end it');

  // the words that are often just words: left alone unless the value looks like a token
  const plainValues = ['redirect loop', 'the cache is stale', 'rename the button', 'x', 'add the footer text', 'fifteencharword', '"the cache is stale"'];
  const tokenValues = ['4f9a8b7c6d5e4f3a2b1c', 'abc123', '9', 'reallylongwordnodigits', 'sixteencharacter', '"abc 123"', FAKE.github, FAKE.client, FAKE.shortJwt, 'atcs_Abcdefgh'];
  for (const spelled of spellingsOf(SENSITIVE_NAMES.weak)) {
    for (const value of plainValues) {
      const text = `Fix ${spelled}: ${value} today`;
      assert.equal(redacted(text), text, 'a sentence that only uses the word is not changed');
    }
    for (const value of tokenValues) {
      assert.equal(redacted(`see ${spelled}: ${value} here`), `see ${spelled}: [redacted] here`, `${spelled}: ${value}`);
    }
  }
  // 15 characters is a word, 16 with no spaces is a token, and a digit alone is enough
  assert.equal(redacted('key: fifteencharword'), 'key: fifteencharword');
  assert.equal(redacted('key: sixteencharacter'), 'key: [redacted]');
  assert.equal(redacted('Fix auth: 2 failing tests'), 'Fix auth: [redacted] failing tests');
  // a pair inside the value of a sentence is still found
  assert.equal(redacted('key: rotate it, token=abc'), 'key: rotate it, token=[redacted]');
  assert.equal(redacted('auth: redirect token=abc'), 'auth: redirect token=[redacted]');
  assert.equal(redacted('key: token=abc'), 'key: token=[redacted]');
  assert.equal(redacted('auth: password: hunter'), 'auth: password: [redacted]');
  // cleaning text that is already clean changes nothing, so a marker never reads as a long token
  for (const text of ['key: token=abc', 'auth: password: hunter', 'Fix auth: redirect loop, password=hunter', 'session: 4f9a8b7c6d5e4f3a2b1c', 'Key: the cache is stale, token=abc123']) {
    assert.equal(redacted(redacted(text)), redacted(text), text);
  }
});

test('titles that use words like auth, key, and session are printed as written, and a token after one is hidden', { skip: !HAS_SQLITE }, async () => {
  const titles = {
    PA: 'Fix auth: redirect loop',
    PB: 'Key: the cache is stale',
    PC: 'session: rename the button',
    PD: 'session: 4f9a8b7c6d5e4f3a2b1c',
    PE: 'auth: abc123',
    PF: 'password: secret',
    PG: 'Rotate the key when token=abc123 is set',
  };
  const scn = workspaceWith('atris-brief-owner-prose-', (store) => {
    Object.entries(titles).forEach(([id, title], i) => held(store, { id, title, member: 'fleet-codex', at: ago(1, i), pullRequest: { state: 'open', number: 80 + i, url: pullUrl(80 + i) } }));
  });
  const data = await briefDataOf(scn);
  const title = (id) => data.needs_you.find((item) => item.task_id === id).title;
  assert.equal(title('PA'), 'Fix auth: redirect loop');
  assert.equal(title('PB'), 'Key: the cache is stale');
  assert.equal(title('PC'), 'session: rename the button');
  assert.equal(title('PD'), 'session: [redacted]');
  assert.equal(title('PE'), 'auth: [redacted]');
  assert.equal(title('PF'), 'password: [redacted]');
  assert.equal(title('PG'), 'Rotate the key when token=[redacted] is set');
  for (const [where, body] of everyOutput(data)) {
    for (const value of ['4f9a8b7c6d5e4f3a2b1c', 'abc123']) assert.ok(!body.includes(value), `${value} reached ${where}`);
    for (const words of [titles.PA, titles.PB, titles.PC]) assert.ok(body.includes(words), `"${words}" is printed as written in ${where}`);
  }
});

// Provider keys, each built from pieces so this file carries nothing a scanner could take for a real key.
const KEY_BODY = 'aB3dE5gH7jK9mN1pQ3sT5vX7zA9cD1fG3hJ5';
const PROVIDER_KEYS = {
  ghp: ['ghp', KEY_BODY].join('_'),
  gho: ['gho', KEY_BODY].join('_'),
  ghs: ['ghs', KEY_BODY].join('_'),
  ghu: ['ghu', KEY_BODY].join('_'),
  ghr: ['ghr', KEY_BODY].join('_'),
  githubPat: ['github', 'pat', 'B7kQ2mX9vL'.repeat(5)].join('_'),
  sk: ['sk', 'Zq8Lm2Vx'.repeat(5)].join('-'),
  skProj: FAKE.openai,
  skAnt: ['sk', 'ant', 'api03', 'Zq8Lm2VxZq8Lm2Vx'].join('-'),
  xoxb: ['xoxb', '1234567890', 'AbCdEfGhIj'].join('-'),
  xoxp: ['xoxp', '1234567890', 'AbCdEfGhIj'].join('-'),
  xoxa: ['xoxa', '1234567890', 'AbCdEfGhIj'].join('-'),
  xoxr: ['xoxr', '1234567890', 'AbCdEfGhIj'].join('-'),
  aws: ['AKIA', 'Q7ZP3LM29XK4VB8N'].join(''),
  atcs: FAKE.client,
};

test('a provider key is hidden after any character, an underscore or a letter included, and ordinary words are left alone', () => {
  const { redacted, printableLink } = require('../lib/owner-brief');
  for (const [kind, key] of Object.entries(PROVIDER_KEYS)) {
    for (const glue of ['', 'worker_', 'Worker', 'x', '9', 'a-', 'team.']) {
      assert.equal(redacted(`${glue}${key}`), `${glue}[redacted]`, `${kind} after "${glue}"`);
      assert.equal(redacted(`Rotate ${glue}${key} now`), `Rotate ${glue}[redacted] now`, `${kind} after "${glue}" in a sentence`);
    }
    assert.equal(printableLink(`https://ci.example.com/runs/worker_${key}`), null, `${kind} joined in the path of a link`);
  }
  // the body-length rule is kept for a key in the middle of a text: a start with too short a body is not a key there
  // (at the end of a field it is the start of a cut one, see "the start of a key at the end of a field" below),
  // and an ordinary word is not a key anywhere
  const short = [
    'ghp_', 'ghp_short', `ghp_${'a'.repeat(35)}`, `worker_ghp_${'a'.repeat(35)}`, 'worker_ghp_tokens',
    `github_pat_${'a'.repeat(39)}`, 'sk-', 'sk-short', `sk-${'a'.repeat(31)}`, 'sk-ant-short',
    'xoxb-short', 'xoxp-', 'AKIA', `AKIA${'A'.repeat(15)}`, `AKIA${'a'.repeat(16)}`, 'ASIAN-markets', 'The AKIAs',
  ];
  for (const text of short) assert.equal(redacted(`Rotate ${text} now`), `Rotate ${text} now`);
  const ordinary = [
    'task-force', 'disk-usage-report', 'risk-averse-planning', 'ask-the-owner',
    'worker_atcs', 'whatcs ok',
  ];
  for (const text of ordinary) assert.equal(redacted(text), text);
});

test('a provider key joined to a word is hidden in a title, a builder name, and a tag, in every output', { skip: !HAS_SQLITE }, async () => {
  const k = PROVIDER_KEYS;
  const scn = workspaceWith('atris-brief-owner-joined-', (store) => {
    landed(store, { id: 'JL1', title: `Rotate worker_${k.ghp} now`, member: `worker_${k.skAnt}`, tag: `team${k.aws}`, at: ago(1) });
    landed(store, { id: 'JL2', title: 'Landed by the same builder again', member: `worker_${k.skAnt}`, tag: `team${k.aws}`, at: ago(2) });
    held(store, { id: 'JH1', title: `Check x${k.xoxb} again`, member: `Worker${k.githubPat}`, at: ago(1, 3), pullRequest: { state: 'open', number: 91, url: pullUrl(91) } });
    held(store, { id: 'JH2', title: `Look at 9${k.sk} and ${k.atcs}`, member: `fleet_${k.atcs}`, at: ago(1, 4), pullRequest: { state: 'open', number: 92, url: pullUrl(92) } });
  });
  const data = await briefDataOf(scn);
  const need = (id) => data.needs_you.find((item) => item.task_id === id);
  const done = (id) => data.done_this_week.find((item) => item.task_id === id);
  assert.equal(done('JL1').title, 'Rotate worker_[redacted] now');
  assert.equal(done('JL1').built_by, 'worker_[redacted]');
  assert.equal(need('JH1').title, 'Check x[redacted] again');
  assert.equal(need('JH1').built_by, 'Worker[redacted]');
  assert.equal(need('JH2').title, 'Look at 9[redacted] and [redacted]');
  assert.equal(need('JH2').built_by, 'fleet_[redacted]');
  const row = data.team.find((item) => item.member === 'worker_[redacted]');
  assert.ok(row, 'the cleaned name is still a row of its own');
  assert.equal(row.best_lane, 'team[redacted]');
  for (const [where, body] of everyOutput(data)) {
    for (const [kind, key] of Object.entries(k)) assert.ok(!body.includes(key.slice(-14)), `${kind} reached ${where}`);
  }
});

test('a quoted value is read with its backslash escapes, so an escaped quote does not end it', () => {
  const { redacted } = require('../lib/owner-brief');
  const raw = String.raw;
  const cases = [
    [raw`password="abc\"def"`, 'password=[redacted]'],
    [raw`password='abc\'def'`, 'password=[redacted]'],
    // long enough that the security scan's own pattern would take the first piece and leave the rest
    [raw`password="abcdefgh\"ijkl"`, 'password=[redacted]'],
    [raw`token='abcdefgh\'ijkl'`, 'token=[redacted]'],
    [raw`{"password": "abc\"def", "ok": true}`, '{"password": [redacted], "ok": true}'],
    [raw`{'api_key': 'abc\'def', 'ok': 1}`, "{'api_key': [redacted], 'ok': 1}"],
    [raw`password: "abc\"def" and more`, 'password: [redacted] and more'],
    [raw`x password="two \"quoted\" words" y`, 'x password=[redacted] y'],
    [raw`password="abc\\" and more`, 'password=[redacted] and more'],
    [raw`password="a\"b" token='c\'d' ok`, 'password=[redacted] token=[redacted] ok'],
    [raw`key="the \"cache\" is stale"`, 'key=[redacted]'],
    [raw`password="abc\"def`, 'password=[redacted]'],
  ];
  for (const [text, expected] of cases) assert.equal(redacted(text), expected, text);
  // in a sentence, auth, key, and session still judge what is inside the quotes
  assert.equal(redacted(raw`Key: "the \"cache\" is stale"`), raw`Key: "the \"cache\" is stale"`);
  assert.equal(redacted(raw`session: "abc\"1"`), 'session: [redacted]');
  // cleaning text that is already clean changes nothing, except that a hidden json pair takes the
  // comma that follows it the second time (the marker is part of its run, see the next test)
  for (const [text, expected] of cases) assert.equal(redacted(redacted(text)), expected.replace('[redacted],', '[redacted]'), text);
});

// ---- where a value ends, and how much of a long field is read -------------------

test('an unquoted value runs to the next space or the end of the text, so nothing after a comma, semicolon, ampersand, or hash is left showing', () => {
  const { redacted } = require('../lib/owner-brief');
  // the case in the review
  assert.equal(redacted('password=abc,def'), 'password=[redacted]');
  for (const glue of [',', ';', '&', '#', ',;&#,']) {
    const value = `ab1${glue}cd2${glue}ef3`;
    for (const name of [...SENSITIVE_NAMES.strong, ...SENSITIVE_NAMES.weak]) {
      for (const op of ['=', ': ', ' = ', ':=', '=>']) {
        const text = `see ${name}${op}${value} here`;
        assert.equal(redacted(text), `see ${name}${op}[redacted] here`, text);
        assert.equal(redacted(redacted(text)), redacted(text), `${text}, cleaned twice`);
      }
    }
  }
  // a value still ends at a space, and at the end of the text
  assert.equal(redacted('password=abc,def and more'), 'password=[redacted] and more');
  assert.equal(redacted('password=abc;'), 'password=[redacted]');
  assert.equal(redacted('password=abc,\nnext line'), 'password=[redacted] next line');
  assert.equal(redacted('password=abc,\tnext'), 'password=[redacted] next');
  // a pair joined on behind the first one goes with it
  assert.equal(redacted('password=abc,token=def'), 'password=[redacted]');
  assert.equal(redacted('ftp://files.example.com/x?token=abc&sig=def'), 'ftp://files.example.com/x?token=[redacted]');
  // in a sentence, auth, key, and session judge the whole run, not the piece before a comma
  assert.equal(redacted('auth: abc,def1'), 'auth: [redacted]');
  assert.equal(redacted('key: fifteencharword,x'), 'key: [redacted]');
  assert.equal(redacted('Fix auth: redirect, then log in'), 'Fix auth: redirect, then log in');
  assert.equal(redacted('Key: the cache is stale, again'), 'Key: the cache is stale, again');
});

test('a value is hidden to the next space even when an earlier pattern already cut a key out of it, whatever kind of key it was', () => {
  const { redacted } = require('../lib/owner-brief');
  // the case in the review: the key rule hides the key first, and the pair rule must still take what is stuck to it
  const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJ';
  assert.equal(letters.length, 36);
  assert.equal(redacted(`password=ghp_${letters},def`), 'password=[redacted]');
  assert.equal(redacted('password=[redacted],def'), 'password=[redacted]', 'a marker left by an earlier cleaning is part of the run like any other characters');
  assert.equal(redacted(`password=ghp_${letters},def and more`), 'password=[redacted] and more');
  // the same shape with every kind of key, and every kind of tail
  const keys = { ...PROVIDER_KEYS, jwt: FAKE.jwt, webhook: FAKE.webhook };
  const tails = [',def', ';x', '&a=b', '.next', ',', ')more', ',def,ghi', ',token=abc', '/path', ':8080', '#top', '?a=1'];
  for (const [kind, key] of Object.entries(keys)) {
    for (const tail of tails) {
      assert.equal(redacted(`password=${key}${tail}`), 'password=[redacted]', `${kind} then "${tail}"`);
      assert.equal(redacted(`see token: ${key}${tail} here`), 'see token: [redacted] here', `${kind} then "${tail}", in a sentence`);
      assert.equal(redacted(redacted(`password=${key}${tail}`)), 'password=[redacted]', `${kind} then "${tail}", cleaned twice`);
    }
  }
  // every name that always hides, written every way
  for (const name of spellingsOf(SENSITIVE_NAMES.strong)) {
    for (const op of ['=', ': ', ' = ', ':=', '=>']) {
      const text = `see ${name}${op}${keys.ghp},def here`;
      assert.equal(redacted(text), `see ${name}${op}[redacted] here`, text);
    }
  }
  // a name that is often just a word: a key in its value makes the value a token, and what is stuck to the key goes with it
  for (const name of spellingsOf(SENSITIVE_NAMES.weak)) {
    for (const kind of ['ghp', 'skAnt', 'xoxb', 'aws', 'githubPat']) {
      const key = PROVIDER_KEYS[kind];
      assert.equal(redacted(`Fix ${name}: ${key},def today`), `Fix ${name}: [redacted] today`, `${name}: ${kind} then ,def`);
      assert.equal(redacted(`Fix ${name}=${key},def today`), `Fix ${name}=[redacted] today`, `${name}=${kind} then ,def`);
      // punctuation after a key is not part of it, and the text reads the same cleaned again
      assert.equal(redacted(`Fix ${name}: ${key}. Then`), `Fix ${name}: [redacted]. Then`, `${name}: ${kind} then a full stop`);
      assert.equal(redacted(`Fix ${name}: ${key}`), `Fix ${name}: [redacted]`, `${name}: ${kind} alone`);
      assert.equal(redacted(redacted(`Fix ${name}: ${key},def today`)), `Fix ${name}: [redacted] today`, `${name}: ${kind} then ,def, cleaned twice`);
    }
  }
  // whatever else ran before the pair rule and left its marker in the run
  assert.equal(redacted(`password=https://deploy:${FAKE.login}@git.example.com/acme/widgets.git,def`), 'password=[redacted]', 'a login in a link');
  assert.equal(redacted(`password=Bearer ${FAKE.bearer},def`), 'password=[redacted]', 'a Bearer value');
  assert.equal(redacted(`token=${FAKE.github},${FAKE.openai},end`), 'token=[redacted]', 'two keys in one run');
  assert.equal(redacted(`token=${FAKE.github}${FAKE.openai}`), 'token=[redacted]', 'two keys joined');
  assert.equal(redacted(`api_key=x${FAKE.github}y`), 'api_key=[redacted]', 'a key with a letter on each side');
  // a marker and a space: nothing is stuck to it, so the words after it stay
  assert.equal(redacted(`password=${FAKE.github} and more`), 'password=[redacted] and more');
  assert.equal(redacted(`Fix key: ${FAKE.github} and more`), 'Fix key: [redacted] and more');
});

test('a quote that never closes runs to the end of the text, so a quoted secret with spaces in it is not left showing', () => {
  const { redacted } = require('../lib/owner-brief');
  const cases = [
    ['password="correct horse battery staple', 'password=[redacted]'],
    ["password='correct horse battery staple", 'password=[redacted]'],
    ['see token: "two words and more', 'see token: [redacted]'],
    ['x api_key=" spaced out', 'x api_key=[redacted]'],
    ['{"password": "correct horse', '{"password": [redacted]'],
    [String.raw`password="abc\"`, 'password=[redacted]'],
    [String.raw`password="abc\" def ghi`, 'password=[redacted]'],
  ];
  for (const [text, expected] of cases) {
    assert.equal(redacted(text), expected, text);
    assert.equal(redacted(redacted(text)), redacted(text), `${text}, cleaned twice`);
  }
  // a quote that closes still ends where it closes
  assert.equal(redacted('password="a b" and more'), 'password=[redacted] and more');
  assert.equal(redacted("password='a b' and more"), 'password=[redacted] and more');
  // in a sentence, auth, key, and session judge the first word of an open quote, so a stray quote does not hide the rest
  assert.equal(redacted('Fix auth: "redirect loop'), 'Fix auth: "redirect loop');
  assert.equal(redacted('Fix session: "expired after 3 tries'), 'Fix session: "expired after 3 tries');
  assert.equal(redacted('session: "4f9a8b7c6d5e4f3a2b1c and more words'), 'session: [redacted]');
});

// ---- a very long field -------------------------------------------------------------

const MEGABYTE = 1024 * 1024;
const repeatTo = (unit, size = MEGABYTE) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
const LIMIT_MS = 200;

// How long a run takes, in milliseconds. One slow run on a busy machine is not the cleaner,
// so a run that is over the limit is tried twice more and the fastest of the three counts.
function milliseconds(run) {
  let best = Infinity;
  for (let i = 0; i < 3 && best >= LIMIT_MS; i += 1) {
    const started = process.hrtime.bigint();
    run();
    best = Math.min(best, Number(process.hrtime.bigint() - started) / 1e6);
  }
  return best;
}

// One megabyte of the same few characters over and over, in the shapes that make a pattern
// start again at every character: link prefixes with no query string, runs that could be the
// start of a scheme, the start of every kind of key, JWT and Bearer starts, name and value
// pairs, a private key header, a webhook, and plain white space.
const HOSTILE_UNITS = [
  'https://', 'http://x/', 'https://a.b/', 'https://u@', 'https://a?', 'https://a#', 'https://hooks.slack.com/services/', 'a://', 'x://y@',
  'a.', 'ab-', 'x+', '1a.', '-a', 'sk-', 'sk-ant-', 'sk-proj-', 'xoxb-', 'SG.', 'ghp_', 'gho_', 'github_pat_', 'AKIA', 'AIza', 'rk_live_', 'npm_', 'atcs_',
  'eyJ', 'eyJ-', 'eyJabcdefghijk.', 'eyJabcdefghijk.abcdefghijk.', 'Bearer ', 'Bearer a', 'Bearer  ',
  'key=', 'key="', "token='", 'a=b', 'a:', 'a-b-c: ', 'password=\\', 'session: 1 ', 'token="\\"', "x='", '{"a":',
  '-----BEGIN ', '-----BEGIN PRIVATE KEY-----', '-----END ', '-----BEGIN A',
  '[redacted]', 'atcs_a ', 'pwd=a ', 'a ', 'a1', 'x_', '.', '?', '#', ' ', '\n', '\t', '\u00a0',
];

test('a megabyte of repeated link prefixes, scheme-like runs, key starts, and name and value pairs is cleaned in under 200 milliseconds', () => {
  const { redacted, printableLink } = require('../lib/owner-brief');
  const slow = [];
  for (const unit of HOSTILE_UNITS) {
    const text = repeatTo(unit);
    assert.equal(text.length, MEGABYTE);
    let out;
    const ms = milliseconds(() => { out = redacted(text); });
    if (ms >= LIMIT_MS) slow.push(`${JSON.stringify(unit)} took ${ms.toFixed(0)} ms`);
    assert.ok(out.length <= 300, `${JSON.stringify(unit)}: the screen never gets more than 300 characters of a field`);
  }
  assert.deepEqual(slow, [], 'a megabyte took 200 milliseconds or more');
  // a link as long as that is not printed, and finding out is just as quick
  for (const unit of ['a', 'a.', '/a']) {
    const link = `https://${repeatTo(unit, MEGABYTE - 8)}`;
    let printed;
    const ms = milliseconds(() => { printed = printableLink(link); });
    assert.equal(printed, null, `a link of a megabyte of ${unit}`);
    assert.ok(ms < LIMIT_MS, `a link of a megabyte of ${unit} took ${ms.toFixed(0)} ms`);
  }
});

// Every window of eight characters of what must not show.
const windowsOf = (secret) => Array.from({ length: Math.max(0, secret.length - 7) }, (_, i) => secret.slice(i, i + 8));

test('a field longer than the cleaner reads is cut back to its last space, so a token at the cut leaves no piece of itself', () => {
  const { redacted, CLEAN_MAX } = require('../lib/owner-brief');
  assert.ok(Number.isInteger(CLEAN_MAX) && CLEAN_MAX >= 3000 && CLEAN_MAX <= MEGABYTE / 16, `the cleaner reads ${CLEAN_MAX} characters of a field, well above the 300 the screen shows`);
  // one word each, and the ones with spaces in them (a Bearer value, a quoted phrase)
  const oneWord = {
    ...PROVIDER_KEYS,
    jwt: FAKE.jwt,
    shortJwt: FAKE.shortJwt,
    password: 'password=T0pS3cretValue99',
    login: `https://deploy:${FAKE.login}@app.example.com/login`,
  };
  const hidden = { login: FAKE.login, password: 'T0pS3cretValue99' };
  const manyWords = {
    bearer: [`Bearer ${FAKE.bearer}`, FAKE.bearer],
    quoted: ['password="correct horse battery staple correct horse"', 'correct horse battery staple correct horse'],
  };
  const tail = repeatTo(' and so on', MEGABYTE);
  let slowest = { ms: 0, label: '' };
  const run = (label, piece, secret, before, glue, space) => {
    const text = `start${space.repeat(CLEAN_MAX - 5 - before)}${piece}${tail}`;
    assert.ok(text.length > MEGABYTE && text.slice(0, CLEAN_MAX).endsWith(piece.slice(0, before)) && text[CLEAN_MAX - before] === piece[0]);
    let out;
    const ms = milliseconds(() => { out = redacted(text); });
    if (ms > slowest.ms) slowest = { ms, label };
    for (const part of windowsOf(secret)) assert.ok(!out.includes(part), `"${part}" of the secret reached the screen: ${label}`);
    return out;
  };
  // every way the cut can fall through a few of them, and a few ways through all of them
  const every = new Set(['ghp', 'skProj', 'jwt', 'password', 'login']);
  for (const [kind, key] of Object.entries(oneWord)) {
    const secret = hidden[kind] || key;
    const offsets = every.has(kind) ? Array.from({ length: key.length + 1 }, (_, i) => i) : [0, 1, 4, 5, 6, key.length >> 1, key.length - 1, key.length];
    for (const glue of every.has(kind) ? [''] : ['', 'worker_']) {
      const piece = `${glue}${key}`;
      for (const space of every.has(kind) ? [' '] : [' ', '\n']) {
        for (const before of offsets.map((n) => Math.min(n + glue.length, piece.length))) {
          const label = `${kind} after "${glue}", ${before} of ${piece.length} characters before the cut`;
          const out = run(label, piece, secret, before, glue, space);
          // the word the cut falls in is dropped whole; a word that ends at the cut is hidden whole
          assert.equal(out, before === piece.length ? redacted(`start ${piece}`) : 'start', label);
        }
      }
    }
  }
  for (const [kind, [piece, secret]] of Object.entries(manyWords)) {
    for (let before = 0; before <= piece.length; before += 1) {
      const label = `${kind}, ${before} of ${piece.length} characters before the cut`;
      const out = run(label, piece, secret, before, '', ' ');
      // the words before the cut may stay as words or as a hidden value, and nothing of the value shows
      assert.match(out, before === piece.length ? /^start (?:\[redacted\]|password=\[redacted\])$/ : /^start(?: Bearer| password=\[redacted\])?$/, label);
    }
  }
  assert.ok(slowest.ms < LIMIT_MS, `a megabyte with a token at the cut took ${slowest.ms.toFixed(0)} ms (${slowest.label})`);

  // a text with no space in what is read has no word to stop at, so none of it is shown
  assert.equal(redacted('a'.repeat(MEGABYTE)), '');
  assert.equal(redacted('a'.repeat(CLEAN_MAX + 1)), '');
  // a text exactly as long as what is read is kept whole, and a space at the cut keeps the word before it
  const token = PROVIDER_KEYS.ghp;
  assert.equal(redacted(`start${' '.repeat(CLEAN_MAX - 5 - token.length)}${token}`), 'start [redacted]');
  assert.equal(redacted(`start${' '.repeat(CLEAN_MAX - 5 - token.length)}${token}x`), 'start');
  assert.equal(redacted(`${'a'.repeat(CLEAN_MAX)} ${token}`), '');
  assert.equal(redacted(`ok${' '.repeat(CLEAN_MAX)}after`), 'ok');
  assert.equal(redacted(`ok ${'a'.repeat(CLEAN_MAX)}`), 'ok');
});

test('the cleaner keeps at most 300 characters of a field and stops at the last whole word, wherever a link, a path, or a secret stands at the cut', () => {
  const { printableLink, redacted } = require('../lib/owner-brief');
  const { scrub } = require('../utils/agent-client');
  // the 300 is the shared scrubber's own; if it ever changes, the cut made here has to be looked at again
  assert.equal(scrub('ab '.repeat(400), []).length, CAP);

  // every place a link, a path, or a branch can start, from well before the cut to just past it
  const tail = ' and the rest of the title';
  for (const link of [FAR_LINK, 'src/deep/path/to/the/file.js', 'feature/ABC-123']) {
    for (let start = 240; start <= CAP + 2; start += 1) {
      const text = `${prose(start - 1)} ${link}${tail}`;
      const shown = redacted(text);
      assert.equal(shown, wholeWordsWithin(text), `${link} starting at ${start}`);
      assert.ok(shown.length <= CAP, `${link} starting at ${start}: ${shown.length} characters`);
      // the last word shown is a whole word of the text, so a link is there whole or not at all
      assert.ok(text.split(' ').includes(shown.split(' ').pop()), `${link} starting at ${start}: ends in a piece of a word`);
    }
  }
  // one word that fills the cap exactly is kept, and one character more drops it
  assert.equal(redacted('a'.repeat(CAP)), 'a'.repeat(CAP));
  assert.equal(redacted('a'.repeat(CAP + 1)), '');
  assert.equal(redacted(`ok ${'a'.repeat(CAP - 3)}`), `ok ${'a'.repeat(CAP - 3)}`);
  assert.equal(redacted(`ok ${'a'.repeat(CAP - 2)}`), 'ok');
  // a word that does not fit is dropped, and nothing after it is shown, however short
  assert.equal(redacted(`ok ${'a'.repeat(400)} fine`), 'ok');
  // a word that ends exactly at the cap is kept, and the one after it is not
  assert.equal(redacted(`${prose(CAP - 3)} xx fine`), `${prose(CAP - 3)} xx`);
  // squeezing white space comes first, so a text that fits once squeezed is kept whole
  assert.equal(redacted(`${prose(250)}${' '.repeat(100)}end`), `${prose(250)} end`);
  assert.equal(redacted(`${prose(CAP - 4)}\n\t\n end`), `${prose(CAP - 4)} end`);
  // a line break or a tab ends a word like a space does
  assert.equal(redacted(`${prose(CAP - 5)}\nab\ncd`), `${prose(CAP - 5)} ab`);
  assert.equal(redacted(`${prose(CAP - 5)}\tab\u00a0cd`), `${prose(CAP - 5)} ab`);
  // a text that fits comes out as the shared scrubber makes it: its secrets hidden, its white space squeezed
  for (const text of [`Rotate ${FAKE.client} now`, `a ${FAKE.shortJwt}\n${FAKE.jwt}\t ok`, '  spaced   out \n words  ', `${prose(CAP - 1)} `]) {
    assert.equal(redacted(text), scrub(text, []), JSON.stringify(text));
  }

  // a secret at the cut: it is hidden before the cut is made, so the marker is what stands at the cut and none of the secret
  const secrets = [
    ['a GitHub key', PROVIDER_KEYS.ghp, '[redacted]', PROVIDER_KEYS.ghp],
    ['an OpenAI key', PROVIDER_KEYS.skProj, '[redacted]', PROVIDER_KEYS.skProj],
    ['a JWT', FAKE.jwt, '[redacted]', FAKE.jwt],
    ['a short JWT', FAKE.shortJwt, '[redacted]', FAKE.shortJwt],
    ['a client secret', FAKE.client, '[redacted]', FAKE.client],
    ['a Bearer value', `Bearer ${FAKE.bearer}`, '[redacted]', FAKE.bearer],
    ['a password pair', 'password=T0pS3cretValue99', 'password=[redacted]', 'T0pS3cretValue99'],
    ['a login in a link', `https://deploy:${FAKE.login}@app.example.com/login`, 'https://[redacted]@app.example.com/login', FAKE.login],
  ];
  for (const [kind, secret, hidden, secretPart] of secrets) {
    for (const after of [tail, '']) {
      for (let start = 240; start <= CAP + 2; start += 1) {
        const before = prose(start - 1);
        const shown = redacted(`${before} ${secret}${after}`);
        assert.equal(shown, wholeWordsWithin(`${before} ${hidden}${after}`), `${kind} starting at ${start}`);
        for (const part of windowsOf(secretPart)) assert.ok(!shown.includes(part), `"${part}" of ${kind} starting at ${start} reached the screen`);
      }
    }
  }

  // a link of exactly 300 characters is still printed whole, and one of 301 is not printed at all
  const exact = `https://example.org/${'a'.repeat(CAP - 20)}`;
  assert.equal(exact.length, CAP);
  assert.equal(printableLink(exact), exact);
  assert.equal(printableLink(`${exact}a`), null);
});

// ---- a reason the store cut ----------------------------------------------------------

// A release reason is kept to 300 characters. The store cuts what a person types and puts "..." at the end
// (RELEASE_REASON_MAX in lib/task-db.js), and a flight cuts its own reason at 300 with nothing added (releaseReason
// in lib/fleet.js). So a key can stand across the cut, and ghp_ with some of its characters is a piece the key rule
// cannot know. The words before the key are plain.
const STORE_CUT = 300;
const PLAIN_WORDS = 'rejected by the hook ';

// A reason as a flight saves it: exactly `length` characters, the last of them the first `shown` of `key`.
function cutInsideKey(key, shown, length = STORE_CUT) {
  const before = repeatTo(PLAIN_WORDS, length - shown - 1).replace(/ $/, 'x');
  const piece = key.slice(0, shown);
  return { before, piece, reason: `${before} ${piece}` };
}

// The ways the cut can fall through each kind of secret: just the start of it, part of it, all but the last character.
const cutPoints = (key) => [...new Set([Math.min(5, key.length - 1), key.length >> 1, key.length - 1])];

const CUT_KEYS = {
  ...PROVIDER_KEYS,
  jwt: FAKE.jwt,
  webhook: FAKE.webhook,
  login: `https://deploy:${FAKE.login}@git.example.com/acme/widgets.git`,
  password: 'password=T0pS3cretValue99',
};
// A link or a pair starts with words that stand in the rest of the screen too, so only the other kinds are looked for by their pieces.
const OWN_PIECES = Object.keys(CUT_KEYS).filter((kind) => !['webhook', 'login', 'password'].includes(kind));

test('a key across the cut of a stored reason leaves no piece of itself in the team table, the page, or the json', { skip: !HAS_SQLITE }, async () => {
  const shapes = [];
  Object.entries(CUT_KEYS).forEach(([kind, key]) => cutPoints(key).forEach((shown) => shapes.push({ kind, shown, member: `fleet-cut-${shapes.length}`, ...cutInsideKey(key, shown) })));
  assert.ok(shapes.length >= 40, 'many kinds of key, each cut in a few places');
  for (const shape of shapes) assert.equal(shape.reason.length, STORE_CUT);
  const scn = workspaceWith('atris-brief-owner-storecut-', (store) => {
    shapes.forEach((shape, i) => dropped(store, { id: `SC${i}`, title: `Cut job ${i}`, member: shape.member, at: ago(2), reason: shape.reason }));
  });
  const data = await briefDataOf(scn);
  for (const shape of shapes) {
    const row = data.team.find((item) => item.member === shape.member);
    assert.ok(row, `${shape.kind} cut after ${shape.shown}: the member has a row`);
    assert.equal(row.top_miss.count, 1);
    // the last word is dropped whole, and the words before it are printed as they were
    assert.equal(row.top_miss.reason, shape.before, `${shape.kind} cut after ${shape.shown} characters`);
  }
  for (const [where, body] of everyOutput(data)) {
    for (const shape of shapes.filter((item) => OWN_PIECES.includes(item.kind))) {
      for (const part of windowsOf(shape.piece)) assert.ok(!body.includes(part), `"${part}" of ${shape.kind} cut after ${shape.shown} reached ${where}`);
    }
  }
});

test('a reason the real store cut at 300 characters leaves no piece of a key, and a reason it did not cut keeps its last word', { skip: !HAS_SQLITE }, async () => {
  const tasks = require('../lib/task-db');
  const scn = makeWorkspace('atris-brief-owner-realcut-', 'git@github.com:acme/widgets.git');
  const key = PROVIDER_KEYS.ghp;
  // a key that starts before the store's cut (297 characters, then "...") and runs on well past it
  const shapes = [4, 12, 20, 33].map((shown, i) => {
    const before = repeatTo(PLAIN_WORDS, 297 - shown - 1).replace(/ $/, 'x');
    return { shown, before, piece: key.slice(0, shown), member: `fleet-real-${i}`, reason: `${before} ${key} and the retry failed again` };
  });
  const kept = [
    { member: 'fleet-short', reason: 'tests failed' },
    { member: 'fleet-mid', reason: `${repeatTo(PLAIN_WORDS, 240).replace(/ $/, 'x')} finished` },
  ];
  const savedBy = new Map();
  await withEnv({ ATRIS_TASKS_DB: scn.dbPath, ATRIS_TEST_STATE_DIR: scn.stateDir }, () => {
    const db = tasks.open(scn.dbPath);
    try {
      [...shapes, ...kept].forEach(({ member, reason }, i) => {
        const { id } = tasks.addTask(db, { title: `Real cut job ${i}`, workspaceRoot: scn.ws });
        assert.equal(tasks.claimTask(db, { id, claimedBy: member, leaseMinutes: 30 }).claimed, true);
        assert.equal(tasks.releaseTask(db, { id, actor: member, reason }).released, true);
      });
      for (const row of db.prepare("SELECT payload FROM task_events WHERE event_type = 'claim_released'").all()) {
        const payload = JSON.parse(row.payload);
        savedBy.set(payload.released_by, payload.reason);
      }
    } finally {
      tasks.close();
    }
  });
  for (const shape of shapes) {
    const saved = savedBy.get(shape.member);
    assert.equal(saved.length, STORE_CUT, 'the store keeps 297 characters and adds three dots');
    assert.ok(saved.endsWith(`${shape.piece}...`), `the store left ${shape.piece} and the dots at the end`);
  }
  assert.equal(savedBy.get('fleet-short'), 'tests failed');
  const data = await briefDataOf(scn, { now: Date.now() + HOUR });
  for (const shape of shapes) {
    const row = data.team.find((item) => item.member === shape.member);
    assert.ok(row, `${shape.member} has a row`);
    assert.equal(row.top_miss.reason, shape.before, `a key cut after ${shape.shown} characters by the store`);
  }
  // a reason shorter than the cut is printed whole
  assert.equal(data.team.find((item) => item.member === 'fleet-short').top_miss.reason, 'tests failed');
  assert.match(data.team.find((item) => item.member === 'fleet-mid').top_miss.reason, / finished$/);
  for (const [where, body] of everyOutput(data)) {
    for (const shape of shapes) for (const part of windowsOf(shape.piece)) assert.ok(!body.includes(part), `"${part}" reached ${where}`);
  }
});

test('a reason or a note as long as the store keeps loses its last word before it is cleaned, and a shorter or a longer one keeps it', () => {
  const { reasonOf, redacted } = require('../lib/owner-brief');
  // exactly `length` characters of plain words, ending in a letter
  const words = (length) => repeatTo(PLAIN_WORDS, length).replace(/ $/, 'x');
  // `length` characters in all, the last of them a piece of a key, a space (or a line break, or a tab) before it
  const endingIn = (piece, length, space = ' ') => `${words(length - piece.length - space.length)}${space}${piece}`;
  for (const length of [300, 299, 298, 290, 285, 281, 280]) {
    for (const [piece, space] of [['ghp_a', ' '], ['ghp_abc...', ' '], ['ghp_a', '\n'], ['ghp_a', '\t'], ['ghp_a', '  ']]) {
      const text = endingIn(piece, length, space);
      assert.equal(text.length, length);
      // the piece goes (the dots the store puts on what it cuts go with it), and the words before it are as they were
      assert.equal(reasonOf(text), words(length - piece.length - space.length), `${length} characters, ${JSON.stringify(space)} then ${piece}`);
    }
  }
  // a space at the very end (the store trims it) does not save the word before it
  assert.equal(reasonOf(`${endingIn('ghp_a', 299)} `), words(299 - 6));
  // shorter than that, the text was not cut at 300 by the store, so its last word is its own
  for (const length of [279, 250, 120, 40, 12]) {
    const text = `${words(length - 5)} done`;
    assert.equal(text.length, length);
    assert.equal(reasonOf(text), text, `${length} characters`);
    assert.equal(reasonOf(text), redacted(text));
    // unless it is the start of a key: a flight cuts before the store squeezes spaces, so a cut reason can be any length
    const cut = endingIn('ghp_a', length);
    assert.equal(reasonOf(cut), `${words(length - 6)} [redacted]`, `${length} characters ending in the start of a key`);
  }
  // longer than the store keeps, it was not cut by the store, so it is cleaned as it is
  for (const length of [301, 320, 1000]) {
    const text = endingIn('ghp_a', length);
    assert.equal(reasonOf(text), redacted(text), `${length} characters`);
  }
  // with no space to back up to there is no word to keep, and nothing at all is not an error
  assert.equal(reasonOf('a'.repeat(290)), '');
  for (const nothing of [null, undefined, '', '   ']) assert.equal(reasonOf(nothing), '');
  // a whole key is hidden wherever it stands; at the end of a text this long it goes with the last word
  assert.equal(reasonOf(`${words(100)} ${PROVIDER_KEYS.ghp}`), `${words(100)} [redacted]`);
  assert.equal(reasonOf(`${words(250)} ${PROVIDER_KEYS.ghp}`), words(250));
});

test('a reason a flight cut at 300 and the store then squeezed spaces out of is treated as cut too', { skip: !HAS_SQLITE }, async () => {
  // the flight cuts at 300 first, and the store then turns every run of spaces into one, so the saved reason is shorter than 300
  const key = PROVIDER_KEYS.skAnt;
  const shown = 20;
  const base = repeatTo(PLAIN_WORDS, STORE_CUT - shown - 1 - 12).replace(/ $/, 'x');
  let widened = 0;
  const before = base.replace(/ /g, (space) => (widened++ < 6 ? '   ' : space));
  const raw = `${before} ${key.slice(0, shown)}`;
  assert.equal(raw.length, STORE_CUT);
  const saved = raw.replace(/\s+/g, ' ').trim();
  assert.equal(saved.length, STORE_CUT - 12, 'twelve characters were squeezed out');
  assert.ok(saved.endsWith(key.slice(0, shown)));
  const scn = workspaceWith('atris-brief-owner-squeezed-', (store) => {
    dropped(store, { id: 'SQ1', title: 'Squeezed job', member: 'fleet-squeezed', at: ago(2), reason: saved });
  });
  const row = (await briefDataOf(scn)).team.find((item) => item.member === 'fleet-squeezed');
  assert.equal(row.top_miss.reason, before.replace(/\s+/g, ' '), 'the key is gone and the words before it are as they were');
});

test('a reason well under the cut is printed whole, and a refused job and a job sent back twice with a cut reason show no piece of the key', { skip: !HAS_SQLITE }, async () => {
  const shortReasons = ['tests failed', 'ran out of time on step 3', `${repeatTo(PLAIN_WORDS, 150).replace(/ $/, 'x')} done`, `${repeatTo(PLAIN_WORDS, 230).replace(/ $/, 'x')} done`];
  const cut = cutInsideKey(PROVIDER_KEYS.gho, 20);
  const scn = workspaceWith('atris-brief-owner-undercut-', (store) => {
    shortReasons.forEach((reason, i) => dropped(store, { id: `UC${i}`, title: `Short reason job ${i}`, member: `fleet-under-${i}`, at: ago(2), reason }));
    // a billing job a builder let go of, with a reason cut in the middle of a key
    dropped(store, { id: 'UCP', title: 'Billing job a builder let go of', member: 'fleet-refused', tag: 'billing', at: ago(1), reason: cut.reason });
    sentBack(store, {
      id: 'UCS', title: 'Make the report faster', member: 'fleet-codex', claimedAt: ago(11),
      notes: [{ at: ago(8), note: 'first try' }, { at: ago(2), note: cut.reason }],
    });
  });
  const data = await briefDataOf(scn);
  shortReasons.forEach((reason, i) => assert.equal(data.team.find((item) => item.member === `fleet-under-${i}`).top_miss.reason, reason, `reason ${i}`));
  const need = (id) => data.needs_you.find((item) => item.task_id === id);
  assert.match(need('UCP').why, /Reason given: "rejected by the hook rejected by the hook/);
  assert.match(need('UCS').why, /Last note: "rejected by the hook rejected by the hook/);
  assert.equal(data.team.find((item) => item.member === 'fleet-refused').top_miss.reason, cut.before);
  for (const [where, body] of everyOutput(data)) {
    for (const part of windowsOf(cut.piece)) assert.ok(!body.includes(part), `"${part}" reached ${where}`);
  }
});

// ---- the start of a key at the end of a field ----------------------------------------------
//
// A flight cuts a reason at 300 characters before the store squeezes runs of spaces to one, so a reason that ends in
// a piece of a key can be far shorter than 300 (a reviewer saved one of 41 characters). The key rules want the whole
// body (ghp_ and ten more characters is under their 36), so such a piece would print as it is. A cut can only leave
// the start of a key at the end of a field, so the last word of a field is hidden from the start of a key on,
// whatever the length of the field, of the word, or of the body. The rule is for the words of a field: a key start
// in the middle of a text is left to the key rules. A start right after a slash is the name of a repository, a branch,
// or a folder, and a link is read only in front of its path (a login, a webhook address), where no name begins like a key.

// One real-shaped key for each provider rule of the security scan, and one for each way a key starts. Built from
// pieces, like the keys above. `inWords` marks a start that also stands inside ordinary words (task-12, MSG.,
// EURASIA, pnpm_store, highs_total, task_live_report, SurveyJob), which count only at the start of a word.
const KEY_SAMPLES = [
  { rule: 'github-token', start: 'ghp_', key: PROVIDER_KEYS.ghp },
  { rule: 'github-token', start: 'gho_', key: PROVIDER_KEYS.gho },
  { rule: 'github-token', start: 'ghs_', key: PROVIDER_KEYS.ghs, inWords: true },
  { rule: 'github-token', start: 'ghu_', key: PROVIDER_KEYS.ghu },
  { rule: 'github-token', start: 'ghr_', key: PROVIDER_KEYS.ghr },
  { rule: 'github-token', start: 'github_pat_', key: PROVIDER_KEYS.githubPat },
  { rule: 'openai-key', start: 'sk-', key: PROVIDER_KEYS.sk, inWords: true },
  { rule: 'openai-key', start: 'sk-proj-', key: PROVIDER_KEYS.skProj, inWords: true },
  { rule: 'anthropic-key', start: 'sk-ant-', key: PROVIDER_KEYS.skAnt, inWords: true },
  { rule: 'slack-token', start: 'xoxb-', key: PROVIDER_KEYS.xoxb },
  { rule: 'slack-token', start: 'xoxp-', key: PROVIDER_KEYS.xoxp },
  { rule: 'slack-token', start: 'xoxa-', key: PROVIDER_KEYS.xoxa },
  { rule: 'slack-token', start: 'xoxr-', key: PROVIDER_KEYS.xoxr },
  { rule: 'slack-token', start: 'xoxs-', key: ['xoxs', '1234567890', 'AbCdEfGhIj'].join('-') },
  { rule: 'slack-webhook', start: 'https://hooks.slack.com/services/', key: FAKE.webhook },
  { rule: 'aws-access-key-id', start: 'AKIA', key: PROVIDER_KEYS.aws, inWords: true },
  { rule: 'aws-access-key-id', start: 'ASIA', key: ['ASIA', 'Q7ZP3LM29XK4VB8N'].join(''), inWords: true },
  { rule: 'google-api-key', start: 'AIza', key: ['AI', 'za', 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'].join('') },
  { rule: 'stripe-key', start: 'sk_live_', key: ['sk', 'live', KEY_BODY.slice(0, 22)].join('_'), inWords: true },
  { rule: 'stripe-key', start: 'rk_live_', key: ['rk', 'live', KEY_BODY.slice(0, 22)].join('_'), inWords: true },
  { rule: 'npm-token', start: 'npm_', key: ['npm', KEY_BODY].join('_'), inWords: true },
  { rule: 'sendgrid-key', start: 'SG.', key: ['SG', KEY_BODY.slice(0, 22), (KEY_BODY + KEY_BODY).slice(0, 43)].join('.'), inWords: true },
  { rule: 'jwt', start: 'eyJ', key: FAKE.jwt, inWords: true },
  // the client secret scrub finds: it is not one of the scan's rules
  { rule: 'client-secret', start: 'atcs_', key: FAKE.client },
];

// A key start and ten more characters of its body, the shape of the piece a reviewer saved.
const startPlusTen = (sample) => sample.key.slice(0, sample.start.length + 10);

test('the start of a key at the end of a field is hidden whatever the length of the key, the word, or the field', () => {
  const { redacted, reasonOf, CLEAN_MAX } = require('../lib/owner-brief');
  const { SECRET_RULES } = require('../lib/security-scan');
  // every provider key the scan finds has a sample here, and each sample is a real key of its rule
  const providers = SECRET_RULES.filter((rule) => (rule.known && rule.id !== 'private-key') || rule.id === 'jwt');
  for (const rule of providers) {
    assert.ok(KEY_SAMPLES.some((sample) => sample.rule === rule.id), `${rule.id} has no sample key here: add one, and its start to the key starts in lib/owner-brief.js`);
  }
  for (const sample of KEY_SAMPLES) {
    const rule = SECRET_RULES.find((item) => item.id === sample.rule);
    if (rule) assert.ok(rule.re.test(sample.key), `the ${sample.start} sample is a ${sample.rule}`);
    assert.ok(sample.key.startsWith(sample.start), `the sample key starts with ${sample.start}`);
  }
  const before = 'rejected by the hook';
  for (const sample of KEY_SAMPLES) {
    // every place a cut can fall after the start: the start alone, then each character more, then the whole key
    for (let shown = sample.start.length; shown <= sample.key.length; shown += 1) {
      const text = `${before} ${sample.key.slice(0, shown)}`;
      assert.equal(redacted(text), `${before} [redacted]`, `${sample.start}, ${shown} of ${sample.key.length} characters`);
      assert.equal(reasonOf(text), `${before} [redacted]`, `${sample.start}, ${shown} of ${sample.key.length} characters, as a reason`);
    }
    // the word is hidden from the start of the key, and what stands in front of it stays: the words before it, and
    // anything glued to it that is not a letter or a digit
    const piece = startPlusTen(sample);
    for (const glue of ['worker_', 'key:', '(', '"', 'a-', 'team.', '=', '[', '#']) {
      assert.equal(redacted(`${before} ${glue}${piece}`), `${before} ${glue}[redacted]`, `${sample.start} after "${glue}"`);
    }
    // a start that is never part of an ordinary word counts after a letter or a digit too, as a whole key does
    if (!sample.inWords) {
      for (const glue of ['Worker', 'x', '9']) assert.equal(redacted(`${before} ${glue}${piece}`), `${before} ${glue}[redacted]`, `${sample.start} after "${glue}"`);
    }
    // only the last word: a start with a short body and something after it is not at the end of the field, and is not a key
    if (sample.start !== 'atcs_') {
      const middle = `${before} ${sample.key.slice(0, sample.start.length + 3)} and then it passed`;
      assert.equal(redacted(middle), middle, `${sample.start} in the middle`);
    }
    // the line breaks and tabs a reason can end in
    assert.equal(redacted(`${before}\n${piece}\n`), `${before} [redacted]`, `${sample.start} after a line break`);
    assert.equal(redacted(`${before}\t${piece}  `), `${before} [redacted]`, `${sample.start} after a tab, with spaces at the end`);
  }
  // a text that is only the start of a key, and a text with a space before it that is nothing else
  assert.equal(redacted('ghp_abcdefghij'), '[redacted]');
  assert.equal(redacted('  ghp_abcdefghij  '), '[redacted]');
  // the first start in the last word is where the hiding begins
  assert.equal(redacted('see a=b:ghp_abc=sk-xyz'), 'see a=b:[redacted]');
  // nothing, and a text with no last word, are not errors
  for (const nothing of [null, undefined, '', '   ', '\n']) assert.equal(redacted(nothing), '');
  // the last word is looked at once: a long last word of the same few characters is cleaned in moments
  for (const unit of ['ab-', 'a_', 'sk', 'ghp', 'eyJ', 'AKI', 'SG', 'npm', 'xox', '.', '9', 'a/']) {
    const text = `start ${repeatTo(unit, CLEAN_MAX - 10)}`;
    let out;
    const ms = milliseconds(() => { out = redacted(text); });
    assert.ok(ms < LIMIT_MS, `a last word of ${JSON.stringify(unit)} took ${ms.toFixed(0)} ms`);
    assert.ok(out.startsWith('start'), `${JSON.stringify(unit)}`);
  }
});

test('ordinary words at the end of a field are left alone, and so is a link', () => {
  const { redacted, printableLink } = require('../lib/owner-brief');
  const ordinary = [
    'Fix task-12', 'Fix the disk-1', 'Look at risk-x', 'ask-me', 'Run the flask-app', 'Add a mask-fix',
    'Write the MSG.', 'Grow in EURASIA', 'Move to pnpm_store', 'Add highs_total', 'Fix task_live_report',
    'Rename the worker_atcs', 'The whatcs ok', 'Use GitHub', 'Fix the sk', 'Fix the ghp', 'Say xoxo', 'Check the eyes',
    'Fix github_pat', 'Rotate all keys', 'Read the SG', 'Ship it', 'Rating: 7',
    'Fix SurveyJob', 'Read the KeyJar', 'Print npm_config_global', 'Set npm_package_version', 'Clear npm_lifecycle_event',
  ];
  for (const text of ordinary) assert.equal(redacted(text), text);
  // a start with a short body is not hidden anywhere but at the end of a field
  for (const sample of KEY_SAMPLES.filter((item) => item.rule !== 'client-secret')) {
    const middle = `Rotate ${sample.start}x1 now`;
    assert.equal(redacted(middle), middle);
  }
  // a link is left to the key rules: a repository or a folder with a key start in its name is still a link
  for (const link of ['https://github.com/acme/sk-tools/pull/12', 'https://github.com/acme/npm_tools/pull/12', 'https://github.com/acme/ghs_notes/commit/1a2b3c4d5e6f', 'https://github.com/acme/widgets/pull/12']) {
    assert.equal(printableLink(link), link);
  }
  assert.equal(printableLink(`https://ci.example.com/runs/worker_${PROVIDER_KEYS.ghp}`), null);
});

test('a link or a path at the end of a field is left alone, and a key start right after a slash does not count', () => {
  const { redacted, reasonOf } = require('../lib/owner-brief');
  // the two a reviewer saved: a repository named sk-tools in a link, and a branch named sk-tools
  for (const text of ['Review https://github.com/acme/sk-tools/pull/12', 'Merge feature/sk-tools']) {
    assert.equal(redacted(text), text);
    assert.equal(reasonOf(text), text);
  }
  // every kind of start, as the name of a repository, a branch, a folder, and a file. (The client secret scrub hides atcs_ in any
  // word, a name included, because that prefix is only ever a secret.)
  for (const sample of KEY_SAMPLES.filter((item) => item.rule !== 'slack-webhook' && item.start !== 'atcs_')) {
    const name = `${sample.start}tools`;
    for (const text of [
      `Review https://github.com/acme/${name}/pull/12`,
      `Review https://github.com/acme/widgets/tree/${name}`,
      `Review (https://github.com/acme/${name}/pull/12)`,
      `Review <https://github.com/acme/${name}>`,
      `Review see:https://github.com/acme/${name}`,
      `Clone git@github.com:acme/${name}.git`,
      `Clone ssh://github.com/acme/${name}.git`,
      `Merge feature/${name}`,
      `Open src/${name}/index.js`,
      `Open /${name}`,
    ]) assert.equal(redacted(text), text, text);
  }
  // a host named like a start is a host
  for (const text of ['Review https://sk-tools.example.com/pull/12', 'Open https://www.sk-ii.com', 'Open https://dev-sk-tools.example.com', 'Open https://SG.example.com', 'Open https://AKIAtools.example.com/x']) {
    assert.equal(redacted(text), text, text);
  }
  // a key at the end of a title is hidden, whole or in part, and what stands before it is kept
  for (const sample of KEY_SAMPLES) {
    assert.equal(redacted(`Rotate the deploy key ${sample.key}`), 'Rotate the deploy key [redacted]', `${sample.start}, the whole key`);
    assert.equal(redacted(`Rotate the deploy key ${startPlusTen(sample)}`), 'Rotate the deploy key [redacted]', `${sample.start} and ten more characters`);
  }
  // only the last word is read: a name in front of a key is kept
  assert.equal(redacted(`Merge feature/sk-tools ${PROVIDER_KEYS.sk.slice(0, 13)}`), 'Merge feature/sk-tools [redacted]');
  assert.equal(redacted(`Review https://github.com/acme/sk-tools/pull/12 ${PROVIDER_KEYS.ghp.slice(0, 14)}`), 'Review https://github.com/acme/sk-tools/pull/12 [redacted]');
  // a login or a webhook address cut short is not a name: it is read in front of the path of a link
  const piece = PROVIDER_KEYS.ghp.slice(0, 14);
  assert.equal(redacted(`Clone failed for https://${piece}`), 'Clone failed for https://[redacted]');
  assert.equal(redacted(`Clone failed for https://deploy:${piece}`), 'Clone failed for https://deploy:[redacted]');
  assert.equal(redacted(`Post failed for ${startPlusTen(KEY_SAMPLES.find((item) => item.rule === 'slack-webhook'))}`), 'Post failed for [redacted]');
  // after a slash a start is a name, in a folder and in the path of a link alike: that is left alone, as asked,
  // and a whole key in either place is still hidden by the key rules
  assert.equal(redacted(`Open feature/${piece}`), `Open feature/${piece}`);
  assert.equal(redacted(`Open https://ci.example.com/runs/${piece}`), `Open https://ci.example.com/runs/${piece}`);
  assert.equal(redacted(`Open feature/${PROVIDER_KEYS.ghp}`), 'Open feature/[redacted]');
  assert.equal(redacted(`Open https://ci.example.com/runs/${PROVIDER_KEYS.ghp}`), 'Open https://ci.example.com/runs/[redacted]');
});

test('a link or a path at the end of a title, a note, a reason, or a tag keeps its names in every output, and a key at the end is still hidden', { skip: !HAS_SQLITE }, async () => {
  const gh = PROVIDER_KEYS.ghp.slice(0, 14);
  const scn = workspaceWith('atris-brief-owner-names-', (store) => {
    landed(store, { id: 'NM1', title: 'Move it to https://github.com/acme/sk-tools/pull/12', member: 'fleet-codex', tag: 'lane/sk-tools', at: ago(1) });
    landed(store, { id: 'NM2', title: 'Rename it to feature/sk-tools', member: 'fleet-codex', tag: 'lane/sk-tools', at: ago(2) });
    landed(store, { id: 'NM3', title: `Rotate the key ${gh}`, member: 'fleet-codex', tag: 'lane/sk-tools', at: ago(3) });
    sentBack(store, {
      id: 'NM4', title: 'Make the report faster', member: 'fleet-sonnet', claimedAt: ago(11),
      notes: [{ at: ago(8), note: 'first try' }, { at: ago(2), note: 'still fails on feature/sk-tools' }],
    });
    dropped(store, { id: 'NM5', title: 'Billing job a builder let go of', member: 'fleet-refused', tag: 'billing', at: ago(1), reason: 'push failed for https://github.com/acme/sk-tools' });
  });
  const data = await briefDataOf(scn);
  const done = (id) => data.done_this_week.find((item) => item.task_id === id);
  const need = (id) => data.needs_you.find((item) => item.task_id === id);
  assert.equal(done('NM1').title, 'Move it to https://github.com/acme/sk-tools/pull/12');
  assert.equal(done('NM2').title, 'Rename it to feature/sk-tools');
  assert.equal(done('NM3').title, 'Rotate the key [redacted]');
  assert.match(need('NM4').why, /Last note: "still fails on feature\/sk-tools"/);
  assert.match(need('NM5').why, /Reason given: "push failed for https:\/\/github\.com\/acme\/sk-tools"/);
  assert.equal(data.team.find((item) => item.member === 'fleet-refused').top_miss.reason, 'push failed for https://github.com/acme/sk-tools');
  assert.equal(data.team.find((item) => item.member === 'fleet-codex').best_lane, 'lane/sk-tools');
  for (const [where, body] of everyOutput(data)) {
    for (const name of ['github.com/acme/sk-tools/pull/12', 'feature/sk-tools']) assert.ok(body.includes(name), `${name} is missing from ${where}`);
    for (const part of windowsOf(gh)) assert.ok(!body.includes(part), `"${part}" reached ${where}`);
  }
});

test('a reason of 41 characters that ends in the start of a key shows no piece of it, for every kind of key', { skip: !HAS_SQLITE }, async () => {
  // the shape the reviewer saved: 41 characters, the last of them a key start and ten more characters
  // (a start longer than that, a webhook link, needs room: it is twenty characters longer than its piece)
  const shapes = KEY_SAMPLES.map((sample, i) => {
    const piece = startPlusTen(sample);
    const length = Math.max(41, piece.length + 20);
    const before = repeatTo(PLAIN_WORDS, length - piece.length - 1).replace(/ $/, 'x');
    return { ...sample, piece, length, before, reason: `${before} ${piece}`, member: `fleet-start-${i}` };
  });
  assert.equal(shapes[0].piece, PROVIDER_KEYS.ghp.slice(0, 14), 'ghp_ and ten more characters');
  assert.equal(shapes[0].reason.length, 41);
  assert.ok(shapes.filter((shape) => shape.reason.length === 41).length >= 20, 'nearly every kind fits in 41 characters');
  for (const shape of shapes) assert.equal(shape.reason.length, shape.length);
  const scn = workspaceWith('atris-brief-owner-startcut-', (store) => {
    shapes.forEach((shape, i) => dropped(store, { id: `KC${i}`, title: `Short cut job ${i}`, member: shape.member, at: ago(2), reason: shape.reason }));
  });
  const data = await briefDataOf(scn);
  for (const shape of shapes) {
    const row = data.team.find((item) => item.member === shape.member);
    assert.ok(row, `${shape.start}: the member has a row`);
    assert.equal(row.top_miss.count, 1);
    assert.equal(row.top_miss.reason, `${shape.before} [redacted]`, `${shape.start} and ten more characters in ${shape.length}`);
  }
  for (const [where, body] of everyOutput(data)) {
    for (const shape of shapes) {
      assert.ok(!body.includes(shape.piece.slice(shape.start.length)), `the body of ${shape.start} reached ${where}`);
      // a link's windows are words that stand in the rest of the screen too, so only the other kinds are looked for by their pieces
      if (shape.rule === 'slack-webhook') continue;
      for (const part of windowsOf(shape.piece)) assert.ok(!body.includes(part), `"${part}" of ${shape.start} reached ${where}`);
      assert.ok(!body.includes(shape.piece.slice(0, shape.start.length + 3)), `${shape.start} and its first characters reached ${where}`);
    }
  }
});

test('a short reason the real task store saved, ending in the start of a key, shows no piece of it', { skip: !HAS_SQLITE }, async () => {
  const tasks = require('../lib/task-db');
  const scn = makeWorkspace('atris-brief-owner-realstart-', 'git@github.com:acme/widgets.git');
  const shapes = KEY_SAMPLES.map((sample, i) => {
    const piece = startPlusTen(sample);
    const length = Math.max(41, piece.length + 20);
    const before = repeatTo(PLAIN_WORDS, length - piece.length - 1).replace(/ $/, 'x');
    return { ...sample, piece, before, reason: `${before} ${piece}`, member: `fleet-realstart-${i}` };
  });
  const savedBy = new Map();
  await withEnv({ ATRIS_TASKS_DB: scn.dbPath, ATRIS_TEST_STATE_DIR: scn.stateDir }, () => {
    const db = tasks.open(scn.dbPath);
    try {
      shapes.forEach(({ member, reason }, i) => {
        const { id } = tasks.addTask(db, { title: `Real start job ${i}`, workspaceRoot: scn.ws });
        assert.equal(tasks.claimTask(db, { id, claimedBy: member, leaseMinutes: 30 }).claimed, true);
        assert.equal(tasks.releaseTask(db, { id, actor: member, reason }).released, true);
      });
      for (const row of db.prepare("SELECT payload FROM task_events WHERE event_type = 'claim_released'").all()) {
        const payload = JSON.parse(row.payload);
        savedBy.set(payload.released_by, payload.reason);
      }
    } finally {
      tasks.close();
    }
  });
  for (const shape of shapes) assert.equal(savedBy.get(shape.member), shape.reason, 'the store keeps a reason this short as it was given');
  const data = await briefDataOf(scn, { now: Date.now() + HOUR });
  for (const shape of shapes) {
    const row = data.team.find((item) => item.member === shape.member);
    assert.ok(row, `${shape.member} has a row`);
    assert.equal(row.top_miss.reason, `${shape.before} [redacted]`, `${shape.start} and ten more characters, saved by the store`);
  }
  for (const [where, body] of everyOutput(data)) {
    for (const shape of shapes) assert.ok(!body.includes(shape.piece.slice(shape.start.length)), `the body of ${shape.start} reached ${where}`);
  }
});

test('the start of a key at the end of a title, a builder name, a tag, a note, or a reason is hidden in every output', { skip: !HAS_SQLITE }, async () => {
  const k = PROVIDER_KEYS;
  const gh = k.ghp.slice(0, 14);
  const aws = k.aws.slice(0, 14);
  const slack = k.xoxb.slice(0, 13);
  const sk = k.sk.slice(0, 13);
  const pat = k.githubPat.slice(0, 21);
  const anthropic = k.skAnt.slice(0, 17);
  const scn = workspaceWith('atris-brief-owner-keystart-', (store) => {
    landed(store, { id: 'KS1', title: `Rotate the deploy key ${gh}`, member: `worker_${aws}`, tag: `lane-${slack}`, at: ago(1) });
    landed(store, { id: 'KS2', title: 'Landed by the same builder again', member: `worker_${aws}`, tag: `lane-${slack}`, at: ago(2) });
    held(store, { id: 'KS3', title: `Check the token ${sk}`, member: `Worker${pat}`, at: ago(1, 3), pullRequest: { state: 'open', number: 93, url: pullUrl(93) } });
    sentBack(store, {
      id: 'KS4', title: 'Make the report faster', member: 'fleet-codex', claimedAt: ago(11),
      notes: [{ at: ago(8), note: 'first try' }, { at: ago(2), note: `the log ends with ${gh}` }],
    });
    dropped(store, { id: 'KS5', title: 'Billing job a builder let go of', member: 'fleet-refused', tag: 'billing', at: ago(1), reason: `push failed with ${anthropic}` });
  });
  const data = await briefDataOf(scn);
  const need = (id) => data.needs_you.find((item) => item.task_id === id);
  const done = (id) => data.done_this_week.find((item) => item.task_id === id);
  assert.equal(done('KS1').title, 'Rotate the deploy key [redacted]');
  assert.equal(done('KS1').built_by, 'worker_[redacted]');
  assert.equal(need('KS3').title, 'Check the token [redacted]');
  assert.equal(need('KS3').built_by, 'Worker[redacted]');
  assert.match(need('KS4').why, /Last note: "the log ends with \[redacted\]"/);
  assert.match(need('KS5').why, /Reason given: "push failed with \[redacted\]"/);
  const row = data.team.find((item) => item.member === 'worker_[redacted]');
  assert.ok(row, 'the cleaned name is still a row of its own');
  assert.equal(row.best_lane, 'lane-[redacted]');
  assert.equal(data.team.find((item) => item.member === 'fleet-refused').top_miss.reason, 'push failed with [redacted]');
  for (const [where, body] of everyOutput(data)) {
    for (const piece of [gh, aws, slack, sk, pat, anthropic]) {
      for (const part of windowsOf(piece)) assert.ok(!body.includes(part), `"${part}" reached ${where}`);
    }
  }
});

test('a megabyte in a title, a note, a name, a tag, a link, or a proof field is cleaned in moments, not minutes', { skip: !HAS_SQLITE }, async () => {
  const huge = (unit) => repeatTo(unit, MEGABYTE);
  const scn = workspaceWith('atris-brief-owner-huge-', (store) => {
    held(store, { id: 'HG1', title: huge('https://'), member: huge('a.'), tag: huge('eyJ-'), at: ago(1), pullRequest: { state: 'open', number: 71, url: `https://${huge('a.')}` } });
    landedWith(store, { id: 'HG2', title: `Shipped ${huge('ab-')}`, member: huge('sk-'), tag: huge('https://a/'), at: ago(1), payload: { merged_pr: `https://${huge('/a')}` } });
    sentBack(store, {
      id: 'HG3', title: 'Make the report faster', member: 'fleet-codex', claimedAt: ago(11),
      notes: [{ at: ago(8), note: huge('x+') }, { at: ago(2), note: `before ${huge('https://')}` }],
    });
    [3, 4, 5].forEach((days, i) => dropped(store, { id: `HR${i}`, title: `Rate limited job ${i}`, member: 'fleet-limited', at: ago(days), reason: huge('key="') }));
    dropped(store, { id: 'HP1', title: 'Billing job a builder let go of', member: 'fleet-cursor', tag: 'billing', at: ago(2), reason: huge('eyJ-') });
  });
  writeProjection(scn.ws, [
    { id: 'HW', display_id: 'CLI-1', title: huge('a.'), status: 'review', tag: 'customer', updated_at: iso(ago(0, 5)) },
    { id: 'HD1', display_id: 'CLI-2', title: `Shipped, see ${huge('https://')}`, status: 'done', done_at: iso(ago(0, 2)), metadata: { latest_agent_proof: huge('a.') } },
    { id: 'HD2', display_id: 'CLI-3', title: 'Shipped with a huge receipt', status: 'done', done_at: iso(ago(0, 3)), metadata: { latest_agent_proof: `verified, see ${huge('https://')}` } },
    { id: 'HD3', display_id: 'CLI-4', title: 'Shipped with another huge receipt', status: 'done', done_at: iso(ago(0, 4)), metadata: { latest_agent_proof: `pr #12 ${huge('ab-')}` } },
  ]);
  const started = Date.now();
  const data = await briefDataOf(scn);
  const took = Date.now() - started;
  assert.ok(took < 5000, `the whole screen took ${took} ms with a megabyte in each field`);
  for (const [where, body] of everyOutput(data)) {
    assert.ok(body.length < 200000, `${where} stays a screenful, not ${body.length} characters`);
  }
  // the older list still gets a pointer from the words it can read
  assert.equal(data.landed.find((item) => item.id === 'CLI-4').proof, 'pr #12');
  assert.equal(data.landed.find((item) => item.id === 'CLI-3').proof, 'proof on file');
});

test('a short secret in a title, a note, a reason, or a link is hidden in every output', { skip: !HAS_SQLITE }, async () => {
  const scn = workspaceWith('atris-brief-owner-short-', (store) => {
    held(store, { id: 'SH1', title: 'Fix the login when password=hunter2 is set', member: 'fleet-codex', at: ago(1), pullRequest: { state: 'open', number: 61, url: 'https://ci.example.com/runs/token=abc123' } });
    landedWith(store, { id: 'SL1', title: 'Rotate api_key=k9z on the server', at: ago(1), payload: { merged_pr: 'https://ci.example.com/builds/sig=z81' } });
    sentBack(store, {
      id: 'SS1', title: 'Make the report faster', member: 'fleet-codex', claimedAt: ago(11),
      notes: [{ at: ago(8), note: 'first try' }, { at: ago(2), note: 'the log said token=abc123 and pwd: pq81' }],
    });
    [3, 4, 5].forEach((days, i) => dropped(store, { id: `SR${i}`, title: `Rate limited job ${i}`, member: 'fleet-limited', at: ago(days), reason: 'rate limited with api_key=k9z set' }));
    dropped(store, { id: 'SP1', title: 'Billing job a builder let go of', member: 'fleet-cursor', tag: 'billing', at: ago(2), reason: 'blocked by session=s77 timeout' });
  });
  const data = await briefDataOf(scn);
  const need = (id) => data.needs_you.find((item) => item.task_id === id);
  const done = (id) => data.done_this_week.find((item) => item.task_id === id);
  assert.equal(need('SH1').title, 'Fix the login when password=[redacted] is set');
  assert.equal(need('SH1').link, null);
  assert.equal(need('SH1').pull_request, 61, 'the pull request number comes from the record, never from the digits of a link');
  assert.equal(done('SL1').title, 'Rotate api_key=[redacted] on the server');
  assert.equal(done('SL1').link, null);
  assert.equal(done('SL1').pull_request, null, 'a link that was dropped is not read as a pull request number');
  assert.match(need('SS1').why, /Last note: "the log said token=\[redacted\] and pwd: \[redacted\]"/);
  assert.match(need('SP1').why, /Reason given: "blocked by session=\[redacted\] timeout"/);
  assert.equal(data.team.find((row) => row.member === 'fleet-limited').top_miss.reason, 'rate limited with api_key=[redacted] set');
  for (const [where, body] of everyOutput(data)) {
    for (const value of ['hunter2', 'abc123', 'k9z', 'z81', 's77', 'pq81']) assert.ok(!body.includes(value), `${value} reached ${where}`);
    assert.ok(!/\b(?:pull request|Pull request) (?:123|81)\b/.test(body), `digits of a dropped link became a pull request number in ${where}`);
  }
});

test('commit hashes, row ids, and normal pull request and commit links come through untouched', { skip: !HAS_SQLITE }, async () => {
  const { redacted, printableLink } = require('../lib/owner-brief');
  const hash = sha('untouched');
  const links = [
    pullUrl(12), `${pullUrl(12)}/files`, commitUrl('untouched'), `${REPO}/commit/${hash.slice(0, 7)}`, `${REPO}/compare/main...feature`,
    'https://git.example.com/acme/widgets/pull/9', 'https://auth.example.com:8443/callback', 'https://example.com:8080/pull/3',
  ];
  for (const link of links) assert.equal(printableLink(link), link, link);
  const texts = [hash, hash.slice(0, 7), 'CLI-12', 'D-decision', 'H1', 'LKS', 'git@github.com:acme/widgets.git', 'Merged pull request 12 into main: fix the checkout total', `Merged ${commitUrl('untouched')} into main`, ...links];
  for (const text of texts) assert.equal(redacted(text), text, text);

  const scn = workspaceWith('atris-brief-owner-untouched-', (store) => {
    held(store, { id: 'UH1', title: 'Held with a normal link', member: 'fleet-codex', at: ago(1), pullRequest: { state: 'open', number: 71, url: pullUrl(71) } });
    landed(store, { id: 'UL1', title: 'Landed by pull request', member: 'fleet-codex', tag: 'backend', at: ago(1), pr: 72 });
    landed(store, { id: 'UL2', title: 'Landed by commit', member: 'fleet-codex', tag: 'backend', at: ago(2), commit: hash });
  });
  const data = await briefDataOf(scn);
  const need = (id) => data.needs_you.find((item) => item.task_id === id);
  const done = (id) => data.done_this_week.find((item) => item.task_id === id);
  assert.equal(need('UH1').link, pullUrl(71));
  assert.equal(done('UL1').link, pullUrl(72));
  assert.equal(done('UL2').link, `${REPO}/commit/${hash}`);
  assert.equal(done('UL1').built_by, 'fleet-codex');
  assert.equal(data.team[0].member, 'fleet-codex');
  assert.equal(data.team[0].best_lane, 'backend');
  const [screen, json, page] = everyOutput(data).map(([, body]) => body);
  for (const link of [pullUrl(71), pullUrl(72), `${REPO}/commit/${hash}`]) {
    for (const body of [screen, json, page]) assert.ok(body.includes(link), link);
  }
  for (const id of ['UH1', 'UL1', 'UL2']) assert.ok(json.includes(`"task_id": "${id}"`), id);
});

// ---- sent back, and held without a link ------------------------------------------

test('only send-backs from review count toward a job being sent back again and again', { skip: !HAS_SQLITE }, async () => {
  const scn = workspaceWith('atris-brief-owner-reopens-', (store) => {
    const job = (id, title, events) => {
      store.task({ id, title, status: 'open', createdAt: ago(20), updatedAt: ago(1) });
      store.event(id, 'claimed', 'fleet-codex', { claimed_by: 'fleet-codex' }, ago(19));
      events.forEach(([type, payload], i) => store.event(id, type, 'keshavrao', payload, ago(10 - i)));
    };
    const revise = (note, extra = {}) => ['revision_requested', { note, approval_status: 'revise', revision_count: 1, ...extra }];
    // finished and failed work brought back is not a send-back from review
    job('SB1', 'Reopened from finished and failed work', [['reopened', { previous_status: 'done', reason: 'redo it' }], ['reopened', { previous_status: 'failed', reason: 'try again' }]]);
    // an archived job brought back, then sent back once from review: one send-back
    job('SB2', 'Archived once and sent back once', [['reopened', { previous_status: 'archived', reason: 'still wanted' }], revise('one more thing')]);
    // accepted work revised twice was not in review either
    job('SB3', 'Accepted work revised twice', [revise('first change', { previous_status: 'done' }), revise('second change', { previous_status: 'done' })]);
    // sent back from review twice, once by reopening it from review
    job('SB4', 'Sent back from review twice', [['reopened', { previous_status: 'review', reason: 'not what I asked for' }], revise('closer, but the total is off')]);
  });
  const data = await ownerData(scn);
  assert.deepEqual(data.needs_you.map((item) => item.title), ['Sent back from review twice']);
  assert.equal(data.needs_you[0].kind, 'sent_back');
  assert.match(data.needs_you[0].why, /Sent back 2 times/);
  assert.match(data.needs_you[0].why, /the total is off/);
});

test('a job sent back twice stays under Needs you after a could-not-start release, and its words never say a builder let go of it', { skip: !HAS_SQLITE }, async () => {
  // The two send-backs are what need a person. The later release only means the build
  // machine had no room, so it neither removes the job from the screen nor changes what
  // the screen says about it.
  const scn = workspaceWith('atris-brief-owner-sentbackunstarted-', (store) => {
    const job = (id, title, tag) => {
      store.task({ id, title, status: 'open', tag, createdAt: ago(20), updatedAt: ago(1) });
      store.event(id, 'claimed', 'fleet-codex', { claimed_by: 'fleet-codex' }, ago(19));
      [[8, 'numbers look wrong'], [4, 'still wrong']].forEach(([days, note], i) => {
        store.event(id, 'proof_ready', 'fleet-codex', { proof: 'checks pass' }, ago(days, 12));
        store.event(id, 'revision_requested', 'keshavrao', { note, approval_status: 'revise', revision_count: i + 1 }, ago(days));
      });
      store.event(id, 'claimed', 'fleet-codex', { claimed_by: 'fleet-codex' }, ago(2));
      store.event(id, 'claim_released', 'fleet-flight', {
        released_by: 'fleet-flight', previous_claimed_by: 'fleet-codex', reason: 'the build machine had no room left', kind: 'could_not_start',
      }, ago(1));
    };
    job('SU1', 'Sent back twice, then could not start', null);
    job('SU2', 'Protected work sent back twice, then could not start', 'billing');
  });
  const data = await briefDataOf(scn);
  for (const id of ['SU1', 'SU2']) {
    const items = data.needs_you.filter((item) => item.task_id === id);
    assert.equal(items.length, 1, `${id} is listed once`);
    assert.equal(items[0].kind, 'sent_back');
    assert.match(items[0].why, /^Sent back 2 times and still not done\. Last note: "still wrong"$/);
    assert.equal(items[0].built_by, null, 'nobody holds it now');
  }
  assert.equal(data.needs_you.length, 2);
  for (const [where, body] of everyOutput(data)) {
    assert.doesNotMatch(body, /let go of|gave up on|nobody has taken|build machine/i, `${where} says a builder let go of it`);
  }
});

test('a held job with no usable pull request link is shown as link missing, not as ready to merge', { skip: !HAS_SQLITE }, async () => {
  const scn = workspaceWith('atris-brief-owner-heldnolink-', (store) => {
    held(store, { id: 'HN1', title: 'Held, nothing saved about the pull request', member: 'fleet-codex', at: ago(1), pullRequest: { state: 'open' } });
    held(store, { id: 'HN2', title: 'Held, a number and nothing else', member: 'fleet-codex', at: ago(2), pullRequest: { state: 'open', number: 13 } });
    held(store, { id: 'HN3', title: 'Held, a link is saved', member: 'fleet-codex', at: ago(3), pullRequest: { state: 'open', number: 14, url: pullUrl(14) } });
  });
  const data = await ownerData(scn);
  const need = (title) => data.needs_you.find((item) => item.title === title);
  const none = need('Held, nothing saved about the pull request');
  assert.equal(none.kind, 'held');
  assert.equal(none.link, null);
  assert.equal(none.pull_request, null);
  assert.match(none.why, /fleet-codex finished this and opened a pull request, but its link was not saved/);
  assert.doesNotMatch(none.why, /waiting for you to merge/);
  const numbered = need('Held, a number and nothing else');
  assert.match(numbered.why, /opened pull request 13, but its link was not saved/);
  assert.doesNotMatch(numbered.why, /waiting for you to merge/);
  assert.equal(numbered.pull_request, 13);
  assert.match(need('Held, a link is saved').why, /waiting for you to merge it/);
  assert.equal(need('Held, a link is saved').link, pullUrl(14));
});

// ---- pieces ------------------------------------------------------------------

test('a GitHub home page is built from any form of origin, without credentials', () => {
  const { githubBaseUrl } = require('../lib/owner-brief');
  assert.equal(githubBaseUrl('git@github.com:acme/widgets.git'), REPO);
  assert.equal(githubBaseUrl('https://github.com/acme/widgets.git'), REPO);
  assert.equal(githubBaseUrl('https://github.com/acme/widgets'), REPO);
  assert.equal(githubBaseUrl('https://x-access-token:ghp_secret@github.com/acme/widgets.git'), REPO);
  assert.equal(githubBaseUrl('ssh://git@github.com/acme/widgets.git'), REPO);
  assert.equal(githubBaseUrl('ssh://git@github.com:22/acme/widgets.git'), REPO);
  assert.equal(githubBaseUrl('git://github.com/acme/widgets.git/'), REPO);
  assert.equal(githubBaseUrl('https://gitlab.com/acme/widgets.git'), null);
  assert.equal(githubBaseUrl('https://github.com.evil.example/acme/widgets.git'), null);
  assert.equal(githubBaseUrl('/Users/someone/code/widgets'), null);
  assert.equal(githubBaseUrl('https://github.com/acme'), null);
  assert.equal(githubBaseUrl('https://github.com/acme/widgets/../other'), null);
  assert.equal(githubBaseUrl(''), null);
  assert.equal(githubBaseUrl(null), null);
});

test('rating and brief read miss reasons through the same helper', () => {
  const { missReasons } = require('../lib/gm-season');
  const plays = [
    { member: 'a', kind: 'dropped', reason: 'tests failed' },
    { member: 'a', kind: 'dropped', reason: 'tests failed' },
    { member: 'a', kind: 'sent_back', reason: 'wrong numbers' },
    { member: 'a', kind: 'abandoned', reason: 'wrong numbers' },
    { member: 'a', kind: 'dropped', reason: 'a third reason' },
    { member: 'a', kind: 'dropped', reason: 'z fourth reason' },
    { member: 'a', kind: 'dropped', reason: null },
    { member: 'a', kind: 'landed', reason: 'landing words are not a miss' },
    { member: 'b', kind: 'dropped', reason: 'someone else' },
  ];
  assert.deepEqual(missReasons(plays, 'a'), [
    { reason: 'tests failed', count: 2 },
    { reason: 'wrong numbers', count: 2 },
    { reason: 'a third reason', count: 1 },
  ]);
  assert.deepEqual(missReasons(plays, 'a', 1), [{ reason: 'tests failed', count: 2 }]);
  assert.deepEqual(missReasons(plays, 'nobody'), []);
});

test('a: answers follow the numbers on the screen, not the older waiting list', () => {
  const data = {
    needs_you: [
      { title: 'first', accept_id: 'CLI-7' },
      { title: 'second, a pull request to merge', accept_id: null },
    ],
    waiting: [{ id: 'CLI-OLD' }],
    moves: [{ id: 'm1', title: 'a move nobody can see on this screen' }],
  };
  const accepted = [];
  const acceptTask = (id) => { accepted.push(id); return { ok: true, output: `accepted ${id}` }; };
  assert.deepEqual(handleBriefAnswer('/nowhere', data, 'a 1', { acceptTask }), { ok: true, message: 'accepted CLI-7' });
  assert.deepEqual(accepted, ['CLI-7']);
  const second = handleBriefAnswer('/nowhere', data, 'a 2', { acceptTask });
  assert.equal(second.ok, false);
  assert.match(second.message, /merge/i);
  assert.equal(handleBriefAnswer('/nowhere', data, 'a 3', { acceptTask }).ok, false);
  assert.deepEqual(accepted, ['CLI-7']);
  const moved = handleBriefAnswer('/nowhere', data, 'm 1', { approveMove: () => assert.fail('a move that is not on the screen must not be approved') });
  assert.equal(moved.ok, false);
});

test('the prompt is offered only when something on the screen can be accepted', () => {
  const tty = { stdin: { isTTY: true }, stdout: { isTTY: true } };
  const withItem = { needs_you: [{ title: 'x', accept_id: 'CLI-7' }], waiting: [], moves: [{ id: 'm1' }] };
  const mergeOnly = { needs_you: [{ title: 'y', accept_id: null }], waiting: [], moves: [{ id: 'm1' }] };
  assert.equal(shouldPromptBrief({ flags: {}, ...tty, data: withItem }), true);
  assert.equal(shouldPromptBrief({ flags: {}, ...tty, data: mergeOnly }), false);
  assert.equal(shouldPromptBrief({ flags: { noInput: true }, ...tty, data: withItem }), false);
});
