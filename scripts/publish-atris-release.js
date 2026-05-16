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

function renderOtpHelp(version) {
  return [
    '',
    'npm publish needs the owner OTP.',
    '',
    `Retry: npm run publish:release -- --otp <code>`,
    `Verify: npm view atris version gitHead --json`,
    '',
    'Playable fallback until npm latest moves:',
    `npm install -g github:atrislabs/atris#v${version}`,
    '',
  ].join('\n');
}

function isOtpFailure(result) {
  const text = `${result.stderr || ''}\n${result.stdout || ''}`;
  return result.status !== 0 && (text.includes('EOTP') || text.toLowerCase().includes('one-time password'));
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
    stdio: 'inherit',
  });
  if (isOtpFailure(result)) {
    console.error(renderOtpHelp(version));
  }
  return result.status || 0;
}

if (require.main === module) {
  process.exitCode = publishAtrisRelease();
}

module.exports = {
  buildPublishArgs,
  isOtpFailure,
  publishAtrisRelease,
  renderOtpHelp,
};
