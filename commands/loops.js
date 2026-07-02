/**
 * atris loops - one view of every background loop: what runs, what died,
 * what you can start or stop.
 *
 *   atris loops              - the board (registry jobs, launchd agents, missions)
 *   atris loops stop <id>    - disable a registry job or boot out a launchd agent
 *   atris loops start <id>   - enable a registry job or kickstart a launchd agent
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

function heartbeatDir() {
  return process.env.ATRIS_HEARTBEAT_DIR || path.join(os.homedir(), '.atris', 'heartbeat');
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function registryPath() {
  return path.join(heartbeatDir(), 'registry.json');
}

function loadRegistry() {
  const registry = readJson(registryPath(), null);
  return registry && Array.isArray(registry.jobs) ? registry : { jobs: [] };
}

function loadRunState() {
  return readJson(path.join(heartbeatDir(), 'state.json'), {});
}

function agoText(iso) {
  const then = Date.parse(iso || '');
  if (!Number.isFinite(then)) return 'never';
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function listLaunchdAgents() {
  let raw = '';
  try {
    raw = execSync('launchctl list', { encoding: 'utf8', timeout: 10000 });
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter(line => line.includes('com.atris.'))
    .map(line => {
      const [pid, exitCode, label] = line.trim().split(/\s+/);
      return {
        label,
        running: pid !== '-',
        pid: pid !== '-' ? pid : null,
        lastExit: exitCode,
      };
    })
    .filter(agent => agent.label);
}

function workspaceMission(cwd) {
  const goalState = readJson(path.join(cwd, '.atris', 'state', 'atris_goal.json'), null);
  const goal = goalState && goalState.goal;
  if (!goal || !goal.objective) return null;
  const started = Date.parse(goal.created_at || '');
  const elapsedMins = Number.isFinite(started) ? Math.round((Date.now() - started) / 60000) : null;
  return {
    id: goal.mission_id || '?',
    status: goal.mission_status || '?',
    objective: String(goal.objective),
    elapsedMins,
  };
}

function showBoard(cwd) {
  const registry = loadRegistry();
  const state = loadRunState();

  console.log('background loops');
  console.log('');

  const enabled = registry.jobs.filter(job => job.enabled !== false && job.disabled !== true);
  const disabledCount = registry.jobs.length - enabled.length;
  console.log(`heartbeat registry (${enabled.length} live, ${disabledCount} retired)`);
  if (!enabled.length) {
    console.log('  none declared');
  }
  for (const job of enabled) {
    const run = state[job.id] || {};
    const fails = Number(run.consecutive_fails || 0);
    const health = fails > 2 ? `${fails} consecutive fails` : fails > 0 ? `${fails} recent fail${fails === 1 ? '' : 's'}` : 'healthy';
    const cadence = job.cadence_minutes >= 60 ? `${Math.round(job.cadence_minutes / 60)}h` : `${job.cadence_minutes}m`;
    console.log(`  ${String(job.id).padEnd(22)} every ${String(cadence).padEnd(5)} last ${agoText(run.last_run).padEnd(9)} ${health}`);
    console.log(`  ${''.padEnd(22)} ${String(job.purpose || '').slice(0, 84)}`);
  }
  console.log('');

  const agents = listLaunchdAgents();
  console.log(`launchd agents (${agents.length})`);
  for (const agent of agents) {
    const status = agent.running ? `running pid ${agent.pid}` : `loaded, last exit ${agent.lastExit}`;
    console.log(`  ${agent.label.padEnd(44)} ${status}`);
  }
  if (!agents.length) console.log('  none');
  console.log('');

  const mission = workspaceMission(cwd);
  console.log('mission (this workspace)');
  if (mission) {
    const elapsed = mission.elapsedMins === null ? '' : ` · ${mission.elapsedMins}m in`;
    console.log(`  ${mission.id}`);
    console.log(`  ${mission.status}${elapsed} · ${mission.objective.slice(0, 80)}`);
  } else {
    console.log('  none active');
  }
  console.log('');
  console.log('control: atris loops stop <id> · atris loops start <id>');
  console.log('ids: registry job id, or a com.atris.* launchd label');
}

function saveRegistry(registry) {
  const target = registryPath();
  fs.copyFileSync(target, `${target}.bak`);
  fs.writeFileSync(target, `${JSON.stringify(registry, null, 2)}\n`);
}

function setRegistryJob(id, enabled) {
  const registry = loadRegistry();
  const job = registry.jobs.find(row => row.id === id);
  if (!job) return false;
  job.enabled = enabled;
  if (enabled) {
    delete job.disabled;
    delete job.disabled_reason;
  } else {
    job.disabled = true;
    job.disabled_reason = `stopped via atris loops ${new Date().toISOString().slice(0, 10)}`;
  }
  saveRegistry(registry);
  return true;
}

function launchdControl(label, action) {
  const uid = process.getuid();
  if (action === 'stop') {
    const result = spawnSync('launchctl', ['bootout', `gui/${uid}/${label}`], { encoding: 'utf8' });
    return result.status === 0;
  }
  const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  if (!fs.existsSync(plist)) return false;
  const bootstrap = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, plist], { encoding: 'utf8' });
  if (bootstrap.status === 0) return true;
  const kick = spawnSync('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`], { encoding: 'utf8' });
  return kick.status === 0;
}

function controlLoop(id, action) {
  const target = String(id || '').trim();
  if (!target) {
    console.error(`Usage: atris loops ${action} <id>`);
    process.exit(1);
  }
  if (target.startsWith('com.atris.')) {
    const ok = launchdControl(target, action);
    if (!ok) {
      console.error(`Could not ${action} ${target}. Check: launchctl print gui/$(id -u)/${target}`);
      process.exit(1);
    }
    console.log(`${action === 'stop' ? 'Stopped' : 'Started'} ${target}.`);
    return;
  }
  const ok = setRegistryJob(target, action === 'start');
  if (!ok) {
    console.error(`No registry job named "${target}". Run: atris loops`);
    process.exit(1);
  }
  console.log(`${action === 'stop' ? 'Disabled' : 'Enabled'} ${target} in the heartbeat registry (backup written).`);
}

function loopsCommand(subcommand, ...args) {
  switch (subcommand) {
    case undefined:
    case 'board':
    case 'list':
      showBoard(process.cwd());
      break;
    case 'stop':
      controlLoop(args[0], 'stop');
      break;
    case 'start':
      controlLoop(args[0], 'start');
      break;
    default:
      console.log('Loop commands:');
      console.log('  atris loops              - board: registry jobs, launchd agents, mission');
      console.log('  atris loops stop <id>    - disable a registry job or stop a launchd agent');
      console.log('  atris loops start <id>   - enable a registry job or start a launchd agent');
  }
}

module.exports = { loopsCommand, showBoard };
