const { ensureValidCredentials } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const DEFAULT_GRAPH_DAYS = 365;
const INTENSITY_CHARS = [' ', '.', ':', '*', '#'];
const ROW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TASK_EPISODES_FILE = path.join('.atris', 'state', 'task_episodes.jsonl');
const CAREER_XP_RECEIPTS_FILE = path.join('.atris', 'state', 'career_xp_receipts.jsonl');
const CAREER_XP_PROJECTION_FILE = path.join('.atris', 'state', 'career_xp.projection.json');
const CAREER_XP_CURSOR_FILE = path.join('.atris', 'state', 'career_xp.cursor.json');
const CAREER_XP_SESSIONS_DIR = path.join('.atris', 'state', 'career_xp_sessions');
const TASK_PROJECTION_FILE = path.join('.atris', 'state', 'tasks.projection.json');
const CODEX_STATE_FILE = path.join(os.homedir(), '.codex', 'state_5.sqlite');
const AGENT_XP_LABEL = 'AgentXP';
const LEVEL_XP = 1000;
const RECEIPT_CHAIN_VERSION = 'atris.career_xp_receipt_chain.v1';
const XP_STATE_FILES = new Set([
  path.basename(TASK_EPISODES_FILE),
  path.basename(CAREER_XP_RECEIPTS_FILE),
  path.basename(CAREER_XP_PROJECTION_FILE),
]);
const SEARCH_EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
  'tmp',
  'temp',
]);
const DEFAULT_SEARCH_DEPTH = 6;

function showHelp() {
  console.log('Usage: atris xp [card|status|collect|session|sync] [--json] [--workspace <path>] [--all] [--root <path>]');
  console.log('       atris xp session [--since today|tonight|YYYY-MM-DD] [--until <time>] [--mission <text>] [--thread <id>] [--no-write]');
  console.log('       atris xp sync [--as <player>] [--local|--all] [--token <token>|logged-in] [--dry-run] [--json]');
  console.log('       atris xp [--json] [--local] [--workspace <path>] [--operator <name>]');
  console.log('');
  console.log('Show your AgentXP graph for the active Atris account.');
  console.log('Use status to show account-level AgentXP across verified local ledgers.');
  console.log('Use collect or status --local to project accepted task proof in the current workspace.');
  console.log('Use session to encapsulate the current work window into a local XP capsule.');
  console.log('Use sync to upload a path-private AgentXP packet to the hosted leaderboard.');
  console.log('Use status --all to explicitly aggregate verified local XP ledgers across workspaces.');
  console.log('Use --local to render from proof receipts in the current workspace.');
}

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatNumber(value) {
  return asNumber(value).toLocaleString('en-US');
}

function buildContributionRows(days) {
  const normalized = Array.isArray(days) ? days : [];
  if (normalized.length === 0) {
    return ROW_LABELS.map(label => `${label} `);
  }

  const first = new Date(`${normalized[0].date}T00:00:00Z`);
  const pad = Number.isFinite(first.getTime()) ? first.getUTCDay() : 0;
  const padded = [
    ...Array.from({ length: pad }, () => null),
    ...normalized,
  ];
  while (padded.length % 7 !== 0) padded.push(null);

  return ROW_LABELS.map((label, rowIndex) => {
    let line = `${label} `;
    for (let index = rowIndex; index < padded.length; index += 7) {
      const day = padded[index];
      const intensity = Math.max(0, Math.min(4, asNumber(day?.intensity)));
      line += INTENSITY_CHARS[intensity];
    }
    return line;
  });
}

function dateWindow(windowDays = DEFAULT_GRAPH_DAYS) {
  const count = Math.max(1, asNumber(windowDays, DEFAULT_GRAPH_DAYS));
  const end = new Date();
  const dates = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(end);
    date.setDate(end.getDate() - offset);
    const key = localDateKey(date);
    if (key && dates[dates.length - 1] !== key) dates.push(key);
  }
  return dates;
}

function graphIntensity(xp, maxDailyXp) {
  const total = asNumber(xp);
  if (total <= 0) return 0;
  const max = Math.max(1, asNumber(maxDailyXp, 1));
  if (max <= 1) return 1;
  const ratio = total / max;
  if (ratio >= 0.75) return 4;
  if (ratio >= 0.5) return 3;
  if (ratio >= 0.25) return 2;
  return 1;
}

function graphFromDailyTotals(dailyTotals, windowDays = DEFAULT_GRAPH_DAYS) {
  const totals = dailyTotals instanceof Map
    ? dailyTotals
    : new Map(Object.entries(dailyTotals || {}));
  const dates = dateWindow(windowDays);
  const maxDailyXp = dates.reduce((max, date) => Math.max(max, asNumber(totals.get(date))), 0);
  const days = dates.map((date) => {
    const xp = asNumber(totals.get(date));
    return {
      date,
      xp,
      total_xp: xp,
      intensity: graphIntensity(xp, maxDailyXp),
    };
  });
  return {
    schema: 'atris.agent_xp_contribution_graph.v1',
    metric_label: AGENT_XP_LABEL,
    window_days: days.length,
    total_xp: days.reduce((sum, day) => sum + day.xp, 0),
    active_days: days.filter(day => day.xp > 0).length,
    first_date: days[0]?.date || null,
    last_date: days[days.length - 1]?.date || null,
    days,
  };
}

function buildAgentXpContributionGraph(receipts, windowDays = DEFAULT_GRAPH_DAYS) {
  const totals = new Map();
  for (const receipt of receipts || []) {
    if (!receipt || receipt.outcome !== 'accepted') continue;
    const xp = asNumber(receipt.xp);
    if (xp <= 0) continue;
    const date = localDateKey(receipt.accepted_at);
    if (!date) continue;
    totals.set(date, asNumber(totals.get(date)) + xp);
  }
  return graphFromDailyTotals(totals, windowDays);
}

function combineAgentXpContributionGraphs(graphs, windowDays = DEFAULT_GRAPH_DAYS) {
  const totals = new Map();
  for (const graph of graphs || []) {
    for (const day of graph?.days || []) {
      const date = day?.date;
      if (!date) continue;
      const xp = asNumber(day.xp ?? day.total_xp);
      if (xp <= 0) continue;
      totals.set(date, asNumber(totals.get(date)) + xp);
    }
  }
  return graphFromDailyTotals(totals, windowDays);
}

function currentForm(payload) {
  const arenas = payload.current_form_by_arena || {};
  const local = arenas.local_workspace || {};
  const ovr = asNumber(local.ovr || local.current_form);
  if (!ovr) return null;
  return {
    ovr,
    visibleStats: Array.isArray(local.visible_stats) ? local.visible_stats : [],
    leaderboardEligible: Boolean(local.leaderboard_eligible),
    integrityStatus: local.integrity_status || 'unknown',
  };
}

function readFlag(args, name, fallback = null) {
  const inline = args.find(arg => arg.startsWith(`${name}=`));
  if (inline) {
    return inline.slice(name.length + 1);
  }
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith('--')) {
    return args[index + 1];
  }
  return fallback;
}

function readFirstFlag(args, names, fallback = null) {
  for (const name of names) {
    const value = readFlag(args, name, null);
    if (value !== null && value !== undefined && value !== '') return value;
  }
  return fallback;
}

function readFlagValues(args, names) {
  const wanted = Array.isArray(names) ? names : [names];
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    for (const name of wanted) {
      if (arg === name && args[index + 1] && !args[index + 1].startsWith('--')) {
        values.push(args[index + 1]);
      } else if (arg.startsWith(`${name}=`)) {
        values.push(arg.slice(name.length + 1));
      }
    }
  }
  return values.filter(Boolean);
}

function hasFlag(args, name) {
  return args.includes(name) || args.some(arg => arg.startsWith(`${name}=`));
}

function levelFromXp(careerXp) {
  return Math.max(1, Math.floor(asNumber(careerXp) / LEVEL_XP) + 1);
}

function localDateKey(value, timeZone = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC') {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch (_) {
    return date.toISOString().slice(0, 10);
  }
}

