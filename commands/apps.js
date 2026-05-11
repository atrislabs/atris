const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function findAppsPackRoot(startDir = process.cwd()) {
  const explicit = process.env.ATRIS_APPS_PACK;
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (fs.existsSync(path.join(resolved, 'scripts', 'app_use.py'))) return resolved;
  }
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, 'atris', 'apps-pack');
    if (fs.existsSync(path.join(candidate, 'scripts', 'app_use.py'))) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function appsUsageLines() {
  return [
    'Usage: atris apps <command>',
    '',
    'Commands:',
    '  list [--json]                List available local apps',
    '  run <slug> [--lines N]       Run an app and print data/latest.md or --json status',
    '  owner <slug> [--json]        Show owner view: launch, usage, learning, next actions',
    '  status [--json]              Show local app health',
    '  queue                        Show app improvement queue',
    '  rate <slug> <up|down> [note] Record output feedback',
    '  smoke                        Run fresh-checkout smoke test',
    '  doctor [--strict]            Audit pack health, smoke, and source cleanliness',
    '  handoff [--json]             Print app operator checklist and receipt paths',
    '  overnight                    Run the bounded overnight app loop',
    '  overnight-install [--start]  Install bounded macOS LaunchAgent',
    '  overnight-agent [status|stop] Inspect or stop macOS LaunchAgent',
  ];
}

function printAppsHelp() {
  console.log('');
  for (const line of appsUsageLines()) console.log(line);
  console.log('');
}

function wantsJson(subcommand, rawArgs) {
  return subcommand === '--json' || rawArgs.includes('--json');
}

function normalizeInvocation(subcommand, rawArgs) {
  if (subcommand === '--json') {
    return { subcommand: 'list', rawArgs: ['--json', ...rawArgs] };
  }
  return { subcommand, rawArgs };
}

function exitAppsError(message, json, options = {}) {
  const payload = {
    ok: false,
    error: message,
    ...(options.extra || {}),
  };
  if (options.usage) payload.usage = appsUsageLines();
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.error(message);
    if (options.usage) printAppsHelp();
  }
  process.exit(options.code || 1);
}

function parseScalar(value) {
  const trimmed = value.trim();
  if (trimmed === '[]') return [];
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  const quoted = trimmed.match(/^"(.*)"$/) || trimmed.match(/^'(.*)'$/);
  return quoted ? quoted[1] : trimmed;
}

function readAppManifest(appDir) {
  const text = fs.readFileSync(path.join(appDir, 'APP.md'), 'utf8');
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  const manifest = {};
  if (!match) return manifest;
  let currentList = null;
  for (const line of match[1].split('\n')) {
    const listItem = line.match(/^\s+-\s+(.*)$/);
    if (listItem && currentList) {
      manifest[currentList].push(parseScalar(listItem[1]));
      continue;
    }
    if (/^\s+/.test(line)) {
      if (currentList && manifest[currentList].length === 0) delete manifest[currentList];
      currentList = null;
      continue;
    }
    const field = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!field) continue;
    const [, key, rawValue] = field;
    if (rawValue === '') {
      manifest[key] = [];
      currentList = key;
    } else {
      manifest[key] = parseScalar(rawValue);
      currentList = null;
    }
  }
  return manifest;
}

function listAppManifests(packRoot) {
  const appsDir = path.join(packRoot, 'apps');
  return fs.readdirSync(appsDir)
    .filter((name) => fs.existsSync(path.join(appsDir, name, 'APP.md')))
    .sort()
    .map((slug) => ({
      slug,
      path: path.join(appsDir, slug, 'APP.md'),
      latest_output: path.join(appsDir, slug, 'data', 'latest.md'),
      ...readAppManifest(path.join(appsDir, slug)),
    }));
}

function popOption(args, name, fallback = null) {
  const eqPrefix = `${name}=`;
  const eqIndex = args.findIndex((arg) => arg.startsWith(eqPrefix));
  if (eqIndex >= 0) {
    const value = args[eqIndex].slice(eqPrefix.length);
    args.splice(eqIndex, 1);
    return value || fallback;
  }
  const index = args.indexOf(name);
  if (index >= 0) {
    const value = args[index + 1];
    args.splice(index, value === undefined ? 1 : 2);
    return value || fallback;
  }
  return fallback;
}

