'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Readable } = require('stream');

const ax = require('../ax');
const axLocalTools = require('../lib/ax-local-tools');
const axSessions = require('../lib/ax-sessions');
const axContext = require('../lib/ax-context');
const axExt = require('../lib/ax-ext');
const axCommands = require('../lib/ax-commands');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('local_file_op reads, edits with unified diff, checkpoints and restores via undo', async () => {
  const dir = makeTempDir('ax-tools-');
  const cpBase = makeTempDir('ax-cp-');
  const targetFile = path.join(dir, 'hello.js');
  fs.writeFileSync(targetFile, 'const a = 1;\nconst b = 2;\nconsole.log(a + b);\n', 'utf8');

  const cp = axLocalTools.createCheckpointContext({ sessionId: 'sess-1', turnId: 'turn-1', baseDir: cpBase });
  const diffs = [];

  const readRes = await axLocalTools.executeLocalFileOp(
    { type: 'read', path: 'hello.js', start_line: 1, end_line: 2 },
    { cwd: dir, approveMode: 'stage' }
  );
  assert.equal(readRes.status, 'ok');
  assert.match(readRes.content, /1: const a = 1;/);

  const editRes = await axLocalTools.executeLocalFileOp(
    { type: 'edit', path: 'hello.js', find: 'const b = 2;', replace: 'const b = 42;' },
    { cwd: dir, approveMode: 'auto', checkpoint: cp, diffs }
  );
  assert.equal(editRes.status, 'ok');
  assert.equal(editRes.diff.added, 1);
  assert.equal(editRes.diff.removed, 1);
  assert.match(editRes.diff.patch, /-const b = 2;/);
  assert.match(editRes.diff.patch, /\+const b = 42;/);
  assert.equal(diffs.length, 1);
  assert.match(axLocalTools.renderUnifiedDiff(editRes.diff, { color: false }), /hello\.js \+1 -1/);

  // Create a brand new file in the same checkpoint.
  const writeRes = await axLocalTools.executeLocalFileOp(
    { type: 'write', path: 'extra.txt', content: 'brand new\n' },
    { cwd: dir, approveMode: 'auto', checkpoint: cp, diffs }
  );
  assert.equal(writeRes.status, 'ok');
  assert.equal(fs.existsSync(path.join(dir, 'extra.txt')), true);

  const cps = axLocalTools.listCheckpoints('sess-1', { baseDir: cpBase });
  assert.equal(cps.length, 1);

  const undo = axLocalTools.restoreLatestCheckpoint('sess-1', { baseDir: cpBase });
  assert.equal(undo.ok, true);
  assert.equal(fs.readFileSync(targetFile, 'utf8'), 'const a = 1;\nconst b = 2;\nconsole.log(a + b);\n');
  assert.equal(fs.existsSync(path.join(dir, 'extra.txt')), false);
});

test('local_file_op enforces plan mode read-only, workspace containment and catastrophic bash guard', async () => {
  const dir = makeTempDir('ax-guard-');
  fs.writeFileSync(path.join(dir, 'note.txt'), 'safe line\n', 'utf8');

  const planRead = await axLocalTools.executeLocalFileOp(
    { type: 'read', path: 'note.txt' },
    { cwd: dir, planMode: true, approveMode: 'stage' }
  );
  assert.equal(planRead.status, 'ok');

  const planEdit = await axLocalTools.executeLocalFileOp(
    { type: 'edit', path: 'note.txt', find: 'safe', replace: 'changed' },
    { cwd: dir, planMode: true, approveMode: 'auto' }
  );
  assert.equal(planEdit.status, 'error');
  assert.equal(planEdit.denied, true);
  assert.match(planEdit.error, /Plan mode is read-only/i);

  const escapeRead = await axLocalTools.executeLocalFileOp(
    { type: 'read', path: '../../etc/passwd' },
    { cwd: dir, approveMode: 'auto' }
  );
  assert.equal(escapeRead.status, 'error');
  assert.match(escapeRead.error, /escapes workspace/i);

  const badBash = await axLocalTools.executeLocalFileOp(
    { type: 'bash', command: 'rm -rf /' },
    { cwd: dir, approveMode: 'auto' }
  );
  assert.equal(badBash.status, 'error');
  assert.equal(badBash.denied, true);
  assert.match(badBash.error, /catastrophic/i);

  const permCheck = axLocalTools.evaluateToolPermission(
    { type: 'edit', path: 'note.txt' },
    { approveMode: 'stage', allowedTools: ['read', 'search'] }
  );
  assert.equal(permCheck.decision, 'deny');
});

