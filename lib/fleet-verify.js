'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { fork, spawn } = require('node:child_process');
require('./task-db'); // Install the CLI's existing node:sqlite warning filter.
const { DatabaseSync } = require('node:sqlite');

const MAX_BYTES = 8192;
const JOINT = '$joint';
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function shape(value, keys, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) {
    throw new Error(`invalid ${field}: expected fields ${keys.join(', ')}`);
  }
}

function integer(value, fallback, max, field) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${field} must be in 1..${max}`);
  return value;
}

function verifier(argv, names = []) {
  if (!Array.isArray(argv) || !argv.length || argv.length > 128 || !argv[0] ||
      argv.some(value => typeof value !== 'string' || value.includes('\0') || value.length > 8192)) {
    throw new Error('verify must be a nonempty command argument array');
  }
  for (const arg of argv) {
    if (arg.includes('{repo:') && !names.some(name => arg === `{repo:${name}}`)) {
      throw new Error(`invalid repository placeholder: ${arg}`);
    }
  }
  return argv;
}

function readManifest(file) {
  if (!file) throw new Error('usage: atris fleet verify <manifest.json> [--retry-failed] [--json]');
  if (fs.statSync(file).size > 512 * 1024) throw new Error('manifest exceeds 512 KiB');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  shape(doc, ['version', 'targets', 'joint', 'timeout_seconds', 'parallel'], 'manifest');
  if (doc.version !== 1) throw new Error('manifest version must be 1');
  if (!Array.isArray(doc.targets) || doc.targets.length < 1 || doc.targets.length > 16) throw new Error('provide 1..16 targets');
  const targets = doc.targets.map(target => {
    shape(target, ['name', 'repo', 'revision', 'verify'], 'target');
    if (typeof target.name !== 'string' || !/^[a-zA-Z0-9][\w.-]{0,47}$/.test(target.name)) throw new Error('invalid target name');
    if (typeof target.repo !== 'string' || !target.repo.trim() || target.repo.includes('\0')) throw new Error('repo must be a local path');
    if (typeof target.revision !== 'string' || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(target.revision)) {
      throw new Error('revision must be a full Git commit object ID');
    }
    return { name: target.name, repo: path.resolve(path.dirname(file), target.repo),
      revision: target.revision.toLowerCase(), verify: verifier(target.verify) };
  });
  const names = targets.map(t => t.name);
  if (new Set(names.map(name => name.toLowerCase())).size !== names.length) throw new Error('target names must be unique');
  shape(doc.joint, ['cwd', 'verify'], 'joint');
  if (!names.includes(doc.joint.cwd)) throw new Error('joint.cwd must name a target');
  return { version: 1, targets, joint: { cwd: doc.joint.cwd, verify: verifier(doc.joint.verify, names) },
    timeout_seconds: integer(doc.timeout_seconds, 60, 300, 'timeout_seconds'), parallel: integer(doc.parallel, 2, 4, 'parallel') };
}

function stopGroup(child) {
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

// Keep only a bounded preview but hash every byte. The supervisor hosting this
// function for a verifier retains its deadline even if the invoking CLI dies.
function command(argv, cwd, env, deadline, supervise = false) {
  return new Promise((resolve, reject) => {
    if (Date.now() >= deadline) { reject(new Error('check time budget expired')); return; }
    const child = spawn(argv[0], argv.slice(1), {
      cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    let interrupted = false;
    function stop() {
      interrupted = true;
      if (child.pid) stopGroup(child);
      child.stdout.destroy();
      child.stderr.destroy();
    }
    const timer = setTimeout(stop, Math.max(1, deadline - Date.now()));
    if (supervise) process.once('disconnect', stop);
    const streams = [child.stdout, child.stderr].map(pipe => {
      let preview = Buffer.alloc(0);
      let size = 0;
      const digest = crypto.createHash('sha256');
      pipe.on('data', chunk => {
        size += chunk.length;
        digest.update(chunk);
        if (preview.length < MAX_BYTES) preview = Buffer.concat([preview, chunk.subarray(0, MAX_BYTES - preview.length)]);
      });
      return () => ({ text: preview.toString('utf8'), bytes: size, sha256: digest.digest('hex') });
    });
    child.once('error', error => {
      clearTimeout(timer);
      if (supervise) process.removeListener('disconnect', stop);
      reject(error);
    });
    child.once('exit', () => { if (child.pid) stopGroup(child); });
    child.once('close', (exit_code, signal) => {
      clearTimeout(timer);
      if (supervise) process.removeListener('disconnect', stop);
      resolve({ exit_code, signal, interrupted, stdout: streams[0](), stderr: streams[1]() });
    });
  });
}

if (require.main === module && process.argv[2] === 'check') {
  process.once('message', async ({ argv, cwd, env, deadline, temporaryDirectory }) => {
    let outcome;
    try { outcome = { result: await command(argv, cwd, env, deadline, true) }; }
    catch (error) { outcome = { error: error.message }; }
    // The parent may have disappeared during the verifier. This supervisor
    // still owns the disposable checkouts and its timeout.
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    if (process.connected) process.send(outcome, () => { if (process.connected) process.disconnect(); });
  });
}

function supervised(argv, cwd, env, deadline, temporaryDirectory) {
  return new Promise((resolve, reject) => {
    const worker = fork(__filename, ['check'], { env, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const timer = setTimeout(() => { if (worker.connected) worker.disconnect(); }, Math.max(1, deadline - Date.now()) + 250);
    worker.once('error', reject);
    worker.once('message', resolve);
    worker.once('exit', () => { clearTimeout(timer); reject(new Error('verifier supervisor exited before returning a receipt')); });
    worker.send({ argv, cwd, env, deadline, temporaryDirectory }, error => { if (error) reject(error); });
  });
}

async function snapshot(target, folder, env, deadline) {
  const repo = fs.realpathSync(target.repo);
  if (!fs.statSync(repo).isDirectory()) throw new Error(`${target.name}: local repo directory is unavailable`);
  fs.mkdirSync(folder);
  async function git(args, cwd = folder) {
    const out = await command(['git', '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always', ...args], cwd, env, deadline);
    if (out.exit_code !== 0 || out.interrupted) throw new Error(`${target.name}: ${out.stderr.text.trim() || 'Git snapshot failed'}`);
    return out.stdout.text.trim();
  }
  const oid = await git(['rev-parse', '--verify', target.revision + '^{commit}'], repo);
  if (oid !== target.revision) throw new Error(`${target.name}: revision does not identify that exact commit`);
  await git(['init', '--quiet', '--template=', '--object-format=' + (oid.length === 40 ? 'sha1' : 'sha256')]);
  await git(['fetch', '--quiet', '--no-tags', '--depth=1', '--', repo, oid]);
  await git(['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
  if (await git(['rev-parse', 'HEAD']) !== oid) throw new Error(`${target.name}: checked-out revision differs from manifest`);
}

function readTicket(db, name) {
  return db.prepare('SELECT * FROM tickets WHERE name=?').get(name);
}

function ticket(db, row, name, revision, input, retryFailed) {
  const result = { name, revision, state: row.state, exit_code: null, cached: false };
  if (row.state === 'running') {
    let alive = true;
    try { process.kill(row.pid, 0); } catch (e) { alive = e.code !== 'ESRCH'; }
    const expired = row.deadline !== null && Date.now() > row.deadline + 5000;
    const unknown = !alive || expired;
    const detail = unknown ? 'the verifier stopped without a receipt; reconcile before any new attempt' : 'another verifier owns this ticket';
    if (unknown) db.prepare("UPDATE tickets SET state='uncertain',detail=? WHERE name=? AND state='running' AND pid=? AND attempt_id IS ?")
      .run(detail, name, row.pid, row.attempt_id);
    return { ...result, state: unknown ? 'uncertain' : 'in_progress', detail };
  }
  if (row.state === 'uncertain') return { ...result, detail: row.detail || 'verifier outcome unknown' };
  if (row.state === 'passed' || row.state === 'failed') {
    const evidence = JSON.parse(row.receipt);
    const { receipt_id, ...body } = evidence;
    if (input !== row.input_hash || body.input_hash !== input || receipt_id !== hash(body) || row.state !== body.state) {
      throw new Error(`invalid saved receipt for ${name}`);
    }
    if (row.state === 'passed' || !retryFailed) return { ...evidence, cached: true };
  }
  return null;
}

async function perform(db, manifestId, manifest, spec, dependencies, scratch, retryFailed) {
  const isJoint = spec.name === JOINT;
  const input = hash([manifestId, spec.name, dependencies]);
  const initial = readTicket(db, spec.name);
  const current = () => ticket(db, readTicket(db, spec.name), spec.name, spec.revision, input, false);
  const cached = ticket(db, initial, spec.name, spec.revision, input, retryFailed);
  if (cached) return cached;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-fleet-verify-'));
  scratch.add(dir);
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: dir,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const snapshots = new Map();
  const deadline = Date.now() + manifest.timeout_seconds * 1000;
  // Joint verification starts from fresh commits. Files written by the earlier
  // target verifiers are disposable and cannot become evidence for their join.
  try {
    const copies = path.join(dir, 'repos');
    fs.mkdirSync(copies);
    for (const target of isJoint ? manifest.targets : [spec]) {
      const dest = path.join(copies, target.name);
      await snapshot(target, dest, env, deadline);
      snapshots.set(target.name, dest);
    }
  } catch (error) {
    const unavailable = { name: spec.name, revision: spec.revision, state: 'unavailable', exit_code: null, cached: false, detail: error.message };
    if (initial.state === 'failed' && retryFailed) {
      const held = db.prepare("UPDATE tickets SET detail=? WHERE name=? AND state='failed' AND receipt=?")
        .run(error.message, spec.name, initial.receipt);
      if (held.changes) return { ...unavailable, previous_receipt_id: JSON.parse(initial.receipt).receipt_id };
    }
    db.prepare("UPDATE tickets SET state='unavailable',detail=? WHERE name=? AND state IN ('pending','unavailable')").run(error.message, spec.name);
    return current() || unavailable;
  }
  const attempt = crypto.randomUUID();
  const claimed = db.prepare(`UPDATE tickets SET state='running',pid=?,input_hash=?,attempt_id=?,deadline=?,detail=NULL
    WHERE name=? AND (state IN ('pending','unavailable') OR (state='failed' AND ?=1 AND receipt=?))`)
    .run(process.pid, input, attempt, deadline, spec.name, Number(retryFailed), initial.receipt);
  if (!claimed.changes) return current() || { name: spec.name, revision: spec.revision, state: 'pending', exit_code: null, cached: false };
  const argv = spec.verify.map(arg => arg.startsWith('{repo:') ? snapshots.get(arg.slice('{repo:'.length, -1)) : arg);
  const cwd = snapshots.get(isJoint ? manifest.joint.cwd : spec.name);
  try {
    const answer = await supervised(argv, cwd, env, deadline, dir);
    if (answer.error) {
      db.prepare("UPDATE tickets SET state='unavailable',detail=?,pid=NULL WHERE name=? AND attempt_id=?")
        .run(answer.error, spec.name, attempt);
      return { name: spec.name, revision: spec.revision, state: 'unavailable', exit_code: null, cached: false, detail: answer.error };
    }
    const out = answer.result;
    if (out.interrupted || out.signal || !Number.isInteger(out.exit_code)) throw new Error('verifier was interrupted; reconcile its effects before retrying');
    const body = {
      name: spec.name,
      revision: spec.revision,
      attempt_id: attempt,
      state: out.exit_code === 0 ? 'passed' : 'failed',
      exit_code: out.exit_code,
      input_hash: input,
      verify: spec.verify,
      ...(isJoint ? { target_receipts: dependencies } : {}),
      stdout: out.stdout,
      stderr: out.stderr,
    };
    const receipt = { ...body, receipt_id: hash(body) };
    const document = JSON.stringify(receipt);
    db.exec('BEGIN IMMEDIATE');
    try {
      const saved = db.prepare('UPDATE tickets SET state=?,receipt=?,pid=NULL WHERE name=? AND attempt_id=?')
        .run(body.state, document, spec.name, attempt);
      if (!saved.changes) throw new Error('the ticket changed before the receipt was saved');
      db.prepare('INSERT INTO receipts(receipt_id,name,document) VALUES (?,?,?)').run(receipt.receipt_id, spec.name, document);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return { ...receipt, cached: false };
  } catch (error) {
    db.prepare("UPDATE tickets SET state='uncertain',detail=?,pid=NULL WHERE name=? AND attempt_id=?").run(error.message, spec.name, attempt);
    return { name: spec.name, revision: spec.revision, state: 'uncertain', exit_code: null, cached: false, detail: error.message };
  }
}

async function verifyFleet(file, { root = process.cwd(), retryFailed = false } = {}) {
  const manifest = readManifest(file);
  const manifest_id = hash(manifest);
  const state = path.join(root, '.atris', 'state', 'fleet-verify');
  fs.mkdirSync(state, { recursive: true });
  const db = new DatabaseSync(path.join(state, manifest_id + '.sqlite'));
  const scratch = new Set();
  try {
    db.exec(`PRAGMA busy_timeout=10000;
      CREATE TABLE IF NOT EXISTS run (manifest_id TEXT PRIMARY KEY, manifest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (receipt_id TEXT PRIMARY KEY, name TEXT NOT NULL, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tickets (name TEXT PRIMARY KEY, state TEXT NOT NULL, pid INTEGER,
      input_hash TEXT, receipt TEXT, detail TEXT, attempt_id TEXT, deadline INTEGER);`);
    db.exec('BEGIN IMMEDIATE');
    try {
      const columns = new Set(db.prepare('PRAGMA table_info(tickets)').all().map(row => row.name));
      if (!columns.has('attempt_id')) db.exec('ALTER TABLE tickets ADD COLUMN attempt_id TEXT');
      if (!columns.has('deadline')) db.exec('ALTER TABLE tickets ADD COLUMN deadline INTEGER');
      db.exec(`INSERT OR IGNORE INTO receipts(receipt_id,name,document)
        SELECT json_extract(receipt,'$.receipt_id'),name,receipt FROM tickets
        WHERE state IN ('passed','failed') AND receipt IS NOT NULL`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    db.prepare('INSERT OR IGNORE INTO run(manifest_id,manifest) VALUES (?,?)').run(manifest_id, JSON.stringify(manifest));
    const saved = db.prepare('SELECT manifest FROM run WHERE manifest_id=?').get(manifest_id);
    if (saved.manifest !== JSON.stringify(manifest)) throw new Error('saved manifest differs from its identity');
    const add = db.prepare("INSERT OR IGNORE INTO tickets(name,state) VALUES (?,'pending')");
    for (const name of [...manifest.targets.map(t => t.name), JOINT]) add.run(name);
    const targets = new Array(manifest.targets.length);
    let index = 0;
    async function worker() {
      while (index < targets.length) {
        const i = index++;
        targets[i] = await perform(db, manifest_id, manifest, manifest.targets[i], [], scratch, retryFailed);
      }
    }
    // Wait for all active checks before closing the database on any error.
    const settled = await Promise.allSettled(Array.from({ length: Math.min(targets.length, manifest.parallel) }, worker));
    const error = settled.find(v => v.status === 'rejected');
    if (error) throw error.reason;
    let joint = { name: JOINT, state: 'pending', exit_code: null, cached: false };
    if (targets.every(t => t.state === 'passed')) {
      joint = await perform(db, manifest_id, manifest, { name: JOINT, revision: null, verify: manifest.joint.verify },
        targets.map(t => t.receipt_id), scratch, retryFailed);
    }
    for (const result of [...targets, joint]) result.ticket_id = hash([manifest_id, result.name]);
    return { ok: joint.state === 'passed', manifest_id, targets, joint };
  } finally {
    db.close();
    for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { verifyFleet };
