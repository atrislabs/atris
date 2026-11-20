const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { safeLineMerge } = require('../lib/company-brain-sync');

const exec = promisify(execFile);
const cli = path.resolve(__dirname, '../bin/atris.js');
const hash = content => createHash('sha256').update(content).digest('hex');

test('merge results survive reversed arrival and ambiguous edits stay separate', () => {
  const base = 'items\n';
  for (const [local, remote] of [['7\n', '5\n'], ['5\n', '7\n']]) {
    assert.equal(safeLineMerge(base, base + local, base + remote).content, 'items\n5\n7\n');
  }
  assert.equal(safeLineMerge('x\nz', 'z', '\nz').ok, false);
  const edited = 'one\nTWO\n';
  const inserted = 'one\nextra\ntwo\n';
  for (const [local, remote] of [[edited, inserted], [inserted, edited]]) {
    assert.equal(safeLineMerge('one\ntwo\n', local, remote).content, 'one\nextra\nTWO\n');
  }
  assert.equal(safeLineMerge('price 20\n', 'price 30\n', 'price 40\n').ok, false);
});

test('two independent CLI clients retain their edits after racing past the freshness check', { timeout: 120000 }, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'atris-file-revisions-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const file = 'orders.txt';
  const base = 'items\n';
  let content = base;
  const written = [];
  let automatic = true;
  let supportsRoute = true;
  let firstWrite;
  const bothWritersArrived = new Promise(resolve => { firstWrite = resolve; });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const respond = (body, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/business/') return respond([{ id: 'b', workspace_id: 'w', slug: 'test-co', name: 'Test' }]);
    const row = { path: file, size: Buffer.byteLength(content), hash: hash(content) };
    const dotfile = { path: '.gitignore', size: 5, hash: hash('dist\n') };
    if (url.pathname.endsWith('/snapshot')) {
      if (url.searchParams.get('include_content') === 'true') {
        row.content = content;
        dotfile.content = 'dist\n';
      }
      return respond({ files: [row, dotfile], supports_conditional_sync: automatic });
    }
    if (url.pathname.endsWith('/files/batch')) return respond({ files: [{ ...row, content }, { ...dotfile, content: 'dist\n' }] });
    if (url.pathname.endsWith('/sync/conditional')) {
      if (!supportsRoute) return respond({}, 404);
      let data = '';
      for await (const chunk of req) data += chunk;
      const [write] = JSON.parse(data).files;
      written.push(write);
      if (written.length === 1) await bothWritersArrived;
      if (written.length === 2) firstWrite();
      const status = write.expected_hash === hash(content) ? 'written' : 'conflict';
      if (status === 'written') content = write.content;
      return respond({ results: [{ path: file, status }] });
    }
    if (url.pathname.endsWith('/git/head') || url.pathname.endsWith('/telemetry')) return respond({});
    return respond({}, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const clients = await Promise.all(['one', 'two'].map(async name => {
    const home = path.join(temp, name);
    const cwd = path.join(home, 'work');
    await fs.mkdir(cwd, { recursive: true });
    const run = (...args) => exec(process.execPath, [cli, ...args], {
      cwd,
      timeout: 30000,
      env: {
        PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH || '', HOME: home,
        ATRIS_TOKEN: 'fixture', ATRIS_API_URL: 'http://127.0.0.1:' + server.address().port,
      },
    });
    await fs.writeFile(path.join(cwd, '.gitignore'), 'dist\n');
    await run('pull', 'test-co', '--into', cwd, '--keep-local', '--fail-on-conflict');
    assert.equal(await fs.readFile(path.join(cwd, '.gitignore'), 'utf8'), 'dist\n');
    return { run, cwd, file: path.join(cwd, file) };
  }));
  await Promise.all(clients.map((c, i) => fs.appendFile(c.file, i ? '5\n' : '7\n')));
  const results = await Promise.allSettled(clients.map(c =>
    c.run('push', 'test-co', '--from', c.cwd, '--only', file)
  ));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1, JSON.stringify(results));
  assert.deepEqual(written.map(write => write.expected_hash), [hash(base), hash(base)]);
  assert.match(results.find(result => result.status === 'rejected').reason.stderr, /did not accept every revision/);
  const loser = clients[results.findIndex(result => result.status === 'rejected')];
  await loser.run('pull', 'test-co', '--into', loser.cwd, '--keep-local', '--fail-on-conflict');
  assert.equal(await fs.readFile(loser.file, 'utf8'), 'items\n5\n7\n');
  await loser.run('push', 'test-co', '--from', loser.cwd, '--only', file, '--conditional');
  assert.equal(content, 'items\n5\n7\n');
  const winner = clients.find(client => client !== loser);
  await winner.run('pull', 'test-co', '--into', winner.cwd, '--keep-local', '--fail-on-conflict');
  assert.equal(await fs.readFile(winner.file, 'utf8'), content);

  // A local save made while the snapshot request is in flight must survive an ordinary pull.
  const original = content;
  content += 'remote update\n';
  const saveDuringSnapshot = req => {
    if (req.url.includes('/snapshot?')) require('node:fs').writeFileSync(winner.file, original + 'late local save\n');
  };
  server.prependListener('request', saveDuringSnapshot);
  await assert.rejects(winner.run('pull', 'test-co', '--into', winner.cwd, '--keep-local', '--fail-on-conflict'),
    error => error.code === 2);
  server.off('request', saveDuringSnapshot);
  assert.equal(await fs.readFile(winner.file, 'utf8'), original + 'late local save\n');
  await winner.run('pull', 'test-co', '--into', winner.cwd);

  // An explicitly guarded client must not fall back to an unconditional upload.
  automatic = false;
  supportsRoute = false;
  await fs.appendFile(winner.file, 'must stay local\n');
  await assert.rejects(winner.run('push', 'test-co', '--from', winner.cwd, '--only', file, '--conditional'),
    error => /does not support conditional sync/.test(error.stderr));
  assert.equal(content, original + 'remote update\n');
});

