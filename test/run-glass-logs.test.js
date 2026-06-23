'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { getRunLogDir, getRunLogPath, writePhaseToRunLog } = require('../commands/run');

// --- Source-level: glass run log helpers exist and are wired ---

const RUN_SRC = fs.readFileSync(path.join(__dirname, '..', 'commands', 'run.js'), 'utf8');

test('run.js always captures stdout for run log persistence', () => {
  // stdio must pipe stdout in both verbose and non-verbose modes
  assert.match(RUN_SRC, /stdio:\s*verbose\s*\?\s*\['pipe',\s*'pipe',\s*'inherit'\]\s*:\s*'pipe'/);
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
