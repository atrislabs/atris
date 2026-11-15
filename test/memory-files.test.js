'use strict';

// Real files in the memory folder: binary and big files under files/ go up on
// a signed upload form and come down on a signed link, byte for byte, streamed.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { memoryCommand } = require('../commands/memory');
const { STATE_FILE } = require('../lib/memory-folder');
const { hashFileSync, progressPrinter } = require('../lib/memory-files');

const md5 = (data) => crypto.createHash('md5').update(data).digest('hex');
const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');
const MB = 1024 * 1024;

function parseForm(body, contentType) {
  const boundary = /boundary=(.+)$/.exec(contentType)[1];
  const fields = {};
  let file = null;
  let pos = body.indexOf(`--${boundary}`);
  while (pos !== -1) {
    const start = pos + boundary.length + 2;
    if (body.subarray(start, start + 2).toString() === '--') break;
    const headEnd = body.indexOf('\r\n\r\n', start);
    const head = body.subarray(start + 2, headEnd).toString();
    const next = body.indexOf(`\r\n--${boundary}`, headEnd + 4);
    const name = /name="([^"]+)"/.exec(head)[1];
    const content = body.subarray(headEnd + 4, next);
    if (name === 'file') file = content; else fields[name] = content.toString();
    pos = next + 2;
  }
  return { fields, file };
}

