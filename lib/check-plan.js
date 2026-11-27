'use strict';

// atris check, part one: read a project's check map and pick checks by rule.
//
// Plain rules, no model, no learning. The change gets one risk tier:
//   low     docs, wording, styles, tests, or code whose diff is only comments
//           and whitespace: only checks marked "tier": "low" run (and the key
//           scan). Never the gate.
//   normal  everything else: checks whose `when` globs match, fast `always`
//           checks, and selectors, which pick the few tests that cover the
//           change (lib/check-select.js). The full gate does not run here.
//   high    a file on a high risk path (money, sign-in, access, security,
//           release, data) or one that imports it: the selected tests first,
//           then every check that guards that risk plus the whole `release` gate.
// A changed file no glob in the map knows adds the `default` set, and is
// listed as unmapped so the map gets fixed. Unknown files widen, never narrow.
// Every pick carries its reason, so a person can read why each check ran.
// `always` is only for checks of 5 seconds or less; the map is refused otherwise.

const fs = require('fs');
const path = require('path');
const { globToRegExp, globsMatch, firstMatch } = require('./check-glob');
const select = require('./check-select');

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
// How long a change of each tier should take on a person's machine, in seconds.
const DEFAULT_BUDGET = { low: 5, normal: 20, high: 300 };
// `always` runs for every change, so it must be quick.
const ALWAYS_MAX_SECONDS = 5;
// Files tests are made of: a test, or a file in a tests folder.
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|spec)\/|(?:^|\/)test[-_][^/]*$|[._-](?:test|spec)\.[a-z]+$|_test\.py$/i;
const CONFTEST = /(?:^|\/)conftest\.py$/;
// The line obelisk's app-opening checks print when they skip themselves on a
// person's Mac (scripts/lib/launches-app.cjs SKIP_PHRASE). Output carrying a
// skip line means the check did not run here, whatever its exit code.
const DEFAULT_SKIP_LINES = ['skipped on this Mac: opens the app; runs in the no-screen lane'];

class CheckMapError extends Error {}

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

