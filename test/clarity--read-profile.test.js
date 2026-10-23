'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readProfile } = require('../lib/clarity');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-read-profile-'));
}

test('readProfile returns the parsed profile from .atris/clarity.json', () => {
  const root = tmp();
  try {
    fs.mkdirSync(path.join(root, '.atris'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.atris', 'clarity.json'),
      JSON.stringify({ focus: 'ship atris', voice: 'plain', updated_at: '2026-01-01' }),
      'utf8'
    );
    const profile = readProfile(root);
    assert.equal(profile.focus, 'ship atris');
    assert.equal(profile.voice, 'plain');
    assert.equal(profile.updated_at, '2026-01-01');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readProfile returns {} when clarity.json is missing', () => {
  const root = tmp();
  try {
    assert.deepEqual(readProfile(root), {});
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readProfile returns {} when clarity.json is corrupt', () => {
  const root = tmp();
  try {
    fs.mkdirSync(path.join(root, '.atris'), { recursive: true });
    fs.writeFileSync(path.join(root, '.atris', 'clarity.json'), '{ not valid json', 'utf8');
    assert.deepEqual(readProfile(root), {});
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readProfile defaults to process.cwd() when no root is given', () => {
  const root = tmp();
  const prev = process.cwd();
  try {
    fs.mkdirSync(path.join(root, '.atris'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.atris', 'clarity.json'),
      JSON.stringify({ leash: 'proceed and report' }),
      'utf8'
    );
    process.chdir(root);
    const profile = readProfile();
    assert.equal(profile.leash, 'proceed and report');
  } finally {
    process.chdir(prev);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