// The Atris memory API (through the injected request helper) and a private bucket
// (a real local HTTP server, standing in for S3's signed POST and GET).
async function fakeCloud(initial = {}) {
  const objects = new Map(); // rel -> { data, meta }
  let n = 0;
  const put = (rel, data, meta = {}) => objects.set(rel, { data: Buffer.from(data), meta });
  for (const [rel, data] of Object.entries(initial)) put(rel, data);
  const forms = new Map();
  const links = new Map();
  const calls = [];
  const s3 = { posts: 0, gets: 0, headers: [], damage: null, refuse: false };

  const server = http.createServer((req, res) => {
    s3.headers.push(req.headers);
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname.startsWith('/get/')) {
      s3.gets += 1;
      const rel = links.get(url.pathname.slice(5));
      const found = rel && objects.get(rel);
      if (!found) { res.writeHead(403); res.end('<Error><Code>AccessDenied</Code></Error>'); return; }
      const data = s3.damage === rel ? Buffer.from(found.data.toString('latin1').replace(/./, '#'), 'latin1') : found.data;
      res.writeHead(200, { 'Content-Length': data.length });
      res.end(data);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/upload') {
      s3.posts += 1;
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        assert.equal(Number(req.headers['content-length']), body.length);
        const { fields, file } = parseForm(body, req.headers['content-type']);
        const signed = forms.get(fields['x-amz-meta-atris-upload']);
        if (s3.refuse || !signed || signed.key !== fields.key || file.length !== signed.size) {
          res.writeHead(400);
          res.end('<Error><Code>EntityTooLarge</Code><Message>Your proposed upload exceeds the maximum allowed size</Message></Error>');
          return;
        }
        put(signed.key, file, { 'atris-upload': fields['x-amz-meta-atris-upload'] });
        res.writeHead(204);
        res.end();
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((go) => server.listen(0, '127.0.0.1', go));
  const base = `http://127.0.0.1:${server.address().port}`;

  const fail = (status, error) => ({ ok: false, status, data: null, error });
  const ok = (data) => ({ ok: true, status: 200, data });
  const request = async (pathname, options = {}) => {
    const url = new URL(pathname, 'https://x.test');
    const param = (name) => url.searchParams.get(name);
    const method = options.method || 'GET';
    calls.push(`${method} ${url.pathname}${param('path') ? ` ${param('path')}` : ''}`);
    assert.ok(options.token, 'every call carries the login token');
    if (url.pathname === '/memory/ls') {
      const prefix = param('folder') ? `${param('folder')}/` : '';
      const seen = new Map();
      for (const [key, { data }] of objects) {
        if (!key.startsWith(prefix)) continue;
        const [name, ...deeper] = key.slice(prefix.length).split('/');
        if (deeper.length) seen.set(`${name}/`, { name: `${name}/`, files: 1 });
        else seen.set(name, { name, size: data.length, content_type: 'application/octet-stream' });
      }
      return ok({ items: [...seen.values()] });
    }
    if (url.pathname === '/memory/file' && method === 'GET') {
      const found = objects.get(param('path'));
      if (!found) return fail(400, `No file at ${param('path')}.`);
      const text = new TextDecoder('utf-8', { fatal: true });
      try { return ok({ path: param('path'), text: text.decode(found.data) }); } catch { return fail(400, 'That file is not text.'); }
    }
    if (url.pathname === '/memory/file' && method === 'DELETE') {
      if (!objects.delete(param('path'))) return fail(404, `No file at ${param('path')}.`);
      return ok({ path: param('path'), deleted: true });
    }
    if (url.pathname === '/memory/write') {
      const { path: rel, text } = options.body;
      if (Buffer.byteLength(text) > 1000000) return fail(400, 'Keep a write under 1 MB.');
      put(rel, text);
      return ok({ path: rel, bytes: Buffer.byteLength(text) });
    }
    if (url.pathname === '/memory/link') {
      const found = objects.get(param('path'));
      if (!found) return fail(404, `No file at ${param('path')}.`);
      const id = String((n += 1));
      links.set(id, param('path'));
      return ok({ path: param('path'), url: `${base}/get/${id}`, bytes: found.data.length, etag: md5(found.data), md5: md5(found.data) });
    }
    if (url.pathname === '/memory/upload') {
      const { path: rel, size } = options.body;
      if (!rel.startsWith('files/')) return fail(400, 'Uploads go under files/.');
      if (s3.full) return fail(402, 'Your file space is full, so it was not saved. Your notes, board and memory keep working as always.');
      const id = crypto.randomBytes(8).toString('hex');
      forms.set(id, { key: rel, size });
      return ok({ path: rel, url: `${base}/upload`, token: id, bytes: size,
        fields: { key: rel, 'Content-Type': 'application/octet-stream', 'x-amz-meta-atris-upload': id, policy: 'p', 'x-amz-signature': 's' } });
    }
    if (url.pathname === '/memory/upload/done') {
      const signed = forms.get(options.body.token);
      const found = signed && objects.get(signed.key);
      if (!found || found.meta['atris-upload'] !== options.body.token) return fail(404, `Nothing arrived at ${signed && signed.key}.`);
      return ok({ path: signed.key, bytes: found.data.length, etag: md5(found.data), md5: md5(found.data) });
    }
    return fail(404, 'Not Found');
  };
  return { objects, calls, request, s3, put, close: () => new Promise((go) => server.close(go)) };
}

function run(sub, dir, cloud, extra = []) {
  const out = [];
  return memoryCommand([sub, dir, ...extra], {
    log: (line) => out.push(line),
    err: (line) => out.push(line),
    apiRequestJson: cloud && cloud.request,
    getToken: async () => ({ token: 'secret-token-123', account: 'acct-1' }),
    tty: null,
  }).then((code) => ({ code, text: out.join('\n') }));
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-memory-files-test-'));
}

// Every byte value, in a pattern no text decoder would accept.
function binary(bytes) {
  const data = crypto.randomBytes(bytes);
  data[0] = 0xff;
  data[1] = 0xfe;
  return data;
}

const START = { 'MAP.md': '# MAP\n', 'about.md': '# About me\n', 'wiki/a.md': 'a\n', 'files/notes/todo.txt': 'one\n' };

test('push sends photos and big files through the upload form, byte for byte, with a progress line', async () => {
  const dir = tmp();
  const cloud = await fakeCloud(START);
  try {
    await run('pull', dir, cloud);
    const photo = binary(300 * 1024);
    const film = binary(9 * MB);
    const big = Buffer.from('line of a big csv\n'.repeat(80000)); // 1.4 MB of text
    fs.mkdirSync(path.join(dir, 'files/photos'));
    fs.writeFileSync(path.join(dir, 'files/photos/beach.jpg'), photo);
    fs.writeFileSync(path.join(dir, 'files/film.mov'), film);
    fs.writeFileSync(path.join(dir, 'files/export.csv'), big);
    fs.writeFileSync(path.join(dir, 'wiki/a.md'), 'a, edited\n');
    const r = await run('push', dir, cloud);
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /^Sending files\/film.mov \(9 MB\)\.\.\.$/m);
    assert.doesNotMatch(r.text, /Sending files\/photos/); // small files need no progress line
    assert.match(r.text, /Pushed 4 files: files\/export.csv, files\/film.mov, files\/photos\/beach.jpg, wiki\/a.md\./);
    assert.ok(cloud.objects.get('files/film.mov').data.equals(film));
    assert.ok(cloud.objects.get('files/photos/beach.jpg').data.equals(photo));
    assert.ok(cloud.objects.get('files/export.csv').data.equals(big));
    assert.equal(cloud.objects.get('wiki/a.md').data.toString(), 'a, edited\n');
    assert.deepEqual(cloud.calls.filter((c) => c.startsWith('PUT')), ['PUT /memory/write']); // only the page went as text
    assert.equal(cloud.s3.posts, 3);
    assert.ok(cloud.s3.headers.every((h) => !h.authorization), 'the login token never goes to storage');
    const state = JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), 'utf8'));
    assert.deepEqual(state.files['files/film.mov'], { sha256: sha(film), bytes: film.length, md5: md5(film), etag: md5(film) });
    const again = await run('push', dir, cloud);
    assert.match(again.text, /Nothing to push/);
    assert.equal(cloud.s3.posts, 3);
    assert.match((await run('status', dir)).text, /Nothing changed here/);
  } finally {
    await cloud.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pull brings binary and big files down byte-exact, and leaves no half-fetched copy', async () => {
  const film = binary(6 * MB);
  const scan = binary(5000);
  const cloud = await fakeCloud({ ...START, 'files/film.mov': film, 'files/scan.pdf': scan, 'files/big.md': `${'x'.repeat(2 * MB)}\n` });
  const dir = tmp();
  try {
    const r = await run('pull', dir, cloud);
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /Pulled 7 files/);
    assert.match(r.text, /^Fetching files\/film.mov \(6 MB\)\.\.\.$/m);
    assert.equal(hashFileSync(path.join(dir, 'files/film.mov')).sha256, sha(film));
    assert.equal(hashFileSync(path.join(dir, 'files/scan.pdf')).sha256, sha(scan));
    assert.equal(fs.readFileSync(path.join(dir, 'files/big.md'), 'utf8').length, 2 * MB + 1);
    assert.equal(cloud.s3.gets, 3);
    assert.ok(cloud.s3.headers.every((h) => !h.authorization));
    assert.deepEqual(fs.readdirSync(path.join(dir, 'files')).filter((n) => n.includes('atris-tmp')), []);

    const second = await run('pull', dir, cloud);
    assert.match(second.text, /7 already current/);
    assert.equal(cloud.s3.gets, 3); // unchanged files are not fetched again

    const newer = binary(6 * MB);
    cloud.put('files/film.mov', newer);
    const third = await run('pull', dir, cloud);
    assert.match(third.text, /1 updated/);
    assert.equal(hashFileSync(path.join(dir, 'files/film.mov')).sha256, sha(newer));
  } finally {
    await cloud.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a small .csv that is not UTF-8 goes up as a file and comes down byte-exact on another laptop', async () => {
  const here = tmp();
  const there = tmp();
  const cloud = await fakeCloud(START);
  try {
    await run('pull', here, cloud);
    const excel = Buffer.from('name;city\nJos\xe9;S\xe3o Paulo\n', 'latin1');
    fs.writeFileSync(path.join(here, 'files/export.csv'), excel);
    assert.match((await run('push', here, cloud)).text, /Pushed 1 file: files\/export.csv/);
    assert.ok(cloud.objects.get('files/export.csv').data.equals(excel));
    const r = await run('pull', there, cloud);
    assert.equal(r.code, 0, r.text);
    assert.ok(fs.readFileSync(path.join(there, 'files/export.csv')).equals(excel));
    const gets = cloud.s3.gets;
    assert.match((await run('pull', there, cloud)).text, /5 already current/);
    assert.equal(cloud.s3.gets, gets);
  } finally {
    await cloud.close();
    fs.rmSync(here, { recursive: true, force: true });
    fs.rmSync(there, { recursive: true, force: true });
  }
});