// Every problem in the map, as plain lines. validateMap refuses a map with any.
function mapProblems(raw) {
  const problems = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['atris/checks.json must be one JSON object'];
  const checks = raw.checks;
  if (!checks || typeof checks !== 'object' || Array.isArray(checks) || !Object.keys(checks).length) {
    return ['atris/checks.json needs a "checks" object with at least one named check'];
  }
  for (const [name, spec] of Object.entries(checks)) {
    if (!spec || typeof spec !== 'object') { problems.push(`check "${name}" must be an object`); continue; }
    const run = String(spec.run || '').trim();
    if (!run) { problems.push(`check "${name}" has no "run" command`); continue; }
    const chain = chainIn(run);
    if (chain) problems.push(`check "${name}" chains commands with "${chain}"; give each command its own check`);
    const where = spec.where || 'here';
    if (!WHERE.includes(where)) problems.push(`check "${name}" has where "${where}"; use one of ${WHERE.join(', ')}`);
    if (spec.risk && !RISK_KINDS.includes(spec.risk)) problems.push(`check "${name}" guards risk "${spec.risk}"; use one of ${RISK_KINDS.join(', ')}`);
    if (spec.tier !== undefined && !TIERS.includes(spec.tier)) problems.push(`check "${name}" has tier "${spec.tier}"; use one of ${TIERS.join(', ')}`);
    if (spec.each && !run.includes('{file}')) problems.push(`check "${name}" runs once per file ("each"), so its run needs {file}`);
    if (spec.always === true) {
      const seconds = Number(spec.seconds);
      if (spec.select) problems.push(`check "${name}" is a selector and always; a selector already runs for every change in its "when"`);
      else if (!(Number.isFinite(seconds) && seconds > 0)) problems.push(`check "${name}" is always but says no "seconds"; always is only for checks of ${ALWAYS_MAX_SECONDS}s or less, so say how long it takes`);
      else if (seconds > ALWAYS_MAX_SECONDS) problems.push(`check "${name}" is always but takes about ${seconds}s; always is only for checks of ${ALWAYS_MAX_SECONDS}s or less. Give it "when" globs, put it in the release gate (high risk runs it), or make it a selector`);
    }
    if (spec.select !== undefined) {
      if (!select.isKind(spec.select)) problems.push(`check "${name}" selects "${spec.select}"; use one of ${select.KINDS.join(', ')}`);
      if (!run.includes('{files}') && !run.includes('{file}')) problems.push(`check "${name}" is a selector, so its run needs {files} (one run for all picked tests) or {file} (one run each)`);
      if (!asList(spec.roots).length) problems.push(`check "${name}" is a selector and needs "roots": the folders or globs its tests live in`);
      if (spec.each) problems.push(`check "${name}" is a selector; drop "each"`);
      if (spec.fallback !== undefined) {
        const fallback = String(spec.fallback || '').trim();
        if (!fallback) problems.push(`check "${name}" has an empty fallback`);
        else if (checks[fallback]) { if (checks[fallback].select) problems.push(`check "${name}" falls back to "${fallback}", another selector; fall back to a full command`); } else if (raw.gates && raw.gates[fallback]) { /* a whole gate */ } else if (chainIn(fallback)) problems.push(`check "${name}" has a fallback that chains commands; make it one command or name a check`);
      } else {
        problems.push(`check "${name}" is a selector with no "fallback"; name the full check to run when no test covers a file`);
      }
      if (spec.cwd !== undefined && (path.isAbsolute(String(spec.cwd)) || String(spec.cwd).split('/').includes('..'))) problems.push(`check "${name}" has cwd "${spec.cwd}"; use a folder inside the repo`);
      if (spec.max !== undefined && !(Number.isInteger(spec.max) && spec.max > 0)) problems.push(`check "${name}" has max ${spec.max}; use a whole number above 0`);
    }
    if (spec.env !== undefined && (typeof spec.env !== 'object' || Array.isArray(spec.env) || Object.values(spec.env).some((value) => typeof value !== 'string'))) {
      problems.push(`check "${name}" has env that is not an object of text values`);
    }
  }
  const high = (raw.risk && raw.risk.high) || {};
  if (typeof high !== 'object' || Array.isArray(high)) problems.push('risk.high must name each risk, like {"sign-in": ["src/auth/**"]}');
  else for (const kind of Object.keys(high)) if (!RISK_KINDS.includes(kind)) problems.push(`risk.high has "${kind}"; use one of ${RISK_KINDS.join(', ')}`);
  for (const [gate, names] of Object.entries(raw.gates || {})) {
    for (const name of asList(names)) if (!checks[name]) problems.push(`gate "${gate}" names "${name}", which is not a check`);
  }
  for (const name of asList(raw.default)) if (!checks[name]) problems.push(`default names "${name}", which is not a check`);
  for (const name of asList(raw.normal_needs_lane)) if (!checks[name]) problems.push(`normal_needs_lane names "${name}", which is not a check`);
  if (raw.secret_scan && chainIn(String(raw.secret_scan))) problems.push('secret_scan must be one command');
  if (raw.big !== undefined && !(Array.isArray(raw.big) && raw.big.every((glob) => typeof glob === 'string' && glob.trim()))) problems.push('big must be a list of path globs, like ["src/auth/**", "**/migrations/**"]');
  if (raw.owner_notice !== undefined && !['feed', 'none'].includes(raw.owner_notice)) problems.push('owner_notice is "feed" (the default) or "none"');
  if (raw.budget !== undefined) {
    if (!raw.budget || typeof raw.budget !== 'object') problems.push('budget must be like {"low": 5, "normal": 20, "high": 300}');
    else for (const [tier, value] of Object.entries(raw.budget)) {
      if (!TIERS.includes(tier)) problems.push(`budget has "${tier}"; use ${TIERS.join(', ')}`);
      else if (!(Number(value) > 0)) problems.push(`budget.${tier} must be seconds above 0`);
    }
  }
  const limit = require('./waiting-pile').limitProblem(raw);
  if (limit) problems.push(limit);
  if (raw.owners !== undefined && (!raw.owners || typeof raw.owners !== 'object' || Array.isArray(raw.owners))) problems.push('owners must be like {"src/billing/**": ["tests/test_billing.py"]}');
  return problems;
}

