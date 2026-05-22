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
    assert.match(ax.formatHeader({ mode: 'code-fast', cwd: '/tmp/project' }), /Atris Code Fast \(composer-2-5-fast\)/);
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
