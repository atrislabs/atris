/**
 * Atris Compile — learn like AI, run like code.
 *
 * The compile loop: execution records → compile-to-deterministic-code →
 * statistical backtest → gated promote. The LLM is only in the build path;
 * the promoted artifact runs token-free.
 *
 *   atris compile record <name> --input <json|@file> --output <json|@file>
 *   atris compile build <name>        (uses the shared runner command)
 *   atris compile backtest <name>
 *   atris compile promote <name>
 *   atris compile exec <name> --input <json|@file> [--record]
 *   atris compile status
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const {
  buildRunnerAvailabilityCommand,
  buildRunnerCommand,
  resolveClaudeRunnerBin,
} = require('../lib/runner-command');
const { writePromptTempFile } = require('../lib/prompt-temp');

const DEFAULT_THRESHOLD = 0.99;
const SAMPLE_RECORDS_FOR_BUILD = 25;
const LOW_RECORD_WARNING = 20;

// ── paths ──────────────────────────────────────────────────────────

function processDir(root, name) {
  return path.join(root, 'atris', 'processes', name);
}

function recordsPath(root, name) {
  return path.join(root, '.atris', 'state', 'processes', name, 'records.jsonl');
}

function manifestPath(root, name) {
  return path.join(processDir(root, name), 'process.json');
}

function runnerPath(root, name) {
  return path.join(processDir(root, name), 'run.js');
}

function specPath(root, name) {
  return path.join(processDir(root, name), 'spec.md');
}

function validName(name) {
  return typeof name === 'string' && /^[a-z0-9][a-z0-9-_]*$/.test(name);
}

// ── manifest ───────────────────────────────────────────────────────

function readManifest(root, name) {
  const p = manifestPath(root, name);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeManifest(root, name, manifest) {
  fs.mkdirSync(processDir(root, name), { recursive: true });
  const target = manifestPath(root, name);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n');
  fs.renameSync(tmp, target);
  return manifest;
}

function defaultManifest(name) {
  return {
    name,
    version: 0,
    status: 'draft', // draft | active | drifted
    threshold: DEFAULT_THRESHOLD,
    compiledAt: null,
    backtest: null, // { version, total, passed, accuracy, at, failures }
  };
}

// ── records ────────────────────────────────────────────────────────

function parseValueArg(raw) {
  if (raw === undefined || raw === null) return undefined;
  let text = String(raw);
  if (text.startsWith('@')) {
    text = fs.readFileSync(text.slice(1), 'utf8');
  }
  try {
    return JSON.parse(text);
  } catch {
    return text; // plain string payloads are fine
  }
}

function appendRecord(root, name, record) {
  const p = recordsPath(root, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const entry = { ts: new Date().toISOString(), ...record };
  fs.appendFileSync(p, JSON.stringify(entry) + '\n');
  return entry;
}

function readRecords(root, name) {
  const p = recordsPath(root, name);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function listProcesses(root) {
  const names = new Set();
  const docsDir = path.join(root, 'atris', 'processes');
  const stateDir = path.join(root, '.atris', 'state', 'processes');
  for (const dir of [docsDir, stateDir]) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) names.add(entry.name);
    }
  }
  return [...names].sort();
}

// ── compare ────────────────────────────────────────────────────────

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => deepEqual(a[k], b[k]));
}

// ── runner loading / execution ─────────────────────────────────────

function loadRunner(root, name) {
  const p = runnerPath(root, name);
  if (!fs.existsSync(p)) {
    throw new Error(`no compiled artifact at ${path.relative(root, p)} — run "atris compile build ${name}" first`);
  }
  const resolved = require.resolve(p);
  delete require.cache[resolved]; // always load the latest compiled version
  const mod = require(resolved);
  if (!mod || typeof mod.run !== 'function') {
    throw new Error(`${path.relative(root, p)} must export { run(input) }`);
  }
  return mod;
}

// ── backtest ───────────────────────────────────────────────────────

async function runBacktest(root, name, options = {}) {
  const records = readRecords(root, name);
  if (records.length === 0) {
    throw new Error(`no execution records for "${name}" — add some with "atris compile record ${name} --input ... --output ..."`);
  }
  const runner = loadRunner(root, name);
  const manifest = readManifest(root, name) || defaultManifest(name);
  const threshold = options.threshold !== undefined ? options.threshold : manifest.threshold;

  let passed = 0;
  const failures = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const expected = record.expected !== undefined ? record.expected : record.output;
    try {
      const actual = await runner.run(record.input);
      if (deepEqual(actual, expected)) {
        passed++;
      } else {
        failures.push({ index: i, input: record.input, expected, actual });
      }
    } catch (err) {
      failures.push({ index: i, input: record.input, expected, error: err.message });
    }
  }

  const total = records.length;
  const accuracy = passed / total;
  const result = {
    version: manifest.version,
    total,
    passed,
    accuracy,
    threshold,
    at: new Date().toISOString(),
    failures: failures.slice(0, 10),
  };

  manifest.backtest = result;
  // a one-off --threshold applies to this run only; the promote gate stays as set
  // drift detection: an active process falling below its standing gate is drifted
  if (manifest.status === 'active' && accuracy < manifest.threshold) {
    manifest.status = 'drifted';
  }
  writeManifest(root, name, manifest);

  return { result, manifest, failureCount: failures.length };
}

// ── promote gate ───────────────────────────────────────────────────

function promoteProcess(root, name, options = {}) {
  const manifest = readManifest(root, name);
  if (!manifest) {
    throw new Error(`no manifest for "${name}" — compile and backtest it first`);
  }
  if (options.threshold !== undefined) {
    // the only way to change the standing gate: deliberate, at promote time
    manifest.threshold = options.threshold;
  }
  const bt = manifest.backtest;
  if (!bt) {
    throw new Error(`"${name}" has no backtest — run "atris compile backtest ${name}" first`);
  }
  if (bt.version !== manifest.version) {
    throw new Error(`backtest is for version ${bt.version} but current version is ${manifest.version} — re-run the backtest`);
  }
  if (bt.accuracy < manifest.threshold) {
    throw new Error(`backtest accuracy ${(bt.accuracy * 100).toFixed(2)}% is below the ${(manifest.threshold * 100).toFixed(2)}% gate (${bt.passed}/${bt.total}) — not promoting`);
  }
  manifest.status = 'active';
  manifest.promotedAt = new Date().toISOString();
  writeManifest(root, name, manifest);
  return manifest;
}

// ── build (the only step that spends tokens) ───────────────────────

function buildCompilePrompt(root, name, records, notes) {
  const runRel = path.relative(root, runnerPath(root, name));
  const specRel = path.relative(root, specPath(root, name));
  const hasSpec = fs.existsSync(specPath(root, name));
  const sample = records.slice(-SAMPLE_RECORDS_FOR_BUILD);

  return `You are the Atris process compiler. Compile the recurring process "${name}" into deterministic code.

${hasSpec ? `Read the process spec first: ${specRel}` : `There is no spec file yet. Infer the process from the execution records below, then write what you inferred to ${specRel} (short markdown: purpose, input shape, output shape, rules).`}
${notes ? `\nOperator notes for this build:\n${notes}\n` : ''}
Execution records (most recent ${sample.length} of ${records.length}; input is what the process received, expected/output is the correct result):
${JSON.stringify(sample, null, 2)}

Write the compiled artifact to ${runRel} with this exact contract:
- CommonJS module exporting { run }: \`module.exports = { run };\`
- \`run(input)\` takes one input value and returns the output (sync return or promise both fine)
- deterministic: no network calls, no Date.now()/new Date() in outputs, no randomness, no environment reads
- Node.js built-ins only — zero npm dependencies
- handle malformed input by throwing a clear Error, never by guessing

The artifact will be verified by replaying every execution record through run() and requiring near-perfect accuracy, so generalize the rules — do not hardcode a lookup table of the sample records.

Reply [COMPILE_COMPLETE] when ${runRel} is written.`;
}

function executeBuild(root, name, options = {}) {
  const { verbose = false, timeout = 600000, notes = '', cmdOverride } = options;
  const records = readRecords(root, name);
  if (records.length === 0) {
    throw new Error(`no execution records for "${name}" — record real runs first, then compile`);
  }

  if (!cmdOverride) {
    try {
      execSync(buildRunnerAvailabilityCommand(), { stdio: 'pipe' });
    } catch {
      throw new Error(`${resolveClaudeRunnerBin()} CLI not found. Set ATRIS_RUNNER_BIN (or legacy ATRIS_CLAUDE_BIN), or install the configured runner first.`);
    }
  }

  fs.mkdirSync(processDir(root, name), { recursive: true });
  const prompt = buildCompilePrompt(root, name, records, notes);
  const promptTemp = writePromptTempFile('compile-prompt', prompt);

  try {
    const cmd = cmdOverride || buildRunnerCommand({ promptFile: promptTemp.filePath, allowedTools: 'Read,Write,Edit,Glob,Grep' });
    const env = { ...process.env };
    delete env.CLAUDECODE;
    execSync(cmd, {
      cwd: root,
      encoding: 'utf8',
      timeout,
      stdio: verbose ? 'inherit' : 'pipe',
      maxBuffer: 10 * 1024 * 1024,
      env,
    });
  } finally {
    promptTemp.cleanup();
  }

  if (!fs.existsSync(runnerPath(root, name))) {
    throw new Error(`compile finished but ${path.relative(root, runnerPath(root, name))} was not written`);
  }
  loadRunner(root, name); // validates the contract

  const manifest = readManifest(root, name) || defaultManifest(name);
  manifest.version += 1;
  manifest.compiledAt = new Date().toISOString();
  manifest.status = 'draft'; // every rebuild must re-earn promotion through the gate
  manifest.backtest = null; // new version must re-earn its backtest
  writeManifest(root, name, manifest);
  return manifest;
}

// ── arg parsing ────────────────────────────────────────────────────

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
      flags[arg.slice(2)] = args[++i];
    } else {
      flags[arg.slice(2)] = true;
    }
  }
  return { flags, positional };
}

// ── formatting ─────────────────────────────────────────────────────

function formatAccuracy(accuracy) {
  return `${(accuracy * 100).toFixed(2)}%`;
}

function printBacktest(name, result, failureCount, manifest) {
  console.log(`backtest ${name} v${result.version}: ${result.passed}/${result.total} passed (${formatAccuracy(result.accuracy)}), gate ${formatAccuracy(result.threshold)}`);
  if (result.total < LOW_RECORD_WARNING) {
    console.log(`note: only ${result.total} record${result.total === 1 ? '' : 's'} — accuracy means more with ${LOW_RECORD_WARNING}+`);
  }
  if (failureCount > 0) {
    console.log(`${failureCount} mismatch${failureCount === 1 ? '' : 'es'}. first ${Math.min(failureCount, 3)}:`);
    for (const f of result.failures.slice(0, 3)) {
      if (f.error) {
        console.log(`  record ${f.index}: threw "${f.error}"`);
      } else {
        console.log(`  record ${f.index}: expected ${JSON.stringify(f.expected)} got ${JSON.stringify(f.actual)}`);
      }
    }
  }
  if (manifest.status === 'drifted') {
    console.log(`drift detected: active process fell below its gate. recompile with "atris compile build ${name}"`);
  } else if (result.accuracy >= result.threshold && manifest.status !== 'active') {
    console.log(`gate passed. promote with "atris compile promote ${name}"`);
  }
}

// ── command dispatcher ─────────────────────────────────────────────

function showCompileHelp() {
  console.log('');
  console.log('Usage: atris compile <subcommand> [args]');
  console.log('');
  console.log('Compile a recurring process into deterministic code, verified by');
  console.log('backtesting against real execution records. LLM only at build time;');
  console.log('the promoted artifact runs token-free.');
  console.log('');
  console.log('  record <name> --input <json|@file> --output <json|@file> [--expected ...]');
  console.log('                            append an execution record');
  console.log('  build <name> [--notes "..."] [--verbose]');
  console.log('                            compile records + spec into atris/processes/<name>/run.js');
  console.log('  backtest <name> [--threshold 0.99] [--json]');
  console.log('                            replay every record through run.js, score accuracy');
  console.log('                            (--threshold judges this run only; the gate is unchanged)');
  console.log('  promote <name> [--gate 0.99]');
  console.log('                            mark active (gate: backtest accuracy >= threshold);');
  console.log('                            --gate is the only way to change the standing threshold');
  console.log('  exec <name> --input <json|@file> [--record]');
  console.log('                            run the compiled process on new input');
  console.log('  status [<name>] [--json]  list processes, versions, accuracy, drift');
  console.log('');
  console.log('Loop: record real runs -> build -> backtest -> promote -> exec --record');
  console.log('When backtest accuracy drops below the gate, the process is marked drifted');
  console.log('and a recompile is suggested — self-healing against process drift.');
  console.log('');
}

async function compileCommand(subcommand, ...rawArgs) {
  const root = process.cwd();
  const { flags, positional } = parseFlags(rawArgs);

  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    showCompileHelp();
    return;
  }

  // `atris compile <name>` with an existing process name = build shortcut
  let cmd = subcommand;
  let name = positional[0];
  const subcommands = ['record', 'build', 'backtest', 'promote', 'exec', 'status'];
  if (!subcommands.includes(subcommand)) {
    if (validName(subcommand) && listProcesses(root).includes(subcommand)) {
      cmd = 'build';
      name = subcommand;
    } else {
      console.error(`unknown subcommand "${subcommand}". try: atris compile help`);
      process.exitCode = 1;
      return;
    }
  }

  if (cmd === 'status') {
    const names = name ? [name] : listProcesses(root);
    const rows = names.map((n) => {
      const manifest = readManifest(root, n) || defaultManifest(n);
      const records = readRecords(root, n).length;
      return {
        name: n,
        version: manifest.version,
        status: manifest.status,
        records,
        accuracy: manifest.backtest ? manifest.backtest.accuracy : null,
        compiledAt: manifest.compiledAt,
      };
    });
    if (flags.json) {
      console.log(JSON.stringify({ ok: true, processes: rows }, null, 2));
      return;
    }
    if (rows.length === 0) {
      console.log('no compiled processes yet. start with: atris compile record <name> --input ... --output ...');
      return;
    }
    for (const row of rows) {
      const acc = row.accuracy === null ? 'no backtest' : formatAccuracy(row.accuracy);
      console.log(`${row.name}  v${row.version}  ${row.status}  ${row.records} record${row.records === 1 ? '' : 's'}  ${acc}`);
    }
    return;
  }

  if (!validName(name)) {
    console.error('process name required (lowercase letters, digits, dashes). example: atris compile record invoice-triage --input ... --output ...');
    process.exitCode = 1;
    return;
  }

  if (cmd === 'record') {
    const input = parseValueArg(flags.input);
    const output = parseValueArg(flags.output);
    if (input === undefined || output === undefined) {
      console.error('record needs --input and --output (inline json, a plain string, or @file)');
      process.exitCode = 1;
      return;
    }
    const record = { input, output };
    const expected = parseValueArg(flags.expected);
    if (expected !== undefined) record.expected = expected;
    if (flags.source) record.source = flags.source;
    appendRecord(root, name, record);
    const total = readRecords(root, name).length;
    console.log(`recorded ${name} run ${total} -> ${path.relative(root, recordsPath(root, name))}`);
    return;
  }

  if (cmd === 'build') {
    const records = readRecords(root, name);
    console.log(`compiling ${name} from ${records.length} execution record${records.length === 1 ? '' : 's'}…`);
    const manifest = executeBuild(root, name, {
      verbose: Boolean(flags.verbose),
      notes: typeof flags.notes === 'string' ? flags.notes : '',
      timeout: flags.timeout ? Number(flags.timeout) * 1000 : undefined,
    });
    console.log(`compiled ${name} v${manifest.version} -> ${path.relative(root, runnerPath(root, name))}`);
    console.log(`next: atris compile backtest ${name}`);
    return;
  }

  if (cmd === 'backtest') {
    const options = {};
    if (flags.threshold !== undefined) {
      const t = Number(flags.threshold);
      if (!(t > 0 && t <= 1)) {
        console.error('--threshold must be between 0 and 1 (e.g. 0.99)');
        process.exitCode = 1;
        return;
      }
      options.threshold = t;
    }
    const { result, manifest, failureCount } = await runBacktest(root, name, options);
    if (flags.json) {
      console.log(JSON.stringify({ ok: true, name, ...result, status: manifest.status }, null, 2));
    } else {
      printBacktest(name, result, failureCount, manifest);
    }
    if (result.accuracy < result.threshold) process.exitCode = 1;
    return;
  }

  if (cmd === 'promote') {
    const options = {};
    if (flags.gate !== undefined) {
      const t = Number(flags.gate);
      if (!(t > 0 && t <= 1)) {
        console.error('--gate must be between 0 and 1 (e.g. 0.99)');
        process.exitCode = 1;
        return;
      }
      options.threshold = t;
    }
    const manifest = promoteProcess(root, name, options);
    console.log(`${name} v${manifest.version} promoted to active (${formatAccuracy(manifest.backtest.accuracy)} over ${manifest.backtest.total} records, gate ${formatAccuracy(manifest.threshold)})`);
    console.log(`run it token-free: atris compile exec ${name} --input '<json>' --record`);
    return;
  }

  if (cmd === 'exec') {
    const input = parseValueArg(flags.input);
    if (input === undefined) {
      console.error('exec needs --input (inline json, a plain string, or @file)');
      process.exitCode = 1;
      return;
    }
    const manifest = readManifest(root, name);
    if (manifest && manifest.status === 'drifted') {
      console.error(`warning: ${name} is marked drifted — outputs may be stale. recompile with "atris compile build ${name}"`);
    }
    const runner = loadRunner(root, name);
    const output = await runner.run(input);
    console.log(JSON.stringify(output, null, 2));
    if (flags.record) {
      appendRecord(root, name, { input, output, source: 'exec' });
    }
    return;
  }
}

module.exports = {
  compileCommand,
  // exported for tests
  appendRecord,
  readRecords,
  readManifest,
  writeManifest,
  defaultManifest,
  deepEqual,
  runBacktest,
  promoteProcess,
  executeBuild,
  buildCompilePrompt,
  parseValueArg,
  parseFlags,
  listProcesses,
  recordsPath,
  runnerPath,
  manifestPath,
  DEFAULT_THRESHOLD,
};
