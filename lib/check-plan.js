'use strict';

// atris check, part one: read a project's check map and pick checks by rule.
//
// Plain rules, no model, no learning. Given the files a change touches:
//   1. every check whose `when` globs match a changed file runs;
//   2. every check marked `always` runs;
//   3. a changed file on a high risk path (money, sign-in, security, release)
//      adds every check that guards that risk plus the whole `release` gate;
//   4. a changed file no glob in the map knows adds the `default` set, and is
//      listed as unmapped so the map gets fixed. Unknown files widen, never narrow.
// Every pick carries its reason, so a person can read why each check ran.

const fs = require('fs');
const path = require('path');

const MAP_PATH = path.join('atris', 'checks.json');
const WHERE = ['here', 'no-screen', 'paid'];
const RISK_KINDS = ['money', 'sign-in', 'access', 'security', 'release', 'data'];
// High risk in every project, whatever its map says: the map itself (changing
// it changes what gets checked), lockfiles, and database migrations.
const BUILTIN_HIGH = {
  security: ['atris/checks.json'],
  release: ['**/package-lock.json', '**/npm-shrinkwrap.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/poetry.lock', '**/Pipfile.lock', '**/uv.lock', '**/Cargo.lock', '**/go.sum'],
  data: ['**/migrations/**'],
};
const TIERS = ['low', 'normal', 'high'];
// The line obelisk's app-opening checks print when they skip themselves on a
// person's Mac (scripts/lib/launches-app.cjs SKIP_PHRASE). Output carrying a
// skip line means the check did not run here, whatever its exit code.
const DEFAULT_SKIP_LINES = ['skipped on this Mac: opens the app; runs in the no-screen lane'];

class CheckMapError extends Error {}

