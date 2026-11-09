'use strict';

// Member changes save map notes as their own small files under
// atris/refs/map-notes.d/ instead of editing atris/refs/MAP-NOTES.md, so two
// changes never clash on the shared map. Once an hour the autoland tick folds
// those files into MAP-NOTES.md on the main branch and removes them, in one
// commit built without touching any checkout. When the notes are split into
// area notes under atris/refs/map/, a drop whose heading an area note already
// has folds into that note; any other drop folds into the member notes file. A push that loses a race with
// another landing is dropped; the next hour tries again from the new main.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { MAP_NOTES_DIR } = require('./map-refs');

const NOTES_FILE = 'atris/refs/MAP-NOTES.md';
const DROP_DIR = 'atris/refs/map-notes.d';
const MEMBER_NOTES_FILE = `${MAP_NOTES_DIR}/member-notes.md`;
const MEMBER_NOTES_HEAD = '# Member notes\n\nMap notes that member changes added and no area has claimed yet. Move each one into the area note that owns its code. Back to [MAP-NOTES.md](../MAP-NOTES.md).\n';
const FOLD_EVERY_MS = 60 * 60 * 1000;

function git(args, cwd, extraEnv = {}) {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, ...extraEnv, GIT_NO_REPLACE_OBJECTS: '1' },
  });
  return {
    ok: res.status === 0,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || res.error?.message || '').trim(),
  };
}

function foldDue(lastAt, now = Date.now()) {
  const last = Date.parse(lastAt || '');
  return !Number.isFinite(last) || now - last >= FOLD_EVERY_MS;
}

const isHeading = (line) => /^## \S/.test(line);
const trimEnd = (text) => String(text || '').replace(/\r\n/g, '\n').replace(/\s+$/, '');

// Fold drop texts into the notes text. A drop that opens with a "## " heading
// already in the notes adds its new lines at the end of that section; any
// other drop is added at the end of the file as written. A drop whose lines
// are all already there adds nothing.
function foldNotesText(notes, drops) {
  const lines = trimEnd(notes) ? trimEnd(notes).split('\n') : [];
  let added = 0;
  for (const drop of drops) {
    const body = trimEnd(drop.text).split('\n');
    while (body.length && !body[0].trim()) body.shift();
    if (!body.length) continue;
    const at = isHeading(body[0]) ? lines.findIndex((l) => l.trim() === body[0].trim()) : -1;
    if (at >= 0) {
      let end = lines.findIndex((l, i) => i > at && isHeading(l));
      if (end < 0) end = lines.length;
      const seen = new Set(lines.slice(at, end).map((l) => l.trim()));
      const fresh = body.slice(1).filter((l) => l.trim() && !seen.has(l.trim()));
      if (!fresh.length) continue;
      while (end > at + 1 && !lines[end - 1].trim()) end--;
      lines.splice(end, 0, ...fresh);
      added += fresh.length;
    } else {
      const seen = new Set(lines.map((l) => l.trim()));
      const content = body.filter((l) => l.trim());
      if (content.every((l) => seen.has(l.trim()))) continue;
      if (lines.length) lines.push('');
      lines.push(...body);
      added += content.length;
    }
  }
  return { text: lines.length ? `${lines.join('\n')}\n` : '', added };
}

// Which notes file each drop folds into. Without area notes every drop goes to
// MAP-NOTES.md as before.
function foldTargets(root, baseSha, drops) {
  const read = (file) => {
    const blob = git(['cat-file', 'blob', `${baseSha}:${file}`], root);
    return blob.ok ? blob.stdout : null;
  };
  const listed = git(['ls-tree', '--name-only', baseSha, '--', `${MAP_NOTES_DIR}/`], root).stdout
    .split('\n').filter((f) => f.endsWith('.md')).sort();
  const targets = new Map();
  const put = (file, text, drop) => {
    if (!targets.has(file)) targets.set(file, { text, drops: [] });
    targets.get(file).drops.push(drop);
  };
  if (!listed.length) {
    for (const drop of drops) put(NOTES_FILE, read(NOTES_FILE) || '', drop);
    return targets;
  }
  const notes = listed.map((file) => ({ file, text: read(file) || '' }));
  for (const drop of drops) {
    const first = trimEnd(drop.text).split('\n').find((l) => l.trim()) || '';
    const owner = isHeading(first) && notes.find((note) => note.text.split('\n').some((l) => l.trim() === first.trim()));
    if (owner) put(owner.file, owner.text, drop);
    else put(MEMBER_NOTES_FILE, read(MEMBER_NOTES_FILE) || MEMBER_NOTES_HEAD, drop);
  }
  return targets;
}

