'use strict';

// Lists leftover fixture folders from the work-folder cleanup proofs in the
// temporary directory. Preview only: it never deletes. --paths prints just the
// folder paths so a person who approves clearing them can act on that list.
// Green-landing scratch copies are left out on purpose: production keeps
// those when they hold Git locks.

const fs = require('fs');
const os = require('os');
const path = require('path');

const PREFIXES = [
  'atris-cleanup-moved', 'atris-cleanup-moved-lock', 'atris-cleanup-refused', 'atris-fleet-check',
  'atris-green-scratch', 'atris-land-missing', 'atris-land-moved-dirty', 'atris-land-vanishing',
  'atris-missing-ordinary', 'atris-regression-check', 'atris-removal-guard', 'atris-tidy-vanishing',
];

const folders = (n) => `${n} folder${n === 1 ? '' : 's'}`;

function folderBytes(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += folderBytes(file);
      else total += fs.lstatSync(file).size;
    } catch {}
  }
  return total;
}

// A mkdtemp folder is the prefix, a dash, and six random characters, so
// exact matching keeps overlapping prefixes apart.
function previewFixtures({ tmp = fs.realpathSync(os.tmpdir()), minHours = 24, now = Date.now() } = {}) {
  const found = [];
  for (const name of fs.readdirSync(tmp)) {
    const prefix = PREFIXES.find((p) => new RegExp(`^${p}-[A-Za-z0-9]{6}$`).test(name));
    if (!prefix) continue;
    const dir = path.join(tmp, name);
    let stat;
    try { stat = fs.lstatSync(dir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    const ageHours = (now - stat.mtimeMs) / 3600000;
    if (ageHours < minHours) continue;
    let bytes = 0;
    try { bytes = folderBytes(dir); } catch {}
    found.push({ prefix, path: dir, ageHours, bytes });
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

function main(args) {
  const hoursAt = args.indexOf('--hours');
  const minHours = hoursAt >= 0 ? Number(args[hoursAt + 1]) : 24;
  if (!Number.isFinite(minHours) || minHours < 0) {
    console.error('usage: node scripts/preview-proof-fixtures.js [--hours <n>] [--paths]');
    return 2;
  }
  const found = previewFixtures({ minHours });
  if (args.includes('--paths')) {
    for (const item of found) console.log(item.path);
    return 0;
  }
  const byPrefix = new Map();
  for (const item of found) {
    const row = byPrefix.get(item.prefix) || { count: 0, bytes: 0, oldest: 0 };
    row.count += 1;
    row.bytes += item.bytes;
    row.oldest = Math.max(row.oldest, item.ageHours);
    byPrefix.set(item.prefix, row);
  }
  console.log(`proof fixtures older than ${minHours}h: ${folders(found.length)}, ${(found.reduce((n, i) => n + i.bytes, 0) / 1048576).toFixed(1)} MB`);
  for (const [prefix, row] of [...byPrefix].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${prefix}: ${folders(row.count)}, ${(row.bytes / 1048576).toFixed(1)} MB, oldest ${Math.floor(row.oldest)}h`);
  }
  console.log('nothing was deleted; list paths with --paths');
  return 0;
}

module.exports = { previewFixtures, PREFIXES };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
