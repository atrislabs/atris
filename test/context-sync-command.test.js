'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { businessStatus, businessDiff } = require('../commands/context-sync');
const { saveManifest, computeLocalHashes } = require('../lib/manifest');

// Env vars that can pull in a real login from outside the sandbox.
const AUTH_ENV = [
  'ATRIS_TOKEN',
  'ATRIS_PROFILE',
  'ATRIS_AGENT_TOKEN_FILE',
  'ATRIS_CLIENT_ID',
  'ATRIS_CLIENT_SECRET_FILE',
];

// Runs fn inside a throwaway HOME and cwd. Restores everything afterwards.
// process.exit is replaced so a command's exit(1) becomes a catchable error.
// console.log and console.error are captured into the returned lines.
async function withSandbox(setup, fn) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-context-sync-'));
  const home = path.join(sandbox, 'home');
  const work = path.join(sandbox, 'work');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(work, { recursive: true });

  const saved = {
    home: process.env.HOME,
    cwd: process.cwd(),
    argv: process.argv,
    exit: process.exit,
    log: console.log,
    error: console.error,
    env: Object.fromEntries(AUTH_ENV.map((k) => [k, process.env[k]])),
  };
  const out = { logs: [], errors: [] };

  try {
    for (const k of AUTH_ENV) delete process.env[k];
    process.env.HOME = home;
    process.chdir(work);
    if (setup) setup({ home, work });

    process.exit = (code) => {
      const err = new Error(`process.exit(${code})`);
      err.exitCode = code;
      throw err;
    };
    console.log = (...args) => out.logs.push(args.join(' '));
    console.error = (...args) => out.errors.push(args.join(' '));

    await fn({ home, work, out });
  } finally {
    process.exit = saved.exit;
    console.log = saved.log;
    console.error = saved.error;
    process.argv = saved.argv;
    process.chdir(saved.cwd);
    process.env.HOME = saved.home;
    for (const k of AUTH_ENV) {
      if (saved.env[k] === undefined) delete process.env[k];
      else process.env[k] = saved.env[k];
    }
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

// Writes a credentials file the auth loader accepts. The token is not a JWT,
// so the loader returns it as-is and no network call is made.
function writeLogin(home) {
  const dir = path.join(home, '.atris');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'credentials.json'),
    JSON.stringify({ token: 'sandbox-token', provider: null, email: 'test@example.com' })
  );
}

// Registers a business in the same config file the command reads.
function writeBusiness(home, slug, name) {
  const dir = path.join(home, '.atris');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'businesses.json'),
    JSON.stringify({
      [slug]: { business_id: 'biz-1', workspace_id: 'ws-1', name, slug },
    })
  );
}

test('businessStatus exits 1 with a login hint when there are no credentials', async () => {
  await withSandbox(null, async ({ out }) => {
    await assert.rejects(businessStatus('acme'), (err) => err.exitCode === 1);
    assert.deepStrictEqual(out.errors, ['Not logged in. Run: atris login']);
    assert.deepStrictEqual(out.logs, []);
  });
});

test('businessDiff exits 1 and says how to pull when no local copy exists', async () => {
  await withSandbox(
    ({ home }) => {
      writeLogin(home);
      writeBusiness(home, 'acme', 'Acme Co');
    },
    async ({ out }) => {
      await assert.rejects(businessDiff('acme'), (err) => err.exitCode === 1);
      assert.deepStrictEqual(out.errors, ['No local copy found. Run: atris pull acme']);
      assert.deepStrictEqual(out.logs, []);
    }
  );
});

test('businessDiff reports no changes when local files match the last sync', async () => {
  await withSandbox(
    ({ home, work }) => {
      writeLogin(home);
      writeBusiness(home, 'acme', 'Acme Co');
      const localDir = path.join(work, 'acme');
      fs.mkdirSync(path.join(localDir, 'notes'), { recursive: true });
      fs.writeFileSync(path.join(localDir, 'readme.md'), '# acme\n');
      fs.writeFileSync(path.join(localDir, 'notes', 'plan.md'), 'ship it\n');
      saveManifest('acme', {
        last_sync: new Date().toISOString(),
        files: computeLocalHashes(localDir),
      });
    },
    async ({ out }) => {
      await businessDiff('acme');
      assert.deepStrictEqual(out.errors, []);
      assert.deepStrictEqual(out.logs, ['\n  No local changes.\n']);
    }
  );
});

test('businessDiff lists modified and new files, and honors a path filter argument', async () => {
  await withSandbox(
    ({ home, work }) => {
      writeLogin(home);
      writeBusiness(home, 'acme', 'Acme Co');
      const localDir = path.join(work, 'acme');
      fs.mkdirSync(path.join(localDir, 'notes'), { recursive: true });
      fs.writeFileSync(path.join(localDir, 'readme.md'), '# acme\n');
      fs.writeFileSync(path.join(localDir, 'notes', 'plan.md'), 'draft one\n');
      saveManifest('acme', {
        last_sync: new Date().toISOString(),
        files: computeLocalHashes(localDir),
      });
      // Edit one synced file and add one brand-new file after the sync.
      fs.writeFileSync(path.join(localDir, 'notes', 'plan.md'), 'draft one\ndraft two\n');
      fs.writeFileSync(path.join(localDir, 'notes', 'fresh.md'), 'a\nb\n');
    },
    async ({ out }) => {
      // No path argument: both changed files are listed.
      // Directory order is not guaranteed, so check the blocks, not the sequence.
      process.argv = ['node', 'atris', 'diff', 'acme'];
      await businessDiff('acme');
      const body = out.logs.join('\n');
      assert.ok(body.startsWith('\n  2 files changed locally:\n'), body);
      assert.ok(
        body.includes('  ~ notes/plan.md  (modified)\n    | draft one\n    | draft two\n'),
        body
      );
      assert.ok(body.includes('  + notes/fresh.md  (new file, 2 lines)\n'), body);

      // A path argument narrows the list to that prefix.
      out.logs.length = 0;
      process.argv = ['node', 'atris', 'diff', 'acme', 'readme'];
      await businessDiff('acme');
      assert.deepStrictEqual(out.logs, ['\n  No local changes.\n']);

      // A flag in the path slot is not treated as a path filter.
      out.logs.length = 0;
      process.argv = ['node', 'atris', 'diff', 'acme', '--verbose'];
      await businessDiff('acme');
      assert.match(out.logs[0], /^\n {2}2 files changed locally:\n$/);
    }
  );
});
