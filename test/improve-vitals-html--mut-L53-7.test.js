'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderVitalsHtml } = require('../lib/improve-vitals-html');

test('renders loops dissolved today under closed or shipped today section', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vitals-mut-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const closureDir = path.join(root, '.atris', 'state');
  fs.mkdirSync(closureDir, { recursive: true });

  const now = '2026-03-15T12:00:00.000Z';
  const events = [
    { kind: 'opened', id: 'loop-dissolved-1', what: 'sunset legacy feature', at: now },
    { kind: 'dissolved', id: 'loop-dissolved-1', at: now, why: 'no longer needed' },
  ];
  fs.writeFileSync(
    path.join(closureDir, 'closure.jsonl'),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  );

  const html = renderVitalsHtml(root, {
    now,
    collectImproveVitals: () => ({}),
  });

  assert.ok(
    html.includes('<li class="done"><span class="lane">let go</span>sunset legacy feature</li>'),
    'expected dissolved loop to appear as "let go" under closed or shipped today'
  );
  assert.ok(
    !html.includes('nothing yet today.'),
    'expected "nothing yet today." to not be displayed when loops were dissolved today'
  );
});
