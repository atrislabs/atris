'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { memberLineup } = require('../lib/team-lineup');

test('memberLineup matches a trimmed name without case sensitivity and returns roster fields', () => {
  const member = Object.freeze({
    member: 'Builder', job: 'build', engine: 'codex', model: 'example-model',
    effort: 'high', source: 'file', file: 'atris/ROSTER.md', extra: 'private',
  });
  const lineup = Object.freeze({ ok: true, team: Object.freeze([
    Object.freeze({ member: 'Reviewer', job: 'review' }), member,
  ]) });

  const result = memberLineup(lineup, '  bUiLdEr  ');
  assert.deepStrictEqual(result, {
    job: 'build', engine: 'codex', model: 'example-model', effort: 'high',
    source: 'roster', file: 'atris/ROSTER.md',
  });
  assert.notStrictEqual(result, member);
});

test('memberLineup supplies null defaults and labels non-file sources automatic', () => {
  for (const source of [undefined, 'automatic', 'inferred']) {
    assert.deepStrictEqual(memberLineup({
      ok: true, team: [{ member: 'Scout', job: '', engine: null, source }],
    }, 'scout'), {
      job: null, engine: null, model: null, effort: null,
      source: 'automatic', file: null,
    });
  }
});

test('memberLineup returns null for unknown names and empty teams', () => {
  const lineup = { ok: true, team: [{ member: 'Builder', job: 'build' }] };
  for (const name of ['unknown', 'build', '', '   ', null, undefined]) {
    assert.strictEqual(memberLineup(lineup, name), null);
  }
  assert.strictEqual(memberLineup({ ok: true, team: [] }, 'Builder'), null);
  assert.strictEqual(memberLineup({ ok: true }, 'Builder'), null);
});

test('memberLineup returns null when the lineup is absent or unreadable', () => {
  for (const lineup of [undefined, null, {}, {
    ok: false, error: 'roster unavailable', team: [{ member: 'Builder' }],
  }]) {
    assert.strictEqual(memberLineup(lineup, 'Builder'), null);
  }
});
