'use strict';

// A person's Atris memory folder on this laptop: copy it down, see what changed
// here, send changes back. The server is the source of truth. Everything here
// works from a small hidden state file that remembers, for each file, the
// fingerprint it had on the server at the last pull.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const transfer = require('./memory-files');

const STATE_FILE = '.atris-memory.json';
const WRITABLE_PREFIXES = ['wiki/', 'files/'];
const MAX_WRITE_BYTES = 1000000;
const READ_PAGE = 400;
const FETCH_PARALLEL = 6;
const MAX_FOLDERS = 2000;
const MAX_LOCAL_FILES = 20000;
const MAX_DEPTH = 24;

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// A path inside the folder, or null. Rejects '..', absolute paths, drive
// letters, backslashes, empty parts and hidden parts (the state file is hidden,
// so hidden names are never copied in either direction).
function cleanRel(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 400) return null;
  if (rel.startsWith('/') || rel.includes('\\') || rel.includes('\0') || /^[A-Za-z]:/.test(rel)) return null;
  const parts = rel.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..' || part.startsWith('.'))) return null;
  return rel;
}

function isWritable(rel) {
  return WRITABLE_PREFIXES.some((prefix) => rel.startsWith(prefix));
}

// Pages and files that push --prune may remove from the server. wiki/learning.md
// is a note the server keeps in step with remember, so it is never removed.
const SERVER_NOTES = new Set(['wiki/learning.md']);

function isRemovable(rel) {
  return isWritable(rel) && !SERVER_NOTES.has(rel);
}

function insideRoot(rootReal, target) {
  const rel = path.relative(rootReal, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Where a file lives on disk. Builds its folders one step at a time and refuses
// any step that is a link or a file, so nothing can lead out of the target
// folder. The file itself must not be a link either.
function localTarget(rootReal, rel) {
  const clean = cleanRel(rel);
  if (!clean) throw new Error(`unsafe path: ${String(rel).slice(0, 80)}`);
  const parts = clean.split('/');
  let current = rootReal;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    let info = null;
    try { info = fs.lstatSync(current); } catch { /* not there yet */ }
    if (!info) fs.mkdirSync(current);
    else if (!info.isDirectory()) throw new Error(`not a plain folder: ${path.relative(rootReal, current)}`);
  }
  const abs = path.join(current, parts[parts.length - 1]);
  if (!insideRoot(rootReal, abs)) throw new Error(`unsafe path: ${clean}`);
  let info = null;
  try { info = fs.lstatSync(abs); } catch { /* new file */ }
  if (info && !info.isFile()) throw new Error(`not a plain file: ${clean}`);
  return abs;
}

function writeFileAtomic(abs, text) {
  const temp = path.join(path.dirname(abs), `.${path.basename(abs)}.atris-tmp-${process.pid}`);
  try {
    fs.writeFileSync(temp, text, 'utf8');
    fs.renameSync(temp, abs);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* nothing to clean */ }
    throw error;
  }
}

function loadState(rootDir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(rootDir, STATE_FILE), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let state;
  try { state = JSON.parse(raw); } catch { state = null; }
  if (!state || typeof state !== 'object' || !state.files || typeof state.files !== 'object') {
    throw new Error(`${STATE_FILE} is unreadable. Delete it and pull again; your files are kept.`);
  }
  return state;
}

