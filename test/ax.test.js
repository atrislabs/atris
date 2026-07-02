const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const ax = require('../ax');

// A cwd with no .git/atris/atris.md marker anywhere up its (nonexistent) tree.
// os.tmpdir() and /tmp are not safe here — a stray /tmp/atris turns them into
// a "workspace" for the walk-up detector.
const NON_WORKSPACE_CWD = '/nonexistent/ax-non-workspace';

test('ax routes workspace questions local inside a workspace, cloud outside', () => {
  const repoCwd = path.join(__dirname, '..');
  assert.equal(ax.resolveRoute('what files are here?', { cwd: repoCwd }), 'local');
  assert.equal(ax.resolveRoute('search src for the input component', { cwd: repoCwd }), 'local');
  assert.equal(ax.resolveRoute('fix the xp game tests', { cwd: repoCwd }), 'local');
  assert.equal(ax.resolveRoute('what files are here?', { cwd: NON_WORKSPACE_CWD }), 'cloud');
  // Workspace standard v2: inside a workspace every prompt routes local with
  // tools attached; the model decides whether to use them, even for pure chat.
  assert.equal(ax.resolveRoute('what is the capital of france?', { cwd: repoCwd }), 'local');
  assert.equal(ax.resolveRoute('what is the capital of france?', { cwd: NON_WORKSPACE_CWD }), 'cloud');

  const payload = ax.buildPayload('what files are here?', {
    mode: 'fast',
    cwd: NON_WORKSPACE_CWD,
  });

  assert.equal(payload.model, 'atris:fast');
  assert.equal(payload.workspace_path, undefined);
  assert.equal(payload.max_turns, 1);

  const localPayload = ax.buildPayload('what files are here?', {
    mode: 'fast',
    route: 'local',
    cwd: '/tmp/project',
  });
  assert.equal(localPayload.workspace_path, '/tmp/project');
  assert.equal(localPayload.max_turns, 8);
});

test('ax exposes Atris 2 Max as the highest-reasoning tier', () => {
  assert.equal(ax.modelForMode('max'), 'atris:max');

  const payload = ax.buildPayload('refactor this module and verify the tests', {
    mode: 'max',
    cwd: NON_WORKSPACE_CWD,
  });
  assert.equal(payload.model, 'atris:max');
  assert.equal(payload.workspace_path, undefined);
  assert.equal(payload.max_turns, 1);

  const localPayload = ax.buildPayload('refactor this module and verify the tests', {
    mode: 'max',
    route: 'local',
    cwd: '/tmp/project',
  });
  assert.equal(localPayload.workspace_path, '/tmp/project');
  assert.equal(localPayload.max_turns, 14);

  const cloudWrite = ax.buildPayload('send a slack message to the team', {
    mode: 'max',
    route: 'cloud',
  });
  assert.equal(cloudWrite.max_turns, 1);
  assert.equal(cloudWrite.allow_external_actions, undefined);

  assert.match(ax.formatHeader({ mode: 'max', cwd: '/tmp/project', chat: true }), /Atris 2 Max chat/);

  const profile = ax.buildRunProfile({ mode: 'max', cwd: NON_WORKSPACE_CWD });
  assert.equal(profile.model, 'atris:max');
  assert.equal(profile.route, 'cloud');
  assert.equal(profile.max_turns, 1);
  assert.match(profile.reasoning, /Atris cloud|high reasoning/);
});

test('ax never shows model ids to the user and swaps tiers in chat', () => {
  const modelPattern = /atris:|composer-2-5|gpt-|kimi|fable|fireworks|openrouter/i;
  for (const mode of ['fast', 'pro', 'max', 'code-fast']) {
    assert.doesNotMatch(ax.formatHeader({ mode, cwd: '/tmp/project', chat: true }), modelPattern);
  }
  assert.match(ax.formatHeader({ mode: 'pro', cwd: '/tmp/project', chat: true }), /\/fast \/pro \/max swap tiers/);

  const profileText = ax.formatRunProfile(ax.buildRunProfile({ mode: 'max', cwd: '/tmp/project' }), { color: false });
  assert.doesNotMatch(profileText, modelPattern);

  assert.equal(
    ax.formatSystemInit({ tool_runtime: { mode: 'workspace_tools', tool_model: 'gpt-5.5', reasoning_effort: 'high' } }),
    'workspace tools  thinking high'
  );

  assert.equal(ax.tierLabel('max'), 'Atris 2 Max');
  assert.equal(ax.chatTierCommand('/max'), 'max');
  assert.equal(ax.chatTierCommand(' /FAST '), 'fast');
  assert.equal(ax.chatTierCommand('/pro'), 'pro');
  assert.equal(ax.chatTierCommand('build /max speed'), null);
  assert.equal(ax.chatTierCommand('max'), null);

  assert.equal(ax.formatPrompt('max'), 'max › ');
  assert.equal(ax.formatPrompt(), '› ');
});

test('ax doctor formats runtime readiness without model ids or secrets', async () => {
  const modelPattern = /atris:|composer-2-5|gpt-|kimi|fable|fireworks|openrouter|secret|token/i;
  const ready = await ax.buildRuntimeHealth({
    healthRes: {
      ok: true,
      status: 200,
      data: {
        ready: true,
        models: [{
          id: 'atris:fast',
          route: 'fireworks',
          chat_model: 'fireworks:glm-5.2',
          tool_model: 'fireworks:glm-5.2',
          ready: true,
        }],
      },
    },
  });
  const readyText = ax.formatRuntimeHealth(ready, { color: false });

  assert.equal(ready.backend.ready, true);
  assert.equal(ready.fast.ready, true);
  assert.match(readyText, /backend\s+ready/);
  assert.match(readyText, /fast\s+ready/);
  assert.match(readyText, /approvals\s+ready/);
  assert.doesNotMatch(readyText, modelPattern);

  const offline = await ax.buildRuntimeHealth({
    healthRes: { ok: false, status: 0, data: null, error: 'ECONNREFUSED secret-token' },
  });
  const offlineText = ax.formatRuntimeHealth(offline, { color: false });

  assert.equal(offline.backend.reachable, false);
  assert.match(offlineText, /backend\s+offline/);
  assert.match(offlineText, /Atris cloud unavailable/);
  assert.doesNotMatch(offlineText, /start local backend|uvicorn/);
  assert.doesNotMatch(offlineText, modelPattern);

  const localOffline = await ax.buildRuntimeHealth({
    route: 'local',
    healthRes: { ok: false, status: 0, data: null, error: 'ECONNREFUSED secret-token' },
  });
  const localOfflineText = ax.formatRuntimeHealth(localOffline, { color: false });
  assert.match(localOfflineText, /start local backend/);
  assert.doesNotMatch(localOfflineText, modelPattern);
});