function runPackScript(packRoot, script, args) {
  const result = spawnSync('python3', [script, ...args], {
    cwd: packRoot,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) {
    console.error(`✗ Failed to run python3 ${script}: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 0);
}

function appsCommand(subcommand, ...rawArgs) {
  const jsonRequested = wantsJson(subcommand, rawArgs);
  const normalized = normalizeInvocation(subcommand, rawArgs);
  subcommand = normalized.subcommand;
  rawArgs = normalized.rawArgs;

  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    printAppsHelp();
    return;
  }
  const packRoot = findAppsPackRoot();
  if (!packRoot) {
    if (jsonRequested) {
      exitAppsError('No Atris app pack found.', true, {
        extra: { expected: 'atris/apps-pack/ in this workspace, or ATRIS_APPS_PACK' },
      });
    }
    console.error('✗ No Atris app pack found.');
    console.error('  Expected atris/apps-pack/ in this workspace, or set ATRIS_APPS_PACK.');
    process.exit(1);
  }

  const args = [...rawArgs];
  const workspace = path.resolve(popOption(args, '--workspace', process.cwd()));
  const lines = popOption(args, '--lines', null);
  const note = popOption(args, '--note', null);
  const hours = popOption(args, '--hours', null);
  const intervalMinutes = popOption(args, '--interval-minutes', null);
  const maxCycles = popOption(args, '--max-cycles', null);
  const label = popOption(args, '--label', null);
  const python = popOption(args, '--python', null);
  const json = args.includes('--json');
  if (json) args.splice(args.indexOf('--json'), 1);
  const noRun = args.includes('--no-run');
  if (noRun) args.splice(args.indexOf('--no-run'), 1);

  if (subcommand === 'list') {
    if (json) {
      console.log(JSON.stringify({ pack: packRoot, apps: listAppManifests(packRoot) }, null, 2));
      process.exit(0);
    }
    runPackScript(packRoot, 'scripts/app_use.py', ['--list']);
  }
  if (subcommand === 'status') runPackScript(packRoot, 'scripts/app_status.py', json ? ['--json'] : []);
  if (subcommand === 'queue') runPackScript(packRoot, 'scripts/app_improvement_queue.py', []);
  if (subcommand === 'smoke') runPackScript(packRoot, 'scripts/install_smoke.py', []);
  if (subcommand === 'doctor') runPackScript(packRoot, 'scripts/install_smoke.py', []);
  if (subcommand === 'handoff') {
    const command = ['--workspace', workspace];
    if (json) command.push('--json');
    runPackScript(packRoot, 'scripts/app_operator_checklist.py', command);
  }
  if (subcommand === 'overnight') {
    const command = ['--workspace', workspace];
    if (hours) command.push('--hours', hours);
    if (intervalMinutes) command.push('--interval-minutes', intervalMinutes);
    if (maxCycles) command.push('--max-cycles', maxCycles);
    runPackScript(packRoot, 'scripts/app_overnight.py', command);
  }
  if (subcommand === 'overnight-install') {
    const command = ['--workspace', workspace];
    if (hours) command.push('--hours', hours);
    if (intervalMinutes) command.push('--interval-minutes', intervalMinutes);
    if (maxCycles) command.push('--max-cycles', maxCycles);
    if (label) command.push('--label', label);
    if (python) command.push('--python', python);
    if (args.includes('--start')) command.push('--start');
    if (args.includes('--dry-run')) command.push('--dry-run');
    runPackScript(packRoot, 'scripts/install_overnight_launch_agent.py', command);
  }
  if (subcommand === 'overnight-agent') {
    const command = [args.shift() || 'status'];
    if (label) command.push('--label', label);
    if (args.includes('--dry-run')) command.push('--dry-run');
    if (json) command.push('--json');
    runPackScript(packRoot, 'scripts/control_overnight_launch_agent.py', command);
  }
  if (subcommand === 'run') {
    const slug = args.shift();
    if (!slug) {
      exitAppsError('Usage: atris apps run <slug> [--workspace <path>] [--lines N]', json);
    }
    const command = [slug, '--workspace', workspace];
    if (lines) command.push('--lines', lines);
    if (json) command.push('--json');
    if (noRun) command.push('--no-run');
    runPackScript(packRoot, 'scripts/app_use.py', command);
  }
  if (subcommand === 'owner') {
    const slug = args.shift();
    if (!slug) {
      exitAppsError('Usage: atris apps owner <slug> [--workspace <path>] [--lines N]', json);
    }
    const command = [slug, '--workspace', workspace];
    if (lines) command.push('--lines', lines);
    if (json) command.push('--json');
    if (noRun) command.push('--no-run');
    runPackScript(packRoot, 'scripts/app_owner.py', command);
  }
  if (subcommand === 'rate') {
    const slug = args.shift();
    const rating = args.shift();
    const ratingNote = note || args.join(' ');
    if (!slug || !['up', 'down'].includes(rating)) {
      console.error('Usage: atris apps rate <slug> <up|down> [note]');
      process.exit(1);
    }
    runPackScript(packRoot, 'scripts/app_rate.py', [slug, rating, ratingNote || '']);
  }

  exitAppsError(`Unknown apps command: ${subcommand}`, json, { usage: true });
}

module.exports = {
  appsCommand,
  findAppsPackRoot,
  listAppManifests,
};
