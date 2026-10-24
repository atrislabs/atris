'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderVitalsHtml } = require('../lib/improve-vitals-html');

test('a loop closed on the supplied day appears among completed items', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vitals-date-string-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  const state = path.join(root, '.atris', 'state');
  fs.mkdirSync(state, { recursive: true });
  const events = [
    {
      kind: 'opened', id: 'sample-loop', what: 'finish sample',
      owner: 'operator', lane: 'code', ttl_days: 7,
      opened_at: '2026-01-14T10:00:00.000Z',
      at: '2026-01-14T10:00:00.000Z',
    },
    { kind: 'closed', id: 'sample-loop', at: '2026-01-15T11:00:00.000Z', proof: 'done' },
  ];
  fs.writeFileSync(path.join(state, 'closure.jsonl'), events.map(JSON.stringify).join('\n') + '\n');

  const html = renderVitalsHtml(root, {
    now: '2026-01-15T12:00:00.000Z',
    collectImproveVitals: () => ({}),
  });
  assert.match(html, /<li class="done">[^\n]*finish sample/);
});