function saveState(rootDir, state) {
  writeFileAtomic(path.join(rootDir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

// Every plain file under the folder, hidden names and links skipped.
function scanLocal(rootDir) {
  const files = new Map();
  const skipped = [];
  const walk = (dir, prefix, depth) => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const rel = prefix + entry.name;
      if (entry.isSymbolicLink()) { skipped.push({ path: rel, reason: 'is a link' }); continue; }
      if (entry.isDirectory()) { walk(path.join(dir, entry.name), `${rel}/`, depth + 1); continue; }
      if (!entry.isFile()) continue;
      if (!cleanRel(rel)) { skipped.push({ path: rel, reason: 'has an unsafe name' }); continue; }
      if (files.size >= MAX_LOCAL_FILES) { skipped.push({ path: rel, reason: 'too many files' }); continue; }
      files.set(rel, path.join(dir, entry.name));
    }
  };
  walk(rootDir, '', 0);
  return { files, skipped };
}

// What differs from the last pull. Files are compared by fingerprint.
function diffLocal(rootDir, state) {
  const { files, skipped } = scanLocal(rootDir);
  const modified = [];
  const added = [];
  let unchanged = 0;
  for (const [rel, abs] of files) {
    const known = state.files[rel];
    let hash;
    try { hash = transfer.hashFileSync(abs).sha256; } catch { skipped.push({ path: rel, reason: 'could not be read' }); continue; }
    if (!known) added.push(rel);
    else if (known.sha256 !== hash) modified.push(rel);
    else unchanged += 1;
  }
  const deleted = Object.keys(state.files).filter((rel) => !files.has(rel));
  return { modified, added, deleted, unchanged, skipped };
}

function decodeText(buffer) {
  try { return utf8.decode(buffer); } catch { return null; }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function apiError(result, what) {
  if (result && result.status === 401) {
    const error = new Error('your Atris login was not accepted. Run: atris login');
    error.status = 401;
    return error;
  }
  const detail = result && result.error;
  const message = detail && typeof detail === 'object' ? JSON.stringify(detail) : String(detail || 'request failed');
  const error = new Error(`${what}: ${message.replace(/\s+/g, ' ').slice(0, 200)}`);
  error.status = result ? result.status : 0;
  return error;
}

// The few server calls this needs. `request` is the CLI's API helper.
function memoryClient(request, token) {
  const call = (pathname, options = {}) => request(pathname, { token, timeoutMs: 30000, ...options });
  const query = (value) => encodeURIComponent(value);
  const client = {
    usedLineFallback: false,
    rawFileMissing: false,
    filesSupported: null, // false once the server shows it has no file links yet
    sizes: new Map(), // bytes of each file, from the listing

    async list() {
      const found = [];
      let level = [''];
      let folders = 0;
      while (level.length) {
        folders += level.length;
        if (folders > MAX_FOLDERS) throw new Error('the folder has too many sub-folders to copy');
        const pages = await mapLimit(level, 4, async (folder) => {
          const result = await call(`/memory/ls?folder=${query(folder)}`);
          if (!result.ok) throw apiError(result, 'could not list the folder');
          return { folder, items: (result.data && result.data.items) || [] };
        });
        level = [];
        for (const { folder, items } of pages) {
          for (const item of items) {
            const name = String(item.name || '');
            const full = folder ? `${folder}/${name}` : name;
            if (!name.endsWith('/')) { found.push(full); client.sizes.set(full, Number(item.size)); }
            else if (cleanRel(full.slice(0, -1))) level.push(full.slice(0, -1));
            else found.push(full); // never descended; pull counts it as an unsafe name
          }
        }
      }
      return found.sort();
    },

    // { exists: false } when the server has no such file; throws on any other trouble.
    async read(rel) {
      if (!client.rawFileMissing) {
        const result = await call(`/memory/file?path=${query(rel)}`);
        if (result.ok && result.data && typeof result.data.text === 'string') {
          return { exists: true, text: result.data.text };
        }
        if (result.status === 404) client.rawFileMissing = true;
        else if (/^No file at/.test(String(result.error || ''))) return { exists: false };
        else throw apiError(result, `could not read ${rel}`);
      }
      // The server is older than the exact-file call: page through numbered lines.
      client.usedLineFallback = true;
      const lines = [];
      for (let start = 1; ; start += READ_PAGE) {
        const result = await call(`/memory/read?path=${query(rel)}&start=${start}&count=${READ_PAGE}`);
        if (!result.ok) {
          if (start === 1 && /^No file at/.test(String(result.error || ''))) return { exists: false };
          throw apiError(result, `could not read ${rel}`);
        }
        const data = result.data || {};
        for (const line of data.lines || []) lines.push(String(line.text));
        if (!data.more || start > 2000000) break;
      }
      return { exists: true, text: lines.length ? `${lines.join('\n')}\n` : '' };
    },

    async write(rel, text) {
      const result = await call('/memory/write', { method: 'PUT', body: { path: rel, text } });
      if (!result.ok) throw apiError(result, `could not save ${rel}`);
    },

    // true when removed, false when the server had no such file.
    async remove(rel) {
      const result = await call(`/memory/file?path=${query(rel)}`, { method: 'DELETE' });
      if (result.ok) return true;
      if (result.status === 404 && /^No file at/.test(String(result.error || ''))) return false;
      if (result.status === 404 || result.status === 405) {
        const error = new Error('the Atris server cannot delete pages yet');
        error.status = result.status;
        throw error;
      }
      throw apiError(result, `could not remove ${rel}`);
    },

    // A short-lived download link plus size and fingerprint, or { exists: false }.
    async link(rel) {
      const result = await call(`/memory/link?path=${query(rel)}`);
      if (result.ok && result.data && result.data.url) {
        client.filesSupported = true;
        return { exists: true, ...result.data };
      }
      if (result.status === 404 && /^No file at/.test(String(result.error || ''))) return { exists: false };
      if (result.status === 404 || result.status === 405) throw noFiles(client);
      throw apiError(result, `could not look up ${rel}`);
    },

    // The server checks the upload like a write and signs a form for exactly this file.
    async startUpload(rel, bytes) {
      const result = await call('/memory/upload', { method: 'POST', body: { path: rel, size: bytes } });
      if (result.ok && result.data && result.data.url && result.data.token) return result.data;
      if ((result.status === 404 && result.error === 'Not Found') || result.status === 405) throw noFiles(client);
      throw apiError(result, `could not send ${rel}`);
    },

    async finishUpload(token) {
      const result = await call('/memory/upload/done', { method: 'POST', body: { token }, timeoutMs: 120000 });
      if (result.ok && result.data) return result.data;
      throw apiError(result, 'the server could not confirm it arrived');
    },
  };
  return client;
}

function noFiles(client) {
  client.filesSupported = false;
  const error = new Error('the Atris server cannot take files yet');
  error.noFiles = true;
  return error;
}

// Whether the server copy of rel may be replaced or removed. "same": it already
// holds these bytes. "clear": it holds what was pulled last, or nothing.
// "changed": it changed since the last pull, so it is never overwritten.
// Files fetched as files are compared by S3 fingerprint, pages by their text.
async function serverCheck(client, rel, base, local, { asFile = false } = {}) {
  if ((asFile || (base && base.etag)) && client.filesSupported !== false) {
    const info = await client.link(rel);
    if (!info.exists) return { verdict: 'clear', exists: false };
    if (local && info.md5 && info.md5 === local.md5 && info.bytes === local.bytes) {
      return { verdict: 'same', exists: true, etag: info.etag };
    }
    if (base && base.etag && base.etag === info.etag) return { verdict: 'clear', exists: true };
    if (base && base.md5 && info.md5 && base.md5 === info.md5) return { verdict: 'clear', exists: true };
    if (!base || base.etag) return { verdict: 'changed', exists: true };
    // A page pulled as text: compare its text below.
  }
  const current = await client.read(rel);
  if (!current.exists) return { verdict: 'clear', exists: false };
  const serverSha = sha256(Buffer.from(current.text, 'utf8'));
  if (local && serverSha === local.sha256) return { verdict: 'same', exists: true };
  return { verdict: base && serverSha === base.sha256 ? 'clear' : 'changed', exists: true };
}

// Copy one file down as a file: streamed to a hidden temp name beside it,
// checked against S3's size and fingerprint, then moved into place. Same rules
// as a page: an edit here or a change on both sides is never overwritten.
// false when the server has no file links yet, so the caller copies it as text.
async function pullFile({ rootReal, rel, client, state, out, onProgress }) {
  let temp = null;
  try {
    const link = await client.link(rel);
    if (!link.exists) return true;
    const abs = localTarget(rootReal, rel);
    const base = state.files[rel] || null;
    const local = fs.existsSync(abs) ? transfer.hashFileSync(abs) : null;
    const record = (print) => ({ sha256: print.sha256, bytes: print.bytes, md5: print.md5, etag: link.etag });
    if (base && base.etag && base.etag === link.etag && local) {
      // The server copy is the one pulled last time: nothing to fetch.
      if (local.sha256 === base.sha256) out.same += 1; else out.keptLocal.push(rel);
      return true;
    }
    if (local && link.md5 && local.md5 === link.md5 && local.bytes === link.bytes) {
      out.same += 1;
      state.files[rel] = record(local);
      return true;
    }
    temp = transfer.tempBeside(abs);
    const progress = onProgress && ((done, total) => onProgress({ rel, verb: 'Fetching', done, total }));
    let got;
    try {
      got = await transfer.fetchFile({ url: link.url, temp, bytes: link.bytes, onProgress: progress });
    } finally {
      if (onProgress) onProgress({ rel, verb: 'Fetching', done: link.bytes, total: link.bytes, finished: true });
    }
    if (got.bytes !== link.bytes || (link.md5 && got.md5 !== link.md5)) {
      throw new Error('it arrived damaged (its fingerprint did not match), so it was not kept. Pull again');
    }
    if (local && local.sha256 === got.sha256) {
      out.same += 1;
    } else if (!local || (base && local.sha256 === base.sha256)) {
      fs.renameSync(temp, abs);
      temp = null;
      out[local ? 'updated' : 'added'].push(rel);
    } else {
      out[base && got.sha256 === base.sha256 ? 'keptLocal' : 'conflicts'].push(rel);
      return true;
    }
    state.files[rel] = record(got);
    return true;
  } catch (error) {
    if (error.noFiles) return false;
    out.failed.push({ path: rel, error: error.message });
    return true;
  } finally {
    if (temp) { try { fs.unlinkSync(temp); } catch { /* never made */ } }
  }
}

// Send one big or binary file under files/: check the server copy, ask for a
// signed form, stream the file to storage, then confirm. A failed send is
// still confirmed, so the room the server held for it is given back.
async function pushFile({ rootReal, rel, small, client, state, out, onProgress }) {
  const abs = path.join(rootReal, ...rel.split('/'));
  const base = state.files[rel] || null;
  try {
    const local = transfer.hashFileSync(abs);
    const check = await serverCheck(client, rel, base, local, { asFile: true });
    if (check.verdict === 'same') {
      state.files[rel] = { sha256: local.sha256, bytes: local.bytes, md5: local.md5, etag: check.etag };
      out.alreadyThere.push(rel);
      return;
    }
    if (check.verdict === 'changed') { out.conflicts.push(rel); return; }
    const form = await client.startUpload(rel, local.bytes);
    const progress = onProgress && ((done, total) => onProgress({ rel, verb: 'Sending', done, total }));
    let sent;
    try {
      sent = await transfer.sendFile({ url: form.url, fields: form.fields, abs, bytes: local.bytes, onProgress: progress });
    } catch (error) {
      await client.finishUpload(form.token).catch(() => {});
      throw error;
    } finally {
      if (onProgress) onProgress({ rel, verb: 'Sending', done: local.bytes, total: local.bytes, finished: true });
    }
    const done = await client.finishUpload(form.token);
    if (Number(done.bytes) !== sent.bytes || (done.md5 && done.md5 !== sent.md5)) {
      throw new Error('it arrived damaged (its fingerprint did not match). Push again');
    }
    state.files[rel] = { sha256: sent.sha256, bytes: sent.bytes, md5: sent.md5, etag: done.etag };
    out.pushed.push(rel);
  } catch (error) {
    if (error.noFiles) out[small ? 'notText' : 'tooBig'].push(rel); // an older server: as before
    else out.failed.push({ path: rel, error: error.message });
  }
}

// Small files in parallel, large ones one at a time so each gets its own progress line.
async function moveFiles(list, sizeOf, fn) {
  await mapLimit(list.filter((item) => sizeOf(item) < transfer.LARGE_BYTES), 4, fn);
  for (const item of list.filter((each) => sizeOf(each) >= transfer.LARGE_BYTES)) await fn(item);
}

function checkAccount(state, account) {
  if (state.account && account && state.account !== account) {
    throw new Error('this folder was pulled from a different Atris account. Use another folder, or run: atris whoami');
  }
}

async function pullFolder({ dir, client, account = null, now = () => new Date(), onProgress = null }) {
  fs.mkdirSync(dir, { recursive: true });
  const rootReal = fs.realpathSync(dir);
  const state = loadState(rootReal) || { version: 1, files: {} };
  checkAccount(state, account);
  if (account) state.account = account;

  const remote = await client.list();
  const out = { total: remote.length, added: [], updated: [], same: 0, keptLocal: [], conflicts: [], failed: [], unsafe: [], gone: 0 };
  const movedAsFile = (rel) => Boolean(state.files[rel] && state.files[rel].etag);
  const asFiles = remote.filter((rel) => cleanRel(rel) && (transfer.goesAsFile(rel, client.sizes.get(rel)) || movedAsFile(rel)));

  const pullText = async (rel) => {
    if (!cleanRel(rel)) { out.unsafe.push(rel); return; }
    let file;
    try { file = await client.read(rel); } catch (error) {
      // A .csv or .txt that is not UTF-8, sent from another laptop as a file: fetch it as one.
      if (rel.startsWith('files/') && client.filesSupported !== false
        && await pullFile({ rootReal, rel, client, state, out, onProgress })) return;
      out.failed.push({ path: rel, error: error.message });
      return;
    }
    if (!file.exists) return;
    const remoteSha = sha256(Buffer.from(file.text, 'utf8'));
    const base = state.files[rel] ? state.files[rel].sha256 : null;
    let abs;
    try {
      abs = localTarget(rootReal, rel);
      let localSha = null;
      try { localSha = transfer.hashFileSync(abs).sha256; } catch { /* no local copy */ }
      const { md5 } = transfer.printOf(Buffer.from(file.text, 'utf8'));
      const record = { sha256: remoteSha, bytes: Buffer.byteLength(file.text, 'utf8'), md5 };
      if (localSha === remoteSha) {
        out.same += 1;
        state.files[rel] = record;
      } else if (localSha === null) {
        writeFileAtomic(abs, file.text);
        state.files[rel] = record;
        out.added.push(rel);
      } else if (base && localSha === base) {
        writeFileAtomic(abs, file.text);
        state.files[rel] = record;
        out.updated.push(rel);
      } else if (base && remoteSha === base) {
        out.keptLocal.push(rel);
      } else {
        out.conflicts.push(rel);
      }
    } catch (error) {
      out.failed.push({ path: rel, error: error.message });
    }
  };
  const fileSet = new Set(asFiles);
  await mapLimit(remote.filter((rel) => !fileSet.has(rel)), FETCH_PARALLEL, pullText);
  await moveFiles(asFiles, (rel) => client.sizes.get(rel) || 0, async (rel) => {
    const done = client.filesSupported !== false && await pullFile({ rootReal, rel, client, state, out, onProgress });
    if (!done) await pullText(rel); // an older server: copy it as text, as before
  });

  const onServer = new Set(remote);
  for (const rel of Object.keys(state.files)) {
    if (!onServer.has(rel)) { delete state.files[rel]; out.gone += 1; }
  }
  state.pulled_at = now().toISOString();
  saveState(rootReal, state);
  for (const key of ['added', 'updated', 'keptLocal', 'conflicts', 'unsafe']) out[key].sort();
  out.usedLineFallback = client.usedLineFallback;
  return out;
}

// Remove from the server the pages deleted here since the last pull. Only
// wiki/ and files/, and only while the server copy is still the one pulled, so
// a page someone changed elsewhere is never lost. onPrune hears the list first.
async function pruneDeleted({ state, client, deleted, out, onPrune }) {
  const doomed = deleted.filter(isRemovable).sort();
  Object.assign(out, {
    pruned: true, removed: [], alreadyGone: [], changedOnServer: [],
    notRemovable: deleted.filter((rel) => !isRemovable(rel)).sort(),
  });
  if (onPrune && doomed.length) onPrune(doomed);
  await mapLimit(doomed, 4, async (rel) => {
    try {
      const current = await serverCheck(client, rel, state.files[rel], null);
      if (current.verdict === 'changed') {
        out.changedOnServer.push(rel);
        return;
      }
      const removed = current.exists && await client.remove(rel);
      out[removed ? 'removed' : 'alreadyGone'].push(rel);
      delete state.files[rel];
    } catch (error) {
      out.failed.push({ path: rel, error: error.message, removing: true });
    }
  });
  for (const key of ['removed', 'alreadyGone', 'changedOnServer']) out[key].sort();
}

async function pushFolder({ dir, client, account = null, prune = false, onPrune = null, onProgress = null }) {
  let rootReal;
  try { rootReal = fs.realpathSync(dir); } catch { rootReal = null; }
  const state = rootReal ? loadState(rootReal) : null;
  if (!state) throw new Error(`${dir} has not been pulled yet. Run: atris memory pull`);
  checkAccount(state, account);

  const change = diffLocal(rootReal, state);
  const changed = [...change.modified, ...change.added].sort();
  const out = {
    pushed: [], alreadyThere: [], conflicts: [], failed: [], tooBig: [], notText: [],
    notPushable: changed.filter((rel) => !isWritable(rel)),
    deletedHere: change.deleted, skipped: change.skipped,
  };

  const asFiles = [];
  await mapLimit(changed.filter(isWritable), 4, async (rel) => {
    const abs = path.join(rootReal, ...rel.split('/'));
    let bytes;
    try { bytes = fs.statSync(abs).size; } catch (error) { out.failed.push({ path: rel, error: error.message }); return; }
    // Only a file small enough to be a page is read whole; anything bigger is streamed.
    const buffer = bytes <= MAX_WRITE_BYTES ? fs.readFileSync(abs) : null;
    const text = buffer && decodeText(buffer);
    if (text === null || text === undefined) {
      if (rel.startsWith('files/')) asFiles.push({ rel, bytes, small: Boolean(buffer) });
      else out[buffer ? 'notText' : 'tooBig'].push(rel); // pages under wiki/ stay text up to 1 MB
      return;
    }
    const local = transfer.printOf(buffer);
    try {
      const current = await serverCheck(client, rel, state.files[rel], local);
      if (current.verdict === 'same') {
        state.files[rel] = { sha256: local.sha256, bytes: buffer.length, md5: local.md5 };
        out.alreadyThere.push(rel);
        return;
      }
      if (current.verdict === 'changed') { out.conflicts.push(rel); return; }
      await client.write(rel, text);
      state.files[rel] = { sha256: local.sha256, bytes: buffer.length, md5: local.md5 };
      out.pushed.push(rel);
    } catch (error) {
      out.failed.push({ path: rel, error: error.message });
    }
  });
  await moveFiles(asFiles, (item) => item.bytes, (item) => pushFile({ rootReal, ...item, client, state, out, onProgress }));
  if (prune) await pruneDeleted({ state, client, deleted: change.deleted, out, onPrune });

  saveState(rootReal, state);
  for (const key of ['pushed', 'alreadyThere', 'conflicts', 'tooBig', 'notText']) out[key].sort();
  return out;
}

function statusFolder({ dir }) {
  let rootReal;
  try { rootReal = fs.realpathSync(dir); } catch { rootReal = null; }
  const state = rootReal ? loadState(rootReal) : null;
  if (!state) throw new Error(`${dir} has not been pulled yet. Run: atris memory pull`);
  const change = diffLocal(rootReal, state);
  return {
    modified: change.modified.sort(),
    added: change.added.sort(),
    deleted: change.deleted.sort(),
    unchanged: change.unchanged,
    skipped: change.skipped,
    pulledAt: state.pulled_at || null,
  };
}

module.exports = {
  STATE_FILE,
  cleanRel,
  isRemovable,
  isWritable,
  memoryClient,
  pullFolder,
  pushFolder,
  statusFolder,
};
