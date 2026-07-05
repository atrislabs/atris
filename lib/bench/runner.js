'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createBenchContext, withBenchContext } = require('./context');
const { ENGINE_NAMES, getEngineAdapter, normalizeEngineName } = require('./engines');

const DEFAULT_PACK = 'core-v1';

class BenchInfraError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BenchInfraError';
    this.exitCode = 2;
  }
}

function repoRootFromHere() {
  return path.resolve(__dirname, '..', '..');
}

function benchmarksRoot(repoRoot = repoRootFromHere()) {
  return path.join(repoRoot, 'atris', 'benchmarks');
}

function packDir(repoRoot = repoRootFromHere(), pack = DEFAULT_PACK) {
  return path.join(benchmarksRoot(repoRoot), pack || DEFAULT_PACK);
}

function defaultTasksDir(repoRoot = repoRootFromHere()) {
  return packDir(repoRoot, DEFAULT_PACK);
}

function validateTaskSpec(spec, filePath) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new BenchInfraError(`${filePath}: task spec must export an object`);
  }
  if (typeof spec.id !== 'string' || !/^[a-z0-9-]+$/.test(spec.id)) {
    throw new BenchInfraError(`${filePath}: task spec id must be kebab-case`);
  }
  if (typeof spec.title !== 'string' || !spec.title.trim()) {
    throw new BenchInfraError(`${spec.id}: title is required`);
  }
  if (typeof spec.run !== 'function') {
    throw new BenchInfraError(`${spec.id}: run(ctx) function is required`);
  }
  if (spec.timeoutMs !== undefined && (!Number.isFinite(Number(spec.timeoutMs)) || Number(spec.timeoutMs) <= 0)) {
    throw new BenchInfraError(`${spec.id}: timeoutMs must be a positive number`);
  }
  if (spec.needsPython !== undefined && typeof spec.needsPython !== 'boolean') {
    throw new BenchInfraError(`${spec.id}: needsPython must be boolean when present`);
  }
  return spec;
}

function validateAgentTaskSpec(spec, filePath) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new BenchInfraError(`${filePath}: task spec must export an object`);
  }
  if (typeof spec.id !== 'string' || !/^[a-z0-9-]+$/.test(spec.id)) {
    throw new BenchInfraError(`${filePath}: task spec id must be kebab-case`);
  }
  if (typeof spec.title !== 'string' || !spec.title.trim()) {
    throw new BenchInfraError(`${spec.id}: title is required`);
  }
  if (typeof spec.category !== 'string' || !spec.category.trim()) {
    throw new BenchInfraError(`${spec.id}: category is required`);
  }
  if (typeof spec.check !== 'function') {
    throw new BenchInfraError(`${spec.id}: check(ctx) function is required`);
  }
  if (spec.timeoutMs !== undefined && (!Number.isFinite(Number(spec.timeoutMs)) || Number(spec.timeoutMs) <= 0)) {
    throw new BenchInfraError(`${spec.id}: timeoutMs must be a positive number`);
  }
  return spec;
}

