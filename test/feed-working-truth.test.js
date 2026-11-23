'use strict';
// Working holds only work that is moving. Finished work waiting for the person's ok leaves it (the ok card asks), and
// a claim nothing has moved for a day says so on the card instead of looking under way.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tasks = require('../lib/task-db');
const feed = require('../lib/feed-core');
const { project } = require('./helpers/feed-project');

const cards = (ctx, filter = 'all') => feed.listCards(ctx.root, { filter, limit: 100, env: ctx.env }).cards;
const endRuns = (ctx) => {
  const file = path.join(ctx.root, '.atris', 'state', 'feed', 'runs.json');
  if (!fs.existsSync(file)) return;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw.runs || raw.entries || [];
  for (const run of list) { run.status = 'ended'; run.ended_at = new Date().toISOString(); }
  fs.writeFileSync(file, JSON.stringify(raw));
};

test('finished work waiting for an ok is asked for once, in Needs you, and is not shown as Working', (t) => {
  const ctx = project(t);
  const { card } = feed.proposeCard(ctx.root, { as: 'scout', title: 'Call the ten oldest leads', why: 'Old leads answer more often', env: ctx.env });
  feed.decide(ctx.root, card.id, 'approve', { env: ctx.env, deps: ctx.deps });
  endRuns(ctx);
  ctx.db.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(card.source.id);
  const working = cards(ctx, 'working').filter((c) => c.source.id === card.source.id);
  assert.deepEqual(working.map((c) => c.id), [], 'nothing of it is in Working');
  const asks = cards(ctx, 'needs_decision').filter((c) => c.source.id === card.source.id);
  assert.equal(asks.length, 1);
  assert.match(asks[0].id, /:accept$/);
});

test('a claim nothing has moved for a day says so under its title; a fresh one does not', (t) => {
  const ctx = project(t);
  const stale = tasks.addTask(ctx.db, { workspaceRoot: ctx.root, title: 'Sort the inbox', status: 'claimed', claimedBy: 'scout' }).id;
  const fresh = tasks.addTask(ctx.db, { workspaceRoot: ctx.root, title: 'Clean the old notes', status: 'claimed', claimedBy: 'scout' }).id;
  const at = Date.parse('2026-09-23T10:00:00Z');
  ctx.db.prepare('UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?').run(at, at, stale);
  const all = cards(ctx, 'working');
  const old = all.find((c) => c.source.id === stale);
  const now = all.find((c) => c.source.id === fresh);
  assert.ok(old, 'the stale claim keeps its place');
  assert.equal(old.progress && old.progress.text, 'Nothing has moved on this since Sep 23.');
  assert.equal(old.still_since, new Date(at).toISOString());
  assert.ok(now, 'the fresh claim is there');
  assert.ok(!now.still_since, 'a fresh claim is not called still');
  assert.ok(!(now.progress && /Nothing has moved/.test(now.progress.text)));
});