test('big files are streamed: neither push nor pull reads one whole into memory', async () => {
  const dir = tmp();
  const cloud = await fakeCloud(START);
  const realRead = fs.readFileSync;
  try {
    await run('pull', dir, cloud);
    const film = binary(12 * MB);
    fs.writeFileSync(path.join(dir, 'files/film.mov'), film);
    fs.readFileSync = function guarded(target, ...rest) {
      if (String(target).endsWith('film.mov')) throw new Error('read a whole big file into memory');
      return realRead.call(fs, target, ...rest);
    };
    assert.match((await run('status', dir)).text, /new\s+files\/film.mov/);
    const pushed = await run('push', dir, cloud);
    assert.equal(pushed.code, 0, pushed.text);
    fs.rmSync(path.join(dir, 'files/film.mov'));
    const pulled = await run('pull', dir, cloud);
    assert.equal(pulled.code, 0, pulled.text);
    assert.equal(hashFileSync(path.join(dir, 'files/film.mov')).sha256, sha(film));
  } finally {
    fs.readFileSync = realRead;
    await cloud.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a file changed on both sides is never overwritten, either way', async () => {
  const dir = tmp();
  const cloud = await fakeCloud({ ...START, 'files/scan.pdf': binary(4000) });
  try {
    await run('pull', dir, cloud);
    const theirs = binary(4000);
    const mine = binary(4100);
    cloud.put('files/scan.pdf', theirs);
    fs.writeFileSync(path.join(dir, 'files/scan.pdf'), mine);
    const push = await run('push', dir, cloud);
    assert.equal(push.code, 1);
    assert.match(push.text, /Not pushed: files\/scan.pdf changed on the server since your last pull/);
    assert.ok(cloud.objects.get('files/scan.pdf').data.equals(theirs));
    const pull = await run('pull', dir, cloud);
    assert.match(pull.text, /Left files\/scan.pdf alone: it changed here and on the server/);
    assert.ok(fs.readFileSync(path.join(dir, 'files/scan.pdf')).equals(mine));
    assert.equal(cloud.s3.posts, 0);

    // a file someone else made at the same path is not overwritten either
    fs.writeFileSync(path.join(dir, 'files/new.bin'), binary(100));
    cloud.put('files/new.bin', binary(100));
    assert.match((await run('push', dir, cloud)).text, /files\/new.bin.* changed on the server/);
  } finally {
    await cloud.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an edit here to a file the server still has as pulled is kept, without fetching it again', async () => {
  const dir = tmp();
  const cloud = await fakeCloud({ ...START, 'files/scan.pdf': binary(4000) });
  try {
    await run('pull', dir, cloud);
    const mine = binary(4000);
    fs.writeFileSync(path.join(dir, 'files/scan.pdf'), mine);
    const gets = cloud.s3.gets;
    assert.match((await run('pull', dir, cloud)).text, /Kept your edits to files\/scan.pdf/);
    assert.equal(cloud.s3.gets, gets);
    assert.match((await run('push', dir, cloud)).text, /Pushed 1 file: files\/scan.pdf/);
    assert.ok(cloud.objects.get('files/scan.pdf').data.equals(mine));
  } finally {
    await cloud.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a damaged download is refused and the copy here is untouched', async () => {
  const dir = tmp();
  const original = binary(5000);
  const cloud = await fakeCloud({ ...START, 'files/scan.pdf': original });
  try {
    await run('pull', dir, cloud);
    const newer = binary(5000);
    cloud.put('files/scan.pdf', newer);
    cloud.s3.damage = 'files/scan.pdf';
    const r = await run('pull', dir, cloud);
    assert.equal(r.code, 1);
    assert.match(r.text, /Could not copy files\/scan.pdf: it arrived damaged/);
    assert.ok(fs.readFileSync(path.join(dir, 'files/scan.pdf')).equals(original));
    assert.deepEqual(fs.readdirSync(path.join(dir, 'files')).filter((n) => n.includes('atris-tmp')), []);
  } finally {
    await cloud.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a send storage refuses is reported, still confirmed so its room comes back, and a full folder says so', async () => {
  const dir = tmp();
  const cloud = await fakeCloud(START);
  try {
    await run('pull', dir, cloud);
    fs.writeFileSync(path.join(dir, 'files/a.bin'), binary(2000));
    cloud.s3.refuse = true;
    const r = await run('push', dir, cloud);
    assert.equal(r.code, 1);
    assert.match(r.text, /Could not push files\/a.bin: storage refused it \(EntityTooLarge/);
    assert.ok(cloud.calls.includes('POST /memory/upload/done'), 'a failed send is still confirmed');
    assert.equal(cloud.objects.has('files/a.bin'), false);
    cloud.s3.refuse = false;
    cloud.s3.full = true;
    const full = await run('push', dir, cloud);
    assert.match(full.text, /Could not push files\/a.bin: could not send files\/a.bin: Your file space is full/);
    cloud.s3.full = false;
    assert.match((await run('push', dir, cloud)).text, /Pushed 1 file: files\/a.bin/);
  } finally {
    await cloud.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('push skips nothing silently: every changed file lands in one named outcome', async () => {
  const dir = tmp();
  const cloud = await fakeCloud(START);
  try {
    await run('pull', dir, cloud);
    const changes = {
      'files/photo.heic': binary(800),
      'files/huge.txt': Buffer.from('y'.repeat(1500000)),
      'files/empty.bin': Buffer.alloc(0),
      'wiki/picture.png': binary(500),
      'wiki/too-long.md': Buffer.from('z'.repeat(1000001)),
      'wiki/a.md': Buffer.from('a2\n'),
      'about.md': Buffer.from('# About me, edited\n'),
    };
    for (const [rel, data] of Object.entries(changes)) fs.writeFileSync(path.join(dir, rel), data);
    const r = await run('push', dir, cloud, ['--json']);
    const out = JSON.parse(r.text);
    const outcomes = ['pushed', 'alreadyThere', 'conflicts', 'tooBig', 'notText', 'notPushable'];
    const seen = outcomes.flatMap((key) => out[key]).concat(out.failed.map((f) => f.path));
    assert.deepEqual([...seen].sort(), Object.keys(changes).sort());
    assert.equal(new Set(seen).size, seen.length, 'each file has exactly one outcome');
    assert.deepEqual(out.pushed, ['files/empty.bin', 'files/huge.txt', 'files/photo.heic', 'wiki/a.md']);
    assert.deepEqual(out.notText, ['wiki/picture.png']);
    assert.deepEqual(out.tooBig, ['wiki/too-long.md']);
    assert.deepEqual(out.notPushable, ['about.md']);
    assert.equal(cloud.objects.get('files/empty.bin').data.length, 0);
  } finally {
    await cloud.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('push --prune removes a deleted file only while the server copy is the one pulled', async () => {
  const dir = tmp();
  const cloud = await fakeCloud({ ...START, 'files/old.mov': binary(3000), 'files/kept.mov': binary(3000) });
  try {
    await run('pull', dir, cloud);
    fs.rmSync(path.join(dir, 'files/old.mov'));
    fs.rmSync(path.join(dir, 'files/kept.mov'));
    cloud.put('files/kept.mov', binary(3000)); // changed on another laptop
    const status = await run('status', dir);
    assert.match(status.text, /deleted\s+files\/old.mov\s+\(atris memory push --prune removes it from Atris\)/);
    const r = await run('push', dir, cloud, ['--prune']);
    assert.match(r.text, /Removed 1 file from your Atris memory: files\/old.mov\./);
    assert.match(r.text, /Not removed: files\/kept.mov changed on the server since your last pull/);
    assert.equal(cloud.objects.has('files/old.mov'), false);
    assert.equal(cloud.objects.has('files/kept.mov'), true);
  } finally {
    await cloud.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the progress line updates in place on a terminal and prints once elsewhere', () => {
  const written = [];
  const logged = [];
  const onTerminal = progressPrinter({ log: (l) => logged.push(l), tty: { write: (s) => written.push(s) } });
  for (const done of [0, 2 * MB, 2 * MB + 1, 8 * MB]) onTerminal({ rel: 'files/a.mov', verb: 'Sending', done, total: 8 * MB });
  onTerminal({ rel: 'files/a.mov', verb: 'Sending', done: 8 * MB, total: 8 * MB, finished: true });
  onTerminal({ rel: 'files/small.jpg', verb: 'Sending', done: 10, total: 10 });
  assert.deepEqual(written, ['\rSending files/a.mov (8 MB) 0%', '\rSending files/a.mov (8 MB) 25%',
    '\rSending files/a.mov (8 MB) 100%', '\n']);
  assert.deepEqual(logged, []);
  const plain = progressPrinter({ log: (l) => logged.push(l) });
  for (const done of [0, 4 * MB, 8 * MB]) plain({ rel: 'files/a.mov', verb: 'Fetching', done, total: 8 * MB });
  assert.deepEqual(logged, ['Fetching files/a.mov (8 MB)...']);
});
