'use strict';

// Behavior tests for commands/workflow.js — the plan/do/review workflow engine.
//
// Note on scope: commands/workflow.js is not a workflow-definition parser; it is
// the plan -> do -> review command trio plus the cloud tool-relay helpers
// (makeCloudExecutor, postToolResult). Coverage here follows what the file
// actually does:
//   - missing-setup errors are plain sentences, not stack traces
//   - plan/do/review prompt-mode output shapes on a real initialized workspace
//   - workspace state feeding behavior (inbox uncertainty, MAP placeholder,
//     feature build plans, journal completions -> handoff hint)
//   - flag handling (--full, --help)
//   - cloud executor request translation + failure handling (a failing relayed
//     command surfaces status error with the reason, never a throw)
//   - postToolResult wire shape and non-200 rejection
// Every CLI spawn runs in its own temp cwd.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'atris.js');

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-workflow-test-'));
  tempDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function runCli(args, { cwd, input } = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    input: input === undefined ? '' : input,
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
    },
  });
  if (result.error) throw result.error;
  return result;
}

// One initialized workspace, built once; tests clone it so mutations stay isolated.
let goldenDir = null;
function initializedWorkspace() {
  if (!goldenDir) {
    goldenDir = makeTempDir();
    const res = runCli(['init', '--yes'], { cwd: goldenDir, input: '\n' });
    assert.equal(res.status, 0, `init failed: ${res.stderr}\n${res.stdout}`);
  }
  const clone = makeTempDir();
  fs.cpSync(goldenDir, clone, { recursive: true });
  return clone;
}

function todayLogFile(dir) {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const yearDir = path.join(dir, 'atris', 'logs', year);
  fs.mkdirSync(yearDir, { recursive: true });
  return path.join(yearDir, `${year}-${month}-${day}.md`);
}

test('plan in an uninitialized directory gives a plain error, not a stack trace', () => {
  const dir = makeTempDir();
  const res = runCli(['plan'], { cwd: dir });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /navigator\.md not found/);
  assert.match(res.stdout, /atris init/);
  const combined = res.stdout + res.stderr;
  assert.ok(!/at .*workflow\.js:\d+/.test(combined), `stack trace leaked:\n${combined}`);
});

test('do in an uninitialized directory gives a plain error, not a stack trace', () => {
  const dir = makeTempDir();
  const res = runCli(['do'], { cwd: dir });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /executor\.md not found/);
  const combined = res.stdout + res.stderr;
  assert.ok(!/at .*workflow\.js:\d+/.test(combined), `stack trace leaked:\n${combined}`);
});

test('plan on an initialized workspace prints the navigator prompt shape', () => {
  const dir = initializedWorkspace();
  const res = runCli(['plan'], { cwd: dir });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Atris Plan — Navigator Agent Activated/);
  assert.match(res.stdout, /CONTEXT FILES \(agent should read\):/);
  assert.match(res.stdout, /COPY\/PASTE PROMPT FOR YOUR CODING AGENT:/);
  assert.match(res.stdout, /You are the Navigator\./);
  // Step sequence: visualize -> confidence gate -> tasks -> log -> stop.
  assert.match(res.stdout, /1\) ASCII visualize \+ wait for approval/);
  assert.match(res.stdout, /Confidence Gate/);
  assert.match(res.stdout, /3\) Write tasks to atris\/TODO\.md under ## Backlog/);
  assert.match(res.stdout, /5\) Stop\. Do NOT execute/);
  assert.match(res.stdout, /Inbox items: \d+/);
});

test('plan reads inbox state: uncertainty in the journal triggers the brainstorm suggestion', () => {
  const dir = initializedWorkspace();
  fs.writeFileSync(
    todayLogFile(dir),
    '# Journal\n\n## Inbox\n- not sure if we should rewrite the parser\n- maybe split the module\n\n## Notes\n'
  );
  const res = runCli(['plan'], { cwd: dir });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /atris brainstorm/);
  assert.match(res.stdout, /Inbox items: 2/);
});

