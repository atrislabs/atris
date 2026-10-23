'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseInboxItems,
  getNextInboxId,
  addInboxItemToContent,
  replaceInboxSection,
} = require('../lib/file-ops');

const LF = '# Log\n\n## Inbox\n\n- **I1:** first idea\n\n---\n\n## Completed\n';

test('parseInboxItems reads items and getNextInboxId continues the sequence (LF)', () => {
  assert.equal(parseInboxItems(LF).length, 1);
  assert.equal(parseInboxItems(LF)[0].id, 1);
  assert.equal(getNextInboxId(LF), 2);
});

test('addInboxItemToContent prepends the new item and keeps one Inbox section (LF)', () => {
  const out = addInboxItemToContent(LF, getNextInboxId(LF), 'second idea');
  assert.equal((out.match(/## Inbox/g) || []).length, 1, 'exactly one Inbox section');
  const items = parseInboxItems(out);
  assert.equal(items.length, 2);
  assert.equal(items[0].id, 2, 'newest item is first');
  assert.match(items[0].text, /second idea/);
});

// --- CRLF regression: Windows-edited / round-tripped journals ---

test('parseInboxItems handles CRLF line endings', () => {
  const crlf = LF.replace(/\n/g, '\r\n');
  assert.equal(parseInboxItems(crlf).length, 1, 'CRLF inbox must parse like LF');
  assert.equal(getNextInboxId(crlf), 2, 'IDs must not reset to 1 on CRLF');
});

test('addInboxItemToContent does not duplicate the Inbox section on CRLF', () => {
  const crlf = LF.replace(/\n/g, '\r\n');
  const out = addInboxItemToContent(crlf, getNextInboxId(crlf), 'second idea');
  assert.equal((out.match(/## Inbox/g) || []).length, 1, 'must not append a second Inbox section');
  assert.equal(parseInboxItems(out).length, 2, 'both items preserved');
});

test('replaceInboxSection appends a fresh section when none exists', () => {
  const out = replaceInboxSection('# Log\n\nNo inbox here.\n', [{ id: 1, text: 'x', line: '- **I1:** x' }]);
  assert.equal((out.match(/## Inbox/g) || []).length, 1);
  assert.equal(parseInboxItems(out).length, 1);
});

test('replaceInboxSection renders inbox-zero when empty', () => {
  const out = replaceInboxSection(LF, []);
  assert.match(out, /\(Empty - inbox zero achieved\)/);
  assert.equal(parseInboxItems(out).length, 0);
});

test('getLogPath reads a YYYY-MM-DD date as that local day, even west of Greenwich', () => {
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const script = `const { getLogPath } = require(${JSON.stringify(path.resolve(__dirname, '..', 'lib', 'file-ops'))});`
    + "const r = getLogPath('2026-01-01'); process.stdout.write(r.dateFormatted + ' ' + path.basename(r.yearDir));";
  for (const tz of ['America/Los_Angeles', 'UTC', 'Asia/Tokyo']) {
    const res = spawnSync(process.execPath, ['-e', `const path = require('path'); ${script}`], {
      encoding: 'utf8',
      env: { ...process.env, TZ: tz },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, '2026-01-01 2026', `wrong journal day in ${tz}`);
  }
});
