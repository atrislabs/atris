const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildPublishArgs,
  isOtpFailure,
  renderOtpHelp,
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
  const help = renderOtpHelp('3.15.24');
  assert.match(help, /npm run publish:release -- --otp <code>/);
  assert.match(help, /npm install -g github:atrislabs\/atris#v3\.15\.24/);
  assert.match(help, /npm view atris version gitHead --json/);
});