// Globs match the whole path from the repo root. `*` stays inside one folder,
// `**/` spans any number of folders, `?` is one character, `{a,b}` is either,
// and a glob ending in `/` means everything under that folder.
function globToRegExp(glob) {
  let text = String(glob || '').trim().replace(/^\.\//, '');
  if (text.endsWith('/')) text += '**';
  return new RegExp(`^${globBody(text)}$`);
}

function globBody(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '*') {
      if (text[i + 1] === '*') {
        if (text[i + 2] === '/') { out += '(?:.*/)?'; i += 2; } else { out += '.*'; i += 1; }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if (ch === '{') {
      const close = text.indexOf('}', i);
      if (close === -1) { out += '\\{'; continue; }
      const options = text.slice(i + 1, close).split(',').map(globBody);
      out += `(?:${options.join('|')})`;
      i = close;
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return out;
}

function globsMatch(globs, file) {
  return (globs || []).some((glob) => globToRegExp(glob).test(file));
}

function firstMatch(globs, files) {
  return files.find((file) => globsMatch(globs, file)) || null;
}

function asList(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

// One command per check. A chain hides which half failed and lets the second
// half run on a broken first half, so the map refuses it.
function chainIn(command) {
  let quote = '';
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') return two;
    if (ch === ';') return ';';
  }
  return '';
}

function validateMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CheckMapError('atris/checks.json must be one JSON object');
  const checks = raw.checks;
  if (!checks || typeof checks !== 'object' || Array.isArray(checks) || !Object.keys(checks).length) {
    throw new CheckMapError('atris/checks.json needs a "checks" object with at least one named check');
  }
  const map = {
    version: raw.version || 1,
    checks: {},
    risk: { low: asList(raw.risk && raw.risk.low), normal: asList(raw.risk && raw.risk.normal), high: {} },
    gates: {},
    default: asList(raw.default),
    skipLines: raw.skip_lines ? asList(raw.skip_lines) : DEFAULT_SKIP_LINES.slice(),
    parallel: Number.isInteger(raw.parallel) && raw.parallel > 0 ? raw.parallel : 4,
  };
  for (const [name, spec] of Object.entries(checks)) {
    if (!spec || typeof spec !== 'object') throw new CheckMapError(`check "${name}" must be an object`);
    const run = String(spec.run || '').trim();
    if (!run) throw new CheckMapError(`check "${name}" has no "run" command`);
    const chain = chainIn(run);
    if (chain) throw new CheckMapError(`check "${name}" chains commands with "${chain}"; give each command its own check`);
    const where = spec.where || 'here';
    if (!WHERE.includes(where)) throw new CheckMapError(`check "${name}" has where "${where}"; use one of ${WHERE.join(', ')}`);
    if (spec.risk && !RISK_KINDS.includes(spec.risk)) throw new CheckMapError(`check "${name}" guards risk "${spec.risk}"; use one of ${RISK_KINDS.join(', ')}`);
    if (spec.each && !run.includes('{file}')) throw new CheckMapError(`check "${name}" runs once per file ("each"), so its run needs {file}`);
    const seconds = Number(spec.seconds);
    map.checks[name] = {
      name,
      run,
      // A check that truly needs the desktop app never runs here: the cage
      // sets ELECTRON_RUN_AS_NODE=1 for here checks, which changes how Electron starts.
      where: spec.needsElectron === true ? 'no-screen' : where,
      needsElectron: spec.needsElectron === true,
      port: spec.port === true,
      when: asList(spec.when),
      always: spec.always === true,
      risk: spec.risk || null,
      seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : null,
      timeoutSeconds: Number.isFinite(Number(spec.timeout_seconds)) && Number(spec.timeout_seconds) > 0 ? Number(spec.timeout_seconds) : null,
      each: spec.each ? asList(spec.each) : null,
      namesChanged: spec.names_changed ? {
        of: asList(spec.names_changed.of),
        except: asList(spec.names_changed.except),
      } : null,
      confirm: spec.confirm ? String(spec.confirm) : '',
    };
  }
  const high = (raw.risk && raw.risk.high) || {};
  if (typeof high !== 'object' || Array.isArray(high)) throw new CheckMapError('risk.high must name each risk, like {"sign-in": ["src/auth/**"]}');
  for (const [kind, globs] of Object.entries(high)) {
    if (!RISK_KINDS.includes(kind)) throw new CheckMapError(`risk.high has "${kind}"; use one of ${RISK_KINDS.join(', ')}`);
    map.risk.high[kind] = asList(globs);
  }
  for (const [kind, globs] of Object.entries(BUILTIN_HIGH)) map.risk.high[kind] = [...new Set([...(map.risk.high[kind] || []), ...globs])];
  const push = raw.push || {};
  map.push = {
    update: push.update === 'merge' ? 'merge' : 'rebase',
    via: push.via ? String(push.via) : '',
    laneStatus: push.lane_status ? String(push.lane_status) : '',
    aheadOfLane: push.low_risk_ahead_of_lane === true,
    maxFiles: Number.isInteger(push.max_files) ? push.max_files : 5,
    maxLines: Number.isInteger(push.max_lines) ? push.max_lines : 200,
  };
  const proof = raw.proof || {};
  map.proof = {
    coverageFloor: Number.isFinite(Number(proof.coverage_floor)) && proof.coverage_floor !== undefined ? Number(proof.coverage_floor) : null,
  };
  // Entry files that import nearly everything (an app's root component). Counting
  // them as importers would pick their checks for every change, so a map can say no.
  map.importersExcept = asList(raw.importers_except);
  map.secretScan = raw.secret_scan ? String(raw.secret_scan) : '';
  if (map.secretScan && chainIn(map.secretScan)) throw new CheckMapError('secret_scan must be one command');
  for (const [gate, names] of Object.entries(raw.gates || {})) {
    map.gates[gate] = asList(names);
    for (const name of map.gates[gate]) if (!map.checks[name]) throw new CheckMapError(`gate "${gate}" names "${name}", which is not a check`);
  }
  for (const name of map.default) if (!map.checks[name]) throw new CheckMapError(`default names "${name}", which is not a check`);
  return map;
}

function loadMap(root) {
  const file = path.join(root, MAP_PATH);
  if (!fs.existsSync(file)) return null;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new CheckMapError(`atris/checks.json is not valid JSON: ${error.message}`);
  }
  return validateMap(raw);
}

// Where a file run by an "each" check must run, from what it says in its first
// 20 lines. A marker can only move a check off this machine, never onto it.
//   launches: app            -> no-screen (it opens the desktop app)
//   launches: app (with ...) or (after ...)   -> here (it guards its own launch)
//   spends: <not nothing>    -> paid
function whereFromMarkers(source, fallback) {
  const head = String(source || '').split('\n').slice(0, 20).join('\n');
  const spends = head.match(/^\s*(?:\/\/|\*|#)\s*spends:\s*(\S+)/m);
  if (spends && spends[1].toLowerCase() !== 'nothing') return 'paid';
  const launches = head.match(/^\s*(?:\/\/|\*|#)\s*launches:\s*app(?:\s*\(([^)\n]*)\))?/m);
  if (launches && !/^(?:with|after) /.test(launches[1] || '')) return 'no-screen';
  return fallback;
}

function fileTier(map, file) {
  const kinds = Object.entries(map.risk.high).filter(([, globs]) => globsMatch(globs, file)).map(([kind]) => kind);
  if (kinds.length) return { tier: 'high', kinds };
  if (globsMatch(map.risk.normal, file)) return { tier: 'normal', kinds: [] };
  if (globsMatch(map.risk.low, file)) return { tier: 'low', kinds: [] };
  return { tier: 'normal', kinds: [] };
}

function fileIsMapped(map, file) {
  if (globsMatch(map.risk.low, file) || globsMatch(map.risk.normal, file)) return true;
  if (Object.values(map.risk.high).some((globs) => globsMatch(globs, file))) return true;
  return Object.values(map.checks).some((check) => globsMatch(check.when, file)
    || (check.each && globsMatch(check.each, file))
    || (check.namesChanged && globsMatch(check.namesChanged.of, file)));
}

function shellQuote(value) {
  return /^[A-Za-z0-9_./@:=+-]+$/.test(value) ? value : `'${String(value).replace(/'/g, "'\\''")}'`;
}

// Expand an "each" check into one run per file: a candidate runs when it was
// changed itself, or (names_changed) when its text names a changed file. This
// is the same rule obelisk's ship script uses to find focused tests.
function expandEach(check, changed, options) {
  const listFiles = options.listFiles || (() => []);
  const readFile = options.readFile || (() => '');
  const candidates = listFiles().filter((file) => globsMatch(check.each, file));
  const picks = new Map();
  for (const file of changed) {
    if (candidates.includes(file)) picks.set(file, `path-match: ${file}`);
  }
  if (check.namesChanged) {
    const needles = changed
      .filter((file) => globsMatch(check.namesChanged.of, file) && !globsMatch(check.namesChanged.except, file))
      .map((file) => ({ file, needle: file.replace(/\.[A-Za-z0-9]+$/, '') }));
    if (needles.length) {
      for (const candidate of candidates) {
        if (picks.has(candidate)) continue;
        const source = readFile(candidate);
        const hit = needles.find(({ needle }) => source.includes(needle) || source.includes(`${path.basename(needle)}.`));
        if (hit) picks.set(candidate, `names-changed: ${hit.file}`);
      }
    }
  }
  return [...picks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([file, reason]) => ({
    key: `${check.name} ${file}`,
    name: check.name,
    file,
    run: check.run.split('{file}').join(shellQuote(file)),
    where: whereFromMarkers(readFile(file), check.where),
    reasons: [reason],
    seconds: check.seconds,
    timeoutSeconds: check.timeoutSeconds,
    port: check.port,
    needsElectron: check.needsElectron,
  }));
}

// The plan: which checks run for these changed files, and why.
// options.gate picks a whole named gate instead (for a release).
// options.importers: Map of changed file -> files that import it (one hop).
// Those importers count as touched for globs and risk, never as unmapped.
// options.unreadable: changed code files whose imports could not be read; they widen.
function planChecks(map, changedFiles, options = {}) {
  const changed = [...new Set(changedFiles)].sort();
  const importedBy = new Map();
  for (const [file, list] of (options.importers || new Map())) {
    for (const importer of list || []) {
      if (changed.includes(importer) || importedBy.has(importer) || globsMatch(map.importersExcept, importer)) continue;
      importedBy.set(importer, file);
    }
  }
  const files = changed.map((file) => ({ path: file, ...fileTier(map, file), mapped: fileIsMapped(map, file) && !(options.unreadable || []).includes(file) }));
  const via = [...importedBy.keys()].sort().map((file) => ({ path: file, ...fileTier(map, file), imports: importedBy.get(file) }));
  const touched = [...changed, ...via.map((file) => file.path)];
  const tier = [...files, ...via].reduce((best, file) => (TIERS.indexOf(file.tier) > TIERS.indexOf(best) ? file.tier : best), 'low');
  const highKinds = [...new Set([...files, ...via].flatMap((file) => file.kinds))].sort();
  const unmapped = files.filter((file) => !file.mapped).map((file) => file.path);
  const label = (file) => (importedBy.has(file) ? `${file} imports ${importedBy.get(file)}` : file);
  const picks = new Map();
  const pick = (name, reason) => {
    const check = map.checks[name];
    if (!check || check.each) return;
    if (!picks.has(name)) {
      picks.set(name, {
        key: name, name, file: null, run: check.run, where: check.where, reasons: [],
        seconds: check.seconds, timeoutSeconds: check.timeoutSeconds, port: check.port, needsElectron: check.needsElectron,
      });
    }
    const entry = picks.get(name);
    if (!entry.reasons.includes(reason)) entry.reasons.push(reason);
  };

  if (options.gate) {
    if (!map.gates[options.gate]) throw new CheckMapError(`no gate named "${options.gate}" in atris/checks.json`);
    for (const name of map.gates[options.gate]) pick(name, `gate: ${options.gate}`);
  } else {
    for (const check of Object.values(map.checks)) {
      if (check.each) continue;
      const hit = firstMatch(check.when, changed) || firstMatch(check.when, touched);
      if (hit) {
        const more = touched.filter((file) => globsMatch(check.when, file)).length - 1;
        const kind = importedBy.has(hit) ? 'import-match' : 'path-match';
        pick(check.name, `${kind}: ${label(hit)}${more > 0 ? ` (+${more} more)` : ''}`);
      }
      if (check.always) pick(check.name, 'always');
    }
    for (const kind of highKinds) {
      for (const check of Object.values(map.checks)) if (check.risk === kind) pick(check.name, `high-risk: ${kind}`);
    }
    if (highKinds.length) for (const name of map.gates.release || []) pick(name, `release gate (high-risk: ${highKinds.join(', ')})`);
    if (unmapped.length) {
      for (const name of map.default) pick(name, `unmapped: ${unmapped[0]}${unmapped.length > 1 ? ` (+${unmapped.length - 1} more)` : ''}`);
    }
  }
  const selected = [...picks.values()];
  if (!options.gate) {
    for (const check of Object.values(map.checks)) if (check.each) selected.push(...expandEach(check, changed, options));
  }
  const pickedNames = new Set(selected.map((entry) => entry.name));
  const notPicked = Object.keys(map.checks).filter((name) => !pickedNames.has(name));
  const toConfirm = Object.values(map.checks).filter((check) => check.confirm).map((check) => check.name);
  return { files, importers: via, tier, highKinds, unmapped, selected, notPicked, toConfirm, gate: options.gate || null };
}

module.exports = {
  MAP_PATH,
  WHERE,
  CheckMapError,
  globToRegExp,
  validateMap,
  loadMap,
  whereFromMarkers,
  planChecks,
};