test('ax chat defaults cloud and does not show local backend instructions when offline', async () => {
  const previousAuto = process.env.AX_AUTO_LOG;
  process.env.AX_AUTO_LOG = '0';
  const chunks = [];
  const output = {
    isTTY: false,
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
  };
  let healthCalls = 0;
  try {
    await ax.chat({
      mode: 'fast',
      cwd: os.tmpdir(),
      input: Readable.from(['hi\n', 'exit\n']),
      output,
      runtimeHealth: async () => {
        healthCalls += 1;
        return {
          schema: 'ax.runtime_health.v1',
          backend: { ready: false, reachable: false, status: 0, error: 'ECONNREFUSED secret-token' },
          fast: { ready: false, route_ready: false },
          permissions: { ready: false },
        };
      },
    });
  } finally {
    if (previousAuto === undefined) delete process.env.AX_AUTO_LOG;
    else process.env.AX_AUTO_LOG = previousAuto;
  }

  const text = chunks.join('');
  assert.equal(healthCalls, 1);
  assert.match(text, /backend\s+offline/);
  assert.match(text, /Atris cloud unavailable/);
  assert.doesNotMatch(text, /Start backend:|uvicorn main:app/);
  assert.doesNotMatch(text, /secret-token/);
});

test('ax chat inside a workspace downgrades to cloud when local backend is not listening', async () => {
  const previousAuto = process.env.AX_AUTO_LOG;
  process.env.AX_AUTO_LOG = '0';
  const chunks = [];
  const output = {
    isTTY: false,
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
  };
  const preflightRoutes = [];
  try {
    await ax.chat({
      mode: 'fast',
      cwd: path.join(__dirname, '..'),
      input: Readable.from(['what files are here?\n', 'exit\n']),
      output,
      localBackendProbe: async () => false,
      runtimeHealth: async ({ route }) => {
        preflightRoutes.push(route);
        return {
          schema: 'ax.runtime_health.v1',
          route,
          backend: { ready: false, reachable: false, status: 0, error: 'ECONNREFUSED secret-token' },
          fast: { ready: false, route_ready: false },
          permissions: { ready: false },
        };
      },
    });
  } finally {
    if (previousAuto === undefined) delete process.env.AX_AUTO_LOG;
    else process.env.AX_AUTO_LOG = previousAuto;
  }

  const text = chunks.join('');
  // The auto-routed local turn must preflight cloud, never surface the
  // localhost lane to the user.
  assert.deepEqual(preflightRoutes, ['cloud']);
  assert.doesNotMatch(text, /Start backend:|uvicorn main:app|start local backend/);
  assert.doesNotMatch(text, /secret-token/);
});

test('ax chat shows local backend instructions only for explicit local route', async () => {
  const previousAuto = process.env.AX_AUTO_LOG;
  process.env.AX_AUTO_LOG = '0';
  const chunks = [];
  const output = {
    isTTY: false,
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
  };
  try {
    await ax.chat({
      mode: 'fast',
      route: 'local',
      cwd: os.tmpdir(),
      input: Readable.from(['hi\n', 'exit\n']),
      output,
      runtimeHealth: async () => ({
        schema: 'ax.runtime_health.v1',
        route: 'local',
        backend: { ready: false, reachable: false, status: 0, error: 'ECONNREFUSED secret-token' },
        fast: { ready: false, route_ready: false },
        permissions: { ready: false },
      }),
    });
  } finally {
    if (previousAuto === undefined) delete process.env.AX_AUTO_LOG;
    else process.env.AX_AUTO_LOG = previousAuto;
  }

  const text = chunks.join('');
  assert.match(text, /backend\s+offline/);
  assert.match(text, /Start backend:/);
  assert.match(text, /uvicorn main:app/);
  assert.doesNotMatch(text, /secret-token/);
});

test('ax self-test verifies harness invariants without backend calls', async () => {
  const chunks = [];
  const output = {
    isTTY: false,
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
  };
  const results = await ax.runSelfTest({ output });
  const text = chunks.join('');

  assert.equal(results.length, 11);
  assert.equal(results.every(result => result.ok), true);
  assert.match(text, /AX self-test/);
  assert.match(text, /doctor redaction .*ok/);
  assert.match(text, /chat cloud offline preflight .*ok/);
  assert.match(text, /approval id .*ok/);
  assert.match(text, /calendar approval rail .*ok/);
  assert.match(text, /calendar approval execution .*ok/);
  assert.match(text, /calendar chat approval loop .*ok/);
  assert.match(text, /calendar blocked approval retry .*ok/);
  assert.match(text, /calendar chat denial loop .*ok/);
  assert.match(text, /approval queue privacy .*ok/);
  assert.match(text, /approval output privacy .*ok/);
  assert.match(text, /run log privacy .*ok/);
  assert.match(text, /Self-test passed: 11\/11/);
  assert.match(ax.formatUsage(), /--self-test/);
});

