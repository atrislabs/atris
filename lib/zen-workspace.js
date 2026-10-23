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

// The map as it stands on disk: MAP.md plus any split files under atris/map/.
function mapSnapshot(root) {
  const files = [path.join(root, 'atris', 'MAP.md')];
  const dir = path.join(root, 'atris', 'map');
  try {
    for (const name of fs.readdirSync(dir).sort()) files.push(path.join(dir, name));
  } catch {
    // No split map.
  }
  return files.map((f) => {
    try {
      return `${f}\0${fs.readFileSync(f, 'utf8')}`;
    } catch {
      return `${f}\0`;
    }
  }).join('\0\0');
}

function workspaceZen({ root, dryRun = false } = {}) {
  const out = { ran: false, done: [], todo: [], yours: [] };
  if (!root || !fs.existsSync(path.join(root, 'atris'))) return out;
  out.ran = true;

  const mapBefore = dryRun ? null : mapSnapshot(root);
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
  if (!dryRun && mapSnapshot(root) !== mapBefore) lines.push('refreshed the map');
  if (dryRun) out.todo.push(...lines);
  else out.done.push(...lines);

  const unhealable = r.map_refs?.unhealable_count || 0;
  if (unhealable) out.yours.push({ text: `${plural(unhealable, 'map link points', 'map links point')} nowhere`, cmd: 'atris clean' });
  // These are notes (often feature docs, not wiki pages) written about code
  // that has changed since. Rewriting one takes judgment, so it is yours; name
  // the note when there is only one so the line says exactly what to open.
  const pages = r.stale_pages?.items || [];
  if (pages.length) {
    out.yours.push({
      text: pages.length === 1
        ? `${pages[0].page} is older than the code it describes`
        : `${pages.length} notes are older than the code they describe`,
      cmd: 'atris clean --dry-run',
    });
  }
  const dead = r.dead_code?.count || 0;
  if (dead) out.yours.push({ text: `${plural(dead, 'file looks', 'files look')} unused`, cmd: 'atris clean --dry-run' });

  // Every wiki surface that needs pruning shares one command, so they share
  // one line too: a person sees one job, not three.
  try {
    const seen = new Set();
    const parts = [];
    for (const f of require('./wiki').findWikiMetabolismFindings(root)) {
      if (seen.has(f.surface)) continue;
      seen.add(f.surface);
      const unit = f.surface.endsWith('/') ? 'pages' : 'entries';
      parts.push(f.code === 'over-budget'
        ? { one: `wiki ${f.surface} has ${f.count} ${unit}, its budget is ${f.budget}`, short: `${f.surface} ${f.count} of ${f.budget}` }
        : { one: `wiki ${f.surface} grew by ${f.growth} ${unit} since its last pruning`, short: `${f.surface} grew by ${f.growth}` });
    }
    if (parts.length === 1) out.yours.push({ text: parts[0].one, cmd: 'atris wiki consolidate' });
    if (parts.length > 1) {
      out.yours.push({ text: `wiki needs pruning in ${parts.length} places: ${parts.map((x) => x.short).join(', ')}`, cmd: 'atris wiki consolidate' });
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