function discoverPacks(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || repoRootFromHere());
  const root = benchmarksRoot(repoRoot);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function loadTaskSpecs(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || repoRootFromHere());
  const tasksDir = path.resolve(options.tasksDir || packDir(repoRoot, options.pack || DEFAULT_PACK));
  if (!fs.existsSync(tasksDir)) throw new BenchInfraError(`benchmark task directory not found: ${tasksDir}`);
  const entries = fs.readdirSync(tasksDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  const taskDirs = entries
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(tasksDir, entry.name, 'check.js')))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  if (!files.length && !taskDirs.length) throw new BenchInfraError(`no benchmark task specs found in ${tasksDir}`);

  const specs = [];
  const seen = new Set();
  for (const file of files) {
    const filePath = path.join(tasksDir, file);
    delete require.cache[require.resolve(filePath)];
    const spec = validateTaskSpec(require(filePath), filePath);
    if (seen.has(spec.id)) throw new BenchInfraError(`duplicate benchmark task id: ${spec.id}`);
    seen.add(spec.id);
    specs.push({
      ...spec,
      kind: 'legacy',
      taskPath: filePath,
      orderKey: file,
    });
  }
  for (const dirName of taskDirs) {
    const taskDir = path.join(tasksDir, dirName);
    const checkPath = path.join(taskDir, 'check.js');
    const promptPath = path.join(taskDir, 'prompt.md');
    const fixtureDir = path.join(taskDir, 'fixture');
    const solutionPath = path.join(taskDir, 'solution.sh');
    for (const requiredPath of [promptPath, fixtureDir, solutionPath]) {
      if (!fs.existsSync(requiredPath)) throw new BenchInfraError(`${taskDir}: missing ${path.basename(requiredPath)}`);
    }
    delete require.cache[require.resolve(checkPath)];
    const spec = validateAgentTaskSpec(require(checkPath), checkPath);
    if (seen.has(spec.id)) throw new BenchInfraError(`duplicate benchmark task id: ${spec.id}`);
    seen.add(spec.id);
    specs.push({
      id: spec.id,
      title: spec.title,
      category: spec.category,
      timeoutMs: spec.timeoutMs,
      kind: 'agent',
      check: spec.check,
      taskDir,
      fixtureDir,
      promptPath,
      solutionPath,
      setupPath: fs.existsSync(path.join(taskDir, 'setup.js')) ? path.join(taskDir, 'setup.js') : null,
      orderKey: dirName,
    });
  }
  return specs.sort((a, b) => a.orderKey.localeCompare(b.orderKey));
}

function findPython() {
  for (const candidate of ['python3']) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (!result.error && result.status === 0) return candidate;
  }
  return null;
}

function isInfraFailure(err) {
  if (!err) return false;
  if (err.spawnError) return true;
  if (['ETIMEDOUT', 'EAGAIN', 'ENOMEM', 'ENOBUFS'].includes(err.code)) return true;
  if (typeof err.syscall === 'string' && err.syscall.startsWith('spawn')) return true;
  return false;
}

function timeoutError(spec, timeoutMs) {
  const err = new Error(`${spec.id} timed out after ${timeoutMs}ms`);
  err.code = 'ETIMEDOUT';
  return err;
}

