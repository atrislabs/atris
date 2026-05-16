const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildPublishArgs,
  currentGitRef,
  isOtpFailure,
  publishAtrisRelease,
  renderOtpHelp,
  renderPublishVerification,
  verifyPublishedVersion,
} = require('../scripts/publish-atris-release');

test('publish helper adds owner OTP when provided', () => {
  assert.deepEqual(buildPublishArgs(['--otp', '123456']), ['publish', '--access', 'public', '--otp', '123456']);
});

test('publish helper preserves dry-run', () => {
  assert.deepEqual(buildPublishArgs(['--dry-run']), ['publish', '--access', 'public', '--dry-run']);
});

test('publish helper detects npm one-time-password failures', () => {
  assert.equal(isOtpFailure({ status: 1, stderr: 'npm error code EOTP' }), true);
  assert.equal(isOtpFailure({ status: 1, stderr: 'requires a one-time password' }), true);
  assert.equal(isOtpFailure({ status: 1, stderr: 'npm error code E403' }), false);
});

test('publish helper prints exact retry and GitHub fallback', () => {
  const help = renderOtpHelp('3.15.24', 'abc123');
  assert.match(help, /npm run publish:release -- --otp <code>/);
  assert.match(help, /npm install -g github:atrislabs\/atris#abc123/);
  assert.match(help, /npm view atris version gitHead --json/);
});

test('publish helper reads current git ref for fallback help', () => {
  const ref = currentGitRef(() => ({ status: 0, stdout: 'abc123\n' }));
  assert.equal(ref, 'abc123');
});

test('publish helper verifies npm latest after successful publish', () => {
  const verification = verifyPublishedVersion('3.15.30', () => ({
    status: 0,
    stdout: JSON.stringify({ version: '3.15.30', gitHead: 'abc123' }),
  }));
  assert.equal(verification.ok, true);
  assert.match(renderPublishVerification(verification), /Verified npm latest: atris@3\.15\.30 gitHead abc123/);
});

test('publish helper fails verification when npm latest is stale', () => {
  const verification = verifyPublishedVersion('3.15.30', () => ({
    status: 0,
    stdout: JSON.stringify({ version: '3.15.23', gitHead: 'old' }),
  }));
  assert.equal(verification.ok, false);
  assert.match(renderPublishVerification(verification), /expected 3\.15\.30, got 3\.15\.23/);
});

test('publish helper replays captured npm output and prints OTP help', () => {
  const stdout = [];
  const stderr = [];
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  process.stdout.write = chunk => {
    stdout.push(String(chunk));
    return true;
  };
  process.stderr.write = chunk => {
    stderr.push(String(chunk));
    return true;
  };
  try {
    const status = publishAtrisRelease([], (cmd, args) => {
      if (cmd === 'git') return { status: 0, stdout: 'abc123\n' };
      assert.equal(cmd, 'npm');
      assert.deepEqual(args, ['publish', '--access', 'public']);
      return {
        status: 1,
        stdout: 'npm notice package\n',
        stderr: 'npm error code EOTP\n',
      };
    });
    assert.equal(status, 1);
    assert.match(stdout.join(''), /npm notice package/);
    assert.match(stderr.join(''), /npm error code EOTP/);
    assert.match(stderr.join(''), /npm publish needs the owner OTP/);
    assert.match(stderr.join(''), /github:atrislabs\/atris#abc123/);
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
});

test('publish helper verifies registry latest after a successful publish run', () => {
  const stdout = [];
  const originalStdoutWrite = process.stdout.write;
  process.stdout.write = chunk => {
    stdout.push(String(chunk));
    return true;
  };
  try {
    const calls = [];
    const status = publishAtrisRelease([], (cmd, args) => {
      calls.push([cmd, args]);
      if (args[0] === 'publish') return { status: 0, stdout: 'published\n', stderr: '' };
      if (args[0] === 'view') {
        return { status: 0, stdout: JSON.stringify({ version: '3.15.30', gitHead: 'abc123' }) };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    });
    assert.equal(status, 0);
    assert.equal(calls.length, 2);
    assert.match(stdout.join(''), /published/);
    assert.match(stdout.join(''), /Verified npm latest: atris@3\.15\.30 gitHead abc123/);
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
});
