'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderVitalsHtml } = require('../lib/improve-vitals-html');

test('exactly fourteen system loops render without a zero-more paragraph', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vitals-fourteen-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = path.join(root, '.atris', 'state');
  fs.mkdirSync(state, { recursive: true });
  const events = Array.from({ length: 14 }, (_, i) => ({
    kind: 'opened',
    id: `boundary-loop-${i}`,
    what: `system loop ${i + 1}`,
    owner: 'vitals-boundary-system-agent',
    lane: 'code',
    opened_at: '2026-01-01T12:00:00.000Z',
    ttl_days: 7,
  }));
  fs.writeFileSync(path.join(state, 'closure.jsonl'),
    events.map((event) => JSON.stringify(event)).join('\n') + '\n');

  const html = renderVitalsHtml(root, {
    now: '2026-01-15T12:00:00.000Z',
    collectImproveVitals: () => ({}),
  });
  const section = html.match(/  <section>\n    <h2>the system is carrying<\/h2>[\s\S]*?  <\/section>/);
  assert.ok(section, 'the system section must be present');
  const items = events.map((event) =>
    `<li class="late"><span class="lane">code</span>${event.what}<span class="when">7 days late</span></li>`);
  assert.equal(section[0],
    '  <section>\n    <h2>the system is carrying</h2>\n    <ul>\n    '
    + items.join('\n    ') + '\n    </ul>\n    \n  </section>');
});
