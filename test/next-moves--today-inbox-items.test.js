'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { todayInboxItems } = require('../lib/next-moves');

// todayInboxItems takes no date: it reads today's journal. Freeze the clock at
// local noon on a fixed day so the file name is the same in every time zone.
const RealDate = Date;
const TODAY = '2031-06-15';
const YESTERDAY = '2031-06-14';

function withFrozenDate(fn) {
  const frozen = new RealDate(2031, 5, 15, 12, 0, 0).getTime();
  global.Date = class extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(frozen);
      else super(...args);
    }
    static now() { return frozen; }
  };
  try { return fn(); } finally { global.Date = RealDate; }
}

const roots = [];
function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-today-inbox-'));
  roots.push(root);
  return root;
}
test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function writeJournal(root, date, text) {
  const file = path.join(root, 'atris', 'logs', date.slice(0, 4), `${date}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

function titlesToday(root) {
  return withFrozenDate(() => todayInboxItems(root)).map((i) => i.title);
}

test('returns inbox items from today\'s journal with title, why, source, and weight', () => {
  const root = tmpRoot();
  writeJournal(root, TODAY, [
    `# Log ${TODAY}`,
    '',
    '## Notes',
    '',
    '- not an inbox line',
    '',
    '## Inbox',
    '',
    '- **I1:** Ship the onboarding fix',
    '- **I2:** Write the release note',
    '',
  ].join('\n'));

  const items = withFrozenDate(() => todayInboxItems(root));
  assert.deepStrictEqual(items, [
    { title: 'Ship the onboarding fix', why: 'fresh idea in today\'s inbox', source: 'inbox', weight: 40 },
    { title: 'Write the release note', why: 'fresh idea in today\'s inbox', source: 'inbox', weight: 40 },
  ]);
});

test('returns an empty list when today has no journal file or the logs folder is missing', () => {
  const missingLogs = tmpRoot();
  assert.deepStrictEqual(withFrozenDate(() => todayInboxItems(missingLogs)), []);

  const onlyOtherDay = tmpRoot();
  writeJournal(onlyOtherDay, '2031-06-16', '## Inbox\n\n- **I1:** Tomorrow idea\n');
  assert.deepStrictEqual(withFrozenDate(() => todayInboxItems(onlyOtherDay)), []);
});

test('ignores a prior day\'s inbox and reads only today\'s file', () => {
  const root = tmpRoot();
  writeJournal(root, YESTERDAY, '## Inbox\n\n- **I1:** Yesterday idea\n');
  writeJournal(root, TODAY, '## Inbox\n\n- **I1:** Today idea\n');

  assert.deepStrictEqual(titlesToday(root), ['Today idea']);
});

test('returns an empty list for an empty journal, a journal with no Inbox section, and an empty Inbox', () => {
  const emptyFile = tmpRoot();
  writeJournal(emptyFile, TODAY, '');
  assert.deepStrictEqual(titlesToday(emptyFile), []);

  const noInbox = tmpRoot();
  writeJournal(noInbox, TODAY, `# Log ${TODAY}\n\n## Notes\n\n- **I1:** lives in Notes, not Inbox\n`);
  assert.deepStrictEqual(titlesToday(noInbox), []);

  const emptyInbox = tmpRoot();
  writeJournal(emptyInbox, TODAY, `# Log ${TODAY}\n\n## Inbox\n\nplain text, no bullets\n-\n`);
  assert.deepStrictEqual(titlesToday(emptyInbox), []);
});

test('stops at the next top-level section but keeps items under a ### child heading', () => {
  const root = tmpRoot();
  writeJournal(root, TODAY, [
    '## Inbox',
    '',
    '- **I1:** First idea',
    '',
    '### Later',
    '',
    '- **I2:** Child section idea',
    '',
    '## Backlog',
    '',
    '- **I3:** Backlog item, not inbox',
    '',
  ].join('\n'));

  assert.deepStrictEqual(titlesToday(root), ['First idea', 'Child section idea']);
});

test('strips id and bold markers from titles and accepts CRLF line endings', () => {
  const root = tmpRoot();
  writeJournal(root, TODAY, [
    '## Inbox (fresh)',
    '- **I4:** Id prefixed idea',
    '- **C2:** Command prefixed idea',
    '- **Bold whole line**',
    '- Plain bullet idea',
    '',
  ].join('\r\n'));

  assert.deepStrictEqual(titlesToday(root), [
    'Id prefixed idea',
    'Command prefixed idea',
    'Bold whole line',
    'Plain bullet idea',
  ]);
});

test('drops placeholder titles and status-style lines, and unwraps a Title: prefix', () => {
  const root = tmpRoot();
  writeJournal(root, TODAY, [
    '## Inbox',
    '',
    '- **I1:** tick',
    '- **I2:** TODO',
    '- **I3:** Title: Placeholder idea',
    '- **I4:** Task: do something',
    '- **I5:** Status: waiting',
    '- **I6:** Title: Fix the login redirect',
    '- **I7:** Real idea',
    '',
  ].join('\n'));

  assert.deepStrictEqual(titlesToday(root), ['Fix the login redirect', 'Real idea']);
});