test('ax chat renders claude-style blocks and a slash menu', () => {
  const writes = [];
  const out = { isTTY: false, write: (chunk) => writes.push(chunk) };
  const state = {
    events: [], errors: [], output: '', pendingText: '', wroteText: false,
    wroteActivity: false, lastChar: '\n', progress: null, inAuxBlock: false,
    needsBullet: true, lastAux: '',
  };

  ax.handleEvent({ type: 'system_init', tool_runtime: { mode: 'local_workspace', tool_model: 'openai:gpt-5.5' } }, state, out);
  ax.handleEvent({ type: 'text_delta', content: 'Draft answer that gets superseded.' }, state, out);
  ax.handleEvent({ type: 'status', message: 'retrying_with_required_file_reads' }, state, out);
  ax.handleEvent({ type: 'assistant_blocks', blocks: [{ type: 'tool_use', tool: 'Read', input: { file_path: 'src/config.js' } }] }, state, out);
  ax.handleEvent({ type: 'tool_results', results: [{ content: '{"status":"ok","path":"atris/AGENTS.md","content":"line1\\nline2\\nline3"}' }] }, state, out);
  ax.handleEvent({ type: 'assistant_blocks', blocks: [{ type: 'tool_use', tool: 'Task', input: { type: 'status' } }] }, state, out);

  assert.equal(
    writes.join(''),
    '● Read(src/  config.js)\n  ⎿  3 lines  atris/  AGENTS.md\n\n● Task(status)\n'
  );
  assert.equal(state.output, '');

  assert.equal(
    ax.summarizeToolResult({ content: '{"status": "ok", "path": "atris/AGENTS.md", "content": "# AGE' }),
    'ok  atris/  AGENTS.md'
  );
  assert.equal(ax.summarizeToolResult({ content: 'first line\nsecond\nthird' }), 'first line  … +2 lines');

  const menu = ax.chatMenu({ color: false });
  assert.match(menu, /\/fast/);
  assert.match(menu, /\/pro/);
  assert.match(menu, /\/max/);
  assert.match(menu, /\/help/);
  assert.doesNotMatch(menu, /atris:|gpt-|kimi|fable|composer/i);

  assert.deepEqual(ax.chatCompleter('/f'), [['/fast'], '/f']);
  assert.deepEqual(ax.chatCompleter('/'), [['/fast', '/pro', '/max', '/help'], '/']);
  assert.deepEqual(ax.chatCompleter('hello'), [[], 'hello']);
});

test('AX_TIMING prints event timing to stderr without changing chat output', () => {
  const previousTiming = process.env.AX_TIMING;
  const previousWrite = process.stderr.write;
  const timingLines = [];
  process.env.AX_TIMING = '1';
  process.stderr.write = (chunk) => {
    timingLines.push(String(chunk));
    return true;
  };
  try {
    const writes = [];
    const out = { isTTY: false, write: (chunk) => writes.push(chunk) };
    const state = {
      events: [], errors: [], output: '', pendingText: '', wroteText: false,
      wroteActivity: false, lastChar: '\n', progress: null, inAuxBlock: false,
      needsBullet: true, lastAux: '',
    };

    ax.handleEvent({ type: 'assistant_blocks', blocks: [{ type: 'tool_use', tool: 'Read' }] }, state, out);
    ax.handleEvent({ type: 'tool_results', results: [{ content: 'ok' }] }, state, out);

    assert.match(timingLines.join(''), /\[ax-timing\].*assistant_blocks tool:Read/);
    assert.match(timingLines.join(''), /\[ax-timing\].*tool_results results:1/);
    assert.equal(state.events.length, 2);
    assert.equal(writes.join(''), '● Read()\n  ⎿  ok\n');
  } finally {
    if (previousTiming === undefined) delete process.env.AX_TIMING;
    else process.env.AX_TIMING = previousTiming;
    process.stderr.write = previousWrite;
  }
});

