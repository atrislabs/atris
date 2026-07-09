'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { startMission, listMissions } = require('./mission');

const CLI_PATH = path.join(__dirname, '..', 'bin', 'atris.js');
const VALID_EVERY = new Set(['15m', '1h', '4h']);
const VALID_NOTIFY = new Set(['journal', 'imessage']);
const TERMINAL_STATUSES = new Set(['stopped', 'complete']);
const DEFAULT_EVERY = '1h';
const DEFAULT_NOTIFY = 'journal';
const WATCH_OWNER = 'watcher';
const WATCH_LANE = 'watch';

function slugify(value) {
  return String(value || 'watch')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'watch';
}

function hasFlag(args, name) {
  return args.includes(name);
}

function unquote(value) {
  const text = String(value);
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function readFlag(args, name, fallback = '') {
  const prefix = `${name}=`;
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (arg === name && args[i + 1] && !String(args[i + 1]).startsWith('--')) return unquote(args[i + 1]);
    if (arg.startsWith(prefix)) return unquote(arg.slice(prefix.length));
  }
  return fallback;
}

function parseSentenceArgs(args) {
  const sentenceParts = [];
  let index = 0;
  while (index < args.length) {
    const arg = String(args[index]);
    if (arg.startsWith('--')) break;
    sentenceParts.push(arg);
    index += 1;
  }
  return {
    sentence: sentenceParts.join(' ').trim(),
    rest: args.slice(index),
  };
}

function watchStatePath(slug) {
  return `.atris/state/watch/${slug}.json`;
}

function buildWatchObjective(sentence, slug) {
  const statePath = watchStatePath(slug);
  return `Each tick: check ${sentence}, compare to last tick state under ${statePath}, report only meaningful changes`;
}

function notifyLabel(notify) {
  if (notify === 'imessage') return 'imessage when the pulse picks it up';
  return "today's journal under ## Notes";
}

function activeWatchMissions(root = process.cwd()) {
  return listMissions(root).filter((mission) => (
    mission.lane === WATCH_LANE && !TERMINAL_STATUSES.has(mission.status)
  ));
}

function watchName(mission) {
  return mission.metadata?.watch_slug || mission.slug || mission.id;
}

function resolveWatchMission(ref, root = process.cwd()) {
  const slug = slugify(ref);
  return activeWatchMissions(root).find((mission) => (
    watchName(mission) === slug || mission.slug === slug || mission.id === ref
  )) || null;
}