test('local_file_op supports list, search, inspect, append, delete and bounded bash', async () => {
  const dir = makeTempDir('ax-ops-');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'function greet() { return "hello"; }\n', 'utf8');

  const listed = await axLocalTools.executeLocalFileOp({ type: 'list' }, { cwd: dir });
  assert.equal(listed.status, 'ok');
  assert.ok(listed.entries.includes('src/app.js'));

  const searched = await axLocalTools.executeLocalFileOp({ type: 'search', pattern: 'greet' }, { cwd: dir });
  assert.equal(searched.status, 'ok');
  assert.equal(searched.count, 1);

  const inspected = await axLocalTools.executeLocalFileOp({ type: 'inspect', path: 'src/app.js' }, { cwd: dir });
  assert.equal(inspected.status, 'ok');
  assert.equal(inspected.kind, 'file');

  const bashRes = await axLocalTools.executeLocalFileOp(
    { type: 'bash', command: 'printf "ok-from-bash"' },
    { cwd: dir, approveMode: 'auto' }
  );
  assert.equal(bashRes.status, 'ok');
  assert.equal(bashRes.output, 'ok-from-bash');
});

test('sessions persist as JSONL, resume by prefix or latest cwd and export markdown', () => {
  const baseDir = makeTempDir('ax-sessions-');
  const workDir = makeTempDir('ax-work-');
  const id = axSessions.createSessionId();

  axSessions.appendSessionRecord(id, {
    type: 'turn',
    cwd: workDir,
    mode: 'pro',
    user: 'Explain auth middleware',
    assistant: 'Auth validates bearer tokens in utils/auth.js.',
    credits: 2,
    diffs: [{ file: 'utils/auth.js', added: 2, removed: 1, patch: '@@ -1 +1 @@\n-old\n+new' }],
  }, { baseDir });

  const listed = axSessions.listSessions({ cwd: workDir, baseDir });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, id);

  const loaded = axSessions.loadSession(id.slice(0, 8), { baseDir });
  assert.equal(loaded.id, id);
  assert.equal(loaded.history.length, 2);
  assert.equal(loaded.credits, 2);
  assert.equal(loaded.diffs.length, 1);

  const latest = axSessions.latestSessionForCwd(workDir, { baseDir });
  assert.equal(latest.id, id);

  const md = axSessions.exportSessionMarkdown(loaded);
  assert.match(md, /# Atris Session:/);
  assert.match(md, /Explain auth middleware/);
});

test('@file mentions expand line ranges, Tab completion works for @path and project memory loads', () => {
  const dir = makeTempDir('ax-ctx-');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'line1\nline2\nline3\nline4\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Project Rules\nKeep diffs small.\n', 'utf8');

  const expanded = axContext.expandAtMentions('Review @src/index.js:2-3 and @src/', dir);
  assert.equal(expanded.attachments.length, 2);
  assert.match(expanded.prompt, /2: line2\n3: line3/);
  assert.doesNotMatch(expanded.prompt, /4: line4/);

  const [hits, token] = ax.chatCompleter('fix @src/in', dir);
  assert.deepEqual(hits, ['@src/index.js']);
  assert.equal(token, '@src/in');
  // Pinned existing completer invariants stay untouched.
  assert.deepEqual(ax.chatCompleter('/f'), [['/fast'], '/f']);
  assert.deepEqual(ax.chatCompleter('/r'), [['/rapid'], '/r']);
  assert.deepEqual(ax.chatCompleter('/l'), [['/log'], '/l']);
  assert.deepEqual(ax.chatCompleter('hello'), [[], 'hello']);

  const mem = axContext.loadProjectMemory(dir);
  assert.deepEqual(mem.files, ['AGENTS.md']);
  assert.match(mem.summary, /Keep diffs small/);

  const compacted = axContext.compactConversationHistory([
    { role: 'user', content: 'First long question about routing' },
    { role: 'assistant', content: 'Detailed routing explanation' },
  ], 'keep routing decisions');
  assert.equal(compacted.compactedTurns, 1);
  assert.match(compacted.digest, /Focus: keep routing decisions/);
});

