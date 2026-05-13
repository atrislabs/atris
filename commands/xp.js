const { ensureValidCredentials } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const INTENSITY_CHARS = [' ', '.', ':', '*', '#'];
const ROW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TASK_EPISODES_FILE = path.join('.atris', 'state', 'task_episodes.jsonl');
const CAREER_XP_RECEIPTS_FILE = path.join('.atris', 'state', 'career_xp_receipts.jsonl');
const CAREER_XP_PROJECTION_FILE = path.join('.atris', 'state', 'career_xp.projection.json');
const CAREER_XP_CURSOR_FILE = path.join('.atris', 'state', 'career_xp.cursor.json');
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
  console.log('Usage: atris xp [status|collect] [--json] [--workspace <path>] [--all] [--root <path>]');
  console.log('       atris xp [--json] [--local] [--workspace <path>] [--operator <name>]');
  console.log('');
  console.log('Show your Career XP contribution graph for the active Atris account.');
  console.log('Use status/collect to project accepted local task proof into a durable XP ledger.');
  console.log('Use status --all to aggregate verified local XP ledgers across workspaces.');
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

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8');
  return content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line));
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

function readJsonFile(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
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
    if (hadIntegrity && receipt.receipt_hash !== expected.receipt_hash) {
      errors.push(`receipt_hash_mismatch:${receiptLabel(receipt)}`);
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

function readTaskEpisodeTail(episodePath, cursorPath) {
  const stat = fs.existsSync(episodePath) ? fs.statSync(episodePath) : null;
  const cursor = readJsonFile(cursorPath, null);
  const previousBytes = Number(cursor?.bytes_read || 0);
  const size = stat ? stat.size : 0;
  const reset = !cursor || cursor.source_path !== episodePath || size < previousBytes;
  const start = reset ? 0 : previousBytes;
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
    const episodes = buffer.toString('utf8')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => JSON.parse(line));
    return {
      episodes,
      cursor: {
        schema: 'atris.career_xp_cursor.v1',
        source_path: episodePath,
        bytes_read: size,
        source_size: size,
        last_episode_id: episodes.length ? episodes[episodes.length - 1].episode_id || null : cursor?.last_episode_id || null,
        updated_at: new Date().toISOString(),
        reset,
      },
    };
  } finally {
    fs.closeSync(fd);
  }
}

