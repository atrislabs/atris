const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const api = require('../utils/api');

let apiHandler = async () => ({
  ok: true,
  data: [{ id: 'b1', workspace_id: 'w1', name: 'Test Co', slug: 'test-co' }],
});

const origApiRequestJson = api.apiRequestJson;
api.apiRequestJson = (...args) => apiHandler(...args);

const { pushAtris } = require('../commands/push');

api.apiRequestJson = origApiRequestJson;

test('safety advice omits sync artifacts flag when change has no review artifacts', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'safety-gate-'));
  const homeDir = path.join(root, 'home');
  const workspaceDir = path.join(root, 'workspace');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });

  const atrisHome = path.join(homeDir, '.atris');
  fs.mkdirSync(atrisHome, { recursive: true });
  fs.writeFileSync(
    path.join(atrisHome, 'credentials.json'),
    JSON.stringify({ token: 'test-token' })
  );
  fs.writeFileSync(
    path.join(atrisHome, 'businesses.json'),
    JSON.stringify({
      'test-co': {
        business_id: 'b1',
        workspace_id: 'w1',
        name: 'Test Co',
        slug: 'test-co',
      },
    })
  );

  const atrisWorkspace = path.join(workspaceDir, '.atris');
  fs.mkdirSync(atrisWorkspace, { recursive: true });
  fs.writeFileSync(
    path.join(atrisWorkspace, 'business.json'),
    JSON.stringify({ slug: 'test-co', name: 'Test Co' })
  );

  for (let i = 0; i < 5; i++) {
    fs.writeFileSync(path.join(workspaceDir, `file${i}.txt`), `content-${i}`);
  }

  const prevEnv = { ...process.env };
  const prevArgv = process.argv;
  const prevCwd = process.cwd();

  let output = '';
  t.mock.method(process.stdout, 'write', (chunk) => {
    output += chunk;
    return true;
  });

  apiHandler = async (pathname) => {
    if (pathname === '/business/') {
      return {
        ok: true,
        data: [{ id: 'b1', workspace_id: 'w1', name: 'Test Co', slug: 'test-co' }],
      };
    }
    return { ok: true, data: {} };
  };

  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = homeDir;
    process.chdir(workspaceDir);
    process.argv = [process.execPath, 'atris', 'push', 'test-co', '--force', '--dry-run'];

    await pushAtris();

    assert.ok(output.includes('--allow-broad-workspace'));
    assert.equal(output.includes('--allow-sync-artifacts'), false);
  } finally {
    apiHandler = origApiRequestJson;
    process.chdir(prevCwd);
    process.argv = prevArgv;
    for (const key of Object.keys(process.env)) {
      if (key !== 'HOME' && !(key in prevEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, val] of Object.entries(prevEnv)) {
      if (key !== 'HOME') {
        process.env[key] = val;
      }
    }
    if (prevEnv.HOME) {
      process.env.HOME = prevEnv.HOME;
    } else {
      process.env.HOME = os.tmpdir();
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
