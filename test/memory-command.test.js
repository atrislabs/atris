'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { memoryCommand } = require('../commands/memory');
const { cleanRel, STATE_FILE } = require('../lib/memory-folder');

const CLI = path.join(__dirname, '..', 'bin', 'atris.js');

// A stand-in for the memory part of the Atris server, kept in a Map.
function fakeServer(initial, { raw = true, bundle = false, listingEtags = false, bundleSize = 1000 } = {}) {
  const files = new Map(Object.entries(initial));
  const calls = [];
  const bodies = [];
  const etag = (text) => crypto.createHash('md5').update(text).digest('hex');
  const fail = (status, error) => ({ ok: false, status, data: null, error });
  const ok = (data) => ({ ok: true, status: 200, data });
  const request = async (pathname, options = {}) => {
    const url = new URL(pathname, 'https://x.test');
    const param = (name) => url.searchParams.get(name);
    calls.push(`${options.method || 'GET'} ${url.pathname}`);
    assert.ok(options.token, 'every call carries the login token');
    if (url.pathname === '/memory/bundle' && bundle) {
      bodies.push(options.body);
      const { have, after } = options.body;
      const changed = [...files].filter(([rel, text]) => have[rel] !== etag(text)).sort(([a], [b]) => a.localeCompare(b));
      const offset = Number(after || 0);
      return ok({
        pages: changed.slice(offset, offset + bundleSize).map(([rel, text]) => ({ path: rel, text, etag: etag(text) })),
        unchanged: Object.entries(have).filter(([rel, value]) => files.has(rel) && etag(files.get(rel)) === value).length,
        gone: Object.keys(have).filter((rel) => !files.has(rel)), skipped: [],
        next: offset + bundleSize < changed.length ? String(offset + bundleSize) : null,
      });
    }
    if (url.pathname === '/memory/ls') {
      const base = param('folder') ? `${param('folder')}/` : '';
      const seen = new Map();
      for (const [key, text] of files) {
        if (!key.startsWith(base)) continue;
        const [name, ...deeper] = key.slice(base.length).split('/');
        if (deeper.length) seen.set(`${name}/`, { name: `${name}/`, files: 1 });
        else seen.set(name, { name, size: Buffer.byteLength(text), ...(listingEtags ? { etag: etag(text) } : {}) });
      }
      return ok({ items: [...seen.values()] });
    }
    if (url.pathname === '/memory/file') {
      if (!raw) return fail(404, 'Not Found');
      if (!files.has(param('path'))) return fail(400, `No file at ${param('path')}.`);
      return ok({ path: param('path'), text: files.get(param('path')) });
    }
    if (url.pathname === '/memory/read') {
      if (!files.has(param('path'))) return fail(400, `No file at ${param('path')}.`);
      const lines = files.get(param('path')).split(/\r?\n/);
      if (lines[lines.length - 1] === '') lines.pop();
      const start = Number(param('start'));
      const count = Number(param('count'));
      return ok({
        lines: lines.slice(start - 1, start - 1 + count).map((text, i) => ({ n: start + i, text })),
        total: lines.length,
        more: start - 1 + count < lines.length,
      });
    }
    if (url.pathname === '/memory/write') {
      const { path: rel, text } = options.body;
      if (!/^(wiki|files)\//.test(rel)) return fail(400, 'Agents write under wiki/ or files/.');
      files.set(rel, text);
      return ok({ path: rel, bytes: Buffer.byteLength(text) });
    }
    return fail(404, 'Not Found');
  };
  return { files, calls, bodies, request };
}

function run(sub, dir, server, extra = []) {
  const out = [];
  const errs = [];
  return memoryCommand([sub, dir, ...extra], {
    log: (line) => out.push(line),
    err: (line) => errs.push(line),
    apiRequestJson: server && server.request,
    getToken: async () => ({ token: 'secret-token-123', account: 'acct-1' }),
  }).then((code) => ({ code, text: out.join('\n'), errs: errs.join('\n') }));
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-memory-test-'));
}

const START = {
  'MAP.md': '# MAP\n',
  'about.md': '# About me\n',
  'now.md': '# Now\n',
  'wiki/learning.md': '# Learning\n',
  'wiki/people/sam.md': '# Sam\r\nmet at the meetup',
  'logs/2026/2026-11-09.md': '# 2026-11-09\n\n- Applied to Wise\n',
  'files/notes/todo.txt': 'one\ntwo\n',
};

test('bundle pulls 200 pages in a handful of requests and follows cursors', async () => {
  const dir = tmp();
  const files = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`wiki/${String(i).padStart(3, '0')}.md`, `page ${i}\n`]));
  const server = fakeServer(files, { bundle: true, bundleSize: 75 });
  const result = await run('pull', dir, server);
  assert.equal(result.code, 0);
  assert.equal(server.calls.length, 3);
  assert.deepEqual(server.bodies.map((body) => body.after), ['', '75', '150']);
  for (const [rel, text] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(dir, rel), 'utf8'), text);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an unchanged bundle uses one request and writes no files', async () => {
  const dir = tmp();
  const server = fakeServer(START, { bundle: true });
  assert.equal((await run('pull', dir, server)).code, 0);
  const paths = [STATE_FILE, ...Object.keys(START)].map((rel) => path.join(dir, rel));
  const before = paths.map((abs) => fs.statSync(abs).mtimeMs);
  server.calls.length = 0;
  assert.equal((await run('pull', dir, server)).code, 0);
  assert.deepEqual(server.calls, ['POST /memory/bundle']);
  assert.deepEqual(paths.map((abs) => fs.statSync(abs).mtimeMs), before);
  assert.equal(Object.keys(server.bodies.at(-1).have).length, Object.keys(START).length);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a changed bundle page is rewritten and local edits stay safe', async () => {
  const dir = tmp();
  const server = fakeServer(START, { bundle: true });
  await run('pull', dir, server);
  server.files.set('now.md', 'changed on server\n');
  fs.writeFileSync(path.join(dir, 'about.md'), 'local edit\n');
  server.files.set('wiki/learning.md', 'server edit\n');
  fs.writeFileSync(path.join(dir, 'wiki/learning.md'), 'local edit\n');
  const result = await run('pull', dir, server);
  assert.equal(result.code, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'now.md'), 'utf8'), 'changed on server\n');
  assert.equal(fs.readFileSync(path.join(dir, 'about.md'), 'utf8'), 'local edit\n');
  assert.equal(fs.readFileSync(path.join(dir, 'wiki/learning.md'), 'utf8'), 'local edit\n');
  assert.match(result.text, /Left wiki\/learning.md alone/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('older servers fall back and avoid fetching matching listing etags', async () => {
  const dir = tmp();
  const server = fakeServer({ 'wiki/a.md': 'a\n', 'wiki/b.md': 'b\n' }, { listingEtags: true });
  assert.equal((await run('pull', dir, server)).code, 0);
  server.calls.length = 0;
  server.files.set('wiki/b.md', 'new\n');
  assert.equal((await run('pull', dir, server)).code, 0);
  assert.equal(server.calls.filter((call) => call === 'GET /memory/file').length, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'wiki/b.md'), 'utf8'), 'new\n');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('bundle reports removed pages without removing local copies and restores deleted local pages', async () => {
  const dir = tmp();
  const server = fakeServer({ 'wiki/a.md': 'a\n', 'wiki/b.md': 'b\n' }, { bundle: true });
  await run('pull', dir, server);
  server.files.delete('wiki/a.md');
  fs.unlinkSync(path.join(dir, 'wiki/b.md'));
  const result = await run('pull', dir, server);
  assert.equal(result.code, 0);
  assert.match(result.text, /1 file is no longer on the server/);
  assert.equal(fs.readFileSync(path.join(dir, 'wiki/a.md'), 'utf8'), 'a\n');
  assert.equal(fs.readFileSync(path.join(dir, 'wiki/b.md'), 'utf8'), 'b\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE))).files['wiki/a.md'], undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('bundle skipped files use the existing download fallback', async () => {
  const dir = tmp();
  const server = fakeServer({ 'files/a.txt': 'hello\n' }, { bundle: true });
  const request = server.request;
  server.request = async (pathname, options) => {
    if (pathname === '/memory/bundle') return { ok: true, status: 200, data: { pages: [], unchanged: 0, gone: [], skipped: [{ path: 'files/a.txt', size: 6, why: 'too big' }], next: null } };
    return request(pathname, options);
  };
  const result = await run('pull', dir, server);
  assert.equal(result.code, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'files/a.txt'), 'utf8'), 'hello\n');
  assert.ok(server.calls.includes('GET /memory/link'));
  assert.ok(server.calls.includes('GET /memory/file'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a 405 bundle response falls back, while other errors stop the pull', async () => {
  const dir = tmp();
  const server = fakeServer({ 'wiki/a.md': 'a\n' });
  const request = server.request;
  let status = 405;
  server.request = async (pathname, options) => pathname === '/memory/bundle'
    ? { ok: false, status, error: 'unavailable' } : request(pathname, options);
  assert.equal((await run('pull', dir, server)).code, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'wiki/a.md'), 'utf8'), 'a\n');
  server.calls.length = 0;
  status = 429;
  assert.equal((await run('pull', dir, server)).code, 1);
  assert.deepEqual(server.calls, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pull copies every file, keeps paths and exact bytes, and writes a hidden state file', async () => {
  const dir = tmp();
  const server = fakeServer(START);
  const r = await run('pull', dir, server);
  assert.equal(r.code, 0);
  assert.match(r.text, /Pulled 7 files/);
  for (const [rel, text] of Object.entries(START)) {
    assert.equal(fs.readFileSync(path.join(dir, rel), 'utf8'), text, rel);
  }
  const state = JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), 'utf8'));
  assert.equal(Object.keys(state.files).length, 7);
  assert.match(state.files['about.md'].sha256, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(state).includes('secret-token'));
  assert.ok(!r.text.includes('secret-token'));
  const again = await run('pull', dir, server);
  assert.match(again.text, /7 already current/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pull works on a server without the exact-file call, paging through numbered lines', async () => {
  const dir = tmp();
  const long = `${Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n')}\n`;
  const server = fakeServer({ 'wiki/long.md': long, 'wiki/a.md': 'a\n' }, { raw: false });
  const r = await run('pull', dir, server);
  assert.equal(r.code, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'wiki/long.md'), 'utf8'), long);
  assert.match(r.text, /older download/);
  assert.equal(server.calls.filter((c) => c === 'GET /memory/read').length >= 4, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('push sends only wiki/ and files/ changes, and says the rest change through remember', async () => {
  const dir = tmp();
  const server = fakeServer(START);
  await run('pull', dir, server);
  fs.writeFileSync(path.join(dir, 'wiki/learning.md'), '# Learning\n- gardening\n');
  fs.mkdirSync(path.join(dir, 'wiki/agent-notes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'wiki/agent-notes/new.md'), 'hello\n');
  fs.writeFileSync(path.join(dir, 'about.md'), '# About me\nI edited this\n');
  fs.writeFileSync(path.join(dir, 'logs/2026/2026-11-09.md'), 'rewritten\n');
  const r = await run('push', dir, server);
  assert.equal(r.code, 0);
  assert.match(r.text, /Pushed 2 files: wiki\/agent-notes\/new.md, wiki\/learning.md/);
  assert.match(r.text, /Not pushed: about.md, logs\/2026\/2026-11-09.md\. Those change through remember/);
  assert.equal(server.files.get('wiki/agent-notes/new.md'), 'hello\n');
  assert.equal(server.files.get('wiki/learning.md'), '# Learning\n- gardening\n');
  assert.equal(server.files.get('about.md'), '# About me\n');
  assert.equal(server.files.get('logs/2026/2026-11-09.md'), START['logs/2026/2026-11-09.md']);
  const second = await run('push', dir, server);
  assert.doesNotMatch(second.text, /Pushed/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('push does not overwrite a file the server changed since the last pull', async () => {
  const dir = tmp();
  const server = fakeServer(START);
  await run('pull', dir, server);
  fs.writeFileSync(path.join(dir, 'wiki/learning.md'), 'mine\n');
  server.files.set('wiki/learning.md', '# Learning\n- changed elsewhere\n');
  const r = await run('push', dir, server);
  assert.equal(r.code, 1);
  assert.match(r.text, /wiki\/learning.md changed on the server since your last pull/);
  assert.equal(server.files.get('wiki/learning.md'), '# Learning\n- changed elsewhere\n');
  fs.writeFileSync(path.join(dir, 'wiki/brand-new.md'), 'x\n');
  server.files.set('wiki/brand-new.md', 'someone else made this\n');
  const clash = await run('push', dir, server);
  assert.match(clash.text, /wiki\/brand-new.md, wiki\/learning.md changed on the server/);
  assert.equal(server.files.get('wiki/brand-new.md'), 'someone else made this\n');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pull updates untouched files, keeps local edits, and never clobbers a clash', async () => {
  const dir = tmp();
  const server = fakeServer(START);
  await run('pull', dir, server);
  server.files.set('now.md', '# Now\n- new goal\n');
  fs.writeFileSync(path.join(dir, 'wiki/learning.md'), 'my edit\n');
  server.files.set('wiki/people/sam.md', 'server edit\n');
  fs.writeFileSync(path.join(dir, 'wiki/people/sam.md'), 'local edit\n');
  const r = await run('pull', dir, server);
  assert.match(r.text, /1 updated/);
  assert.match(r.text, /Kept your edits to wiki\/learning.md/);
  assert.match(r.text, /Left wiki\/people\/sam.md alone/);
  assert.equal(fs.readFileSync(path.join(dir, 'now.md'), 'utf8'), '# Now\n- new goal\n');
  assert.equal(fs.readFileSync(path.join(dir, 'wiki/learning.md'), 'utf8'), 'my edit\n');
  assert.equal(fs.readFileSync(path.join(dir, 'wiki/people/sam.md'), 'utf8'), 'local edit\n');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('status lists local changes and flags files that cannot be pushed', async () => {
  const dir = tmp();
  const server = fakeServer(START);
  await run('pull', dir, server);
  assert.match((await run('status', dir)).text, /Nothing changed here/);
  fs.writeFileSync(path.join(dir, 'wiki/learning.md'), 'edit\n');
  fs.writeFileSync(path.join(dir, 'files/new.txt'), 'new\n');
  fs.writeFileSync(path.join(dir, 'about.md'), 'edit\n');
  fs.rmSync(path.join(dir, 'now.md'));
  const r = await run('status', dir);
  assert.match(r.text, /edited\s+wiki\/learning.md\n/);
  assert.match(r.text, /new\s+files\/new.txt\n/);
  assert.match(r.text, /edited\s+about.md\s+\(changes through remember, not pushed\)/);
  assert.match(r.text, /deleted\s+now.md/);
  const json = JSON.parse((await run('status', dir, null, ['--json'])).text);
  assert.deepEqual(json.added, ['files/new.txt']);
  assert.equal(server.calls.includes('GET /memory/ls'), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('unsafe names from the server are never written outside the folder', async () => {
  const parent = tmp();
  const dir = path.join(parent, 'mem');
  const server = fakeServer({
    '../escape.md': 'bad', 'wiki/../../escape2.md': 'bad', '/abs.md': 'bad', 'wiki\\win.md': 'bad',
    '.atris-memory.json': '{"files":{}}', 'wiki/.hidden.md': 'bad', 'wiki/fine.md': 'ok\n',
  });
  const r = await run('pull', dir, server);
  assert.equal(r.code, 0);
  assert.match(r.text, /Skipped \d+ files with names that are not safe/);
  assert.equal(fs.readFileSync(path.join(dir, 'wiki/fine.md'), 'utf8'), 'ok\n');
  assert.deepEqual(fs.readdirSync(parent), ['mem']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), 'utf8')).files['wiki/fine.md'].bytes, 3);
  fs.rmSync(parent, { recursive: true, force: true });
});

test('a link inside the folder cannot lead a pull or a push outside it', async () => {
  const parent = tmp();
  const dir = path.join(parent, 'mem');
  const outside = path.join(parent, 'outside');
  fs.mkdirSync(outside);
  fs.mkdirSync(dir);
  fs.symlinkSync(outside, path.join(dir, 'wiki'));
  const server = fakeServer({ 'wiki/a.md': 'a\n', 'files/b.md': 'b\n' });
  const r = await run('pull', dir, server);
  assert.equal(r.code, 1);
  assert.match(r.text, /Could not copy wiki\/a.md/);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(fs.readFileSync(path.join(dir, 'files/b.md'), 'utf8'), 'b\n');
  fs.writeFileSync(path.join(outside, 'secret.md'), 'private');
  fs.symlinkSync(path.join(outside, 'secret.md'), path.join(dir, 'files/leak.md'));
  const push = await run('push', dir, server);
  assert.match(push.text, /Skipped .*files\/leak.md \(is a link\)/);
  assert.equal(server.files.has('files/leak.md'), false);
  assert.equal(server.files.has('wiki/secret.md'), false);
  fs.rmSync(parent, { recursive: true, force: true });
});

test('push needs a pull first, refuses big or binary files, and refuses a dangerous folder', async () => {
  const dir = tmp();
  const server = fakeServer(START);
  const early = await run('push', dir, server);
  assert.equal(early.code, 1);
  assert.match(early.errs, /has not been pulled yet/);
  await run('pull', dir, server);
  fs.writeFileSync(path.join(dir, 'files/big.txt'), 'x'.repeat(1000001));
  fs.writeFileSync(path.join(dir, 'files/pic.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x80]));
  const r = await run('push', dir, server);
  assert.match(r.text, /files\/big.txt is over 1 MB/);
  assert.match(r.text, /files\/pic.bin is not a text file/);
  assert.equal(server.files.has('files/big.txt'), false);
  const home = await run('pull', os.homedir(), server);
  assert.equal(home.code, 1);
  assert.match(home.errs, /your home directory/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a folder pulled with one account refuses another, and no login stops everything', async () => {
  const dir = tmp();
  const server = fakeServer(START);
  await run('pull', dir, server);
  const other = await memoryCommand(['pull', dir], {
    err: () => {}, log: () => {}, apiRequestJson: server.request,
    getToken: async () => ({ token: 't', account: 'acct-2' }),
  });
  assert.equal(other, 1);
  const errs = [];
  const none = await memoryCommand(['pull', dir], {
    err: (l) => errs.push(l), log: () => {}, apiRequestJson: server.request, getToken: async () => ({ token: '' }),
  });
  assert.equal(none, 1);
  assert.match(errs.join(''), /not logged in/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cleanRel accepts plain folder paths only', () => {
  assert.equal(cleanRel('wiki/a/b.md'), 'wiki/a/b.md');
  for (const bad of ['', '/x', '../x', 'a/../b', 'a//b', './a', 'a\\b', 'C:x', '.hid', 'a/.b', null, 'x'.repeat(401)]) {
    assert.equal(cleanRel(bad), null, String(bad));
  }
});

test('atris memory is a real command with help and a clear unknown-subcommand answer', () => {
  const cwd = tmp();
  const env = { ...process.env, HOME: cwd, ATRIS_NONINTERACTIVE: '1' };
  const help = spawnSync(process.execPath, [CLI, 'memory', '--help'], { cwd, env, encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /atris memory <pull\|push\|status>/);
  const bad = spawnSync(process.execPath, [CLI, 'memory', 'sing'], { cwd, env, encoding: 'utf8' });
  assert.equal(bad.status, 2);
  const status = spawnSync(process.execPath, [CLI, 'memory', 'status', path.join(cwd, 'nope')], { cwd, env, encoding: 'utf8' });
  assert.equal(status.status, 1);
  assert.match(status.stderr, /has not been pulled yet/);
  fs.rmSync(cwd, { recursive: true, force: true });
});

// The fake server plus DELETE /memory/file, answered the way the real one answers it.
function deletingServer(initial, { canDelete = true } = {}) {
  const server = fakeServer(initial);
  const inner = server.request;
  server.request = async (pathname, options = {}) => {
    if (options.method !== 'DELETE') return inner(pathname, options);
    const url = new URL(pathname, 'https://x.test');
    const rel = url.searchParams.get('path');
    server.calls.push(`DELETE ${url.pathname} ${rel}`);
    assert.ok(options.token, 'every call carries the login token');
    if (!canDelete || url.pathname !== '/memory/file') return { ok: false, status: 405, data: null, error: 'Method Not Allowed' };
    if (!/^(wiki|files)\//.test(rel) || rel === 'wiki/learning.md') {
      return { ok: false, status: 400, data: null, error: 'Only pages under wiki/ and files under files/ can be deleted.' };
    }
    if (!server.files.has(rel)) return { ok: false, status: 404, data: null, error: `No file at ${rel}.` };
    server.files.delete(rel);
    return { ok: true, status: 200, data: { path: rel, deleted: true } };
  };
  return server;
}

const deletes = (server) => server.calls.filter((call) => call.startsWith('DELETE'));

test('push --prune removes pages deleted here, only under wiki/ and files/, and lists them first', async () => {
  const dir = tmp();
  const server = deletingServer(START);
  await run('pull', dir, server);
  for (const rel of ['wiki/people/sam.md', 'files/notes/todo.txt', 'now.md', 'wiki/learning.md']) {
    fs.rmSync(path.join(dir, rel));
  }

  const plain = await run('push', dir, server);
  assert.equal(plain.code, 0);
  assert.deepEqual(deletes(server), []);
  assert.match(plain.text, /files\/notes\/todo.txt, wiki\/people\/sam.md\) and are still in your Atris memory\. To remove them there too, run: atris memory push --prune/);
  assert.match(plain.text, /now.md, wiki\/learning.md were deleted here\. Notes and daily pages can't be deleted/);
  const before = (await run('status', dir)).text;
  assert.match(before, /deleted\s+wiki\/people\/sam.md\s+\(atris memory push --prune removes it from Atris\)/);
  assert.match(before, /deleted\s+now.md\s+\(notes and daily pages stay; pull brings it back\)/);
  assert.match(before, /deleted\s+wiki\/learning.md\s+\(notes and daily pages stay/);

  const out = [];
  const code = await memoryCommand(['push', dir, '--prune'], {
    log: (line) => out.push({ line, deletesSoFar: deletes(server).length }),
    err: (line) => out.push({ line }),
    apiRequestJson: server.request,
    getToken: async () => ({ token: 'secret-token-123', account: 'acct-1' }),
  });
  assert.equal(code, 0);
  const text = out.map((o) => o.line).join('\n');
  assert.match(text, /^Removing 2 files from your Atris memory, because you deleted them here:\n {2}files\/notes\/todo.txt\n {2}wiki\/people\/sam.md\n/);
  assert.ok(out.slice(0, 3).every((o) => o.deletesSoFar === 0), 'the list prints before anything is removed');
  assert.match(text, /Removed 2 files from your Atris memory: files\/notes\/todo.txt, wiki\/people\/sam.md\./);
  assert.match(text, /Not removed: now.md, wiki\/learning.md\. Notes and daily pages can't be deleted/);
  assert.deepEqual(deletes(server).sort(), ['DELETE /memory/file files/notes/todo.txt', 'DELETE /memory/file wiki/people/sam.md']);
  assert.equal(server.files.has('wiki/people/sam.md'), false);
  assert.equal(server.files.has('files/notes/todo.txt'), false);
  assert.equal(server.files.get('now.md'), START['now.md']);
  assert.equal(server.files.get('wiki/learning.md'), START['wiki/learning.md']);

  const after = (await run('status', dir)).text;
  assert.doesNotMatch(after, /sam.md|todo.txt/);
  assert.match(after, /deleted\s+now.md/);
  const again = JSON.parse((await run('push', dir, server, ['--prune', '--json'])).text);
  assert.deepEqual(again.removed, []);
  assert.deepEqual(again.notRemovable, ['now.md', 'wiki/learning.md']);
  assert.equal(deletes(server).length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('push --prune never removes a page changed on the server since the pull, and copes with one already gone', async () => {
  const dir = tmp();
  const server = deletingServer(START);
  await run('pull', dir, server);
  fs.rmSync(path.join(dir, 'wiki/people/sam.md'));
  fs.rmSync(path.join(dir, 'files/notes/todo.txt'));
  server.files.set('wiki/people/sam.md', '# Sam\nedited on another laptop\n');
  server.files.delete('files/notes/todo.txt');
  const r = await run('push', dir, server, ['--prune']);
  assert.equal(r.code, 1);
  assert.match(r.text, /Not removed: wiki\/people\/sam.md changed on the server since your last pull, so nothing was lost/);
  assert.match(r.text, /Already gone from your Atris memory: files\/notes\/todo.txt\./);
  assert.equal(server.files.get('wiki/people/sam.md'), '# Sam\nedited on another laptop\n');
  assert.deepEqual(deletes(server), []);
  const pulled = await run('pull', dir, server);
  assert.equal(pulled.code, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'wiki/people/sam.md'), 'utf8'), '# Sam\nedited on another laptop\n');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('push --prune on a server that cannot delete yet removes nothing and says so; --prune is push only', async () => {
  const dir = tmp();
  const server = deletingServer(START, { canDelete: false });
  await run('pull', dir, server);
  fs.rmSync(path.join(dir, 'wiki/people/sam.md'));
  const r = await run('push', dir, server, ['--prune']);
  assert.equal(r.code, 1);
  assert.match(r.text, /Could not remove wiki\/people\/sam.md: the Atris server cannot delete pages yet/);
  assert.equal(server.files.has('wiki/people/sam.md'), true);
  assert.match((await run('status', dir)).text, /deleted\s+wiki\/people\/sam.md/);
  for (const sub of ['pull', 'status']) {
    const wrong = await run(sub, dir, server, ['--prune']);
    assert.equal(wrong.code, 2);
    assert.match(wrong.errs, /--prune only works with push/);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
