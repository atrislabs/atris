// atris run: thin front door over the mission runtime loop.
// One bounded pursuit: start a mission from the objective (or resume the most
// logical runnable mission), tick it, complete on pass, then exit.
// The old plan→do→review loop lives on behind `atris run --legacy`.
const path = require('path');
const { spawnSync } = require('child_process');

const CLI_PATH = path.join(__dirname, '..', 'bin', 'atris.js');

const RUN_VALUE_FLAGS = new Set([
  '--owner',
  '--cadence',
  '--minutes',
  '--hours',
  '--max-ticks',
  '--max-wall',
  '--runner',
  '--runner-bin',
  '--runner-template',
  '--runner-model',
  '--runner-profile',
]);

function readValueFlag(args, name) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function runBudgetSeconds(args = []) {
  const hours = positiveNumber(readValueFlag(args, '--hours'));
  if (hours) return Math.round(hours * 3600);
  const minutes = positiveNumber(readValueFlag(args, '--minutes'));
  if (minutes) return Math.round(minutes * 60);
  return null;
}

function runObjective(args = []) {
  const words = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (RUN_VALUE_FLAGS.has(arg)) { i++; continue; }
    if (arg.startsWith('-')) continue;
    words.push(arg);
  }
  return words.join(' ').trim();
}

// Runners a spawned `mission run` can drive unattended.
const HEADLESS_DRIVABLE_RUNNERS = new Set(['claude', 'atris2']);
const CALLER_SESSION_RUNNERS = new Set(['codex_goal', 'caller_session', 'current_agent']);

function liveCodexSession(env = process.env) {
  return Boolean(String(env.CODEX_THREAD_ID || '').trim());
}

function runnerDrivableForFrontDoor(runner, options = {}) {
  const normalized = String(runner || '').trim().toLowerCase();
  if (HEADLESS_DRIVABLE_RUNNERS.has(normalized)) return true;
  if (options.allowCallerSessionRunners && CALLER_SESSION_RUNNERS.has(normalized)) return true;
  return false;
}

// Most logical mission: a moving one beats a planned one, newer beats older.
// ready is excluded — it waits for review, not for another worker pass.
function pickRunnableMission(root = process.cwd(), missionMap = null, options = {}) {
  let map = missionMap;
  if (!map) {
    try { map = require('./mission').loadMissionMap(root); } catch { return null; }
  }
  const candidates = Array.from(map.values())
    .filter((mission) => mission && (mission.status === 'running' || mission.status === 'planning'))
    .filter((mission) => runnerDrivableForFrontDoor(mission?.runner, options))
    .filter((mission) => !/^decide and start the next useful mission after:/i.test(String(mission?.objective || '')))
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === 'running' ? -1 : 1;
      return String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || ''));
    });
  return candidates[0] || null;
}

function runTickBudget(args, budgetSeconds) {
  const explicit = positiveNumber(readValueFlag(args, '--max-ticks'));
  if (explicit) return Math.floor(explicit);
  // A timed run is a loop contract: keep picking the next useful move until
  // the wall clock spends the budget (same rule as member run).
  return budgetSeconds ? Math.max(4, Math.ceil(budgetSeconds / 300)) : 4;
}

async function runMissionFront(args = []) {
  const objective = runObjective(args);
  const budgetSeconds = runBudgetSeconds(args);
  const maxTicks = runTickBudget(args, budgetSeconds);
  const maxWallSeconds = positiveNumber(readValueFlag(args, '--max-wall')) || budgetSeconds || 1200;

  if (objective) {
    const { runRuntimeMissionLoop } = require('../lib/mission-runtime-loop');
    const result = await runRuntimeMissionLoop({
      objective,
      owner: readValueFlag(args, '--owner') || 'mission-lead',
      cadence: readValueFlag(args, '--cadence') || '',
      maxTicks,
      maxWallSeconds,
      noComplete: args.includes('--no-complete'),
    }, {
      cliPath: CLI_PATH,
      onProgress: (line) => console.log(`  ${line}`),
    });
    console.log(result.text || '');
    return result.ok ? 0 : 1;
  }

  const mission = pickRunnableMission(process.cwd(), null, {
    allowCallerSessionRunners: liveCodexSession(),
  });
  if (!mission) {
    console.log('No objective given and no runnable mission found.');
    const { printOperatorNext } = require('../lib/operator-next');
    printOperatorNext('atris run "<objective>" --owner navigator');
    return 1;
  }
  console.log(`Resuming mission ${mission.id} (${mission.status}): ${mission.objective}`);
  const result = spawnSync(process.execPath, [
    CLI_PATH, 'mission', 'run', mission.id,
    '--max-ticks', String(maxTicks),
    '--max-wall', String(maxWallSeconds),
    '--complete-on-pass',
  ], { cwd: process.cwd(), stdio: 'inherit' });
  return result.status || 0;
}

module.exports = {
  runMissionFront,
  pickRunnableMission,
  liveCodexSession,
  runnerDrivableForFrontDoor,
  runObjective,
  runBudgetSeconds,
  runTickBudget,
};
