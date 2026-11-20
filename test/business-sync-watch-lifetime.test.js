const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

test('sync --watch keeps receiving remote changes after its first sync', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-watch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(path.join(cwd, '.atris'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.atris/business.json'), JSON.stringify({ slug: 'example' }));

  let content = 'first version';
  const writes = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let body = {};
    if (url.pathname === '/api/business/') {
      body = [{ id: 'b', slug: 'example', name: 'Example', workspace_id: 'w' }];
    } else if (url.pathname.endsWith('/snapshot') || url.pathname.endsWith('/files/batch')) {
      const hash = createHash('sha256').update(content).digest('hex');
      const file = { path: '/note.md', hash, size: Buffer.byteLength(content) };
      if (url.searchParams.get('include_content') !== 'false') file.content = content;
      // Cloud computers omit bytes for binary files. The hash-only listing
      // can include the same path without identifying it as binary.
      const attachment = { path: '/photo.bin', hash: 'a-binary-hash', size: 20,
        binary: url.searchParams.get('include_content') !== 'false' };
      body = { files: [file, attachment] };
    }
    if (url.pathname.endsWith('/sync')) {
      let payload = '';
      for await (const chunk of req) payload += chunk;
      const { files } = JSON.parse(payload);
      writes.push(...files);
      body = { results: files.map(({ path }) => ({ path, status: 'written' })) };
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());

  const cli = path.resolve(__dirname, '../bin/atris.js');
  const child = spawn(process.execPath, [cli, 'sync', 'example', '--watch', '--interval=1', '--debounce=1'], {
    cwd,
    env: { ...process.env, HOME: root, ATRIS_TOKEN: 'test', ATRIS_SKIP_UPDATE_CHECK: '1',
      ATRIS_API_URL: 'http://127.0.0.1:' + server.address().port + '/api' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  t.after(async () => { child.kill(); await closed; });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  const file = path.join(cwd, 'note.md');
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && child.exitCode === null) {
    if (output.includes('watching this folder')) content = 'second version';
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === 'second version') {
      fs.writeFileSync(file, 'reply');
    }
    if (writes.length) {
      assert.deepEqual(writes, [{ path: 'note.md', content: 'reply' }]);
      return;
    }
    await delay(50);
  }
  assert.fail('The watcher failed to receive the remote edit and publish its reply.\n' + output);
});
