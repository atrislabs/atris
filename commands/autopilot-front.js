// atris autopilot: point it at the workspace and it keeps going.
// Each leg picks the most logical work — a moving mission first, then a
// member choosing useful work, then a self-chosen mission — and drives it
// through the mission runtime. It loops until stopped:
//   atris autopilot stop   (from any terminal)  or Ctrl-C here.
// The old suggest→justify→execute loop lives on behind `atris autopilot --legacy`.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pickRunnableMission, runBudgetSeconds } = require('./run-front');

const CLI_PATH = path.join(__dirname, '..', 'bin', 'atris.js');
const DEFAULT_LEG_WALL_SECONDS = 3600;
const LEG_TICKS = 12;
const FAST_FAIL_SECONDS = 30;
const MAX_FAST_FAILS = 5;

function statePath(root) { return path.join(root, '.atris', 'state', 'autopilot.json'); }
function stopPath(root) { return path.join(root, '.atris', 'state', 'autopilot.stop'); }

function readState(root) {
  try { return JSON.parse(fs.readFileSync(statePath(root), 'utf8')); } catch { return null; }
}

function writeState(root, state) {
  fs.mkdirSync(path.dirname(statePath(root)), { recursive: true });
  fs.writeFileSync(statePath(root), `${JSON.stringify(state, null, 2)}\n`);
}

function clearState(root) {
  try { fs.unlinkSync(statePath(root)); } catch {}
}

function stopRequested(root) { return fs.existsSync(stopPath(root)); }
function requestStop(root) {
  fs.mkdirSync(path.dirname(stopPath(root)), { recursive: true });
  fs.writeFileSync(stopPath(root), `${new Date().toISOString()}\n`);
}
function clearStop(root) { try { fs.unlinkSync(stopPath(root)); } catch {} }

function pidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readValueFlag(args, name) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// Most logical member: the one who owns the newest mission, else the first
// member on the team. Null when the workspace has no members yet.
function pickMember(root, preferredOwner = '') {
  let members = [];
  try {
    const { findAllMembers } = require('./member');
    members = findAllMembers(path.join(root, 'atris', 'team')) || [];
  } catch {
    return null;
  }
  if (!members.length) return null;
  const owner = String(preferredOwner || '').trim().toLowerCase();
  if (owner) {
    const owned = members.find((member) => String(member?.name || '').trim().toLowerCase() === owner);
    if (owned) return owned.name;
  }
  return members[0]?.name || null;
}

function newestMissionOwner(root) {
  let map;
  try { map = require('./mission').loadMissionMap(root); } catch { return ''; }
  const newest = Array.from(map.values())
    .sort((a, b) => String(b?.updated_at || b?.created_at || '').localeCompare(String(a?.updated_at || a?.created_at || '')));
  return newest[0]?.owner || '';
}

function legPlan(root, legWallSeconds) {
  const mission = pickRunnableMission(root);
  if (mission) {
    return {
      kind: 'mission',
      label: `mission ${mission.id}: ${mission.objective}`,
      args: ['mission', 'run', mission.id, '--max-ticks', String(LEG_TICKS), '--max-wall', String(legWallSeconds), '--complete-on-pass'],
    };
  }
  const member = pickMember(root, newestMissionOwner(root));
  if (member) {
    // --runner atris2: member run defaults to codex_goal, which waits for a
    // live Codex session — a headless leg would tick it without doing work.
    return {
      kind: 'member',
      label: `member ${member} chooses useful work`,
      args: ['member', 'run', member, '--runner', 'atris2', '--minutes', String(Math.max(5, Math.round(legWallSeconds / 60)))],
    };
  }
  return {
    kind: 'auto-mission',
    label: 'self-chosen mission from Atris state',
    args: [
      'mission', 'run',
      'Choose one bounded useful task from Atris state, complete it, and show plain proof.',
      '--owner', 'mission-lead',
      '--runner', 'atris2',
      '--max-ticks', String(LEG_TICKS),
      '--max-wall', String(legWallSeconds),
    ],
  };
}

function driveLeg(root, legArgs, current) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...legArgs], { cwd: root, stdio: 'inherit' });
    current.child = child;
    // Stop fast: a stop file written by `atris autopilot stop` in another
    // terminal terminates the running leg, not just the loop between legs.
    const poll = setInterval(() => {
      if (stopRequested(root)) { try { child.kill('SIGTERM'); } catch {} }
    }, 2000);
    if (poll.unref) poll.unref();
    const finish = (code) => {
      clearInterval(poll);
      current.child = null;
      resolve(Number.isFinite(code) ? code : 1);
    };
    child.on('error', () => finish(1));
    child.on('close', finish);
  });
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function autopilotStop(root = process.cwd()) {
  requestStop(root);
  const state = readState(root);
  if (state && pidAlive(state.pid)) {
    try { process.kill(state.pid, 'SIGTERM'); } catch {}
    console.log(`Stopping autopilot (pid ${state.pid}).`);
  } else {
    console.log('No live autopilot process; stop marker written so the next start clears it.');
  }
  return 0;
}