function parseJsonlContent(content, options = {}) {
  const allowPartialTail = Boolean(options.allowPartialTail);
  const rows = [];
  const hasTerminalNewline = /\r?\n$/.test(content);
  const lines = content.split('\n');
  let parsedBytes = 0;
  let skippedPartialTail = false;
  let skippedPartialTailBytes = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const isLast = index === lines.length - 1;
    const lineHadNewline = !isLast || hasTerminalNewline;
    const lineBytes = isLast && hasTerminalNewline && rawLine === ''
      ? 0
      : Buffer.byteLength(rawLine, 'utf8') + (lineHadNewline ? 1 : 0);
    const line = rawLine.trim();

    if (!line) {
      parsedBytes += lineBytes;
      continue;
    }

    try {
      rows.push(JSON.parse(line));
      parsedBytes += lineBytes;
    } catch (error) {
      if (allowPartialTail && isLast && !hasTerminalNewline) {
        skippedPartialTail = true;
        skippedPartialTailBytes = lineBytes;
        break;
      }
      throw error;
    }
  }

  return {
    rows,
    parsedBytes,
    skippedPartialTail,
    skippedPartialTailBytes,
  };
}

function readJsonl(filePath, options = {}) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8');
  return parseJsonlContent(content, options).rows;
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function appendJsonl(filePath, rows) {
  if (!rows.length) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, rows.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.length ? rows.map(row => JSON.stringify(row)).join('\n') + '\n' : '', 'utf8');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => {
      const item = value[key];
      if (item === undefined) return null;
      return `${JSON.stringify(key)}:${canonicalJson(item)}`;
    }).filter(Boolean).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function hashPayload(value) {
  return sha256(canonicalJson(value));
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/@.*$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function readJsonFile(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch (_) {
    return 0;
  }
}

function timestampMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && String(value).trim() !== '') return numeric;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function isoFromMs(value) {
  const ms = timestampMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function startOfTonight() {
  const date = new Date();
  if (date.getHours() < 6) {
    date.setDate(date.getDate() - 1);
  }
  date.setHours(18, 0, 0, 0);
  return date;
}

function parseSessionBoundary(value, fallback) {
  if (!value) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === 'now') return new Date();
  if (normalized === 'today') return startOfToday();
  if (normalized === 'tonight') return startOfTonight();
  if (normalized === 'yesterday') {
    const date = startOfToday();
    date.setDate(date.getDate() - 1);
    return date;
  }

  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  if (dateOnly) {
    return new Date(
      Number(dateOnly[1]),
      Number(dateOnly[2]) - 1,
      Number(dateOnly[3]),
      0,
      0,
      0,
      0
    );
  }

  const parsed = new Date(value);
  if (Number.isFinite(parsed.getTime())) return parsed;
  throw new Error(`Invalid session time: ${value}`);
}

function inWindow(value, sinceMs, untilMs) {
  const ms = timestampMs(value);
  return ms !== null && ms >= sinceMs && ms <= untilMs;
}

