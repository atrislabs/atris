'use strict';

// Several places, one review: parsing, path prefixes, the one-folder review
// staying the same, safe clones (stubbed, no network) and cleanup.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const audit = require('../lib/security-audit');
const places = require('../lib/sentinel-places');
const { auditCommand, parseAuditArgs } = require('../commands/security-review');

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };

function git(cwd, args) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
}

function makeRepo(dir, files, { untracked = {} } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  git(dir, ['init', '-q']);
  git(dir, ['add', '.']);
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  for (const [rel, body] of Object.entries(untracked)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return fs.realpathSync(dir);
}

function tmp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

const SHELL = "const { execSync } = require('child_process');\nfunction run(t) {\n  return execSync(`echo ${t}`);\n}\nmodule.exports = { run };\n";
const SENDER = "async function forward(msg) {\n  return fetch('/api/webhooks/email', { method: 'POST', body: JSON.stringify(msg) });\n}\nmodule.exports = { forward };\n";
const RECEIVER = "const { execSync } = require('child_process');\nfunction mount(router) {\n  router.post('/webhooks/email', (req) => execSync(`mail ${req.body.to}`));\n}\nmodule.exports = { mount };\n";

// A parent folder holding web (git), api (git) and mobile (plain folder).
function makeCompany() {
  const parent = tmp('sentinel-company-');
  const web = makeRepo(path.join(parent, 'web'), { 'src/index.js': SHELL, 'src/mail.js': SENDER });
  const api = makeRepo(path.join(parent, 'api'), { 'src/index.js': SHELL, 'routes/hooks.js': RECEIVER, 'config/.env.production': 'TOKEN=abc\n' }, { untracked: { '.env': 'SECRET=never-copied\n', 'src/scratch.js': SHELL } });
  const mobile = path.join(parent, 'mobile');
  fs.mkdirSync(path.join(mobile, 'src'), { recursive: true });
  fs.writeFileSync(path.join(mobile, 'src', 'index.js'), SHELL);
  return { parent, web, api, mobile: fs.realpathSync(mobile) };
}

function withHome(fn) {
  const home = tmp('sentinel-home-');
  const prev = process.env.ATRIS_SECURITY_AUDIT_HOME;
  process.env.ATRIS_SECURITY_AUDIT_HOME = home;
  const out = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => out.push(a.join(' '));
  return Promise.resolve().then(() => fn(home, out)).finally(() => {
    console.log = origLog;
    console.error = origErr;
    if (prev === undefined) delete process.env.ATRIS_SECURITY_AUDIT_HOME;
    else process.env.ATRIS_SECURITY_AUDIT_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  });
}

const LOCAL = ['--hunter', 'codex', '--verifier', 'claude', '--no-upload'];

// Run history lives in <label>-<hash of the project's identity>.
function historyDir(home, label) {
  const name = fs.readdirSync(home).find((n) => n.startsWith(`${label}-`) && /-[0-9a-f]{12}$/.test(n));
  assert.ok(name, `a history folder for ${label}`);
  return path.join(home, name);
}

// Engines that read every area they are given and find nothing.
async function readsAllCleanJobs(jobs) {
  return jobs.map((job) => {
    if (job.prompt.includes('security hunter')) {
      const ids = [...job.prompt.matchAll(/coverage_id: (\S+)/g)].map((m) => m[1]);
      const paths = [...job.prompt.matchAll(/starting paths: ([^,\s]+)/g)].map((m) => m[1]);
      return { ok: true, stdout: JSON.stringify({ units: ids.map((id, i) => ({ coverage_id: id, disposition: 'covered', reviewed_paths: [paths[i] || paths[0]], checks: [{ invariant: 'input never becomes shell text', method: 'source', result: 'read it', reviewed_paths: [paths[i] || paths[0]] }], candidate_fingerprints: [], unresolved: [] })), candidates: [], hardening: [], uncovered: [] }) };
    }
    if (job.prompt.includes('coverage critic')) return { ok: true, stdout: JSON.stringify({ missing_units: [], reassign_ids: [], stop: true }) };
    return { ok: true, stdout: '{"ok": true}' };
  });
}

// A review that gets past planning first checks that codex and claude are
// installed and signed in. Stand-ins on PATH, marked signed in, so the test
// does not depend on the tools being on this computer.
function enginesReady() {
  const bin = tmp('sentinel-places-bin-');
  for (const n of ['codex', 'claude']) {
    fs.writeFileSync(path.join(bin, n), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(bin, n), 0o755);
  }
  return { env: { ...process.env, PATH: bin + path.delimiter + (process.env.PATH || '') }, signedIn: () => true, bin };
}

// ---------------------------------------------------------------- words

test('git URLs on any host are places; file, ext and option-looking URLs are not', () => {
  for (const url of [
    'https://github.com/acme/api.git',
    'https://gitlab.example.com:8443/group/sub/web',
    'ssh://git@bitbucket.org/acme/mobile.git',
    'git@github.com:acme/api.git',
    'git@git.internal.acme.co:platform/server.git',
    'https://user:token@git.acme.co/acme/api.git',
  ]) assert.ok(places.isGitUrl(url), url);
  for (const bad of ['file:///tmp/x', 'ext::sh -c touch% /tmp/pwned', 'ssh://-oProxyCommand=touch/x', '--upload-pack=touch', 'src/index.js', '../web', 'https://github.com', '']) {
    assert.ok(!places.isGitUrl(bad), bad);
  }
  assert.strictEqual(places.safeUrl('https://user:token@git.acme.co/acme/api.git'), 'https://git.acme.co/acme/api.git');
  assert.strictEqual(places.nameFromUrl('git@github.com:acme/api.git'), 'api');
  assert.strictEqual(places.nameFromUrl('https://gitlab.example.com/group/web/'), 'web');
});

test('several places parse: folders next door, own repos, URLs and --with; other words stay scope paths', () => {
  const c = makeCompany();
  try {
    const r = places.resolvePlaces(c.api, ['../web', 'src', '../mobile', 'git@github.com:acme/pay.git'], ['https://gitlab.example.com/acme/admin.git']);
    assert.strictEqual(r.multi, true);
    assert.deepStrictEqual(r.places.map((p) => p.kind === 'url' ? p.url : path.basename(p.path)), ['api', 'https://gitlab.example.com/acme/admin.git', 'web', 'mobile', 'git@github.com:acme/pay.git']);
    assert.strictEqual(r.places[0].home, true, 'the current repo joins first');
    assert.deepStrictEqual(r.scope, ['src']);
    // The same place twice is one part, and naming the current folder is fine.
    const twice = places.resolvePlaces(c.api, ['../web', '../web/', '.'], []);
    assert.strictEqual(twice.places.length, 2);
    // From a plain parent folder, only the places named.
    const parent = places.resolvePlaces(c.parent, ['web', 'api'], []);
    assert.deepStrictEqual(parent.places.map((p) => path.basename(p.path)), ['web', 'api']);
    assert.ok(!parent.places.some((p) => p.home));
    // One folder alone is the old one-folder review.
    const one = places.resolvePlaces(c.api, ['src', 'routes/hooks.js'], []);
    assert.strictEqual(one.multi, false);
    assert.deepStrictEqual(one.scope, ['src', 'routes/hooks.js']);
    assert.throws(() => places.resolvePlaces(c.api, [], ['../nope']), /not a folder or a git URL/);
    assert.throws(() => places.resolvePlaces(c.api, ['file:///etc'], []), /not a place sentinel can review/);
  } finally { fs.rmSync(c.parent, { recursive: true, force: true }); }
});

test('the audit flags take several --with places, --ref and --keep-clones', () => {
  const o = parseAuditArgs(['../web', '--with', 'git@github.com:acme/api.git', '--with=../mobile', '--ref', 'main', '--keep-clones', '--plan']);
  assert.deepStrictEqual(o.with, ['git@github.com:acme/api.git', '../mobile']);
  assert.deepStrictEqual(o.scope, ['../web']);
  assert.strictEqual(o.ref, 'main');
  assert.strictEqual(o.keepClones, true);
  assert.throws(() => parseAuditArgs(['--with']), /needs a value/);
});

test('part names never collide and never read as a skipped or test folder', () => {
  const taken = new Set();
  assert.strictEqual(places.partName('app', taken, audit.reservedPartName), 'app');
  assert.strictEqual(places.partName('app', taken, audit.reservedPartName), 'app-2');
  assert.strictEqual(places.partName('test', taken, audit.reservedPartName), 'test-app');
  assert.strictEqual(places.partName('vendor', taken, audit.reservedPartName), 'vendor-app');
  assert.strictEqual(places.partName('../../x', taken, audit.reservedPartName), 'x');
});

// ---------------------------------------------------------------- one system

test('two parts that both have src/index.js map to separate, prefixed areas', () => {
  const c = makeCompany();
  const sys = places.buildSystem(places.resolvePlaces(c.api, ['../web', '../mobile'], []));
  try {
    assert.strictEqual(sys.multi, true);
    assert.deepStrictEqual(sys.parts.map((p) => p.name), ['api', 'web', 'mobile']);
    const { units } = audit.mapTarget(sys.root, { profile: 'standard' });
    const surfaces = units.map((u) => u.surface);
    for (const p of ['api/src/index.js', 'web/src/index.js', 'mobile/src/index.js', 'api/routes/hooks.js']) assert.ok(surfaces.includes(p), `${p} in ${surfaces.join(', ')}`);
    assert.strictEqual(new Set(units.map((u) => u.coverage_id)).size, units.length, 'every area has its own id');
    assert.deepStrictEqual(audit.validateLedger(units), []);
    assert.ok(units.every((u) => u.starting_paths.every((p) => /^(api|web|mobile)\//.test(p))));
    const sub = Object.fromEntries(units.map((u) => [u.surface, u.subsystem]));
    assert.strictEqual(sub['api/src/index.js'], 'api/src');
    assert.strictEqual(sub['web/src/index.js'], 'web/src');
    // Only tracked files were copied: the untracked .env and scratch file stayed home.
    assert.ok(!fs.existsSync(path.join(sys.root, 'api', '.env')));
    assert.ok(!fs.existsSync(path.join(sys.root, 'api', 'src', 'scratch.js')));
    assert.ok(!surfaces.includes('api/src/scratch.js'));
    // The plain folder had no git, so its files were walked as before.
    assert.ok(fs.existsSync(path.join(sys.root, 'mobile', 'src', 'index.js')));
  } finally {
    const root = sys.root;
    sys.cleanup();
    assert.ok(!fs.existsSync(root), 'the review copy is gone');
    assert.strictEqual(audit.systemOf(root), null);
    fs.rmSync(c.parent, { recursive: true, force: true });
  }
});

test('a hosted engine may see only each part\'s tracked, non-secret files', () => {
  const c = makeCompany();
  const sys = places.buildSystem(places.resolvePlaces(c.api, ['../web', '../mobile'], []));
  try {
    const allowed = audit.hostedAllowedFiles(sys.root, []);
    assert.ok(allowed.has('api/src/index.js'));
    assert.ok(allowed.has('web/src/mail.js'));
    assert.ok(!allowed.has('api/config/.env.production'), 'a tracked env file is never sent');
    assert.ok(![...allowed].some((f) => f.startsWith('mobile/')), 'a folder without git sends nothing, as in a one-folder review');
    assert.ok(![...allowed].some((f) => f.endsWith('scratch.js') || f.endsWith('/.env')));
    assert.deepStrictEqual([...audit.hostedAllowedFiles(sys.root, ['web'])].sort(), ['web/src/index.js', 'web/src/mail.js']);
  } finally { sys.cleanup(); fs.rmSync(c.parent, { recursive: true, force: true }); }
});

test('hosted hunters are told it is one system, see the shared route, and secret lines are hidden at the send point', async () => {
  const c = makeCompany();
  const key = `${'ghp_'}a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8`;
  fs.appendFileSync(path.join(c.web, 'src', 'mail.js'), `const token = "${key}";\n`);
  git(c.web, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'key']);
  const sys = places.buildSystem(places.resolvePlaces(c.api, ['../web'], []));
  try {
    assert.ok(sys.seams.some((s) => s.route === '/api/webhooks/email' && s.places.some((p) => p.startsWith('web/src/mail.js')) && s.places.some((p) => p.startsWith('api/routes/hooks.js'))), JSON.stringify(sys.seams));
    await withHome(async () => {
      const prompts = [];
      const runJobs = async (jobs) => { for (const j of jobs) prompts.push(j.prompt); return jobs.map(() => ({ text: '{}' })); };
      const res = await audit.runAudit({ root: sys.root, profile: 'quick', budget: 8, hunter: 'atris:fast', verifier: 'atris:pro', runJobs });
      const hunter = prompts.find((p) => p.includes('You are a security hunter'));
      assert.ok(hunter, 'a hunter ran');
      assert.match(hunter, /## One system in 2 parts/);
      assert.match(hunter, /\/api\/webhooks\/email: /);
      const { redactOutgoing } = require('../lib/sentinel-cloud');
      for (const p of prompts) assert.ok(!redactOutgoing(p).text.includes(key), 'no secret survives the send point');
      assert.ok(!prompts.some((p) => p.includes('never-copied')));
      assert.deepStrictEqual(res.meta.parts.map((p) => p.name), ['api', 'web']);
    });
  } finally { sys.cleanup(); fs.rmSync(c.parent, { recursive: true, force: true }); }
});

test('the plan shows the parts and one shared budget; the report and saved results list each part with its commit', async () => {
  const c = makeCompany();
  try {
    await withHome(async (home, out) => {
      const code = await auditCommand(['../web', '../mobile', '--plan', '--budget', '20', ...LOCAL], { root: c.api, token: null });
      assert.strictEqual(code, 0, out.join('\n'));
      const text = out.join('\n');
      assert.match(text, /one system in 3 parts/);
      assert.match(text, /up to 20 AI tool calls in total, shared by all 3 places/);
      assert.match(text, /parts per place: api \d+, web \d+, mobile \d+/);
      const runDir = path.join(historyDir(home, 'api+mobile+web'), 'run-1');
      const meta = JSON.parse(fs.readFileSync(path.join(runDir, 'run-metadata.json'), 'utf8'));
      assert.strictEqual(meta.budget, 20, 'never multiplied by the number of parts');
      assert.deepStrictEqual(meta.parts.map((p) => [p.name, p.source]), [['api', 'folder'], ['web', 'folder'], ['mobile', 'folder']]);
      assert.match(meta.parts[0].commit, /^[0-9a-f]{40}$/);
      assert.strictEqual(meta.parts[2].commit, null);
      const report = fs.readFileSync(path.join(runDir, 'REPORT.md'), 'utf8');
      assert.match(report, /## Parts/);
      assert.match(report, /- web: .*web, commit [0-9a-f]{40}/);
      assert.match(report, /shared by all 3 parts/);
      // The temporary review copy is gone.
      assert.ok(!fs.existsSync(meta.target));
    });
  } finally { fs.rmSync(c.parent, { recursive: true, force: true }); }
});

test('one folder alone stays exactly the one-folder review', async () => {
  const c = makeCompany();
  try {
    await withHome(async (home) => {
      const viaCommand = path.join(home, 'a');
      const direct = path.join(home, 'b');
      assert.strictEqual(await auditCommand(['src', '--plan', '--out', viaCommand, ...LOCAL], { root: c.api, token: null }), 0);
      await audit.runAudit({ root: c.api, scope: ['src'], planOnly: true, out: direct, hunter: 'codex', verifier: 'claude' });
      for (const f of ['coverage-ledger.json', 'architecture.md', 'REPORT.md', 'findings.json']) {
        assert.strictEqual(fs.readFileSync(path.join(viaCommand, f), 'utf8'), fs.readFileSync(path.join(direct, f), 'utf8'), f);
      }
      const meta = JSON.parse(fs.readFileSync(path.join(viaCommand, 'run-metadata.json'), 'utf8'));
      assert.ok(!('parts' in meta));
      assert.strictEqual(meta.target, c.api);
      assert.doesNotMatch(fs.readFileSync(path.join(viaCommand, 'architecture.md'), 'utf8'), /One system/);
    });
  } finally { fs.rmSync(c.parent, { recursive: true, force: true }); }
});

test('scope paths in a system start with a part; bare ones belong to the current folder', async () => {
  const c = makeCompany();
  try {
    await withHome(async (home, out) => {
      assert.strictEqual(await auditCommand(['../web', 'routes', 'web/src', '--plan', '--out', path.join(home, 'r'), ...LOCAL], { root: c.api, token: null }), 0, out.join('\n'));
      const meta = JSON.parse(fs.readFileSync(path.join(home, 'r', 'run-metadata.json'), 'utf8'));
      assert.deepStrictEqual(meta.scope_paths, ['api/routes', 'web/src']);
      assert.strictEqual(await auditCommand(['web', 'api', 'src', '--plan', ...LOCAL], { root: c.parent, token: null }), 2);
      assert.match(out.join('\n'), /start src with the name of its part/);
    });
  } finally { fs.rmSync(c.parent, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- clones

function stubSpawn(calls, { fail = null, files = { 'server/app.js': RECEIVER } } = {}) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (args.includes('clone')) {
      if (fail) return { status: 128, stdout: '', stderr: fail };
      const dest = args[args.length - 1];
      for (const [rel, body] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
        fs.writeFileSync(path.join(dest, rel), body);
      }
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args.includes('rev-parse')) return { status: 0, stdout: 'abcdef1234567890abcdef1234567890abcdef12\n', stderr: '' };
    return { status: 1, stdout: '', stderr: 'unexpected' };
  };
}

test('a URL clones with the exact safe flags into a fresh temp folder, which cleanup removes', () => {
  const base = tmp('sentinel-tmpbase-');
  const calls = [];
  try {
    const url = 'https://user:s3cret@git.example.com/acme/api.git';
    const c = places.cloneRepo(url, { ref: 'release/2.0', spawn: stubSpawn(calls), tmpBase: base, env: { PATH: process.env.PATH } });
    const clone = calls.find((x) => x.args.includes('clone'));
    assert.strictEqual(clone.cmd, 'git');
    assert.deepStrictEqual(clone.args, [
      '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never',
      'clone', '--depth', '1', '--no-recurse-submodules', '--branch', 'release/2.0', '--', url, path.join(c.tmp, 'src'),
    ]);
    assert.strictEqual(clone.opts.env.GIT_LFS_SKIP_SMUDGE, '1');
    assert.strictEqual(clone.opts.env.GIT_TERMINAL_PROMPT, '0');
    assert.strictEqual(path.dirname(c.tmp), base);
    assert.ok(path.basename(c.tmp).startsWith('atris-sentinel-clone-'));
    assert.strictEqual(c.commit, 'abcdef1234567890abcdef1234567890abcdef12');
    assert.throws(() => places.cloneRepo(url, { ref: '--upload-pack=x', spawn: stubSpawn([]), tmpBase: base }), /branch or tag/);
    fs.rmSync(c.tmp, { recursive: true, force: true });
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('a failed clone says why in plain words, hides credentials and leaves no temp folder', () => {
  const base = tmp('sentinel-tmpbase-');
  try {
    const url = 'https://user:s3cret@git.example.com/acme/api.git';
    const cases = [
      ["fatal: could not read Username for 'https://git.example.com': terminal prompts disabled", /could not sign in to git\.example\.com/],
      ['remote: Repository not found.\nfatal: repository \'https://user:s3cret@git.example.com/acme/api.git/\' not found', /was not found, or your git account cannot see it/],
      ['fatal: Remote branch nope not found in upstream origin', /has no branch or tag called nope/],
    ];
    for (const [stderr, want] of cases) {
      let err = null;
      try { places.cloneRepo(url, { ref: 'nope', spawn: stubSpawn([], { fail: stderr }), tmpBase: base }); } catch (e) { err = e; }
      assert.ok(err, 'it throws');
      assert.match(err.message, want);
      assert.ok(!err.message.includes('s3cret'), err.message);
      assert.deepStrictEqual(fs.readdirSync(base), [], 'no temp folder left behind');
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('a review with a URL cleans the clone and the review copy, on success and on failure; --keep-clones keeps the clone', async () => {
  const c = makeCompany();
  const base = tmp('sentinel-tmpbase-');
  try {
    await withHome(async (home, out) => {
      const url = 'git@git.example.com:acme/server.git';
      const calls = [];
      const ok = await auditCommand(['--with', url, '--plan', ...LOCAL], { root: c.api, token: null, spawn: stubSpawn(calls), tmpBase: base });
      assert.strictEqual(ok, 0, out.join('\n'));
      assert.deepStrictEqual(fs.readdirSync(base), [], 'clone and review copy removed after success');
      const meta = JSON.parse(fs.readFileSync(path.join(historyDir(home, 'api+server'), 'run-1', 'run-metadata.json'), 'utf8'));
      assert.deepStrictEqual(meta.parts[1], { name: 'server', source: 'git', url, commit: 'abcdef1234567890abcdef1234567890abcdef12' });
      const ledger = JSON.parse(fs.readFileSync(path.join(historyDir(home, 'api+server'), 'run-1', 'coverage-ledger.json'), 'utf8'));
      assert.ok(ledger.some((u) => u.surface === 'server/server/app.js'));

      const bad = await auditCommand(['--with', url, '--plan', ...LOCAL], { root: c.api, token: null, spawn: stubSpawn([], { fail: 'ERROR: Permission denied (publickey).' }), tmpBase: base });
      assert.strictEqual(bad, 2);
      assert.match(out.join('\n'), /could not sign in to git\.example\.com/);
      assert.deepStrictEqual(fs.readdirSync(base), [], 'nothing left after a failed clone');

      // A review that fails after the clone (its --out folder is not empty) still cleans up.
      const ready = enginesReady();
      const boom = await auditCommand(['--with', url, '--out', home, ...LOCAL], { root: c.api, token: null, spawn: stubSpawn([]), tmpBase: base, env: ready.env, signedIn: ready.signedIn });
      fs.rmSync(ready.bin, { recursive: true, force: true });
      assert.strictEqual(boom, 2);
      assert.match(out.join('\n'), /already has files/);
      assert.deepStrictEqual(fs.readdirSync(base), [], 'nothing left after a failed review');
      // Results never land inside a place under review.
      assert.strictEqual(await auditCommand(['../web', '--out', path.join(c.web, 'run'), '--plan', ...LOCAL], { root: c.api, token: null }), 2);
      assert.match(out.join('\n'), /pick a folder outside the places you review/);

      const kept = await auditCommand(['--with', url, '--plan', '--keep-clones', ...LOCAL], { root: c.api, token: null, spawn: stubSpawn([]), tmpBase: base });
      assert.strictEqual(kept, 0);
      const left = fs.readdirSync(base);
      assert.strictEqual(left.length, 1);
      assert.ok(left[0].startsWith('atris-sentinel-clone-'), 'only the clone stays, not the review copy');
      assert.match(out.join('\n'), /kept the clone at/);
      assert.strictEqual(await auditCommand(['--ref', 'main', '--plan', ...LOCAL], { root: c.api, token: null }), 2, '--ref needs a URL');
    });
  } finally { fs.rmSync(base, { recursive: true, force: true }); fs.rmSync(c.parent, { recursive: true, force: true }); }
});

test('a URL alone from a plain folder reviews that repo with its own paths; a planted symlink never comes along', async () => {
  const plain = tmp('sentinel-plain-');
  const base = tmp('sentinel-tmpbase-');
  try {
    await withHome(async (home, out) => {
      const spawn = (cmd, args, opts) => {
        if (args.includes('clone')) {
          const dest = args[args.length - 1];
          fs.mkdirSync(path.join(dest, 'server'), { recursive: true });
          fs.writeFileSync(path.join(dest, 'server', 'app.js'), RECEIVER);
          fs.symlinkSync(path.join(os.homedir(), '.ssh', 'id_rsa'), path.join(dest, 'server', 'key.js'));
          return { status: 0, stdout: '', stderr: '' };
        }
        return stubSpawn([])(cmd, args, opts);
      };
      const code = await auditCommand(['https://git.example.com/acme/server.git', 'server', '--plan', ...LOCAL], { root: plain, token: null, spawn, tmpBase: base });
      assert.strictEqual(code, 0, out.join('\n'));
      const runDir = path.join(historyDir(home, 'server'), 'run-1');
      const meta = JSON.parse(fs.readFileSync(path.join(runDir, 'run-metadata.json'), 'utf8'));
      assert.deepStrictEqual(meta.scope_paths, ['server']);
      assert.strictEqual(meta.source_ref.commit, 'abcdef1234567890abcdef1234567890abcdef12');
      assert.deepStrictEqual(meta.parts.map((p) => p.url), ['https://git.example.com/acme/server.git']);
      const ledger = JSON.parse(fs.readFileSync(path.join(runDir, 'coverage-ledger.json'), 'utf8'));
      assert.ok(ledger.some((u) => u.surface === 'server/app.js'), 'no part prefix for a lone repo');
      assert.ok(!ledger.some((u) => u.starting_paths.includes('server/key.js')));
      assert.doesNotMatch(fs.readFileSync(path.join(runDir, 'architecture.md'), 'utf8'), /One system/);
      assert.deepStrictEqual(fs.readdirSync(base), []);
    });
  } finally { fs.rmSync(base, { recursive: true, force: true }); fs.rmSync(plain, { recursive: true, force: true }); }
});

test('a symlink inside a local part is not copied into the review', () => {
  const c = makeCompany();
  fs.symlinkSync('/etc/hosts', path.join(c.web, 'src', 'hosts.js'));
  git(c.web, ['add', '.']);
  git(c.web, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'link']);
  const sys = places.buildSystem(places.resolvePlaces(c.api, ['../web'], []));
  try {
    assert.ok(!fs.existsSync(path.join(sys.root, 'web', 'src', 'hosts.js')));
    assert.ok(!audit.listFiles(sys.root).includes('web/src/hosts.js'));
  } finally { sys.cleanup(); fs.rmSync(c.parent, { recursive: true, force: true }); }
});

test('a local bare repo clones by path only when a test allows it on purpose', () => {
  const c = makeCompany();
  const base = tmp('sentinel-tmpbase-');
  try {
    const bare = path.join(c.parent, 'web.git');
    execFileSync('git', ['clone', '-q', '--bare', c.web, bare], { env: GIT_ENV, stdio: 'ignore' });
    assert.throws(() => places.cloneRepo(bare, { tmpBase: base }), /does not look like a git URL/);
    assert.throws(() => places.cloneRepo(`file://${bare}`, { tmpBase: base }), /does not look like a git URL/);
    assert.deepStrictEqual(fs.readdirSync(base), []);
    const got = places.cloneRepo(bare, { tmpBase: base, allowFile: true, env: GIT_ENV });
    assert.ok(fs.existsSync(path.join(got.dir, 'src', 'mail.js')));
    assert.strictEqual(got.commit, git(c.web, ['rev-parse', 'HEAD']).trim());
    assert.strictEqual(git(got.dir, ['rev-list', '--count', 'HEAD']).trim(), '1', 'newest commit only');
    fs.rmSync(got.tmp, { recursive: true, force: true });
  } finally { fs.rmSync(base, { recursive: true, force: true }); fs.rmSync(c.parent, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- after the review

test('status, recheck and fix find a review of several places from any of its folders and say what they support', async () => {
  const c = makeCompany();
  const { fixCommand } = require('../commands/sentinel-fix');
  try {
    await withHome(async (home, out) => {
      assert.strictEqual(await auditCommand(['../web', '../mobile', '--plan', ...LOCAL], { root: c.api, token: null }), 0, out.join('\n'));
      out.length = 0;
      assert.strictEqual(await auditCommand(['status'], { root: c.web }), 0);
      assert.match(out.join('\n'), /no finished sentinel review of this folder yet/, 'a plan is not a review');
      assert.strictEqual(await auditCommand(['../web', '../mobile', '--quick', ...LOCAL], { root: c.api, token: null, runJobs: readsAllCleanJobs, quiet: true }), 0, out.join('\n'));

      out.length = 0;
      assert.strictEqual(await auditCommand(['status'], { root: c.web }), 0);
      let text = out.join('\n');
      assert.doesNotMatch(text, /no sentinel audit has run/);
      assert.match(text, /one system in 3 parts/);
      assert.match(text, /this folder was the web part of a review of 3 places\. status shows it here\. recheck and fix work on a review of one folder for now/);

      out.length = 0;
      assert.strictEqual(await auditCommand(['status', '--json'], { root: c.api }), 0);
      const json = JSON.parse(out.join('\n'));
      assert.strictEqual(json.system.part, 'api');
      assert.ok(json.dir.startsWith(path.join(home, 'api+mobile+web')));

      out.length = 0;
      assert.strictEqual(await auditCommand(['recheck'], { root: c.web, token: null }), 0);
      text = out.join('\n');
      assert.match(text, /the last review of this folder read 3 places together \(api, web, mobile\)\. recheck works on a review of one folder for now/);
      assert.match(text, /run that review again: atris sentinel --with \.\.\/api --with \.\.\/mobile/);

      out.length = 0;
      assert.strictEqual(await fixCommand([], { root: c.api }), 0);
      text = out.join('\n');
      assert.match(text, /read 3 places together \(api, web, mobile\), with this one as the api part\. it has 0 confirmed findings/);
      assert.match(text, /fix works on a review of one folder for now, so nothing was changed/);
      assert.match(text, /review this folder alone first: atris sentinel/);
      assert.strictEqual(await fixCommand(['abc123'], { root: c.api }), 2, 'asking to fix one names the limit and fails');

      // A newer review of the folder alone is the one status and fix use.
      assert.strictEqual(await auditCommand(['--quick', ...LOCAL], { root: c.web, token: null, runJobs: readsAllCleanJobs, quiet: true }), 0);
      out.length = 0;
      assert.strictEqual(await auditCommand(['status'], { root: c.web }), 0);
      text = out.join('\n');
      assert.doesNotMatch(text, /one system in/);
      assert.doesNotMatch(text, /part of a review of/);
      // The other folders still find the system review.
      out.length = 0;
      assert.strictEqual(await auditCommand(['status'], { root: c.api }), 0);
      assert.match(out.join('\n'), /this folder was the api part/);
    });
  } finally { fs.rmSync(c.parent, { recursive: true, force: true }); }
});

test('a folder matches a git URL part by its origin in https or ssh form', async () => {
  const dir = tmp('sentinel-origin-');
  try {
    const repo = makeRepo(path.join(dir, 'web'), { 'src/index.js': SHELL });
    git(repo, ['remote', 'add', 'origin', 'git@github.com:org/web.git']);
    await withHome(async (home) => {
      const runDir = path.join(home, 'api+web', 'run-1');
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'run-metadata.json'), JSON.stringify({ run_status: 'complete', finished_at: '2026-11-23T00:00:00.000Z', parts: [{ name: 'api', source: 'folder', path: path.join(dir, 'elsewhere') }, { name: 'web', source: 'git', url: 'https://github.com/Org/Web.git', commit: 'a'.repeat(40) }] }));
      fs.writeFileSync(path.join(runDir, 'findings.json'), '[]');
      const found = audit.latestReview(repo);
      assert.ok(found && found.system, 'found by origin URL');
      assert.strictEqual(found.system.part, 'web');
      assert.strictEqual(audit.latestReview(dir), null, 'a folder that was no part finds nothing');
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