test('install preserves a racing editor save, an open descriptor and interrupted work', async t => {
  const io = require('node:fs');
  const { installLocalMerge, recoverInterruptedMerges } = require('../lib/local-merge-install');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-install-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'note.txt');
  await fs.writeFile(target, 'latest');
  assert.equal(installLocalMerge(root, target, hash('previous'), 'merged'), false);
  assert.equal(await fs.readFile(target, 'utf8'), 'latest');

  const oldFile = await fs.open(target, 'a');
  assert.equal(installLocalMerge(root, target, hash('latest'), 'merged'), true);
  await oldFile.write(' late save');
  await oldFile.close();
  const history = path.join(root, '.atris', 'sync', 'local-revisions');
  const copies = await Promise.all((await fs.readdir(history)).map(name => fs.readFile(path.join(history, name, 'original'), 'utf8')));
  assert.ok(copies.includes('latest late save'));
  recoverInterruptedMerges(root);
  const recovered = (await fs.readdir(root)).filter(name => name.startsWith('note.txt.recovered-'));
  assert.equal(recovered.length, 1);
  assert.equal(await fs.readFile(path.join(root, recovered[0]), 'utf8'), 'latest late save');
  assert.equal(await fs.readFile(target, 'utf8'), 'merged');

  const link = io.linkSync;
  const mock = t.mock.method(io, 'linkSync', (source, dest) => {
    if (dest === target && path.basename(source) === 'candidate') io.writeFileSync(dest, 'editor replacement');
    return link(source, dest);
  });
  assert.equal(installLocalMerge(root, target, hash('merged'), 'merged again'), false);
  mock.mock.restore();
  assert.equal(await fs.readFile(target, 'utf8'), 'editor replacement');

  const longName = path.join(root, 'a'.repeat(196) + '.txt');
  await fs.writeFile(longName, 'before');
  const held = await fs.open(longName, 'a');
  assert.equal(installLocalMerge(root, longName, hash('before'), 'after'), true);
  await held.write(' later');
  await held.close();
  recoverInterruptedMerges(root);
  const shortName = (await fs.readdir(root)).find(name => name.startsWith('recovered-'));
  assert.equal(await fs.readFile(path.join(root, shortName), 'utf8'), 'before later');

  const pending = path.join(root, '.atris', 'sync', 'pending-merges', '2147483647-orphan');
  await fs.mkdir(pending);
  await fs.writeFile(path.join(pending, 'path'), 'note.txt');
  await fs.rename(target, path.join(pending, 'original'));
  recoverInterruptedMerges(root);
  assert.equal(await fs.readFile(target, 'utf8'), 'editor replacement');
});
