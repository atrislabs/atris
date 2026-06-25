#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const packagePath = path.join(repoRoot, 'package.json');

function readPackageVersion() {
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  return pkg.version;
}

function readFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : '';
}

function buildPublishArgs(args = []) {
  const publishArgs = ['publish', '--access', 'public'];
  const otp = readFlag(args, '--otp') || process.env.NPM_CONFIG_OTP || process.env.NPM_OTP || '';
  if (otp) publishArgs.push('--otp', otp);
  if (args.includes('--dry-run')) publishArgs.push('--dry-run');
  return publishArgs;
}

function currentGitRef(runner = spawnSync) {
  const result = runner('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

function renderOtpHelp(version, installRef = `v${version}`) {
  return [
    '',
    'npm publish needs the owner OTP.',
    '',
    `Retry: npm run publish:release -- --otp <code>`,
    `Verify: npm view atris version gitHead --json`,
    '',
    'Playable fallback until npm latest moves:',
    `npm install -g github:atrislabs/atris#${installRef}`,
    '',
  ].join('\n');
}

function isOtpFailure(result) {
  const text = `${result.stderr || ''}\n${result.stdout || ''}`;
  return result.status !== 0 && (text.includes('EOTP') || text.toLowerCase().includes('one-time password'));
}

function isTrustedPublishAuthFailure(result) {
  const text = `${result.stderr || ''}\n${result.stdout || ''}`;
  const lower = text.toLowerCase();
  const permission404 = text.includes('npm error code E404')
    && text.includes('could not be found or you do not have permission');
  const missingOidcAuth = text.includes('npm error code ENEEDAUTH')
    && lower.includes('need auth')
    && lower.includes('logged in');
  return result.status !== 0
    && process.env.GITHUB_ACTIONS === 'true'
    && (permission404 || missingOidcAuth);
}

function renderTrustedPublishHelp() {
  return [
    '',
    'GitHub trusted publishing did not authenticate this workflow.',
    '',
    'Configure npm package trusted publishing:',
    '- package: atris',
    '- provider: GitHub Actions',
    '- owner/repository: atrislabs/atris',
    '- workflow filename: publish.yml',
    '',
    'Retry: gh workflow run publish.yml --repo atrislabs/atris --ref master',
    '',
  ].join('\n');
}

function checkVersionAvailability(version, runner = spawnSync) {
  const result = runner('npm', ['view', `atris@${version}`, 'version', 'gitHead', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status === 0) {
    let payload = {};
    try {
      payload = JSON.parse(result.stdout || '{}');
    } catch {}
    return {
      ok: false,
      reason: 'version_exists',
      version: payload.version || version,
      gitHead: payload.gitHead || null,
    };
  }
  const text = `${result.stderr || ''}\n${result.stdout || ''}`;
  if (text.includes('E404') || text.includes('No match found')) {
    return { ok: true, version };
  }
  return {
    ok: false,
    reason: 'version_check_failed',
    version,
    error: result.stderr || result.stdout || 'npm view failed',
  };
}

function renderVersionAvailabilityFailure(check) {
  if (check.reason === 'version_exists') {
    return [
      `npm already has atris@${check.version}.`,
      check.gitHead ? `Published gitHead: ${check.gitHead}` : null,
      'Bump package.json and package-lock.json before publishing.',
      '',
    ].filter(Boolean).join('\n');
  }
  return [
    `Could not verify npm availability for atris@${check.version}.`,
    String(check.error || '').trim(),
    'Refusing to publish until the registry preflight is clear.',
    '',
  ].filter(Boolean).join('\n');
}

function verifyPublishedVersion(version, runner = spawnSync) {
  const result = runner('npm', ['view', 'atris', 'version', 'gitHead', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    return { ok: false, error: result.stderr || result.stdout || 'npm view failed' };
  }
  let payload = {};
  try {
    payload = JSON.parse(result.stdout || '{}');
  } catch (error) {
    return { ok: false, error: `could not parse npm view output: ${error.message}` };
  }
  const actual = String(payload.version || '');
  return {
    ok: actual === version,
    actual,
    expected: version,
    gitHead: payload.gitHead || null,
  };
}

function sleepMs(ms) {
  if (!ms) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function verifyPublishedVersionWithRetry(version, runner = spawnSync, options = {}) {
  // npm's `latest` dist-tag is eventually consistent: the read CDN can lag the
  // publish by well over a minute. Give it a realistic window (~60s) before we
  // fall back to confirming the exact version landed.
  const attempts = Math.max(1, Number(options.attempts || 12));
  const delayMs = Math.max(0, Number(options.delayMs ?? 5000));
  let verification = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    verification = {
      ...verifyPublishedVersion(version, runner),
      attempt,
      attempts,
    };
    if (verification.ok) return verification;
    if (attempt < attempts) sleepMs(delayMs);
  }
  return verification;
}

function renderPublishVerification(verification) {
  if (verification.ok) {
    return `Verified npm latest: atris@${verification.actual} gitHead ${verification.gitHead || 'unknown'}\n`;
  }
  return `npm latest verification failed: expected ${verification.expected || 'unknown'}, got ${verification.actual || verification.error || 'unknown'}\n`;
}

function renderPublishLatestLag(version, verification) {
  return [
    `Published atris@${version} to npm (confirmed on the registry).`,
    `The "latest" dist-tag still reads ${verification.actual || 'an older version'}; it is propagating and will catch up.`,
    'Treating the release as successful: npm publish already succeeded and the version is live.',
    '',
  ].join('\n');
}

function publishAtrisRelease(args = process.argv.slice(2), runner = spawnSync, options = {}) {
  const version = readPackageVersion();
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: npm run publish:release -- [--otp <code>] [--dry-run]');
    console.log('');
    console.log('Publishes the atris npm package and prints the AgentXP fallback if npm asks for OTP.');
    return 0;
  }

  if (!args.includes('--dry-run') && !options.skipVersionPreflight) {
    const availability = checkVersionAvailability(version, runner);
    if (!availability.ok) {
      process.stderr.write(renderVersionAvailabilityFailure(availability));
      return 1;
    }
  }

  const result = runner('npm', buildPublishArgs(args), {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (isOtpFailure(result)) {
    process.stderr.write(renderOtpHelp(version, currentGitRef(runner) || `v${version}`));
  } else if (isTrustedPublishAuthFailure(result)) {
    process.stderr.write(renderTrustedPublishHelp());
  }
  if (result.status === 0 && !args.includes('--dry-run')) {
    const verification = verifyPublishedVersionWithRetry(version, runner, {
      attempts: options.verificationAttempts,
      delayMs: options.verificationDelayMs,
    });
    if (verification.ok) {
      process.stdout.write(renderPublishVerification(verification));
      return 0;
    }
    // npm publish already succeeded; the latest read-back just lagged. Confirm the
    // exact version actually landed before failing the job — a red CI for a release
    // that is live on the registry is a false negative, and you cannot un-publish.
    const landed = checkVersionAvailability(version, runner);
    if (landed.reason === 'version_exists') {
      process.stdout.write(renderPublishLatestLag(version, verification));
      return 0;
    }
    process.stderr.write(renderPublishVerification(verification));
    return 1;
  }
  return typeof result.status === 'number' ? result.status : 1;
}

if (require.main === module) {
  process.exitCode = publishAtrisRelease();
}

module.exports = {
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
};
