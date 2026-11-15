'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { memoryLiveCommand, plainError } = require('../commands/memory-live');
const { memoryCommand } = require('../commands/memory');
const live = require('../lib/memory-live');

const CLI = path.join(__dirname, '..', 'bin', 'atris.js');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-memory-live-'));
}

const NOTES = {
  about: '# About me\n\nKeshav. Builds Atris. Likes short answers.\n',
  now: '# Now\n\n- Ship memory for every agent (2026-11-09)\n',
  learning: '# Learning\n\n## Want to learn\n\n## I understand\n\n## Shaky, come back to\n',
  journal: `# Journal\n\n${Array.from({ length: 20 }, (_, i) => `- said thing ${i + 1} (claude, 2026-11-09)`).join('\n')}\n`,
  board: '# Board\n',
};

// A stand-in for the Atris server's memory routes, answered the way the real ones answer.
function fakeServer({ notes = NOTES, files = {}, fail = {} } = {}) {
  const store = new Map(Object.entries(files));
  const calls = [];
  const ok = (data) => ({ ok: true, status: 200, data });
  const no = (status, error) => ({ ok: false, status, data: null, error });
  const request = async (pathname, options = {}) => {
    const url = new URL(pathname, 'https://x.test');
    const q = (name) => url.searchParams.get(name);
    const method = options.method || 'GET';
    calls.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: options.body, options });
    assert.equal(options.token, 'tok-1', 'every call carries the login token');
    const key = `${method} ${url.pathname}`;
    if (fail[key]) return fail[key];
    if (key === 'GET /me/memory') {
      const empty = !live.noteBody(notes.about) && !live.noteBody(notes.now) && !live.noteBody(notes.learning);
      return ok({ files: notes, empty, suggestions: [] });
    }
    if (key === 'POST /me/memory/remember') {
      const { text, file, source } = options.body;
      return ok({ file, added: `- ${text} (${source}, 2026-11-09)` });
    }
    if (key === 'GET /memory/grep') {
      const terms = q('q').split('|').map((t) => t.trim().toLowerCase());
      const hits = [];
      for (const [rel, text] of store) {
        if (q('folder') && !rel.startsWith(`${q('folder')}/`)) continue;
        text.split('\n').forEach((line, i) => {
          if (terms.some((t) => line.toLowerCase().includes(t))) hits.push({ path: rel, n: i + 1, text: line.trim() });
        });
      }
      return ok({ hits, files: store.size, truncated: false });
    }
    if (key === 'GET /memory/ask') {
      const ask = q('q');
      if (/nobody/.test(ask)) return ok({ question: ask, answer: 'Nothing about that.', found: false, sources: [], steps: 2 });
      if (/busy/.test(ask)) return ok({ question: ask, answer: null, found: false, sources: [], note: 'The reader is busy, so here is what a search found.', search: { hits: [{ path: 'wiki/lease.md', n: 2, text: 'landlord is Pat' }] } });
      return ok({ question: ask, answer: 'Pat is the landlord.', found: true, sources: [{ path: 'wiki/lease.md', n: 2, text: 'landlord is Pat', by: 'read' }], steps: 2 });
    }
    if (key === 'GET /memory/read') {
      if (!store.has(q('path'))) return no(400, `No file at ${q('path')}.`);
      const lines = store.get(q('path')).split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      const start = Number(q('start'));
      const count = Number(q('count'));
      return ok({
        path: q('path'),
        lines: lines.slice(start - 1, start - 1 + count).map((text, i) => ({ n: start + i, text })),
        total: lines.length,
        more: start - 1 + count < lines.length,
      });
    }
    if (key === 'GET /memory/file') {
      if (!store.has(q('path'))) return no(400, `No file at ${q('path')}.`);
      return ok({ path: q('path'), text: store.get(q('path')), bytes: Buffer.byteLength(store.get(q('path'))) });
    }
    if (key === 'GET /memory/ls') {
      const base = q('folder') ? `${q('folder')}/` : '';
      const seen = new Map();
      for (const [rel, text] of store) {
        if (!rel.startsWith(base)) continue;
        const [name, ...deeper] = rel.slice(base.length).split('/');
        if (deeper.length) {
          const item = seen.get(`${name}/`) || { name: `${name}/`, files: 0 };
          item.files += 1;
          seen.set(`${name}/`, item);
        } else seen.set(name, { name, size: Buffer.byteLength(text) });
      }
      return ok({ items: [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : 1)) });
    }
    if (key === 'PUT /memory/write') {
      const { path: rel, text } = options.body;
      if (!/^(wiki|files)\//.test(rel)) return no(400, 'Agents write under wiki/ or files/. Use remember for notes and the daily log.');
      store.set(rel, text);
      return ok({ path: rel, bytes: Buffer.byteLength(text) });
    }
    if (key === 'DELETE /memory/file') {
      if (!store.has(q('path'))) return no(404, `No file at ${q('path')}.`);
      store.delete(q('path'));
      return ok({ path: q('path'), deleted: true });
    }
    if (key === 'POST /memory/log') {
      const { agent, text } = options.body;
      return ok({ path: `team/${agent}/logs/2026-11-09.md`, line: `- 20:13 UTC ${text}`, new_notebook: false });
    }
    if (key === 'POST /memory/lesson') {
      const { agent, text, score_before: before, score_after: after } = options.body;
      const kept = after > before;
      return ok({
        kept,
        lesson: kept ? `- 2026-11-09: ${text} (score ${before} -> ${after})` : null,
        path: kept ? `team/${agent}/lessons.md` : `team/${agent}/logs/2026-11-09.md`,
        log: `- 20:13 UTC ${kept ? 'kept lesson' : 'tried and dropped lesson'}: ${text}`,
        new_notebook: false,
      });
    }
    if (key === 'GET /memory/usage') {
      return ok({ used_bytes: 1200, limit_bytes: 1000000000, plan: 'free', counted: 'files/', message: 'Your files use 1.2 KB of the 1 GB that comes free. Notes and memory never count toward it.' });
    }
    return no(404, 'Not Found');
  };
  return { store, calls, request };
}