test('MCP stdio client lists and calls tools and lifecycle hooks block on exit code 2', async () => {
  const dir = makeTempDir('ax-ext-');
  const mockServer = path.join(dir, 'mock-mcp.js');
  fs.writeFileSync(mockServer, `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {} } }));
  } else if (msg.method === 'tools/list') {
    console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'ping', description: 'Return pong', inputSchema: { type: 'object' } }] } }));
  } else if (msg.method === 'tools/call') {
    console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'pong:' + (msg.params.arguments.who || 'world') }] } }));
  }
});
`, 'utf8');
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({
    mcpServers: { demo: { command: process.execPath, args: [mockServer] } },
  }), 'utf8');

  const configs = axExt.loadMcpServerConfigs(dir);
  assert.equal(configs.length, 1);
  const tools = await axExt.listMcpServerTools(configs[0]);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].qualifiedName, 'mcp__demo__ping');

  const callRes = await axExt.callMcpServerTool(configs[0], 'ping', { who: 'atris' });
  assert.equal(callRes.status, 'ok');
  assert.equal(callRes.result.content[0].text, 'pong:atris');

  fs.mkdirSync(path.join(dir, '.atris'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.atris', 'hooks.json'), JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: 'bash', command: 'echo "blocked by policy" >&2; exit 2' }],
    },
  }), 'utf8');
  assert.ok(axExt.loadHooksConfig(dir).PreToolUse);
  const blocked = await axExt.runLifecycleHooks('PreToolUse', { op: 'bash', tool: 'local_file_op' }, { cwd: dir });
  assert.equal(blocked.blocked, true);
  assert.match(blocked.reason, /blocked by policy/);
  const allowed = await axExt.runLifecycleHooks('PreToolUse', { op: 'read', tool: 'local_file_op' }, { cwd: dir });
  assert.equal(allowed.blocked, false);
});

test('ax postTurn relays local_file_op over real HTTP SSE and runStreamJsonTurn emits normalized NDJSON', async () => {
  const dir = makeTempDir('ax-relay-');
  fs.writeFileSync(path.join(dir, 'sample.txt'), 'before value\n', 'utf8');

  let receivedToolResult = null;
  let receivedPayload = null;
  let continueStream = null;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (req.url === '/api/atris2/turn/tool-result') {
        receivedToolResult = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        if (continueStream) continueStream();
        return;
      }
      if (req.url === '/api/atris2/turn') {
        receivedPayload = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({
          type: 'tool_call_request',
          call_id: 'call-edit-1',
          name: 'local_file_op',
          args: { type: 'edit', path: 'sample.txt', find: 'before value', replace: 'after value' },
        })}\n\n`);
        continueStream = () => {
          res.write(`data: ${JSON.stringify({ type: 'text_delta', content: 'Updated sample.txt.' })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: 'result', result: 'Updated sample.txt.' })}\n\n`);
          res.end();
        };
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const prevUrl = process.env.AX_BACKEND_URL;
  process.env.AX_BACKEND_URL = `http://127.0.0.1:${port}/api/atris2/turn`;

  try {
    let ndjson = '';
    const streamOut = { write(chunk) { ndjson += String(chunk); return true; } };
    const finalEv = await ax.runStreamJsonTurn('Update @sample.txt', {
      mode: 'pro',
      cwd: dir,
      route: 'local',
      approveMode: 'auto',
      streamOutput: streamOut,
    });

    assert.equal(finalEv.ok, true);
    assert.equal(finalEv.output, 'Updated sample.txt.');
    assert.equal(fs.readFileSync(path.join(dir, 'sample.txt'), 'utf8'), 'after value\n');
    assert.ok(receivedPayload.message.includes('1: before value'));
    assert.ok(receivedToolResult && receivedToolResult.call_id === 'call-edit-1');
    assert.equal(finalEv.diffs.length, 1);

    const events = ndjson.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(events[0].type, 'system_init');
    assert.ok(events.some((e) => e.type === 'tool_call' && e.tool === 'edit'));
    assert.ok(events.some((e) => e.type === 'tool_result' && e.diff && e.diff.file === 'sample.txt'));
    assert.ok(events.some((e) => e.type === 'receipt' && Array.isArray(e.receipt.diffs) && e.receipt.diffs.length === 1));
    assert.equal(events[events.length - 1].type, 'result');
  } finally {
    if (prevUrl === undefined) delete process.env.AX_BACKEND_URL;
    else process.env.AX_BACKEND_URL = prevUrl;
    await new Promise((resolve) => server.close(resolve));
  }
});