test('ax shows credits, tier colors, spinner verbs, and clickable paths', () => {
  assert.equal(ax.formatDoneLine(7000, 3), '— Worked for 7s · 3 credits —');
  assert.equal(ax.formatDoneLine(7000, 1), '— Worked for 7s · 1 credit —');
  assert.equal(ax.formatDoneLine(131000), '— Worked for 2m 11s —');
  assert.equal(
    ax.creditsFromState({ events: [{ type: 'receipt', receipt: { billing: { billed: true, credits_charged: 5 } } }] }),
    5
  );
  assert.equal(
    ax.creditsFromState({ events: [{ type: 'receipt', receipt: { billing: { billed: false, credits_charged: 5 } } }] }),
    null
  );
  assert.equal(ax.creditsFromState({ events: [] }), null);

  assert.equal(ax.formatWorkingLine(2100), '• Working (2s • ctrl-c to interrupt)');
  assert.equal(ax.formatWorkingLine(2100, 'Reading', '⠙'), '⠙ Reading… (2s · ctrl-c to interrupt)');

  const colored = { color: true, isTTY: true };
  const previousNoColor = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  try {
    assert.match(ax.formatPrompt('max', colored), /\x1b\[35m/);
    assert.match(ax.formatPrompt('fast', colored), /\x1b\[32m/);
    assert.match(ax.formatPrompt('pro', colored), /\x1b\[36m/);
    assert.match(ax.formatHeader({ mode: 'max', cwd: '/tmp', chat: true }, colored), /\x1b\[35m/);

    assert.match(ax.formatPathSubject('src/config.js', colored), /\x1b\]8;;file:\/\//);
    assert.doesNotMatch(ax.formatPathSubject('src/config.js'), /\x1b\]8/);
    assert.doesNotMatch(ax.formatPathSubject('cloud scratch', colored), /\x1b\]8/);
  } finally {
    if (previousNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previousNoColor;
  }
});

test('ax routes connector reads to authenticated cloud context', () => {
  // Workspace standard v2: connector reads route cloud outside a workspace;
  // GitHub-connector phrasing keeps the cloud lane even inside one.
  assert.equal(ax.resolveRoute('what is on my calendar today?', { cwd: NON_WORKSPACE_CWD }), 'cloud');
  assert.equal(ax.resolveRoute('which integrations are connected?', { cwd: NON_WORKSPACE_CWD }), 'cloud');
  assert.equal(ax.resolveRoute('what github repos do I have?', { cwd: path.join(__dirname, '..') }), 'cloud');
  assert.equal(ax.resolveRoute('create a github issue for this bug', { cwd: path.join(__dirname, '..') }), 'cloud');

  const payload = ax.buildPayload('what is on my calendar today?', {
    mode: 'fast',
    cwd: NON_WORKSPACE_CWD,
    connectionContext: {
      schema: 'atris.connection_capabilities.v1',
      connections: [],
    },
  });

  assert.equal(payload.model, 'atris:fast');
  assert.equal(payload.workspace_path, undefined);
  assert.equal(payload.max_turns, 1);
  assert.equal(payload.connection_context.schema, 'atris.connection_capabilities.v1');
});

test('ax marks connector writes as isolated preview turns', () => {
  const payload = ax.buildPayload('send gmail to ada@example.com about receipts', {
    mode: 'fast',
    route: 'cloud',
    conversationId: 'ax-thread-1',
    turnId: 'turn-123',
    connectionContext: {
      schema: 'atris.connection_capabilities.v1',
      connections: [{
        id: 'gmail',
        connected: true,
        authority: { list_messages: 'read_only', send_message: 'approval_required' },
      }],
    },
  });

  assert.equal(payload.max_turns, 1);
  assert.equal(payload.turn_id, 'turn-123');
  assert.equal(payload.conversation_id, 'ax-thread-1');
  assert.equal(payload.external_action_policy, 'preview_then_explicit_approval');
  assert.deepEqual(payload.connector_turn, {
    schema: 'ax.connector_turn.v1',
    scope: 'current_turn_only',
    policy: 'preview_then_explicit_approval',
    writes_require_approval: true,
    turn_id: 'turn-123',
    conversation_id: 'ax-thread-1',
  });
  assert.equal(payload.allow_external_actions, undefined);
});

test('ax sends chat history as structured previous messages, not a prompt wrapper', () => {
  const history = [
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: "I'll add it today at 2:00 PM.\nWhat should I call it?",
      task_preview: {
        task: 'calendar.create_event',
        status: 'needs_input',
        missing: ['title'],
      },
    },
  ];
  const payload = ax.buildPayload('can you add a calendar event at 2PM today please for buunch', {
    mode: 'fast',
    cwd: NON_WORKSPACE_CWD,
    history,
    conversationId: 'ax-thread-1',
    connectionContext: {
      schema: 'atris.connection_capabilities.v1',
      connections: [],
    },
  });

  assert.equal(payload.message, 'can you add a calendar event at 2PM today please for buunch');
  assert.deepEqual(payload.previous_messages, history);
  assert.equal(payload.previous_messages[1].task_preview.task, 'calendar.create_event');
  assert.equal(payload.conversation_id, 'ax-thread-1');
  assert.equal(payload.workspace_path, undefined);
  assert.equal(payload.allow_external_actions, undefined);
  assert.equal(payload.cleanup_external_actions, undefined);
  assert.equal(payload.max_turns, 1);
  assert.doesNotMatch(payload.message, /Current user message|Recent conversation|Continue this terminal/);
});

test('ax routes GitHub repo mutations to cloud outside a workspace, local tools take them inside', () => {
  assert.equal(ax.resolveRoute('push something to github', { cwd: NON_WORKSPACE_CWD }), 'cloud');
  assert.equal(ax.resolveRoute('commit a tiny proof change and push to github', { cwd: NON_WORKSPACE_CWD }), 'cloud');
  assert.equal(ax.resolveRoute('open a pull request for this branch on github', { cwd: NON_WORKSPACE_CWD }), 'cloud');

  // Inside a workspace the workspace-intent detector claims repo-shaped work
  // for local tools when the wording overlaps (change/branch); pure connector
  // phrasing stays cloud.
  const repoCwd = path.join(__dirname, '..');
  assert.equal(ax.resolveRoute('push something to github', { cwd: repoCwd }), 'cloud');
  assert.equal(ax.resolveRoute('commit a tiny proof change and push to github', { cwd: repoCwd }), 'local');

  assert.equal(ax.resolveRoute('push something to github', { route: 'local' }), 'local');
});

test('ax carries local connector lookup id only on cloud payloads', () => {
  const localPayload = ax.buildPayload('what files are here?', {
    route: 'local',
    cwd: '/tmp/project',
    connectionUserId: '00000000-0000-4000-8000-000000000001',
  });
  assert.equal(localPayload.connection_user_id, undefined);

  const cloudPayload = ax.buildPayload('what is on my calendar today?', {
    route: 'cloud',
    connectionUserId: '00000000-0000-4000-8000-000000000001',
  });
  assert.equal(cloudPayload.connection_user_id, '00000000-0000-4000-8000-000000000001');
});

test('ax falls back to local integration status cache when backend status is unavailable', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-integrations-cache-'));
  fs.mkdirSync(path.join(homeDir, '.obelisk'), { recursive: true });
  fs.writeFileSync(
    path.join(homeDir, '.obelisk', 'integrations-status.json'),
    JSON.stringify({ status: { gmail: true, slack: { connected: true }, notion: false } }),
  );

  try {
    const cached = ax.cachedIntegrationStatus({ homeDir });
    assert.equal(cached.gmail, true);
    assert.equal(cached.slack.connected, true);

    const context = await ax.buildConnectionContext({
      token: '',
      localWorkspace: false,
      integrationStatusHomeDir: homeDir,
      statusRes: { ok: false, data: null },
      contractRes: {
        ok: true,
        data: {
          schema: 'atris.connection_capabilities.v1',
          connectors: [
            { id: 'gmail', authority: { list_messages: 'read_only', send_message: 'approval_required' } },
            { id: 'slack', authority: { list_channels: 'read_only', list_messages: 'read_only' } },
          ],
        },
      },
    });

    const byId = new Map(context.connections.map(connection => [connection.id, connection]));
    assert.equal(context.connection_status_source, 'local_cache');
    assert.equal(byId.get('gmail').connected, true);
    assert.equal(byId.get('slack').connected, true);
    assert.equal(byId.get('notion').connected, false);
    assert.deepEqual(byId.get('gmail').authority, { list_messages: 'read_only', send_message: 'approval_required' });
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('ax can force local or cloud routing', () => {
  assert.equal(ax.resolveRoute('what files are here?', { route: 'cloud' }), 'cloud');
  assert.equal(ax.resolveRoute('what is on my calendar?', { route: 'local' }), 'local');
  assert.equal(ax.buildPayload('what is on my calendar?', { route: 'local', cwd: '/tmp/project' }).workspace_path, '/tmp/project');
  assert.equal(ax.buildPayload('what files are here?', { route: 'cloud', cwd: '/tmp/project' }).workspace_path, undefined);
});

test('ax sends a no-op verify_command unless --verify opts in', () => {
  const defaultPayload = ax.buildPayload('what files are here?', {
    mode: 'fast',
    cwd: '/tmp/project',
  });
  assert.equal(defaultPayload.verify_command, 'true');

  const blankPayload = ax.buildPayload('what files are here?', {
    mode: 'fast',
    cwd: '/tmp/project',
    verify: '   ',
  });
  assert.equal(blankPayload.verify_command, 'true');

  const localPayload = ax.buildPayload('fix the failing suite', {
    mode: 'max',
    route: 'local',
    cwd: '/tmp/project',
    verify: 'npm test',
  });
  assert.equal(localPayload.verify_command, 'npm test');
  assert.equal(localPayload.workspace_path, '/tmp/project');

  const businessPayload = ax.buildPayload('fix the failing suite', {
    mode: 'pro',
    business: { slug: 'acme' },
    verify: 'pytest -q',
  });
  assert.equal(businessPayload.verify_command, 'pytest -q');
  assert.equal(businessPayload.workspace_path, '/workspace/acme');

  assert.match(ax.formatUsage(), /--verify <cmd>/);
});

test('ax exposes Atris Code Fast as an explicit public lane', () => {
  const previousBackend = process.env.AX_CODE_FAST_BACKEND_URL;
  const previousApiBase = process.env.AX_CODE_FAST_API_BASE;
  delete process.env.AX_CODE_FAST_BACKEND_URL;
  delete process.env.AX_CODE_FAST_API_BASE;

  try {
    assert.equal(ax.modelForMode('code-fast'), 'composer-2-5-fast');
    assert.equal(ax.codeFastUrl(), 'https://api.atris.ai/api/cursor/turn');
    assert.deepEqual(ax.buildCodeFastPayload('say ok', { cwd: '/tmp/project' }), {
      message: 'say ok',
      model: 'composer-2-5-fast',
      timeout_seconds: 180,
    });

    process.env.AX_CODE_FAST_BACKEND_URL = 'http://127.0.0.1:8000';
    assert.equal(ax.codeFastUrl(), 'http://127.0.0.1:8000/api/cursor/turn');
    assert.equal(
      ax.buildCodeFastPayload('say ok', { route: 'local', cwd: '/tmp/project' }).workspace_path,
      '/tmp/project'
    );
    assert.match(ax.formatHeader({ mode: 'code-fast', cwd: '/tmp/project' }), /Atris Code Fast/);
    assert.doesNotMatch(ax.formatHeader({ mode: 'code-fast', cwd: '/tmp/project' }), /composer-2-5-fast/);
    assert.equal(ax.buildRunProfile({ mode: 'code-fast', cwd: '/tmp/project' }).model, 'composer-2-5-fast');
    assert.equal(
      ax.codeFastWorkspaceNotice({ billing: { workspace_mode: 'cloud_scratch' } }),
      'cloud scratch files are temporary and are not saved to your Mac'
    );
    assert.equal(ax.codeFastWorkspaceNotice({ workspace: { mode: 'local_workspace', persistence: 'local' } }), null);
  } finally {
    if (previousBackend === undefined) delete process.env.AX_CODE_FAST_BACKEND_URL;
    else process.env.AX_CODE_FAST_BACKEND_URL = previousBackend;
    if (previousApiBase === undefined) delete process.env.AX_CODE_FAST_API_BASE;
    else process.env.AX_CODE_FAST_API_BASE = previousApiBase;
  }
});

test('ax backend URL is configurable', () => {
  const previous = process.env.AX_BACKEND_URL;
  process.env.AX_BACKEND_URL = 'http://127.0.0.1:9001';
  try {
    assert.equal(ax.backendUrl(), 'http://127.0.0.1:9001/api/atris2/turn');
  } finally {
    if (previous === undefined) delete process.env.AX_BACKEND_URL;
    else process.env.AX_BACKEND_URL = previous;
  }
});

test('ax formats paths with filename emphasis spacing', () => {
  const formatted = ax.formatPathSubject(path.join('/tmp', 'project', 'src', 'App.tsx'), { color: false });
  assert.equal(formatted, '/tmp/project/src/  App.tsx');
});

test('ax renders basic markdown for terminal output', () => {
  assert.equal(ax.renderTerminalMarkdown('## Heading\nUse **bold** and `code`.', { color: false }), 'Heading\nUse bold and code.');
  const previousNoColor = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  try {
    const rendered = ax.renderTerminalMarkdown('Use **bold** and `code`.', { color: true, isTTY: true });
    assert.match(rendered, /\x1b\[1mbold\x1b\[0m/);
    assert.match(rendered, /\x1b\[36mcode\x1b\[0m/);
  } finally {
    if (previousNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previousNoColor;
  }
});

test('ax streaming markdown handles split bold delimiters', () => {
  const state = { markdownMode: 'normal', markdownBuffer: '', markdownCarry: '' };
  const options = { color: false, isTTY: true };
  assert.equal(ax.renderStreamingMarkdown(state, 'This is *', options), 'This is ');
  assert.equal(ax.renderStreamingMarkdown(state, '*bold', options), '');
  assert.equal(ax.renderStreamingMarkdown(state, '** now', options), 'bold now');
});

test('ax renders connector result when no text delta was emitted', () => {
  const chunks = [];
  const output = {
    isTTY: false,
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
  };
  const state = {
    events: [],
    errors: [],
    output: '',
    pendingText: '',
    wroteText: false,
    wroteActivity: false,
    lastChar: '\n',
    progress: null,
    inAuxBlock: false,
    markdownMode: 'normal',
    markdownBuffer: '',
    markdownCarry: '',
  };

  ax.handleEvent({ type: 'result', result: 'No Slack user matched jared.' }, state, output);

  assert.equal(state.output, 'No Slack user matched jared.');
  assert.equal(state.pendingText, 'No Slack user matched jared.');
});

test('ax renders approval preview rows from Atris2 receipts', () => {
  const chunks = [];
  const output = {
    isTTY: false,
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
  };
  const state = {
    events: [],
    errors: [],
    output: '',
    pendingText: '',
    wroteText: false,
    wroteActivity: false,
    lastChar: '\n',
    progress: null,
    inAuxBlock: false,
    needsBullet: true,
    markdownMode: 'normal',
    markdownBuffer: '',
    markdownCarry: '',
  };

  ax.handleEvent({
    type: 'text_delta',
    content: 'Accepted: markoo today at 2:00 PM.\nCalendar approval still needed before I create it.',
  }, state, output);
  ax.handleEvent({
    type: 'receipt',
    receipt: {
      task_preview: {
        task: 'calendar.create_event',
        owner_member: 'harness-engineer',
        status: 'approval_required',
        missing: [],
        slots: {
          title: 'markoo',
          start: '2026-06-28T14:00:00-07:00',
        },
      },
      task_accept_receipt: {
        task: 'calendar.create_event',
        title: 'markoo',
        start: '2026-06-28T14:00:00-07:00',
      },
      tool_events: [{
        tool: 'google_calendar',
        approval_request: {
          connector: 'google_calendar',
          action: 'create_event',
          executor_action_type: 'google_calendar_create_event',
          status: 'approval_required',
          payload: { summary: 'markoo' },
        },
      }],
    },
  }, state, output);

  const rendered = chunks.join('');
  assert.match(rendered, /^Accepted: markoo today at 2:00 PM\./);
  assert.match(rendered, /owner\s+harness-engineer/);
  assert.match(rendered, /plan\s+create calendar event "markoo" Jun 28, 2026 at 2:00 PM/);
  assert.match(rendered, /check\s+approval required/);
  assert.match(rendered, /wait\s+Approval needed before creation: calendar event "markoo" Jun 28, 2026 at 2:00 PM/);
  assert.equal(state.output, 'Accepted: markoo today at 2:00 PM.\nCalendar approval still needed before I create it.');
});

test('ax renders Gmail approval previews without leaking the body', () => {
  const receipt = {
    task_preview: {
      task: 'gmail.send_message',
      owner_member: 'comms',
      status: 'approval_required',
      missing: [],
      slots: {
        to: 'ada@example.com',
        subject: 'Receipt review',
      },
    },
    tool_events: [{
      tool: 'gmail',
      approval_request: {
        connector: 'gmail',
        action: 'send_message',
        executor_action_type: 'gmail_send',
        status: 'approval_required',
        payload: {
          to: ['ada@example.com'],
          subject: 'Receipt review',
          body: 'secret receipt body',
        },
      },
    }],
  };

  const rendered = [
    ...ax.formatTaskPreviewRows(receipt, { color: false }),
    ax.formatApprovalReceipt(receipt),
  ].join('\n');

  assert.match(rendered, /owner\s+comms/);
  assert.match(rendered, /plan\s+send Gmail to ada@example.com subject "Receipt review"/);
  assert.match(rendered, /Approval needed before sending Gmail: to ada@example.com subject "Receipt review" \(body hidden until approved\)/);
  assert.doesNotMatch(rendered, /secret receipt body/);
});

test('ax does not execute approval previews before explicit acceptance', async () => {
  const output = { isTTY: false, write() { return true; } };
  const state = {
    events: [{
      type: 'receipt',
      receipt: {
        task_preview: { task: 'calendar.create_event', status: 'approval_required' },
        tool_events: [{
          approval_request: {
            connector: 'google_calendar',
            executor_action_type: 'google_calendar_create_event',
            status: 'approval_required',
            payload: { summary: 'markoo' },
          },
        }],
      },
    }],
    errors: [],
    output: '',
    pendingText: '',
    wroteText: false,
    wroteActivity: false,
    lastChar: '\n',
    progress: null,
    inAuxBlock: false,
    needsBullet: true,
  };
  let called = false;

  const result = await ax.executeApprovalFromState(state, {
    output,
    postApproval: async () => {
      called = true;
      return { ok: true, status: 200, data: {} };
    },
  });

  assert.equal(result, null);
  assert.equal(called, false);
});

test('ax executes accepted approval receipts through Atris2 approval endpoint', async () => {
  const chunks = [];
  const output = {
    isTTY: false,
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
  };
  const receipt = {
    task_accept_receipt: {
      accepted: true,
      task: 'calendar.create_event',
      execution_status: 'pending_approval_execution',
      execution_endpoint: '/api/atris2/approvals/execute',
    },
    tool_events: [{
      tool: 'google_calendar',
      approval_request: {
        connector: 'google_calendar',
        action: 'create_event',
        executor_action_type: 'google_calendar_create_event',
        status: 'approval_required',
        payload: {
          summary: 'markoo',
          start: { dateTime: '2026-06-28T14:00:00-07:00' },
          end: { dateTime: '2026-06-28T15:00:00-07:00' },
        },
      },
    }],
  };
  const request = ax.approvalExecutionRequestFromReceipt(receipt);
  assert.match(request.approval_request_id, /^apreq_ax_[a-f0-9]{20}$/);

  const state = {
    events: [{ type: 'receipt', receipt }],
    errors: [],
    output: 'Accepted: markoo today at 2:00 PM.',
    pendingText: '',
    wroteText: true,
    wroteActivity: true,
    lastChar: '\n',
    progress: null,
    inAuxBlock: false,
    needsBullet: true,
  };
  let captured = null;

  const execution = await ax.executeApprovalFromState(state, {
    model: 'atris:fast',
    output,
    postApproval: async (approvalRequest, options) => {
      captured = { approvalRequest, options };
      return {
        ok: true,
        status: 200,
        data: {
          status: 'executed',
          action_type: 'google_calendar_create_event',
          execution: {
            action_type: 'google_calendar_create_event',
            executed: true,
            status: 'executed',
          },
        },
      };
    },
  });

  assert.equal(captured.options.model, 'atris:fast');
  assert.equal(captured.approvalRequest.approval_request_id, request.approval_request_id);
  assert.equal(captured.approvalRequest.payload.summary, 'markoo');
  assert.equal(execution.message, 'Created calendar event.');
  const rendered = chunks.join('');
  assert.match(rendered, /wait\s+Sending approved action to Atris cloud/);
  assert.match(rendered, /done\s+Created calendar event\./);
});

test('ax keeps generic approval requests pending locally across turns', () => {
  const receipt = {
    tool_events: [{
      tool: 'slack',
      approval_request: {
        connector: 'slack',
        action: 'post_message',
        executor_action_type: 'slack_post_message',
        status: 'approval_required',
        payload: { channel: '#general', text: 'ship note' },
      },
    }],
  };
  const approvalRequest = ax.approvalRequestFromReceipt(receipt);

  assert.match(approvalRequest.approval_request_id, /^apreq_ax_[a-f0-9]{20}$/);
  assert.equal(approvalRequest.payload.text, 'ship note');
  assert.equal(
    ax.latestPendingApprovalRequest([
      { role: 'user', content: 'send this' },
      { role: 'assistant', content: 'Approval needed.', approval_request: approvalRequest },
    ]).approval_request_id,
    approvalRequest.approval_request_id
  );
  assert.equal(
    ax.latestPendingApprovalRequest([
      { role: 'assistant', content: 'Approval needed.', approval_request: approvalRequest },
      { role: 'assistant', content: 'Cancelled.' },
    ]),
    null
  );
  assert.equal(ax.messageApprovesPendingApproval('yes send it'), true);
  assert.equal(ax.messageApprovesPendingApproval('change the channel'), false);
  assert.equal(ax.messageCancelsPendingApproval('cancel it'), true);
});

test('ax executes a stored generic approval request without another model turn', async () => {
  const chunks = [];
  const output = {
    isTTY: false,
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
  };
  const approvalRequest = ax.approvalRequestFromReceipt({
    tool_events: [{
      approval_request: {
        connector: 'slack',
        executor_action_type: 'slack_post_message',
        status: 'approval_required',
        payload: { channel: '#general', text: 'ship note' },
      },
    }],
  });
  const state = {
    events: [],
    errors: [],
    output: 'Accepted.',
    pendingText: '',
    wroteText: true,
    wroteActivity: true,
    lastChar: '\n',
    progress: null,
    inAuxBlock: false,
    needsBullet: true,
  };
  let captured = null;

  const execution = await ax.executeApprovalRequest(approvalRequest, {
    model: 'atris:fast',
    output,
    state,
    postApproval: async (request, options) => {
      captured = { request, options };
      return {
        ok: true,
        status: 200,
        data: {
          status: 'executed',
          action_type: 'slack_post_message',
          execution: { status: 'executed', action_type: 'slack_post_message', executed: true },
          billing: { billed: true, credits_charged: 1 },
        },
      };
    },
  });

  assert.equal(captured.options.model, 'atris:fast');
  assert.equal(captured.request.approval_request_id, approvalRequest.approval_request_id);
  assert.equal(execution.message, 'Sent Slack message.');
  assert.equal(ax.creditsFromApprovalExecution(execution.response), 1);
  const rendered = chunks.join('');
  assert.match(rendered, /wait\s+Sending approved action to Atris cloud/);
  assert.match(rendered, /done\s+Sent Slack message\./);
});

test('ax persists approvals privately and lists them without payload text', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-approval-store-'));
  const storePath = path.join(dir, 'approvals.json');
  try {
    const receipt = {
      task_preview: {
        task: 'slack.post_message',
        owner_member: 'comms',
        status: 'approval_required',
        missing: [],
      },
      tool_events: [{
        tool: 'slack',
        approval_request: {
          connector: 'slack',
          action: 'post_message',
          executor_action_type: 'slack_post_message',
          status: 'approval_required',
          payload: { channel: '#general', text: 'secret payload text' },
        },
      }],
    };
    const approvalRequest = ax.approvalRequestFromReceipt(receipt);
    const record = ax.persistPendingApproval(receipt, approvalRequest, { storePath, cwd: '/tmp/project', mode: 'fast' });
    const mode = fs.statSync(storePath).mode & 0o777;
    assert.equal(mode, 0o600);

    const listed = ax.formatStoredApprovals(ax.readApprovalStore({ storePath }), { color: false });
    assert.match(listed, /Pending approvals/);
    assert.match(listed, new RegExp(record.id));
    assert.match(listed, new RegExp(`approve\\s+ax --approve ${record.id}`));
    assert.match(listed, /owner\s+comms/);
    assert.match(listed, /check\s+approval required/);
    assert.doesNotMatch(listed, /secret payload text/);

    const chunks = [];
    await ax.approveStoredApproval(record.id.slice(0, 16), {
      storePath,
      output: { isTTY: false, write(chunk) { chunks.push(String(chunk)); return true; } },
      postApproval: async () => ({
        ok: true,
        status: 200,
        data: {
          status: 'executed',
          action_type: 'slack_post_message',
          execution: { status: 'executed', action_type: 'slack_post_message', executed: true },
        },
      }),
    });
    assert.equal(ax.readApprovalStore({ storePath }).approvals.length, 0);
    const approvedText = chunks.join('');
    assert.match(approvedText, new RegExp(record.id));
    assert.match(approvedText, /owner\s+comms/);
    assert.match(approvedText, /check\s+approval required/);
    assert.match(approvedText, /Sent Slack message/);
    assert.doesNotMatch(approvedText, /secret payload text/);

    const second = ax.persistPendingApproval(receipt, approvalRequest, { storePath, cwd: '/tmp/project', mode: 'fast' });
    const denied = ax.denyStoredApproval(second.id.slice(0, 16), { storePath });
    assert.equal(denied.id, second.id);
    assert.equal(ax.readApprovalStore({ storePath }).approvals.length, 0);

    const oldCreatedAt = new Date(Date.now() - (25 * 60 * 60 * 1000)).toISOString();
    const stale = ax.persistPendingApproval(receipt, approvalRequest, { storePath, cwd: '/tmp/project', mode: 'fast', createdAt: oldCreatedAt });
    let called = false;
    const staleChunks = [];
    const staleResult = await ax.approveStoredApproval(stale.id, {
      storePath,
      output: { isTTY: false, write(chunk) { staleChunks.push(String(chunk)); return true; } },
      postApproval: async () => {
        called = true;
        return { ok: true, status: 200, data: {} };
      },
    });
    assert.equal(staleResult.stale, true);
    assert.equal(called, false);
    assert.equal(ax.readApprovalStore({ storePath }).approvals.length, 0);
    assert.match(staleChunks.join(''), /Approval expired/);
    assert.doesNotMatch(staleChunks.join(''), /secret payload text/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ax stored approval preview includes exact approve command without payload text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-one-shot-approval-'));
  const storePath = path.join(dir, 'approvals.json');
  const receipt = {
    task_preview: {
      task: 'calendar.create_event',
      owner_member: 'harness-engineer',
      status: 'approval_required',
      missing: [],
      slots: {
        title: 'markoo',
        start: '2026-06-28T14:00:00-07:00',
      },
    },
    tool_events: [{
      tool: 'google_calendar',
      approval_request: {
        connector: 'google_calendar',
        action: 'create_event',
        executor_action_type: 'google_calendar_create_event',
        status: 'approval_required',
        payload: {
          summary: 'secret payload text',
          start: { dateTime: '2026-06-28T14:00:00-07:00' },
        },
      },
    }],
  };

  try {
    const request = ax.approvalRequestFromReceipt(receipt);
    const record = ax.persistPendingApproval(receipt, request, { storePath, cwd: dir, mode: 'fast' });
    const listed = ax.formatStoredApprovals(ax.readApprovalStore({ storePath }), { color: false });

    assert.equal(record.id, request.approval_request_id);
    assert.match(listed, /owner\s+harness-engineer/);
    assert.match(listed, /plan\s+create calendar event "markoo" Jun 28, 2026 at 2:00 PM/);
    assert.match(listed, /check\s+approval required/);
    assert.match(listed, /wait\s+Approval needed before creation: calendar event "markoo" Jun 28, 2026 at 2:00 PM/);
    assert.match(listed, new RegExp(`approve\\s+ax --approve ${record.id}`));
    assert.doesNotMatch(listed, /secret payload text/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ax stored Gmail approval preview hides email body', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-gmail-approval-'));
  const storePath = path.join(dir, 'approvals.json');
  const receipt = {
    task_preview: {
      task: 'gmail.send_message',
      owner_member: 'comms',
      status: 'approval_required',
      missing: [],
      slots: {
        to: 'ada@example.com',
        subject: 'Receipt review',
      },
    },
    tool_events: [{
      tool: 'gmail',
      approval_request: {
        connector: 'gmail',
        action: 'send_message',
        executor_action_type: 'gmail_send',
        status: 'approval_required',
        payload: {
          to: 'ada@example.com',
          subject: 'Receipt review',
          body: 'secret receipt body',
        },
      },
    }],
  };

  try {
    const request = ax.approvalRequestFromReceipt(receipt);
    const record = ax.persistPendingApproval(receipt, request, { storePath, cwd: dir, mode: 'fast' });
    const listed = ax.formatStoredApprovals(ax.readApprovalStore({ storePath }), { color: false });

    assert.equal(record.id, request.approval_request_id);
    assert.match(listed, /owner\s+comms/);
    assert.match(listed, /plan\s+send Gmail to ada@example.com subject "Receipt review"/);
    assert.match(listed, /wait\s+Approval needed before sending Gmail: to ada@example.com subject "Receipt review" \(body hidden until approved\)/);
    assert.match(listed, new RegExp(`approve\\s+ax --approve ${record.id}`));
    assert.doesNotMatch(listed, /secret receipt body/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ax formats blocked approval execution without leaking payloads', () => {
  assert.equal(
    ax.formatApprovalExecutionResult({
      ok: false,
      status: 402,
      data: { detail: { error: 'paid_cloud_computer_required', message: 'secret body should not matter' } },
    }),
    'Approval execution needs a paid cloud computer.'
  );
  assert.equal(
    ax.formatApprovalExecutionResult({
      ok: true,
      status: 200,
      data: {
        status: 'blocked_connector_not_connected',
        action_type: 'google_calendar_create_event',
        execution: { status: 'blocked_connector_not_connected', action_type: 'google_calendar_create_event' },
      },
    }),
    'Calendar event was not created because the connector is not connected.'
  );
});

test('ax auto logger redacts transcripts by default under atris/runs', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-log-test-'));
  fs.mkdirSync(path.join(cwd, 'atris'), { recursive: true });
  const chunks = [];
  const previousFull = process.env.AX_LOG_FULL;
  delete process.env.AX_LOG_FULL;
  const logger = ax.createRunLogger({
    cwd,
    mode: 'pro',
    kind: 'play',
    output: {
      isTTY: true,
      write(chunk) {
        chunks.push(String(chunk));
      }
    }
  });

  try {
    logger.output.write('\x1b[32mprivate payroll secret\x1b[0m\n');
    logger.write('user typed private calendar secret\n');
    logger.close(0);
    assert.ok(logger.path.startsWith(path.join(cwd, 'atris', 'runs')));
    const text = fs.readFileSync(logger.path, 'utf8');
    assert.match(text, /mode: pro/);
    assert.match(text, /transcript: redacted/);
    assert.match(text, /redacted_chars: \d+/);
    assert.match(text, /full transcript disabled by default/);
    assert.doesNotMatch(text, /private payroll secret/);
    assert.doesNotMatch(text, /private calendar secret/);
    assert.doesNotMatch(text, /\x1b\[/);
    assert.match(text, /exit_code: 0/);
    assert.match(chunks.join(''), /\x1b\[32mprivate payroll secret/);
  } finally {
    if (previousFull === undefined) delete process.env.AX_LOG_FULL;
    else process.env.AX_LOG_FULL = previousFull;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('ax auto logger can opt into full transcripts explicitly', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-log-full-test-'));
  fs.mkdirSync(path.join(cwd, 'atris'), { recursive: true });
  const previousFull = process.env.AX_LOG_FULL;
  process.env.AX_LOG_FULL = '1';
  const logger = ax.createRunLogger({
    cwd,
    mode: 'pro',
    kind: 'play',
    output: {
      isTTY: true,
      write() {
        return true;
      }
    }
  });

  try {
    logger.output.write('\x1b[32mfull transcript text\x1b[0m\n');
    logger.close(0);
    const text = fs.readFileSync(logger.path, 'utf8');
    assert.match(text, /transcript: full/);
    assert.match(text, /full transcript text/);
    assert.doesNotMatch(text, /\x1b\[/);
    assert.match(text, /exit_code: 0/);
  } finally {
    if (previousFull === undefined) delete process.env.AX_LOG_FULL;
    else process.env.AX_LOG_FULL = previousFull;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
