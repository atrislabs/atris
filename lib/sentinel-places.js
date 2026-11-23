'use strict';

// Several places, one review. A company's website, server and phone app
// often live in separate repos, and the worst holes sit between them: one
// part trusts a field another part never checked. This module turns a list
// of places (folders on this machine, or git URLs on any host) into one
// review folder the audit reads as a single system.
//
//   1. resolvePlaces  sort the command's words into places and scope paths
//   2. cloneRepo      a git URL becomes a shallow, read-only clone in a fresh
//                     temp folder, with the user's own git credentials. No
//                     hooks, no submodules, no LFS downloads, no prompts.
//                     Nothing from the clone is ever run.
//   3. buildSystem    each part's tracked files are copied under the part's
//                     name into one fresh folder, so two parts that both
//                     have src/index.js never collide. The audit is told
//                     what git would say about it (lib/security-audit.js
//                     registerSystem), so only tracked files are read and
//                     only each part's own sendable files can reach a
//                     hosted engine. A lone URL is copied the same way with
//                     no prefix, so no link inside it can lead out of it.
//
// cleanup() always removes the review folder, and removes clones unless the
// caller asked to keep them.
//
// Zero external deps (Node built-ins only).

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const COPY_MAX_FILE_BYTES = 8 * 1024 * 1024;
const COPY_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const CLONE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_SEAMS = 20;
const SEAM_EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.rb', '.go', '.java', '.kt', '.kts', '.swift', '.php', '.rs', '.cs', '.dart', '.ex', '.exs', '.scala', '.vue', '.svelte']);
const NOT_A_ROUTE = /^\/(?:tmp|usr|etc|dev|bin|sbin|var|proc|sys|home|users|opt|private|library|applications|volumes|mnt)(?:\/|$)/i;
const ASSET = /\.(?:png|jpe?g|gif|svg|ico|webp|css|scss|js|mjs|map|html?|woff2?|ttf|otf|mp[34]|json|txt|md)$/i;

// The flags every clone runs with. Exported so a test can hold them exact.
const SAFE_CLONE_CONFIG = ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never'];
const SAFE_CLONE_FLAGS = ['clone', '--depth', '1', '--no-recurse-submodules'];

// ---------------------------------------------------------------- words

// https, http, ssh, git and scp-style (git@host:org/repo) URLs on any host.
// file:// and ext:: are never places: one reads outside the review, the
// other runs a command.
function isGitUrl(value) {
  const s = String(value || '');
  if (!s || /\s/.test(s) || s.startsWith('-')) return false;
  const m = s.match(/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/.+/i);
  if (m) return !m[1].startsWith('-');
  const scp = s.match(/^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):(?!\/\/)[^\s]+$/);
  return Boolean(scp && !scp[1].startsWith('-'));
}

// A URL as it may be shown or saved: any user name, password or token in it
// is dropped.
function safeUrl(url) {
  return String(url || '').replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1');
}

function hostOf(url) {
  const s = safeUrl(url);
  const m = s.match(/^[a-z][a-z0-9+.-]*:\/\/([^/:]+)/i) || s.match(/^[^@]+@([^:]+):/);
  return m ? m[1] : 'the git host';
}

function nameFromUrl(url) {
  const m = safeUrl(url).replace(/\/+$/, '').match(/([^/:]+?)(?:\.git)?$/);
  return m ? m[1] : 'repo';
}

