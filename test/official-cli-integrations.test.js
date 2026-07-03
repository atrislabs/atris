const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scrubAgentEnv } = require('./helpers/agent-env');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-official-cli-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, { cwd, env } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...scrubAgentEnv(),
      ATRIS_SKIP_UPDATE_CHECK: '1',
      ...(env || {}),
    },
  });
  if (result.error) throw result.error;
  return result;
}

function writeFakeBinary(dir, name) {
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const scriptPath = path.join(binDir, name);
  fs.writeFileSync(scriptPath, [
    '#!/bin/sh',
    'printf "%s\\n" "$*" >> "$ATRIS_FAKE_CLI_LOG"',
    'if [ "$1" = "--version" ]; then',
    `  echo "${name} version 1.2.3"`,
    'fi',
    'exit 0',
    '',
  ].join('\n'));
  fs.chmodSync(scriptPath, 0o755);
  return binDir;
}

function readLog(file) {
  return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean);
}

test('github help is workspace-free', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    const res = runCli(['github', '--help'], { cwd: dir, env: { HOME: home } });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /usage: atris github <command> \[args\]/);
    assert.match(res.stdout, /pr list/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(home, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('github reports a missing official cli with install hint', () => {
  const dir = makeTempDir();
  try {
    const emptyPath = path.join(dir, 'empty-bin');
    fs.mkdirSync(emptyPath);
    const res = runCli(['github', 'auth'], { cwd: dir, env: { PATH: emptyPath } });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /github cli not found/);
    assert.match(res.stderr, /install: https:\/\/cli\.github\.com\//);
  } finally {
    cleanupTempDir(dir);
  }
});

test('github auth checks gh auth status', () => {
  const dir = makeTempDir();
  try {
    const logPath = path.join(dir, 'gh.log');
    const binDir = writeFakeBinary(dir, 'gh');
    const res = runCli(['github', 'auth'], {
      cwd: dir,
      env: { PATH: binDir, ATRIS_FAKE_CLI_LOG: logPath },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /auth: ok/);
    assert.deepEqual(readLog(logPath), ['--version', 'auth status']);
  } finally {
    cleanupTempDir(dir);
  }
});

test('github pr list forwards to gh', () => {
  const dir = makeTempDir();
  try {
    const logPath = path.join(dir, 'gh.log');
    const binDir = writeFakeBinary(dir, 'gh');
    const res = runCli(['github', 'pr', 'list', '--limit', '5'], {
      cwd: dir,
      env: { PATH: binDir, ATRIS_FAKE_CLI_LOG: logPath },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.deepEqual(readLog(logPath), ['--version', 'pr list --limit 5']);
  } finally {
    cleanupTempDir(dir);
  }
});

test('vercel help is workspace-free', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    const res = runCli(['vercel', '--help'], { cwd: dir, env: { HOME: home } });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /usage: atris vercel <command> \[args\]/);
    assert.match(res.stdout, /deploy/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(home, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('vercel reports a missing official cli with install hint', () => {
  const dir = makeTempDir();
  try {
    const emptyPath = path.join(dir, 'empty-bin');
    fs.mkdirSync(emptyPath);
    const res = runCli(['vercel', 'auth'], { cwd: dir, env: { PATH: emptyPath } });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /vercel cli not found/);
    assert.match(res.stderr, /install: https:\/\/vercel\.com\/docs\/cli/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('vercel auth checks vercel whoami', () => {
  const dir = makeTempDir();
  try {
    const logPath = path.join(dir, 'vercel.log');
    const binDir = writeFakeBinary(dir, 'vercel');
    const res = runCli(['vercel', 'auth'], {
      cwd: dir,
      env: { PATH: binDir, ATRIS_FAKE_CLI_LOG: logPath },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /auth: ok/);
    assert.deepEqual(readLog(logPath), ['--version', 'whoami']);
  } finally {
    cleanupTempDir(dir);
  }
});

test('vercel deploy forwards to vercel', () => {
  const dir = makeTempDir();
  try {
    const logPath = path.join(dir, 'vercel.log');
    const binDir = writeFakeBinary(dir, 'vercel');
    const res = runCli(['vercel', 'deploy', '--prod'], {
      cwd: dir,
      env: { PATH: binDir, ATRIS_FAKE_CLI_LOG: logPath },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.deepEqual(readLog(logPath), ['--version', 'deploy --prod']);
  } finally {
    cleanupTempDir(dir);
  }
});

test('supabase help is workspace-free', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    const res = runCli(['supabase', '--help'], { cwd: dir, env: { HOME: home } });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /usage: atris supabase <command> \[args\]/);
    assert.match(res.stdout, /db push/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(home, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('supabase reports a missing official cli with install hint', () => {
  const dir = makeTempDir();
  try {
    const emptyPath = path.join(dir, 'empty-bin');
    fs.mkdirSync(emptyPath);
    const res = runCli(['supabase', 'auth'], { cwd: dir, env: { PATH: emptyPath } });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /supabase cli not found/);
    assert.match(res.stderr, /install: https:\/\/supabase\.com\/docs\/guides\/cli/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('supabase auth checks supabase projects list', () => {
  const dir = makeTempDir();
  try {
    const logPath = path.join(dir, 'supabase.log');
    const binDir = writeFakeBinary(dir, 'supabase');
    const res = runCli(['supabase', 'auth'], {
      cwd: dir,
      env: { PATH: binDir, ATRIS_FAKE_CLI_LOG: logPath },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /auth: ok/);
    assert.deepEqual(readLog(logPath), ['--version', 'projects list']);
  } finally {
    cleanupTempDir(dir);
  }
});

test('supabase status forwards to supabase status', () => {
  const dir = makeTempDir();
  try {
    const logPath = path.join(dir, 'supabase.log');
    const binDir = writeFakeBinary(dir, 'supabase');
    const res = runCli(['supabase', 'status'], {
      cwd: dir,
      env: { PATH: binDir, ATRIS_FAKE_CLI_LOG: logPath },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.deepEqual(readLog(logPath), ['--version', 'status']);
  } finally {
    cleanupTempDir(dir);
  }
});

test('supabase db push forwards to supabase', () => {
  const dir = makeTempDir();
  try {
    const logPath = path.join(dir, 'supabase.log');
    const binDir = writeFakeBinary(dir, 'supabase');
    const res = runCli(['supabase', 'db', 'push', '--linked'], {
      cwd: dir,
      env: { PATH: binDir, ATRIS_FAKE_CLI_LOG: logPath },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.deepEqual(readLog(logPath), ['--version', 'db push --linked']);
  } finally {
    cleanupTempDir(dir);
  }
});

test('linear help is workspace-free', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    const res = runCli(['linear', '--help'], { cwd: dir, env: { HOME: home } });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /usage: atris linear <command> \[args\]/);
    assert.match(res.stdout, /issue list/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(home, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('linear reports a missing official cli with install hint', () => {
  const dir = makeTempDir();
  try {
    const emptyPath = path.join(dir, 'empty-bin');
    fs.mkdirSync(emptyPath);
    const res = runCli(['linear', 'auth'], { cwd: dir, env: { PATH: emptyPath } });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /linear cli not found/);
    assert.match(res.stderr, /install the linear cli/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('linear auth checks linear auth status', () => {
  const dir = makeTempDir();
  try {
    const logPath = path.join(dir, 'linear.log');
    const binDir = writeFakeBinary(dir, 'linear');
    const res = runCli(['linear', 'auth'], {
      cwd: dir,
      env: { PATH: binDir, ATRIS_FAKE_CLI_LOG: logPath },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /auth: ok/);
    assert.deepEqual(readLog(logPath), ['--version', 'auth status']);
  } finally {
    cleanupTempDir(dir);
  }
});

test('linear issue list forwards to linear', () => {
  const dir = makeTempDir();
  try {
    const logPath = path.join(dir, 'linear.log');
    const binDir = writeFakeBinary(dir, 'linear');
    const res = runCli(['linear', 'issue', 'list', '--team', 'ENG'], {
      cwd: dir,
      env: { PATH: binDir, ATRIS_FAKE_CLI_LOG: logPath },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.deepEqual(readLog(logPath), ['--version', 'issue list --team ENG']);
  } finally {
    cleanupTempDir(dir);
  }
});