function validateMap(raw) {
  const problems = mapProblems(raw);
  if (problems.length) throw new CheckMapError(problems.length === 1 ? problems[0] : `atris/checks.json has ${problems.length} problems:\n  ${problems.join('\n  ')}`);
  const checks = raw.checks;
  const map = {
    version: raw.version || 1,
    checks: {},
    risk: { low: asList(raw.risk && raw.risk.low), normal: asList(raw.risk && raw.risk.normal), high: {} },
    gates: {},
    default: asList(raw.default),
    skipLines: raw.skip_lines ? asList(raw.skip_lines) : DEFAULT_SKIP_LINES.slice(),
    parallel: Number.isInteger(raw.parallel) && raw.parallel > 0 ? raw.parallel : 4,
    budget: { ...DEFAULT_BUDGET },
    normalNeedsLane: asList(raw.normal_needs_lane),
    owners: Object.entries(raw.owners || {}).map(([glob, tests]) => ({ glob, tests: asList(tests) })),
  };
  for (const [tier, value] of Object.entries(raw.budget || {})) map.budget[tier] = Number(value);
  for (const [name, spec] of Object.entries(checks)) {
    const run = String(spec.run || '').trim();
    const where = spec.where || 'here';
    const seconds = Number(spec.seconds);
    map.checks[name] = {
      name,
      run,
      // A check that truly needs the desktop app never runs here: the cage
      // sets ELECTRON_RUN_AS_NODE=1 for here checks, which changes how Electron starts.
      where: spec.needsElectron === true ? 'no-screen' : where,
      needsElectron: spec.needsElectron === true,
      // Runs the project's whole suite, so it may stand in as a fallback.
      full: spec.full === true,
      port: spec.port === true,
      when: asList(spec.when),
      always: spec.always === true,
      risk: spec.risk || null,
      tier: spec.tier || null,
      seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : null,
      timeoutSeconds: Number.isFinite(Number(spec.timeout_seconds)) && Number(spec.timeout_seconds) > 0 ? Number(spec.timeout_seconds) : null,
      each: spec.each ? asList(spec.each) : null,
      namesChanged: spec.names_changed ? {
        of: asList(spec.names_changed.of),
        except: asList(spec.names_changed.except),
      } : null,
      confirm: spec.confirm ? String(spec.confirm) : '',
      cwd: spec.cwd ? String(spec.cwd).replace(/^\.\//, '').replace(/\/+$/, '') : '',
      env: spec.env ? { ...spec.env } : null,
      select: spec.select || null,
      roots: asList(spec.roots),
      max: Number.isInteger(spec.max) && spec.max > 0 ? spec.max : 40,
      fallback: spec.fallback ? String(spec.fallback).trim() : '',
      python: spec.python ? String(spec.python) : '',
      perTestSeconds: Number(spec.per_test_seconds) > 0 ? Number(spec.per_test_seconds) : null,
      parallelMin: Number.isInteger(spec.parallel_min) && spec.parallel_min > 0 ? spec.parallel_min : 4,
      hubTests: Number.isInteger(spec.hub_tests) && spec.hub_tests > 0 ? spec.hub_tests : null,
    };
  }
  const high = (raw.risk && raw.risk.high) || {};
  for (const [kind, globs] of Object.entries(high)) map.risk.high[kind] = asList(globs);
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
  // Files touched by nearly every change and named by hundreds of tests (an
  // app's main file). Their tests are found by the names the change touches
  // (the functions it edits), not by the file's name.
  map.broad = asList(raw.broad);
  map.secretScan = raw.secret_scan ? String(raw.secret_scan) : '';
  // Paths where a failure is a big bug (atris check fix): no default, the map says.
  map.big = asList(raw.big);
  map.ownerNotice = raw.owner_notice === 'none' ? 'none' : 'feed';
  for (const [gate, names] of Object.entries(raw.gates || {})) map.gates[gate] = asList(names);
  return map;
}

// `atris check --lint-map`: every problem, plus warnings that do not refuse the map.
function lintMap(raw, { durations = null } = {}) {
  const errors = mapProblems(raw);
  const warnings = [];
  if (!errors.length) {
    for (const [name, spec] of Object.entries(raw.checks)) {
      const measured = durations && durations(name);
      if (spec.always === true && measured && measured > ALWAYS_MAX_SECONDS) warnings.push(`check "${name}" is always and says ${spec.seconds}s, but it has taken about ${Math.round(measured)}s here; give it "when" globs or make it faster`);
      if (spec.confirm) warnings.push(`check "${name}" still has a confirm note from init`);
    }
    const map = validateMap(raw);
    for (const check of Object.values(map.checks)) {
      if (check.select && check.fallback && !fallbackIsFull(map, check.fallback)) {
        warnings.push(`check "${check.name}" falls back to ${map.checks[check.fallback] ? `"${check.fallback}", which is not in the release gate and not marked "full": true` : `the command "${check.fallback}"`}: that runs only part of the tests, so a change that falls back is never proven. Name the release gate, a check in it, or a check marked "full": true`);
      }
      if (check.select && map.checks[check.fallback] && !map.checks[check.fallback].seconds) {
        warnings.push(`check "${check.name}" falls back to "${check.fallback}", which says no "seconds"; plans and replay count it as 0s until it has run here, so give it "seconds"`);
      }
    }
    for (const entry of map.importersExcept) {
      if (!/[*?{]/.test(entry) && fileTier(map, entry).tier === 'high') warnings.push(`importers_except lists ${entry}, a high risk file; it is still counted, since high risk is never excepted`);
    }
  }
  return { errors, warnings };
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

const WHERE_ORDER = ['here', 'no-screen', 'paid'];

// A fallback stands in for the tests a selector could not pick, so it must be
// the whole suite: a gate, a check in the release gate, a check marked
// "full": true, or a check that runs in a lane. Anything else (one command,
// any other check) runs part of the tests and can never prove a change.
function fallbackIsFull(map, fallback) {
  if (map.gates[fallback] && !map.checks[fallback]) return true;
  const check = map.checks[fallback];
  if (!check) return false;
  return check.full || (map.gates.release || []).includes(fallback) || check.where !== 'here';
}

// Where a file must run: the stricter of what it says now and what it said on
// the base. Deleting a "launches: app" line in the same change does not move a
// test onto this machine.
function whereOf(options, file, fallback) {
  const now = whereFromMarkers((options.readFile || (() => ''))(file), fallback);
  if (!options.readBaseFile) return now;
  const before = whereFromMarkers(options.readBaseFile(file), fallback);
  return WHERE_ORDER.indexOf(before) > WHERE_ORDER.indexOf(now) ? before : now;
}

function isTestPath(map, file) {
  if (CONFTEST.test(file)) return false;
  if (TEST_PATH.test(file)) return true;
  return Object.values(map.checks).some((check) => check.select && select.isCandidate(check, file));
}

// One file's tier and why. options.commentOnly: files whose diff is only
// comments and whitespace.
function fileTier(map, file, options = {}) {
  const kinds = Object.entries(map.risk.high).filter(([, globs]) => globsMatch(globs, file)).map(([kind]) => kind);
  if (kinds.length) return { tier: 'high', kinds, why: kinds.join(', ') };
  if (globsMatch(map.risk.normal, file)) return { tier: 'normal', kinds: [], why: 'risk.normal' };
  if (options.commentOnly && options.commentOnly.has(file)) return { tier: 'low', kinds: [], why: 'comments or whitespace only' };
  if (isTestPath(map, file)) return { tier: 'low', kinds: [], why: 'tests' };
  if (globsMatch(map.risk.low, file)) return { tier: 'low', kinds: [], why: 'risk.low' };
  return { tier: 'normal', kinds: [], why: 'code' };
}

function fileIsMapped(map, file) {
  if (globsMatch(map.risk.low, file) || globsMatch(map.risk.normal, file)) return true;
  if (Object.values(map.risk.high).some((globs) => globsMatch(globs, file))) return true;
  return Object.values(map.checks).some((check) => globsMatch(check.when, file)
    || (check.select && (!check.when.length || select.isCandidate(check, file)))
    || (check.each && eachMatch(check.each, file))
    || (check.namesChanged && globsMatch(check.namesChanged.of, file)));
}

function shellQuote(value) {
  return /^[A-Za-z0-9_./@:=+-]+$/.test(value) ? value : `'${String(value).replace(/'/g, "'\\''")}'`;
}

// An "each" list matches a file when one of its globs does and none of its
// "!glob" entries does: ["a/*.sh", "!a/net.sh"] leaves a/net.sh out.
function eachMatch(globs, file) {
  const list = globs || [];
  const skip = list.filter((glob) => String(glob).startsWith('!')).map((glob) => String(glob).slice(1));
  return globsMatch(list.filter((glob) => !String(glob).startsWith('!')), file) && !globsMatch(skip, file);
}

// Expand an "each" check into one run per file: a candidate runs when it was
// changed itself, or (names_changed) when its text names a changed file. This
// is the same rule obelisk's ship script uses to find focused tests.
function expandEach(check, changed, options) {
  const listFiles = options.listFiles || (() => []);
  const readFile = options.readFile || (() => '');
  const candidates = listFiles().filter((file) => eachMatch(check.each, file));
  const picks = new Map();
  for (const file of changed) {
    if (candidates.includes(file)) picks.set(file, `path-match: ${file}`);
  }
  if (check.namesChanged && !options.lowOnly) {
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
    where: whereOf(options, file, check.where),
    reasons: [reason],
    seconds: check.seconds,
    timeoutSeconds: check.timeoutSeconds,
    port: check.port,
    needsElectron: check.needsElectron,
  }));
}

function entryFrom(check, extra) {
  return {
    key: check.name, name: check.name, file: null, run: check.run, where: check.where, reasons: [],
    seconds: check.seconds, timeoutSeconds: check.timeoutSeconds, port: check.port, needsElectron: check.needsElectron,
    cwd: check.cwd, env: check.env, stage: 1, ...extra,
  };
}

// Paths in {files} and {file} are relative to the check's cwd.
function relToCwd(check, file) {
  return check.cwd ? path.posix.relative(check.cwd, file) : file;
}

// Turn a selector's picked tests into runnable entries. {file}: one run per
// test, run in a small pool. {files}: one run for all tests that may run in
// the same place. A test marked launches: app or spends: goes to its lane.
function selectorEntries(check, tests, options) {
  const fill = (text) => text.split('{python}').join(options.python ? options.python(check) : 'python3');
  if (check.run.includes('{file}')) {
    return tests.map((test) => entryFrom(check, {
      key: `${check.name} ${test.file}`,
      file: test.file,
      run: fill(check.run).split('{file}').join(shellQuote(relToCwd(check, test.file))),
      where: whereOf(options, test.file, check.where),
      reasons: test.reasons.slice(),
      selector: check.name,
      tests: [test],
    }));
  }
  const groups = new Map();
  for (const test of tests) {
    const where = whereOf(options, test.file, check.where);
    if (!groups.has(where)) groups.set(where, []);
    groups.get(where).push(test);
  }
  return [...groups.entries()].map(([where, list]) => {
    const parallel = options.parallelArgs ? options.parallelArgs(check, list.length) : '';
    let run = fill(check.run).split('{files}').join(list.map((test) => shellQuote(relToCwd(check, test.file))).join(' '));
    run = run.includes('{parallel}') ? run.split('{parallel}').join(parallel).replace(/ {2,}/g, ' ').trim() : (parallel ? `${run} ${parallel}` : run);
    return entryFrom(check, {
      key: where === check.where ? check.name : `${check.name} (${where})`,
      run,
      where,
      reasons: [`${list.length} selected test${list.length === 1 ? '' : 's'}`],
      selector: check.name,
      tests: list,
      selectedCount: list.length,
      perTestSeconds: check.perTestSeconds,
      workers: parallel ? Number((parallel.match(/-n\s+(\d+)/) || [])[1]) || 1 : 1,
    });
  });
}

// The plan: which checks run for these changed files, and why.
// options.gate picks a whole named gate instead (for a release).
// options.importers: Map of changed file -> files that import it (one hop).
// Those importers count as touched for globs and risk, never as unmapped.
// options.importersOf(file): direct importers of any file (selectors use two hops).
// options.unreadable: changed code files whose imports could not be read; they widen.
// options.commentOnly: changed code files whose diff is only comments and whitespace.
// options.listFiles, readFile, grep: how selectors see the repo.
// options.readBaseFile: a changed file's text on the base, for its markers.
// options.python(check), parallelArgs(check, n): how a selector's run is filled in.
function planChecks(map, changedFiles, options = {}) {
  const changed = [...new Set(changedFiles)].sort();
  const commentOnly = options.commentOnly || new Set();
  const tierOptions = { commentOnly };
  const files = changed.map((file) => ({ path: file, ...fileTier(map, file, tierOptions), mapped: fileIsMapped(map, file) && !(options.unreadable || []).includes(file) }));
  // A file whose change is low risk (docs, comments, tests) changes nothing its
  // importers run, so they are not counted.
  const lowFiles = new Set(files.filter((file) => file.tier === 'low').map((file) => file.path));
  const importedBy = new Map();
  for (const [file, list] of (options.importers || new Map())) {
    if (lowFiles.has(file)) continue;
    for (const importer of list || []) {
      if (changed.includes(importer) || importedBy.has(importer)) continue;
      // importers_except can quiet an entry file, never a high risk one: a
      // change a sign-in or money file imports stays high risk.
      if (globsMatch(map.importersExcept, importer) && fileTier(map, importer).tier !== 'high') continue;
      importedBy.set(importer, file);
    }
  }
  const via = [...importedBy.keys()].sort().map((file) => ({ path: file, ...fileTier(map, file), imports: importedBy.get(file) }));
  const touched = [...changed, ...via.map((file) => file.path)];
  const tier = options.gate ? 'high' : [...files, ...via].reduce((best, file) => (TIERS.indexOf(file.tier) > TIERS.indexOf(best) ? file.tier : best), 'low');
  const highKinds = [...new Set([...files, ...via].flatMap((file) => file.kinds))].sort();
  const unmapped = files.filter((file) => !file.mapped).map((file) => file.path);
  const label = (file) => (importedBy.has(file) ? `${file} imports ${importedBy.get(file)}` : file);
  const allows = (check) => (tier === 'low' ? check.tier === 'low' : tier === 'normal' ? check.tier !== 'high' : true);
  const picks = new Map();
  const extra = [];
  const pick = (name, reason, more = {}) => {
    const check = map.checks[name];
    if (!check || check.each || check.select) return;
    if (!picks.has(name)) picks.set(name, entryFrom(check, more));
    const entry = picks.get(name);
    if (!more.partialFallback) delete entry.partialFallback;
    if (!entry.reasons.includes(reason)) entry.reasons.push(reason);
  };
  // Pick a selector's fallback: every check of a gate it names, the check it
  // names, or its one command. A partial one is marked (fallbackIsFull).
  const pickFallback = (check, reason, more = {}) => {
    const fallback = check.fallback;
    if (map.gates[fallback] && !map.checks[fallback]) {
      for (const name of map.gates[fallback]) {
        const member = map.checks[name];
        if (!member) continue;
        if (member.select) {
          if (map.checks[member.fallback]) pick(member.fallback, reason, { ...more, late: true });
          else extra.push(entryFrom(member, { key: `${name} fallback`, run: member.fallback, reasons: [reason], seconds: null, partialFallback: true, ...more, late: true }));
        } else pick(name, reason, { ...more, late: true });
      }
      return;
    }
    const partial = fallbackIsFull(map, fallback) ? {} : { partialFallback: true };
    if (map.checks[fallback]) pick(fallback, reason, { ...more, ...partial, late: true });
    else extra.push(entryFrom(check, { key: `${check.name} fallback`, run: fallback, reasons: [reason], seconds: null, ...more, partialFallback: true, late: true }));
  };
  const selections = {};

  if (options.gate) {
    if (!map.gates[options.gate]) throw new CheckMapError(`no gate named "${options.gate}" in atris/checks.json`);
    for (const name of map.gates[options.gate]) {
      const check = map.checks[name];
      if (check && check.select && check.fallback) {
        pickFallback(check, `gate: ${options.gate} (${name} runs whole)`);
      } else {
        pick(name, `gate: ${options.gate}`);
      }
    }
  } else {
    for (const check of Object.values(map.checks)) {
      if (check.each || check.select || !allows(check)) continue;
      const hit = firstMatch(check.when, changed) || firstMatch(check.when, touched);
      if (hit) {
        const more = touched.filter((file) => globsMatch(check.when, file)).length - 1;
        const kind = importedBy.has(hit) ? 'import-match' : 'path-match';
        pick(check.name, `${kind}: ${label(hit)}${more > 0 ? ` (+${more} more)` : ''}`);
      }
      if (check.always) pick(check.name, 'always');
    }
    if (tier === 'high') {
      for (const kind of highKinds) {
        for (const check of Object.values(map.checks)) if (check.risk === kind && !check.select) pick(check.name, `high-risk: ${kind}`, { stage: 2 });
      }
      for (const name of map.gates.release || []) {
        const check = map.checks[name];
        const reason = `release gate (high-risk: ${highKinds.join(', ')})`;
        // A selector in the gate runs whole for high risk: its full fallback.
        if (check && check.select) {
          pickFallback(check, `${reason}, ${name} runs whole`, { stage: 2 });
          continue;
        }
        pick(name, reason, { stage: 2 });
      }
    }
    if (unmapped.length) {
      for (const name of map.default) pick(name, `unmapped: ${unmapped[0]}${unmapped.length > 1 ? ` (+${unmapped.length - 1} more)` : ''}`);
    }
    if (tier === 'normal') {
      for (const name of map.normalNeedsLane) pick(name, 'the map says normal changes need it in the lane', { where: 'no-screen', laneOnly: true });
    }
    // Selectors: the few tests that cover the change.
    const isLow = (file) => lowFiles.has(file);
    const isTest = (file) => isTestPath(map, file);
    for (const check of Object.values(map.checks)) {
      if (!check.select) continue;
      const inDefault = map.default.includes(check.name);
      const inScope = (file) => (!check.when.length || globsMatch(check.when, file) || select.isCandidate(check, file) || (inDefault && unmapped.includes(file)));
      if (!changed.some(inScope)) continue;
      const lowOnly = tier === 'low';
      if (!lowOnly && !allows(check)) continue;
      const result = select.selectTests(check, {
        changed,
        files: options.listFiles ? options.listFiles() : [],
        inScope,
        isLow,
        isTest,
        readFile: options.readFile || (() => ''),
        importersOf: options.importersOf || ((file) => (options.importers && options.importers.get(file)) || []),
        loadsPart: options.loadsPart,
        importersExcept: (file) => globsMatch(map.importersExcept, file),
        owners: map.owners,
        lowOnly,
        grep: options.grep,
        isBroad: (file) => globsMatch(map.broad, file),
        changedNames: options.changedNames || (() => []),
      });
      selections[check.name] = {
        mode: result.fallback ? 'fallback' : result.tests.length ? 'tests' : 'none',
        why: result.fallback || '',
        tests: result.tests,
        uncovered: result.uncovered,
        candidates: result.candidates,
        broad_names: result.broadNames,
        hubs: result.hubs,
        max: result.max,
      };
      if (result.fallback) {
        const reason = `fallback for ${check.name}: ${result.fallback}`;
        pickFallback(check, reason, { stage: tier === 'high' ? 2 : 1 });
      } else if (result.tests.length) {
        extra.push(...selectorEntries(check, result.tests, options));
      }
    }
  }
  const seen = new Set();
  const selected = [...picks.values(), ...extra].filter((entry) => {
    if (seen.has(entry.key)) return false;
    seen.add(entry.key);
    return true;
  });
  if (!options.gate) {
    for (const check of Object.values(map.checks)) {
      if (!check.each) continue;
      if (tier === 'low' || allows(check)) {
        const each = expandEach(check, tier === 'low' ? changed.filter((file) => eachMatch(check.each, file)) : changed, tier === 'low' ? { ...options, lowOnly: true } : options);
        selected.push(...each);
      }
    }
  }
  // Cheapest first, so a defect is caught at the cheapest stage. A stage
  // starts only when every check before it passed; checks inside one stage
  // run side by side.
  //   0  quick checks: one command of 5s or less (lint, types, the map)
  //   1  the tests this change needs, and its other checks
  //   2  the full gate: a selector's fallback, the release gate and the
  //      checks that guard a high risk
  // The key scan runs before stage 0 (commands/check.js).
  for (const entry of selected) {
    const quick = !entry.selector && !entry.file && entry.seconds && entry.seconds <= ALWAYS_MAX_SECONDS;
    if (entry.stage === 2 || entry.late) entry.stage = 2;
    else if (quick) entry.stage = 0;
    else if (tier === 'high' && !entry.selector && !entry.file) entry.stage = 2;
    else entry.stage = 1;
    delete entry.late;
  }
  const pickedNames = new Set(selected.map((entry) => entry.name));
  const notPicked = Object.keys(map.checks).filter((name) => !pickedNames.has(name));
  const toConfirm = Object.values(map.checks).filter((check) => check.confirm).map((check) => check.name);
  const uncovered = [...new Set(Object.values(selections).flatMap((entry) => entry.uncovered))].sort();
  const lowWhy = files.filter((file) => file.tier === 'low').map((file) => ({ path: file.path, why: file.why }));
  return {
    files, importers: via, tier, highKinds, unmapped, selected, notPicked, toConfirm,
    gate: options.gate || null, selections, uncovered, lowWhy,
    target: map.budget[tier] || null,
  };
}

module.exports = {
  MAP_PATH,
  WHERE,
  TIERS,
  DEFAULT_BUDGET,
  CheckMapError,
  globToRegExp,
  globsMatch,
  validateMap,
  lintMap,
  loadMap,
  whereFromMarkers,
  fileTier,
  isTestPath,
  planChecks,
  fallbackIsFull,
};
