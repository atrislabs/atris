const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Readable } = require('node:stream');

const ax = require('../ax');
const repoRoot = path.resolve(__dirname, '..');

test('ax fast chat starts without business initialization crash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-chat-start-'));
  try {
    const res = spawnSync(process.execPath, [path.join(repoRoot, 'ax'), '--fast', '--chat'], {
      cwd: dir,
      input: '/exit\n',
      encoding: 'utf8',
      env: {
        ...process.env,
        ATRIS_SKIP_UPDATE_CHECK: '1',
      },
    });

    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /Atris 2 Fast chat/);
    assert.doesNotMatch(res.stderr, /Cannot access 'business' before initialization/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ax chat subcommand alias starts chat instead of sending a local prompt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-chat-alias-'));
  try {
    assert.deepEqual(ax.normalizeChatCommandArgs(['chat', 'ax', '--fast']), {
      args: ['--chat', '--fast'],
      chatRequested: true,
    });

    const res = spawnSync(process.execPath, [path.join(repoRoot, 'ax'), 'chat', 'ax', '--fast'], {
      cwd: dir,
      input: '/exit\n',
      encoding: 'utf8',
      env: {
        ...process.env,
        ATRIS_SKIP_UPDATE_CHECK: '1',
        AX_BACKEND_URL: 'http://127.0.0.1:1',
      },
    });

    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /Atris 2 Fast chat/);
    assert.doesNotMatch(res.stderr, /ECONNREFUSED|Request timeout|chat ax/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ax spawn aliases create and inspect durable worker requests without backend chat', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-spawn-'));
  try {
    assert.equal(ax.isAxSpawnCommand('spawn'), true);

    const created = spawnSync(process.execPath, [
      path.join(repoRoot, 'ax'),
      'spawn',
      'worker',
      '--task',
      'Fix one bounded bug',
      '--engine',
      'codex',
      '--json',
    ], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        ATRIS_SKIP_UPDATE_CHECK: '1',
      },
    });
    assert.equal(created.status, 0, created.stderr || created.stdout);
    const payload = JSON.parse(created.stdout);
    assert.equal(payload.action, 'spawn_created');
    assert.equal(payload.request.role, 'worker');
    assert.equal(payload.request.task, 'Fix one bounded bug');
    assert.match(payload.request.command, /^codex exec /);
    assert.doesNotMatch(created.stdout, /Atris 2/);

    const listed = spawnSync(process.execPath, [path.join(repoRoot, 'ax'), 'spawns', '--json'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        ATRIS_SKIP_UPDATE_CHECK: '1',
      },
    });
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    assert.equal(JSON.parse(listed.stdout).requests.length, 1);

    const shown = spawnSync(process.execPath, [path.join(repoRoot, 'ax'), 'spawn-status', payload.request.id, '--json'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        ATRIS_SKIP_UPDATE_CHECK: '1',
      },
    });
    assert.equal(shown.status, 0, shown.stderr || shown.stdout);
    assert.equal(JSON.parse(shown.stdout).request.id, payload.request.id);

    const help = spawnSync(process.execPath, [path.join(repoRoot, 'ax'), 'spawn', '--help'], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        ATRIS_SKIP_UPDATE_CHECK: '1',
      },
    });
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /Usage: ax spawn <role>/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ax detects YouTube URLs and builds local processor args', async () => {
  const url = 'https://www.youtube.com/watch?v=gBukk9LIklc';
  assert.equal(ax.extractYoutubeUrl(`watch ${url}.`), url);
  assert.deepEqual(ax.buildAxYoutubeArgs(url), [url]);
  assert.deepEqual(ax.buildAxYoutubeArgs(`extract takeaways ${url}`), [
    url,
    '--query',
    'extract takeaways',
  ]);

  const calls = [];
  await ax.runAxYoutubeCommand(['summarize this', url], {
    youtubeCommand: async (argv) => {
      calls.push(argv);
      return 0;
    },
  });
  assert.deepEqual(calls[0], [url, '--query', 'summarize this']);

  const explicit = [];
  await ax.runAxYoutubeCommand(['youtube', url, '--json'], {
    youtubeCommand: async (argv) => {
      explicit.push(argv);
      return 0;
    },
  });
  assert.deepEqual(explicit[0], [url, '--json']);

  const helpOutput = [];
  await ax.runAxYoutubeCommand(['youtube', '--help'], {
    output: (line) => helpOutput.push(line),
  });
  assert.match(helpOutput.join('\n'), /Usage: ax youtube process/);
});

