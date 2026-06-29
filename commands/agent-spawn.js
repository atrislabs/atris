const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { resolveClaudeRunnerBin } = require('../lib/runner-command');

const SPAWN_SCHEMA = 'atris.agent_spawn.v1';
const DOGFOOD_SCHEMA = 'atris.agent_cli_dogfood.v1';
const SPAWN_STATE_REL = path.join('.atris', 'state', 'agent_spawns.jsonl');
const ALLOWED_ENGINES = new Set(['manual', 'codex', 'claude', 'cursor', 'devin', 'droid']);
const DOGFOOD_ENGINES = new Set(['devin', 'droid']);

function nowIso() {
  return new Date().toISOString();
}

function spawnStatePath(root = process.cwd()) {
  return path.join(root, SPAWN_STATE_REL);
}

function ensureSpawnState(root = process.cwd()) {
  const statePath = spawnStatePath(root);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  return statePath;
}

function readJsonl(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function loadSpawnRequests(root = process.cwd()) {
  return readJsonl(spawnStatePath(root));
}

function appendSpawnRequest(root, request) {
  const statePath = ensureSpawnState(root);
  fs.appendFileSync(statePath, `${JSON.stringify(request)}\n`);
  return statePath;
}

function idForSpawn(role) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const suffix = crypto.randomBytes(3).toString('hex');
  const cleanRole = String(role || 'agent').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'agent';
  return `spawn-${stamp}-${cleanRole}-${suffix}`;
}

