'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('onboarding preserves the supplied role in the contact page', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'business-contact-role-'));
  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  try {
    // Keep all onboarding state, including the task database, in this fixture.
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.HOME = root;
    process.env.ATRIS_TASKS_DB = path.join(root, 'tasks.db');
    process.env.ATRIS_TEST_STATE_DIR = root;
    process.chdir(root);
    fs.mkdirSync(path.join(root, '.atris'));
    fs.mkdirSync(path.join(root, 'atris', 'reports'), { recursive: true });
    fs.mkdirSync(path.join(root, 'atris', 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(root, 'atris', 'wiki', 'index.md'), '# Wiki\n');
    fs.writeFileSync(path.join(root, '.atris', 'business.json'), JSON.stringify({
      name: 'Fixture Bakery',
      slug: 'fixture-bakery',
    }));

    const { onboardBusiness } = require('../commands/business');
    await onboardBusiness('--contact', 'Avery Stone', '--role', 'Operations director');

    const page = fs.readFileSync(path.join(root, 'atris', 'wiki', 'people', 'avery-stone.md'), 'utf8');
    assert.deepEqual(page.split('\n').filter(line => line.startsWith('- Role:')), [
      '- Role: Operations director',
    ]);
  } finally {
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousEnv);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