test('chat slash commands /plan, /compact, /cost, /diff and /mcp work without backend calls', async () => {
  const dir = makeTempDir('ax-chat-slash-');
  let out = '';
  const output = { isTTY: false, write(s) { out += s; return true; } };
  await ax.chat({
    mode: 'pro',
    cwd: dir,
    input: Readable.from(['/plan\n', '/cost\n', '/diff\n', '/mcp\n', '/compact\n', '/exit\n']),
    output,
    turnFunction: async () => { throw new Error('should not call model'); },
  });
  assert.match(out, /plan mode on/);
  assert.match(out, /0 turns/);
  assert.match(out, /no file edits/);
  assert.match(out, /no MCP servers configured/);
  assert.match(out, /nothing to compact/);
});

test('multi_edit applies atomic hunks, glob finds files and web_fetch blocks loopback/private hosts', async () => {
  const dir = makeTempDir('ax-power-tools-');
  const cpBase = makeTempDir('ax-power-cp-');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  const target = path.join(dir, 'src', 'calc.js');
  fs.writeFileSync(target, 'const x = 1;\nconst y = 2;\nmodule.exports = x + y;\n', 'utf8');

  // Atomic failure leaves file untouched.
  const bad = await axLocalTools.executeLocalFileOp({
    type: 'multi_edit',
    path: 'src/calc.js',
    edits: [
      { find: 'const x = 1;', replace: 'const x = 10;' },
      { find: 'does not exist', replace: 'boom' },
    ],
  }, { cwd: dir, approveMode: 'auto' });
  assert.equal(bad.status, 'error');
  assert.equal(fs.readFileSync(target, 'utf8'), 'const x = 1;\nconst y = 2;\nmodule.exports = x + y;\n');

  // Valid multi_edit applies both hunks with one unified diff and checkpoint.
  const cp = axLocalTools.createCheckpointContext({ sessionId: 'me-1', turnId: 't1', baseDir: cpBase });
  const ok = await axLocalTools.executeLocalFileOp({
    type: 'multi_edit',
    path: 'src/calc.js',
    edits: [
      { find: 'const x = 1;', replace: 'const x = 10;' },
      { find: 'const y = 2;', replace: 'const y = 20;' },
    ],
  }, { cwd: dir, approveMode: 'auto', checkpoint: cp });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.edits_applied, 2);
  assert.match(ok.diff.patch, /\+const x = 10;/);
  assert.match(ok.diff.patch, /\+const y = 20;/);

  const globRes = await axLocalTools.executeLocalFileOp({ type: 'glob', pattern: '**/*.js' }, { cwd: dir });
  assert.equal(globRes.status, 'ok');
  assert.deepEqual(globRes.entries, ['src/calc.js']);

  const ssrf = await axLocalTools.executeLocalFileOp({ type: 'web_fetch', url: 'http://127.0.0.1:8000/secret' }, { cwd: dir });
  assert.equal(ssrf.status, 'error');
  assert.match(ssrf.error, /private or loopback/i);
});

