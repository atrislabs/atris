const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { INTENTS } = require('../lib/intents');

const cliPath = path.join(__dirname, '..', 'bin', 'atris.js');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atris-init-for-agents-'));
}

function cleanup(dir) {
  if (dir && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('init writes FOR_AGENTS and the AGENTS adapter breadcrumb', () => {
  const tempDir = createTempDir();
  const homeDir = path.join(tempDir, 'home');
  fs.mkdirSync(homeDir);

  try {
    const result = spawnSync(process.execPath, [cliPath, 'init'], {
      cwd: tempDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        ATRIS_SKIP_UPDATE_CHECK: '1',
        HOME: homeDir,
      },
    });

    assert.equal(
      result.status,
      0,
      `init failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );

    const forAgentsPath = path.join(tempDir, 'atris', 'FOR_AGENTS.md');
    assert.equal(fs.existsSync(forAgentsPath), true);
    const forAgentsContent = fs.readFileSync(forAgentsPath, 'utf8');
    assert.ok(forAgentsContent.trim().length > 0);
    assert.match(forAgentsContent, /what changes, why it matters, and\nwhat done looks like/i);
    assert.match(forAgentsContent, /exact title, files, commands, requirements,\nevents, proof, and approval rules/i);

    const agentsPath = path.join(tempDir, 'AGENTS.md');
    const agentsContent = fs.readFileSync(agentsPath, 'utf8');
    assert.ok(agentsContent.includes('FOR_AGENTS.md'));
    assert.match(agentsContent, /## You translate/);
    assert.match(agentsContent, /atris guide/);
    assert.match(agentsContent, /asks you first/);
    assert.match(agentsContent, /Never end a reply with a command/);
    assert.ok(agentsContent.includes(INTENTS[0].say[0]));
    assert.match(agentsContent, /Every created task leads with three plain fields/);
    assert.match(agentsContent, /accept\/revise gates and never skips proof/);

    const claudeContent = fs.readFileSync(path.join(tempDir, 'CLAUDE.md'), 'utf8');
    assert.match(claudeContent, /The person does not know atris words\./);
    assert.match(claudeContent, /atris guide "<their words>"/);
    assert.match(result.stdout, /no commands to learn\. tell your agent what you want in plain words\./);

    const policyContent = fs.readFileSync(path.join(tempDir, 'atris', 'atris.md'), 'utf8');
    assert.match(policyContent, /The three plain fields are the default face on every task view/);
    assert.match(policyContent, /exact\ntitle, context, requirements, files, events, proof, and verifier stay beneath\nthem unchanged/);
  } finally {
    cleanup(tempDir);
  }
});
