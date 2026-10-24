'use strict';
require('./helpers/clean-temp');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderVitalsHtml } = require('../lib/improve-vitals-html');

test('a dissolved loop is labeled let go', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vitals-dissolved-'));
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
      kind: 'opened', id: 'retired-loop', what: 'retire the unused experiment',
      owner: 'operator', lane: 'code', opened_at: '2026-01-15T10:00:00.000Z',
      at: '2026-01-15T10:00:00.000Z', ttl_days: 7,
      close_condition: 'the experiment is finished',
    },
    { kind: 'dissolved', id: 'retired-loop', at: '2026-01-15T11:00:00.000Z', why: 'no longer needed' },
  ];
  fs.writeFileSync(path.join(state, 'closure.jsonl'), events.map(JSON.stringify).join('\n') + '\n');
  const html = renderVitalsHtml(root, {
    now: '2026-01-15T12:00:00.000Z',
    collectImproveVitals: () => ({}),
  });
  const row = html.match(/<li class="done">([\s\S]*?)retire the unused experiment<\/li>/);
  assert.equal(row?.[1].match(/<span class="lane">([^<]*)<\/span>/)?.[1], 'let go');
});
