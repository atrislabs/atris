'use strict';

// Zen for every repo you keep, in one run. The list comes from the command
// line or ~/.atris/zen.json ({"repos": ["~/code/app", ...]}). A repo whose
// unsaved edits touch live app data or secrets is skipped whole, because a
// person should look at it first. Each repo gets one line, then one shared
// list of what only a person can do.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULT_TEAM_STATE, dirtyEntries, untrackedFiles } = require('./zen');
const { applyZen } = require('./zen-apply');

const LIVE_DATA = DEFAULT_TEAM_STATE.filter((p) => p.startsWith('*.')).map((p) => p.slice(1));
const SECRET = /(^|\/)(\.env(\..+)?|id_rsa[^/]*|[^/]*\.(pem|key|p12)|[^/]*(secret|credential)[^/]*)$/i;

function fleetFile() {
  return process.env.ATRIS_ZEN_FLEET_FILE || path.join(os.homedir(), '.atris', 'zen.json');
}

function expand(p) {
  return path.resolve(p.replace(/^~(?=$|\/)/, os.homedir()));
}

function fleetRepos(paths = []) {
  if (paths.length) return paths.map(expand);
  try {
    const listed = JSON.parse(fs.readFileSync(fleetFile(), 'utf8')).repos;
    return Array.isArray(listed) ? listed.filter((p) => typeof p === 'string').map(expand) : [];
  } catch {
    return [];
  }
}

// Unsaved edits that look like live app data or secrets.
function riskyEdits(root) {
  return dirtyEntries(root)
    .flatMap((e) => (e.xy === '??' && e.path.endsWith('/') ? untrackedFiles(root, e.path) : [e.path]))
    .filter((p) => LIVE_DATA.some((ext) => p.endsWith(ext)) || SECRET.test(p));
}

function home(p) {
  const dir = os.homedir();
  return p === dir || p.startsWith(dir + path.sep) ? `~${p.slice(dir.length)}` : p;
}

function zenOne(repo, fetch) {
  const name = path.basename(repo);
  if (!fs.existsSync(repo)) return { repo, name, state: 'missing', text: `not found at ${home(repo)}`, yours: [] };
  const risky = riskyEdits(repo);
  if (risky.length) {
    const shown = risky.slice(0, 3).join(', ') + (risky.length > 3 ? ` and ${risky.length - 3} more` : '');
    return { repo, name, state: 'skipped', text: `skipped, unsaved live data or secrets: ${shown}`, yours: [] };
  }
  let result;
  try {
    result = applyZen({ cwd: repo, fetch });
  } catch (err) {
    return { repo, name, state: 'failed', text: `zen stopped: ${String(err.message || err).split('\n')[0]}`, yours: [] };
  }
  if (!result.ok) return { repo, name, state: 'failed', text: `can't start, ${result.error}`, yours: [] };
  const did = [...result.done, ...(result.workspace?.done || [])];
  let text = result.already ? 'already zen' : did.join(', ') || 'zen';
  if (!result.zen) text += `; still out of place: ${result.remaining.join(', ')}`;
  // Where your copy went and what was left alone matter as much as what was
  // done, so they ride along under the repo line. Side copy paths stay out to
  // keep the pane small; plain atris zen in that repo lists them.
  const more = [...result.notes, ...result.left.filter((line) => !/^\s/.test(line))];
  return { repo, name, state: result.zen ? 'zen' : 'almost', text, more, yours: result.workspace?.yours || [] };
}

function fleetZen({ repos, fetch = true } = {}) {
  return repos.map((repo) => zenOne(repo, fetch));
}

function printFleet(results) {
  const width = Math.max(...results.map((r) => r.name.length));
  console.log('');
  console.log('  atris zen, every repo');
  console.log('');
  for (const r of results) {
    console.log(`  ${r.name.padEnd(width)}  ${r.text}`);
    for (const line of r.more || []) console.log(`  ${''.padEnd(width)}  ${line}`);
  }
  const yours = results.flatMap((r) => r.yours.map((item) => ({ text: `${r.name}: ${item.text}`, cmd: item.cmd })));
  if (yours.length) {
    console.log('');
    console.log('  for you');
    const w = Math.max(...yours.map((item) => item.text.length));
    for (const item of yours) console.log(`  ${item.text.padEnd(w)}   ${item.cmd}`);
  }
  const calm = results.filter((r) => r.state === 'zen').length;
  const skipped = results.filter((r) => r.state === 'skipped').length;
  console.log('');
  console.log(`  ${calm} of ${results.length} repos zen${skipped ? `, ${skipped} skipped for you to look at` : ''}.`);
  console.log('');
}

module.exports = { fleetFile, fleetRepos, fleetZen, printFleet, riskyEdits };
