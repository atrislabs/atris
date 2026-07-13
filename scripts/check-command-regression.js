#!/usr/bin/env node
'use strict';

// No-command-regression release gate.
//
// 3.25.0 shipped from a lineage that lacked deck/card/reel/slop/site/theme, so
// `atris@latest` silently lost six commands. This gate compares the about-to-
// publish command surface against the currently-published atris@latest and
// refuses to publish if any command disappeared. Intentional removals are
// acknowledged with ATRIS_ALLOW_COMMAND_REMOVALS="a,b".

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');

// Parse the knownCommands array literal out of bin/atris.js (the invocable surface).
function extractKnownCommands(source) {
  const start = String(source || '').indexOf('const knownCommands');
  if (start === -1) return [];
  const open = source.indexOf('[', start);
  const close = source.indexOf('];', open);
  if (open === -1 || close === -1) return [];
  const body = source.slice(open + 1, close);
  const matches = body.match(/'([^']+)'/g) || [];
  return matches.map((s) => s.slice(1, -1));
}

// Parse the command verbs the router actually dispatches on: `command === 'x'`.
// Flag aliases (--help, -v) and numeric tokens are not user-facing commands.
function extractDispatchedCommands(source) {
  const matches = String(source || '').match(/command === '([^']+)'/g) || [];
  const verbs = matches.map((s) => s.replace(/^command === '/, '').replace(/'$/, ''));
  // Real command verbs start with a letter; drop numeric special forms
  // (e.g. `atris 2 fast`) and flag aliases (`--help`, `-v`).
  return Array.from(new Set(verbs)).filter((v) => /^[a-z][a-z0-9_-]*$/.test(v));
}

// A command dispatched in the router but absent from knownCommands is dead: it
// falls through to the natural-language handler and never runs (the avail bug).
function findUnregisteredDispatches(rootDir) {
  let binSource = '';
  try {
    binSource = fs.readFileSync(path.join(rootDir, 'bin', 'atris.js'), 'utf8');
  } catch (_) {
    return [];
  }
  const dispatched = extractDispatchedCommands(binSource);
  const known = new Set(readKnownCommandsFromDir(rootDir));
  return dispatched.filter((c) => !known.has(c));
}

function diffCommandRegression(publishedCommands, localCommands, { allow = [] } = {}) {
  const local = new Set(localCommands);
  const allowed = new Set(allow);
  const removed = publishedCommands.filter((c) => !local.has(c) && !allowed.has(c));
  return { ok: removed.length === 0, removed };
}

// The array literal moved from bin/atris.js to lib/known-commands.js when the
// usage sensor landed. Older published tarballs still carry it inline, so both
// sides of the diff must try both layouts.
const KNOWN_COMMANDS_LAYOUTS = [
  path.join('lib', 'known-commands.js'),
  path.join('bin', 'atris.js'),
];

function readKnownCommandsFromDir(dir) {
  for (const rel of KNOWN_COMMANDS_LAYOUTS) {
    try {
      const cmds = extractKnownCommands(fs.readFileSync(path.join(dir, rel), 'utf8'));
      if (cmds.length) return cmds;
    } catch (_) { /* try the next layout */ }
  }
  return [];
}

// Fetch the command surface from the published tarball. Best-effort: null on infra failure.
function fetchPublishedBin(version = 'latest', runner = spawnSync) {
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-regression-'));
    const pack = runner('npm', ['pack', `atris@${version}`], { cwd: dir, encoding: 'utf8' });
    if (pack.status !== 0) return null;
    const tgz = String(pack.stdout || '').trim().split('\n').pop();
    if (!tgz) return null;
    let extracted = false;
    for (const rel of KNOWN_COMMANDS_LAYOUTS) {
      const member = `package/${rel.split(path.sep).join('/')}`;
      const extract = runner('tar', ['xzf', tgz, '-C', dir, member], { cwd: dir, encoding: 'utf8' });
      if (extract.status === 0) extracted = true;
    }
    if (!extracted) return null;
    const cmds = readKnownCommandsFromDir(path.join(dir, 'package'));
    return cmds.length ? cmds : null;
  } catch (_) {
    return null;
  } finally {
    if (dir) try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

function main() {
  const localCommands = readKnownCommandsFromDir(repoRoot);
  if (!localCommands.length) {
    console.error('check-command-regression: could not read local knownCommands; aborting.');
    return 1;
  }
  const orphans = findUnregisteredDispatches(repoRoot);
  if (orphans.length) {
    console.error(`Refusing to publish: these commands are dispatched in bin/atris.js but missing from knownCommands (they silently never run):\n  ${orphans.join(', ')}`);
    console.error('Add them to lib/known-commands.js.');
    return 1;
  }
  const publishedCommands = fetchPublishedBin('latest');
  if (!publishedCommands) {
    console.warn('check-command-regression: could not fetch atris@latest; skipping (infra, not a regression).');
    return 0;
  }
  const allow = (process.env.ATRIS_ALLOW_COMMAND_REMOVALS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const { ok, removed } = diffCommandRegression(publishedCommands, localCommands, { allow });
  if (!ok) {
    console.error(`Refusing to publish: these commands exist in atris@latest but not in this release:\n  ${removed.join(', ')}`);
    console.error(`If the removal is intentional, set ATRIS_ALLOW_COMMAND_REMOVALS="${removed.join(',')}" and re-run.`);
    return 1;
  }
  console.log(`No command regressions vs atris@latest (${publishedCommands.length} published, ${localCommands.length} local).`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { extractKnownCommands, extractDispatchedCommands, findUnregisteredDispatches, readKnownCommandsFromDir, diffCommandRegression, fetchPublishedBin, main };
