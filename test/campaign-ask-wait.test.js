'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { campaignCommand } = require('../commands/campaign');
const { createMemoryStore, getCampaign } = require('../lib/campaign-store');
const { fold, decide } = require('../lib/campaign-core');

const ID = 'cmp-ask-wait';
const OPENED = '2026-10-01T00:00:00.000Z';
const LATER = '2026-10-01T00:00:02.000Z';

function fixture(defaultAnswer) {
  const store = createMemoryStore({ origin: 'ask-wait-test', now: () => OPENED });
  store.append({ campaign_id: ID, type: 'campaign_started', actor: 'human:tester',
    data: { title: 'Ask wait', judge: 'exit 1', budget: 10 } });
  store.append({ campaign_id: ID, type: 'ask_opened', actor: 'builder',
    data: { ask_id: 'a-wait', question: 'Send the note?', after_ms: 1000,
      ...(defaultAnswer === undefined ? {} : { default: defaultAnswer }) } });
  return store;
}

// Exercise the real command handler and store. Explicit identity avoids the
// calling agent shell deciding whether this invocation represents a person.
async function command(store, args) {
  const output = [];
  const saved = { log: console.log, error: console.error };
  console.log = console.error = (line) => output.push(String(line));
  try {
    const code = await campaignCommand(args, { store, actor: 'human:tester' });
    return { code, out: output.join('\n') };
  } finally {
    console.log = saved.log;
    console.error = saved.error;
  }
}

test('an explicit agent cannot write a default event by hand', async () => {
  const store = fixture('no');
  const before = store.read(ID);
  const result = await command(store, ['event', ID, 'ask_defaulted', '--data',
    JSON.stringify({ ask_id: 'a-wait', answer: 'no' }), '--as', 'builder', '--json']);
  assert.notEqual(result.code, 0, result.out);
  assert.equal(JSON.parse(result.out).ok, false);
  assert.deepEqual(store.read(ID), before, 'refusal must not append a default event');
  assert.equal(getCampaign(store, ID).asks[0].id, 'a-wait');
});

test('an explicit agent cannot silently close an ask through answer or a forged person', async () => {
  const store = fixture('no');
  const answered = await command(store, ['answer', ID, 'a-wait', 'yes', '--as', 'builder']);
  assert.match(answered.out, /not closed|only a person/);
  assert.equal(getCampaign(store, ID).asks[0].id, 'a-wait');
  const before = store.read(ID);
  for (const args of [
    ['answer', ID, 'a-wait', 'yes', '--as', 'human:tester'],
    ['event', ID, 'ask_answered', '--data', '{"ask_id":"a-wait","answer":"yes"}', '--as', 'builder'],
  ]) {
    const refused = await command(store, args);
    assert.notEqual(refused.code, 0, refused.out);
    assert.deepEqual(store.read(ID), before);
  }
});

test('a parked ask remains visible in campaign show text and JSON', async () => {
  const store = fixture();
  const parked = fold(store.read(ID), LATER);
  assert.equal(parked.asks[0].parked, true);
  assert.notEqual(decide(parked, LATER).action, 'wait');
  const text = await command(store, ['show', ID]);
  assert.equal(text.code, 0, text.out);
  assert.match(text.out, /a-wait: Send the note\?/);
  const json = await command(store, ['show', ID, '--json']);
  assert.equal(json.code, 0, json.out);
  const shown = JSON.parse(json.out).campaign.asks.find((ask) => ask.id === 'a-wait');
  assert.ok(shown, 'show JSON must keep the unanswered ask');
  assert.equal(shown.parked, true, 'show must recognize a deadline in the past');
});

test('a person may answer after the default without becoming an unknown ask', async () => {
  const store = fixture('no');
  store.append({ campaign_id: ID, type: 'ask_defaulted', actor: 'system', at: LATER,
    data: { ask_id: 'a-wait', answer: 'no' } });
  const result = await command(store, ['answer', ID, 'a-wait', 'yes, send it', '--json']);
  assert.equal(result.code, 0, result.out);
  const events = store.read(ID);
  const answer = events.findLast((event) => event.type === 'ask_answered');
  assert.equal(answer.actor, 'human:tester');
  assert.equal(answer.data.answer, 'yes, send it');
  const view = JSON.parse(result.out).campaign;
  assert.ok(!view.warnings.some((warning) => warning.code === 'unknown_ask'),
    'the late human answer must replace the default, not be discarded');
});

// Requirement four is truncated after "a fresh as" in the mission brief.
// Do not invent its acceptance condition or silently mark it covered.
