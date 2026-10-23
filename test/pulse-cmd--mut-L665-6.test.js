'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { installCommand } = require('../commands/pulse');
const libPulse = require('../lib/pulse');

test('install cadence failure surfaces a thrown value that has no message field', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-mut-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-mut-root-'));

  const originalNormalize = libPulse.normalizeCronCadence;
  const originalWrite = process.stdout.write;
  libPulse.normalizeCronCadence = () => {
    throw 'cron backend refused the cadence';
  };
  process.stdout.write = () => true;
  try {
    const out = installCommand(['--cadence', 'bogus'], root, { homeDir });
    assert.strictEqual(out.detail, 'cron backend refused the cadence');
  } finally {
    libPulse.normalizeCronCadence = originalNormalize;
    process.stdout.write = originalWrite;
  }
});
