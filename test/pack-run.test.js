const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runPack } = require('../commands/pack');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-pack-run-test-'));
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// An installed packet: a folder with a readable pack.json.
function seedInstalledPack(dir, slug = 'g-brain') {
  const packDir = path.join(dir, slug);
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(
    path.join(packDir, 'pack.json'),
    `${JSON.stringify({ slug, title: 'G Brain', version: '0.1.0' }, null, 2)}\n`
  );
  fs.writeFileSync(path.join(packDir, 'README.md'), '# G Brain\n');
  return packDir;
}

// Every seam pack run touches, captured instead of executed.
function stubDeps(overrides = {}) {
  const calls = { local: [], cloud: [], install: [] };
  return {
    calls,
    deps: {
      computerLocal: (args, options) => { calls.local.push({ cwd: process.cwd(), args, options }); },
      runComputer: async (args) => { calls.cloud.push({ cwd: process.cwd(), args }); },
      loadCredentials: () => ({ token: 'test-token' }),
      readBusinessBinding: () => ({ slug: 'acme', business_id: 'b1', workspace_id: 'w1' }),
      ...overrides,
    },
  };
}

// Returns { code, output } with console captured for the whole async call.
async function captureConsole(fn) {
  const lines = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...args) => lines.push(args.join(' '));
  console.log = (...args) => lines.push(args.join(' '));
  try {
    const code = await fn();
    return { code, output: lines.join('\n') };
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
}