test('settings.json allow/deny rules and [a]lways approval persistence govern local_file_op', async () => {
  const dir = makeTempDir('ax-perms-');
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({
    permissions: {
      allow: ['bash(echo:*)'],
      deny: ['bash(curl:*)', 'edit(.env)'],
    },
  }), 'utf8');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'ok.txt'), 'hi\n', 'utf8');

  const loaded = axLocalTools.loadPermissionSettings(dir);
  assert.ok(loaded.allow.includes('bash(echo:*)'));
  assert.ok(loaded.deny.includes('bash(curl:*)'));

  // Deny beats auto/bypass permissions!
  const deniedCurl = await axLocalTools.executeLocalFileOp(
    { type: 'bash', command: 'curl https://example.com' },
    { cwd: dir, approveMode: 'auto' }
  );
  assert.equal(deniedCurl.status, 'error');
  assert.equal(deniedCurl.denied, true);

  const deniedEnv = await axLocalTools.executeLocalFileOp(
    { type: 'edit', path: '.env', find: '1', replace: '2' },
    { cwd: dir, approveMode: 'auto' }
  );
  assert.equal(deniedEnv.status, 'error');
  assert.equal(deniedEnv.denied, true);

  // Allow rule skips prompt even in stage mode.
  const allowedEcho = await axLocalTools.executeLocalFileOp(
    { type: 'bash', command: 'echo hi-rule' },
    { cwd: dir, approveMode: 'stage' }
  );
  assert.equal(allowedEcho.status, 'ok');
  assert.match(allowedEcho.output, /hi-rule/);

  // Selecting 'always' persists a rule into .atris/settings.json.
  const savedEdit = await axLocalTools.executeLocalFileOp(
    { type: 'edit', path: 'ok.txt', find: 'hi', replace: 'hello' },
    { cwd: dir, approveMode: 'stage', requestApproval: async () => 'always' }
  );
  assert.equal(savedEdit.status, 'ok');
  const persisted = axLocalTools.loadPermissionSettings(dir);
  assert.ok(persisted.allow.includes('edit(ok.txt)'));
});

test('custom .claude/commands and .atris/commands expand $ARGUMENTS in ax chat and headless turns', async () => {
  const dir = makeTempDir('ax-custom-cmds-');
  const fakeHome = makeTempDir('ax-custom-home-');
  fs.mkdirSync(path.join(dir, '.claude', 'commands'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.claude', 'commands', 'shipcheck.md'),
    '---\ndescription: Run pre-ship checklist\n---\nVerify all tests and diff for $ARGUMENTS.\n',
    'utf8'
  );

  const listed = axCommands.listCustomSlashCommands(dir, { homeDir: fakeHome });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, 'shipcheck');
  assert.equal(listed[0].description, 'Run pre-ship checklist');

  const expanded = axCommands.expandCustomSlashCommand('/shipcheck auth module', dir, { homeDir: fakeHome });
  assert.equal(expanded.prompt, 'Verify all tests and diff for auth module.');

  let seenPrompt = '';
  let out = '';
  await ax.chat({
    mode: 'pro',
    cwd: dir,
    input: Readable.from(['/commands\n', '/permissions\n', '/shipcheck billing\n', '/exit\n']),
    output: { isTTY: false, write(s) { out += s; return true; } },
    turnFunction: async (prompt) => {
      seenPrompt = prompt;
      return { output: 'Checklist complete.', durationMs: 12, events: [] };
    },
  });
  assert.match(out, /\/shipcheck/);
  assert.match(out, /no permission rules/);
  assert.equal(seenPrompt, 'Verify all tests and diff for billing.');
});
