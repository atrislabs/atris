'use strict';

// Member branches stop editing the shared map files. Before a branch goes to
// GitHub, its edits to any MAP.md or MAP-NOTES.md that already exist on the
// main branch are taken back out and saved as a patch in the map inbox, one
// file per branch. The shared map files land untouched, so two members never
// clash in them; the inbox patches are folded into the maps later on the main
// branch by one actor.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const INBOX_DIR = 'atris/refs/map-inbox';
const SHARED_MAP = /(?:^|\/)MAP(?:-NOTES)?\.md$/;

function run(args, cwd, extraEnv = {}, { raw = false } = {}) {
  const env = { ...process.env, ...extraEnv, GIT_NO_REPLACE_OBJECTS: '1' };
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120000, env });
  const stdout = String(res.stdout || '');
  return { ok: res.status === 0, stdout: raw ? stdout : stdout.trim(), stderr: String(res.stderr || '').trim() };
}

function inboxPath(branch) {
  const slug = String(branch || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '') || 'branch';
  return `${INBOX_DIR}/${slug}.patch`;
}

const SHA = /^[0-9a-f]{40,64}$/;

// Returns { sha } unchanged when the branch left the shared maps alone, or
// { sha, moved, inbox } for a new commit on top of headSha whose shared map
// files match the starting point and whose map edits sit in the inbox patch.
// Never touches the checkout. Any failure returns { hold }.
function inboxMapEdits({ headSha, baseSha, branch, cwd }) {
  const bases = run(['merge-base', '--all', headSha, baseSha], cwd);
  const mergeBase = bases.ok ? bases.stdout.split('\n').filter(Boolean) : [];
  if (mergeBase.length !== 1) return { sha: headSha, moved: [] };
  const changed = run(['diff', '--no-renames', '--name-status', mergeBase[0], headSha], cwd);
  if (!changed.ok) return { hold: 'the branch\'s map edits could not be read' };
  const moved = changed.stdout.split('\n')
    .map((line) => line.split('\t'))
    .filter(([status, file]) => status === 'M' && SHARED_MAP.test(file || ''))
    .map(([, file]) => file);
  if (!moved.length) return { sha: headSha, moved: [] };

  const patch = run(['diff', '--no-color', '--no-ext-diff', '--no-renames', mergeBase[0], headSha, '--', ...moved], cwd, {}, { raw: true });
  if (!patch.ok || !patch.stdout) return { hold: 'the branch\'s map edits could not be saved' };
  const inbox = inboxPath(branch);
  const earlier = run(['cat-file', 'blob', `${headSha}:${inbox}`], cwd, {}, { raw: true });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-map-inbox-'));
  try {
    const index = { GIT_INDEX_FILE: path.join(tmp, 'index') };
    if (!run(['read-tree', headSha], cwd, index).ok) return { hold: 'the map inbox could not be built' };
    for (const file of moved) {
      const entry = run(['ls-tree', mergeBase[0], '--', file], cwd).stdout.match(/^(\d{6}) blob ([0-9a-f]{40,64})\t/);
      if (!entry || !run(['update-index', '--cacheinfo', `${entry[1]},${entry[2]},${file}`], cwd, index).ok) {
        return { hold: `the map file ${file} could not be put back` };
      }
    }
    const patchFile = path.join(tmp, 'patch');
    fs.writeFileSync(patchFile, (earlier.ok ? earlier.stdout : '') + patch.stdout);
    const blob = run(['hash-object', '-w', patchFile], cwd);
    if (!blob.ok || !SHA.test(blob.stdout)) return { hold: 'the map inbox could not be saved' };
    if (!run(['update-index', '--add', '--cacheinfo', `100644,${blob.stdout},${inbox}`], cwd, index).ok) {
      return { hold: 'the map inbox could not be built' };
    }
    const tree = run(['write-tree'], cwd, index);
    if (!tree.ok) return { hold: 'the map inbox could not be built' };
    const commit = run(['commit-tree', tree.stdout, '-p', headSha, '-m', 'Move map edits to the map inbox'], cwd);
    if (!commit.ok || !SHA.test(commit.stdout)) return { hold: 'the map inbox commit could not be saved' };
    return { sha: commit.stdout, moved, inbox };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { inboxMapEdits, inboxPath, INBOX_DIR };
