const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const journal = require('../lib/journal');

// showLogDiff prints through console.log and process.stdout.write.
// Capture both, and strip the ANSI color codes that `git diff --color=always` adds.
function captureOutput(fn) {
  const chunks = [];
  const originalLog = console.log;
  const originalWrite = process.stdout.write;
  console.log = (...args) => { chunks.push(`${args.join(' ')}\n`); };
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try {
    fn();
  } finally {
    console.log = originalLog;
    process.stdout.write = originalWrite;
  }
  return chunks.join('').replace(/\x1b\[[0-9;]*m/g, '');
}

// Point TMPDIR at the sandbox so every temp file the function makes stays in it.
// Git reads no global or system config, so the host machine cannot change the output.
function withSandboxEnv(sandbox, fn) {
  const overrides = {
    HOME: sandbox,
    TMPDIR: sandbox,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    process.env[key] = overrides[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
}

function makeSandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-journal-diff-test-'));
}

test('showLogDiff prints a diff that marks the changed line on each side', () => {
  const sandbox = makeSandbox();
  try {
    const localPath = path.join(sandbox, 'local.md');
    fs.writeFileSync(localPath, '# Log\n\nkeep this\nold line\n');

    const output = withSandboxEnv(sandbox, () => captureOutput(() => {
      journal.showLogDiff(localPath, '# Log\n\nkeep this\nnew line\n');
    }));
    const lines = output.split('\n');

    assert.ok(lines.includes('Diff (web -> local):'));
    assert.ok(lines.includes(' keep this'));
    assert.ok(lines.includes('-old line'));
    assert.ok(lines.includes('+new line'));
    assert.ok(!output.includes('no textual diff available'));
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('showLogDiff says there is no textual diff when both sides match', () => {
  const sandbox = makeSandbox();
  try {
    const localPath = path.join(sandbox, 'local.md');
    const content = '# Log\n\nsame on both sides\n';
    fs.writeFileSync(localPath, content);

    const output = withSandboxEnv(sandbox, () => captureOutput(() => {
      journal.showLogDiff(localPath, content);
    }));

    assert.ok(output.includes('no textual diff available'));
    assert.ok(!output.includes('Diff (web -> local):'));
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('showLogDiff removes its temp directory after printing the diff', () => {
  const sandbox = makeSandbox();
  try {
    const localPath = path.join(sandbox, 'local.md');
    fs.writeFileSync(localPath, 'alpha\n');

    withSandboxEnv(sandbox, () => captureOutput(() => {
      journal.showLogDiff(localPath, 'beta\n');
    }));

    // withSandboxEnv sets TMPDIR to the sandbox itself, so the temp dir would land directly in it.
    const leftovers = fs.readdirSync(sandbox).filter((name) => name.startsWith('atris-diff-'));
    assert.deepStrictEqual(leftovers, []);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('showLogDiff reports the error instead of throwing when the temp dir cannot be made', () => {
  const sandbox = makeSandbox();
  try {
    const localPath = path.join(sandbox, 'local.md');
    fs.writeFileSync(localPath, 'alpha\n');
    const missingTmp = path.join(sandbox, 'does-not-exist');

    const output = withSandboxEnv(sandbox, () => {
      process.env.TMPDIR = missingTmp;
      return captureOutput(() => {
        journal.showLogDiff(localPath, 'beta\n');
      });
    });

    assert.ok(output.includes('Unable to show diff automatically (ENOENT'));
    assert.ok(!output.includes('Diff (web -> local):'));
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
