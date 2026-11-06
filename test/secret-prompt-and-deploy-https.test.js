const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const AUTH = path.join(__dirname, '..', 'utils', 'auth.js');

function ask(secret) {
  const script = `require(${JSON.stringify(AUTH)}).promptUser('API token: ', ${secret ? '{ secret: true }' : '{}'}).then((a) => process.stderr.write('got:' + a))`;
  return spawnSync(process.execPath, ['-e', script], { input: 'tok_live_abc123\n', encoding: 'utf8' });
}

test('a secret prompt never prints the piped answer back', () => {
  const r = ask(true);
  assert.equal(r.stderr, 'got:tok_live_abc123');
  assert.match(r.stdout, /API token: /);
  assert.doesNotMatch(r.stdout, /tok_live_abc123/);
});

test('an ordinary prompt still echoes the piped answer', () => {
  const r = ask(false);
  assert.match(r.stdout, /tok_live_abc123/);
});

test('site deploy refuses plain http to another machine before any request', async () => {
  const { run } = require('../commands/site-deploy');
  const fs = require('fs');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-https-'));
  fs.writeFileSync(path.join(dir, 'index.html'), 'hello');
  const calls = [];
  const errors = [];
  try {
    for (const base of ['http://api.example.com', 'http://10.0.0.5:8080']) {
      const code = await run([dir, '--name', 'plain-http', '--api-base', base, '--yes'], {
        loadCredentials: () => ({ token: 'user-token' }),
        fetch: async (url) => { calls.push(url); throw new Error('should not send'); },
        request: async (url) => { calls.push(url); throw new Error('should not send'); },
        log: () => {},
        error: (line) => errors.push(line),
      });
      assert.equal(code, 2);
    }
    assert.deepEqual(calls, []);
    assert.equal(errors.length, 2);
    assert.ok(errors.every((line) => /https/.test(line)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
