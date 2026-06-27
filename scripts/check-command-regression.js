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

function diffCommandRegression(publishedCommands, localCommands, { allow = [] } = {}) {
  const local = new Set(localCommands);
  const allowed = new Set(allow);
  const removed = publishedCommands.filter((c) => !local.has(c) && !allowed.has(c));
  return { ok: removed.length === 0, removed };
}

// Fetch bin/atris.js from the published tarball. Best-effort: null on infra failure.
function fetchPublishedBin(version = 'latest', runner = spawnSync) {
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-regression-'));
    const pack = runner('npm', ['pack', `atris@${version}`], { cwd: dir, encoding: 'utf8' });
    if (pack.status !== 0) return null;
    const tgz = String(pack.stdout || '').trim().split('\n').pop();
    if (!tgz) return null;
    const extract = runner('tar', ['xzf', tgz, '-C', dir, 'package/bin/atris.js'], { cwd: dir, encoding: 'utf8' });
    if (extract.status !== 0) return null;
    return fs.readFileSync(path.join(dir, 'package', 'bin', 'atris.js'), 'utf8');
  } catch (_) {
    return null;
  } finally {
    if (dir) try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

function main() {
  const localCommands = extractKnownCommands(fs.readFileSync(path.join(repoRoot, 'bin', 'atris.js'), 'utf8'));
  if (!localCommands.length) {
    console.error('check-command-regression: could not read local knownCommands; aborting.');
    return 1;
  }
  const publishedSource = fetchPublishedBin('latest');
  if (!publishedSource) {
    console.warn('check-command-regression: could not fetch atris@latest; skipping (infra, not a regression).');
    return 0;
  }
  const publishedCommands = extractKnownCommands(publishedSource);
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

module.exports = { extractKnownCommands, diffCommandRegression, fetchPublishedBin, main };
