'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderBriefReview } = require('../lib/brief-ledger');

function makeItem(overrides = {}) {
  return {
    brief_id: 'brief-test-1',
    ts: '2026-01-02T03:00:00.000Z',
    engine: 'codex',
    prompt_text: 'fix the thing',
    signals: {
      engine: 'codex',
      prompt_words: 3,
      has_named_verify: true,
      had_exit_criteria: true,
      time_to_land_ms: 5 * 60 * 1000,
    },
    ...overrides,
  };
}

test('renderBriefReview renders counts and item rows for a populated review', () => {
  const review = {
    schema: 'atris.brief.review.v1',
    count: 3,
    groups: {
      pass: [makeItem({ brief_id: 'b1', task_id: 'T-9' })],
      partial: [],
      fail: [
        makeItem({
          brief_id: 'b2',
          engine: 'claude',
          prompt_text: 'investigate flaky gate',
          signals: {
            engine: 'claude',
            prompt_words: 3,
            has_named_verify: false,
            had_exit_criteria: true,
            time_to_land_ms: null,
          },
        }),
      ],
      open: [
        makeItem({
          brief_id: 'b3',
          engine: '',
          task_id: '',
          mission_id: '',
          prompt_text: 'open work item',
          signals: {
            engine: '',
            prompt_words: 0,
            has_named_verify: false,
            had_exit_criteria: false,
            time_to_land_ms: null,
          },
        }),
      ],
    },
  };

  const out = renderBriefReview(review);
  const lines = out.split('\n');

  assert.equal(lines[0], 'brief review: 3 recent briefs | pass 1, partial 0, fail 1, open 1');
  assert.ok(lines.includes('pass: recorded'));
  assert.ok(lines.includes('partial: none'));
  assert.ok(lines.includes('fail: recorded'));
  assert.ok(lines.includes('open: recorded'));

  const passRow = lines.find((line) => line.startsWith('- codex'));
  assert.equal(passRow, '- codex | 3 words | verify yes | exit yes | land 5m | task T-9');

  const failRow = lines.find((line) => line.startsWith('- claude'));
  assert.equal(failRow, '- claude | 3 words | verify no | exit yes | land not landed | investigate flaky gate');

  const openRow = lines.find((line) => line.startsWith('- unknown'));
  assert.equal(openRow, '- unknown | 0 words | verify no | exit no | land not landed | open work item');

  assert.ok(!out.includes('lessons:'));
});

test('renderBriefReview renders an empty review without throwing', () => {
  const out = renderBriefReview();
  const lines = out.split('\n');

  assert.equal(lines[0], 'brief review: 0 recent briefs | pass 0, partial 0, fail 0, open 0');
  for (const key of ['pass', 'partial', 'fail', 'open']) {
    assert.ok(lines.includes(`${key}: none`), `expected "${key}: none" in output`);
  }
  assert.equal(lines.filter((line) => line.startsWith('- ')).length, 0);
});

test('renderBriefReview caps each group at five rows and truncates long titles', () => {
  const items = Array.from({ length: 7 }, (_, i) =>
    makeItem({ brief_id: `b${i}`, task_id: `T-${i}` })
  );
  items[0] = makeItem({ brief_id: 'b-long', task_id: `T-${'x'.repeat(100)}` });

  const review = { count: 7, groups: { pass: items } };
  const lines = renderBriefReview(review).split('\n');

  const rows = lines.filter((line) => line.startsWith('- '));
  assert.equal(rows.length, 5);
  assert.ok(rows[0].endsWith('...'));
  assert.equal(rows[0].split(' | ').pop().length, 72);
});

test('renderBriefReview renders lessons when asked and falls back when empty', () => {
  const withLessons = {
    count: 1,
    groups: { pass: [makeItem()] },
    lessons: ['briefs with a named verify command land 1 of 1.'],
  };
  const out = renderBriefReview(withLessons, { lessons: true });
  assert.ok(out.includes('lessons:'));
  assert.ok(out.includes('- briefs with a named verify command land 1 of 1.'));

  const empty = renderBriefReview({ count: 0, groups: {}, lessons: [] }, { lessons: true });
  assert.ok(empty.includes('lessons: not enough data yet'));

  const noFlag = renderBriefReview(withLessons);
  assert.ok(!noFlag.includes('lessons:'));
});
