// atris drive — self-driving tick over the mission plane.
// One tick: run mission doctor, auto-execute the fixes it prescribes that are
// safe to run (stale ready receipts -> verify tick), and log everything that
// still needs a human as an explicit disengagement. The metric that matters:
// disengagements per tick, driven to zero.
//
// State: .atris/state/drive.jsonl (one line per tick, append-only).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'atris.js');

function runAtris(args, cwd) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function parseJsonLoose(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  if (start === -1) return null;
  try { return JSON.parse(text.slice(start)); } catch (err) { return null; }
}

function statePath(cwd) {
  return path.join(cwd, '.atris', 'state', 'drive.jsonl');
}

function loadHistory(cwd, limit = 20) {
  try {
    const lines = fs.readFileSync(statePath(cwd), 'utf8').trim().split('\n');
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (err) { return []; }
}

function appendState(cwd, record) {
  const file = statePath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + '\n');
}

async function driveCommand(argv) {
  const cwd = process.cwd();
  const json = argv.includes('--json');
  const dryRun = argv.includes('--dry-run');

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('atris drive - one self-driving tick over the mission plane');
    console.log('');
    console.log('  atris drive [--dry-run] [--json]   doctor -> auto-fix safe findings -> count disengagements');
    console.log('  atris drive status [--json]        disengagement trend from past ticks');
    console.log('');
    console.log('  Auto-handled: stale_ready_receipt (runs the verify tick, completes on pass).');
    console.log('  Everything else = a disengagement: the system needed a human. Logged, counted, escalated.');
    return 0;
  }

  if (argv[0] === 'status') {
    const history = loadHistory(cwd);
    if (!history.length) { console.log('No drive ticks yet. Run: atris drive'); return 0; }
    if (json) { console.log(JSON.stringify({ ok: true, ticks: history }, null, 2)); return 0; }
    console.log('drive — disengagements per tick (goal: 0)\n');
    for (const t of history) {
      console.log(`  ${t.at}  fixed ${t.fixed}/${t.findings}  disengagements ${t.disengagements}`);
    }
    return 0;
  }

  const doctor = runAtris(['mission', 'doctor', '--json'], cwd);
  const report = parseJsonLoose(doctor.stdout);
  if (!report || !Array.isArray(report.findings)) {
    console.error('drive: mission doctor returned no parseable findings.');
    if (doctor.stderr) console.error(doctor.stderr.slice(0, 500));
    return 1;
  }

  const fixed = [];
  const disengagements = [];

  for (const f of report.findings) {
    if (f.code === 'stale_ready_receipt' && f.mission_id && !dryRun) {
      const tick = runAtris(['mission', 'tick', f.mission_id, '--verify', '--complete-on-pass', '--json'], cwd);
      const result = parseJsonLoose(tick.stdout);
      const passed = tick.code === 0 && result && result.ok !== false;
      if (passed) {
        fixed.push({ mission_id: f.mission_id, action: 'verify_tick', objective: f.objective });
        continue;
      }
      disengagements.push({ ...pick(f), reason: 'verify_tick_failed' });
      continue;
    }
    if (f.code === 'stale_ready_receipt' && dryRun) {
      fixed.push({ mission_id: f.mission_id, action: 'would_verify_tick', objective: f.objective });
      continue;
    }
    disengagements.push({ ...pick(f), reason: f.code });
  }

  function pick(f) {
    return { mission_id: f.mission_id, code: f.code, owner: f.owner, objective: (f.objective || '').slice(0, 120), next: f.next };
  }

  const record = {
    at: new Date().toISOString(),
    findings: report.findings.length,
    checked: report.checked_count,
    fixed: fixed.length,
    disengagements: disengagements.length,
    dry_run: dryRun,
    fixed_detail: fixed,
    disengagement_detail: disengagements,
  };
  if (!dryRun) appendState(cwd, record);

  if (json) { console.log(JSON.stringify({ ok: true, ...record }, null, 2)); return 0; }

  console.log(`drive tick — ${report.checked_count} missions checked, ${report.findings.length} findings`);
  console.log(`  auto-fixed:      ${fixed.length}`);
  for (const x of fixed) console.log(`    ✓ ${x.action} ${x.mission_id}`);
  console.log(`  disengagements:  ${disengagements.length}  (a human has to grab the wheel)`);
  const byCode = {};
  for (const d of disengagements) byCode[d.reason] = (byCode[d.reason] || 0) + 1;
  for (const [code, n] of Object.entries(byCode)) console.log(`    ✋ ${code} ×${n}`);
  const history = loadHistory(cwd, 5);
  if (history.length > 1) {
    console.log(`  trend: ${history.map((t) => t.disengagements).join(' → ')}`);
  }
  console.log(`  next: atris drive status · fix the ✋ list · re-run atris drive`);
  return disengagements.length > 0 ? 0 : 0;
}

module.exports = { driveCommand };