function autopilotStatus(root = process.cwd()) {
  const state = readState(root);
  if (!state) { console.log('Autopilot is not running.'); return 0; }
  const alive = pidAlive(state.pid);
  console.log(`Autopilot ${alive ? 'running' : 'not running (stale state)'} — pid ${state.pid}, started ${state.started_at}, legs ${state.legs || 0}`);
  if (state.current_leg) console.log(`Current leg: ${state.current_leg}`);
  if (!alive) clearState(root);
  return 0;
}

function showFrontHelp() {
  console.log('');
  console.log('Usage: atris autopilot [options]');
  console.log('');
  console.log('Keeps the workspace moving: picks the most logical mission or member,');
  console.log('drives it through the mission runtime, then picks the next one.');
  console.log('Runs until you stop it.');
  console.log('');
  console.log('Options:');
  console.log('  --minutes N | --hours N   Total budget (default: unlimited)');
  console.log('  --leg-wall N              Seconds per leg (default: 3600)');
  console.log('  --once                    Run a single leg, then exit');
  console.log('  --legacy                  Old suggest→justify→execute loop');
  console.log('');
  console.log('Control:');
  console.log('  atris autopilot stop      Stop fast, from any terminal');
  console.log('  atris autopilot status    Show what the loop is doing');
  console.log('');
}

async function autopilotFront(args = []) {
  const root = process.cwd();
  if (args[0] === 'stop') return autopilotStop(root);
  if (args[0] === 'status') return autopilotStatus(root);
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') { showFrontHelp(); return 0; }

  const existing = readState(root);
  if (existing && pidAlive(existing.pid) && existing.pid !== process.pid) {
    console.log(`Autopilot already running (pid ${existing.pid}). Stop it first: atris autopilot stop`);
    return 1;
  }

  clearStop(root);
  const budgetSeconds = runBudgetSeconds(args);
  const legWallDefault = positiveNumber(readValueFlag(args, '--leg-wall')) || DEFAULT_LEG_WALL_SECONDS;
  const once = args.includes('--once');
  const startedAt = Date.now();
  const state = { pid: process.pid, started_at: new Date().toISOString(), legs: 0 };
  writeState(root, state);

  const current = { child: null };
  // `autopilot stop` SIGTERMs this pid directly, so the farewell must print
  // here — the signal always beats the loop's own stop-file check.
  const onSignal = () => {
    if (current.child) { try { current.child.kill('SIGTERM'); } catch {} }
    const reason = stopRequested(root) ? 'stop requested' : 'interrupted';
    console.log(`\nAutopilot off (${reason}). Legs run: ${state.legs}.`);
    clearState(root);
    clearStop(root);
    process.exit(130);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  console.log('Autopilot on. Stop anytime: Ctrl-C here, or `atris autopilot stop` anywhere.');

  let fastFails = 0;
  let stopReason = '';
  while (true) {
    if (stopRequested(root)) { stopReason = 'stop requested'; break; }
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    if (budgetSeconds && elapsed >= budgetSeconds) { stopReason = 'budget spent'; break; }
    const legWall = budgetSeconds ? Math.min(legWallDefault, budgetSeconds - elapsed) : legWallDefault;

    const plan = legPlan(root, Math.max(60, legWall));
    state.legs += 1;
    state.current_leg = plan.label;
    state.updated_at = new Date().toISOString();
    writeState(root, state);
    console.log(`\nautopilot leg ${state.legs}: ${plan.label}`);

    const legStarted = Date.now();
    const code = await driveLeg(root, plan.args, current);
    state.last_exit = code;
    writeState(root, state);

    if (once) { stopReason = 'single leg (--once)'; break; }
    if (stopRequested(root)) { stopReason = 'stop requested'; break; }

    // A leg that finishes in seconds means no real work happened — a crash,
    // or a degenerate mission whose ticks record instantly (exit 0). Either
    // way, back off and stop instead of hot-looping on it.
    const legSeconds = (Date.now() - legStarted) / 1000;
    if (legSeconds < FAST_FAIL_SECONDS) {
      fastFails += 1;
      if (fastFails >= MAX_FAST_FAILS) {
        stopReason = `${MAX_FAST_FAILS} fast legs in a row (${code === 0 ? 'no progress' : 'failures'})`;
        break;
      }
      await sleep(code === 0 ? 5000 : 15000);
    } else {
      fastFails = 0;
      await sleep(2000);
    }
  }

  clearStop(root);
  clearState(root);
  console.log(`\nAutopilot off (${stopReason}). Legs run: ${state.legs}.`);
  return stopReason.includes('fast legs') ? 1 : 0;
}

module.exports = {
  autopilotFront,
  autopilotStop,
  autopilotStatus,
  legPlan,
  pickMember,
  stopRequested,
  requestStop,
  clearStop,
  readState,
  writeState,
};
