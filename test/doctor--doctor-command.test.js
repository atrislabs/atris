const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { doctorCommand } = require('../commands/doctor');

const ENV_VARS = [
  'HOME',
  'ATRIS_TOKEN',
  'ATRIS_PROFILE',
  'ATRIS_AGENT_TOKEN_FILE',
  'ATRIS_CLIENT_ID',
  'ATRIS_CLIENT_SECRET',
  'ATRIS_TEST_REAL_HOME',
  'ATRIS_TEST_STATE_DIR',
];

function makeTempDir(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// Point HOME at a throwaway dir and strip ATRIS_* env so auth lookups can
// never touch the machine's real credentials, no matter what env the file
// is run under.
function isolateEnv(t, home) {
  const saved = {};
  for (const name of ENV_VARS) {
    saved[name] = {
      had: Object.prototype.hasOwnProperty.call(process.env, name),
      value: process.env[name],
    };
  }
  for (const name of ENV_VARS) delete process.env[name];
  process.env.HOME = home;
  t.after(() => {
    for (const name of ENV_VARS) {
      if (saved[name].had) process.env[name] = saved[name].value;
      else delete process.env[name];
    }
  });
}

function captureLog(t) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  t.after(() => { console.log = orig; });
  return lines;
}

// A fake atris install: package.json plus the public bin shim and entry,
// all inside the temp dir so nothing reads the real repo.
function makePackageRoot(t, root) {
  const pkg = path.join(root, 'pkg');
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  fs.writeFileSync(path.join(pkg, 'bin', 'atris'), '#!/bin/sh\nexec node bin/atris.js\n');
  fs.writeFileSync(path.join(pkg, 'bin', 'atris.js'), '// entry\n');
  return pkg;
}

// A fake workspace: atris/atris.md marker so detectWorkspaceRoot stops here,
// optional team members, optional .git dir.
function makeWorkspace(t, root, { members = [], git = false } = {}) {
  const ws = path.join(root, 'ws');
  fs.mkdirSync(path.join(ws, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'atris', 'atris.md'), '# atris\n');
  for (const name of members) {
    const dir = path.join(ws, 'atris', 'team', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'MEMBER.md'), `# ${name}\n`);
  }
  if (git) fs.mkdirSync(path.join(ws, '.git'));
  return ws;
}

function fixture(t) {
  const root = makeTempDir(t, 'atris-doctor-test-');
  isolateEnv(t, path.join(root, 'home'));
  fs.mkdirSync(path.join(root, 'home'), { recursive: true });
  return {
    packageRoot: makePackageRoot(t, root),
    root,
  };
}

test('doctorCommand --json reports a ready setup and exits 0', (t) => {
  const { packageRoot, root } = fixture(t);
  const ws = makeWorkspace(t, root, { members: ['alice', 'bob'], git: true });
  const nested = path.join(ws, 'nested', 'deep');
  fs.mkdirSync(nested, { recursive: true });
  const lines = captureLog(t);

  const code = doctorCommand(['--json'], {
    packageRoot,
    cwd: nested,
    nodeVersion: 'v22.5.1',
    binInstalled: (bin) => bin === 'git' || bin === 'claude',
  });

  assert.equal(code, 0);
  const payload = JSON.parse(lines.join('\n'));
  assert.equal(payload.ok, true);
  assert.equal(payload.action, 'doctor');
  assert.equal(payload.version, '9.9.9');
  assert.equal(payload.version_line, 'atris v9.9.9');
  assert.equal(payload.node.version, 'v22.5.1');
  assert.equal(payload.node.major, 22);
  assert.equal(payload.task_support, true);
  assert.equal(payload.cli_runnable, true);
  assert.equal(payload.bin.shim, true);
  assert.equal(payload.auth.signed_in, false);
  assert.equal(payload.workspace_root, path.resolve(ws));
  assert.equal(payload.warnings.length, 0);
  assert.equal(payload.members.ready, true);
  assert.deepEqual(payload.members.member_names, ['alice', 'bob']);
  assert.equal(payload.members.git_installed, true);
  assert.equal(payload.members.git_repo, true);
  assert.deepEqual(payload.members.tools, ['claude']);
  assert.equal(payload.members.next, null);
});

test('doctorCommand renders human output with member next step', (t) => {
  const { packageRoot, root } = fixture(t);
  const ws = makeWorkspace(t, root, { members: ['alice'], git: false });
  const lines = captureLog(t);

  const code = doctorCommand([], {
    packageRoot,
    cwd: ws,
    nodeVersion: 'v22.0.0',
    binInstalled: (bin) => bin === 'git',
  });

  assert.equal(code, 0);
  const out = lines.join('\n');
  assert.match(out, /atris doctor/);
  assert.match(out, /version: atris v9\.9\.9/);
  assert.match(out, /task support \(22\+\): yes/);
  assert.match(out, /auth: signed out/);
  assert.match(out, /members: not ready yet/);
  assert.match(out, /team: 1 member\b/);
  assert.match(out, /git: installed, but this folder is not a git repo/);
  assert.match(out, /next: run git init here so members can work on their own copy\./);
});

test('doctorCommand exits 1 when node is below task-support floor', (t) => {
  const { packageRoot, root } = fixture(t);
  const ws = makeWorkspace(t, root, { members: ['alice'], git: true });
  const lines = captureLog(t);

  const code = doctorCommand([], {
    packageRoot,
    cwd: ws,
    nodeVersion: 'v18.19.0',
    binInstalled: () => true,
  });

  assert.equal(code, 1);
  const out = lines.join('\n');
  assert.match(out, /node: v18\.19\.0/);
  assert.match(out, /task support \(22\+\): no/);
  assert.match(out, /install Node 22\+ before running atris task\./);
});

test('doctorCommand reports empty workspace with no team as not ready', (t) => {
  const { packageRoot, root } = fixture(t);
  const bare = path.join(root, 'bare');
  fs.mkdirSync(path.join(bare, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(bare, 'atris', 'atris.md'), '# atris\n');
  const lines = captureLog(t);

  const code = doctorCommand(['--json'], {
    packageRoot,
    cwd: bare,
    nodeVersion: 'v22.5.1',
    binInstalled: () => false,
  });

  assert.equal(code, 0);
  const payload = JSON.parse(lines.join('\n'));
  assert.equal(payload.workspace_root, path.resolve(bare));
  assert.equal(payload.members.ready, false);
  assert.equal(payload.members.members, 0);
  assert.deepEqual(payload.members.member_names, []);
  assert.deepEqual(payload.members.tools, []);
  assert.equal(payload.members.built_in_tool, false);
  assert.equal(payload.members.next, 'run atris init to add a team to this folder.');
});

test('doctorCommand prints usage and exits 0 on --help', (t) => {
  fixture(t);
  const lines = captureLog(t);

  const code = doctorCommand(['--help']);

  assert.equal(code, 0);
  assert.match(lines.join('\n'), /Usage: atris doctor \[--json\]/);
});