function mainBranch(root, remote) {
  const head = git(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`], root).stdout.trim();
  return head.startsWith(`${remote}/`) ? head.slice(remote.length + 1) : 'master';
}

// Fold every drop file on the main branch into the shared map notes and push
// the result. Returns what happened; never throws for an ordinary miss.
function foldMapNotesOnMain(root, { base = '', remote = 'origin', push = true } = {}) {
  base = base || mainBranch(root, remote);
  const remoteRef = `refs/remotes/${remote}/${base}`;
  const fetched = git(['fetch', '-q', remote, `+refs/heads/${base}:${remoteRef}`], root);
  if (!fetched.ok) return { folded: 0, reason: 'main_unreadable', detail: fetched.stderr.split('\n')[0] };
  const baseSha = git(['rev-parse', remoteRef], root).stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(baseSha)) return { folded: 0, reason: 'main_unreadable' };

  const listed = git(['ls-tree', '-r', '--name-only', baseSha, '--', `${DROP_DIR}/`], root);
  const files = listed.stdout.split('\n').filter((f) => f.endsWith('.md')).sort();
  if (!files.length) return { folded: 0, reason: 'nothing_to_fold', base: baseSha };

  const drops = [];
  for (const file of files) {
    const blob = git(['cat-file', 'blob', `${baseSha}:${file}`], root);
    if (!blob.ok) return { folded: 0, reason: 'drop_unreadable', detail: file };
    drops.push({ file, text: blob.stdout });
  }
  const targets = foldTargets(root, baseSha, drops);
  let added = 0;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-map-fold-'));
  try {
    const index = { GIT_INDEX_FILE: path.join(tmp, 'index') };
    let built = git(['read-tree', baseSha], root, index).ok;
    for (const [target, { text: currentText, drops: targetDrops }] of targets) {
      if (!built) break;
      const folded = foldNotesText(currentText, targetDrops);
      added += folded.added;
      const notesPath = path.join(tmp, 'notes');
      fs.writeFileSync(notesPath, folded.text);
      const blob = git(['hash-object', '-w', notesPath], root).stdout.trim();
      built = /^[0-9a-f]{40,64}$/.test(blob)
        && git(['update-index', '--add', '--cacheinfo', `100644,${blob},${target}`], root, index).ok;
    }
    built = built && git(['update-index', '--force-remove', '--', ...files], root, index).ok;
    const tree = built ? git(['write-tree'], root, index).stdout.trim() : '';
    const message = `Fold ${files.length} map ${files.length === 1 ? 'note' : 'notes'} from member changes into the shared map`;
    const commit = tree ? git(['commit-tree', tree, '-p', baseSha, '-m', message], root).stdout.trim() : '';
    if (!/^[0-9a-f]{40,64}$/.test(commit)) return { folded: 0, reason: 'commit_failed' };
    if (!push) return { folded: files.length, added, sha: commit, pushed: false, files };
    const pushed = git(['push', '-q', remote, `${commit}:refs/heads/${base}`], root);
    if (!pushed.ok) return { folded: 0, reason: 'push_rejected', detail: pushed.stderr.split('\n')[0], sha: commit };
    git(['update-ref', remoteRef, commit], root);
    return { folded: files.length, added, sha: commit, pushed: true, files };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { NOTES_FILE, DROP_DIR, FOLD_EVERY_MS, foldDue, foldNotesText, foldMapNotesOnMain };