test('plan flags a placeholder MAP.md so agents generate it before writing tasks', () => {
  const dir = initializedWorkspace();
  fs.writeFileSync(
    path.join(dir, 'atris', 'MAP.md'),
    '# MAP\n\nGenerated by your AI agent after reading atris.md\n'
  );
  const res = runCli(['plan'], { cwd: dir });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /placeholder — generate first/);
  assert.match(res.stdout, /missing or placeholder, generate it/);
});

test('plan --full dumps the actual navigator spec content', () => {
  const dir = initializedWorkspace();
  const marker = 'WORKFLOW-TEST-NAVIGATOR-MARKER-9271';
  const navigatorFile = fs.existsSync(path.join(dir, 'atris', 'team', 'navigator', 'MEMBER.md'))
    ? path.join(dir, 'atris', 'team', 'navigator', 'MEMBER.md')
    : path.join(dir, 'atris', 'team', 'navigator.md');
  fs.appendFileSync(navigatorFile, `\n${marker}\n`);

  const brief = runCli(['plan'], { cwd: dir });
  assert.equal(brief.status, 0, brief.stderr);
  assert.ok(!brief.stdout.includes(marker), 'default plan should not dump the full spec');

  const full = runCli(['plan', '--full'], { cwd: dir });
  assert.equal(full.status, 0, full.stderr);
  assert.match(full.stdout, /NAVIGATOR SPEC \(full\):/);
  assert.ok(full.stdout.includes(marker), '--full should include the spec content');
});

test('do prints the executor prompt shape and surfaces feature build plans', () => {
  const dir = initializedWorkspace();
  const featureDir = path.join(dir, 'atris', 'features', 'sample-feature');
  fs.mkdirSync(featureDir, { recursive: true });
  fs.writeFileSync(path.join(featureDir, 'build.md'), '# build plan\n');

  const res = runCli(['do'], { cwd: dir });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Atris Do — Executor Agent Activated/);
  assert.match(res.stdout, /You are the Executor\./);
  assert.match(res.stdout, /claim next unclaimed Backlog task/);
  assert.match(res.stdout, /Do NOT plan — just execute/);
  assert.match(res.stdout, /Feature build plans found: 1/);
  assert.match(res.stdout, /sample-feature[\/\\]build\.md/);
});

test('review --verbose prints the validator prompt and reacts to journal completions', () => {
  const dir = initializedWorkspace();
  fs.writeFileSync(
    todayLogFile(dir),
    '# Journal\n\n## Completed ✅\n- **C1:** shipped the fixture\n\n## Notes\n'
  );
  const res = runCli(['review', '--verbose'], { cwd: dir });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Atris Review — Validator Agent Activated/);
  assert.match(res.stdout, /You are the Validator\./);
  assert.match(res.stdout, /Run the project test suite/);
  assert.match(res.stdout, /atris task render --out atris\/TODO\.md/);
  // Journal has completions but no handoff yet -> handoff nudge.
  assert.match(res.stdout, /SESSION HANDOFF/);
});

test('help smokes: plan --help exits clean and top-level help lists the workflow trio', () => {
  const dir = makeTempDir();
  const planHelp = runCli(['plan', '--help'], { cwd: dir });
  assert.equal(planHelp.status, 0, planHelp.stderr);
  assert.match(planHelp.stdout, /plan/i);

  const help = runCli(['help'], { cwd: dir });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Golden path:/);
  assert.match(help.stdout, /atris review/);

  const allHelp = runCli(['help', '--all'], { cwd: dir });
  assert.equal(allHelp.status, 0, allHelp.stderr);
  assert.match(allHelp.stdout, /plan\s+- /);
  assert.match(allHelp.stdout, /do\s+- /);
  assert.match(allHelp.stdout, /review\s+- /);
});

// ---- cloud relay helpers (in-process unit tests) ----

function stubTerminal(impl) {
  const terminalPath = require.resolve('../commands/terminal');
  const previous = require.cache[terminalPath];
  require.cache[terminalPath] = {
    id: terminalPath,
    filename: terminalPath,
    loaded: true,
    exports: { runTerminalCommand: impl },
  };
  return () => {
    if (previous) require.cache[terminalPath] = previous;
    else delete require.cache[terminalPath];
  };
}