function run(args, server, extra = {}) {
  const out = [];
  const errs = [];
  const raw = [];
  return memoryLiveCommand(args, {
    log: (line) => out.push(line),
    err: (line) => errs.push(line),
    out: (text) => raw.push(text),
    apiRequestJson: server && server.request,
    getAuth: async () => ({ token: 'tok-1', scoped: false }),
    env: {},
    apiBase: 'https://api.atris.ai/api',
    ...extra,
  }).then((code) => ({ code, text: out.join('\n'), errs: errs.join('\n'), raw: raw.join('') }));
}

const FILES = {
  'MAP.md': '# MAP\n\nRead this first.\n',
  'wiki/people/sam.md': '# Sam\nmet at the meetup\nworks on rent tools\n',
  'wiki/lease.md': '# Lease\nlandlord is Pat\n',
  'files/notes.txt': 'one\ntwo\n',
};

test('show reads every note in one request and prints one compact block for a model', async () => {
  const server = fakeServer();
  const r = await run(['show'], server);
  assert.equal(r.code, 0);
  assert.equal(server.calls.length, 1);
  assert.equal(server.calls[0].path, '/me/memory');
  assert.match(r.text, /^# Atris memory\n/);
  assert.match(r.text, /## About them, in their words \(about\.md\)\nKeshav\. Builds Atris\. Likes short answers\./);
  assert.match(r.text, /## What they are working on now \(now\.md\)\n- Ship memory for every agent/);
  assert.doesNotMatch(r.text, /Their learning|Their board/, 'notes with only headings are left out');
  assert.match(r.text, /## Recently they said, newest first\n- said thing 1 /);
  assert.match(r.text, /- said thing 15 /);
  assert.doesNotMatch(r.text, /said thing 16/, 'only the 15 newest journal lines');
  assert.match(r.text, /atris memory search "word\|other word"/);
  const learning = await run(['show'], fakeServer({ notes: { ...NOTES, learning: '# Learning\n\n## Want to learn\n- Rust\n' } }));
  assert.match(learning.text, /## Their learning \(wiki\/learning\.md\)\n### Want to learn\n- Rust/, 'a note\'s own headings sit one level down');

  const j = JSON.parse((await run(['show', '--json'], server)).text);
  assert.equal(j.ok, true);
  assert.equal(j.empty, false);
  assert.equal(j.files.about, NOTES.about);
  assert.equal(typeof j.text, 'string');
  assert.match(j.text, /About them/);
});

test('show on an empty memory says so and how to save the first line; long notes are cut with a pointer', async () => {
  const blank = { about: '# About me\n', now: '# Now\n', learning: NOTES.learning, journal: '# Journal\n', board: '# Board\n' };
  const empty = await run(['show'], fakeServer({ notes: blank }));
  assert.equal(empty.code, 0);
  assert.match(empty.text, /Nothing saved yet\./);
  assert.match(empty.text, /atris memory remember "one short line"/);

  const long = { ...blank, about: `# About me\n\n${'a long line about them\n'.repeat(300)}` };
  const cut = await run(['show'], fakeServer({ notes: long }));
  assert.match(cut.text, /\(more: atris memory read about\.md\)/);
  assert.ok(cut.text.length < 3200, 'one section stays near 2,400 characters');
});

test('search sends the words split by | and the folder, and prints path:line: text', async () => {
  const server = fakeServer({ files: FILES });
  const r = await run(['search', 'rent|landlord'], server);
  assert.equal(r.code, 0);
  assert.equal(server.calls[0].path, '/memory/grep');
  assert.equal(server.calls[0].query.q, 'rent|landlord');
  assert.match(r.text, /^wiki\/people\/sam\.md:3: works on rent tools$/m);
  assert.match(r.text, /^wiki\/lease\.md:2: landlord is Pat$/m);
  assert.match(r.text, /2 lines \(searched 4 files\)\. Read around one: atris memory read <path> --from <line>/);

  await run(['search', 'rent', 'Pat', '--in', 'wiki/people'], server);
  assert.equal(server.calls[1].query.q, 'rent|Pat', 'several words become one search');
  assert.equal(server.calls[1].query.folder, 'wiki/people');

  const none = await run(['search', 'zebra|okapi'], server);
  assert.equal(none.code, 0);
  assert.match(none.text, /No lines with "zebra" or "okapi" \(searched 4 files\)\./);

  const j = JSON.parse((await run(['search', 'landlord', '--json'], server)).text);
  assert.deepEqual(Object.keys(j).sort(), ['files', 'folder', 'hits', 'ok', 'query', 'truncated']);
  assert.deepEqual(j.hits, [{ path: 'wiki/lease.md', n: 2, text: 'landlord is Pat' }]);

  const missing = await run(['search'], server);
  assert.equal(missing.code, 2);
  assert.match(missing.errs, /say what to look for/);
});

test('ask sends the whole question once and prints the answer with the lines it rests on', async () => {
  const server = fakeServer({ files: FILES });
  const r = await run(['ask', 'who is', 'my landlord?', '--in', 'wiki'], server);
  assert.equal(r.code, 0);
  assert.equal(server.calls[0].path, '/memory/ask');
  assert.equal(server.calls[0].query.q, 'who is my landlord?');
  assert.equal(server.calls[0].query.folder, 'wiki');
  assert.equal(server.calls[0].options.retries, 0, 'a slow answer is not asked twice');
  assert.ok(server.calls[0].options.timeoutMs >= 80000, 'waits for the reader');
  assert.equal(r.text, 'Pat is the landlord.\n\nFrom:\n  wiki/lease.md:2: landlord is Pat');

  const none = await run(['ask', 'who is nobody?'], server);
  assert.match(none.text, /^Nothing about that\.\n\nNot found for certain\./);

  const busy = await run(['ask', 'busy now?'], server);
  assert.match(busy.text, /^The reader is busy.*\n\nLines that may hold it:\n  wiki\/lease\.md:2: landlord is Pat$/);

  const j = JSON.parse((await run(['ask', 'landlord?', '--json'], server)).text);
  assert.equal(j.found, true);
  assert.equal(j.sources[0].path, 'wiki/lease.md');

  assert.match((await run(['ask'], server)).errs, /ask a question/);
  assert.equal((await run(['ask', 'x'.repeat(501)], server)).code, 2);
});

test('read prints numbered lines a page at a time, --raw prints the file exactly', async () => {
  const long = `${Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n')}\n`;
  const server = fakeServer({ files: { ...FILES, 'wiki/long.md': long } });
  const r = await run(['read', 'wiki/people/sam.md'], server);
  assert.equal(r.code, 0);
  assert.equal(r.text, '  1  # Sam\n  2  met at the meetup\n  3  works on rent tools');
  assert.deepEqual(server.calls[0].query, { path: 'wiki/people/sam.md', start: '1', count: '120' });

  const page = await run(['read', 'wiki/long.md', '--from', '121', '--lines', '2'], server);
  assert.equal(page.text, '121  line 121\n122  line 122\n(lines 121-122 of 300. Next: atris memory read wiki/long.md --from 123)');

  const raw = await run(['read', 'wiki/people/sam.md', '--raw'], server);
  assert.equal(raw.raw, FILES['wiki/people/sam.md']);
  assert.equal(server.calls.at(-1).path, '/memory/file');

  const j = JSON.parse((await run(['read', 'wiki/lease.md', '--json'], server)).text);
  assert.equal(j.ok, true);
  assert.equal(j.total, 2);
  assert.deepEqual(j.lines[1], { n: 2, text: 'landlord is Pat' });

  for (const bad of [['read'], ['read', 'a.md', 'b.md'], ['read', 'a.md', '--from', '0'], ['read', 'a.md', '--lines', 'ten'], ['read', 'a.md', '--raw', '--from', '2']]) {
    assert.equal((await run(bad, server)).code, 2, bad.join(' '));
  }
});

test('ls lists files with sizes and folders with counts', async () => {
  const server = fakeServer({ files: FILES });
  const r = await run(['ls'], server);
  assert.equal(r.code, 0);
  assert.match(r.text, /^MAP\.md\s+24 B$/m);
  assert.match(r.text, /^wiki\/\s+2 files$/m);
  assert.match(r.text, /^files\/\s+1 file$/m);
  await run(['ls', 'wiki/'], server);
  assert.equal(server.calls[1].query.folder, 'wiki', 'a trailing slash is fine');
  const empty = await run(['ls', 'nothing'], server);
  assert.match(empty.text, /Nothing in nothing yet\./);
  const j = JSON.parse((await run(['ls', 'wiki', '--json'], server)).text);
  assert.deepEqual(j, { ok: true, folder: 'wiki', items: [{ name: 'lease.md', size: 24 }, { name: 'people/', files: 1 }] });
});

test('remember saves one line to the person\'s notes, tagged with the agent', async () => {
  const server = fakeServer();
  const r = await run(['remember', 'prefers', 'short answers'], server, { env: { ATRIS_AGENT: 'codex' } });
  assert.equal(r.code, 0);
  assert.equal(server.calls[0].method, 'POST');
  assert.equal(server.calls[0].path, '/me/memory/remember');
  assert.deepEqual(server.calls[0].body, { text: 'prefers short answers', file: 'journal', source: 'codex' });
  assert.equal(server.calls[0].options.retries, 0, 'a save is never sent twice');
  assert.equal(r.text, 'Saved to journal: prefers short answers (codex, 2026-11-09)');

  await run(['remember', 'Rust', '--to', 'learning', '--section', 'want'], server);
  assert.deepEqual(server.calls[1].body, { text: 'Rust', file: 'learning', source: 'terminal', section: 'want' });

  const j = JSON.parse((await run(['remember', 'moving to Austin', '--to', 'now', '--as', 'cursor', '--json'], server)).text);
  assert.deepEqual(j, { ok: true, file: 'now', added: '- moving to Austin (cursor, 2026-11-09)' });

  const dash = await run(['remember', '--', '- likes tea'], server);
  assert.equal(dash.code, 0);
  assert.equal(server.calls.at(-1).body.text, '- likes tea');

  for (const bad of [['remember'], ['remember', 'x', '--to', 'about'], ['remember', 'x', '--section', 'want'], ['remember', 'x', '--to', 'learning', '--section', 'maybe'], ['remember', 'x'.repeat(1001)], ['remember', '- likes tea']]) {
    const res = await run(bad, server);
    assert.equal(res.code, 2, bad.join(' ').slice(0, 60));
  }
  assert.equal(server.calls.length, 4, 'a bad request never reaches the server');
});

test('write saves a page from --file or stdin; refuses empty, missing, binary and too-big input', async () => {
  const dir = tmp();
  const server = fakeServer();
  fs.writeFileSync(path.join(dir, 'page.md'), '# Rent\nPat is the landlord\n');
  const fromFile = await run(['write', 'wiki/rent.md', '--file', 'page.md'], server, { cwd: dir });
  assert.equal(fromFile.code, 0);
  assert.equal(fromFile.text, 'Saved wiki/rent.md (27 B).');
  assert.equal(server.store.get('wiki/rent.md'), '# Rent\nPat is the landlord\n');
  assert.equal(server.calls[0].method, 'PUT');

  const piped = await run(['write', 'wiki/piped.md'], server, { readStdin: async () => Buffer.from('from stdin\n') });
  assert.equal(piped.code, 0);
  assert.equal(server.store.get('wiki/piped.md'), 'from stdin\n');

  const dash = await run(['write', 'files/a.txt', '--file', '-', '--json'], server, { readStdin: async () => Buffer.from('dash\n') });
  assert.deepEqual(JSON.parse(dash.text), { ok: true, path: 'files/a.txt', bytes: 5 });

  const nothing = await run(['write', 'wiki/x.md'], server, { readStdin: async () => null });
  assert.equal(nothing.code, 2);
  assert.match(nothing.errs, /give the page with --file <file>, or pipe it in/);
  const empty = await run(['write', 'wiki/x.md'], server, { readStdin: async () => Buffer.alloc(0) });
  assert.equal(empty.code, 2);
  assert.match(empty.errs, /nothing to save, no text came in\. To delete a page, run: atris memory rm wiki\/x\.md/);
  fs.writeFileSync(path.join(dir, 'pic.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x81]));
  const binary = await run(['write', 'files/pic.bin', '--file', 'pic.bin'], server, { cwd: dir });
  assert.equal(binary.code, 1);
  assert.match(binary.errs, /pic\.bin is not text/);
  const big = await run(['write', 'files/big.txt'], server, { readStdin: async () => Buffer.alloc(1000001, 97) });
  assert.equal(big.code, 1);
  assert.match(big.errs, /Keep a write under 1 MB\./);
  const gone = await run(['write', 'wiki/x.md', '--file', 'nope.md'], server, { cwd: dir });
  assert.equal(gone.code, 1);
  assert.match(gone.errs, /could not read nope\.md: no such file/);
  const words = await run(['write', 'wiki/x.md', 'some text'], server);
  assert.equal(words.code, 2);
  assert.match(words.errs, /Pipe it in/);

  const refused = await run(['write', 'about.md', '--file', 'page.md'], server, { cwd: dir });
  assert.equal(refused.code, 1);
  assert.equal(refused.errs, 'Agents write under wiki/ or files/. Use remember for notes and the daily log.');
  assert.equal(server.calls.filter((c) => c.method === 'PUT').length, 4);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rm deletes one page; a missing page is a plain answer', async () => {
  const server = fakeServer({ files: FILES });
  const r = await run(['rm', 'wiki/lease.md'], server);
  assert.equal(r.code, 0);
  assert.equal(r.text, 'Deleted wiki/lease.md from your Atris memory.');
  assert.equal(server.calls[0].method, 'DELETE');
  assert.equal(server.calls[0].query.path, 'wiki/lease.md');
  assert.equal(server.store.has('wiki/lease.md'), false);
  const again = await run(['rm', 'wiki/lease.md', '--json'], server);
  assert.equal(again.code, 1);
  assert.deepEqual(JSON.parse(again.text), { ok: false, error: 'No file at wiki/lease.md.', status: 404 });
});

test('log and lesson keep the agent\'s own notebook; --as comes from ATRIS_AGENT when not given', async () => {
  const server = fakeServer();
  const logged = await run(['log', 'drafted the lease email'], server, { env: { ATRIS_AGENT: 'codex' } });
  assert.equal(logged.code, 0);
  assert.deepEqual(server.calls[0].body, { text: 'drafted the lease email', agent: 'codex' });
  assert.equal(logged.text, 'Logged in team/codex/logs/2026-11-09.md: 20:13 UTC drafted the lease email');

  const kept = await run(['lesson', 'search names first', '--before', '3', '--after', '5', '--as', 'grok'], server, { env: { ATRIS_AGENT: 'codex' } });
  assert.equal(kept.code, 0);
  assert.deepEqual(server.calls[1].body, { text: 'search names first', score_before: 3, score_after: 5, agent: 'grok' });
  assert.equal(kept.text, 'Kept in team/grok/lessons.md: 2026-11-09: search names first (score 3 -> 5)');

  const dropped = await run(['lesson', 'guess', '--before=-1', '--after=-1', '--json'], server, { env: { ATRIS_AGENT: 'codex' } });
  const j = JSON.parse(dropped.text);
  assert.equal(j.ok, true);
  assert.equal(j.kept, false);
  assert.equal(server.calls[2].body.score_before, -1);
  const plain = await run(['lesson', 'guess', '--before', '2', '--after', '1'], server, { env: { ATRIS_AGENT: 'codex' } });
  assert.equal(plain.text, 'Not kept, because the score did not go up (2 -> 1). Logged as tried and dropped in team/codex/logs/2026-11-09.md.');

  const noAgent = await run(['log', 'x'], server);
  assert.equal(noAgent.code, 2);
  assert.match(noAgent.errs, /--as <name>, or set ATRIS_AGENT once/);
  for (const bad of [['lesson', 'x', '--after', '2', '--as', 'a'], ['lesson', 'x', '--before', 'high', '--after', '2', '--as', 'a'], ['log', '--as', 'a']]) {
    assert.equal((await run(bad, server)).code, 2, bad.join(' '));
  }
  assert.equal(server.calls.length, 4);
});

test('usage prints the server\'s plain line', async () => {
  const server = fakeServer();
  const r = await run(['usage'], server);
  assert.equal(r.text, 'Your files use 1.2 KB of the 1 GB that comes free. Notes and memory never count toward it.');
  const j = JSON.parse((await run(['usage', '--json'], server)).text);
  assert.equal(j.used_bytes, 1200);
  assert.equal(j.plan, 'free');
});

test('not logged in: every server command stops with one plain line, and --json says the same', async () => {
  const server = fakeServer({ files: FILES });
  const cases = [['show'], ['search', 'x'], ['ask', 'x?'], ['read', 'a.md'], ['ls'], ['remember', 'x'], ['write', 'wiki/a.md'], ['rm', 'wiki/a.md'], ['usage'], ['log', 'x', '--as', 'a'], ['lesson', 'x', '--before', '1', '--after', '2', '--as', 'a']];
  for (const args of cases) {
    const r = await run(args, server, { getAuth: async () => ({ token: '' }), readStdin: async () => { throw new Error('stdin is not read before login'); } });
    assert.equal(r.code, 1, args[0]);
    assert.equal(r.errs, 'not logged in. run: atris login', args[0]);
    const j = await run([...args, '--json'], server, { getAuth: async () => null });
    assert.deepEqual(JSON.parse(j.text), { ok: false, error: 'not logged in. run: atris login' }, args[0]);
  }
  assert.equal(server.calls.length, 0);
});

test('server errors come through in plain words', async () => {
  const say = (result, auth) => plainError(result, auth);
  assert.equal(say({ status: 400, error: 'No file at wiki/x.md.' }), 'No file at wiki/x.md.');
  assert.equal(say({ status: 401, error: 'Invalid token' }), 'your Atris login was not accepted. Run: atris login');
  assert.equal(say({ status: 402, error: 'Your file space is full, so files/a.txt was not saved.' }), 'Your file space is full, so files/a.txt was not saved.');
  assert.equal(say({ status: 403, error: 'This ticket can read but not write.' }), 'This ticket can read but not write.');
  assert.equal(say({ status: 422, error: [{ loc: ['body', 'text'], msg: 'String should have at most 1000 characters' }] }),
    'Atris refused the request, text: String should have at most 1000 characters');
  assert.equal(say({ status: 404, error: 'Not Found' }), 'the Atris server does not have this memory command yet. Try again after it updates.');
  assert.equal(say({ status: 404, error: 'Not Found' }, { scoped: true }), 'this agent sign-in cannot reach Atris memory. Memory needs your own login: atris login');
  assert.equal(say({ status: 429, error: 'Too Many Requests' }), 'Atris is getting too many requests right now. Wait a minute and try again.');
  assert.equal(say({ status: 503, error: '<html>bad gateway</html>' }), 'Atris had a problem (HTTP 503). Try again in a moment.');
  assert.equal(say({ status: 0, error: 'connect ECONNREFUSED 127.0.0.1:9' }), 'could not reach Atris (connect ECONNREFUSED 127.0.0.1:9). Check the connection and try again.');

  const server = fakeServer({ fail: { 'GET /me/memory': { ok: false, status: 500, data: null, error: 'Internal Server Error' } } });
  const r = await run(['show'], server);
  assert.equal(r.code, 1);
  assert.equal(r.errs, 'Atris had a problem (HTTP 500). Try again in a moment.');
  const j = JSON.parse((await run(['show', '--json'], server)).text);
  assert.deepEqual(j, { ok: false, error: 'Atris had a problem (HTTP 500). Try again in a moment.', status: 500 });
  const missing = await run(['read', 'wiki/nope.md'], fakeServer());
  assert.equal(missing.errs, 'No file at wiki/nope.md.');
});

test('the rules block is short, plain and written idempotently between its markers', async () => {
  const block = live.rulesBlock('codex');
  const lines = block.split('\n');
  assert.ok(lines.length <= 15, `block is ${lines.length} lines`);
  assert.equal(lines[0], live.BEGIN);
  assert.equal(lines.at(-1), live.END);
  for (const needed of ['atris memory show', 'atris memory search', 'atris memory remember', 'remember, note, save or don\'t forget', '--as codex', 'atris memory log']) {
    assert.ok(block.includes(needed), needed);
  }
  assert.match(live.rulesBlock(''), /--as <your-name>/);

  const dir = tmp();
  const file = path.join(dir, 'AGENTS.md');
  const before = '# My project\n\nUse tabs.\n';
  fs.writeFileSync(file, before);
  const first = await run(['agents', '--write', 'AGENTS.md', '--as', 'codex'], null, { cwd: dir });
  assert.equal(first.code, 0);
  assert.match(first.text, /^Added the Atris memory rules to AGENTS\.md\./);
  const once = fs.readFileSync(file, 'utf8');
  assert.equal(once, `${before}\n${block}\n`);
  const second = await run(['agents', '--write', 'AGENTS.md', '--as', 'codex'], null, { cwd: dir });
  assert.match(second.text, /already has these rules\. Nothing changed\./);
  assert.equal(fs.readFileSync(file, 'utf8'), once, 'rerun changes nothing');

  fs.appendFileSync(file, '\n## Later notes\nKeep these.\n');
  const withTail = fs.readFileSync(file, 'utf8');
  const third = await run(['agents', '--write', 'AGENTS.md', '--as', 'cursor'], null, { cwd: dir });
  assert.match(third.text, /Updated the Atris memory rules in AGENTS\.md\. The rest of the file is untouched\./);
  const after = fs.readFileSync(file, 'utf8');
  assert.equal(after, withTail.replace(block, live.rulesBlock('cursor')));
  assert.equal(after.split(live.BEGIN).length, 2, 'exactly one block');
  assert.ok(after.startsWith(before) && after.endsWith('## Later notes\nKeep these.\n'));

  const fresh = path.join(dir, '.cursor', 'rules', 'atris.mdc');
  await run(['agents', '--write', fresh], null, { cwd: dir });
  assert.equal(fs.readFileSync(fresh, 'utf8'), `${live.rulesBlock('')}\n`);

  const j = JSON.parse((await run(['agents', '--write', 'AGENTS.md', '--as', 'cursor', '--json'], null, { cwd: dir })).text);
  assert.equal(j.ok, true);
  assert.equal(j.file.action, 'unchanged');
  assert.equal(j.agent, 'cursor');
  assert.equal(j.mcp.url, 'https://api.atris.ai/mcp');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the rules block keeps CRLF files CRLF, collapses a pasted-twice copy, and refuses a half block', () => {
  const block = live.rulesBlock('codex');
  const crlf = live.upsertBlock('# Rules\r\nbe kind\r\n', block);
  assert.equal(crlf.action, 'added');
  assert.equal(crlf.text, `# Rules\r\nbe kind\r\n\r\n${block.replace(/\n/g, '\r\n')}\r\n`);
  assert.equal(live.upsertBlock(crlf.text, block).action, 'unchanged');

  const old = `${live.BEGIN}\nold rules\n${live.END}`;
  const twice = live.upsertBlock(`top\n${old}\n\n${old}\nbottom\n`, block);
  assert.equal(twice.text, `top\n${block}\nbottom\n`);
  assert.equal(live.upsertBlock('', block).text, `${block}\n`);
  assert.equal(live.upsertBlock('no newline at end', block).text, `no newline at end\n\n${block}\n`);
  assert.throws(() => live.upsertBlock(`top\n${live.BEGIN}\nhalf\n`, block), /with no <!-- atris-memory:end -->/);

  const dir = tmp();
  const file = path.join(dir, 'CLAUDE.md');
  const half = `keep\n${live.BEGIN}\nhalf\n`;
  fs.writeFileSync(file, half);
  return run(['agents', '--write', file], null, { cwd: dir }).then((r) => {
    assert.equal(r.code, 1);
    assert.match(r.errs, /Fix that by hand/);
    assert.equal(fs.readFileSync(file, 'utf8'), half, 'a half block is never guessed at');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

test('agents prints the block to paste and the MCP lines for the server the CLI talks to', async () => {
  const r = await run(['agents'], null);
  assert.equal(r.code, 0);
  assert.ok(r.text.includes(live.rulesBlock('')));
  assert.match(r.text, /atris memory agents --write AGENTS\.md/);
  assert.match(r.text, /Claude Code: claude mcp add --transport http atris https:\/\/api\.atris\.ai\/mcp --header "Authorization: Bearer atris_YOUR_KEY"/);
  assert.match(r.text, /Codex: {7}codex mcp add atris --url https:\/\/api\.atris\.ai\/mcp --bearer-token-env-var ATRIS_API_KEY/);
  assert.match(r.text, /Cursor: {6}in ~\/\.cursor\/mcp\.json: \{"mcpServers":\{"atris":\{"type":"http","url":"https:\/\/api\.atris\.ai\/mcp"/);
  assert.match(r.text, /atris api-key create memory/);
  const local = await run(['setup', '--json'], null, { apiBase: 'http://localhost:8000/api' });
  assert.equal(JSON.parse(local.text).mcp.url, 'http://localhost:8000/mcp');
  assert.equal((await run(['agents', 'extra'], null)).code, 2);
});

test('atris memory routes the new commands and shows every command in one grouped screen', async () => {
  const out = [];
  const server = fakeServer();
  const code = await memoryCommand(['show'], {
    log: (line) => out.push(line),
    err: (line) => out.push(line),
    apiRequestJson: server.request,
    getAuth: async () => ({ token: 'tok-1' }),
  });
  assert.equal(code, 0);
  assert.match(out.join('\n'), /^# Atris memory/);

  const help = [];
  assert.equal(await memoryCommand([], { log: (line) => help.push(line) }), 0);
  const screen = help.join('\n');
  for (const group of ['read', 'save', 'notebook (an agent\'s own; --as defaults to $ATRIS_AGENT)', 'copy to laptop: atris memory <pull|push|status> [folder] [--json]']) {
    assert.ok(screen.split('\n').includes(group), group);
  }
  for (const sub of ['show', 'search', 'ask', 'read', 'ls', 'remember', 'write', 'rm', 'usage', 'log', 'lesson', 'agents', 'pull', 'push', 'status']) {
    assert.match(screen, new RegExp(`^ {2}${sub}\\b`, 'm'), sub);
  }
  assert.ok(screen.split('\n').length <= 30, 'fits one screen');
  assert.equal((await run(['read', '--frm', '2', 'a.md'], null)).code, 2);
  assert.equal((await run(['ls', '--raw'], null)).code, 2, '--raw is for read only');
});

// ---------------------------------------------------------------- the real CLI against a local stand-in server

function startServer() {
  const seen = [];
  const store = new Map([['wiki/lease.md', '# Lease\nlandlord is Pat\n']]);
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      seen.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, auth: req.headers.authorization });
      const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      const key = `${req.method} ${url.pathname}`;
      if (key === 'GET /api/me/memory') return send(200, { files: NOTES, empty: false, suggestions: [] });
      if (key === 'GET /api/memory/grep') return send(200, { hits: [{ path: 'wiki/lease.md', n: 2, text: 'landlord is Pat' }], files: 1, truncated: false });
      if (key === 'PUT /api/memory/write') { store.set(body.path, body.text); return send(200, { path: body.path, bytes: Buffer.byteLength(body.text) }); }
      if (key === 'POST /api/me/memory/remember') return send(200, { file: body.file, added: `- ${body.text} (${body.source}, 2026-11-09)` });
      if (key === 'GET /api/memory/read') return send(400, { detail: `No file at ${url.searchParams.get('path')}.` });
      return send(404, { detail: 'Not Found' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, store, port: server.address().port })));
}

function cliEnv(home, extra = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('ATRIS_')) delete env[name];
  return { ...env, HOME: home, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_NONINTERACTIVE: '1', ...extra };
}

function runCli(args, env, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'memory', ...args], { env, cwd: env.HOME });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

test('the real CLI: show, search, remember and a stdin write against a local server, plus not logged in', async () => {
  const home = tmp();
  const { server, seen, store, port } = await startServer();
  try {
    const env = cliEnv(home, { ATRIS_API_URL: `http://127.0.0.1:${port}/api`, ATRIS_TOKEN: 'cli-token-9', ATRIS_AGENT: 'opencode' });
    const show = await runCli(['show'], env);
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /^# Atris memory\n/);
    assert.match(show.stdout, /Likes short answers/);
    assert.equal(seen[0].auth, 'Bearer cli-token-9');

    const search = await runCli(['search', 'landlord', '--json'], env);
    assert.equal(search.status, 0, search.stderr);
    assert.deepEqual(JSON.parse(search.stdout).hits, [{ path: 'wiki/lease.md', n: 2, text: 'landlord is Pat' }]);

    const page = '# Notes\nfrom a pipe, with ünïcode\n';
    const write = await runCli(['write', 'wiki/notes.md'], env, page);
    assert.equal(write.status, 0, write.stderr);
    assert.equal(write.stdout.trim(), `Saved wiki/notes.md (${live.size(Buffer.byteLength(page))}).`);
    assert.equal(store.get('wiki/notes.md'), page);

    const remember = await runCli(['remember', 'likes window seats'], env);
    assert.equal(remember.stdout.trim(), 'Saved to journal: likes window seats (opencode, 2026-11-09)');

    const missing = await runCli(['read', 'wiki/nope.md'], env);
    assert.equal(missing.status, 1);
    assert.equal(missing.stderr.trim(), 'No file at wiki/nope.md.');

    const out = cliEnv(home);
    const nobody = await runCli(['show'], out);
    assert.equal(nobody.status, 1);
    assert.equal(nobody.stderr.trim(), 'not logged in. run: atris login');
    const nobodyJson = await runCli(['remember', 'x', '--json'], out);
    assert.equal(nobodyJson.status, 1);
    assert.deepEqual(JSON.parse(nobodyJson.stdout), { ok: false, error: 'not logged in. run: atris login' });
    const before = seen.length;
    const noInput = await runCli(['write', 'wiki/x.md'], env, '');
    assert.equal(noInput.status, 2);
    assert.match(noInput.stderr, /nothing to save, no text came in/);
    assert.equal(seen.length, before);
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the fast path loads only what memory needs', async () => {
  const home = tmp();
  const hook = path.join(home, 'loaded.js');
  fs.writeFileSync(hook, "process.on('exit', () => { process.stderr.write('\\nLOADED ' + JSON.stringify(Object.keys(require.cache)) + '\\n'); });\n");
  try {
    const env = cliEnv(home);
    const r = await new Promise((resolve) => {
      const child = spawn(process.execPath, ['-r', hook, CLI, 'memory', 'agents'], { env, cwd: home });
      let stderr = '';
      child.stdout.resume();
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (status) => resolve({ status, stderr }));
    });
    assert.equal(r.status, 0);
    const loaded = JSON.parse(r.stderr.split('LOADED ')[1]).map((file) => path.relative(path.join(__dirname, '..'), file));
    for (const heavy of ['lib/first-minute.js', 'lib/task-db.js', 'lib/memory-folder.js', 'lib/mission-runtime-loop.js', 'utils/update-check.js', 'lib/context-gatherer.js']) {
      assert.ok(!loaded.includes(heavy), `${heavy} is not loaded`);
    }
    assert.ok(loaded.includes('commands/memory-live.js'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