// Part names start every path the engines see, so a name the audit would
// treat as a skipped folder or a test folder gets a suffix.
function partName(raw, taken, reserved = () => false) {
  let base = String(raw || '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '').slice(0, 60) || 'part';
  if (reserved(base)) base = `${base}-app`;
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base}-${n}`;
  taken.add(name.toLowerCase());
  return name;
}

function gitTop(dir) {
  try {
    return childProcess.execFileSync('git', ['-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { return null; }
}

function realDir(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

// Sort the command's words. A word is a place when it is a git URL, a
// folder outside the current one, or a folder that is its own git repo.
// Every other word is a scope path, as before. `withPlaces` (from --with)
// are always places. The current folder joins as a part when it is inside a
// git repo or is named itself; a run from a plain parent folder reviews only
// the places named.
function resolvePlaces(cwd, words = [], withPlaces = []) {
  const here = realDir(cwd);
  const places = [];
  const scope = [];
  let namedHere = false;
  const add = (word, fromWith) => {
    if (isGitUrl(word)) { places.push({ kind: 'url', url: word }); return; }
    if (/^file:/i.test(word) || /^[a-z][a-z0-9+.-]*::/i.test(word)) throw new Error(`${safeUrl(word)} is not a place sentinel can review; use a folder or an https or ssh git URL`);
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(word)) throw new Error(`${safeUrl(word)} does not look like a git URL`);
    const abs = path.resolve(cwd, word);
    if (!isDir(abs)) {
      if (fromWith) throw new Error(`${word} is not a folder or a git URL`);
      scope.push(word);
      return;
    }
    const real = realDir(abs);
    if (real === here) { namedHere = true; return; }
    const ownRepo = fs.existsSync(path.join(real, '.git'));
    if (fromWith || !inside(here, real) || ownRepo) places.push({ kind: 'path', path: real });
    else scope.push(word);
  };
  for (const w of withPlaces) add(w, true);
  for (const w of words) add(w, false);
  const seen = new Set();
  const unique = places.filter((p) => {
    const key = p.kind === 'url' ? `url:${safeUrl(p.url)}` : `path:${p.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const hereIsRepo = Boolean(gitTop(cwd));
  const includeHere = namedHere || hereIsRepo || !unique.length;
  const all = includeHere ? [{ kind: 'path', path: here, home: true }, ...unique] : unique;
  return { places: all, scope, multi: all.length > 1 || all.some((p) => p.kind === 'url') };
}

// ---------------------------------------------------------------- clone

function cleanGitError(stderr, url, ref) {
  const text = String(stderr || '').split(String(url)).join(safeUrl(url));
  const host = hostOf(url);
  if (/could not read (?:Username|Password)|Authentication failed|terminal prompts disabled|Permission denied \(publickey|access denied|403/i.test(text)) {
    return `could not sign in to ${host} for ${safeUrl(url)}. check that git clone works for it in your own terminal, then try again`;
  }
  if (ref && /Remote branch .* not found|couldn't find remote ref/i.test(text)) return `${safeUrl(url)} has no branch or tag called ${ref}`;
  if (/Repository not found|not found|does not appear to be a git repository|does not exist|404/i.test(text)) {
    return `${safeUrl(url)} was not found, or your git account cannot see it`;
  }
  if (/Could not resolve host|Connection refused|timed out|unable to access/i.test(text)) return `could not reach ${host}. check your connection and the URL`;
  const first = text.split('\n').map((l) => l.trim()).find(Boolean);
  return `git could not clone ${safeUrl(url)}${first ? `: ${safeUrl(first).slice(0, 200)}` : ''}`;
}

function validRef(ref) {
  return typeof ref === 'string' && /^[A-Za-z0-9._/-]{1,200}$/.test(ref) && !ref.startsWith('-') && !ref.includes('..');
}

// A shallow clone into a fresh empty temp folder. Hooks point at /dev/null,
// file:// and ext:: transports are refused, submodules and LFS files are
// not fetched, and git never asks for a password. `allowFile` exists only so
// a test can clone a local bare repo; no command line flag sets it.
function cloneRepo(url, { ref = null, spawn = childProcess.spawnSync, tmpBase = os.tmpdir(), env = process.env, allowFile = false } = {}) {
  if (!isGitUrl(url) && !allowFile) throw new Error(`${safeUrl(url)} does not look like a git URL`);
  if (ref !== null && !validRef(ref)) throw new Error('--ref must be a branch or tag name');
  const tmp = fs.mkdtempSync(path.join(tmpBase, 'atris-sentinel-clone-'));
  const dest = path.join(tmp, 'src');
  const config = allowFile ? SAFE_CLONE_CONFIG.map((a) => (a === 'protocol.file.allow=never' ? 'protocol.file.allow=always' : a)) : SAFE_CLONE_CONFIG;
  const args = [...config, ...SAFE_CLONE_FLAGS, ...(ref ? ['--branch', ref] : []), '--', url, dest];
  const childEnv = { ...env, GIT_LFS_SKIP_SMUDGE: '1', GIT_TERMINAL_PROMPT: '0' };
  try {
    const r = spawn('git', args, { cwd: tmp, env: childEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: CLONE_TIMEOUT_MS });
    if (!r || r.error || r.status !== 0) {
      const why = r && r.error ? (r.error.code === 'ENOENT' ? 'git is not installed on this machine' : r.error.code === 'ETIMEDOUT' ? `cloning ${safeUrl(url)} took more than ten minutes` : cleanGitError(r.error.message, url, ref)) : cleanGitError(r && r.stderr, url, ref);
      throw new Error(why);
    }
    if (!isDir(dest)) throw new Error(`git said it cloned ${safeUrl(url)} but left no folder`);
    const head = spawn('git', ['-c', 'core.fsmonitor=false', 'rev-parse', 'HEAD'], { cwd: dest, env: childEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const commit = head && head.status === 0 ? String(head.stdout || '').trim() : null;
    return { dir: dest, tmp, commit: /^[0-9a-f]{7,64}$/.test(commit || '') ? commit : null };
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

// ---------------------------------------------------------------- system

function gitState(dir) {
  const run = (args) => childProcess.execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    return { commit: run(['rev-parse', 'HEAD']) || null, dirty: run(['status', '--porcelain', '--untracked-files=no']).length > 0 };
  } catch { return { commit: null, dirty: null }; }
}

// Copy one part's files (tracked by git, or every file outside skipped
// folders when it is not a git repo, the same list a one-folder review
// reads) under `prefix/` (the part name; empty for a lone clone).
// Symlinks, files outside the part and very large files are left out, so a
// link planted in someone else's repo can never lead an engine out of it.
function copyPart(audit, part, stage, budget, prefix) {
  const src = part.dir;
  const join = (rel) => (prefix ? `${prefix}/${rel}` : rel);
  const srcReal = realDir(src);
  const files = [];
  for (const rel of audit.listFiles(src)) {
    if (!audit.isRepoRel(rel)) continue;
    const from = path.join(src, rel);
    let stat;
    try { stat = fs.lstatSync(from); } catch { continue; }
    if (!stat.isFile() || stat.size > COPY_MAX_FILE_BYTES) continue;
    if (!inside(srcReal, realDir(from))) continue;
    budget.bytes += stat.size;
    if (budget.bytes > COPY_MAX_TOTAL_BYTES) throw new Error('these places hold more than 1 GB of tracked files together; review fewer places or narrower ones');
    const to = path.join(stage, join(rel));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    files.push(join(rel));
  }
  // What a hosted engine may see, by the part's own git rules.
  const allowed = [...audit.hostedAllowedFiles(src, [])].map(join);
  return { files, allowed };
}

// Route-like strings one part names and another also names: a client and
// the server route it calls, a webhook sender and its receiver. Hunters get
// these as places to start following a request across parts.
function routeKey(raw) {
  let p = raw.replace(/\$\{[^}]*\}/g, '*').replace(/\{[^}]*\}/g, '*').replace(/<[^>]*>/g, '*').replace(/\/:[A-Za-z_][A-Za-z0-9_]*/g, '/*').replace(/\?.*$/, '').replace(/\/+$/, '');
  if (!p || NOT_A_ROUTE.test(p) || ASSET.test(p) || p.includes('//')) return null;
  const segs = p.split('/').filter(Boolean);
  if (!segs.length || !segs.some((s) => /[A-Za-z]{2,}/.test(s))) return null;
  return segs.join('/').toLowerCase();
}

function findSeams(audit, root, parts) {
  const byPart = new Map();
  for (const part of parts) {
    const routes = new Map();
    for (const rel of part.files) {
      if (routes.size >= 2000) break;
      if (!SEAM_EXTS.has(path.extname(rel).toLowerCase()) || audit.TEST_PATH.test(rel.slice(part.name.length + 1))) continue;
      const text = audit.readText(root, rel);
      if (text === null) continue;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && routes.size < 2000; i++) {
        if (lines[i].length > 2000) continue;
        for (const m of lines[i].matchAll(/["'`](\/[A-Za-z0-9_\-.:{}$<>*/]{2,200})["'`?]/g)) {
          const key = routeKey(m[1]);
          if (key && !routes.has(key)) routes.set(key, `${rel}:${i + 1}`);
        }
      }
    }
    byPart.set(part.name, routes);
  }
  const seams = [];
  const names = [...byPart.keys()];
  const seen = new Set();
  for (let a = 0; a < names.length; a++) {
    for (const [ka, locA] of byPart.get(names[a])) {
      for (let b = a + 1; b < names.length; b++) {
        for (const [kb, locB] of byPart.get(names[b])) {
          const [short, long] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
          const match = ka === kb || (short.split('/').length >= 2 && long.endsWith(`/${short}`));
          if (!match) continue;
          const id = `${long}\0${locA}\0${locB}`;
          if (seen.has(id)) continue;
          seen.add(id);
          seams.push({ route: `/${long}`, places: [locA, locB] });
        }
      }
    }
  }
  return seams.sort((x, y) => x.route.localeCompare(y.route)).slice(0, MAX_SEAMS);
}

// Clone every URL, copy every part into one fresh folder and register it
// with the audit. The result's cleanup() must run when the review ends,
// whether it passed or failed.
function buildSystem(resolved, { ref = null, keepClones = false, spawn, tmpBase = os.tmpdir(), env = process.env, allowFile = false, log = () => {} } = {}) {
  const audit = require('./security-audit');
  const clones = [];
  let stageTmp = null;
  let registered = null;
  const cleanup = () => {
    if (registered) { audit.unregisterSystem(registered); registered = null; }
    if (stageTmp) { fs.rmSync(stageTmp, { recursive: true, force: true }); stageTmp = null; }
    const kept = [];
    for (const c of clones.splice(0)) {
      if (keepClones) kept.push(c.dir);
      else fs.rmSync(c.tmp, { recursive: true, force: true });
    }
    return { kept };
  };
  try {
    const taken = new Set();
    const parts = [];
    for (const place of resolved.places) {
      if (place.kind === 'url') {
        log(`cloning ${safeUrl(place.url)}${ref ? ` at ${ref}` : ''}`);
        const c = cloneRepo(place.url, { ref, spawn, tmpBase, env, allowFile });
        clones.push(c);
        parts.push({ name: partName(nameFromUrl(place.url), taken, audit.reservedPartName), dir: c.dir, info: { source: 'git', url: safeUrl(place.url), ...(ref ? { ref } : {}), commit: c.commit } });
      } else {
        const top = gitTop(place.path);
        const raw = top && realDir(top) === place.path ? audit.repoName(place.path) : path.basename(place.path);
        parts.push({ name: partName(raw, taken, audit.reservedPartName), dir: place.path, info: { source: 'folder', path: place.path, ...gitState(place.path) } });
      }
    }
    const describe = (p) => ({ name: p.name, ...p.info });
    // A lone clone (a URL run from a plain folder) is copied too, with no
    // prefix: its paths read as in its own repo.
    const single = parts.length === 1;
    stageTmp = fs.mkdtempSync(path.join(tmpBase, 'atris-sentinel-review-'));
    const root = path.join(stageTmp, single ? parts[0].name : 'system');
    fs.mkdirSync(root);
    const budget = { bytes: 0 };
    const files = [];
    const allowed = new Set();
    for (const p of parts) {
      const got = copyPart(audit, p, root, budget, single ? '' : p.name);
      p.files = got.files;
      files.push(...got.files);
      const copied = new Set(got.files);
      for (const f of got.allowed) if (copied.has(f)) allowed.add(f);
    }
    const name = parts.map((p) => p.name).sort().join('+').slice(0, 100);
    const described = parts.map(describe);
    const seams = single ? [] : findSeams(audit, root, parts);
    audit.registerSystem(root, { name, parts: described, files: files.sort(), allowed, seams, single });
    registered = root;
    return { root, name, parts: described, multi: !single, seams, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

// The command that runs a review of several places again from one of its
// folders: every other part comes back as --with.
function rerunLine(parts, here, cwd) {
  const others = parts.filter((p) => p && p.name !== here);
  const words = others.map((p) => {
    if (p.source === 'git') return safeUrl(p.url);
    const rel = path.relative(cwd, p.path);
    return rel && rel.length < p.path.length ? rel : p.path;
  });
  const ref = others.find((p) => p.ref);
  return ['atris sentinel', ...words.map((w) => `--with ${/[\s'"]/.test(w) ? JSON.stringify(w) : w}`), ...(ref ? [`--ref ${ref.ref}`] : [])].join(' ');
}

module.exports = {
  isGitUrl,
  safeUrl,
  nameFromUrl,
  partName,
  resolvePlaces,
  cloneRepo,
  buildSystem,
  rerunLine,
};