test('ax chat routes pasted YouTube URLs to local processor without backend chat', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-youtube-chat-'));
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  const url = 'https://www.youtube.com/watch?v=gBukk9LIklc';
  const calls = [];
  const writes = [];
  try {
    await ax.chat({
      mode: 'fast',
      cwd: dir,
      input: Readable.from([`${url}\n`]),
      output: {
        isTTY: false,
        write(chunk) {
          writes.push(String(chunk));
          return true;
        },
      },
      youtubeCommand: async (argv, deps) => {
        calls.push(argv);
        deps.output('processed via local youtube command');
        return 0;
      },
    });

    assert.deepEqual(calls, [[url]]);
    const text = writes.join('');
    assert.match(text, /processed via local youtube command/);
    assert.doesNotMatch(text, /Blocked: direct network access/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ax dogfoods fast chat with a 25-loop checklist', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-dogfood-chat-'));
  fs.mkdirSync(path.join(dir, 'atris'), { recursive: true });
  try {
    const report = await ax.runChatDogfood({ cwd: dir, loops: 25 });
    assert.equal(report.schema, 'atris.ax_chat_dogfood.v1');
    assert.equal(report.loops_run, 25);
    assert.equal(report.failures.length, 0);
    assert.equal(report.checklist.every(item => item.passed), true);
    assert.ok(fs.existsSync(report.log_path));
    assert.equal(report.turn_calls.some(call => call.message === 'hi' && call.route === 'cloud' && !call.workspace_path), true);
    assert.equal(report.turn_calls.some(call => call.message === 'what files are here?' && call.route === 'cloud' && !call.workspace_path), true);
    assert.equal(report.youtube_calls.length, 1);
    assert.match(ax.formatChatDogfoodReport(report), /loops: 25\/25/);
    assert.match(ax.formatChatDogfoodReport(report), /checklist: 12\/12 passed/);
    assert.doesNotMatch(report.output, /atris:|composer-2-5|gpt-|kimi|fable|fireworks|openrouter/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ax dogfood status summarizes overnight mission proof', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-dogfood-status-'));
  const missionId = 'mission-test-dogfood';
  try {
    fs.mkdirSync(path.join(dir, '.atris', 'state'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'atris', 'runs'), { recursive: true });
    fs.appendFileSync(path.join(dir, '.atris', 'state', 'missions.jsonl'), `${JSON.stringify({
      schema: 'atris.mission.v1',
      id: missionId,
      status: 'ready',
      cadence: '13m',
      verifier: 'node ax --dogfood-chat --loops 25',
      last_tick_index: 2,
      last_tick_at: '2026-06-23T08:00:00.000Z',
      updated_at: '2026-06-23T08:00:00.000Z',
    })}\n`);

    const stdout = [
      'Ax fast chat dogfood',
      'loops: 25/25',
      'checklist: 12/12 passed',
      `log: ${path.join(dir, 'atris', 'runs', 'ax-play-test.log')}`,
    ].join('\n');
    for (const index of [1, 2]) {
      fs.writeFileSync(path.join(dir, 'atris', 'runs', `mission-${missionId}-tick-${index}.json`), JSON.stringify({
        tick: { tick_index: index, verifier_passed: true },
        verifier_result: { passed: true, stdout },
      }));
    }
    fs.writeFileSync(path.join(dir, 'atris', 'runs', 'ax-fast-chat-overnight-cron.log'), [
      '=== ax fast chat dogfood tick 2026-06-23T08:00:00Z ===',
      'ok',
    ].join('\n'));

    const status = ax.buildChatDogfoodStatus({
      cwd: dir,
      crontabText: '*/13 * * * * tick.sh # ATRIS_AX_FAST_CHAT_DOGFOOD',
    });
    assert.equal(status.mission_id, missionId);
    assert.equal(status.clean_chat_loops, 50);
    assert.equal(status.target_met, true);
    assert.equal(status.overnight_proven, true);
    assert.equal(status.clean_tick_count, 2);
    assert.equal(status.cron_runs, 1);
    assert.match(ax.formatChatDogfoodStatusReport(status), /loops: 50\/25 clean/);
    assert.match(ax.formatChatDogfoodStatusReport(status), /result: overnight 25-loop proof is complete/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ax routes fresh-user workspace questions to hosted cloud by default', () => {
  assert.equal(ax.resolveRoute('what files are here?'), 'cloud');
  assert.equal(ax.resolveRoute('search src for the input component'), 'cloud');
  assert.equal(ax.resolveRoute('fix the xp game tests'), 'cloud');

  const payload = ax.buildPayload('what files are here?', {
    mode: 'fast',
    cwd: '/tmp/project',
  });

  assert.equal(payload.model, 'atris:fast');
  assert.equal(payload.workspace_path, undefined);
  assert.equal(payload.max_turns, 1);
  assert.equal(payload.member_slug, 'ax');
  assert.equal(payload.bypass_permissions, false);
});

test('ax uses local workspace tools only when a local backend is configured or forced', () => {
  assert.equal(ax.resolveRoute('what files are here?', { localWorkspaceBackend: true }), 'local');
  assert.equal(ax.resolveRoute('search src for the input component', { localWorkspaceBackend: true }), 'local');

  const payload = ax.buildPayload('what files are here?', {
    mode: 'fast',
    cwd: '/tmp/project',
    localWorkspaceBackend: true,
  });

  assert.equal(payload.workspace_path, '/tmp/project');
  assert.equal(payload.max_turns, 8);
});

test('ax routes greetings and no-intent snippets to cloud chat', () => {
  assert.equal(ax.resolveRoute('hi'), 'cloud');
  assert.equal(ax.resolveRoute('ax'), 'cloud');
  assert.equal(ax.resolveRoute('pop'), 'cloud');
  assert.equal(ax.resolveRoute('hello why'), 'cloud');
  assert.equal(ax.resolveRoute('hello please'), 'cloud');
  assert.equal(ax.resolveRoute('oj'), 'cloud');
  assert.equal(ax.resolveRoute('fix'), 'cloud');
  assert.equal(ax.resolveRoute('what files are here?'), 'cloud');

  const payload = ax.buildPayload('hi', {
    mode: 'fast',
    cwd: '/tmp/project',
  });

  assert.equal(payload.model, 'atris:fast');
  assert.equal(payload.workspace_path, undefined);
  assert.equal(payload.max_turns, 1);
});

test('ax exposes Atris 2 Max as the highest-reasoning tier', () => {
  assert.equal(ax.modelForMode('max'), 'atris:max');

  const payload = ax.buildPayload('refactor this module and verify the tests', {
    mode: 'max',
    cwd: '/tmp/project',
  });
  assert.equal(payload.model, 'atris:max');
  assert.equal(payload.workspace_path, undefined);
  assert.equal(payload.max_turns, 1);

  const cloudWrite = ax.buildPayload('send a slack message to the team', {
    mode: 'max',
    route: 'cloud',
    bypassPermissions: true,
  });
  assert.equal(cloudWrite.max_turns, 4);
  assert.equal(cloudWrite.allow_external_actions, true);

  const cloudSafe = ax.buildPayload('send a slack message to the team', {
    mode: 'max',
    route: 'cloud',
    bypassPermissions: false,
  });
  assert.equal(cloudSafe.allow_external_actions, undefined);

  assert.match(ax.formatHeader({ mode: 'max', cwd: '/tmp/project', chat: true }), /Atris 2 Max chat {2}· {2}\/tmp\/project/);
  // permission state lives on the status line below the box, not the header
  assert.doesNotMatch(ax.formatHeader({ mode: 'max', cwd: '/tmp/project', chat: true }), /permissions safe/);

  const profile = ax.buildRunProfile({ mode: 'max', cwd: '/tmp/project' });
  assert.equal(profile.model, 'atris:max');
  assert.equal(profile.max_turns, 1);
  assert.equal(profile.route, 'cloud');
  assert.match(profile.reasoning, /high reasoning/);
  assert.doesNotMatch(ax.formatRunProfile(profile, { color: false }), /\bbackend\b/i);
});

test('ax defaults to fast tier when no mode flag is set', () => {
  const profile = ax.buildRunProfile({ cwd: '/tmp/project' });
  assert.equal(profile.mode, 'fast');
  assert.equal(profile.model, 'atris:fast');
  assert.equal(profile.max_turns, 1);
  assert.equal(profile.route, 'cloud');
  assert.match(ax.formatHeader({ cwd: '/tmp/project', chat: true }), /Atris 2 Fast chat/);
});

test('ax never shows model ids to the user and swaps tiers in chat', () => {
  const modelPattern = /atris:|composer-2-5|gpt-|kimi|fable|fireworks|openrouter/i;
  for (const mode of ['fast', 'pro', 'max', 'code-fast']) {
    assert.doesNotMatch(ax.formatHeader({ mode, cwd: '/tmp/project', chat: true }), modelPattern);
  }
  assert.match(ax.formatHeader({ mode: 'pro', cwd: '/tmp/project', chat: true }), /shift\+enter newline/);

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
  assert.equal(ax.chatPermissionCommand('/bypass'), true);
  assert.equal(ax.chatPermissionCommand('/safe'), false);
  assert.equal(ax.chatTierCommand('build /max speed'), null);
  assert.equal(ax.chatTierCommand('max'), null);

  assert.equal(ax.formatPrompt('max'), 'max › ');
  assert.equal(ax.formatPrompt(), '› ');
  assert.match(ax.formatChatInputPrompt('fast', { color: false }), /^ {2}→ fast › /);
  // Top/bottom are plain rules; the mode + shift+enter affordance is a status
  // line below the box, and "enter send" is never shown.
  assert.match(ax.formatInputBoxTop({ color: false }), /^╭─+╮$/);
  assert.match(ax.formatInputBoxStatus({ color: false, bypassPermissions: false }), /^ {2}approve · shift\+enter$/);
  assert.match(ax.formatInputBoxStatus({ color: false, bypassPermissions: true }), /^ {2}full access · shift\+enter$/);
  assert.doesNotMatch(ax.formatInputBoxStatus({ color: false }), /enter send/);
  assert.match(ax.formatInputBoxBottom({ color: false }), /^╰─+╯$/);
  assert.equal(ax.buildInputBoxTopPlain({ columns: 80 }).length, 79);
  assert.equal(ax.buildInputBoxBottomPlain({ columns: 80 }).length, 79);
  assert.match(ax.formatInputBoxInputRow('│ → fast › ', 'hello', { color: false, columns: 40 }), /│ → fast › hello\s+│$/);
  assert.equal(ax.isPermissionToggleKey({ shift: true, name: 'tab' }), true);
  assert.equal(ax.isPermissionToggleKey({ name: 'tab' }), false);
  assert.equal(ax.isPermissionToggleKey({ sequence: '\x1b[Z' }), true);
  assert.equal(ax.isMultilineInsertKey('\n', { sequence: '\n' }), true);
  assert.equal(ax.isMultilineInsertKey('', { shift: true, name: 'return' }), true);
  assert.equal(ax.isMultilineInsertKey('', { name: 'return' }), false);
  assert.match(ax.formatPermissionToggleMessage(false, { color: false }), /Approve mode.*ask before they run/);
  assert.match(ax.formatPermissionToggleMessage(true, { color: false }), /Full access.*without approval/);
  assert.deepEqual(ax.permissionAccentCodes({ bypassPermissions: false, color: false }), ['\x1b[2m', '\x1b[34m']);
  assert.deepEqual(ax.permissionAccentCodes({ bypassPermissions: true, color: false }), ['\x1b[2m', '\x1b[33m']);
});

test('ax input box survives three ask cycles without stacked borders', () => {
  const writes = [];
  const out = { isTTY: true, columns: 80, write: (chunk) => writes.push(String(chunk)) };
  const layout = (bypass) => ({ color: false, columns: 79, bypassPermissions: bypass });

  for (let round = 0; round < 3; round += 1) {
    out.write(`\n${ax.formatInputBoxTop(layout(round % 2 === 0))}\n`);
    out.write(`${ax.formatChatInputPrompt('fast', layout(false))}hello\n`);
    ax.closeInputBox(out, layout(false));
  }

  const joined = writes.join('');
  assert.equal((joined.match(/╰─+╯/g) || []).length, 3);
  assert.equal((joined.match(/╭/g) || []).length, 3);
  assert.doesNotMatch(joined, /\x1b\[2A/);

  const previousNoColor = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  try {
    // mode color now lives on the status line below the box, not the plain top
    assert.match(
      ax.formatInputBoxStatus({ color: true, isTTY: true, bypassPermissions: false, columns: 80 }),
      /\x1b\[34mapprove/,
    );
    assert.match(
      ax.formatInputBoxStatus({ color: true, isTTY: true, bypassPermissions: true, columns: 80 }),
      /\x1b\[33mfull access/,
    );
  } finally {
    if (previousNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previousNoColor;
  }
});

test('ax repaintInputBoxBottom closes the box below single and multiline input', () => {
  const readline = require('node:readline');
  const { PassThrough } = require('node:stream');
  const layout = { color: false, columns: 79, bypassPermissions: false };
  const makeRl = (line, cursor) => {
    const input = new PassThrough();
    input.isTTY = true;
    input.setRawMode = () => {};
    const output = new PassThrough();
    output.isTTY = true;
    output.columns = 80;
    const rl = readline.createInterface({ input, output, terminal: true, prompt: '│ → fast › ' });
    rl.line = line;
    rl.cursor = cursor;
    return rl;
  };
  const capture = (line, cursor) => {
    let writes = '';
    ax.repaintInputBoxBottom(makeRl(line, cursor), { write: (c) => { writes += String(c); } }, layout);
    return writes;
  };

  // cursor at end of a single-line input -> rule one row below, status under it,
  // and the cursor returns up by rule-row + status-row (down + 1 = 2).
  const single = capture('hi', 2);
  assert.match(single, /╰─+╯/);
  assert.match(single, /approve · shift\+enter/);
  assert.doesNotMatch(single, /enter send/);
  assert.match(single, /\x1b\[1B/);
  assert.match(single, /\x1b\[2A/);

  // cursor parked on the first row of a two-row input -> rule two rows below
  const multi = capture('aaa\nbbb', 1);
  assert.match(multi, /╰─+╯/);
  assert.match(multi, /approve · shift\+enter/);
  assert.match(multi, /\x1b\[2B/);
  assert.match(multi, /\x1b\[3A/);

  // missing readline cursor helpers must be a no-op, never throw
  let safe = '';
  ax.repaintInputBoxBottom({ line: 'x', _prompt: '> ' }, { write: (c) => { safe += String(c); } }, layout);
  assert.equal(safe, '');

  // input taller than the viewport must skip the rule (scroll would scramble it)
  const tall = makeRl(Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'), 0);
  let tallOut = '';
  ax.repaintInputBoxBottom(tall, { rows: 16, write: (c) => { tallOut += String(c); } }, layout);
  assert.equal(tallOut, '');
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
  assert.match(menu, /\/goal/);
  assert.match(menu, /\/fast/);
  assert.match(menu, /\/pro/);
  assert.match(menu, /\/max/);
  assert.match(menu, /\/bypass/);
  assert.match(menu, /\/safe/);
  assert.match(menu, /shift\+tab/);
  assert.match(menu, /\/help/);
  assert.doesNotMatch(menu, /atris:|gpt-|kimi|fable|composer/i);

  assert.deepEqual(ax.chatCompleter('/f'), [['/fast'], '/f']);
  assert.deepEqual(ax.chatCompleter('/'), [['/goal', '/fast', '/pro', '/max', '/bypass', '/safe', '/help'], '/']);
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

  assert.equal(ax.formatWorkingLine(2100), '• Thinking… (2s · ctrl-c to interrupt)');
  assert.equal(ax.formatWorkingLine(2100, 'Reading', '⠙'), '• Reading… (2s · ctrl-c to interrupt)');

  const colored = { color: true, isTTY: true };
  const previousNoColor = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  try {
    assert.match(ax.formatWorkingLine(2100, 'Reading', { ...colored, frameChar: '⠙', tick: 3 }), /\x1b\[97m/);
    assert.match(ax.formatWorkingLine(2100, 'Reading', { ...colored, frameChar: '⠙', tick: 3 }), /R.*e.*a.*d.*i.*n.*g/);
    assert.doesNotMatch(ax.formatWorkingLine(2100, 'Reading', { ...colored, tick: 3 }), /\x1b\[1m/);
    assert.notEqual(
      ax.formatWorkingLine(2100, 'Reading', { ...colored, frameChar: '⠙', tick: 3 }),
      ax.formatWorkingLine(2100, 'Reading', { ...colored, frameChar: '⠙', tick: 7 })
    );
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

test('ax continuation wrapper marks current user message for backend connector routing', () => {
  const wrapped = ax.buildMessage('check my slack messages', [
    { role: 'user', content: 'what is on my calendar today' },
    { role: 'assistant', content: 'Calendar today: standup' },
  ]);
  assert.match(wrapped, /# Current user message\ncheck my slack messages$/);
  assert.doesNotMatch(wrapped, /Current user message: check my slack messages/);
});

test('ax routes GitHub repo mutations to cloud unless local workspace is configured', () => {
  assert.equal(ax.resolveRoute('push something to github'), 'cloud');
  assert.equal(ax.resolveRoute('commit a tiny proof change and push to github'), 'cloud');
  assert.equal(ax.resolveRoute('open a pull request for this branch on github'), 'cloud');
  assert.equal(ax.resolveRoute('push something to github', { localWorkspaceBackend: true }), 'local');
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
  assert.equal(defaultPayload.workspace_path, undefined);

  const blankPayload = ax.buildPayload('what files are here?', {
    mode: 'fast',
    cwd: '/tmp/project',
    verify: '   ',
  });
  assert.equal(blankPayload.verify_command, 'true');
  assert.equal(blankPayload.workspace_path, undefined);

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
  assert.match(ax.formatUsage(), /ax spawn <role> --task/);
  assert.match(ax.formatUsage(), /atris agent spawn <role> --task/);
});

test('ax exposes Atris Code Fast as an explicit public lane', () => {
  const previousBackend = process.env.AX_CODE_FAST_BACKEND_URL;
  const previousApiBase = process.env.AX_CODE_FAST_API_BASE;
  const previousAtrisApiBase = process.env.ATRIS_API_BASE;
  delete process.env.AX_CODE_FAST_BACKEND_URL;
  delete process.env.AX_CODE_FAST_API_BASE;
  delete process.env.ATRIS_API_BASE;

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
    assert.equal(ax.codeFastUrl({ route: 'local' }), 'http://127.0.0.1:8000/api/cursor/turn');
    assert.equal(ax.codeFastUrl({ route: 'cloud' }), 'https://api.atris.ai/api/cursor/turn');
    assert.equal(
      ax.buildRunProfile({ mode: 'code-fast', route: 'cloud', cwd: '/tmp/project' }).endpoint,
      'https://api.atris.ai/api/cursor/turn'
    );
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
    if (previousAtrisApiBase === undefined) delete process.env.ATRIS_API_BASE;
    else process.env.ATRIS_API_BASE = previousAtrisApiBase;
  }
});

test('ax backend URL is configurable', () => {
  const previous = process.env.AX_BACKEND_URL;
  const previousCloud = process.env.OBELISK_ATRIS2_BACKEND_URL;
  const previousApiBase = process.env.ATRIS_API_BASE;
  delete process.env.AX_BACKEND_URL;
  delete process.env.OBELISK_ATRIS2_BACKEND_URL;
  delete process.env.ATRIS_API_BASE;
  try {
    assert.equal(ax.backendUrl(), 'https://api.atris.ai/api/atris2/turn');

    process.env.AX_BACKEND_URL = 'http://127.0.0.1:9001';
    assert.equal(ax.backendUrl(), 'http://127.0.0.1:9001/api/atris2/turn');
    assert.equal(ax.backendUrl({ route: 'local' }), 'http://127.0.0.1:9001/api/atris2/turn');
    assert.equal(ax.backendUrl({ route: 'cloud' }), 'https://api.atris.ai/api/atris2/turn');
    assert.equal(
      ax.buildRunProfile({ mode: 'fast', route: 'cloud', cwd: '/tmp/project' }).endpoint,
      'https://api.atris.ai/api/atris2/turn'
    );
  } finally {
    if (previous === undefined) delete process.env.AX_BACKEND_URL;
    else process.env.AX_BACKEND_URL = previous;
    if (previousCloud === undefined) delete process.env.OBELISK_ATRIS2_BACKEND_URL;
    else process.env.OBELISK_ATRIS2_BACKEND_URL = previousCloud;
    if (previousApiBase === undefined) delete process.env.ATRIS_API_BASE;
    else process.env.ATRIS_API_BASE = previousApiBase;
  }
});

test('ax backend hint defaults to hosted cloud without local setup instructions', () => {
  const writes = [];
  const originalLog = console.log;
  try {
    console.log = (line = '') => writes.push(String(line));
    ax.printBackendHint();
  } finally {
    console.log = originalLog;
  }

  const text = writes.join('\n');
  assert.match(text, /ax --cloud "hello"/);
  assert.match(text, /ATRIS_API_BASE=https:\/\/api\.atris\.ai/);
  assert.doesNotMatch(text, /AX_BACKEND_URL=http:\/\/127\.0\.0\.1:8000/);
  assert.doesNotMatch(text, /\blocal\b.*\bbackend\b/i);
  assert.doesNotMatch(text, /\/Users\/keshavrao\/arena\/atrisos-backend/);
});

test('ax backend hint shows local developer lane only when local is requested', () => {
  const writes = [];
  const originalLog = console.log;
  try {
    console.log = (line = '') => writes.push(String(line));
    ax.printBackendHint({ route: 'local' });
  } finally {
    console.log = originalLog;
  }

  const text = writes.join('\n');
  assert.match(text, /Local developer lane/);
  assert.match(text, /AX_BACKEND_URL=http:\/\/127\.0\.0\.1:8000/);
  assert.doesNotMatch(text, /\/Users\/keshavrao\/arena\/atrisos-backend/);
});

test('ax formats paths with filename emphasis spacing', () => {
  const formatted = ax.formatPathSubject(path.join('/tmp', 'project', 'src', 'App.tsx'), { color: false });
  assert.equal(formatted, '/tmp/project/src/  App.tsx');
});

test('ax renders basic markdown for terminal output', () => {
  assert.equal(ax.renderTerminalMarkdown('## Heading\nUse **bold** and `code`.', { color: false }), 'Heading\nUse bold and code.');
  assert.equal(ax.renderTerminalMarkdown('*hello* and _there_', { color: false }), 'hello and there');
  assert.equal(ax.renderTerminalMarkdown('- one\n* two\n1. three', { color: false }), '• one\n• two\n• three');
  assert.equal(ax.renderTerminalMarkdown('> quote line', { color: false }), '▏ quote line');
  assert.equal(ax.renderTerminalMarkdown('~~gone~~', { color: false }), 'gone');
  assert.equal(ax.renderTerminalMarkdown('[docs](https://example.com)', { color: false }), 'docs (https://example.com)');
  const previousNoColor = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  try {
    const rendered = ax.renderTerminalMarkdown('Use **bold** and `code`.', { color: true, isTTY: true });
    assert.match(rendered, /\x1b\[1mbold\x1b\[0m/);
    assert.match(rendered, /\x1b\[36mcode\x1b\[0m/);
    const italic = ax.renderTerminalMarkdown('*hello*', { color: true, isTTY: true });
    assert.match(italic, /\x1b\[3mhello\x1b\[0m/);
    const strike = ax.renderTerminalMarkdown('~~nope~~', { color: true, isTTY: true });
    assert.match(strike, /\x1b\[9mnope\x1b\[0m/);
  } finally {
    if (previousNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previousNoColor;
  }
});

test('ax streaming markdown handles split bold delimiters', () => {
  const state = { markdownMode: 'normal', markdownBuffer: '', markdownCarry: '', markdownDelim: '', atLineStart: true };
  const options = { color: false, isTTY: true };
  assert.equal(ax.renderStreamingMarkdown(state, 'This is *', options), 'This is ');
  assert.equal(ax.renderStreamingMarkdown(state, '*bold', options), '');
  assert.equal(ax.renderStreamingMarkdown(state, '** now', options), 'bold now');
});

test('ax streaming markdown renders italic spans', () => {
  const state = { markdownMode: 'normal', markdownBuffer: '', markdownCarry: '', markdownDelim: '', atLineStart: true };
  const options = { color: true, isTTY: true };
  const previousNoColor = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  try {
    assert.equal(ax.renderStreamingMarkdown(state, 'Say *hel', options), 'Say ');
    assert.match(ax.renderStreamingMarkdown(state, 'lo* friend', options), /\x1b\[3mhello\x1b\[0m friend/);
  } finally {
    if (previousNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previousNoColor;
  }
});

test('ax streaming markdown renders block lines and links', () => {
  const state = { markdownMode: 'normal', markdownBuffer: '', markdownCarry: '', markdownDelim: '', atLineStart: true };
  const options = { color: false, isTTY: true };
  assert.equal(ax.renderStreamingMarkdown(state, '## Title\n', options), 'Title\n');
  assert.equal(ax.renderStreamingMarkdown(state, '- item one\n', options), '• item one\n');
  assert.equal(ax.renderStreamingMarkdown(state, '[link](https://example.com)', options), 'link (https://example.com)');
});

test('ax streaming markdown carries split heading markers instead of leaking ##', () => {
  const state = { markdownMode: 'normal', markdownBuffer: '', markdownCarry: '', markdownDelim: '', atLineStart: true };
  const options = { color: false, isTTY: true };
  // "##" and " Sample" arrive in separate deltas — must not leak the hashes
  let out = ax.renderStreamingMarkdown(state, '##', options);
  out += ax.renderStreamingMarkdown(state, ' Sample\n', options);
  out += ax.renderStreamingMarkdown(state, 'body\n', options);
  assert.equal(out, 'Sample\nbody\n');
});

test('ax streaming markdown renders fenced code blocks (split across deltas)', () => {
  const state = { markdownMode: 'normal', markdownBuffer: '', markdownCarry: '', markdownDelim: '', atLineStart: true };
  const options = { color: false, isTTY: true };
  // language label and the fences must be consumed, body indented two spaces
  let out = '';
  for (const delta of ['```py', 'thon\n', 'def greet():\n', '    return 1\n', '``', '`\n', 'after\n']) {
    out += ax.renderStreamingMarkdown(state, delta, options);
  }
  assert.equal(out, '  def greet():\n      return 1\nafter\n');
  assert.equal(state.markdownMode, 'normal');

  // whole fence in one delta
  const state2 = { markdownMode: 'normal', markdownBuffer: '', markdownCarry: '', markdownDelim: '', atLineStart: true };
  assert.equal(
    ax.renderStreamingMarkdown(state2, '```js\nconst a = 1;\n```\ndone\n', options),
    '  const a = 1;\ndone\n',
  );
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
    markdownDelim: '',
    atLineStart: true,
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

test('ax manageTurnInterrupt routes abort through registerAbort or SIGINT', () => {
  let registered = null;
  let fired = false;
  const cleanup = ax.manageTurnInterrupt(() => {
    fired = true;
  }, {
    registerAbort(fn) {
      registered = fn;
    },
  });
  assert.equal(typeof registered, 'function');
  registered();
  assert.equal(fired, true);
  cleanup();
});

test('postTurn aborts in-flight SSE turn on interrupt', async () => {
  const http = require('http');
  const originalRequest = http.request;
  let destroyCalled = false;
  http.request = (_opts, callback) => {
    const req = {
      on(event, handler) {
        if (event === 'error') this._errorHandler = handler;
      },
      destroy() {
        destroyCalled = true;
        if (this._errorHandler) this._errorHandler(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
      },
      setTimeout() {},
      write() {},
      end() {
        callback({
          statusCode: 200,
          setEncoding() {},
          on() {},
        });
      },
    };
    return req;
  };
  try {
    let abort = null;
    const turn = ax.postTurn('hello', {
      cwd: process.cwd(),
      route: 'local',
      registerAbort(fn) { abort = fn; },
      showProgress: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    abort();
    const result = await turn;
    assert.equal(result.interrupted, true);
    assert.equal(destroyCalled, true);
  } finally {
    http.request = originalRequest;
  }
});
