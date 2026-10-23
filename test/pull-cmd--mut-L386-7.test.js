const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// A saved manifest with files but no workspace_root (written by an older
// version) must still count as "same root": the hash-only sync stays on.
test('manifest without a saved workspace root still gets the hash-only sync', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-pull-mut-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const home = path.join(root, 'home');
  const work = path.join(root, 'work');
  const manifestDir = path.join(home, '.atris', 'businesses', 'acme');
  const outDir = path.join(work, 'acme');
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(path.join(manifestDir, 'manifest.json'), JSON.stringify({
    last_sync: '2020-01-01T00:00:00.000Z',
    files: { '/note.md': { hash: 'abc123', size: 5 } },
  }));
  fs.writeFileSync(path.join(outDir, 'note.md'), 'hello');

  const overrides = {
    HOME: home,
    ATRIS_AGENT_TOKEN_FILE: path.join(home, 'agent-token.json'),
    ATRIS_PROFILE: '',
    ATRIS_TOKEN: `test.${Buffer.from(JSON.stringify({
      type: 'agent_access',
      exp: 4000000000,
    })).toString('base64url')}.test`,
  };
  const previousEnv = Object.fromEntries(Object.keys(overrides).map((k) => [k, process.env[k]]));
  Object.assign(process.env, overrides);

  const previousCwd = process.cwd();
  const previousArgv = process.argv;
  process.chdir(work);
  process.argv = [process.execPath, 'atris', 'pull', 'acme', '--keep-local'];

  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  t.mock.method(process.stdout, 'write', () => true);
  t.mock.method(process, 'exit', (code) => {
    assert.fail(`pull must not exit the process (${code})`);
  });
  const spinner = t.mock.method(global, 'setInterval', () => 0);

  const requested = [];
  const api = require('../utils/api');
  t.mock.method(api, 'apiRequestJson', async (p) => {
    requested.push(p);
    if (p === '/business/') {
      return { ok: true, data: [{ id: 'b1', slug: 'acme', name: 'Acme', workspace_id: 'w1' }] };
    }
    if (p.includes('/snapshot')) {
      return { ok: true, data: { files: [{ path: 'note.md', hash: 'abc123', size: 5 }] } };
    }
    return { ok: true, data: {} };
  });

  try {
    const { pullAtris } = require('../commands/pull');
    await pullAtris();
  } finally {
    spinner.mock.restore();
    process.argv = previousArgv;
    process.chdir(previousCwd);
    for (const [k, v] of Object.entries(previousEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  const snapshotUrl = requested.find((u) => u.includes('/snapshot'));
  assert.ok(snapshotUrl, 'expected pull to request a workspace snapshot');
  assert.ok(
    snapshotUrl.includes('include_content=false'),
    `expected the hash-only snapshot, got ${snapshotUrl}`
  );
});
