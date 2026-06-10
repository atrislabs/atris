const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ax = require('../ax');

test('ax routes workspace questions to local Atris 2 tools', () => {
  assert.equal(ax.resolveRoute('what files are here?'), 'local');
  assert.equal(ax.resolveRoute('search src for the input component'), 'local');
  assert.equal(ax.resolveRoute('fix the xp game tests'), 'local');

  const payload = ax.buildPayload('what files are here?', {
    mode: 'fast',
    cwd: '/tmp/project',
  });

  assert.equal(payload.model, 'atris:fast');
  assert.equal(payload.workspace_path, '/tmp/project');
  assert.equal(payload.max_turns, 8);
});

test('ax exposes Atris 2 Max as the highest-reasoning tier', () => {
  assert.equal(ax.modelForMode('max'), 'atris:max');

  const payload = ax.buildPayload('refactor this module and verify the tests', {
    mode: 'max',
    cwd: '/tmp/project',
  });
  assert.equal(payload.model, 'atris:max');
  assert.equal(payload.workspace_path, '/tmp/project');
  assert.equal(payload.max_turns, 14);

  const cloudWrite = ax.buildPayload('send a slack message to the team', {
    mode: 'max',
    route: 'cloud',
  });
  assert.equal(cloudWrite.max_turns, 4);

  assert.match(ax.formatHeader({ mode: 'max', cwd: '/tmp/project', chat: true }), /Atris 2 Max chat/);

  const profile = ax.buildRunProfile({ mode: 'max', cwd: '/tmp/project' });
  assert.equal(profile.model, 'atris:max');
  assert.equal(profile.max_turns, 14);
  assert.match(profile.reasoning, /high reasoning/);
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
  assert.equal(ax.resolveRoute('what is on my calendar today?'), 'cloud');
  assert.equal(ax.resolveRoute('which integrations are connected?'), 'cloud');
  assert.equal(ax.resolveRoute('what github repos do I have?'), 'cloud');
  assert.equal(ax.resolveRoute('create a github issue for this bug'), 'cloud');

  const payload = ax.buildPayload('what is on my calendar today?', {
    mode: 'fast',
    cwd: '/tmp/project',
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

test('ax routes GitHub repo mutations to local workspace tools', () => {
  assert.equal(ax.resolveRoute('push something to github'), 'local');
  assert.equal(ax.resolveRoute('commit a tiny proof change and push to github'), 'local');
  assert.equal(ax.resolveRoute('open a pull request for this branch on github'), 'local');
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

test('ax auto logger writes clean chat transcripts under atris/runs', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-log-test-'));
  fs.mkdirSync(path.join(cwd, 'atris'), { recursive: true });
  const chunks = [];
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
    logger.output.write('\x1b[32matris text\x1b[0m\n');
    logger.close(0);
    assert.ok(logger.path.startsWith(path.join(cwd, 'atris', 'runs')));
    const text = fs.readFileSync(logger.path, 'utf8');
    assert.match(text, /mode: pro/);
    assert.match(text, /atris text/);
    assert.doesNotMatch(text, /\x1b\[/);
    assert.match(text, /exit_code: 0/);
    assert.match(chunks.join(''), /\x1b\[32matris text/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