function withTimeout(promise, spec, timeoutMs) {
  let timer = null;
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(timeoutError(spec, timeoutMs)), timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function formatFailure(err) {
  if (!err) return 'unknown failure';
  return String(err.stack || err.message || err);
}

async function runTaskAttempt(spec, options) {
  const timeoutMs = Number(spec.timeoutMs || options.timeoutMs || 30000);
  return withBenchContext({
    repoRoot: options.repoRoot,
    taskId: spec.id,
    timeoutMs,
  }, async (ctx) => withTimeout(spec.run(ctx), spec, timeoutMs));
}

function copyFixtureIntoWorkspace(fixtureDir, workspace) {
  fs.cpSync(fixtureDir, workspace, {
    recursive: true,
    force: true,
    dereference: false,
  });
}

async function runSetup(spec, ctx) {
  if (!spec.setupPath) return;
  delete require.cache[require.resolve(spec.setupPath)];
  const setupModule = require(spec.setupPath);
  const setup = typeof setupModule === 'function' ? setupModule : setupModule && setupModule.setup;
  if (typeof setup !== 'function') {
    throw new BenchInfraError(`${spec.id}: setup.js must export a function or { setup }`);
  }
  await setup(ctx);
}

function formatEngineFailure(engineName, result) {
  const stdout = String(result && result.stdout ? result.stdout : '').trim();
  const stderr = String(result && result.stderr ? result.stderr : '').trim();
  const details = [stderr, stdout].filter(Boolean).join('\n').slice(0, 4000);
  return `engine ${engineName} exited ${result ? result.status : 'unknown'}${details ? `\n${details}` : ''}`;
}

async function runAgentTaskSpec(spec, options = {}) {
  const started = Date.now();
  const timeoutMs = Number(spec.timeoutMs || options.timeoutMs || 300000);
  let bench = null;
  try {
    bench = createBenchContext({
      repoRoot: options.repoRoot,
      taskId: spec.id,
      timeoutMs,
    });
    const ctx = bench.ctx;
    ctx.taskDir = spec.taskDir;
    ctx.fixtureDir = spec.fixtureDir;
    ctx.promptPath = spec.promptPath;
    copyFixtureIntoWorkspace(spec.fixtureDir, ctx.workspace);

    const engine = getEngineAdapter(options.engine, { solutionPath: spec.solutionPath });
    const availability = engine.available(ctx.workspace);
    if (!availability.available) {
      return {
        id: spec.id,
        passed: false,
        skipped: true,
        failures: [],
        duration_ms: Date.now() - started,
        retried: false,
      };
    }

    await runSetup(spec, ctx);
    const promptText = fs.readFileSync(spec.promptPath, 'utf8');
    const engineResult = await withTimeout(Promise.resolve(engine.run(promptText, ctx.workspace, timeoutMs)), spec, timeoutMs);
    if (!engineResult || engineResult.status !== 0) {
      throw new Error(formatEngineFailure(options.engine, engineResult));
    }
    await withTimeout(Promise.resolve().then(() => spec.check(ctx)), spec, timeoutMs);
    return {
      id: spec.id,
      passed: true,
      skipped: false,
      failures: [],
      duration_ms: Date.now() - started,
      retried: false,
    };
  } catch (err) {
    return {
      id: spec.id,
      passed: false,
      skipped: false,
      failures: [formatFailure(err)],
      duration_ms: Date.now() - started,
      retried: false,
    };
  } finally {
    if (bench) bench.teardown();
  }
}

async function runTaskSpec(spec, options = {}) {
  if (spec.kind === 'agent') return runAgentTaskSpec(spec, options);

  const started = Date.now();
  let retried = false;

  if (spec.needsPython && !options.pythonCmd) {
    return {
      id: spec.id,
      passed: false,
      skipped: true,
      failures: [],
      duration_ms: Date.now() - started,
      retried: false,
    };
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const value = await runTaskAttempt(spec, options);
      if (value && value.skipped) {
        return {
          id: spec.id,
          passed: false,
          skipped: true,
          failures: [],
          duration_ms: Date.now() - started,
          retried,
        };
      }
      return {
        id: spec.id,
        passed: true,
        skipped: false,
        failures: [],
        duration_ms: Date.now() - started,
        retried,
      };
    } catch (err) {
      const infra = isInfraFailure(err);
      if (infra && attempt === 0) {
        retried = true;
        continue;
      }
      return {
        id: spec.id,
        passed: false,
        skipped: false,
        failures: [formatFailure(err)],
        duration_ms: Date.now() - started,
        retried,
      };
    }
  }

  return {
    id: spec.id,
    passed: false,
    skipped: false,
    failures: ['unreachable benchmark runner state'],
    duration_ms: Date.now() - started,
    retried,
  };
}

function selectTaskSpecs(specs, taskIds = []) {
  const ids = (taskIds || []).filter(Boolean);
  if (!ids.length) return specs;
  const byId = new Map(specs.map((spec) => [spec.id, spec]));
  return ids.map((id) => {
    const spec = byId.get(id);
    if (!spec) throw new BenchInfraError(`unknown benchmark task: ${id}`);
    return spec;
  });
}

async function runTaskSpecs(specs, options = {}) {
  const records = [];
  for (const spec of specs) {
    records.push(await runTaskSpec(spec, options));
  }
  return records;
}

function normalizeBenchEngine(engine) {
  if (engine === undefined || engine === null || engine === '') return null;
  try {
    return normalizeEngineName(engine);
  } catch (err) {
    throw new BenchInfraError(err.message);
  }
}

function normalizeLabel(label) {
  if (label === undefined || label === null || label === '') return null;
  if (label === 'baseline' || label === 'candidate') return label;
  throw new BenchInfraError(`invalid bench label: ${label}`);
}

function benchStateDir(stateRoot = process.cwd()) {
  return path.join(stateRoot, '.atris', 'state', 'bench');
}

