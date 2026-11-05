'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('journal pull refuses to merge repeated local sections and preserves the file', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-journal-duplicates-'));
  const oldCwd = process.cwd();
  t.after(() => { process.chdir(oldCwd); fs.rmSync(root, { recursive: true, force: true }); });
  process.chdir(root);
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const log = path.join(root, 'atris', 'logs', date.slice(0, 4), `${date}.md`);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const original = '# Today\n\n## Notes\nfirst important note\n\n## Notes\nsecond important note\n';
  fs.writeFileSync(log, original);
  const api = require('../utils/api');
  const output = [];
  t.mock.method(console, 'log', (...args) => output.push(args.join(' ')));
  t.mock.method(api, 'apiRequestJson', async (p) => p.endsWith(date)
    ? { ok: true, data: { content: '# Today\n\n## Inbox\nnew remote item\n' } }
    : { ok: false });
  delete require.cache[require.resolve('../commands/pull')];
  const { pullGeneralJournal } = require('../commands/pull');
  await pullGeneralJournal('synthetic-token', 'synthetic-agent');
  assert.equal(fs.readFileSync(log, 'utf8'), original);
  assert.ok(output.some((line) => line.includes('kept local for review')));
  assert.ok(!output.some((line) => line.includes('up to date')));
});

test('merge parser refuses duplicate and reserved headings without changing ordinary parsing', () => {
  const { parseJournalSections, DuplicateJournalSectionError } = require('../lib/journal');
  for (const content of [
    '## Notes\nfirst\n## Notes\nsecond\n',
    '## __proto__\nimportant\n',
    '## constructor\nimportant\n',
    '## __header__\nimportant\n',
  ]) {
    assert.throws(() => parseJournalSections(content, { rejectDuplicates: true }), DuplicateJournalSectionError);
  }
  assert.equal(parseJournalSections('## Notes\nfirst\n## Notes\nsecond\n').Notes, '## Notes\nsecond\n');
});

test('log sync refuses repeated remote sections without writing either copy', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-log-duplicates-'));
  const oldCwd = process.cwd();
  const oldArgv = process.argv;
  t.after(() => { process.chdir(oldCwd); process.argv = oldArgv; fs.rmSync(root, { recursive: true, force: true }); });
  process.chdir(root);
  const date = '2020-01-15';
  process.argv = ['node', 'atris', 'log', 'sync', `--date=${date}`];
  const log = path.join(root, 'atris', 'logs', '2020', `${date}.md`);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const original = '# Today\n\n## Inbox\nlocal item\n';
  fs.writeFileSync(log, original);
  fs.utimesSync(log, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
  const api = require('../utils/api');
  const config = require('../utils/config');
  const auth = require('../utils/auth');
  let writes = 0;
  t.mock.method(config, 'loadConfig', () => ({ agent_id: 'synthetic-agent' }));
  t.mock.method(config, 'loadLogSyncState', () => ({}));
  t.mock.method(config, 'saveLogSyncState', () => { writes++; });
  t.mock.method(auth, 'ensureValidCredentials', async () => ({ credentials: { token: 'synthetic-token' } }));
  t.mock.method(api, 'apiRequestJson', async (_p, opts) => {
    if (opts.method !== 'GET') { writes++; return { ok: true }; }
    return { ok: true, data: { updated_at: '2020-01-16T00:00:00Z', content: '# Today\n\n## Notes\nfirst remote\n\n## Notes\nsecond remote\n' } };
  });
  delete require.cache[require.resolve('../commands/log-sync')];
  const { logSyncAtris } = require('../commands/log-sync');
  await assert.rejects(logSyncAtris(), /repeated section/);
  assert.equal(fs.readFileSync(log, 'utf8'), original);
  assert.equal(writes, 0);
});