function flagValue(args, names) {
  for (const name of names) {
    const inline = args.find(arg => arg.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const idx = args.indexOf(name);
    if (idx !== -1 && idx < args.length - 1 && !String(args[idx + 1]).startsWith('--')) return args[idx + 1];
  }
  return null;
}

function hasFlag(args, names) {
  return names.some(name => args.includes(name));
}

function positionalArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      if (!arg.includes('=') && i < args.length - 1 && !String(args[i + 1]).startsWith('--')) i++;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function runsDir(root = process.cwd()) {
  const atrisRuns = path.join(root, 'atris', 'runs');
  if (fs.existsSync(path.join(root, 'atris'))) return atrisRuns;
  return path.join(root, '.atris', 'runs');
}

function commandOnPath(name, deps = {}) {
  if (typeof deps.commandOnPath === 'function') return deps.commandOnPath(name);
  const runner = deps.spawnSync || spawnSync;
  const result = runner('which', [name], { encoding: 'utf8', timeout: 1000 });
  return result.status === 0 ? String(result.stdout || '').trim() : null;
}

function runCli(argv, deps = {}, options = {}) {
  const runner = deps.spawnSync || spawnSync;
  const [cmd, ...args] = argv;
  const started = Date.now();
  const result = runner(cmd, args, {
    cwd: options.cwd || deps.root || process.cwd(),
    encoding: 'utf8',
    timeout: options.timeoutMs || 30000,
    maxBuffer: 1024 * 1024 * 4,
    env: options.env || process.env,
  });
  return {
    command: argv.join(' '),
    status: result.status,
    signal: result.signal || null,
    ok: !result.error && result.status === 0,
    duration_ms: Date.now() - started,
    error: result.error ? result.error.message : null,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

function buildDelegatePrompt({ role, task, cwd }) {
  return [
    `You are an Atris delegated ${role}.`,
    '',
    `Workspace: ${cwd || process.cwd()}`,
    `Task: ${task}`,
    '',
    'Do one bounded proof-backed pass.',
    'Do not revert unrelated edits.',
    'Return changed files, verifier commands, and remaining risk.',
  ].join('\n');
}

function commandForEngine(request) {
  const prompt = buildDelegatePrompt(request);
  if (request.engine === 'codex') return `codex exec ${shellQuote(prompt)}`;
  if (request.engine === 'claude') return `${shellQuote(resolveClaudeRunnerBin())} -p ${shellQuote(prompt)}`;
  if (request.engine === 'cursor') return `cursor-agent ${shellQuote(prompt)}`;
  if (request.engine === 'devin') return `devin --model glm-5.2 --permission-mode auto -p ${shellQuote(prompt)}`;
  if (request.engine === 'droid') return `droid exec --model glm-5.2 --reasoning-effort off ${shellQuote(prompt)}`;
  return null;
}

function parseSpawnArgs(args = []) {
  const help = args.length === 0 || hasFlag(args, ['--help', '-h']) || args[0] === 'help';
  if (help) return { help: true };

  const json = hasFlag(args, ['--json']);
  const dryRun = hasFlag(args, ['--dry-run']);
  const roleFlag = flagValue(args, ['--role']);
  const engine = String(flagValue(args, ['--engine']) || 'manual').toLowerCase();
  if (!ALLOWED_ENGINES.has(engine)) throw new Error(`Unknown engine: ${engine}`);

  const pos = positionalArgs(args);
  const role = roleFlag || pos[0];
  const task = flagValue(args, ['--task', '--message']) || pos.slice(roleFlag ? 0 : 1).join(' ');
  if (!role) throw new Error('Missing role. Usage: atris agent spawn <role> --task "..."');
  if (!String(task || '').trim()) throw new Error('Missing task. Usage: atris agent spawn <role> --task "..."');

  return {
    help: false,
    json,
    dryRun,
    role: String(role).trim(),
    task: String(task).trim(),
    engine,
  };
}

function createSpawnRequest(root, options) {
  const request = {
    schema: SPAWN_SCHEMA,
    id: idForSpawn(options.role),
    status: 'requested',
    role: options.role,
    task: options.task,
    engine: options.engine,
    cwd: root,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  request.command = commandForEngine(request);
  request.next_action = request.command
    ? `Run: ${request.command}`
    : 'Assign this request to a worker runtime, or rerun with --engine codex|claude|cursor|devin|droid.';
  return request;
}

function showSpawnHelp(output = console.log, commandName = 'atris agent spawn') {
  output(`Usage: ${commandName} <role> --task "<bounded task>" [options]`);
  output('');
  output('Create a durable worker request that ax, humans, or another runtime can pick up.');
  output('');
  output('Options:');
  output('  --task <text>      Bounded task to delegate');
  output('  --engine <name>    manual|codex|claude|cursor|devin|droid (default: manual)');
  output('  --json             Machine-readable output');
  output('  --dry-run          Preview without writing .atris/state/agent_spawns.jsonl');
  output('');
  output('Examples:');
  output(`  ${commandName} worker --task "Fix the failing smoke test"`);
  output(`  ${commandName} explorer --engine codex --task "Find where auth is routed"`);
}

function parseDogfoodArgs(args = []) {
  const help = hasFlag(args, ['--help', '-h']) || args[0] === 'help';
  const json = hasFlag(args, ['--json']);
  const live = hasFlag(args, ['--live']);
  const noWrite = hasFlag(args, ['--no-write']);
  const model = flagValue(args, ['--model']) || 'glm-5.2';
  const timeoutRaw = Number(flagValue(args, ['--timeout']) || 45);
  const timeoutMs = Math.max(5, Math.min(300, timeoutRaw)) * 1000;
  const engine = String(flagValue(args, ['--engine']) || positionalArgs(args)[0] || 'all').toLowerCase();
  if (engine !== 'all' && !DOGFOOD_ENGINES.has(engine)) {
    throw new Error(`Unknown dogfood engine: ${engine}. Use devin, droid, or all.`);
  }
  return { help, json, live, noWrite, model, timeoutMs, engine };
}

function livePromptFor(engine) {
  const upper = engine === 'devin' ? 'DEVIN' : 'DROID';
  return `Return exactly ATRIS_${upper}_GLM52_OK. Do not inspect files. Do not run tools.`;
}

function liveCommandFor(engine, model) {
  if (engine === 'devin') {
    return [
      'devin',
      '--model',
      model,
      '--permission-mode',
      'auto',
      '-p',
      livePromptFor(engine),
    ];
  }
  return [
    'droid',
    'exec',
    '--model',
    model,
    '--reasoning-effort',
    'off',
    '--output-format',
    'text',
    '--append-system-prompt',
    'Do not use tools. Reply with exactly the requested token.',
    livePromptFor(engine),
  ];
}

function dryChecksFor(engine, model, deps = {}, options = {}) {
  const binary = engine === 'devin' ? 'devin' : 'droid';
  const binaryPath = commandOnPath(binary, deps);
  const checks = [
    {
      name: 'binary_on_path',
      ok: Boolean(binaryPath),
      detail: binaryPath || `${binary} not on PATH`,
    },
  ];
  if (!binaryPath) return { binary, binaryPath, checks };

  const versionArgs = engine === 'devin' ? ['devin', 'version'] : ['droid', '--version'];
  const version = runCli(versionArgs, deps, options);
  checks.push({
    name: 'version_command',
    ok: version.ok,
    command: version.command,
    stdout_head: version.stdout.slice(0, 500),
    stderr_head: version.stderr.slice(0, 500),
  });

  const helpArgs = engine === 'devin' ? ['devin', '--help'] : ['droid', 'exec', '--help'];
  const help = runCli(helpArgs, deps, options);
  const modelSupport = engine === 'droid'
    ? help.stdout.includes(model)
    : /--model\s+<MODEL>/.test(help.stdout);
  checks.push({
    name: engine === 'droid' ? 'model_list_advertises_glm' : 'model_flag_available',
    ok: help.ok && modelSupport,
    command: help.command,
    detail: engine === 'droid'
      ? `${model} ${modelSupport ? 'listed' : 'missing'}`
      : `--model flag ${modelSupport ? 'available' : 'missing'}`,
    stdout_head: help.stdout.slice(0, 700),
    stderr_head: help.stderr.slice(0, 500),
  });

  return { binary, binaryPath, checks };
}

function runDogfoodEngine(engine, options = {}, deps = {}) {
  const dry = dryChecksFor(engine, options.model || 'glm-5.2', deps, {
    cwd: deps.root || process.cwd(),
    timeoutMs: options.timeoutMs,
  });
  const result = {
    engine,
    model: options.model || 'glm-5.2',
    binary: dry.binary,
    binary_path: dry.binaryPath,
    live: Boolean(options.live),
    checks: dry.checks,
    ok: dry.checks.every(check => check.ok),
  };

  if (options.live && result.ok) {
    const command = liveCommandFor(engine, result.model);
    const run = runCli(command, deps, {
      cwd: deps.root || process.cwd(),
      timeoutMs: options.timeoutMs,
      env: {
        ...process.env,
        ATRIS_SKIP_UPDATE_CHECK: '1',
      },
    });
    const expected = `ATRIS_${engine === 'devin' ? 'DEVIN' : 'DROID'}_GLM52_OK`;
    const matched = run.ok && run.stdout.includes(expected);
    result.checks.push({
      name: 'live_sentinel_prompt',
      ok: matched,
      command: run.command,
      expected,
      stdout_head: run.stdout.slice(0, 700),
      stderr_head: run.stderr.slice(0, 700),
      status: run.status,
      signal: run.signal,
      duration_ms: run.duration_ms,
      error: run.error,
    });
    result.ok = result.checks.every(check => check.ok);
  }

  return result;
}

function writeDogfoodReceipt(root, receipt) {
  const dir = runsDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `agent-dogfood-${timestampForFile()}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return filePath;
}

function showDogfoodHelp(output = console.log) {
  output('Internal usage: atris agent dogfood [devin|droid|--engine all] [--model glm-5.2] [--live] [--json]');
  output('');
  output('Internal support smoke for external coding CLIs; hidden from public agent help.');
  output('Add --live to run one exact sentinel prompt through Devin/Droid.');
}

function agentDogfoodCommand(args = [], deps = {}) {
  const root = deps.root || process.cwd();
  const output = deps.output || ((line = '') => console.log(line));
  const options = parseDogfoodArgs(args);
  if (options.help) {
    showDogfoodHelp(output);
    return { ok: true, action: 'help' };
  }

  const engines = options.engine === 'all' ? ['devin', 'droid'] : [options.engine];
  const receipt = {
    schema: DOGFOOD_SCHEMA,
    action: 'agent_dogfood',
    root,
    model: options.model,
    live: options.live,
    started_at: nowIso(),
    finished_at: null,
    engines: engines.map(engine => runDogfoodEngine(engine, options, deps)),
  };
  receipt.finished_at = nowIso();
  receipt.ok = receipt.engines.every(engine => engine.ok);
  if (!options.noWrite) {
    receipt.receipt_path = writeDogfoodReceipt(root, receipt);
  }

  if (options.json) {
    output(JSON.stringify(receipt, null, 2));
  } else {
    output(`agent dogfood ${receipt.ok ? 'passed' : 'failed'} (${options.live ? 'live' : 'dry'})`);
    for (const engine of receipt.engines) {
      output(`${engine.ok ? '✓' : '✗'} ${engine.engine} ${engine.model}${engine.binary_path ? ` -> ${engine.binary_path}` : ''}`);
      for (const check of engine.checks) {
        output(`  ${check.ok ? '✓' : '✗'} ${check.name}${check.detail ? `: ${check.detail}` : ''}`);
      }
    }
    if (receipt.receipt_path) output(`receipt: ${path.relative(root, receipt.receipt_path)}`);
  }

  return receipt;
}

function printSpawnRequest(request, output = console.log) {
  output(`spawned ${request.id}`);
  output(`role: ${request.role}`);
  output(`engine: ${request.engine}`);
  output(`task: ${request.task}`);
  output(`next: ${request.next_action}`);
}

function agentSpawnCommand(args = [], deps = {}) {
  const root = deps.root || process.cwd();
  const output = deps.output || ((line = '') => console.log(line));
  const options = parseSpawnArgs(args);
  if (options.help) {
    showSpawnHelp(output, deps.commandName || 'atris agent spawn');
    return { ok: true, action: 'help' };
  }
  const request = createSpawnRequest(root, options);
  let statePath = spawnStatePath(root);
  if (!options.dryRun) statePath = appendSpawnRequest(root, request);
  const payload = {
    ok: true,
    action: options.dryRun ? 'spawn_preview' : 'spawn_created',
    request,
    state_path: statePath,
  };
  if (options.json) output(JSON.stringify(payload, null, 2));
  else printSpawnRequest(request, output);
  return payload;
}

function agentSpawnListCommand(args = [], deps = {}) {
  const root = deps.root || process.cwd();
  const output = deps.output || ((line = '') => console.log(line));
  const json = hasFlag(args, ['--json']);
  const requests = loadSpawnRequests(root).reverse();
  const payload = { ok: true, action: 'spawn_list', requests, state_path: spawnStatePath(root) };
  if (json) {
    output(JSON.stringify(payload, null, 2));
    return payload;
  }
  if (!requests.length) {
    output('No agent spawn requests.');
    return payload;
  }
  for (const req of requests.slice(0, 20)) {
    output(`${req.id}\t${req.status}\t${req.engine}\t${req.role}\t${req.task}`);
  }
  return payload;
}

function agentSpawnStatusCommand(args = [], deps = {}) {
  const root = deps.root || process.cwd();
  const output = deps.output || ((line = '') => console.log(line));
  const json = hasFlag(args, ['--json']);
  const id = positionalArgs(args)[0];
  if (!id) throw new Error('Missing spawn id. Usage: atris agent spawn-status <id>');
  const request = loadSpawnRequests(root).find(req => req.id === id);
  if (!request) throw new Error(`Spawn request not found: ${id}`);
  const payload = { ok: true, action: 'spawn_status', request, state_path: spawnStatePath(root) };
  if (json) output(JSON.stringify(payload, null, 2));
  else printSpawnRequest(request, output);
  return payload;
}

module.exports = {
  SPAWN_SCHEMA,
  SPAWN_STATE_REL,
  parseSpawnArgs,
  buildDelegatePrompt,
  commandForEngine,
  createSpawnRequest,
  agentDogfoodCommand,
  parseDogfoodArgs,
  runDogfoodEngine,
  loadSpawnRequests,
  agentSpawnCommand,
  agentSpawnListCommand,
  agentSpawnStatusCommand,
  showSpawnHelp,
};
