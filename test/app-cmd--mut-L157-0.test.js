'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { appCommand } = require('../commands/app');

const EXPECTED_APP_MD = `---
schema_version: 1
name: demo-app
slug: demo-app
description: One-line description of what demo-app does.
access: business
runtime: template
vault: atris-kms
runtime_auth: jwt
access: public
secrets: []
surfaces: [web]
render: none
monetization:
  price_credits: 5
  creator_share: 0.8
---
# demo-app

What this app does, step by step.

1. First action (reference secrets by name like \`MY_API_KEY\`).
2. Second action.
3. Where the output goes.

## Guardrails

- What this app will never do.
- What happens when a secret is missing.
`;

test('app init --runtime template writes the template manifest', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-app-cmd-mut-L157-'));
  fs.mkdirSync(path.join(root, 'atris'), { recursive: true });
  fs.writeFileSync(path.join(root, 'atris', 'atris.md'), '# test workspace\n');

  const cwd = process.cwd();
  const origLog = console.log;
  const origError = console.error;
  const origExit = process.exit;
  console.log = () => {};
  console.error = () => {};
  process.exit = (code) => {
    throw new Error(`exit:${code}`);
  };
  process.chdir(root);

  try {
    await appCommand('init', 'demo-app', '--runtime', 'template');
    const appMd = fs.readFileSync(path.join(root, 'apps', 'demo-app', 'APP.md'), 'utf8');
    assert.strictEqual(appMd, EXPECTED_APP_MD);
  } finally {
    console.log = origLog;
    console.error = origError;
    process.exit = origExit;
    process.chdir(cwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
