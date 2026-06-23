'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { getRunLogDir, getRunLogPath, writePhaseToRunLog, listRunLogs } = require('../commands/run');

// --- Source-level: glass run log helpers exist and are wired ---

const RUN_SRC = fs.readFileSync(path.join(__dirname, '..', 'commands', 'run.js'), 'utf8');

test('run.js captures stdout in non-verbose mode for run log persistence', () => {
  // In non-verbose mode, stdout must be piped for capture
  assert.match(RUN_SRC, /stdio:\s*verbose\s*\?\s*'inherit'\s*:\s*\['pipe',\s*'pipe',\s*'inherit'\]/);
});

test('run.js captures DO phase output (was previously discarded)', () => {
  assert.match(RUN_SRC, /const doOutput = executePhase\('do'/);
  assert.match(RUN_SRC, /writePhaseToRunLog\(runLogPath, cycle, 'do', doOutput/);
});

test('run.js writes all three phases to run logs', () => {
  assert.match(RUN_SRC, /writePhaseToRunLog\(runLogPath, cycle, 'plan'/);
  assert.match(RUN_SRC, /writePhaseToRunLog\(runLogPath, cycle, 'do'/);
  assert.match(RUN_SRC, /writePhaseToRunLog\(runLogPath, cycle, 'review'/);
});

test('run.js prints run log paths at end of run', () => {
  assert.match(RUN_SRC, /writtenRunLogs/);
  assert.match(RUN_SRC, /run logs: atris\/logs\/runs/);
});

// --- Functional: exercise the real production helpers ---

test('getRunLogDir creates atris/logs/runs/ if missing', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runlog-test-'));
  const origCwd = process.cwd();
  try {
    process.chdir(tmpRoot);
    const dir = getRunLogDir();
    assert.ok(fs.existsSync(dir), 'run log dir created');
    assert.ok(dir.endsWith(path.join('atris', 'logs', 'runs')), 'correct path');
  } finally {
    process.chdir(origCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('getRunLogPath produces unique filenames for different runStamps', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runlog-test-'));
  const origCwd = process.cwd();
  try {
    process.chdir(tmpRoot);
    const p1 = getRunLogPath('111111', 1);
    const p2 = getRunLogPath('222222', 1);
    assert.notEqual(p1, p2, 'different runStamps produce different paths');
    assert.ok(p1.includes('111111'), 'stamp appears in filename');
    assert.ok(p1.includes('cycle-1'), 'cycle appears in filename');
  } finally {
    process.chdir(origCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('getRunLogPath produces unique filenames for different cycles', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runlog-test-'));
  const origCwd = process.cwd();
  try {
    process.chdir(tmpRoot);
    const p1 = getRunLogPath('111111', 1);
    const p2 = getRunLogPath('111111', 2);
    assert.notEqual(p1, p2, 'different cycles produce different paths');
  } finally {
    process.chdir(origCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('writePhaseToRunLog creates file with header on first write', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runlog-test-'));
  const origCwd = process.cwd();
  try {
    process.chdir(tmpRoot);
    const logPath = getRunLogPath('999999', 1);
    writePhaseToRunLog(logPath, 1, 'plan', 'Plan reasoning here', 3000);

    assert.ok(fs.existsSync(logPath), 'file created');
    const content = fs.readFileSync(logPath, 'utf8');
    assert.ok(content.includes('# Run Log — Cycle 1'), 'header present');
    assert.ok(content.includes('## PLAN'), 'plan section present');
    assert.ok(content.includes('Plan reasoning here'), 'plan content present');
    assert.ok(content.includes('(3s)'), 'duration present');
  } finally {
    process.chdir(origCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('writePhaseToRunLog appends on subsequent writes', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runlog-test-'));
  const origCwd = process.cwd();
  try {
    process.chdir(tmpRoot);
    const logPath = getRunLogPath('999998', 1);

    writePhaseToRunLog(logPath, 1, 'plan', 'Plan reasoning', 3000);
    writePhaseToRunLog(logPath, 1, 'do', 'Build reasoning', 12000);
    writePhaseToRunLog(logPath, 1, 'review', 'Review reasoning', 5000);

    const content = fs.readFileSync(logPath, 'utf8');
    assert.ok(content.includes('## PLAN'), 'plan section present');
    assert.ok(content.includes('## DO'), 'do section appended');
    assert.ok(content.includes('## REVIEW'), 'review section appended');
    assert.ok(content.includes('Build reasoning'), 'do content present');
    assert.ok(content.includes('Review reasoning'), 'review content present');
    // Header should appear only once
    const headerCount = (content.match(/# Run Log — Cycle 1/g) || []).length;
    assert.equal(headerCount, 1, 'header appears exactly once');
  } finally {
    process.chdir(origCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('writePhaseToRunLog handles empty output gracefully', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runlog-test-'));
  const origCwd = process.cwd();
  try {
    process.chdir(tmpRoot);
    const logPath = getRunLogPath('999997', 1);
    writePhaseToRunLog(logPath, 1, 'plan', '', 1000);

    const content = fs.readFileSync(logPath, 'utf8');
    assert.ok(content.includes('(no output)'), 'empty output handled with placeholder');
  } finally {
    process.chdir(origCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('writePhaseToRunLog handles null output gracefully', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runlog-test-'));
  const origCwd = process.cwd();
  try {
    process.chdir(tmpRoot);
    const logPath = getRunLogPath('999996', 1);
    writePhaseToRunLog(logPath, 1, 'plan', null, 1000);

    const content = fs.readFileSync(logPath, 'utf8');
    assert.ok(content.includes('(no output)'), 'null output handled with placeholder');
  } finally {
    process.chdir(origCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('writePhaseToRunLog can log error sections for failed phases', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runlog-test-'));
  const origCwd = process.cwd();
  try {
    process.chdir(tmpRoot);
    const logPath = getRunLogPath('999995', 1);

    // Simulate a plan phase followed by a failed do phase
    writePhaseToRunLog(logPath, 1, 'plan', 'Plan reasoning', 3000);
    writePhaseToRunLog(logPath, 1, 'error', 'Error: DO phase timed out after 600s\n\nStack: Error: ...', 0);

    const content = fs.readFileSync(logPath, 'utf8');
    assert.ok(content.includes('## PLAN'), 'plan section present');
    assert.ok(content.includes('## ERROR'), 'error section present');
    assert.ok(content.includes('DO phase timed out'), 'error message present');
  } finally {
    process.chdir(origCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run.js logs failed phases to run log for forensic value', () => {
  assert.match(RUN_SRC, /writePhaseToRunLog\(runLogPath, cycle, 'error'/);
  assert.match(RUN_SRC, /err\.message/);
});

// --- listRunLogs command ---

test('listRunLogs shows no-logs message when runs dir is empty', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runlog-test-'));
  const origCwd = process.cwd();
  let output = '';
  const origLog = console.log;
  try {
    process.chdir(tmpRoot);
    console.log = (...args) => { output += args.join(' ') + '\n'; };
    listRunLogs([]);
    assert.ok(output.includes('No run logs found'), 'shows no-logs message');
  } finally {
    console.log = origLog;
    process.chdir(origCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('listRunLogs lists run logs with cycle and phase info', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runlog-test-'));
  const origCwd = process.cwd();
  let output = '';
  const origLog = console.log;
  try {
    process.chdir(tmpRoot);
    console.log = (...args) => { output += args.join(' ') + '\n'; };

    // Create a run log
    const logPath = getRunLogPath('123456', 1);
    writePhaseToRunLog(logPath, 1, 'plan', 'Plan reasoning', 3000);
    writePhaseToRunLog(logPath, 1, 'do', 'Build reasoning', 12000);

    listRunLogs([]);
    assert.ok(output.includes('Run logs (1 file)'), 'shows file count');
    assert.ok(output.includes('Cycle: 1'), 'shows cycle number');
    assert.ok(output.includes('PLAN'), 'shows PLAN phase');
    assert.ok(output.includes('DO'), 'shows DO phase');
  } finally {
    console.log = origLog;
    process.chdir(origCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('listRunLogs --cat prints full contents of a specific log', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runlog-test-'));
  const origCwd = process.cwd();
  let output = '';
  const origLog = console.log;
  try {
    process.chdir(tmpRoot);
    console.log = (...args) => { output += args.join(' ') + '\n'; };

    const logPath = getRunLogPath('123456', 1);
    writePhaseToRunLog(logPath, 1, 'plan', 'Full plan reasoning here', 3000);

    const fileName = path.basename(logPath);
    listRunLogs(['--cat', fileName]);
    assert.ok(output.includes('# Run Log — Cycle 1'), 'shows full header');
    assert.ok(output.includes('Full plan reasoning here'), 'shows full content');
  } finally {
    console.log = origLog;
    process.chdir(origCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
