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

function writeNoisyFakeVercel(dir) {
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const scriptPath = path.join(binDir, 'vercel');
  fs.writeFileSync(scriptPath, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then echo "vercel version 1.2.3"; exit 0; fi',
    'printf "%s\\n" "$*" >> "$ATRIS_FAKE_CLI_LOG"',
    'echo "Building project..."',
    'echo "WARN: deprecated option in vercel.json"',
    'echo "compiling chunk 1 of 40"',
    'echo "compiling chunk 2 of 40"',
    'echo "compiling chunk 3 of 40"',
    'echo "Error: chunk hash mismatch in build output"',
    'echo "Deployment complete: https://example-abc.vercel.app"',
    'exit 0',
    '',
  ].join('\n'));
  fs.chmodSync(scriptPath, 0o755);
  return binDir;
}

test('vercel deploy prints a grouped summary instead of the raw wall', () => {
  const dir = makeTempDir();
  try {
    const logPath = path.join(dir, 'vercel.log');
    const binDir = writeNoisyFakeVercel(dir);
    const res = runCli(['vercel', 'deploy', '--prod'], {
      cwd: dir,
      env: { PATH: binDir, ATRIS_FAKE_CLI_LOG: logPath },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /vercel deploy --prod: ok, 7 output lines/);
    assert.match(res.stdout, /links \(1\)/);
    assert.match(res.stdout, /https:\/\/example-abc\.vercel\.app/);
    assert.match(res.stdout, /errors \(1\)/);
    assert.match(res.stdout, /warnings \(1\)/);
    assert.match(res.stdout, /last lines/);
    assert.match(res.stdout, /full output: atris vercel deploy --prod --raw/);
    assert.deepEqual(readLog(logPath), ['deploy --prod']);
  } finally {
    cleanupTempDir(dir);
  }
});

test('vercel deploy --raw streams the cli output ungrouped', () => {
  const dir = makeTempDir();
  try {
    const logPath = path.join(dir, 'vercel.log');
    const binDir = writeNoisyFakeVercel(dir);
    const res = runCli(['vercel', 'deploy', '--prod', '--raw'], {
      cwd: dir,
      env: { PATH: binDir, ATRIS_FAKE_CLI_LOG: logPath },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /Building project\.\.\./);
    assert.match(res.stdout, /compiling chunk 1 of 40/);
    assert.doesNotMatch(res.stdout, /output lines/);
    assert.deepEqual(readLog(logPath), ['deploy --prod']);
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

test('stripe help is workspace-free', () => {
  const dir = makeTempDir();
  try {
    const home = path.join(dir, 'home');
    const res = runCli(['stripe', '--help'], { cwd: dir, env: { HOME: home } });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /usage: atris stripe <command> \[args\]/);
    assert.match(res.stdout, /products list/);
    assert.equal(fs.existsSync(path.join(dir, 'atris')), false);
    assert.equal(fs.existsSync(path.join(home, '.atris')), false);
  } finally {
    cleanupTempDir(dir);
  }
});

test('stripe reports a missing official cli with install hint', () => {
  const dir = makeTempDir();
  try {
    const emptyPath = path.join(dir, 'empty-bin');
    fs.mkdirSync(emptyPath);
    const res = runCli(['stripe', 'auth'], { cwd: dir, env: { PATH: emptyPath } });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /stripe cli not found/);
    assert.match(res.stderr, /install: https:\/\/docs\.stripe\.com\/stripe-cli/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('stripe auth checks stripe config list', () => {
  const dir = makeTempDir();
  try {
    const logPath = path.join(dir, 'stripe.log');
    const binDir = writeFakeBinary(dir, 'stripe');
    const res = runCli(['stripe', 'auth'], {
      cwd: dir,
      env: { PATH: binDir, ATRIS_FAKE_CLI_LOG: logPath },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /auth: ok/);
    assert.deepEqual(readLog(logPath), ['--version', 'config --list']);
  } finally {
    cleanupTempDir(dir);
  }
});

test('stripe listen forwards to stripe', () => {
  const dir = makeTempDir();
  try {
    const logPath = path.join(dir, 'stripe.log');
    const binDir = writeFakeBinary(dir, 'stripe');
    const res = runCli(['stripe', 'listen', '--forward-to', 'localhost:3000/webhook'], {
      cwd: dir,
      env: { PATH: binDir, ATRIS_FAKE_CLI_LOG: logPath },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.deepEqual(readLog(logPath), ['--version', 'listen --forward-to localhost:3000/webhook']);
  } finally {
    cleanupTempDir(dir);
  }
});

test('stripe products list forwards to stripe', () => {
  const dir = makeTempDir();
  try {
    const logPath = path.join(dir, 'stripe.log');
    const binDir = writeFakeBinary(dir, 'stripe');
    const res = runCli(['stripe', 'products', 'list', '--limit', '3'], {
      cwd: dir,
      env: { PATH: binDir, ATRIS_FAKE_CLI_LOG: logPath },
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.deepEqual(readLog(logPath), ['--version', 'products list --limit 3']);
  } finally {
    cleanupTempDir(dir);
  }
});
