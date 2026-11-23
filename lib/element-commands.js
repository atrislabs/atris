'use strict';

// Deterministic slash workflows on Element (vercel/board + Atris):
// Register named shell workflows once, trigger them as /name on any card,
// and post the verified pass/fail receipt back into the thread.
// Zero third-party dependencies.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const feed = require('./feed-core');
const ops = require('./element-ops');

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const BUILTINS = {
  curve: { name: 'curve', builtin: true, description: 'Post the current loss curve and bottleneck summary', command: null, timeout_ms: 15000 },
  doctor: { name: 'doctor', builtin: true, description: 'Post the current Element readiness check', command: null, timeout_ms: 15000 },
};

function cleanName(raw) {
  const name = String(raw || '').trim().replace(/^\/+/, '').toLowerCase();
  if (!NAME_RE.test(name)) {
    throw new feed.FeedError(400, `invalid command name: ${raw} (use letters, digits, dashes or underscores)`);
  }
  return name;
}

function storePath(root) {
  return path.join(root, '.atris', 'state', 'feed', 'commands.json');
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function loadCustomMap(root) {
  const repoFile = path.join(root, '.atris', 'element-commands.json');
  const repoMap = readJson(repoFile, {});
  const stateMap = readJson(storePath(root), {});
  return { ...(repoMap && typeof repoMap === 'object' ? repoMap : {}), ...(stateMap && typeof stateMap === 'object' ? stateMap : {}) };
}

function redactTokens(text) {
  return String(text || '')
    .replace(/\b(?:token|api[_-]?key|secret|password)\s*[=:]\s*\S+/gi, '[redacted]')
    .replace(/(sk-[a-zA-Z0-9_-]{12,}|ghp_[a-zA-Z0-9]{12,}|atris_[a-zA-Z0-9_-]{12,}|Bearer\s+[a-zA-Z0-9._-]{12,})/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}

function addCommand(root, { name, command, description = '', timeoutMs = 60000 } = {}) {
  const clean = cleanName(name);
  if (BUILTINS[clean]) throw new feed.FeedError(400, `cannot overwrite built-in command: /${clean}`);
  const cmd = String(command || '').trim();
  if (!cmd) throw new feed.FeedError(400, 'usage: atris element cmd add <name> "<shell command>" [--description "<text>"]');
  const file = storePath(root);
  const map = readJson(file, {});
  const entry = {
    name: clean,
    builtin: false,
    command: cmd,
    description: String(description || '').trim().slice(0, 200),
    timeout_ms: Math.max(1000, Math.min(Number(timeoutMs) || 60000, 600000)),
    updated_at: new Date().toISOString(),
  };
  map[clean] = entry;
  writeJsonAtomic(file, map);
  return { version: feed.FEED_VERSION, command: entry };
}

function removeCommand(root, rawName) {
  const clean = cleanName(rawName);
  if (BUILTINS[clean]) throw new feed.FeedError(400, `cannot remove built-in command: /${clean}`);
  const file = storePath(root);
  const map = readJson(file, {});
  const existed = Object.prototype.hasOwnProperty.call(map, clean);
  if (existed) {
    delete map[clean];
    writeJsonAtomic(file, map);
  }
  return { version: feed.FEED_VERSION, removed: existed, name: clean };
}

function listCommands(root) {
  const custom = loadCustomMap(root);
  const items = [
    ...Object.values(BUILTINS),
    ...Object.keys(custom).sort().map((k) => ({ ...custom[k], name: k, builtin: false })),
  ];
  return { version: feed.FEED_VERSION, commands: items };
}

async function runSlashCommand(root, rawName, { cardId = null, as = null, env = process.env, deps = {} } = {}) {
  const name = cleanName(rawName);
  let passed = true;
  let exitCode = 0;
  let snippet = '';

  if (name === 'curve') {
    const out = ops.loadCurve(root, { limit: 100, window: 10 });
    const s = out.summary || {};
    snippet = s.total_episodes
      ? `${s.total_episodes} runs, trend ${s.trend}, spend $${Number(s.total_spend_usd || 0).toFixed(2)}, p95 ${s.p95_total_ms}ms, bottleneck ${s.top_bottleneck || 'none'}`
      : 'no episodes recorded yet';
  } else if (name === 'doctor') {
    const report = await require('./feed-team').doctor(root, { call: false, env, deps });
    const checks = Array.isArray(report && report.checks) ? report.checks : [];
    const bad = checks.filter((c) => !c.ok).map((c) => c.name);
    passed = bad.length === 0;
    exitCode = passed ? 0 : 1;
    snippet = passed ? `all ${checks.length} checks ready` : `needs attention: ${bad.join(', ')}`;
  } else {
    const custom = loadCustomMap(root);
    const entry = custom[name];
    if (!entry || !entry.command) {
      throw new feed.FeedError(404, `unknown workflow command: /${name}. register one with: atris element cmd add ${name} "<cmd>"`);
    }
    try {
      const stdout = execFileSync('/bin/sh', ['-c', entry.command], {
        cwd: root,
        timeout: entry.timeout_ms || 60000,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        env,
      });
      snippet = redactTokens(stdout) || 'ok';
    } catch (err) {
      passed = false;
      exitCode = typeof err.status === 'number' ? err.status : 1;
      const combined = `${err.stdout || ''} ${err.stderr || ''} ${err.message || ''}`;
      snippet = redactTokens(combined) || `exit ${exitCode}`;
    }
  }

  const receipt = `/${name} ${passed ? 'passed' : `failed (exit ${exitCode})`}: ${snippet}`.slice(0, 900);
  let targetCardId = cardId;
  if (targetCardId) {
    require('./feed-room').reply(root, targetCardId, receipt, { as: as || undefined, env, deps });
  } else {
    const posted = ops.postIdempotent(root, { text: receipt, as: as || undefined, env, deps });
    targetCardId = posted.card_id;
  }

  return {
    version: feed.FEED_VERSION,
    name,
    card_id: targetCardId,
    passed,
    exit_code: exitCode,
    output: snippet,
    receipt,
  };
}

module.exports = { addCommand, listCommands, removeCommand, runSlashCommand };
