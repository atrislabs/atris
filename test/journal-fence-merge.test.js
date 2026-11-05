'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('journal pull preserves headings inside fenced code as section content', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-journal-fences-'));
  const before = process.cwd();
  t.after(() => { process.chdir(before); fs.rmSync(root, { recursive: true, force: true }); });
  process.chdir(root);
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const file = path.join(root, 'atris', 'logs', date.slice(0, 4), `${date}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const local = '# Today\n\n## Notes\n```markdown\n## Backlog\ncode example\n```\n';
  fs.writeFileSync(file, local);
  const api = require('../utils/api');
  t.mock.method(api, 'apiRequestJson', async p => p.endsWith(date)
    ? { ok: true, data: { content: '# Today\n\n## Inbox\nremote item\n' } }
    : { ok: false });
  delete require.cache[require.resolve('../commands/pull')];
  await require('../commands/pull').pullGeneralJournal('synthetic-token', 'synthetic-agent');
  const result = fs.readFileSync(file, 'utf8');
  assert.ok(result.includes('## Notes\n```markdown\n## Backlog\ncode example\n```\n'));
  assert.ok(result.includes('## Inbox\nremote item'));
});

test('strict section parser honors matching fence marker, length and trailing text', () => {
  const { parseJournalSections, UnclosedJournalFenceError, DuplicateJournalSectionError } = require('../lib/journal');
  for (const block of [
    '```md\n## Backlog\n```\n',
    '~~~txt\n## Backlog\n~~~\n',
    '  ````markdown\n```\n## Backlog\n````\n',
    '~~~\n```\n## Backlog\n~~~\n',
  ]) {
    const sections = parseJournalSections(`## Notes\n${block}## Inbox\nitem\n`, { rejectDuplicates: true });
    assert.equal(Object.hasOwn(sections, 'Backlog'), false);
    assert.ok(sections.Notes.includes(block));
    assert.ok(sections.Inbox.includes('item'));
  }
  assert.throws(() => parseJournalSections('## Notes\n```\n## Inbox\n', { rejectDuplicates: true }), UnclosedJournalFenceError);
  assert.throws(() => parseJournalSections('## Notes\n```\n## Notes\n```\n## Notes\n', { rejectDuplicates: true }), DuplicateJournalSectionError);
});

test('journal pull refuses an unclosed fence without changing the journal', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-journal-unclosed-'));
  const before = process.cwd();
  t.after(() => { process.chdir(before); fs.rmSync(root, { recursive: true, force: true }); });
  process.chdir(root);
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const file = path.join(root, 'atris', 'logs', date.slice(0, 4), `${date}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const local = '# Today\n\n## Notes\n```\nunfinished\n';
  fs.writeFileSync(file, local);
  const api = require('../utils/api');
  const output = [];
  t.mock.method(console, 'log', (...args) => output.push(args.join(' ')));
  t.mock.method(api, 'apiRequestJson', async p => p.endsWith(date)
    ? { ok: true, data: { content: '# Today\n\n## Inbox\nremote item\n' } }
    : { ok: false });
  delete require.cache[require.resolve('../commands/pull')];
  await require('../commands/pull').pullGeneralJournal('synthetic-token', 'synthetic-agent');
  assert.equal(fs.readFileSync(file, 'utf8'), local);
  assert.ok(output.some(line => line.includes('unclosed code fence')));
});

test('log sync rejects an unclosed remote fence without prompting or writing', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-log-fence-'));
  const before = process.cwd();
  const beforeArgv = process.argv;
  t.after(() => { process.chdir(before); process.argv = beforeArgv; fs.rmSync(root, { recursive: true, force: true }); });
  process.chdir(root);
  const date = '2020-01-15';
  process.argv = ['node', 'atris', 'log', 'sync', `--date=${date}`];
  const file = path.join(root, 'atris', 'logs', '2020', `${date}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const local = '# Today\n\n## Inbox\nlocal item\n';
  fs.writeFileSync(file, local);
  fs.utimesSync(file, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
  const api = require('../utils/api');
  const config = require('../utils/config');
  const auth = require('../utils/auth');
  let writes = 0;
  t.mock.method(config, 'loadConfig', () => ({ agent_id: 'synthetic-agent' }));
  t.mock.method(config, 'loadLogSyncState', () => ({}));
  t.mock.method(config, 'saveLogSyncState', () => { writes++; });
  t.mock.method(auth, 'ensureValidCredentials', async () => ({ credentials: { token: 'synthetic-token' } }));
  t.mock.method(api, 'apiRequestJson', async (_p, options) => {
    if (options.method !== 'GET') { writes++; return { ok: true }; }
    return { ok: true, data: { updated_at: '2020-01-16T00:00:00Z', content: '# Today\n\n## Notes\n~~~\nunfinished\n' } };
  });
  delete require.cache[require.resolve('../commands/log-sync')];
  await assert.rejects(require('../commands/log-sync').logSyncAtris(), /unclosed code fence/);
  assert.equal(fs.readFileSync(file, 'utf8'), local);
  assert.equal(writes, 0);
});
