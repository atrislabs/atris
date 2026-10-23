'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderVitalsHtml } = require('../lib/improve-vitals-html');

test('renders loops closed during the day', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vitals-closed-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const ledger = path.join(root, '.atris', 'state', 'closure.jsonl');
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  fs.writeFileSync(
    ledger,
    JSON.stringify({
      kind: 'opened',
      at: '2026-06-15T12:00:00.000Z',
      id: 'close-test-1',
      what: 'Ship new feature',
      owner: 'you',
      lane: 'business',
      opened_at: '2026-06-15T12:00:00.000Z',
      ttl_days: 7,
      close_condition: 'done',
      source: 'manual',
    }) + '\n' +
    JSON.stringify({
      kind: 'closed',
      at: '2026-06-15T12:00:00.000Z',
      id: 'close-test-1',
      proof: '',
    }) + '\n',
    'utf8'
  );

  const html = renderVitalsHtml(root, {
    now: '2026-06-15T12:00:00.000Z',
    collectImproveVitals: () => ({}),
  });

  assert.ok(html.includes('<span class="lane">closed</span>Ship new feature'));
});
