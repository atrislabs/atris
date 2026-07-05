'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { withBenchContext } = require('./context');

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

function defaultTasksDir(repoRoot = repoRootFromHere()) {
  return path.join(repoRoot, 'atris', 'benchmarks', 'core-v1');
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

function loadTaskSpecs(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || repoRootFromHere());
  const tasksDir = path.resolve(options.tasksDir || defaultTasksDir(repoRoot));
  if (!fs.existsSync(tasksDir)) throw new BenchInfraError(`benchmark task directory not found: ${tasksDir}`);
  const files = fs.readdirSync(tasksDir)
    .filter((file) => file.endsWith('.js'))
    .sort((a, b) => a.localeCompare(b));
  if (!files.length) throw new BenchInfraError(`no benchmark task specs found in ${tasksDir}`);

  const specs = [];
  const seen = new Set();
  for (const file of files) {
    const filePath = path.join(tasksDir, file);
    delete require.cache[require.resolve(filePath)];
    const spec = validateTaskSpec(require(filePath), filePath);
    if (seen.has(spec.id)) throw new BenchInfraError(`duplicate benchmark task id: ${spec.id}`);
    seen.add(spec.id);
    specs.push(spec);
  }
  return specs;
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

async function runTaskSpec(spec, options = {}) {
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
  const specs = selectTaskSpecs(loadTaskSpecs({ repoRoot, tasksDir: options.tasksDir }), options.taskIds);
  const label = normalizeLabel(options.label);
  const started = new Date().toISOString();
  const pythonCmd = options.pythonCmd === undefined ? findPython() : options.pythonCmd;
  const taskRecords = await runTaskSpecs(specs, {
    repoRoot,
    timeoutMs: options.timeoutMs,
    pythonCmd,
  });
  const finished = new Date().toISOString();
  const summary = summarizeTasks(taskRecords);
  const record = {
    schema: 'atris.bench.run.v1',
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
    timeoutMs: spec.timeoutMs || null,
    needsPython: spec.needsPython === true,
  }));
}

module.exports = {
  BenchInfraError,
  appendResultRecord,
  defaultTasksDir,
  exitCodeForRecord,
  findPython,
  isInfraFailure,
  loadTaskSpecs,
  readResultRecords,
  runBench,
  runTaskSpec,
  runTaskSpecs,
  selectTaskSpecs,
  summarizeTasks,
  taskMetadata,
  writeBaselineRecord,
};
