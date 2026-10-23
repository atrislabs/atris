const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function capturePlan(input, args = [], files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-atris-'));
  const previous = { cwd: process.cwd(), argv: process.argv, env: { ...process.env }, log: console.log };
  const lines = [];
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('ATRIS_')) delete process.env[key];
    }
    process.env.HOME = root;
    process.env.USER = 'test';
    process.env.LOGNAME = 'test';
    process.chdir(root);
    process.argv = [process.execPath, 'atris', 'plan', ...args];
    fs.mkdirSync(path.join(root, 'atris'));
    for (const [name, content] of Object.entries(files)) {
      const target = path.join(root, 'atris', name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    console.log = (...values) => lines.push(values.join(' '));
    const { planAtris } = require('../commands/workflow');
    const result = await planAtris(input);
    return { result, output: lines.join('\n') };
  } finally {
    console.log = previous.log;
    process.argv = previous.argv;
    process.chdir(previous.cwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in previous.env)) delete process.env[key];
    }
    Object.assign(process.env, previous.env);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// No journal or learnings fixtures: skip date-dependent content and assertions.
test('planAtris renders a direct request with the current navigator and TODO', async () => {
  const { result, output } = await capturePlan('Build a search box', ['--full'], {
    'team/navigator/MEMBER.md': 'Current navigator instructions',
    'team/navigator.md': 'Obsolete navigator instructions',
    'TODO.md': 'Current search tasks',
    'TASK_CONTEXTS.md': 'Obsolete tasks',
  });
  assert.strictEqual(result, undefined);
  assert.match(output, /PROMPT ONLY/);
  assert.match(output, /Direct request:\nBuild a search box/);
  assert.match(output, /Current navigator instructions/);
  assert.match(output, /Current search tasks/);
  assert.doesNotMatch(output, /Obsolete navigator instructions|Obsolete tasks/);
  assert.match(output, /Stop\. Do NOT execute/);
  assert.doesNotMatch(output, /Sounds like you're exploring options/);
});

test('planAtris recognizes uncertainty in an argument request and reads legacy context', async () => {
  const { output } = await capturePlan(null, ['--verbose', 'Maybe', 'add filters'], {
    'team/navigator.md': 'Legacy navigator instructions',
    'TASK_CONTEXTS.md': 'Legacy filter tasks',
  });
  assert.match(output, /Direct request:\nMaybe add filters/);
  assert.match(output, /Sounds like you're exploring options/);
  assert.match(output, /Try `atris brainstorm`/);
  assert.match(output, /Navigator spec: atris\/team\/navigator\.md/);
  assert.match(output, /Legacy navigator instructions/);
  assert.match(output, /Legacy filter tasks/);
});

test('planAtris handles empty planning context without requiring optional files', async () => {
  const { result, output } = await capturePlan(undefined, ['--full']);
  assert.strictEqual(result, undefined);
  assert.match(output, /Navigator spec: atris\/team\/navigator\/MEMBER\.md \(missing\)/);
  assert.match(output, /\(No items in Inbox\)/);
  assert.match(output, /\(No TODO content\)/);
  assert.match(output, /Inbox items: 0/);
  assert.match(output, /generate it from `atris\/atris\.md` before writing tasks/);
  assert.doesNotMatch(output, /DIRECT REQUEST:|Direct request:|Sounds like you're exploring options/);
});
