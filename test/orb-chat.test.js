'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveInput, turnBody, parseSseLines, runOrbChat } = require('../commands/orb-chat');

function state() {
  return {
    messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Today is outbound.' }],
    choiceHistory: [{ shown: ['Draft Brandon', 'Build anyway'], picked: null }],
    options: [
      { label: 'Draft Brandon', message: 'Draft the Brandon follow-up now.' },
      { label: 'Build anyway', message: 'I want to build the feature anyway.' },
    ],
  };
}

test('a number picks that choice, sends its message and records the pick', () => {
  const s = state();
  assert.deepStrictEqual(resolveInput(s, '2'), { message: 'I want to build the feature anyway.', echo: 'Build anyway' });
  assert.strictEqual(s.choiceHistory[0].picked, 'Build anyway');
});

test('words or an out of range number are sent as typed', () => {
  const s = state();
  assert.deepStrictEqual(resolveInput(s, ' send it '), { message: 'send it', echo: '' });
  assert.deepStrictEqual(resolveInput(s, '7'), { message: '7', echo: '' });
  assert.strictEqual(s.choiceHistory[0].picked, null);
});

test('a turn is the web orb turn with the thread and the choices seen', () => {
  const body = turnBody(state(), 'hello');
  assert.strictEqual(body.surface, 'dashboard_orb');
  assert.strictEqual(body.model, 'atris:fast');
  assert.strictEqual(body.previous_messages.length, 2);
  assert.strictEqual(body.choice_history.length, 1);
  assert.strictEqual(body.orb_opener, undefined);
});

test('the opener starts clean and asks for the orb opener', () => {
  const body = turnBody(state(), 'Open my day.', { opener: true });
  assert.strictEqual(body.orb_opener, true);
  assert.strictEqual(body.turn_kind, 'orb_open');
  assert.deepStrictEqual(body.previous_messages, []);
});

test('stream lines are parsed whole and a partial line waits for the rest', () => {
  const events = [];
  const rest = parseSseLines('data: {"type":"text_delta","content":"Hi"}\ndata: [DONE]\ndata: {"type":"opt', (e) => events.push(e));
  assert.deepStrictEqual(events, [{ type: 'text_delta', content: 'Hi' }]);
  assert.strictEqual(rest, 'data: {"type":"opt');
});

test('say streams the words, prints numbered choices and saves the thread', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-chat-'));
  const prevHome = process.env.ATRIS_TEST_STATE_DIR;
  const prevToken = process.env.ATRIS_TOKEN;
  const prevFetch = globalThis.fetch;
  process.env.ATRIS_TEST_STATE_DIR = home;
  process.env.ATRIS_TOKEN = 'test-token';
  const sse = [
    'data: {"type":"text_delta","content":"Send Brandon first."}',
    'data: {"type":"options","options":[{"label":"Draft Brandon","message":"Draft it."},{"label":"Build anyway"}]}',
    '',
  ].join('\n');
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = { url, body: JSON.parse(init.body), auth: init.headers.Authorization };
    return { ok: true, body: [Buffer.from(sse)] };
  };
  let printed = '';
  try {
    const code = await runOrbChat(['say', 'I', 'want', 'to', 'build'], { out: { write: (s) => { printed += s; } } });
    assert.strictEqual(code, 0);
    assert.match(sent.url, /\/atris2\/turn$/);
    assert.strictEqual(sent.body.message, 'I want to build');
    assert.strictEqual(sent.auth, 'Bearer test-token');
    assert.match(printed, /Send Brandon first\./);
    assert.match(printed, /1.*Draft Brandon/);
    assert.match(printed, /2.*Build anyway/);
    const saved = JSON.parse(fs.readFileSync(path.join(home, '.atris', 'orb-chat.json'), 'utf8'));
    assert.strictEqual(saved.options[1].message, 'Build anyway');
    assert.strictEqual(saved.messages.length, 2);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevHome === undefined) delete process.env.ATRIS_TEST_STATE_DIR; else process.env.ATRIS_TEST_STATE_DIR = prevHome;
    if (prevToken === undefined) delete process.env.ATRIS_TOKEN; else process.env.ATRIS_TOKEN = prevToken;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
