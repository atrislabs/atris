'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const [run] = Object.values(require('../commands/launchpad'));

test('renders fallback explanation text when no task or mission is active', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'run-card-'));
  const origCwd = process.cwd();
  const origHome = process.env.HOME;
  process.env.HOME = tmp;

  fs.mkdirSync(path.join(tmp, 'atris'));
  fs.mkdirSync(path.join(tmp, '.atris', 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, '.atris', 'state', 'tasks.projection.json'),
    JSON.stringify({ tasks: [] })
  );

  let out = '';
  const origWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    out += chunk;
    return true;
  };

  try {
    process.chdir(tmp);
    run([]);
  } finally {
    process.stdout.write = origWrite;
    process.chdir(origCwd);
    process.env.HOME = origHome || tmp;
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  assert.ok(out.includes('No task, mission'));
  assert.ok(!out.includes('[object Object]'));
});
