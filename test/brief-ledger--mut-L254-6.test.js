'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildBriefReview, ledgerPath } = require('../lib/brief-ledger');

test('lessons report only the group with at least five briefs', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-lessons-threshold-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const majorityHasCriteria of [true, false]) {
    const records = Array.from({ length: 6 }, (_, index) => {
      const hasCriteria = index < 5 ? majorityHasCriteria : !majorityHasCriteria;
      return {
        brief_id: `brief-${index}`,
        ts: '2024-01-01T00:00:00.000Z',
        engine: 'fixture',
        prompt_text: hasCriteria ? 'only touch the fixture; verify: node --test' : 'update the fixture',
        outcome: {
          result: index < 3 ? 'pass' : 'fail',
          ts: '2024-01-01T00:01:00.000Z',
        },
      };
    });
    const file = ledgerPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');

    const label = majorityHasCriteria ? 'with' : 'without';
    assert.deepEqual(buildBriefReview(root, { lessons: true }).lessons, [
      `briefs ${label} a named verify command land 3 of 5.`,
      `briefs ${label} bounded slice language land 3 of 5.`,
      `briefs ${label} exit criteria land 3 of 5.`,
      'fixture briefs land 3 of 6.',
    ]);
  }
});
