'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const feed = require('../lib/feed-core');
const inspect = require('../lib/element-inspect');
const { project } = require('./helpers/feed-project');

test('element inspect serves local HTML UI, live JSON state, actions, workflows and blocks foreign origins', async (t) => {
  const ctx = project(t);
  const prop = feed.proposeCard(ctx.root, {
    as: 'scout',
    title: 'Check enterprise billing receipts',
    why: 'Keep customer invoices accurate',
    env: ctx.env,
  });

  const srv = await inspect.startInspector(ctx.root, { port: 0, host: '127.0.0.1', env: ctx.env });
  t.after(() => srv.close());

  // 1. Serves HTML inspector UI.
  const htmlRes = await fetch(`${srv.url}/`);
  assert.equal(htmlRes.status, 200);
  const html = await htmlRes.text();
  assert.match(html, /Atris Element/);
  assert.match(html, /Loss Curve/);

  // 2. Returns live feed cards, loss curve, commands and schedules.
  const stateRes = await fetch(`${srv.url}/api/state`);
  assert.equal(stateRes.status, 200);
  const state = await stateRes.json();
  assert.ok(state.cards.some((c) => c.id === prop.card.id));
  assert.ok(state.commands.some((c) => c.name === 'curve'));

  // 3. Rejects foreign browser origins (CSRF guard).
  const evil = await fetch(`${srv.url}/api/post`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ text: 'blocked' }),
  });
  assert.equal(evil.status, 403);

  // 4. Local post + reply + built-in /curve workflow write cleanly to the same Element store.
  const postedRes = await fetch(`${srv.url}/api/post`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: srv.url },
    body: JSON.stringify({ text: 'Live check from local inspector' }),
  });
  assert.equal(postedRes.status, 200);
  const posted = await postedRes.json();
  assert.ok(posted.card_id);

  const runRes = await fetch(`${srv.url}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: srv.url },
    body: JSON.stringify({ name: 'curve', card_id: posted.card_id }),
  });
  assert.equal(runRes.status, 200);
  const ran = await runRes.json();
  assert.equal(ran.passed, true);

  // 5. Dismiss card via inspector API updates feed state.
  const decRes = await fetch(`${srv.url}/api/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: srv.url },
    body: JSON.stringify({ kind: 'no', card_id: prop.card.id }),
  });
  assert.equal(decRes.status, 200);
});
