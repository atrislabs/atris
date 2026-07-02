'use strict';

// atris engine: bring any intelligence.
// Every installed headless coding CLI is a swappable worker behind one
// contract (bounded prompt in, verified proof out, engines never
// self-certify). This command shows the roster, flips the default, and the
// same names ride --engine on mission run / autopilot / run.
//
//   atris engine            roster + current default
//   atris engine cursor     make cursor the default engine here
//   atris engine reset      back to the house default (atris-fast)
//
// The default persists to .atris/engine.json. Per-run flags and
// ATRIS_RUNNER_PROFILE always beat the file.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  RUNNER_PROFILE_DEFS,
  RUNNER_PROFILE_ALIASES,
  RUNNER_PROFILE_NAMES,
} = require('../lib/runner-command');

const HOUSE_ENGINE = 'atris-fast';

function engineFile(root = process.cwd()) {
  return path.join(root, '.atris', 'engine.json');
}

function binInstalled(bin) {
  const probe = spawnSync('command', ['-v', bin], { encoding: 'utf8', shell: true });
  return probe.status === 0 && Boolean(String(probe.stdout || '').trim());
}

function canonicalEngineName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return '';
  if (RUNNER_PROFILE_DEFS[trimmed]) return trimmed;
  if (RUNNER_PROFILE_ALIASES[trimmed]) return RUNNER_PROFILE_ALIASES[trimmed];
  return '';
}

function readSavedEngine(root = process.cwd()) {
  try {
    const saved = JSON.parse(fs.readFileSync(engineFile(root), 'utf8'));
    return canonicalEngineName(saved.default);
  } catch {
    return '';
  }
}

// The default engine for this workspace, in precedence order:
// env (per-run flags land here) -> .atris/engine.json -> house default.
// The house default is our own intelligence when it is installed.
function resolveDefaultEngine(root = process.cwd()) {
  const env = canonicalEngineName(process.env.ATRIS_RUNNER_PROFILE);
  if (env) return { name: env, source: 'env' };
  const saved = readSavedEngine(root);
  if (saved) return { name: saved, source: 'saved' };
  if (binInstalled(RUNNER_PROFILE_DEFS[HOUSE_ENGINE].bin)) return { name: HOUSE_ENGINE, source: 'house' };
  const fallback = RUNNER_PROFILE_NAMES.find((name) => binInstalled(RUNNER_PROFILE_DEFS[name].bin));
  return fallback ? { name: fallback, source: 'detected' } : { name: HOUSE_ENGINE, source: 'none' };
}

function roster(root = process.cwd()) {
  const current = resolveDefaultEngine(root);
  return RUNNER_PROFILE_NAMES.map((name) => ({
    name,
    bin: RUNNER_PROFILE_DEFS[name].bin,
    installed: binInstalled(RUNNER_PROFILE_DEFS[name].bin),
    default: name === current.name,
  }));
}

function setEngine(name, root = process.cwd()) {
  const canonical = canonicalEngineName(name);
  if (!canonical) {
    throw new Error(`Unknown engine "${name}". Known engines: ${RUNNER_PROFILE_NAMES.join(', ')}`);
  }
  const file = engineFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ default: canonical, set_at: new Date().toISOString() }, null, 2)}\n`);
  return canonical;
}

function resetEngine(root = process.cwd()) {
  try { fs.unlinkSync(engineFile(root)); return true; } catch { return false; }
}

function printRoster(root) {
  const list = roster(root);
  const found = list.filter((e) => e.installed).length;
  const current = resolveDefaultEngine(root);
  console.log('');
  console.log(`  engines — ${found} intelligence${found === 1 ? '' : 's'} found`);
  console.log('');
  for (const engine of list) {
    const mark = engine.default ? '→' : ' ';
    const state = engine.installed ? 'ready' : 'not installed';
    console.log(`  ${mark} ${engine.name.padEnd(12)} ${state}`);
  }
  console.log('');
  console.log(`  default: ${current.name}${current.source === 'saved' ? ' (set here)' : current.source === 'env' ? ' (this session)' : ''}`);
  console.log(`  switch:  atris engine <name>   ·   one run: --engine <name> on mission run / autopilot / run`);
  console.log('');
}

function engineCommand(args = []) {
  const json = args.includes('--json');
  const sub = (args.find((a) => !a.startsWith('--')) || '').trim();
  const root = process.cwd();

  if (!sub || sub === 'list' || sub === 'status') {
    if (json) {
      const current = resolveDefaultEngine(root);
      console.log(JSON.stringify({ engines: roster(root), default: current.name, source: current.source }, null, 2));
      return 0;
    }
    printRoster(root);
    return 0;
  }

  if (sub === 'reset' || sub === 'off') {
    const removed = resetEngine(root);
    console.log(removed
      ? `\n  default engine reset — back to ${resolveDefaultEngine(root).name}\n`
      : `\n  nothing to reset — no engine was set here\n`);
    return 0;
  }

  if (sub === 'help') {
    console.log('\n  atris engine            roster + current default\n  atris engine <name>     make that engine the default here\n  atris engine reset      back to the house default\n  --engine <name>         one run on that engine (mission run / autopilot / run)\n');
    return 0;
  }

  // atris engine <name> — flip the default.
  const canonical = setEngine(sub, root);
  const def = RUNNER_PROFILE_DEFS[canonical];
  const installed = binInstalled(def.bin);
  console.log('');
  console.log(`  default engine: ${canonical}`);
  if (!installed) console.log(`  heads up: its CLI (${def.bin}) is not installed here yet — runs will fail until it is.`);
  console.log(`  every mission run / autopilot / run tick now rides it. one-off: --engine <name>. undo: atris engine reset`);
  console.log('');
  return 0;
}

module.exports = {
  engineCommand,
  resolveDefaultEngine,
  canonicalEngineName,
  readSavedEngine,
  setEngine,
  resetEngine,
  roster,
  HOUSE_ENGINE,
};