function formatLastTick(mission) {
  if (!mission.last_tick_at) return 'never';
  const ageMs = Date.now() - Date.parse(mission.last_tick_at);
  if (!Number.isFinite(ageMs) || ageMs < 0) return mission.last_tick_at;
  const minutes = Math.floor(ageMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatLastReport(mission) {
  const line = String(mission.last_tick_reason || mission.metadata?.last_report || '').trim();
  return line || 'none yet';
}

function padCell(value, width) {
  const text = String(value);
  if (text.length <= width) return text.padEnd(width);
  if (width <= 1) return text.slice(0, width);
  return `${text.slice(0, width - 1)}…`;
}

function printWatchTable(missions) {
  const rows = missions.map((mission) => ({
    name: watchName(mission),
    cadence: mission.cadence || DEFAULT_EVERY,
    lastTick: formatLastTick(mission),
    lastReport: formatLastReport(mission),
  }));
  const widths = {
    name: Math.max(4, ...rows.map((row) => row.name.length)),
    cadence: Math.max(7, ...rows.map((row) => row.cadence.length)),
    lastTick: Math.max(9, ...rows.map((row) => row.lastTick.length)),
    lastReport: Math.max(11, ...rows.map((row) => row.lastReport.length)),
  };
  console.log([
    padCell('name', widths.name),
    padCell('cadence', widths.cadence),
    padCell('last tick', widths.lastTick),
    padCell('last report', widths.lastReport),
  ].join('  '));
  for (const row of rows) {
    console.log([
      padCell(row.name, widths.name),
      padCell(row.cadence, widths.cadence),
      padCell(row.lastTick, widths.lastTick),
      padCell(row.lastReport, widths.lastReport),
    ].join('  '));
  }
}

function showWatchHelp() {
  console.log('');
  console.log('usage: atris watch "<sentence>" [--every 15m|1h|4h] [--name <slug>] [--notify imessage|journal]');
  console.log('       atris watch list');
  console.log('       atris watch stop <slug>');
  console.log('');
  console.log('turn one sentence into an always-on claude watch mission.');
  console.log('');
  console.log('options:');
  console.log('  --every cadence   how often to check (default 1h)');
  console.log('  --name slug       stable watch name (default derived from the sentence)');
  console.log('  --notify channel  journal (default) or imessage preference for the pulse');
  console.log('');
  console.log('looking for the old file-sync watcher? use: atris sync --watch');
  console.log('');
}

function createWatch(args, cwd = process.cwd()) {
  const { sentence, rest } = parseSentenceArgs(args);
  if (!sentence) {
    console.error('usage: atris watch "<sentence>" [--every 15m|1h|4h] [--name <slug>] [--notify imessage|journal]');
    return 2;
  }

  const slug = slugify(readFlag(rest, '--name', '') || sentence);
  const every = readFlag(rest, '--every', DEFAULT_EVERY) || DEFAULT_EVERY;
  const notify = readFlag(rest, '--notify', DEFAULT_NOTIFY) || DEFAULT_NOTIFY;

  if (!VALID_EVERY.has(every)) {
    console.error(`--every must be one of: ${Array.from(VALID_EVERY).join(', ')}`);
    return 2;
  }
  if (!VALID_NOTIFY.has(notify)) {
    console.error(`--notify must be one of: ${Array.from(VALID_NOTIFY).join(', ')}`);
    return 2;
  }

  const stateRel = watchStatePath(slug);
  fs.mkdirSync(path.join(cwd, path.dirname(stateRel)), { recursive: true });

  const objective = buildWatchObjective(sentence, slug);
  const startArgs = [
    objective,
    '--owner', WATCH_OWNER,
    '--lane', WATCH_LANE,
    '--runner', 'claude',
    '--cadence', every,
    '--always-on',
    '--no-verify',
    '--stop', 'owner stops the watch',
  ];

  const previousCwd = process.cwd();
  process.chdir(cwd);
  try {
    startMission(startArgs, {
      silent: true,
      missionPatch: {
        slug,
        metadata: {
          watch: true,
          watch_slug: slug,
          watch_sentence: sentence,
          watch_state_path: stateRel,
          notify,
        },
      },
    });
  } finally {
    process.chdir(previousCwd);
  }

  console.log(`watching ${sentence} every ${every}.`);
  console.log(`reports land in ${notifyLabel(notify)}.`);
  console.log(`state file: ${stateRel}`);
  console.log(`stop with: atris watch stop ${slug}`);
  return 0;
}

function listWatch(cwd = process.cwd()) {
  const missions = activeWatchMissions(cwd);
  if (!missions.length) {
    console.log('no active watches.');
    return 0;
  }
  printWatchTable(missions);
  return 0;
}

function stopWatch(ref, cwd = process.cwd()) {
  const slug = slugify(ref);
  if (!slug) {
    console.error('usage: atris watch stop <slug>');
    return 2;
  }
  const mission = resolveWatchMission(slug, cwd);
  if (!mission) {
    console.error(`no active watch named "${slug}".`);
    return 1;
  }

  const result = spawnSync(process.execPath, [
    CLI_PATH,
    'mission',
    'stop',
    mission.id,
    '--reason',
    'owner stops the watch',
    '--json',
  ], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ATRIS_SKIP_UPDATE_CHECK: '1',
    },
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const message = String(result.stderr || result.stdout || '').trim();
    console.error(message || `failed to stop watch "${slug}".`);
    return result.status || 1;
  }

  console.log(`stopped watch ${slug}.`);
  return 0;
}

function watchCommand(args = [], cwd = process.cwd()) {
  if (hasFlag(args, '--help') || hasFlag(args, '-h') || args[0] === 'help') {
    showWatchHelp();
    return 0;
  }

  const subcommand = String(args[0] || '').trim().toLowerCase();
  if (subcommand === 'list') return listWatch(cwd);
  if (subcommand === 'stop') return stopWatch(args[1], cwd);

  return createWatch(args, cwd);
}

function watchAtris() {
  const code = watchCommand(process.argv.slice(3), process.cwd());
  process.exit(code);
}

module.exports = {
  watchAtris,
  watchCommand,
  showWatchHelp,
  slugify,
  buildWatchObjective,
  activeWatchMissions,
  resolveWatchMission,
  watchStatePath,
};