function appendResultRecord(record, stateRoot = process.cwd()) {
  const dir = benchStateDir(stateRoot);
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, 'results.jsonl');
  fs.appendFileSync(outPath, `${JSON.stringify(record)}\n`, 'utf8');
  return outPath;
}

function writeBaselineRecord(record, stateRoot = process.cwd()) {
  const dir = benchStateDir(stateRoot);
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, 'baseline.json');
  fs.writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return outPath;
}

function readResultRecords(options = {}) {
  const filePath = path.join(benchStateDir(options.stateRoot || process.cwd()), 'results.jsonl');
  if (!fs.existsSync(filePath)) return [];
  const rows = fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const last = Number(options.last || 0);
  return last > 0 ? rows.slice(-last) : rows;
}

function summarizeTasks(tasks) {
  const passed = tasks.filter((task) => task.passed && !task.skipped).map((task) => task.id);
  const failed = tasks.filter((task) => !task.passed && !task.skipped).map((task) => task.id);
  const skipped = tasks.filter((task) => task.skipped).map((task) => task.id);
  const denominator = Math.max(0, tasks.length - skipped.length);
  return {
    passed,
    failed,
    skipped,
    summary: `${passed.length}/${denominator} gate cases passed`,
  };
}

function exitCodeForRecord(record) {
  return record.failed.length > 0 ? 1 : 0;
}

async function runBench(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || repoRootFromHere());
  const pack = options.pack || (options.tasksDir ? path.basename(path.resolve(options.tasksDir)) : DEFAULT_PACK);
  const specs = selectTaskSpecs(loadTaskSpecs({ repoRoot, tasksDir: options.tasksDir, pack }), options.taskIds);
  const engine = normalizeBenchEngine(options.engine);
  if (specs.some((spec) => spec.kind === 'agent') && !engine) {
    throw new BenchInfraError(`agent benchmark pack ${pack} requires --engine <${ENGINE_NAMES.join('|')}>`);
  }
  const label = normalizeLabel(options.label);
  const started = new Date().toISOString();
  const pythonCmd = options.pythonCmd === undefined ? findPython() : options.pythonCmd;
  const taskRecords = await runTaskSpecs(specs, {
    repoRoot,
    timeoutMs: options.timeoutMs,
    pythonCmd,
    engine,
  });
  const finished = new Date().toISOString();
  const summary = summarizeTasks(taskRecords);
  const record = {
    schema: 'atris.bench.run.v1',
    pack,
    engine,
    label,
    experiment: options.experiment || null,
    started,
    finished,
    tasks: taskRecords,
    passed: summary.passed,
    failed: summary.failed,
    skipped: summary.skipped,
    summary: summary.summary,
  };

  if (options.persist !== false) appendResultRecord(record, options.stateRoot || process.cwd());
  if (options.updateBaseline) writeBaselineRecord(record, options.stateRoot || process.cwd());
  return { record, exitCode: exitCodeForRecord(record) };
}

function taskMetadata(options = {}) {
  return loadTaskSpecs(options).map((spec) => ({
    id: spec.id,
    title: spec.title,
    category: spec.category || null,
    timeoutMs: spec.timeoutMs || null,
    needsPython: spec.needsPython === true,
  }));
}

function packMetadata(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || repoRootFromHere());
  return discoverPacks({ repoRoot }).map((id) => ({
    id,
    default: id === DEFAULT_PACK,
    taskCount: loadTaskSpecs({ repoRoot, pack: id }).length,
  }));
}

module.exports = {
  BenchInfraError,
  DEFAULT_PACK,
  appendResultRecord,
  benchmarksRoot,
  defaultTasksDir,
  discoverPacks,
  exitCodeForRecord,
  findPython,
  isInfraFailure,
  loadTaskSpecs,
  packMetadata,
  readResultRecords,
  runBench,
  runTaskSpec,
  runTaskSpecs,
  selectTaskSpecs,
  summarizeTasks,
  taskMetadata,
  writeBaselineRecord,
};