test('cloud executor rejects unsupported tools and path traversal without throwing', async () => {
  const calls = [];
  const restore = stubTerminal(async (...args) => {
    calls.push(args);
    return { ok: true, data: { stdout: '', stderr: '', exit_code: 0 } };
  });
  try {
    const { makeCloudExecutor } = require('../commands/workflow');
    const exec = makeCloudExecutor({ token: 't', businessId: 'b', workspaceId: 'w', slug: 'acme' });

    const wrongTool = await exec('some_other_tool', { type: 'read', path: 'a.txt' });
    assert.equal(wrongTool.status, 'error');
    assert.match(wrongTool.error, /unsupported relayed tool/);

    const traversal = await exec('local_file_op', { type: 'read', path: '../secrets' });
    assert.equal(traversal.status, 'error');
    assert.match(traversal.error, /unsupported op or unsafe path/);

    const unknownOp = await exec('local_file_op', { type: 'teleport', path: 'a.txt' });
    assert.equal(unknownOp.status, 'error');

    assert.equal(calls.length, 0, 'refused ops must never reach the cloud terminal');
  } finally {
    restore();
  }
});

test('cloud executor translates a write into base64-safe shell and maps results by op', async () => {
  const commands = [];
  let nextResult = { ok: true, data: { stdout: 'file body', stderr: '', exit_code: 0 } };
  const restore = stubTerminal(async (token, businessId, workspaceId, command) => {
    commands.push(command);
    return nextResult;
  });
  try {
    const { makeCloudExecutor } = require('../commands/workflow');
    const exec = makeCloudExecutor({ token: 't', businessId: 'b', workspaceId: 'w', slug: 'acme' });

    const content = "it's got 'quotes' and\nnewlines";
    const write = await exec('local_file_op', { type: 'write', path: 'notes.md', content });
    assert.deepEqual(write, { status: 'ok', path: 'notes.md' });
    const b64 = Buffer.from(content, 'utf8').toString('base64');
    assert.ok(commands[0].includes(b64), 'content must travel base64, not raw shell text');
    assert.match(commands[0], /base64 -d > 'notes\.md'/);

    const read = await exec('local_file_op', { type: 'read', path: 'notes.md' });
    assert.equal(read.status, 'ok');
    assert.equal(read.content, 'file body');
  } finally {
    restore();
  }
});

test('cloud executor failure handling: nonzero exit halts with the reason recorded', async () => {
  const restore = stubTerminal(async () => ({
    ok: true,
    data: { stdout: '', stderr: 'grep: bad pattern', exit_code: 2 },
  }));
  try {
    const { makeCloudExecutor } = require('../commands/workflow');
    const exec = makeCloudExecutor({ token: 't', businessId: 'b', workspaceId: 'w', slug: 'acme' });
    const result = await exec('local_file_op', { type: 'bash', command: 'grep [ file' });
    assert.equal(result.status, 'error');
    assert.equal(result.exit_code, 2);
    assert.match(result.error, /bad pattern/);
  } finally {
    restore();
  }
});

test('postToolResult posts the base64 tool-result body and rejects on non-200', async () => {
  process.env.ATRIS_TOOL_RESULT_B64 = '1';
  const { postToolResult } = require('../commands/workflow');
  const bodies = [];
  let respondWith = 200;
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      bodies.push({ url: req.url, body: JSON.parse(data) });
      res.statusCode = respondWith;
      res.end(respondWith === 200 ? '' : 'boom');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    await postToolResult('call-1', { status: 'ok', stdout: 'hi' }, base);
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].url, '/api/atris2/turn/tool-result');
    assert.equal(bodies[0].body.call_id, 'call-1');
    assert.equal(bodies[0].body.output_encoding, 'base64');
    const decoded = JSON.parse(Buffer.from(bodies[0].body.result, 'base64').toString('utf8'));
    assert.deepEqual(decoded, { status: 'ok', stdout: 'hi' });

    respondWith = 500;
    await assert.rejects(
      () => postToolResult('call-2', { status: 'ok' }, base),
      /tool-result HTTP 500/
    );
  } finally {
    server.close();
  }
});
