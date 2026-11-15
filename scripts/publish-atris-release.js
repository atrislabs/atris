#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const readback = require('./npm-publish-readback');

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

function publishAtrisRelease(args = process.argv.slice(2), runner = spawnSync, options = {}) {
  const version = options.version || readPackageVersion();
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
  if (args.includes('--dry-run')) {
    return typeof result.status === 'number' ? result.status : 1;
  }
  // Read back the exact version for a couple of minutes at most. npm can take
  // an hour to show a version it already accepted, so accepted is shipped.
  const shown = result.status === 0
    ? readback.waitForVersion(version, runner, {
      minutes: options.verificationMinutes ?? 2,
      everySeconds: options.verificationEverySeconds ?? 15,
      sleep: options.verificationSleep,
      log: () => {},
    }).state
    : 'missing';
  const outcome = readback.decide(version, result, shown);
  (outcome.exitCode === 0 ? process.stdout : process.stderr).write(`${outcome.line}\n`);
  return outcome.exitCode;
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
  renderTrustedPublishHelp,
  renderVersionAvailabilityFailure,
};
