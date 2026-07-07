/**
 * atris loops - project loop audit/scaffold plus legacy background loop board.
 *
 *   atris loops              - audit atris/loops in this project
 *   atris loops init         - scaffold the loop system into this project
 *   atris self-improve       - alias for atris loops init
 *   atris loops tick         - print the loop tick protocol
 *   atris loops board        - legacy board: registry jobs, launchd agents, mission
 *   atris loops stop <id>    - disable a registry job or boot out a launchd agent
 *   atris loops start <id>   - enable a registry job or kickstart a launchd agent
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const MAX_LOG_AGE_DAYS = 14;
const TEMPLATE_ROOT = path.join(__dirname, '..', 'templates', 'loops');
const SCAFFOLD_FILES = [
  'atris/loops/LOOPS.md',
  'atris/loops/TICK.md',
  'atris/loops/feedback.md',
  'atris/loops/quality.md',
  'atris/wiki/systems/loops.md',
];

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
  return 0;
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
    return 0;
  }
  const ok = setRegistryJob(target, action === 'start');
  if (!ok) {
    console.error(`No registry job named "${target}". Run: atris loops board`);
    process.exit(1);
  }
  console.log(`${action === 'stop' ? 'Disabled' : 'Enabled'} ${target} in the heartbeat registry (backup written).`);
  return 0;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function renderTemplate(text) {
  return text.split('{{DATE}}').join(todayIso());
}

function initLoops(cwd = process.cwd()) {
  const created = [];
  const skipped = [];

  for (const relPath of SCAFFOLD_FILES) {
    const source = path.join(TEMPLATE_ROOT, relPath);
    const target = path.join(cwd, relPath);
    if (fs.existsSync(target)) {
      skipped.push(relPath);
      continue;
    }
    const content = renderTemplate(fs.readFileSync(source, 'utf8'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
    created.push(relPath);
  }

  console.log('atris loops init');
  console.log('');
  console.log('created:');
  if (created.length) created.forEach(file => console.log(`  ${file}`));
  else console.log('  none');
  console.log('');
  console.log('skipped:');
  if (skipped.length) skipped.forEach(file => console.log(`  ${file}`));
  else console.log('  none');
  console.log('');
  console.log('Next: fill Owner/Wiki/Runner TODOs, then run atris loops audit');
  return 0;
}

function stripAnchor(linkTarget) {
  return String(linkTarget || '').split('#')[0];
}

function wikiTargetPath(loopFilePath, wikiLink) {
  const cleaned = stripAnchor(wikiLink);
  if (!cleaned || /^[a-z]+:\/\//i.test(cleaned)) return null;
  return path.resolve(path.dirname(loopFilePath), cleaned);
}

function checkCommandFrom(text) {
  return text.match(/\*\*Check:\*\*\s*`([^`]+)`/)?.[1]?.trim() || null;
}

function runLoopCheck(commandText, cwd) {
  const result = spawnSync(commandText, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: 240000,
  });
  return {
    command: commandText,
    exitCode: typeof result.status === 'number' ? result.status : 1,
    error: result.error ? result.error.message : null,
  };
}

function structuralProblems({ root, filePath, text, nowMs }) {
  const problems = [];

  const owner = text.match(/\*\*Owner:\*\*\s*`team\/([^`]+)`/)?.[1]?.trim();
  if (!owner) problems.push('no Owner field');
  else if (!fs.existsSync(path.join(root, 'team', owner))) problems.push(`owner team/${owner} does not exist`);

  const wiki = text.match(/\*\*Wiki:\*\*\s*\[[^\]]+\]\(([^)]+)\)/)?.[1]?.trim();
  if (!wiki) {
    problems.push('no Wiki field');
  } else {
    const wikiPath = wikiTargetPath(filePath, wiki);
    if (!wikiPath || !fs.existsSync(wikiPath)) problems.push(`wiki page ${wiki} missing`);
  }

  if (!/\*\*Runner:\*\*\s*\S/.test(text)) problems.push('no Runner field');
  if (!/\*\*Protects:\*\*/.test(text)) problems.push('no Protects field');
  if (!/\*\*Signal/.test(text)) problems.push('no Signal field');
  if (!/\*\*Cadence:\*\*/.test(text)) problems.push('no Cadence field');

  const logDates = [...text.matchAll(/^- (\d{4}-\d{2}-\d{2}):/gm)].map(match => match[1]).sort();
  if (logDates.length === 0) {
    problems.push('no dated Log entries');
  } else {
    const newest = logDates[logDates.length - 1];
    const ageDays = (nowMs - Date.parse(`${newest}T00:00:00Z`)) / 86400000;
    if (ageDays > MAX_LOG_AGE_DAYS) problems.push(`log stale: newest ${newest}`);
  }

  return { owner, problems };
}