test('pack run starts a local computer inside the packet folder', async () => {
  const dir = makeTempDir();
  try {
    const packDir = seedInstalledPack(dir);
    const { calls, deps } = stubDeps();
    const code = await runPack(['g-brain'], dir, { deps });

    assert.equal(code, 0);
    assert.equal(calls.local.length, 1, 'local computer should start exactly once');
    assert.equal(fs.realpathSync(calls.local[0].cwd), fs.realpathSync(packDir));
    assert.equal(calls.cloud.length, 0, 'local is the default; cloud must not be touched');
    // the working directory is restored, not leaked
    assert.notEqual(process.cwd(), packDir);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack run accepts a packet directory as well as a slug', async () => {
  const dir = makeTempDir();
  try {
    const packDir = seedInstalledPack(dir, 'some-pack');
    const { calls, deps } = stubDeps({
      installPack: async () => { throw new Error('should not install an existing folder'); },
    });
    const code = await runPack([path.join(dir, 'some-pack')], dir, { deps });

    assert.equal(code, 0);
    assert.equal(fs.realpathSync(calls.local[0].cwd), fs.realpathSync(packDir));
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack run installs an uninstalled slug before starting it', async () => {
  const dir = makeTempDir();
  try {
    const { calls, deps } = stubDeps();
    deps.installPack = async (args) => {
      calls.install.push(args);
      const target = args[args.indexOf('--dir') + 1];
      seedInstalledPack(path.dirname(target), path.basename(target));
      return 0;
    };
    const code = await runPack(['fresh-pack'], dir, { deps });

    assert.equal(code, 0);
    assert.equal(calls.install.length, 1, 'install runs through the existing install path');
    assert.equal(calls.install[0][0], 'fresh-pack');
    assert.equal(calls.local.length, 1);
    assert.equal(
      fs.realpathSync(calls.local[0].cwd),
      fs.realpathSync(path.join(dir, 'fresh-pack'))
    );
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack run --cloud fails loudly when the caller is not logged in', async () => {
  const dir = makeTempDir();
  try {
    seedInstalledPack(dir);
    const { calls, deps } = stubDeps({ loadCredentials: () => null });
    const { code, output } = await captureConsole(() => runPack(['g-brain', '--cloud'], dir, { deps }));

    assert.equal(code, 1);
    assert.match(output, /not logged in/);
    assert.match(output, /atris login/);
    assert.match(output, /local runs free/);
    assert.match(output, /atris pack run g-brain/);
    assert.equal(calls.cloud.length, 0, 'the paywall must not be routed around');
    assert.equal(calls.local.length, 0, 'no silent fallback to local');
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack run --cloud fails loudly when no business is bound', async () => {
  const dir = makeTempDir();
  try {
    seedInstalledPack(dir);
    const { calls, deps } = stubDeps({ readBusinessBinding: () => null });
    const { code, output } = await captureConsole(() => runPack(['g-brain', '--cloud'], dir, { deps }));

    assert.equal(code, 1);
    assert.match(output, /no business is bound/);
    assert.match(output, /paid plan/);
    assert.match(output, /atris pack run g-brain/);
    assert.equal(calls.cloud.length, 0);
    assert.equal(calls.local.length, 0);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack run --cloud uses the cloud workspace path once the gates pass', async () => {
  const dir = makeTempDir();
  try {
    const packDir = seedInstalledPack(dir);
    const { calls, deps } = stubDeps();
    const code = await runPack(['g-brain', '--cloud'], dir, { deps });

    assert.equal(code, 0);
    assert.equal(calls.cloud.length, 1);
    assert.deepEqual(calls.cloud[0].args, ['cloud']);
    assert.equal(fs.realpathSync(calls.cloud[0].cwd), fs.realpathSync(packDir));
    assert.equal(calls.local.length, 0);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack run says plainly when the packet folder is missing or invalid', async () => {
  const dir = makeTempDir();
  try {
    const { deps } = stubDeps();
    fs.mkdirSync(path.join(dir, 'not-a-pack'));
    await assert.rejects(
      () => runPack([path.join(dir, 'not-a-pack')], dir, { deps }),
      /not an atris packet \(no pack\.json\)/
    );

    fs.writeFileSync(path.join(dir, 'not-a-pack', 'pack.json'), '{ broken');
    await assert.rejects(
      () => runPack([path.join(dir, 'not-a-pack')], dir, { deps }),
      /packet is invalid/
    );
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack run keeps permission prompts on for a packet someone else wrote', async () => {
  const dir = makeTempDir();
  try {
    seedInstalledPack(dir);
    const { calls, deps } = stubDeps();
    const { code, output } = await captureConsole(() => runPack(['g-brain'], dir, { deps }));

    assert.equal(code, 0);
    assert.equal(calls.local[0].options.skipPermissions, false);
    assert.match(output, /permission prompts are on/);
    assert.match(output, /--trust/);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack run --trust is the explicit opt-out for a packet you have read', async () => {
  const dir = makeTempDir();
  try {
    seedInstalledPack(dir);
    const { calls, deps } = stubDeps();
    const { code, output } = await captureConsole(() => runPack(['g-brain', '--trust'], dir, { deps }));

    assert.equal(code, 0);
    assert.equal(calls.local[0].options.skipPermissions, true);
    assert.doesNotMatch(output, /permission prompts are on/);
  } finally {
    cleanupTempDir(dir);
  }
});

// The end-to-end proof: what actually reaches the agent binary. A stubbed
// runner records its argv, so this fails if any layer between pack run and the
// spawn puts --dangerously-skip-permissions back.
function seedFakeRunner(dir, argsFile) {
  const runner = path.join(dir, 'fake-runner.sh');
  fs.writeFileSync(runner, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\n`);
  fs.chmodSync(runner, 0o755);
  return runner;
}

function runPackCli(dir, extraArgs, runner) {
  const result = spawnSync(process.execPath, [cliPath, 'pack', 'run', 'g-brain', ...extraArgs], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30000,
    input: '',
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_RUNNER_BIN: runner },
  });
  return result;
}

test('pack run does not hand --dangerously-skip-permissions to the agent by default', () => {
  const dir = makeTempDir();
  try {
    seedInstalledPack(dir);
    const argsFile = path.join(dir, 'argv-default.txt');
    const runner = seedFakeRunner(dir, argsFile);
    const result = runPackCli(dir, [], runner);

    assert.equal(fs.existsSync(argsFile), true, `runner never launched: ${result.stdout}${result.stderr}`);
    const argv = fs.readFileSync(argsFile, 'utf8').split('\n');
    assert.equal(argv.includes('--dangerously-skip-permissions'), false);
    assert.equal(argv.includes('--append-system-prompt'), true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('pack run --trust hands the skip flag through to the agent', () => {
  const dir = makeTempDir();
  try {
    seedInstalledPack(dir);
    const argsFile = path.join(dir, 'argv-trust.txt');
    const runner = seedFakeRunner(dir, argsFile);
    const result = runPackCli(dir, ['--trust'], runner);

    assert.equal(fs.existsSync(argsFile), true, `runner never launched: ${result.stdout}${result.stderr}`);
    const argv = fs.readFileSync(argsFile, 'utf8').split('\n');
    assert.equal(argv.includes('--dangerously-skip-permissions'), true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris console keeps skipping permissions on your own workspace', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'atris', 'TODO.md'), '# TODO\n');
    const argsFile = path.join(dir, 'argv-console.txt');
    const runner = seedFakeRunner(dir, argsFile);
    const result = spawnSync(process.execPath, [cliPath, 'console', 'claude'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 30000,
      input: '',
      env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_RUNNER_BIN: runner },
    });

    assert.equal(fs.existsSync(argsFile), true, `runner never launched: ${result.stdout}${result.stderr}`);
    const argv = fs.readFileSync(argsFile, 'utf8').split('\n');
    assert.equal(argv.includes('--dangerously-skip-permissions'), true);
  } finally {
    cleanupTempDir(dir);
  }
});

test('atris pack help lists run', () => {
  const result = spawnSync(process.execPath, [cliPath, 'pack', 'help'], {
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1' },
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /atris pack run <slug\|dir>/);
});