function expandHome(filePath) {
  if (!filePath) return filePath;
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/')) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runSqliteJsonOptional(dbPath, sql) {
  if (!dbPath || !fs.existsSync(dbPath)) return [];
  const result = spawnSync('sqlite3', ['-readonly', '-json', dbPath, sql], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return [];
  const out = String(result.stdout || '').trim();
  if (!out) return [];
  try {
    return JSON.parse(out);
  } catch (_) {
    return [];
  }
}

function receiptHashBase(receipt, previousHash) {
  const base = {
    ...receipt,
    chain_version: RECEIPT_CHAIN_VERSION,
    previous_receipt_hash: previousHash || null,
  };
  delete base.receipt_hash;
  return base;
}

function receiptDuplicateComparable(receipt) {
  const comparable = { ...(receipt || {}) };
  delete comparable.chain_version;
  delete comparable.previous_receipt_hash;
  delete comparable.receipt_hash;
  return comparable;
}

function receiptLabel(receipt) {
  const title = String(receipt?.title || '').trim();
  if (title) return title;
  const task = String(receipt?.source_task_id || '').trim();
  if (task) return `task ${task.slice(0, 8)}`;
  const source = String(receipt?.source_type || receipt?.source || '').trim();
  return source || 'accepted proof';
}

function withReceiptIntegrity(receipt, previousHash) {
  const base = receiptHashBase(receipt, previousHash);
  return {
    ...base,
    receipt_hash: hashPayload(base),
  };
}

function normalizeReceiptChain(receipts, { allowLegacyUpgrade = true } = {}) {
  const seen = new Map();
  const errors = [];
  const dedupedReceipts = [];
  const normalized = [];
  let previousHash = null;
  let upgraded = false;

  for (const receipt of receipts) {
    if (!receipt || typeof receipt !== 'object') {
      errors.push('invalid_receipt');
      continue;
    }
    if (!receipt.receipt_id) errors.push('missing_receipt_id');
    if (receipt.receipt_id && seen.has(receipt.receipt_id)) {
      const first = seen.get(receipt.receipt_id);
      if (canonicalJson(receiptDuplicateComparable(first)) === canonicalJson(receiptDuplicateComparable(receipt))) {
        dedupedReceipts.push(receiptLabel(receipt));
        continue;
      }
      errors.push(`conflicting_duplicate_receipt:${receiptLabel(receipt)}`);
    }

    const expected = withReceiptIntegrity(receipt, previousHash);
    const hadIntegrity = Boolean(receipt.receipt_hash && receipt.chain_version && Object.prototype.hasOwnProperty.call(receipt, 'previous_receipt_hash'));
    if (hadIntegrity) {
      if (receipt.chain_version !== RECEIPT_CHAIN_VERSION) {
        errors.push(`receipt_chain_version_mismatch:${receiptLabel(receipt)}`);
      }
      if ((receipt.previous_receipt_hash || null) !== (previousHash || null)) {
        errors.push(`receipt_previous_hash_mismatch:${receiptLabel(receipt)}`);
      }
      if (receipt.receipt_hash !== expected.receipt_hash) {
        errors.push(`receipt_hash_mismatch:${receiptLabel(receipt)}`);
      }
    }
    if (!hadIntegrity && !allowLegacyUpgrade) {
      errors.push(`missing_receipt_integrity:${receiptLabel(receipt)}`);
    }
    if (!hadIntegrity && allowLegacyUpgrade) upgraded = true;

    normalized.push(expected);
    previousHash = expected.receipt_hash;
    if (receipt.receipt_id && !seen.has(receipt.receipt_id)) seen.set(receipt.receipt_id, receipt);
  }

  return {
    receipts: normalized,
    upgraded,
    deduped: dedupedReceipts.length > 0,
    integrity: {
      status: errors.length ? 'tampered' : 'verified',
      chain_version: RECEIPT_CHAIN_VERSION,
      receipts_count: normalized.length,
      head_hash: previousHash,
      errors,
      deduped_receipts: dedupedReceipts,
      local_trust: 'tamper_evident_not_attested',
    },
  };
}

function alignJsonlReadStart(filePath, start) {
  if (!start || start <= 0) return 0;
  const fd = fs.openSync(filePath, 'r');
  try {
    const previous = Buffer.alloc(1);
    fs.readSync(fd, previous, 0, 1, start - 1);
    if (previous[0] === 0x0a) return start;

    const current = Buffer.alloc(1);
    const currentBytes = fs.readSync(fd, current, 0, 1, start);
    if (previous[0] === 0x0d && currentBytes === 1 && current[0] === 0x0a) {
      return start + 1;
    }

    const chunkSize = 64 * 1024;
    let scanEnd = start;
    while (scanEnd > 0) {
      const scanStart = Math.max(0, scanEnd - chunkSize);
      const buffer = Buffer.alloc(scanEnd - scanStart);
      fs.readSync(fd, buffer, 0, buffer.length, scanStart);
      for (let index = buffer.length - 1; index >= 0; index -= 1) {
        if (buffer[index] === 0x0a) return scanStart + index + 1;
      }
      scanEnd = scanStart;
    }
    return 0;
  } finally {
    fs.closeSync(fd);
  }
}

function readTaskEpisodeTail(episodePath, cursorPath, options = {}) {
  const stat = fs.existsSync(episodePath) ? fs.statSync(episodePath) : null;
  const forceReset = Boolean(options.forceReset);
  const cursor = forceReset ? null : readJsonFile(cursorPath, null);
  const previousBytes = Number(cursor?.bytes_read || 0);
  const size = stat ? stat.size : 0;
  const reset = forceReset || !cursor || cursor.source_path !== episodePath || size < previousBytes;
  const start = reset || !stat ? 0 : alignJsonlReadStart(episodePath, previousBytes);
  if (!stat || size === start) {
    return {
      episodes: [],
      cursor: {
        schema: 'atris.career_xp_cursor.v1',
        source_path: episodePath,
        bytes_read: size,
        source_size: size,
        last_episode_id: cursor?.last_episode_id || null,
        updated_at: new Date().toISOString(),
        reset,
      },
    };
  }

  const fd = fs.openSync(episodePath, 'r');
  try {
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const parsed = parseJsonlContent(buffer.toString('utf8'), { allowPartialTail: true });
    const episodes = parsed.rows;
    const bytesRead = start + parsed.parsedBytes;
    return {
      episodes,
      cursor: {
        schema: 'atris.career_xp_cursor.v1',
        source_path: episodePath,
        bytes_read: bytesRead,
        source_size: size,
        last_episode_id: episodes.length ? episodes[episodes.length - 1].episode_id || null : cursor?.last_episode_id || null,
        updated_at: new Date().toISOString(),
        reset,
        skipped_partial_tail: parsed.skippedPartialTail,
        skipped_partial_tail_bytes: parsed.skippedPartialTailBytes,
      },
    };
  } finally {
    fs.closeSync(fd);
  }
}

function receiptFromTaskEpisode(episode) {
  const doneForXp = String(episode?.state?.status || '').toLowerCase() === 'done';
  const hasExplicitCareerXp = episode?.career_xp && typeof episode.career_xp === 'object';
  const eligible = doneForXp && (
    episode?.career_xp?.eligible === true
      || (!hasExplicitCareerXp && episode?.rl?.label === 'accepted')
  );
  const proof = String(episode?.proof || '').trim();
  const reward = asNumber(episode?.career_xp?.reward ?? episode?.reward?.value, 0);
  if (!eligible || !proof || reward <= 0 || !episode?.episode_id) return null;

  return {
    schema: 'atris.career_xp_receipt.v1',
    receipt_id: `task_review:${episode.episode_id}`,
    source: 'atris-cli',
    source_type: 'task_review',
    source_task_id: episode.task_id || null,
    source_episode_id: episode.episode_id,
    workspace_root: episode.workspace_root || null,
    actor: episode.action?.actor || null,
    outcome: 'accepted',
    xp: reward,
    reward,
    proof,
    proof_ref: proof,
    source_episode_hash: hashPayload(episode),
    title: episode.state?.title || null,
    goal: episode.goal || null,
    accepted_at: episode.created_at || new Date().toISOString(),
    tokens_used: Number.isFinite(Number(episode.tokens_used)) ? Number(episode.tokens_used) : null,
    duration_seconds: Number.isFinite(Number(episode.duration_seconds)) ? Number(episode.duration_seconds) : null,
  };
}

function latestReceipt(receipts) {
  return receipts
    .slice()
    .sort((a, b) => new Date(b.accepted_at).getTime() - new Date(a.accepted_at).getTime())[0] || null;
}

function countBySource(receipts) {
  return receipts.reduce((acc, receipt) => {
    const source = receipt.source || 'unknown';
    acc[source] = (acc[source] || 0) + 1;
    return acc;
  }, {});
}

function buildCareerXpProjection(receipts, workspace, integrity = {}) {
  const trusted = integrity.status === 'tampered' ? [] : receipts;
  const accepted = trusted
    .filter(receipt => receipt && receipt.outcome === 'accepted' && asNumber(receipt.xp) > 0)
    .sort((a, b) => new Date(a.accepted_at).getTime() - new Date(b.accepted_at).getTime());
  const totalXp = accepted.reduce((sum, receipt) => sum + asNumber(receipt.xp), 0);
  const today = localDateKey(new Date());
  const todayXp = accepted
    .filter(receipt => localDateKey(receipt.accepted_at) === today)
    .reduce((sum, receipt) => sum + asNumber(receipt.xp), 0);
  const level = levelFromXp(totalXp);
  const levelBase = (level - 1) * LEVEL_XP;
  const currentLevelXp = totalXp - levelBase;
  const remainingXp = Math.max(0, (level * LEVEL_XP) - totalXp);
  const nextLevelProgress = {
    level,
    next_level: level + 1,
    current_xp: currentLevelXp,
    required_xp: LEVEL_XP,
    remaining_xp: remainingXp,
    percent: Math.round((currentLevelXp / LEVEL_XP) * 1000) / 10,
  };
  const latest = latestReceipt(accepted);

  return {
    schema: 'atris.career_xp_projection.v1',
    generated_at: new Date().toISOString(),
    workspace_root: workspace,
    metric_label: AGENT_XP_LABEL,
    agent_xp: totalXp,
    total_agent_xp: totalXp,
    today_agent_xp: todayXp,
    career_xp: totalXp,
    total_xp: totalXp,
    today_xp: todayXp,
    level,
    leaderboard_eligible: false,
    integrity_status: integrity.status || 'unknown',
    next_level_progress: nextLevelProgress,
    career: {
      level,
      card_label: 'Career Card',
      progress_label: 'Career Progress',
      next_level_progress: nextLevelProgress,
    },
    contribution_graph: buildAgentXpContributionGraph(accepted),
    receipts_count: accepted.length,
    sources: countBySource(accepted),
    latest_accepted_proof: latest ? {
      label: receiptLabel(latest),
      receipt_id: latest.receipt_id,
      source: latest.source,
      source_task_id: latest.source_task_id,
      source_episode_id: latest.source_episode_id,
      title: latest.title,
      proof: latest.proof,
      xp: latest.xp,
      reward: latest.reward,
      actor: latest.actor,
      accepted_at: latest.accepted_at,
      goal: latest.goal || null,
    } : null,
    ledger: {
      receipts_path: path.join(workspace, CAREER_XP_RECEIPTS_FILE),
      projection_path: path.join(workspace, CAREER_XP_PROJECTION_FILE),
      cursor_path: path.join(workspace, CAREER_XP_CURSOR_FILE),
    },
    integrity: {
      status: integrity.status || 'unknown',
      chain_version: integrity.chain_version || RECEIPT_CHAIN_VERSION,
      head_hash: integrity.head_hash || null,
      receipts_count: integrity.receipts_count ?? accepted.length,
      errors: integrity.errors || [],
      deduped_receipts: integrity.deduped_receipts || [],
      local_trust: integrity.local_trust || 'tamper_evident_not_attested',
      cursor: integrity.cursor || null,
      note: 'Local XP is tamper-evident. Public trust still requires cloud/notary attestation.',
    },
  };
}

function collectLocalXpProjectionState(args = [], { write = true } = {}) {
  const workspace = path.resolve(readFlag(args, '--workspace', process.cwd()));
  const episodePath = path.join(workspace, TASK_EPISODES_FILE);
  const receiptsPath = path.join(workspace, CAREER_XP_RECEIPTS_FILE);
  const projectionPath = path.join(workspace, CAREER_XP_PROJECTION_FILE);
  const cursorPath = path.join(workspace, CAREER_XP_CURSOR_FILE);
  let existingChain = normalizeReceiptChain(readJsonl(receiptsPath));
  if ((existingChain.upgraded || existingChain.deduped) && existingChain.integrity.status === 'verified') {
    if (write) writeJsonl(receiptsPath, existingChain.receipts);
    existingChain = normalizeReceiptChain(existingChain.receipts);
  }
  if (existingChain.integrity.status === 'tampered') {
    const projection = buildCareerXpProjection([], workspace, existingChain.integrity);
    if (write) writeJson(projectionPath, projection);
    return {
      projection: {
        ...projection,
        collected_receipts: 0,
      },
      receipts: [],
      newReceipts: [],
    };
  }

  const replayFromStart = existingChain.receipts.length === 0
    && fileSize(episodePath) > 0
    && fileSize(receiptsPath) === 0;
  const tail = readTaskEpisodeTail(episodePath, cursorPath, { forceReset: replayFromStart });
  const seen = new Set(existingChain.receipts.map(receipt => receipt.receipt_id).filter(Boolean));
  let previousHash = existingChain.integrity.head_hash || null;
  const newReceipts = tail.episodes
    .map(receiptFromTaskEpisode)
    .filter(Boolean)
    .filter((receipt) => {
      if (seen.has(receipt.receipt_id)) return false;
      seen.add(receipt.receipt_id);
      return true;
    })
    .map((receipt) => {
      const signed = withReceiptIntegrity(receipt, previousHash);
      previousHash = signed.receipt_hash;
      return signed;
    });
  const receipts = [...existingChain.receipts, ...newReceipts];
  const finalChain = normalizeReceiptChain(receipts);
  const finalIntegrity = {
    ...finalChain.integrity,
    cursor: tail.cursor,
  };
  const projection = buildCareerXpProjection(
    finalIntegrity.status === 'tampered' ? [] : finalChain.receipts,
    workspace,
    finalIntegrity,
  );

  if (write) {
    appendJsonl(receiptsPath, newReceipts);
    writeJson(cursorPath, tail.cursor);
    writeJson(projectionPath, projection);
  }

  return {
    projection: {
      ...projection,
      collected_receipts: newReceipts.length,
    },
    receipts: finalChain.receipts,
    newReceipts,
    cursor: tail.cursor,
  };
}

function collectLocalXpProjection(args = []) {
  return collectLocalXpProjectionState(args, { write: true }).projection;
}

function uniquePaths(paths) {
  const seen = new Set();
  return paths
    .map(item => path.resolve(item))
    .filter((item) => {
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

function stateWorkspaceForFile(filePath) {
  const stateDir = path.dirname(filePath);
  if (path.basename(stateDir) !== 'state') return null;
  const atrisDir = path.dirname(stateDir);
  if (path.basename(atrisDir) !== '.atris') return null;
  return path.dirname(atrisDir);
}

function discoverCareerXpWorkspaces(root, maxDepth = DEFAULT_SEARCH_DEPTH) {
  const start = path.resolve(root);
  if (!fs.existsSync(start)) return [];
  const workspaces = new Set();
  const stack = [{ dir: start, depth: 0 }];

  while (stack.length) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth >= maxDepth || SEARCH_EXCLUDED_DIRS.has(entry.name)) continue;
        stack.push({ dir: entryPath, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile() || !XP_STATE_FILES.has(entry.name)) continue;
      const workspace = stateWorkspaceForFile(entryPath);
      if (workspace) workspaces.add(workspace);
    }
  }

  return Array.from(workspaces).sort();
}

function defaultAllSearchRoots(args = []) {
  const explicitRoots = readFlagValues(args, ['--root', '--search-root']);
  if (explicitRoots.length) return uniquePaths(explicitRoots);

  const roots = [];
  const workspace = readFlag(args, '--workspace', null);
  if (workspace) roots.push(workspace);
  roots.push(process.cwd());
  roots.push(path.join(os.homedir(), 'arena'));
  return uniquePaths(roots);
}

function workspaceName(workspace) {
  return path.basename(workspace) || workspace;
}

function isVerifiedProjection(projection) {
  return projection?.schema === 'atris.career_xp_projection.v1'
    && projection.integrity_status === 'verified'
    && projection.integrity?.status === 'verified';
}

function buildAllCareerXpProjection(projections, searchRoots = []) {
  const warnings = [];
  const verified = [];
  const workspaces = projections.map((item) => {
    if (item.error) {
      warnings.push({
        workspace_root: item.workspace_root,
        reason: item.error,
      });
      return {
        workspace_root: item.workspace_root,
        name: workspaceName(item.workspace_root),
        included: false,
        integrity_status: 'error',
        error: item.error,
      };
    }

    const projection = item.projection;
    const included = isVerifiedProjection(projection);
    if (included) {
      verified.push(projection);
    } else {
      warnings.push({
        workspace_root: item.workspace_root,
        reason: `integrity:${projection?.integrity_status || projection?.integrity?.status || 'unknown'}`,
        errors: projection?.integrity?.errors || [],
      });
    }

    return {
      workspace_root: item.workspace_root,
      name: workspaceName(item.workspace_root),
      included,
      total_xp: asNumber(projection?.total_xp),
      today_xp: asNumber(projection?.today_xp),
      level: asNumber(projection?.level, 1),
      receipts_count: asNumber(projection?.receipts_count),
      integrity_status: projection?.integrity_status || projection?.integrity?.status || 'unknown',
      leaderboard_eligible: Boolean(projection?.leaderboard_eligible),
      latest_accepted_proof: projection?.latest_accepted_proof || null,
      ledger: projection?.ledger || null,
    };
  }).sort((a, b) => {
    if (b.included !== a.included) return Number(b.included) - Number(a.included);
    return b.total_xp - a.total_xp || a.name.localeCompare(b.name);
  });

  const totalXp = verified.reduce((sum, projection) => sum + asNumber(projection.total_xp), 0);
  const todayXp = verified.reduce((sum, projection) => sum + asNumber(projection.today_xp), 0);
  const level = levelFromXp(totalXp);
  const levelBase = (level - 1) * LEVEL_XP;
  const currentLevelXp = totalXp - levelBase;
  const nextLevelProgress = {
    level,
    next_level: level + 1,
    current_xp: currentLevelXp,
    required_xp: LEVEL_XP,
    remaining_xp: Math.max(0, (level * LEVEL_XP) - totalXp),
    percent: Math.round((currentLevelXp / LEVEL_XP) * 1000) / 10,
  };
  const latest = verified
    .map(projection => ({
      ...(projection.latest_accepted_proof || {}),
      workspace_root: projection.workspace_root,
      workspace_name: workspaceName(projection.workspace_root),
    }))
    .filter(proof => proof && proof.accepted_at)
    .sort((a, b) => new Date(b.accepted_at).getTime() - new Date(a.accepted_at).getTime())[0] || null;
  const contributionGraph = combineAgentXpContributionGraphs(
    verified.map(projection => projection.contribution_graph),
  );

  return {
    schema: 'atris.career_xp_profile.v1',
    generated_at: new Date().toISOString(),
    search_roots: searchRoots,
    workspace_count: workspaces.length,
    verified_workspace_count: verified.length,
    metric_label: AGENT_XP_LABEL,
    agent_xp: totalXp,
    total_agent_xp: totalXp,
    today_agent_xp: todayXp,
    career_xp: totalXp,
    total_xp: totalXp,
    today_xp: todayXp,
    level,
    leaderboard_eligible: false,
    next_level_progress: nextLevelProgress,
    career: {
      level,
      card_label: 'Career Card',
      progress_label: 'Career Progress',
      next_level_progress: nextLevelProgress,
    },
    contribution_graph: contributionGraph,
    receipts_count: verified.reduce((sum, projection) => sum + asNumber(projection.receipts_count), 0),
    latest_accepted_proof: latest,
    workspaces,
    integrity: {
      status: warnings.length ? 'warnings' : 'verified',
      warnings,
      local_trust: 'workspace_local_tamper_evident_not_attested',
      note: 'Only verified local ledgers are counted. Public trust still requires cloud/notary attestation.',
    },
  };
}

function collectAllLocalXpProjection(args = []) {
  const searchRoots = defaultAllSearchRoots(args).filter(root => fs.existsSync(root));
  const explicitWorkspaces = readFlagValues(args, '--workspace');
  const discovered = searchRoots.flatMap(root => discoverCareerXpWorkspaces(root));
  const workspaces = uniquePaths([...explicitWorkspaces, ...discovered]);
  const projections = workspaces.map((workspace) => {
    try {
      return {
        workspace_root: workspace,
        projection: collectLocalXpProjection(['--workspace', workspace]),
      };
    } catch (error) {
      return {
        workspace_root: workspace,
        error: error.message,
      };
    }
  });

  return buildAllCareerXpProjection(projections, searchRoots);
}

function readTaskProjectionState(workspace) {
  const projectionPath = path.join(workspace, TASK_PROJECTION_FILE);
  try {
    const projection = readJsonFile(projectionPath, { tasks: [] });
    return {
      tasks: Array.isArray(projection?.tasks) ? projection.tasks : [],
      warning: null,
    };
  } catch (error) {
    return {
      tasks: [],
      warning: `task_projection_unreadable:${error.message}`,
    };
  }
}

function readTaskProjection(workspace) {
  return readTaskProjectionState(workspace).tasks;
}

function taskRef(task) {
  return task?.display_id || task?.legacy_ref || task?.id || 'task';
}

function taskTimes(task) {
  const times = [
    task?.created_at,
    task?.updated_at,
    task?.done_at,
    task?.review?.reviewed_at,
    task?.review?.accepted_at,
    task?.review?.revised_at,
    task?.metadata?.agent_reviewed_at,
    task?.metadata?.accepted_at,
    task?.metadata?.human_revision_at,
  ];
  for (const event of task?.events || []) times.push(event.created_at);
  for (const message of task?.messages || []) times.push(message.created_at);
  return times
    .map(timestampMs)
    .filter(ms => ms !== null);
}

function taskTouchedInWindow(task, sinceMs, untilMs) {
  return taskTimes(task).some(ms => ms >= sinceMs && ms <= untilMs);
}

function latestTaskMs(task) {
  const times = taskTimes(task);
  return times.length ? Math.max(...times) : null;
}

function taskApprovalStatus(task) {
  return task?.review?.approval_status || task?.metadata?.approval_status || null;
}

function textExcerpt(value, limit = 220) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text || null;
  return `${text.slice(0, limit - 3)}...`;
}

function compactTask(task) {
  const proof = task?.review?.proof || task?.metadata?.latest_agent_proof || null;
  return {
    task_id: taskRef(task),
    id: task?.id || null,
    title: task?.title || null,
    status: task?.status || null,
    tag: task?.tag || null,
    claimed_by: task?.claimed_by || null,
    approval_status: taskApprovalStatus(task),
    summary: task?.review?.summary || null,
    proof_excerpt: textExcerpt(proof),
    has_proof: Boolean(proof),
    updated_at: isoFromMs(latestTaskMs(task)),
  };
}

function receiptMatchesTask(receipt, task) {
  const sourceTaskId = String(receipt?.source_task_id || '');
  if (!sourceTaskId) return false;
  return [task?.id, task?.display_id, task?.legacy_ref]
    .filter(Boolean)
    .map(String)
    .includes(sourceTaskId);
}

function compactReceipt(receipt, task = null, options = {}) {
  const proof = receipt?.proof || null;
  const compact = {
    receipt_id: receipt?.receipt_id || null,
    task_id: task ? taskRef(task) : receipt?.source_task_id || null,
    source_task_id: receipt?.source_task_id || null,
    title: receipt?.title || task?.title || null,
    proof_excerpt: textExcerpt(proof),
    has_proof: Boolean(proof),
    xp: asNumber(receipt?.xp),
    actor: receipt?.actor || null,
    accepted_at: receipt?.accepted_at || null,
    goal: receipt?.goal || null,
  };
  if (options.fullProof) {
    compact.proof = proof;
  }
  return compact;
}

function compactGoal(goal) {
  if (!goal) return null;
  if (typeof goal === 'string') {
    const label = goal.trim();
    return label ? { label } : null;
  }
  const label = goal.objective || goal.title || goal.condition || goal.id || goal.goal_id || null;
  if (!label) return null;
  return {
    provider: goal.provider || null,
    thread_id: goal.thread_id || null,
    goal_id: goal.id || goal.goal_id || null,
    label,
    status: goal.status || null,
    met: typeof goal.met === 'boolean' ? goal.met : null,
    tokens_used: Number.isFinite(Number(goal.tokens_used)) ? Number(goal.tokens_used) : null,
    time_used_seconds: Number.isFinite(Number(goal.time_used_seconds)) ? Number(goal.time_used_seconds) : null,
    created_at: goal.created_at || isoFromMs(goal.created_at_ms),
    updated_at: goal.updated_at || isoFromMs(goal.updated_at_ms),
    workspace_path: goal.thread_cwd || goal.workspace_path || null,
  };
}

function uniqueGoals(goals) {
  const seen = new Set();
  return goals
    .map(compactGoal)
    .filter(Boolean)
    .filter((goal) => {
      const key = `${goal.goal_id || ''}:${goal.label}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function buildNextQuest(reviewTasks, touchedTasks, acceptedReceipts) {
  const pendingReview = reviewTasks
    .slice()
    .sort((a, b) => (latestTaskMs(b) || 0) - (latestTaskMs(a) || 0))[0];
  if (pendingReview) {
    return `Review ${taskRef(pendingReview)}: ${pendingReview.title}`;
  }

  const activeTask = touchedTasks
    .filter(task => ['claimed', 'open', 'todo', 'do'].includes(String(task.status || '').toLowerCase()))
    .sort((a, b) => (latestTaskMs(b) || 0) - (latestTaskMs(a) || 0))[0];
  if (activeTask) {
    return `Move ${taskRef(activeTask)} to Review with proof.`;
  }

  if (!acceptedReceipts.length) {
    return 'Put one task into Review with proof, then accept it if the proof is real.';
  }
  return 'Pick the next highest-leverage task and move it to Review with proof.';
}

function workspacePathCandidates(workspace) {
  const candidates = [workspace];
  try {
    candidates.push(fs.realpathSync(workspace));
  } catch (_) {
    // best-effort only
  }
  const pwd = process.env.PWD || '';
  if (pwd) {
    try {
      if (fs.existsSync(pwd) && fs.realpathSync(pwd) === fs.realpathSync(workspace)) candidates.push(pwd);
    } catch (_) {
      // best-effort only
    }
  }
  return [...new Set(candidates.filter(Boolean))];
}

function readCodexGoalsForSession(args, workspace, sinceMs, untilMs) {
  const dbPath = path.resolve(expandHome(
    readFlag(args, '--codex-state', readFlag(args, '--state', process.env.CODEX_STATE_DB || CODEX_STATE_FILE))
  ));
  const threadId = readFlag(args, '--thread', process.env.CODEX_THREAD_ID || '');
  const clauses = [];
  if (threadId) clauses.push(`tg.thread_id = ${sqlString(threadId)}`);
  const workspaceCandidates = workspacePathCandidates(workspace);
  if (workspaceCandidates.length) {
    clauses.push(`(t.cwd IN (${workspaceCandidates.map(sqlString).join(', ')}) AND tg.created_at_ms <= ${Number(untilMs)} AND (tg.updated_at_ms >= ${Number(sinceMs)} OR tg.status = 'active'))`);
  }
  if (!clauses.length) return [];

  const rows = runSqliteJsonOptional(dbPath, `
SELECT
  'codex' AS provider,
  tg.thread_id,
  tg.goal_id,
  tg.objective,
  tg.status,
  tg.token_budget,
  tg.tokens_used,
  tg.time_used_seconds,
  tg.created_at_ms,
  tg.updated_at_ms,
  t.cwd AS thread_cwd,
  t.title AS thread_title
FROM thread_goals tg
LEFT JOIN threads t ON t.id = tg.thread_id
WHERE ${clauses.join(' OR ')}
ORDER BY tg.updated_at_ms DESC
LIMIT 25
`);

  return rows.map(row => ({
    ...row,
    provider: 'codex',
  }));
}

function buildCareerXpSessionCapsule(args = []) {
  const workspace = path.resolve(readFlag(args, '--workspace', process.cwd()));
  const sinceInput = readFlag(args, '--since', 'today');
  const untilInput = readFlag(args, '--until', null);
  const since = parseSessionBoundary(sinceInput, startOfToday());
  const until = parseSessionBoundary(untilInput, new Date());
  const sinceMs = since.getTime();
  const untilMs = until.getTime();
  if (sinceMs > untilMs) {
    throw new Error('--since must be before --until');
  }

  const writeEnabled = !hasFlag(args, '--no-write') && !hasFlag(args, '--dry-run');
  const projectionState = collectLocalXpProjectionState(['--workspace', workspace], { write: writeEnabled });
  const projection = projectionState.projection;
  const receiptsPath = path.join(workspace, CAREER_XP_RECEIPTS_FILE);
  const taskProjectionPath = path.join(workspace, TASK_PROJECTION_FILE);
  const sessionDate = localDateKey(since) || since.toISOString().slice(0, 10);
  const sessionPath = path.join(workspace, CAREER_XP_SESSIONS_DIR, `${sessionDate}.json`);
  const warnings = [];
  if (projection.integrity?.cursor?.skipped_partial_tail) {
    warnings.push('task_episodes_partial_tail_waiting');
  }
  const taskProjection = readTaskProjectionState(workspace);
  if (taskProjection.warning) warnings.push(taskProjection.warning);
  const tasks = taskProjection.tasks;
  const touchedTasks = tasks
    .filter(task => taskTouchedInWindow(task, sinceMs, untilMs))
    .sort((a, b) => (latestTaskMs(b) || 0) - (latestTaskMs(a) || 0));
  const reviewTasks = touchedTasks.filter((task) => {
    const status = String(task.status || '').toLowerCase();
    return status === 'review' || taskApprovalStatus(task) === 'pending';
  });
  const doneTasks = touchedTasks.filter(task => String(task.status || '').toLowerCase() === 'done');
  const receipts = projection.integrity_status === 'verified' ? projectionState.receipts : [];
  const acceptedReceipts = receipts
    .filter(receipt => receipt?.outcome === 'accepted' && asNumber(receipt.xp) > 0 && inWindow(receipt.accepted_at, sinceMs, untilMs))
    .sort((a, b) => (timestampMs(b.accepted_at) || 0) - (timestampMs(a.accepted_at) || 0));
  const acceptedTasks = acceptedReceipts.map((receipt) => {
    const task = touchedTasks.find(item => receiptMatchesTask(receipt, item));
    return compactReceipt(receipt, task);
  });
  const windowXp = acceptedReceipts.reduce((sum, receipt) => sum + asNumber(receipt.xp), 0);
  const afterTotalXp = asNumber(projection.total_xp);
  const missionFlag = readFlag(args, '--mission', null);
  const episodeGoals = readJsonl(path.join(workspace, TASK_EPISODES_FILE), { allowPartialTail: true })
    .filter(episode => inWindow(episode?.created_at, sinceMs, untilMs))
    .map(episode => episode.goal);
  const codexGoals = readCodexGoalsForSession(args, workspace, sinceMs, untilMs);
  const goals = uniqueGoals([
    ...codexGoals,
    ...acceptedReceipts.map(receipt => receipt.goal),
    ...episodeGoals,
  ]);
  const latestAccepted = acceptedReceipts[0] || null;

  const capsule = {
    schema: 'atris.career_xp_session_capsule.v1',
    generated_at: new Date().toISOString(),
    workspace_root: workspace,
    window: {
      label: String(sinceInput || 'today'),
      since: since.toISOString(),
      until: until.toISOString(),
      since_ms: sinceMs,
      until_ms: untilMs,
    },
    mission: {
      label: missionFlag || goals[0]?.label || touchedTasks.find(task => task.tag === 'career-xp')?.title || 'Capture proof-backed work',
      source: missionFlag ? 'flag' : goals[0] ? 'goal' : 'tasks',
    },
    xp: {
      before_agent_xp: Math.max(0, afterTotalXp - windowXp),
      after_agent_xp: afterTotalXp,
      delta_agent_xp: windowXp,
      today_agent_xp: asNumber(projection.today_xp),
      before_total_xp: Math.max(0, afterTotalXp - windowXp),
      after_total_xp: afterTotalXp,
      delta_xp: windowXp,
      today_xp: asNumber(projection.today_xp),
      level: asNumber(projection.level, 1),
      next_level_progress: projection.next_level_progress || null,
      integrity_status: projection.integrity_status || 'unknown',
    },
    tasks: {
      touched_count: touchedTasks.length,
      review_count: reviewTasks.length,
      accepted_count: acceptedTasks.length,
      done_count: doneTasks.length,
      touched: touchedTasks.map(compactTask),
      review: reviewTasks.map(compactTask),
      accepted: acceptedTasks,
    },
    goals: {
      count: goals.length,
      touched: goals,
    },
    proof: {
      receipts_count: acceptedReceipts.length,
      latest_accepted: latestAccepted ? compactReceipt(
        latestAccepted,
        touchedTasks.find(task => receiptMatchesTask(latestAccepted, task)),
        { fullProof: true }
      ) : null,
      accepted: acceptedTasks,
    },
    next_quest: buildNextQuest(reviewTasks, touchedTasks, acceptedReceipts),
    files: {
      projection_path: path.join(workspace, CAREER_XP_PROJECTION_FILE),
      receipts_path: receiptsPath,
      task_projection_path: fs.existsSync(taskProjectionPath) ? taskProjectionPath : null,
      session_path: writeEnabled ? sessionPath : null,
    },
    written: writeEnabled,
  };

  if (warnings.length) {
    capsule.warnings = warnings;
  }

  if (writeEnabled) {
    writeJson(sessionPath, capsule);
  }

  return capsule;
}

function normalizeLocalScore(score, workspace) {
  const card = score.profile_card || score.player_card || {};
  const integrity = score.integrity || {};
  const careerXp = asNumber(card.agent_xp ?? card.career_xp);
  const leaderboardEligible = Boolean(
    card.leaderboard_eligible ?? integrity.leaderboard_eligible
  );

  return {
    metric_label: AGENT_XP_LABEL,
    agent_xp: careerXp,
    career_xp: careerXp,
    level: levelFromXp(careerXp),
    operator: score.operator || null,
    leaderboard_eligible: leaderboardEligible,
    source: 'local_contribution_score',
    workspace_root: score.workspace_root || workspace,
    current_form_by_arena: {
      local_workspace: {
        ovr: asNumber(card.ovr || card.current_form),
        current_form: asNumber(card.current_form || card.ovr),
        visible_stats: Array.isArray(card.visible_stats) ? card.visible_stats : [],
        leaderboard_eligible: leaderboardEligible,
        integrity_status: score.label || integrity.status || 'unknown',
      },
    },
    contribution_graph: score.contribution_graph || {},
  };
}

function renderContributionGraph(graph) {
  if (!graph || !Array.isArray(graph.days)) return;
  console.log('');
  console.log(`Last ${formatNumber(graph.window_days || DEFAULT_GRAPH_DAYS)} days: ${formatNumber(graph.total_xp)} ${AGENT_XP_LABEL} across ${formatNumber(graph.active_days)} active days`);
  for (const row of buildContributionRows(graph.days)) {
    console.log(row);
  }
  console.log('Legend: blank none | . started | : solid | * heavy | # breakout');
}

function loadLocalPayload(args) {
  const workspace = path.resolve(readFlag(args, '--workspace', process.cwd()));
  const operator = readFlag(
    args,
    '--operator',
    process.env.ATRIS_OPERATOR || process.env.USER || os.userInfo().username
  );
  const script = path.join(workspace, 'scripts', 'contribution_score.py');

  if (!fs.existsSync(script)) {
    throw new Error(`No local contribution scorer found at ${path.relative(process.cwd(), script)}`);
  }

  const result = spawnSync(
    process.env.PYTHON || 'python3',
    [script, '--workspace', workspace, '--operator', operator, '--json'],
    { cwd: workspace, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(detail || `Local scorer exited ${result.status}`);
  }

  return normalizeLocalScore(JSON.parse(result.stdout), workspace);
}

function publicAgentXp(value) {
  return Math.max(0, Math.min(99, asNumber(value)));
}

function verifiedProjection(projection) {
  return projection?.integrity_status === 'verified'
    && projection?.integrity?.status === 'verified';
}

function projectionWorkspaceSummaries(projection) {
  if (Array.isArray(projection?.workspaces)) {
    return projection.workspaces.map(workspace => ({
      name: workspace.name || workspaceName(workspace.workspace_root || 'workspace'),
      workspace_root_hash: workspace.workspace_root ? sha256(path.resolve(workspace.workspace_root)) : null,
      included: Boolean(workspace.included),
      agent_xp: asNumber(workspace.total_xp),
      receipts_count: asNumber(workspace.receipts_count),
      integrity_status: workspace.integrity_status || 'unknown',
    }));
  }

  const workspaceRoot = projection?.workspace_root || path.resolve(process.cwd());
  return [{
    name: workspaceName(workspaceRoot),
    workspace_root_hash: sha256(path.resolve(workspaceRoot)),
    included: verifiedProjection(projection),
    agent_xp: asNumber(projection?.total_agent_xp ?? projection?.total_xp),
    receipts_count: asNumber(projection?.receipts_count),
    integrity_status: projection?.integrity_status || projection?.integrity?.status || 'unknown',
  }];
}

function syncPlayer(args, projection) {
  const explicit = readFirstFlag(args, ['--as', '--player', '--user', '--operator'], null);
  return slugify(
    explicit
    || process.env.ATRIS_PLAYER
    || process.env.ATRIS_USERNAME
    || process.env.ATRIS_PROFILE
    || process.env.USER
    || os.userInfo().username
    || projection?.operator
    || 'player'
  ) || 'player';
}

function buildAgentXpSyncPacket(args = []) {
  const localMode = hasFlag(args, '--local') || hasFlag(args, '--workspace') || hasFlag(args, '--operator');
  const projectionArgs = args.filter(arg => !['--dry-run', '--no-post', '--packet'].includes(arg));
  const projection = hasFlag(args, '--all') || !localMode
    ? collectAllLocalXpProjection(projectionArgs)
    : collectLocalXpProjection(projectionArgs);
  const player = syncPlayer(args, projection);
  const workspaces = projectionWorkspaceSummaries(projection);
  const totalXp = asNumber(projection.total_agent_xp ?? projection.agent_xp ?? projection.total_xp ?? projection.career_xp);
  const receiptsCount = asNumber(projection.receipts_count);
  const eligible = verifiedProjection(projection) && receiptsCount > 0 && totalXp > 0;
  const publicXp = publicAgentXp(totalXp);
  const entry = {
    user_id: player,
    username: player,
    agent_xp: publicXp,
    career_xp: publicXp,
    current_form: publicXp,
    ovr: publicXp,
    level: Math.max(1, asNumber(projection.level, 1)),
    verified_receipts: receiptsCount,
    reviewed_tasks: receiptsCount,
    recent_verified_receipts: receiptsCount,
    recent_reviewed_tasks: receiptsCount,
    leaderboard_eligible: eligible,
    integrity_status: eligible ? 'trusted' : (projection.integrity_status || projection.integrity?.status || 'unknown'),
    lock_reason: eligible ? null : 'not_enough_trusted_proof',
    public_adjustment: null,
    next_move: eligible ? 'Play the next proof-backed AgentXP mission.' : 'Complete one proof-backed AgentXP rep.',
  };
  const packet = {
    schema: 'atris.agentxp_sync_packet.v1',
    generated_at: new Date().toISOString(),
    workspace_root_hash: sha256(workspaces.map(item => item.workspace_root_hash || item.name).sort().join(':')),
    computer: projection.workspace_name || workspaces[0]?.name || 'local',
    operator: player,
    privacy: {
      raw_proofs_included: false,
      raw_receipts_included: false,
      contains_absolute_workspace_root: false,
      public_user_board_omits_lifetime_xp: true,
    },
    sync_contract: {
      anti_bs_rule: 'No accepted proof-backed task episodes means no AgentXP leaderboard movement.',
      trust_rule: 'Only verified local ledgers are uploaded; raw proof and paths stay local.',
    },
    local_evidence: {
      workspaces,
      verified_workspace_count: asNumber(projection.verified_workspace_count, verifiedProjection(projection) ? 1 : 0),
      receipts_count: receiptsCount,
      integrity_status: projection.integrity?.status || projection.integrity_status || 'unknown',
      ledger_head_hash: projection.integrity?.head_hash || null,
    },
    user_leaderboard: {
      schema: 'atris.agentxp_user_leaderboard.v1',
      score_name: AGENT_XP_LABEL,
      entries: [entry],
    },
  };
  packet.packet_hash = hashPayload(packet);
  return {
    schema: 'atris.agentxp_sync_preview.v1',
    generated_at: new Date().toISOString(),
    dry_run: true,
    player,
    entry,
    packet,
  };
}

async function syncAgentXp(args = []) {
  const preview = buildAgentXpSyncPacket(args);
  const dryRun = hasFlag(args, '--dry-run') || hasFlag(args, '--no-post') || hasFlag(args, '--packet');
  if (dryRun) return preview;

  const token = readFlag(args, '--token', process.env.ATRIS_AGENTXP_SYNC_TOKEN || process.env.AGENTXP_SYNC_TOKEN || '');
  const options = {
    method: 'POST',
    body: preview.packet,
    retries: 0,
  };
  if (token) {
    options.headers = { 'X-AgentXP-Sync-Token': token };
  } else {
    const ensured = await ensureValidCredentials(apiRequestJson);
    if (ensured.error) {
      throw new Error(`Missing sync auth. Run atris login, or set ATRIS_AGENTXP_SYNC_TOKEN${ensured.detail ? ` (${ensured.detail})` : ''}.`);
    }
    options.token = ensured.credentials.token;
  }

  const response = await apiRequestJson('/agentxp/leaderboard/sync', options);
  if (!response.ok) {
    throw new Error(`AgentXP sync failed: ${response.error || response.status}`);
  }
  return {
    schema: 'atris.agentxp_sync_result.v1',
    generated_at: new Date().toISOString(),
    dry_run: false,
    player: preview.player,
    entry: preview.entry,
    packet_hash: preview.packet.packet_hash,
    server: response.data || {},
  };
}

function renderSync(payload) {
  const entry = payload.entry || {};
  console.log('AgentXP Sync');
  console.log(`Player ${payload.player || entry.username || 'player'} | AgentXP ${formatNumber(entry.agent_xp)} | receipts ${formatNumber(entry.verified_receipts)}`);
  if (payload.dry_run) {
    console.log(`Packet ${payload.packet?.packet_hash || 'unhashed'} ready; no network upload ran.`);
    console.log('Run with ATRIS_AGENTXP_SYNC_TOKEN set to publish to the hosted leaderboard.');
    return;
  }
  const server = payload.server || {};
  console.log(`Uploaded: accepted ${formatNumber(server.accepted_count)} | stored ${formatNumber(server.stored_count)}`);
  console.log(`Packet ${payload.packet_hash}`);
}

function render(payload) {
  if (payload.schema === 'atris.agentxp_sync_preview.v1' || payload.schema === 'atris.agentxp_sync_result.v1') {
    renderSync(payload);
    return;
  }

  if (payload.schema === 'atris.career_xp_session_capsule.v1') {
    const xp = payload.xp || {};
    const tasks = payload.tasks || {};
    console.log(`${AGENT_XP_LABEL} Session ${payload.window?.label || 'window'}`);
    console.log(`${AGENT_XP_LABEL} earned ${formatNumber(xp.delta_agent_xp ?? xp.delta_xp)} | Total ${formatNumber(xp.after_agent_xp ?? xp.after_total_xp)} | Today ${formatNumber(xp.today_agent_xp ?? xp.today_xp)} | Career Level ${formatNumber(xp.level || 1)}`);
    console.log(`Tasks ${formatNumber(tasks.touched_count)} touched | ${formatNumber(tasks.review_count)} in Review | ${formatNumber(tasks.accepted_count)} accepted`);
    if (payload.proof?.latest_accepted) {
      const proof = payload.proof.latest_accepted;
      console.log(`Latest proof ${proof.task_id || proof.title || 'accepted proof'}: ${textExcerpt(proof.proof, 260)}`);
    } else {
      console.log('Latest proof: none accepted in this session');
    }
    console.log(`Mission: ${payload.mission?.label || 'Capture proof-backed work'}`);
    console.log(`Next quest: ${payload.next_quest || 'Pick the next proof-backed task.'}`);
    if (payload.files?.session_path) console.log(`Capsule: ${payload.files.session_path}`);
    console.log(`Integrity: ${xp.integrity_status || 'unknown'}`);
    return;
  }

  if (payload.schema === 'atris.career_xp_profile.v1') {
    const progress = payload.next_level_progress || {};
    console.log(`${AGENT_XP_LABEL} Card`);
    console.log(`${AGENT_XP_LABEL} ${formatNumber(payload.total_agent_xp ?? payload.total_xp)} | Today ${formatNumber(payload.today_agent_xp ?? payload.today_xp)} | Career Level ${formatNumber(payload.level || 1)}`);
    console.log(`Next career level ${formatNumber(progress.current_xp)}/${formatNumber(progress.required_xp)} ${AGENT_XP_LABEL} (${formatNumber(progress.percent)}%) | ${formatNumber(progress.remaining_xp)} to go`);
    console.log(`Workspaces ${formatNumber(payload.verified_workspace_count)}/${formatNumber(payload.workspace_count)} verified`);
    renderContributionGraph(payload.contribution_graph);
    console.log('');
    for (const workspace of payload.workspaces || []) {
      const marker = workspace.included ? 'included' : 'excluded';
      console.log(`- ${workspace.name}: ${formatNumber(workspace.total_xp)} ${AGENT_XP_LABEL} | today ${formatNumber(workspace.today_xp)} | ${workspace.integrity_status} | ${marker}`);
    }
    if (payload.latest_accepted_proof) {
      const proof = payload.latest_accepted_proof;
      console.log(`Latest proof ${proof.workspace_name || 'workspace'} / ${proof.label || proof.title || 'Accepted proof'}: ${proof.proof}`);
    } else {
      console.log('Latest proof: none accepted yet');
    }
    const integrity = payload.integrity || {};
    console.log(`Integrity: ${integrity.status || 'unknown'} (${integrity.local_trust || 'local'})`);
    for (const warning of integrity.warnings || []) {
      console.log(`Warning: ${warning.workspace_root} ${warning.reason}`);
    }
    return;
  }

  if (payload.schema === 'atris.career_xp_projection.v1') {
    const progress = payload.next_level_progress || {};
    console.log(`${AGENT_XP_LABEL} Card`);
    console.log(`${AGENT_XP_LABEL} ${formatNumber(payload.total_agent_xp ?? payload.total_xp)} | Today ${formatNumber(payload.today_agent_xp ?? payload.today_xp)} | Career Level ${formatNumber(payload.level || 1)}`);
    console.log(`Next career level ${formatNumber(progress.current_xp)}/${formatNumber(progress.required_xp)} ${AGENT_XP_LABEL} (${formatNumber(progress.percent)}%) | ${formatNumber(progress.remaining_xp)} to go`);
    renderContributionGraph(payload.contribution_graph);
    console.log('');
    if (payload.latest_accepted_proof) {
      const proof = payload.latest_accepted_proof;
      console.log(`Latest proof ${proof.label || proof.title || 'Accepted proof'}: ${proof.proof}`);
    } else {
      console.log('Latest proof: none accepted yet');
    }
    console.log(`Ledger: ${payload.ledger?.projection_path || CAREER_XP_PROJECTION_FILE}`);
    return;
  }

  const graph = payload.contribution_graph || {};
  const form = currentForm(payload);

  console.log(`${AGENT_XP_LABEL} ${formatNumber(payload.agent_xp ?? payload.career_xp)} | Career Level ${formatNumber(payload.level || 1)}`);
  if (form) {
    const stats = form.visibleStats.length ? ` | ${form.visibleStats.join(', ')}` : '';
    console.log(`Current form ${form.ovr}/99 | ${form.integrityStatus}${stats}`);
  }
  console.log(`Last ${formatNumber(graph.window_days || 365)} days: ${formatNumber(graph.total_xp)} ${AGENT_XP_LABEL} across ${formatNumber(graph.active_days)} active days`);
  console.log('');
  for (const row of buildContributionRows(graph.days)) {
    console.log(row);
  }
  console.log('');
  console.log('Legend: blank none | . started | : solid | * heavy | # breakout');
  if (payload.leaderboard_eligible === false) {
    console.log('Leaderboard: integrity review needed before public ranking.');
  }
}

async function xpCommand(...args) {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    showHelp();
    return;
  }

  const subcommand = args[0] && !args[0].startsWith('--') ? args[0] : null;
  if (subcommand === 'sync') {
    const commandArgs = args.slice(1);
    let payload;
    try {
      payload = await syncAgentXp(commandArgs);
    } catch (error) {
      console.error(`Failed to sync AgentXP: ${error.message}`);
      process.exit(1);
    }
    if (args.includes('--json')) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    render(payload);
    return;
  }

  if (subcommand === 'session') {
    const commandArgs = args.slice(1);
    let payload;
    try {
      payload = buildCareerXpSessionCapsule(commandArgs);
    } catch (error) {
      console.error(`Failed to build local XP session: ${error.message}`);
      process.exit(1);
    }
    if (args.includes('--json')) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    render(payload);
    return;
  }

  if (subcommand === 'collect' || subcommand === 'status' || subcommand === 'card') {
    const commandArgs = args.slice(1);
    let payload;
    try {
      const explicitLocal = hasFlag(commandArgs, '--local')
        || hasFlag(commandArgs, '--workspace')
        || hasFlag(commandArgs, '--operator');
      const accountStatus = (subcommand === 'status' || subcommand === 'card') && !explicitLocal;
      payload = hasFlag(commandArgs, '--all') || accountStatus
        ? collectAllLocalXpProjection(commandArgs)
        : collectLocalXpProjection(commandArgs);
    } catch (error) {
      console.error(`Failed to collect local XP: ${error.message}`);
      process.exit(1);
    }
    if (args.includes('--json')) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    render(payload);
    return;
  }

  if (subcommand) {
    console.error(`Unknown xp subcommand: ${subcommand}`);
    showHelp();
    process.exit(1);
  }

  const jsonMode = args.includes('--json');
  const localMode = hasFlag(args, '--local') || hasFlag(args, '--workspace') || hasFlag(args, '--operator');
  if (localMode) {
    let payload;
    try {
      payload = collectLocalXpProjection(args);
    } catch (error) {
      console.error(`Failed to collect local XP: ${error.message}`);
      process.exit(1);
    }
    if (jsonMode) {
      console.log(JSON.stringify(payload));
      return;
    }
    render(payload);
    return;
  }

  const ensured = await ensureValidCredentials(apiRequestJson);
  if (ensured.error) {
    console.error(`Not logged in. Run: atris login, or use --local inside a workspace${ensured.detail ? ` (${ensured.detail})` : ''}`);
    process.exit(1);
  }

  const result = await apiRequestJson('/profile/contribution-graph', {
    method: 'GET',
    token: ensured.credentials.token,
  });
  if (!result.ok) {
    console.error(`Failed to load XP graph: ${result.error || result.status}`);
    process.exit(1);
  }

  if (jsonMode) {
    console.log(JSON.stringify(result.data || {}));
    return;
  }

  render(result.data || {});
}

module.exports = {
  xpCommand,
  buildContributionRows,
  buildCareerXpProjection,
  buildAllCareerXpProjection,
  buildCareerXpSessionCapsule,
  collectAllLocalXpProjection,
  collectLocalXpProjection,
  buildAgentXpSyncPacket,
  syncAgentXp,
  receiptFromTaskEpisode,
  render,
};
