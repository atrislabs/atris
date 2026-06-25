'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { getRunLogDir, getRunLogPath, writePhaseToRunLog, listRunLogs, pruneRunLogs, searchRunLogs, statsRunLogs, exportRunLogs, diffRunLogs, buildRunPrompt } = require('../commands/run');

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

test('run.js prints run log notice at startup in non-verbose mode', () => {
  assert.match(RUN_SRC, /phase reasoning will be saved to atris\/logs\/runs/);
});

test('run.js prints run log notice at startup in verbose mode', () => {
  assert.match(RUN_SRC, /Run logs: atris\/logs\/runs/);
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
    assert.ok(content.includes('# Run Log - Cycle 1'), 'header present');
    assert.ok(content.includes('## PLAN'), 'plan section present');
    assert.ok(content.includes('Plan reasoning here'), 'plan content present');
    assert.ok(content.includes('(3s)'), 'duration present');
    assert.ok(content.includes('> Generated:'), 'timestamp present');
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
    const headerCount = (content.match(/# Run Log - Cycle 1/g) || []).length;
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
    assert.ok(output.includes('# Run Log - Cycle 1'), 'shows full header');
    assert.ok(output.includes('Full plan reasoning here'), 'shows full content');
  } finally {
    console.log = origLog;
    process.chdir(origCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('listRunLogs --json outputs machine-readable JSON', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runlog-test-'));
  const origCwd = process.cwd();
  let output = '';
  const origLog = console.log;
  try {
    process.chdir(tmpRoot);
    console.log = (...args) => { output += args.join(' ') + '\n'; };

    const logPath = getRunLogPath('123456', 1);
    writePhaseToRunLog(logPath, 1, 'plan', 'Plan reasoning', 3000);

    listRunLogs(['--json', '--tail', '0']);
    const parsed = JSON.parse(output.trim());
    assert.ok(parsed.ok, 'JSON has ok: true');
    assert.ok(Array.isArray(parsed.logs), 'JSON has logs array');
    assert.equal(parsed.logs.length, 1, 'one log entry');
    assert.equal(parsed.logs[0].cycle, 1, 'cycle parsed correctly');
    assert.ok(parsed.logs[0].phases.includes('PLAN'), 'phases parsed correctly');
  } finally {
    console.log = origLog;
    process.chdir(origCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('listRunLogs --json --cat outputs JSON with content', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runlog-test-'));
  const origCwd = process.cwd();
  let output = '';
  const origLog = console.log;
  try {
    process.chdir(tmpRoot);
    console.log = (...args) => { output += args.join(' ') + '\n'; };

    const logPath = getRunLogPath('123456', 1);
    writePhaseToRunLog(logPath, 1, 'plan', 'JSON cat content', 3000);

    const fileName = path.basename(logPath);
    listRunLogs(['--json', '--cat', fileName]);
    const parsed = JSON.parse(output.trim());
    assert.ok(parsed.ok, 'JSON has ok: true');
    assert.ok(parsed.content.includes('JSON cat content'), 'content in JSON output');
  } finally {
    console.log = origLog;
    process.chdir(origCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('listRunLogs --json with no logs returns empty array', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runlog-test-'));
  const origCwd = process.cwd();
  let output = '';
  const origLog = console.log;
  try {
    process.chdir(tmpRoot);
    console.log = (...args) => { output += args.join(' ') + '\n'; };

    listRunLogs(['--json']);
    const parsed = JSON.parse(output.trim());
    assert.ok(parsed.ok, 'JSON has ok: true');
    assert.equal(parsed.count, 0, 'count is 0');
    assert.deepEqual(parsed.logs, [], 'logs is empty array');
  } finally {
    console.log = origLog;
    process.chdir(origCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// --- pruneRunLogs ---

test('pruneRunLogs does nothing when under keep limit', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runlog-test-'));
  const origCwd = process.cwd();
  let output = '';
  const origLog = console.log;
  try {
    process.chdir(tmpRoot);
    console.log = (...args) => { output += args.join(' ') + '\n'; };

    // Create 3 logs
    for (let i = 0; i < 3; i++) {
      writePhaseToRunLog(getRunLogPath(`10000${i}`, 1), 1, 'plan', `reasoning ${i}`, 1000);
    }

    pruneRunLogs(['--keep', '10']);
    assert.ok(output.includes('No pruning needed'), 'reports no pruning needed');
  } finally {
    console.log = origLog;
    process.chdir(origCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('pruneRunLogs --dry-run shows what would be deleted', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runlog-test-'));
  const origCwd = process.cwd();
  let output = '';
  const origLog = console.log;
  try {
    process.chdir(tmpRoot);
    console.log = (...args) => { output += args.join(' ') + '\n'; };

    // Create 5 logs
    for (let i = 0; i < 5; i++) {
      writePhaseToRunLog(getRunLogPath(`20000${i}`, 1), 1, 'plan', `reasoning ${i}`, 1000);
    }

    pruneRunLogs(['--keep', '2', '--dry-run']);
    assert.ok(output.includes('[DRY RUN]'), 'dry-run mode');
    assert.ok(output.includes('Would delete'), 'shows what would be deleted');
    assert.ok(!fs.readdirSync(getRunLogDir()).every(f => f.endsWith('.md')) || fs.readdirSync(getRunLogDir()).filter(f => f.endsWith('.md')).length === 5, 'no files actually deleted');
  } finally {
    console.log = origLog;
    process.chdir(origCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('pruneRunLogs deletes old logs keeping only N', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runlog-test-'));
  const origCwd = process.cwd();
  let output = '';
  const origLog = console.log;
  try {
    process.chdir(tmpRoot);
    console.log = (...args) => { output += args.join(' ') + '\n'; };

    // Create 5 logs
    for (let i = 0; i < 5; i++) {
      writePhaseToRunLog(getRunLogPath(`30000${i}`, 1), 1, 'plan', `reasoning ${i}`, 1000);
    }

    pruneRunLogs(['--keep', '2']);
    const remaining = fs.readdirSync(getRunLogDir()).filter(f => f.endsWith('.md'));
    assert.equal(remaining.length, 2, 'only 2 logs remain');
    assert.ok(output.includes('Pruned 3'), 'reports 3 pruned');
  } finally {
    console.log = origLog;
    process.chdir(origCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run.js auto-prunes old run logs after run completion', () => {
  assert.match(RUN_SRC, /Auto-prune old run logs/);
  assert.match(RUN_SRC, /const keep = 100/);
});

// --- searchRunLogs ---

test('searchRunLogs finds keyword across phases', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runlog-test-'));
  const origCwd = process.cwd();
  let output = '';
  const origLog = console.log;
  try {
    process.chdir(tmpRoot);
    console.log = (...args) => { output += args.join(' ') + '\n'; };

    const logPath = getRunLogPath('400001', 1);
    writePhaseToRunLog(logPath, 1, 'plan', 'Need to fix the auth module', 3000);
    writePhaseToRunLog(logPath, 1, 'do', 'Implemented auth fix in login.js', 12000);

    searchRunLogs(['auth']);
    assert.ok(output.includes('auth'), 'search output contains keyword');
    assert.ok(output.includes('PLAN'), 'found in PLAN phase');
    assert.ok(output.includes('DO'), 'found in DO phase');
  } finally {
    console.log = origLog;
    process.chdir(origCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('searchRunLogs --phase filters to specific phase', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runlog-test-'));
  const origCwd = process.cwd();
  let output = '';
  const origLog = console.log;
  try {
    process.chdir(tmpRoot);
    console.log = (...args) => { output += args.join(' ') + '\n'; };

    const logPath = getRunLogPath('400002', 1);
    writePhaseToRunLog(logPath, 1, 'plan', 'Need to fix the auth module', 3000);
    writePhaseToRunLog(logPath, 1, 'do', 'Implemented auth fix in login.js', 12000);

    searchRunLogs(['auth', '--phase', 'do']);
    assert.ok(output.includes('DO'), 'found in DO phase');
    assert.ok(!output.includes('[PLAN]'), 'PLAN phase filtered out');
  } finally {
    console.log = origLog;
    process.chdir(origCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('searchRunLogs reports no matches gracefully', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runlog-test-'));
  const origCwd = process.cwd();
  let output = '';
  const origLog = console.log;
  try {
    process.chdir(tmpRoot);
    console.log = (...args) => { output += args.join(' ') + '\n'; };

    const logPath = getRunLogPath('400003', 1);
    writePhaseToRunLog(logPath, 1, 'plan', 'Some reasoning here', 3000);

    searchRunLogs(['nonexistent']);
    assert.ok(output.includes('No matches'), 'reports no matches');
  } finally {
    console.log = origLog;
    process.chdir(origCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// --- spawnSync error handling ---

test('run.js uses spawnSync instead of execSync for phase execution', () => {
  assert.match(RUN_SRC, /spawnSync/);
  assert.match(RUN_SRC, /const \{ execSync, spawnSync \}/);
});

test('run.js execPhaseCommandSync handles non-zero exit codes', () => {
  assert.match(RUN_SRC, /result\.status !== 0/);
  assert.match(RUN_SRC, /err\.stdout = result\.stdout/);
  assert.match(RUN_SRC, /err\.signal = result\.signal/);
});

test('run.js execPhaseCommandSync handles spawn errors', () => {
  assert.match(RUN_SRC, /if \(result\.error\) throw result\.error/);
});

// --- statsRunLogs ---

test('statsRunLogs shows no-logs message when runs dir is empty', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runlog-test-'));
  const origCwd = process.cwd();
  let output = '';
  const origLog = console.log;
  try {
    process.chdir(tmpRoot);
    console.log = (...args) => { output += args.join(' ') + '\n'; };
    statsRunLogs();
    assert.ok(output.includes('No run logs found'), 'shows no-logs message');
  } finally {
    console.log = origLog;
    process.chdir(origCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('statsRunLogs shows phase counts and avg durations', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runlog-test-'));
  const origCwd = process.cwd();
  let output = '';
  const origLog = console.log;
  try {
    process.chdir(tmpRoot);
    console.log = (...args) => { output += args.join(' ') + '\n'; };

    // Create a run log with phases
    const logPath = getRunLogPath('500001', 1);
    writePhaseToRunLog(logPath, 1, 'plan', 'Plan reasoning', 3000);
    writePhaseToRunLog(logPath, 1, 'do', 'Build reasoning', 12000);
    writePhaseToRunLog(logPath, 1, 'review', 'Review reasoning', 5000);

    statsRunLogs();
    assert.ok(output.includes('Run Log Stats'), 'shows stats header');
    assert.ok(output.includes('PLAN'), 'shows PLAN phase');
    assert.ok(output.includes('DO'), 'shows DO phase');
    assert.ok(output.includes('REVIEW'), 'shows REVIEW phase');
    assert.ok(output.includes('3s'), 'shows plan avg duration');
  } finally {
    console.log = origLog;
    process.chdir(origCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// --- exportRunLogs ---

test('exportRunLogs exports all logs as JSON bundle', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runlog-test-'));
  const origCwd = process.cwd();
  let output = '';
  const origLog = console.log;
  try {
    process.chdir(tmpRoot);
    console.log = (...args) => { output += args.join(' ') + '\n'; };

    const logPath = getRunLogPath('600001', 1);
    writePhaseToRunLog(logPath, 1, 'plan', 'Plan reasoning', 3000);
    writePhaseToRunLog(logPath, 1, 'do', 'Build reasoning', 12000);

    const outFile = path.join(tmpRoot, 'export.json');
    exportRunLogs(['--out', outFile]);

    assert.ok(fs.existsSync(outFile), 'export file created');
    const bundle = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    assert.ok(bundle.exported_at, 'has exported_at timestamp');
    assert.equal(bundle.count, 1, 'count is 1');
    assert.equal(bundle.logs.length, 1, 'one log in bundle');
    assert.equal(bundle.logs[0].cycle, 1, 'cycle parsed correctly');
    assert.ok(bundle.logs[0].content.includes('Plan reasoning'), 'content included');
    assert.ok(output.includes('Exported 1 run log'), 'reports export');
  } finally {
    console.log = origLog;
    process.chdir(origCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('exportRunLogs reports no logs gracefully', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runlog-test-'));
  const origCwd = process.cwd();
  let output = '';
  const origLog = console.log;
  try {
    process.chdir(tmpRoot);
    console.log = (...args) => { output += args.join(' ') + '\n'; };

    exportRunLogs([]);
    assert.ok(output.includes('No run logs found'), 'reports no logs');
  } finally {
    console.log = origLog;
    process.chdir(origCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// --- diffRunLogs ---

test('diffRunLogs compares two logs and shows differences', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runlog-test-'));
  const origCwd = process.cwd();
  let output = '';
  const origLog = console.log;
  try {
    process.chdir(tmpRoot);
    console.log = (...args) => { output += args.join(' ') + '\n'; };

    // Create two logs with different content
    const log1 = getRunLogPath('700001', 1);
    writePhaseToRunLog(log1, 1, 'plan', 'Plan A reasoning', 3000);
    writePhaseToRunLog(log1, 1, 'do', 'Build A reasoning', 12000);

    const log2 = getRunLogPath('700002', 1);
    writePhaseToRunLog(log2, 1, 'plan', 'Plan B reasoning', 3000);
    writePhaseToRunLog(log2, 1, 'do', 'Build A reasoning', 12000);

    const file1 = path.basename(log1);
    const file2 = path.basename(log2);
    diffRunLogs([file1, file2]);

    assert.ok(output.includes('Diff:'), 'shows diff header');
    assert.ok(output.includes('different'), 'shows different phases');
    assert.ok(output.includes('identical'), 'shows identical phases');
    assert.ok(output.includes('- Plan A reasoning'), 'shows removed line');
    assert.ok(output.includes('+ Plan B reasoning'), 'shows added line');
  } finally {
    console.log = origLog;
    process.chdir(origCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('diffRunLogs shows usage when not enough args', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runlog-test-'));
  const origCwd = process.cwd();
  let output = '';
  const origLog = console.log;
  try {
    process.chdir(tmpRoot);
    console.log = (...args) => { output += args.join(' ') + '\n'; };

    diffRunLogs(['only-one-file']);
    assert.ok(output.includes('Usage:'), 'shows usage');
  } finally {
    console.log = origLog;
    process.chdir(origCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// --- Integration: full run log lifecycle ---

test('integration: full run log lifecycle (create, list, search, stats, export, prune)', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-runlog-test-'));
  const origCwd = process.cwd();
  let output = '';
  const origLog = console.log;
  try {
    process.chdir(tmpRoot);
    console.log = (...args) => { output += args.join(' ') + '\n'; };

    // 1. Create multiple run logs
    for (let i = 0; i < 5; i++) {
      const logPath = getRunLogPath(`80000${i}`, 1);
      writePhaseToRunLog(logPath, 1, 'plan', `Plan reasoning ${i} with keyword auth`, 3000 + i * 1000);
      writePhaseToRunLog(logPath, 1, 'do', `Build reasoning ${i}`, 10000 + i * 1000);
      writePhaseToRunLog(logPath, 1, 'review', `Review reasoning ${i}`, 5000);
    }

    // 2. List logs
    output = '';
    listRunLogs(['--tail', '0']);
    assert.ok(output.includes('Run logs (5 files)'), 'list shows 5 files');

    // 3. Search for keyword
    output = '';
    searchRunLogs(['auth']);
    assert.ok(output.includes('5 matches'), 'search finds 5 matches for auth');

    // 4. Stats
    output = '';
    statsRunLogs();
    assert.ok(output.includes('Run Log Stats'), 'stats shows header');
    assert.ok(output.includes('PLAN'), 'stats shows PLAN');

    // 5. Export
    output = '';
    const outFile = path.join(tmpRoot, 'export.json');
    exportRunLogs(['--out', outFile]);
    assert.ok(fs.existsSync(outFile), 'export file created');
    const bundle = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    assert.equal(bundle.count, 5, 'export has 5 logs');

    // 6. Prune to 2
    output = '';
    pruneRunLogs(['--keep', '2']);
    const remaining = fs.readdirSync(getRunLogDir()).filter(f => f.endsWith('.md'));
    assert.equal(remaining.length, 2, 'prune leaves 2 logs');

  } finally {
    console.log = origLog;
    process.chdir(origCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// --- Loop closure: review feeds into next plan ---

test('buildRunPrompt accepts priorCycleReview as third argument', () => {
  assert.match(RUN_SRC, /function buildRunPrompt\(phase, context, priorCycleReview\)/);
});

test('plan prompt includes review section when priorCycleReview is provided', () => {
  const ctx = {
    mapPath: 'atris/MAP.md',
    todoPath: 'atris/TODO.md',
    personaPath: 'atris/PERSONA.md',
    lessonsPath: null,
    journalPath: 'atris/logs/2026/2026-06-23.md',
  };
  const review = 'Tests failed in auth module. Missing import for bcrypt.';
  const prompt = buildRunPrompt('plan', ctx, review);

  assert.ok(prompt.includes("Previous Cycle's Review"), 'includes review section header');
  assert.ok(prompt.includes(review), 'includes the actual review text');
  assert.ok(prompt.includes('DATA from the previous cycle'), 'includes data-not-instructions preamble');
  assert.ok(prompt.includes('```'), 'review wrapped in code fence');
  assert.ok(prompt.includes("Read the Previous Cycle's Review"), 'workflow step references review');
});

test('plan prompt does NOT include review section when priorCycleReview is null', () => {
  const ctx = {
    mapPath: 'atris/MAP.md',
    todoPath: 'atris/TODO.md',
    personaPath: 'atris/PERSONA.md',
    lessonsPath: null,
    journalPath: null,
  };
  const prompt = buildRunPrompt('plan', ctx, null);

  assert.ok(!prompt.includes("Previous Cycle's Review"), 'no review section when null');
  assert.ok(!prompt.includes("Read the Previous Cycle's Review"), 'no review workflow step when null');
});

test('plan prompt does NOT include review section when priorCycleReview is whitespace only', () => {
  const ctx = {
    mapPath: null, todoPath: null, personaPath: null, lessonsPath: null, journalPath: null,
  };
  const prompt = buildRunPrompt('plan', ctx, '   \n\n  ');
  assert.ok(!prompt.includes("Previous Cycle's Review"), 'no review section for whitespace-only input');
});

test('plan prompt truncates long review output with truncation marker', () => {
  const ctx = {
    mapPath: null, todoPath: null, personaPath: null, lessonsPath: null, journalPath: null,
  };
  // Create a review with newlines so boundary truncation kicks in
  const longReview = Array(200).fill('line of review text here').join('\n') + '\nfinal line that should be cut';
  const prompt = buildRunPrompt('plan', ctx, longReview);

  assert.ok(prompt.includes('[...truncated]'), 'includes truncation marker');
  // Should be wrapped in code fence
  assert.ok(prompt.includes('```'), 'truncated review still in code fence');
});

test('do and review prompts ignore priorCycleReview (only plan uses it)', () => {
  const ctx = {
    mapPath: 'atris/MAP.md', todoPath: 'atris/TODO.md',
    personaPath: null, lessonsPath: null, journalPath: null,
  };
  const review = 'Some review feedback that should not appear in do or review prompts';

  const doPrompt = buildRunPrompt('do', ctx, review);
  const reviewPrompt = buildRunPrompt('review', ctx, review);

  assert.ok(!doPrompt.includes(review), 'do prompt does not include review');
  assert.ok(!reviewPrompt.includes(review), 'review prompt does not include review');
});

test('run.js carries lastReviewOutput across cycles in the loop', () => {
  assert.match(RUN_SRC, /let lastReviewOutput = null/);
  assert.match(RUN_SRC, /priorCycleReview: lastReviewOutput/);
  assert.match(RUN_SRC, /lastReviewOutput = reviewOutput/);
});
