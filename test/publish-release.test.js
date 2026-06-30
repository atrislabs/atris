const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const packageVersion = require('../package.json').version;

const {
  buildPublishArgs,
  checkVersionAvailability,
  currentGitRef,
  isOtpFailure,
  isTrustedPublishAuthFailure,
  publishAtrisRelease,
  renderOtpHelp,
  renderPublishVerification,
  renderPublishLatestLag,
  renderTrustedPublishHelp,
  renderVersionAvailabilityFailure,
  verifyPublishedVersion,
  verifyPublishedVersionWithRetry,
} = require('../scripts/publish-atris-release');

const publishWorkflowPath = path.resolve(__dirname, '../.github/workflows/publish.yml');

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

test('publish helper detects trusted publisher auth failures in GitHub Actions', () => {
  const originalGithubActions = process.env.GITHUB_ACTIONS;
  process.env.GITHUB_ACTIONS = 'true';
  try {
    assert.equal(isTrustedPublishAuthFailure({
      status: 1,
      stderr: "npm error code E404\nnpm error 404 The requested resource 'atris@3.15.30' could not be found or you do not have permission to access it.",
    }), true);
    assert.equal(isTrustedPublishAuthFailure({
      status: 1,
      stderr: 'npm error code ENEEDAUTH\nnpm error need auth This command requires you to be logged in to https://registry.npmjs.org/\nnpm error need auth You need to authorize this machine using `npm adduser`',
    }), true);
    assert.match(renderTrustedPublishHelp(), /workflow filename: publish\.yml/);
    assert.match(renderTrustedPublishHelp(), /gh workflow run publish\.yml --repo atrislabs\/atris --ref master/);
  } finally {
    if (originalGithubActions == null) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = originalGithubActions;
  }
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

test('publish helper detects an already-published package version', () => {
  const check = checkVersionAvailability('3.15.51', (cmd, args) => {
    assert.equal(cmd, 'npm');
    assert.deepEqual(args, ['view', 'atris@3.15.51', 'version', 'gitHead', '--json']);
    return { status: 0, stdout: JSON.stringify({ version: '3.15.51', gitHead: 'old-head' }) };
  });
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'version_exists');
  assert.match(renderVersionAvailabilityFailure(check), /npm already has atris@3\.15\.51/);
  assert.match(renderVersionAvailabilityFailure(check), /Bump package\.json and package-lock\.json/);
});

test('publish helper treats npm E404 as an available package version', () => {
  const check = checkVersionAvailability('3.15.52', () => ({
    status: 1,
    stderr: 'npm error code E404\nnpm error 404 No match found for version 3.15.52',
  }));
  assert.equal(check.ok, true);
});

test('publish helper refuses to publish when version preflight is inconclusive', () => {
  const stderr = [];
  const originalStderrWrite = process.stderr.write;
  process.stderr.write = chunk => {
    stderr.push(String(chunk));
    return true;
  };
  try {
    const status = publishAtrisRelease([], (cmd, args) => {
      assert.equal(cmd, 'npm');
      assert.equal(args[0], 'view');
      return { status: 1, stderr: 'npm registry timeout\n' };
    });
    assert.equal(status, 1);
    assert.match(stderr.join(''), /Could not verify npm availability/);
    assert.match(stderr.join(''), /Refusing to publish/);
  } finally {
    process.stderr.write = originalStderrWrite;
  }
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

test('publish helper retries stale npm latest verification', () => {
  const versions = ['3.15.23', '3.15.30'];
  const verification = verifyPublishedVersionWithRetry('3.15.30', () => ({
    status: 0,
    stdout: JSON.stringify({ version: versions.shift(), gitHead: 'abc123' }),
  }), { attempts: 3, delayMs: 0 });
  assert.equal(verification.ok, true);
  assert.equal(verification.attempt, 2);
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
      if (args[0] === 'view') return { status: 1, stderr: 'npm error code E404\n' };
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

test('publish helper prints trusted publisher setup help in GitHub Actions', () => {
  const stderr = [];
  const originalStderrWrite = process.stderr.write;
  const originalGithubActions = process.env.GITHUB_ACTIONS;
  process.stderr.write = chunk => {
    stderr.push(String(chunk));
    return true;
  };
  process.env.GITHUB_ACTIONS = 'true';
  try {
    const status = publishAtrisRelease([], (cmd, args) => {
      assert.equal(cmd, 'npm');
      if (args[0] === 'view') return { status: 1, stderr: 'npm error code E404\n' };
      assert.deepEqual(args, ['publish', '--access', 'public']);
      return {
        status: 1,
        stdout: '',
        stderr: "npm error code E404\nnpm error 404 The requested resource 'atris@3.15.30' could not be found or you do not have permission to access it.\n",
      };
    });
    assert.equal(status, 1);
    assert.match(stderr.join(''), /GitHub trusted publishing did not authenticate this workflow/);
    assert.match(stderr.join(''), /owner\/repository: atrislabs\/atris/);
  } finally {
    process.stderr.write = originalStderrWrite;
    if (originalGithubActions == null) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = originalGithubActions;
  }
});

test('publish helper prints trusted publisher setup help for GitHub ENEEDAUTH', () => {
  const stderr = [];
  const originalStderrWrite = process.stderr.write;
  const originalGithubActions = process.env.GITHUB_ACTIONS;
  process.stderr.write = chunk => {
    stderr.push(String(chunk));
    return true;
  };
  process.env.GITHUB_ACTIONS = 'true';
  try {
    const status = publishAtrisRelease([], (cmd, args) => {
      assert.equal(cmd, 'npm');
      if (args[0] === 'view') return { status: 1, stderr: 'npm error code E404\n' };
      assert.deepEqual(args, ['publish', '--access', 'public']);
      return {
        status: 1,
        stdout: '',
        stderr: 'npm error code ENEEDAUTH\nnpm error need auth This command requires you to be logged in to https://registry.npmjs.org/\nnpm error need auth You need to authorize this machine using `npm adduser`\n',
      };
    });
    assert.equal(status, 1);
    assert.match(stderr.join(''), /GitHub trusted publishing did not authenticate this workflow/);
    assert.match(stderr.join(''), /workflow filename: publish\.yml/);
  } finally {
    process.stderr.write = originalStderrWrite;
    if (originalGithubActions == null) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = originalGithubActions;
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
      if (args[0] === 'view' && String(args[1] || '').startsWith('atris@')) {
        return { status: 1, stderr: 'npm error code E404\n' };
      }
      if (args[0] === 'view') {
        return { status: 0, stdout: JSON.stringify({ version: packageVersion, gitHead: 'abc123' }) };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    });
    assert.equal(status, 0);
    assert.equal(calls.length, 3);
    assert.match(stdout.join(''), /published/);
    assert.ok(stdout.join('').includes(`Verified npm latest: atris@${packageVersion} gitHead abc123`));
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
});

test('publish helper retries registry lag after a successful publish run', () => {
  const stdout = [];
  const originalStdoutWrite = process.stdout.write;
  process.stdout.write = chunk => {
    stdout.push(String(chunk));
    return true;
  };
  try {
    let views = 0;
    const status = publishAtrisRelease([], (cmd, args) => {
      if (args[0] === 'publish') return { status: 0, stdout: 'published\n', stderr: '' };
      if (args[0] === 'view' && String(args[1] || '').startsWith('atris@')) {
        return { status: 1, stderr: 'npm error code E404\n' };
      }
      if (args[0] === 'view') {
        views += 1;
        const version = views === 1 ? '3.15.23' : packageVersion;
        return { status: 0, stdout: JSON.stringify({ version, gitHead: 'abc123' }) };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    }, { verificationAttempts: 3, verificationDelayMs: 0 });
    assert.equal(status, 0);
    assert.equal(views, 2);
    assert.ok(stdout.join('').includes(`Verified npm latest: atris@${packageVersion} gitHead abc123`));
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
});

test('publish helper treats a lagging npm latest as success once the version is confirmed live', () => {
  const stdout = [];
  const originalStdoutWrite = process.stdout.write;
  process.stdout.write = chunk => { stdout.push(String(chunk)); return true; };
  try {
    let atrisAtCalls = 0;
    const status = publishAtrisRelease([], (cmd, args) => {
      if (args[0] === 'publish') return { status: 0, stdout: 'published\n', stderr: '' };
      if (args[0] === 'view' && String(args[1] || '').startsWith('atris@')) {
        atrisAtCalls += 1;
        // 1st call is the preflight (must be unpublished to proceed);
        // 2nd is the post-publish confirmation (now live on the registry).
        if (atrisAtCalls === 1) return { status: 1, stderr: 'npm error code E404\n' };
        return { status: 0, stdout: JSON.stringify({ version: packageVersion, gitHead: 'abc123' }) };
      }
      if (args[0] === 'view') {
        // The latest dist-tag never catches up during this run.
        return { status: 0, stdout: JSON.stringify({ version: '3.0.0', gitHead: 'old' }) };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    }, { verificationAttempts: 2, verificationDelayMs: 0 });
    assert.equal(status, 0);
    assert.match(stdout.join(''), /confirmed on the registry/);
    assert.match(stdout.join(''), /propagating/);
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
});

test('publish helper still fails when latest lags and the version is not on the registry', () => {
  const stderr = [];
  const originalStderrWrite = process.stderr.write;
  const originalStdoutWrite = process.stdout.write;
  process.stderr.write = chunk => { stderr.push(String(chunk)); return true; };
  process.stdout.write = () => true;
  try {
    const status = publishAtrisRelease([], (cmd, args) => {
      if (args[0] === 'publish') return { status: 0, stdout: 'published\n', stderr: '' };
      if (args[0] === 'view' && String(args[1] || '').startsWith('atris@')) {
        return { status: 1, stderr: 'npm error code E404\n' };
      }
      if (args[0] === 'view') {
        return { status: 0, stdout: JSON.stringify({ version: '3.0.0', gitHead: 'old' }) };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    }, { verificationAttempts: 2, verificationDelayMs: 0 });
    assert.equal(status, 1);
    assert.match(stderr.join(''), /npm latest verification failed/);
  } finally {
    process.stderr.write = originalStderrWrite;
    process.stdout.write = originalStdoutWrite;
  }
});

test('renderPublishLatestLag explains the release succeeded despite the lag', () => {
  const text = renderPublishLatestLag('9.9.9', { actual: '3.0.0' });
  assert.match(text, /Published atris@9\.9\.9 to npm/);
  assert.match(text, /successful/);
});

test('trusted publish workflow uses OIDC without npm token secrets', () => {
  const workflow = fs.readFileSync(publishWorkflowPath, 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /id-token:\s*write/);
  assert.match(workflow, /contents:\s*read/);
  assert.match(workflow, /node-version:\s*'24'/);
  assert.match(workflow, /registry-url:\s*'https:\/\/registry\.npmjs\.org'/);
  assert.match(workflow, /npm install -g npm@\^11\.5\.1/);
  assert.match(workflow, /npm --version/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /Release gate/);
  assert.match(workflow, /node -c commands\/mission\.js/);
  assert.match(workflow, /node --test test\/mission-status\.test\.js test\/check-command-regression\.test\.js test\/repo-shape\.test\.js/);
  assert.match(workflow, /node scripts\/check-command-regression\.js/);
  assert.match(workflow, /npm run publish:release -- --dry-run/);
  assert.match(workflow, /npm run publish:release/);
  assert.match(workflow, /Block duplicate npm versions/);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN|NPM_CONFIG_TOKEN/);
});
