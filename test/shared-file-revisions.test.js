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
  const edited = 'one\nTWO\n';
  const inserted = 'one\nextra\ntwo\n';
  for (const [local, remote] of [[edited, inserted], [inserted, edited]]) {
    assert.equal(safeLineMerge('one\ntwo\n', local, remote).content, 'one\nextra\nTWO\n');
  }
  assert.equal(safeLineMerge('price 20\n', 'price 30\n', 'price 40\n').ok, false);
});

test('two independent CLI clients retain their edits after racing past the freshness check', { timeout: 30000 }, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'atris-file-revisions-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const file = 'orders.txt';
  const base = 'items\n';
  let content = base;
  const written = [];
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
    if (url.pathname.endsWith('/snapshot')) {
      if (url.searchParams.get('include_content') === 'true') row.content = content;
      return respond({ files: [row] });
    }
    if (url.pathname.endsWith('/files/batch')) return respond({ files: [{ ...row, content }] });
    if (url.pathname.endsWith('/sync/conditional')) {
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
      timeout: 12000,
      env: {
        PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH || '', HOME: home,
        ATRIS_TOKEN: 'fixture', ATRIS_API_URL: 'http://127.0.0.1:' + server.address().port,
      },
    });
    await run('pull', 'test-co', '--into', cwd);
    return { run, cwd, file: path.join(cwd, file) };
  }));
  await Promise.all(clients.map((c, i) => fs.appendFile(c.file, i ? '5\n' : '7\n')));
  const results = await Promise.allSettled(clients.map(c =>
    c.run('push', 'test-co', '--from', c.cwd, '--only', file, '--conditional')
  ));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1, JSON.stringify(results));
  assert.deepEqual(written.map(write => write.expected_hash), [hash(base), hash(base)]);
  const loser = clients[results.findIndex(result => result.status === 'rejected')];
  await loser.run('pull', 'test-co', '--into', loser.cwd, '--keep-local', '--fail-on-conflict');
  assert.equal(await fs.readFile(loser.file, 'utf8'), 'items\n5\n7\n');
  await loser.run('push', 'test-co', '--from', loser.cwd, '--only', file, '--conditional');
  assert.equal(content, 'items\n5\n7\n');
  const winner = clients.find(client => client !== loser);
  await winner.run('pull', 'test-co', '--into', winner.cwd, '--keep-local', '--fail-on-conflict');
  assert.equal(await fs.readFile(winner.file, 'utf8'), content);
});