function auditLoops(cwd = process.cwd()) {
  const loopsDir = path.join(cwd, 'atris', 'loops');
  if (!fs.existsSync(loopsDir)) {
    console.log('No atris/loops directory found.');
    console.log('Run: atris loops init');
    console.log('');
    console.log('SELF-IMPROVING: NOT YET — 1 open');
    return 1;
  }

  const files = fs.readdirSync(loopsDir)
    .filter(file => file.endsWith('.md') && file !== 'LOOPS.md' && file !== 'TICK.md')
    .sort();

  if (!files.length) {
    console.log('No loop files found in atris/loops.');
    console.log('Run: atris loops init');
    console.log('');
    console.log('SELF-IMPROVING: NOT YET — 1 open');
    return 1;
  }

  console.log('atris loops audit');
  console.log('');

  let open = 0;
  const nowMs = Date.now();
  for (const file of files) {
    const filePath = path.join(loopsDir, file);
    const text = fs.readFileSync(filePath, 'utf8');
    const { problems } = structuralProblems({ root: cwd, filePath, text, nowMs });
    const checkCommand = checkCommandFrom(text);
    const check = checkCommand ? runLoopCheck(checkCommand, cwd) : null;
    if (check && check.exitCode !== 0) problems.push(`check failed: exit ${check.exitCode}`);

    if (problems.length) open += 1;
    const loopName = file.replace(/\.md$/, '');
    console.log(`${problems.length ? '❌' : '✅'} ${loopName}`);
    for (const problem of problems) console.log(`   ↳ ${problem}`);
    if (check) {
      const errorSuffix = check.error ? ` (${check.error})` : '';
      console.log(`   ↳ check: \`${check.command}\` exit ${check.exitCode}${errorSuffix}`);
    }
  }

  console.log('');
  if (open === 0) {
    console.log('SELF-IMPROVING: YES');
    return 0;
  }
  console.log(`SELF-IMPROVING: NOT YET — ${open} open`);
  return 1;
}

function tickLoops(cwd = process.cwd()) {
  const localTick = path.join(cwd, 'atris', 'loops', 'TICK.md');
  const packagedTick = path.join(TEMPLATE_ROOT, 'atris', 'loops', 'TICK.md');
  const source = fs.existsSync(localTick) ? localTick : packagedTick;
  console.log(fs.readFileSync(source, 'utf8').trimEnd());
  return 0;
}

function showLoopsHelp() {
  console.log('Usage: atris loops [audit|init|tick|board|start|stop]');
  console.log('');
  console.log('Self-improving loop commands:');
  console.log('  atris loops              - audit atris/loops in this project');
  console.log('  atris loops audit        - same audit explicitly');
  console.log('  atris loops init         - scaffold atris/loops + loop wiki');
  console.log('  atris self-improve       - alias for atris loops init');
  console.log('  atris loops tick         - print atris/loops/TICK.md protocol');
  console.log('');
  console.log('Background loop board:');
  console.log('  atris loops board        - registry jobs, launchd agents, mission');
  console.log('  atris loops stop <id>    - disable a registry job or stop a launchd agent');
  console.log('  atris loops start <id>   - enable a registry job or start a launchd agent');
  return 0;
}

function loopsCommand(subcommand, ...args) {
  switch (subcommand) {
    case undefined:
    case 'audit':
      return auditLoops(process.cwd());
    case 'init':
      return initLoops(process.cwd());
    case 'tick':
      return tickLoops(process.cwd());
    case 'board':
    case 'list':
      return showBoard(process.cwd());
    case 'stop':
      return controlLoop(args[0], 'stop');
    case 'start':
      return controlLoop(args[0], 'start');
    case 'help':
    case '--help':
    case '-h':
      return showLoopsHelp();
    default:
      return showLoopsHelp();
  }
}

module.exports = {
  loopsCommand,
  showBoard,
  initLoops,
  auditLoops,
  tickLoops,
  structuralProblems,
};
