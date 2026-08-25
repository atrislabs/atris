'use strict';

// Workspace business binding behavior: how .atris/business.json is written,
// read, and surfaced by the business command. Covers the offline paths plus
// `init --here` against a local stand-in for the cloud API (ATRIS_API_URL seam).
// Every CLI spawn runs from a temp cwd with a temp HOME (repo-hygiene ratchet).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

const {
  createCanonicalBusinessWorkspace,
  collectBusinessShareState,
  renderBusinessCreatedNextSteps,
} = require('../commands/business');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runCli(args, { cwd, env } = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ...(env || {}),
    },
  });
}

// Async spawn for tests that also run an in-process HTTP stub: spawnSync would
// block this event loop, so the stub could never answer and the CLI would hang.
function runCliAsync(args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ATRIS_SKIP_UPDATE_CHECK: '1',
        ...(env || {}),
      },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`CLI timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 20000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

function seedBinding(cwd, overrides = {}) {
  const atrisDir = path.join(cwd, '.atris');
  fs.mkdirSync(atrisDir, { recursive: true });
  const meta = {
    business_id: 'local-only',
    workspace_id: 'local-only',
    name: 'Acme Co',
    slug: 'acme-co',
    workspace_template: 'business',
    created_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
  fs.writeFileSync(path.join(atrisDir, 'business.json'), JSON.stringify(meta, null, 2));
  return meta;
}

function writeCredentials(home) {
  const atrisDir = path.join(home, '.atris');
  fs.mkdirSync(atrisDir, { recursive: true });
  fs.writeFileSync(path.join(atrisDir, 'credentials.json'), JSON.stringify({
    token: 'test-token',
    provider: 'test',
    saved_at: new Date().toISOString(),
  }));
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(line => line.trim())
    .map(line => JSON.parse(line));
}

test('createCanonicalBusinessWorkspace writes the binding and refuses to double-bind', () => {
  const root = makeTempDir('atris-biz-bind-');
  try {
    const bizMeta = {
      business_id: 'biz-9',
      workspace_id: 'ws-9',
      name: 'Acme Co',
      slug: 'acme-co',
      owner_email: 'owner@example.com',
    };
    const result = createCanonicalBusinessWorkspace(root, bizMeta, { here: true });

    assert.equal(result.targetRoot, root);
    assert.equal(result.workspaceTemplate, 'business');
    const binding = JSON.parse(fs.readFileSync(result.businessJsonPath, 'utf8'));
    assert.equal(binding.business_id, 'biz-9');
    assert.equal(binding.workspace_id, 'ws-9');
    assert.equal(binding.slug, 'acme-co');
    assert.equal(binding.owner_email, 'owner@example.com');
    assert.equal(binding.workspace_template, 'business');
    assert.ok(binding.created_at, 'binding records when it was created');

    // The scaffold lands alongside the binding.
    assert.ok(fs.existsSync(path.join(root, 'atris', 'MAP.md')), 'seeds atris/MAP.md');
    assert.ok(fs.existsSync(path.join(root, 'atris', 'TODO.md')), 'seeds atris/TODO.md');

    // A second bind of the same directory is refused with a plain sentence.
    assert.throws(
      () => createCanonicalBusinessWorkspace(root, bizMeta, { here: true }),
      /already contains \.atris\/business\.json/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('collectBusinessShareState explains a missing or corrupt binding in one sentence', () => {
  const empty = makeTempDir('atris-biz-nobind-');
  const corrupt = makeTempDir('atris-biz-corrupt-');
  try {
    assert.throws(
      () => collectBusinessShareState(empty),
      /Run this command inside a business environment with \.atris\/business\.json\./,
    );

    fs.mkdirSync(path.join(corrupt, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(corrupt, '.atris', 'business.json'), '{ not json');
    assert.throws(
      () => collectBusinessShareState(corrupt),
      /Failed to read \.atris\/business\.json/,
    );
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
    fs.rmSync(corrupt, { recursive: true, force: true });
  }
});

test('collectBusinessShareState reads the binding back and marks local-only workspaces unready', () => {
  const cwd = makeTempDir('atris-biz-state-');
  try {
    const meta = seedBinding(cwd);
    const state = collectBusinessShareState(cwd);

    assert.equal(state.bizMeta.name, meta.name);
    assert.equal(state.bizMeta.slug, meta.slug);
    assert.equal(state.remoteReady, false, 'local-only ids mean no remote pull');
    assert.equal(state.ready, false);
    assert.ok(state.missing.includes('canonical Atris scaffold'));
    assert.ok(state.missing.includes('first proof recap'));
    assert.deepEqual(state.proof, { events: 0, episodes: 0, scorecards: 0 });

    // Cloud-shaped ids flip remoteReady without touching the network.
    const cloud = makeTempDir('atris-biz-cloud-');
    try {
      seedBinding(cloud, { business_id: 'biz-1', workspace_id: 'ws-1' });
      assert.equal(collectBusinessShareState(cloud).remoteReady, true);
    } finally {
      fs.rmSync(cloud, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('renderBusinessCreatedNextSteps points at the workspace and quotes the mission title', () => {
  const text = renderBusinessCreatedNextSteps({ name: 'Acme "Co"', slug: 'acme-co' }, '/tmp/acme-co');
  assert.match(text, /cd \/tmp\/acme-co/);
  assert.match(text, /atris business start/);
  assert.match(text, /atris mission start "Run the first useful loop for Acme \\"Co\\""/);
  assert.match(text, /atris business record atris\/reports\/<recap>\.md/);
});

test('business record outside a workspace fails with a plain sentence, not a stack', () => {
  const home = makeTempDir('atris-biz-home-');
  const cwd = makeTempDir('atris-biz-work-');
  try {
    fs.writeFileSync(path.join(cwd, 'recap.md'), '# Recap\n');
    const result = runCli(['business', 'record', 'recap.md', '--account'], { cwd, env: { HOME: home } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Run this command inside a business environment with \.atris\/business\.json\./);
    assert.ok(!/\n\s+at /.test(result.stderr), `stack trace leaked to the operator:\n${result.stderr}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('business record with a corrupt binding fails plainly and names the file', () => {
  const home = makeTempDir('atris-biz-home-');
  const cwd = makeTempDir('atris-biz-work-');
  try {
    fs.mkdirSync(path.join(cwd, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.atris', 'business.json'), '{ broken');
    fs.writeFileSync(path.join(cwd, 'recap.md'), '# Recap\n');
    const result = runCli(['business', 'record', 'recap.md', '--account'], { cwd, env: { HOME: home } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Failed to read \.atris\/business\.json/);
    assert.ok(!/\n\s+at /.test(result.stderr), `stack trace leaked to the operator:\n${result.stderr}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('business record appends proof rows carrying the binding through the flag parser', () => {
  const home = makeTempDir('atris-biz-home-');
  const cwd = makeTempDir('atris-biz-work-');
  try {
    seedBinding(cwd);
    fs.mkdirSync(path.join(cwd, 'atris', 'reports'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'atris', 'reports', 'week-1.md'), '# First week recap\n\nShipped.\n');

    const first = runCli([
      'business', 'record', 'atris/reports/week-1.md',
      '--outcome', 'positive', '--metric', 'operator speed',
    ], { cwd, env: { HOME: home } });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.match(first.stdout, /Recorded recap for Acme Co\./);
    assert.match(first.stdout, /Outcome: positive/);
    assert.match(first.stdout, /Reward:  5/);
    assert.match(first.stdout, /Metric:  operator speed/);

    const stateDir = path.join(cwd, '.atris', 'state');
    for (const file of ['events.jsonl', 'episodes.jsonl', 'scorecards.jsonl']) {
      const rows = readJsonl(path.join(stateDir, file));
      assert.equal(rows.length, 1, `${file} has one row`);
      assert.equal(rows[0].business_slug, 'acme-co');
      assert.equal(rows[0].report_path, 'atris/reports/week-1.md');
      assert.equal(rows[0].report_title, 'First week recap');
      assert.equal(rows[0].outcome, 'positive');
      assert.equal(rows[0].reward, 5);
      assert.equal(rows[0].metric, 'operator speed');
    }

    // An explicit reward overrides the outcome default (-3 for negative).
    const second = runCli([
      'business', 'record', 'atris/reports/week-1.md',
      '--outcome', 'negative', '--reward', '2',
    ], { cwd, env: { HOME: home } });
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const scorecards = readJsonl(path.join(stateDir, 'scorecards.jsonl'));
    assert.equal(scorecards.length, 2);
    assert.equal(scorecards[1].outcome, 'negative');
    assert.equal(scorecards[1].reward, 2);

    // A missing report is a plain refusal.
    const missing = runCli(['business', 'record', 'nope.md'], { cwd, env: { HOME: home } });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Report not found: nope\.md/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('business start renders the collaborator card from a seeded binding', () => {
  const home = makeTempDir('atris-biz-home-');
  const cwd = makeTempDir('atris-biz-work-');
  try {
    seedBinding(cwd);
    const result = runCli(['business', 'start', '--account'], { cwd, env: { HOME: home } });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Acme Co collaborator start/);
    assert.match(result.stdout, /Business: Acme Co \(acme-co\)/);
    assert.match(result.stdout, /Ready: no/);
    assert.match(result.stdout, /Remote pull: local-only/);
    assert.match(result.stdout, /local-only: share the folder directly/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('business list reads the home cache and says so when it is empty', () => {
  const home = makeTempDir('atris-biz-home-');
  const cwd = makeTempDir('atris-biz-work-');
  try {
    const empty = runCli(['business', 'list', '--account'], { cwd, env: { HOME: home } });
    assert.equal(empty.status, 0, empty.stderr || empty.stdout);
    assert.match(empty.stdout, /No businesses connected\. Run: atris business add <slug>/);

    fs.mkdirSync(path.join(home, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(home, '.atris', 'businesses.json'), JSON.stringify({
      'acme-co': { business_id: 'biz-1', name: 'Acme Co', slug: 'acme-co', added_at: '2026-08-01' },
    }));
    const listed = runCli(['business', 'list', '--account'], { cwd, env: { HOME: home } });
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    assert.match(listed.stdout, /Acme Co \(acme-co\)/);
    assert.match(listed.stdout, /ID: biz-1/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('business fleet --json classifies workspaces by their bindings, offline', () => {
  const home = makeTempDir('atris-biz-home-');
  const cwd = makeTempDir('atris-biz-work-');
  try {
    const fleetRoot = path.join(home, 'arena', 'atris-business');

    const ready = path.join(fleetRoot, 'ready-co');
    seedBinding(ready, { name: 'Ready Co', slug: 'ready-co' });
    fs.mkdirSync(path.join(ready, 'atris'), { recursive: true });

    const unbound = path.join(fleetRoot, 'unbound-co');
    fs.mkdirSync(path.join(unbound, 'atris'), { recursive: true });

    const result = runCli(['business', 'fleet', '--json', '--account'], { cwd, env: { HOME: home } });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.root, fleetRoot);
    const byName = Object.fromEntries(parsed.customers.map(c => [c.name, c]));
    assert.equal(byName['ready-co'].state, 'ready');
    assert.equal(byName['ready-co'].bizName, 'Ready Co');
    assert.equal(byName['unbound-co'].state, 'unbound');
    assert.equal(byName['unbound-co'].action, 'create .atris/business.json');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('business init --here creates the business and binds the current directory', async () => {
  const home = makeTempDir('atris-biz-home-');
  const cwd = makeTempDir('atris-biz-work-');
  writeCredentials(home);

  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method, url: req.url, body: rawBody ? JSON.parse(rawBody) : null });
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && req.url.startsWith('/api/business/by-slug/')) {
        res.statusCode = 404;
        res.end(JSON.stringify({ detail: 'not found' }));
      } else if (req.method === 'GET' && req.url === '/api/business/') {
        res.end(JSON.stringify([]));
      } else if (req.method === 'POST' && req.url === '/api/business/') {
        res.end(JSON.stringify({
          id: 'biz-42', workspace_id: 'ws-42', name: 'Acme Co', slug: 'acme-co', agent_id: 'agent-42',
        }));
      } else {
        res.statusCode = 500;
        res.end(JSON.stringify({ detail: `unexpected ${req.method} ${req.url}` }));
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  try {
    const env = {
      HOME: home,
      ATRIS_API_URL: `http://127.0.0.1:${server.address().port}/api`,
    };
    const result = await runCliAsync(['business', 'init', 'Acme Co', '--here', '--account'], { cwd, env });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Business created!/);
    assert.match(result.stdout, /Slug:\s+acme-co/);
    assert.match(result.stdout, /atris business start/);

    const create = requests.find(r => r.method === 'POST');
    assert.deepEqual(create.body, { name: 'Acme Co' });

    // The current directory got the binding, not a nested slug folder.
    const binding = JSON.parse(fs.readFileSync(path.join(cwd, '.atris', 'business.json'), 'utf8'));
    assert.equal(binding.business_id, 'biz-42');
    assert.equal(binding.workspace_id, 'ws-42');
    assert.equal(binding.slug, 'acme-co');
    assert.ok(fs.existsSync(path.join(cwd, 'atris', 'MAP.md')), 'scaffold lands in the bound directory');

    // The home cache learned about the new business.
    const cache = JSON.parse(fs.readFileSync(path.join(home, '.atris', 'businesses.json'), 'utf8'));
    assert.equal(cache['acme-co'].business_id, 'biz-42');

    // A repeat init of the same slug is refused before hitting the create endpoint.
    const dupe = await runCliAsync(['business', 'init', 'Acme Co', '--here', '--account'], { cwd, env });
    assert.equal(dupe.status, 1);
    assert.match(dupe.stderr, /A business with slug "acme-co" already exists\./);
    assert.match(dupe.stderr, /atris pull acme-co/);
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('an unknown business subcommand fails with help, not silence', () => {
  const home = makeTempDir('atris-biz-home-');
  const cwd = makeTempDir('atris-biz-work-');
  try {
    const result = runCli(['business', 'frobnicate'], { cwd, env: { HOME: home } });
    assert.match(result.stderr, /account-global/);
    assert.match(result.stderr, /pass --account/);
    assert.equal(result.status, 2, 'an unbound business verb is a failure, not a success');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
