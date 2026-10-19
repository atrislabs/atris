'use strict';

// The workspace and understanding layers of atris zen. Zen runs the safe,
// existing cleanups (`atris clean`), then names the few things only a person
// can do, each with one command. That short list is the shared picture: zen
// did everything it could, and here is exactly what is left for you.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'atris.js');

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function runCliJson(args, root) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 180000,
    env: { ...process.env, ATRIS_SKIP_UPDATE_CHECK: '1', ATRIS_NONINTERACTIVE: '1' },
  });
  const text = String(result.stdout || '');
  const start = text.indexOf('{');
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

function workspaceZen({ root, dryRun = false } = {}) {
  const out = { ran: false, done: [], todo: [], yours: [] };
  if (!root || !fs.existsSync(path.join(root, 'atris'))) return out;
  out.ran = true;

  const clean = runCliJson(dryRun ? ['clean', '--dry-run', '--json'] : ['clean', '--json'], root);
  const r = clean?.results || {};
  const lines = [];
  const journals = r.journals?.archived_count || 0;
  if (journals) lines.push(`${dryRun ? '' : 'archived '}${plural(journals, 'old journal', 'old journals')}${dryRun ? ' to archive' : ''}`);
  const stale = r.stale_tasks?.count || 0;
  if (stale) lines.push(`${dryRun ? '' : 'put away '}${plural(stale, 'stale task', 'stale tasks')}${dryRun ? ' to put away' : ''}`);
  const healed = r.map_refs?.healed_count || 0;
  if (healed) lines.push(`${dryRun ? '' : 'fixed '}${plural(healed, 'broken map link', 'broken map links')}${dryRun ? ' to fix' : ''}`);
  const sections = r.sections?.cleaned_count || 0;
  if (sections) lines.push(`${dryRun ? '' : 'cleared '}${plural(sections, 'empty task section', 'empty task sections')}${dryRun ? ' to clear' : ''}`);
  if (!dryRun && (r.map_scripts?.items || []).some((item) => item.status === 'ok')) lines.push('refreshed the map');
  if (dryRun) out.todo.push(...lines);
  else out.done.push(...lines);

  const unhealable = r.map_refs?.unhealable_count || 0;
  if (unhealable) out.yours.push({ text: `${plural(unhealable, 'map link points', 'map links point')} nowhere`, cmd: 'atris clean' });
  const pages = r.stale_pages?.items || [];
  if (pages.length) {
    out.yours.push({
      text: `${plural(pages.length, 'wiki page is', 'wiki pages are')} behind ${pages.length === 1 ? 'its source' : 'their sources'}`,
      cmd: 'atris clean --dry-run',
    });
  }
  const dead = r.dead_code?.count || 0;
  if (dead) out.yours.push({ text: `${plural(dead, 'file looks', 'files look')} unused`, cmd: 'atris clean --dry-run' });

  try {
    if (require('./wiki').wikiMetabolismNudge(root)) {
      out.yours.push({ text: 'the wiki has grown and wants a pruning pass', cmd: 'atris wiki consolidate' });
    }
  } catch {
    // No wiki, nothing to prune.
  }

  // Only ask where tasks already live; asking would otherwise create task state.
  const state = path.join(root, '.atris', 'state');
  const hasTasks = ['tasks.projection.json', 'atris.db'].some((f) => fs.existsSync(path.join(state, f)));
  const reviews = hasTasks ? runCliJson(['task', 'reviews', '--json'], root) : null;
  const ready = reviews?.queue?.counts?.certified || 0;
  if (ready) {
    out.yours.push({
      text: `${plural(ready, 'finished job is', 'finished jobs are')} waiting for your ok`,
      cmd: 'atris task reviews',
    });
  }
  return out;
}

module.exports = { workspaceZen };
