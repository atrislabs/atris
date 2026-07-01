// atris truth — one table of what is actually proven, blocked, or stale.
// Rolls up sources that already exist; writes nothing. SQL/state is truth, this is the render.
//   1. .atris/state/missions.jsonl        — mission states (dedupe by id, latest wins)
//   2. ~/.atris/tasks.db                  — task counts by status
//   3. atris/features/*/                  — validate.md frontmatter + newest proof/ receipt age
//   4. ~/.atris/heartbeat/{registry,state}.json — declared loops vs last_run / fails

const fs = require('fs');
const path = require('path');
const os = require('os');

const STALE_DAYS = 7;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function daysAgo(ms) {
  if (!ms) return null;
  return (Date.now() - ms) / 86400000;
}

function fmtAge(days) {
  if (days == null) return 'never';
  if (days < 1) return `${Math.round(days * 24)}h`;
  return `${Math.round(days)}d`;
}

function loadMissions(cwd) {
  const file = path.join(cwd, '.atris', 'state', 'missions.jsonl');
  if (!fs.existsSync(file)) return [];
  const seen = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      const id = rec.id || rec.mission_id;
      if (id) seen.set(id, rec);
    } catch { /* skip bad lines */ }
  }
  return [...seen.values()].filter((m) => m.status && m.status !== 'complete' && m.status !== 'archived');
}

function loadTaskCounts() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(os.homedir(), '.atris', 'tasks.db'), { readOnly: true });
    const rows = db.prepare('SELECT status, COUNT(*) n FROM tasks GROUP BY status').all();
    db.close();
    const counts = {};
    for (const r of rows) counts[r.status] = r.n;
    return counts;
  } catch { return null; }
}

function loadFeatures(cwd) {
  const dir = path.join(cwd, 'atris', 'features');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('_')) continue;
    const fdir = path.join(dir, name);
    const validate = path.join(fdir, 'validate.md');
    if (!fs.existsSync(validate)) continue;
    let status = null;
    const head = fs.readFileSync(validate, 'utf8').slice(0, 500);
    const m = head.match(/^status:\s*(.+)$/m);
    if (m) status = m[1].trim();
    // newest receipt in proof/ (if any)
    let proofAgeDays = null;
    const proofDir = path.join(fdir, 'proof');
    if (fs.existsSync(proofDir)) {
      let newest = 0;
      for (const p of fs.readdirSync(proofDir)) {
        try { newest = Math.max(newest, fs.statSync(path.join(proofDir, p)).mtimeMs); } catch { /* skip */ }
      }
      if (newest) proofAgeDays = daysAgo(newest);
    }
    let verdict;
    if (/blocked/i.test(status || '')) verdict = 'blocked';
    else if (proofAgeDays != null && proofAgeDays <= STALE_DAYS) verdict = 'proven';
    else if (proofAgeDays != null) verdict = 'stale';
    else verdict = 'unproven';
    out.push({ lane: name, status: status || '-', verdict, proofAgeDays });
  }
  return out;
}

function loadHeartbeats() {
  const hbDir = path.join(os.homedir(), '.atris', 'heartbeat');
  const registry = readJson(path.join(hbDir, 'registry.json'));
  const state = readJson(path.join(hbDir, 'state.json')) || {};
  if (!registry || !Array.isArray(registry.jobs)) return [];
  return registry.jobs.filter((j) => !j.disabled).map((j) => {
    const s = state[j.id] || {};
    const lastRun = s.last_run ? Date.parse(s.last_run) : null;
    const ageDays = daysAgo(lastRun);
    const expectedDays = ((j.cadence_minutes || 60) / 1440) * 3; // 3 missed cadences = stale
    let verdict;
    if (s.disabled) verdict = 'disabled';
    else if ((s.consecutive_fails || 0) > 0) verdict = 'blocked';
    else if (lastRun == null) verdict = 'never-ran';
    else if (ageDays > Math.max(expectedDays, 0.05)) verdict = 'stale';
    else verdict = 'proven';
    return { id: j.id, verdict, lastRunAgeDays: ageDays, fails: s.consecutive_fails || 0 };
  });
}

function truthCommand(args = []) {
  const cwd = process.cwd();
  const json = args.includes('--json');
  const summary = args.includes('--summary');

  const missions = loadMissions(cwd);
  const tasks = loadTaskCounts();
  const features = loadFeatures(cwd);
  const heartbeats = loadHeartbeats();

  const featureTally = {};
  for (const f of features) featureTally[f.verdict] = (featureTally[f.verdict] || 0) + 1;
  const loopTally = {};
  for (const h of heartbeats) loopTally[h.verdict] = (loopTally[h.verdict] || 0) + 1;

  const result = {
    ok: true,
    generated_at: new Date().toISOString(),
    missions_active: missions.map((m) => ({ id: m.id || m.mission_id, status: m.status, owner: m.owner })),
    tasks,
    features: featureTally,
    loops: loopTally,
    feature_rows: features,
    loop_rows: heartbeats,
  };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  const line = (s) => console.log(s);
  if (summary) {
    line(`truth: features ${featureTally.proven || 0} proven / ${featureTally.stale || 0} stale / ${featureTally.blocked || 0} blocked / ${featureTally.unproven || 0} unproven · loops ${loopTally.proven || 0} live / ${(loopTally.stale || 0) + (loopTally['never-ran'] || 0)} stale / ${loopTally.blocked || 0} failing · missions ${missions.length} active`);
    return 0;
  }

  line('ATRIS TRUTH — live state, not belief\n');

  line(`Missions active: ${missions.length}`);
  for (const m of missions) line(`  ${m.status.padEnd(8)} ${m.owner || '?'}  ${m.id || m.mission_id}`);

  if (tasks) {
    line(`\nTasks: ${Object.entries(tasks).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  }

  line(`\nFeature lanes (${features.length}):`);
  const order = { blocked: 0, stale: 1, unproven: 2, proven: 3 };
  for (const f of features.sort((a, b) => (order[a.verdict] ?? 9) - (order[b.verdict] ?? 9))) {
    line(`  ${f.verdict.padEnd(9)} ${fmtAge(f.proofAgeDays).padStart(6)}  ${f.lane}`);
  }

  line(`\nLoops (${heartbeats.length}):`);
  for (const h of heartbeats) {
    line(`  ${h.verdict.padEnd(9)} ${fmtAge(h.lastRunAgeDays).padStart(6)}  ${h.id}${h.fails ? `  fails=${h.fails}` : ''}`);
  }

  line(`\nVerdict key: proven = receipt within ${STALE_DAYS}d · stale = receipt older · unproven = no receipt ever · blocked = failing now`);
  return 0;
}

module.exports = { truthCommand };