function receiptFromTaskEpisode(episode) {
  const eligible = episode?.career_xp?.eligible === true || episode?.rl?.label === 'accepted';
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
  const latest = latestReceipt(accepted);

  return {
    schema: 'atris.career_xp_projection.v1',
    generated_at: new Date().toISOString(),
    workspace_root: workspace,
    career_xp: totalXp,
    total_xp: totalXp,
    today_xp: todayXp,
    level,
    leaderboard_eligible: false,
    integrity_status: integrity.status || 'unknown',
    next_level_progress: {
      level,
      next_level: level + 1,
      current_xp: currentLevelXp,
      required_xp: LEVEL_XP,
      remaining_xp: remainingXp,
      percent: Math.round((currentLevelXp / LEVEL_XP) * 1000) / 10,
    },
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

function collectLocalXpProjection(args = []) {
  const workspace = path.resolve(readFlag(args, '--workspace', process.cwd()));
  const episodePath = path.join(workspace, TASK_EPISODES_FILE);
  const receiptsPath = path.join(workspace, CAREER_XP_RECEIPTS_FILE);
  const projectionPath = path.join(workspace, CAREER_XP_PROJECTION_FILE);
  const cursorPath = path.join(workspace, CAREER_XP_CURSOR_FILE);
  let existingChain = normalizeReceiptChain(readJsonl(receiptsPath));
  if ((existingChain.upgraded || existingChain.deduped) && existingChain.integrity.status === 'verified') {
    writeJsonl(receiptsPath, existingChain.receipts);
    existingChain = normalizeReceiptChain(existingChain.receipts);
  }
  if (existingChain.integrity.status === 'tampered') {
    const projection = buildCareerXpProjection([], workspace, existingChain.integrity);
    writeJson(projectionPath, projection);
    return {
      ...projection,
      collected_receipts: 0,
    };
  }

  const tail = readTaskEpisodeTail(episodePath, cursorPath);
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

  appendJsonl(receiptsPath, newReceipts);
  writeJson(cursorPath, tail.cursor);
  writeJson(projectionPath, projection);

  return {
    ...projection,
    collected_receipts: newReceipts.length,
  };
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
  const latest = verified
    .map(projection => ({
      ...(projection.latest_accepted_proof || {}),
      workspace_root: projection.workspace_root,
      workspace_name: workspaceName(projection.workspace_root),
    }))
    .filter(proof => proof && proof.accepted_at)
    .sort((a, b) => new Date(b.accepted_at).getTime() - new Date(a.accepted_at).getTime())[0] || null;

  return {
    schema: 'atris.career_xp_profile.v1',
    generated_at: new Date().toISOString(),
    search_roots: searchRoots,
    workspace_count: workspaces.length,
    verified_workspace_count: verified.length,
    career_xp: totalXp,
    total_xp: totalXp,
    today_xp: todayXp,
    level,
    leaderboard_eligible: false,
    next_level_progress: {
      level,
      next_level: level + 1,
      current_xp: currentLevelXp,
      required_xp: LEVEL_XP,
      remaining_xp: Math.max(0, (level * LEVEL_XP) - totalXp),
      percent: Math.round((currentLevelXp / LEVEL_XP) * 1000) / 10,
    },
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

function normalizeLocalScore(score, workspace) {
  const card = score.profile_card || {};
  const integrity = score.integrity || {};
  const careerXp = asNumber(card.career_xp);
  const leaderboardEligible = Boolean(
    card.leaderboard_eligible ?? integrity.leaderboard_eligible
  );

  return {
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

function render(payload) {
  if (payload.schema === 'atris.career_xp_profile.v1') {
    const progress = payload.next_level_progress || {};
    console.log(`Career XP ${formatNumber(payload.total_xp)} | Today ${formatNumber(payload.today_xp)} | Level ${formatNumber(payload.level || 1)}`);
    console.log(`Next level ${formatNumber(progress.current_xp)}/${formatNumber(progress.required_xp)} XP (${formatNumber(progress.percent)}%) | ${formatNumber(progress.remaining_xp)} to go`);
    console.log(`Workspaces ${formatNumber(payload.verified_workspace_count)}/${formatNumber(payload.workspace_count)} verified`);
    for (const workspace of payload.workspaces || []) {
      const marker = workspace.included ? 'included' : 'excluded';
      console.log(`- ${workspace.name}: ${formatNumber(workspace.total_xp)} XP | today ${formatNumber(workspace.today_xp)} | ${workspace.integrity_status} | ${marker}`);
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
    console.log(`Career XP ${formatNumber(payload.total_xp)} | Today ${formatNumber(payload.today_xp)} | Level ${formatNumber(payload.level || 1)}`);
    console.log(`Next level ${formatNumber(progress.current_xp)}/${formatNumber(progress.required_xp)} XP (${formatNumber(progress.percent)}%) | ${formatNumber(progress.remaining_xp)} to go`);
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

  console.log(`Career XP ${formatNumber(payload.career_xp)} | Level ${formatNumber(payload.level || 1)}`);
  if (form) {
    const stats = form.visibleStats.length ? ` | ${form.visibleStats.join(', ')}` : '';
    console.log(`Current form ${form.ovr}/99 | ${form.integrityStatus}${stats}`);
  }
  console.log(`Last ${formatNumber(graph.window_days || 365)} days: ${formatNumber(graph.total_xp)} XP across ${formatNumber(graph.active_days)} active days`);
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
  if (subcommand === 'collect' || subcommand === 'status') {
    const commandArgs = args.slice(1);
    let payload;
    try {
      payload = hasFlag(commandArgs, '--all')
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

  const jsonMode = args.includes('--json');
  const localMode = hasFlag(args, '--local') || hasFlag(args, '--workspace') || hasFlag(args, '--operator');
  if (localMode) {
    let payload;
    try {
      payload = loadLocalPayload(args);
    } catch (error) {
      console.error(`Failed to load local XP graph: ${error.message}`);
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
  collectAllLocalXpProjection,
  collectLocalXpProjection,
  receiptFromTaskEpisode,
  render,
};
