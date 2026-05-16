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
  return result.status !== 0
    && process.env.GITHUB_ACTIONS === 'true'
    && text.includes('npm error code E404')
    && text.includes('could not be found or you do not have permission');
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

function renderPublishVerification(verification) {
  if (verification.ok) {
    return `Verified npm latest: atris@${verification.actual} gitHead ${verification.gitHead || 'unknown'}\n`;
  }
  return `npm latest verification failed: expected ${verification.expected || 'unknown'}, got ${verification.actual || verification.error || 'unknown'}\n`;
}

function publishAtrisRelease(args = process.argv.slice(2), runner = spawnSync) {
  const version = readPackageVersion();
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: npm run publish:release -- [--otp <code>] [--dry-run]');
    console.log('');
    console.log('Publishes the atris npm package and prints the AgentXP fallback if npm asks for OTP.');
    return 0;
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
    const verification = verifyPublishedVersion(version, runner);
    const output = renderPublishVerification(verification);
    if (verification.ok) process.stdout.write(output);
    else process.stderr.write(output);
    return verification.ok ? 0 : 1;
  }
  return typeof result.status === 'number' ? result.status : 1;
}

if (require.main === module) {
  process.exitCode = publishAtrisRelease();
}

module.exports = {
  buildPublishArgs,
  currentGitRef,
  isOtpFailure,
  isTrustedPublishAuthFailure,
  publishAtrisRelease,
  renderOtpHelp,
  renderPublishVerification,
  renderTrustedPublishHelp,
  verifyPublishedVersion,
};
