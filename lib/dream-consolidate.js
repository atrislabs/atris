'use strict';

// Offline dreaming pass: audit raw runs against durable memory, de-poison and
// deduplicate lessons, patch wiki index gaps, trim bloated member now.md files,
// and promote the top verified invariants into atris/MEMORY_CORE.md.
//
// Safe by default: dry-run reports findings without mutating files; --apply
// archives every pruned or trimmed item under .atris/state/dream_archive* so
// nothing is lost silently.

const fs = require('fs');
const path = require('path');
const wiki = require('./wiki');
const { appendLedgerEntry } = require('./lesson-ledger');
const { MEMORY_CORE_PATH } = require('./member-context');
const { TRACE_REL } = require('./swarm-comms');

const DEFAULT_MAX_CORE = 10;
const DEFAULT_MAX_NOW_BYTES = 12 * 1024;
const TRIMMED_NOW_TAIL_BYTES = 4 * 1024;
const LESSON_LINE_RE = /^\s*-\s*\*\*\[(\d{4}-\d{2}-\d{2})\]\s*([a-z0-9][a-z0-9-]*)\*\*\s*[\u2014:-]+\s*(pass|fail|draft)?\s*[\u2014:-]*\s*(.*)$/i;
const LOCAL_PATH_RE = /(?<![a-zA-Z0-9._/-])((?:commands|lib|bin|scripts|utils|test|atris)\/[a-zA-Z0-9._/-]+\.(?:js|mjs|ts|py|sh|md|json))\b/g;

function safeRead(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function safeJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function readJsonl(file) {
  const text = safeRead(file);
  if (!text) return [];
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip malformed line */ }
  }
  return rows;
}

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

function appendJsonl(file, rows) {
  if (!rows.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
}

function cleanProse(text, max = 180) {
  const flat = String(text || '')
    .replace(/[\u2012-\u2015]/g, '-')
    .replace(/,\s+(and|but)\b/gi, ' $1')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (sentenceEnd >= Math.floor(max * 0.5)) return cut.slice(0, sentenceEnd + 1).trim();
  const space = cut.lastIndexOf(' ');
  const clipped = (space > Math.floor(max * 0.5) ? cut.slice(0, space) : cut).replace(/[,;:\-]+$/, '').trim();
  return /[.!?]$/.test(clipped) ? clipped : `${clipped}.`;
}

function collectFailureCorpus(root) {
  const failures = [];
  const episodes = readJsonl(path.join(root, '.atris', 'state', 'task_episodes.jsonl'));
  for (const ep of episodes) {
    const reward = Number(ep && ep.reward && ep.reward.value);
    const status = String((ep && ep.outcome) || (ep && ep.status) || (ep && ep.human_feedback && ep.human_feedback.approval_status) || '').toLowerCase();
    if ((Number.isFinite(reward) && reward < 0) || ['failed', 'fail', 'rejected', 'reverted', 'revise'].includes(status)) {
      failures.push({
        source: 'task_episodes',
        ts: String(ep.ts || ep.created_at || ''),
        text: JSON.stringify(ep).toLowerCase(),
      });
    }
  }

  const missions = readJsonl(path.join(root, '.atris', 'state', 'missions.jsonl'));
  for (const m of missions) {
    const status = String((m && m.status) || '').toLowerCase();
    const reason = String((m && (m.stop_reason || m.last_error || m.error)) || '');
    if (status === 'failed' || /error|fail|loop|retry|poison|timeout/i.test(reason)) {
      failures.push({
        source: 'missions',
        ts: String(m.updated_at || m.created_at || ''),
        text: `${m.objective || ''} ${reason}`.toLowerCase(),
      });
    }
  }

  const runsDir = path.join(root, 'atris', 'runs');
  if (fs.existsSync(runsDir)) {
    let names = [];
    try { names = fs.readdirSync(runsDir).filter((n) => /^mission-.*\.json$/.test(n)).sort().slice(-60); } catch { names = []; }
    for (const name of names) {
      const parsed = safeJson(path.join(runsDir, name));
      if (!parsed || typeof parsed !== 'object') continue;
      const failed = parsed.ok === false || parsed.verified === false || /fail|error|retry|stuck/i.test(String(parsed.status || parsed.reason || ''));
      if (failed) {
        failures.push({
          source: `runs/${name}`,
          ts: String(parsed.ts || parsed.created_at || parsed.finished_at || ''),
          text: JSON.stringify(parsed).toLowerCase(),
        });
      }
    }
  }

  const swarmLoopRows = readJsonl(path.join(root, '.atris', 'state', 'swarm_loop.jsonl')).slice(-200);
  for (const row of swarmLoopRows) {
    const steps = Array.isArray(row && row.steps) ? row.steps : (row && row.step ? [row.step] : []);
    const badSteps = steps.filter((s) => s && s.ran && s.ok === false);
    if (badSteps.length || (row && row.frozen_ok === false)) {
      failures.push({
        source: 'swarm_loop',
        ts: String((row && row.ts) || ''),
        text: JSON.stringify({ alerts: row.alerts || [], steps: badSteps }).toLowerCase(),
      });
    }
  }
  return failures;
}

function parseLessonsFile(root) {
  const file = path.join(root, 'atris', 'lessons.md');
  const content = safeRead(file);
  if (!content) return { file, content: '', lines: [], entries: [] };
  const lines = content.split(/\r?\n/);
  const entries = [];
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    const m = line.match(LESSON_LINE_RE);
    if (!m) continue;
    const date = m[1];
    const slug = m[2].toLowerCase();
    const kind = String(m[3] || 'note').toLowerCase();
    const body = String(m[4] || '').trim();
    const resolved = /^\[resolved\b/i.test(body);
    const refs = [...new Set([...body.matchAll(LOCAL_PATH_RE)].map((r) => r[1]))];
    entries.push({ lineIndex: idx, raw: line, date, slug, kind, body, resolved, refs });
  }
  return { file, content, lines, entries };
}

function auditLessons(root, parsed, meta, failures) {
  const bySlug = new Map();
  for (const entry of parsed.entries) {
    const list = bySlug.get(entry.slug) || [];
    list.push(entry);
    bySlug.set(entry.slug, list);
  }

  const duplicates = [];
  const keepers = [];
  for (const [slug, group] of bySlug.entries()) {
    if (group.length === 1) {
      keepers.push(group[0]);
      continue;
    }
    const sorted = [...group].sort((a, b) => {
      if (a.resolved !== b.resolved) return a.resolved ? -1 : 1;
      if (a.date !== b.date) return b.date.localeCompare(a.date);
      return b.raw.length - a.raw.length;
    });
    keepers.push(sorted[0]);
    for (const drop of sorted.slice(1)) {
      duplicates.push({
        slug,
        lineIndex: drop.lineIndex,
        date: drop.date,
        reason: `duplicate of ${sorted[0].date} ${slug}`,
        raw: drop.raw,
      });
    }
  }

  const poisoned = [];
  for (const entry of keepers) {
    const metaRow = meta && meta[entry.slug] && typeof meta[entry.slug] === 'object' ? meta[entry.slug] : null;
    const isResolved = entry.resolved || String(metaRow && metaRow.status || '').toLowerCase() === 'resolved';
    const missingRefs = entry.refs.filter((rel) => !fs.existsSync(path.join(root, rel)));
    const repeatHits = failures.filter((f) => f.text.includes(entry.slug) && (!f.ts || f.ts.slice(0, 10) >= entry.date)).length;

    if (!isResolved && missingRefs.length > 0 && missingRefs.length === entry.refs.length) {
      poisoned.push({
        slug: entry.slug,
        lineIndex: entry.lineIndex,
        date: entry.date,
        reason: `references missing file(s): ${missingRefs.join(', ')}`,
        action: 'quarantine',
        raw: entry.raw,
      });
    } else if (repeatHits >= 2 && !isResolved) {
      poisoned.push({
        slug: entry.slug,
        lineIndex: entry.lineIndex,
        date: entry.date,
        reason: `correlated with ${repeatHits} failed runs since ${entry.date}`,
        action: 'flag',
        raw: entry.raw,
      });
    }
  }

  return { keepers, duplicates, poisoned };
}

function auditLearnedFile(root) {
  const file = path.join(root, 'atris', 'learned.md');
  const content = safeRead(file);
  if (!content) return { file, exists: false, duplicates: 0, cleaned: '' };
  const lines = content.split(/\r?\n/);
  const seen = new Set();
  const out = [];
  let duplicates = 0;
  for (const line of lines) {
    if (line.startsWith('- ')) {
      const key = line.replace(/\s+/g, ' ').trim().toLowerCase();
      if (seen.has(key)) {
        duplicates += 1;
        continue;
      }
      seen.add(key);
    }
    out.push(line);
  }
  return { file, exists: true, duplicates, cleaned: out.join('\n') };
}

function auditMemberNowFiles(root, maxBytes = DEFAULT_MAX_NOW_BYTES) {
  const teamDir = path.join(root, 'atris', 'team');
  if (!fs.existsSync(teamDir)) return [];
  const bloated = [];
  for (const entry of fs.readdirSync(teamDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
    const nowFile = path.join(teamDir, entry.name, 'now.md');
    let stat;
    try { stat = fs.statSync(nowFile); } catch { continue; }
    if (stat.isFile() && stat.size > maxBytes) {
      bloated.push({
        member: entry.name,
        file: path.relative(root, nowFile).replace(/\\/g, '/'),
        fullPath: nowFile,
        bytes: stat.size,
      });
    }
  }
  return bloated.sort((a, b) => b.bytes - a.bytes);
}

function extractCoreRule(entry) {
  const body = entry.body.replace(/^\[resolved[^\]]*\]\s*/i, '').trim();
  const ruleMatch = body.match(/\brule:\s*([^]+?)(?=\s+(?:detector|mechanism|fix shipped):|$)/i);
  if (ruleMatch && ruleMatch[1].trim().length >= 16) {
    return cleanProse(ruleMatch[1], 190);
  }
  const mechMatch = body.match(/\bmechanism:\s*([^]+?)(?=\s+(?:detector|rule):|$)/i);
  if (mechMatch && mechMatch[1].trim().length >= 16) {
    return cleanProse(mechMatch[1], 190);
  }
  const firstSentence = body.split(/(?<=[.!?])\s+/)[0] || body;
  return cleanProse(firstSentence, 190);
}

function scoreInvariant(entry, metaRow, poisonedSlugs) {
  if (poisonedSlugs.has(entry.slug)) return -1000;
  if (/^experiment-/.test(entry.slug) && /kept \(superset\)/i.test(entry.body)) return -500;
  let score = 0;
  if (/\brule:/i.test(entry.body)) score += 60;
  if (/\bmechanism:/i.test(entry.body)) score += 35;
  if (/\bdetector:/i.test(entry.body)) score += 25;
  if (entry.kind === 'fail') score += 15;
  if (entry.resolved) score += 10;
  if (metaRow) {
    const status = String(metaRow.status || '').toLowerCase();
    if (['open', 'observed', 'attempted'].includes(status)) score += 30;
    if (metaRow.mechanism && /prompt[-_\s]?rule/i.test(JSON.stringify(metaRow.mechanism))) score += 45;
  }
  // Recency tie-breaker (YYYYMMDD integer scaled gently).
  const dayNum = Number(entry.date.replace(/-/g, '')) || 0;
  score += Math.floor((dayNum - 20250000) / 100);
  return score;
}

function buildMemoryCore(keepers, meta, poisonedSlugs, maxCore = DEFAULT_MAX_CORE) {
  const ranked = keepers
    .map((entry) => ({
      entry,
      score: scoreInvariant(entry, meta && meta[entry.slug], poisonedSlugs),
      rule: extractCoreRule(entry),
    }))
    .filter((item) => item.score > 0 && item.rule.length >= 16)
    .sort((a, b) => b.score - a.score || b.entry.date.localeCompare(a.entry.date) || a.entry.slug.localeCompare(b.entry.slug));

  const seenRules = new Set();
  const top = [];
  for (const item of ranked) {
    const norm = item.rule.toLowerCase();
    if (seenRules.has(norm)) continue;
    seenRules.add(norm);
    top.push(item);
    if (top.length >= maxCore) break;
  }

  const today = new Date().toISOString().slice(0, 10);
  const lines = [
    '# Core Verified Memory',
    '',
    `Distilled by offline dreaming on ${today}. Top ${top.length} verified invariants loaded on startup.`,
    '',
  ];
  if (!top.length) {
    lines.push('- No verified invariants promoted yet. Run `atris dream consolidate --apply` after recording lessons.');
  } else {
    for (const item of top) {
      lines.push(`- **${item.entry.slug}** (${item.entry.date}): ${item.rule}`);
    }
  }
  lines.push('');
  return {
    items: top.map((item) => ({ slug: item.entry.slug, date: item.entry.date, rule: item.rule, score: item.score })),
    markdown: lines.join('\n'),
  };
}

function auditWiki(root) {
  const wikiDir = wiki.findLocalWikiDir(root);
  if (!wikiDir) {
    return { exists: false, stale: [], orphans: [], brokenIndexLinks: [], metabolism: [] };
  }
  const stale = wiki.findStaleWikiPages(root);
  const orphans = wiki.findWikiOrphans(root);
  const metabolism = wiki.findWikiMetabolismFindings(root);
  const indexPath = path.join(wikiDir, 'index.md');
  const indexText = safeRead(indexPath);
  const brokenIndexLinks = [];
  const matches = [...indexText.matchAll(/\[\[([^\]]+)\]\]/g)];
  for (const m of matches) {
    const rawTarget = String(m[1]).split('|')[0].trim();
    if (!rawTarget || /^https?:\/\//i.test(rawTarget)) continue;
    const candidates = [
      path.join(root, rawTarget),
      path.join(wikiDir, rawTarget),
      path.join(root, `${rawTarget}.md`),
      path.join(wikiDir, `${rawTarget}.md`),
    ];
    if (!candidates.some((c) => fs.existsSync(c))) {
      brokenIndexLinks.push(rawTarget);
    }
  }
  return {
    exists: true,
    wikiDir,
    indexPath,
    stale,
    orphans,
    brokenIndexLinks: [...new Set(brokenIndexLinks)],
    metabolism,
  };
}

function trimBloatedNowFile(root, item, stamp) {
  const raw = safeRead(item.fullPath);
  if (!raw) return false;
  const archiveDir = path.join(root, '.atris', 'state', 'dream_archive');
  fs.mkdirSync(archiveDir, { recursive: true });
  const safeStamp = stamp.replace(/[^0-9TZ]/g, '').slice(0, 15);
  fs.writeFileSync(path.join(archiveDir, `${item.member}-now-${safeStamp}.md`), raw, 'utf8');

  const lines = raw.split(/\r?\n/);
  const heading = lines.find((l) => /^#\s+/.test(l)) || `# ${item.member} now`;
  const tail = raw.slice(Math.max(0, raw.length - TRIMMED_NOW_TAIL_BYTES));
  const newline = tail.indexOf('\n');
  const cleanTail = newline >= 0 ? tail.slice(newline + 1).trim() : tail.trim();
  const compact = [
    heading,
    '',
    `> Trimmed by offline dreaming on ${stamp.slice(0, 10)}. Earlier history archived under .atris/state/dream_archive/.`,
    '',
    cleanTail,
    '',
  ].join('\n');
  writeAtomic(item.fullPath, compact);
  return true;
}

function patchWikiOrphans(root, wikiAudit) {
  if (!wikiAudit.exists || !wikiAudit.orphans.length) return { added: [], deferred: [] };
  const pages = wiki.readWikiPages(root);
  const byPath = new Map(pages.map((p) => [p.relativePath, p]));
  let indexContent = safeRead(wikiAudit.indexPath);
  const cap = (wiki.DEFAULT_WIKI_METABOLISM_BUDGETS && Number(wiki.DEFAULT_WIKI_METABOLISM_BUDGETS.index)) || 40;
  const currentBullets = indexContent.split(/\r?\n/).filter((l) => /^\s*-\s+/.test(l)).length;
  let slots = Math.max(0, cap - currentBullets);
  const added = [];
  const deferred = [];
  const lines = [];
  for (const rel of wikiAudit.orphans) {
    if (indexContent.includes(`[[${rel}]]`)) continue;
    if (slots <= 0) {
      deferred.push(rel);
      continue;
    }
    const page = byPath.get(rel);
    const fm = (page && page.frontmatter) || {};
    const desc = cleanProse(fm.actionability || fm.title || path.basename(rel, '.md'), 140);
    lines.push(`- [[${rel}]]: ${desc}`);
    added.push(rel);
    slots -= 1;
  }
  if (!added.length) return { added: [], deferred };
  if (!indexContent.endsWith('\n')) indexContent += '\n';
  if (!/\n## dream-indexed\b/i.test(indexContent)) {
    indexContent += '\n## dream-indexed\n\n';
  }
  indexContent += `${lines.join('\n')}\n`;
  writeAtomic(wikiAudit.indexPath, indexContent);
  return { added, deferred };
}

// Build Slice 2 of CORDINATION_MODEL.md: join pending routing trace rows
// against task_episodes.jsonl and missions.jsonl so each route gets a real
// outcome label (`accepted` | `failed`) for future router evaluation/training.
function joinCoordinationTraceOutcomes(root, apply) {
  const tracePath = path.join(root, TRACE_REL);
  const rows = readJsonl(tracePath);
  if (!rows.length) {
    return { total: 0, pending: 0, joined: 0, accepted: 0, failed: 0, tiers: { 1: 0, 2: 0, 3: 0 } };
  }

  const episodes = readJsonl(path.join(root, '.atris', 'state', 'task_episodes.jsonl'));
  const missions = readJsonl(path.join(root, '.atris', 'state', 'missions.jsonl'));
  const loopRows = readJsonl(path.join(root, '.atris', 'state', 'swarm_loop.jsonl'));

  // Build per-source maps (latest row wins within each source), then merge by priority:
  // episodes > missions > swarm_loop so stale historical failures never overwrite fresh retries.
  const episodeOutcomes = new Map();
  for (const ep of episodes) {
    const key = String((ep && (ep.task_id || ep.task_key)) || '').trim();
    if (!key) continue;
    const reward = Number(ep && ep.reward && ep.reward.value);
    const status = String((ep && (ep.status || ep.outcome || (ep.human_feedback && ep.human_feedback.approval_status))) || '').toLowerCase();
    if (['failed', 'fail', 'rejected', 'reverted'].includes(status) || (Number.isFinite(reward) && reward < 0)) {
      episodeOutcomes.set(key, 'failed');
    } else if (['accepted', 'done', 'kept', 'pass', 'approved'].includes(status) || (Number.isFinite(reward) && reward > 0)) {
      episodeOutcomes.set(key, 'accepted');
    }
  }

  const missionOutcomes = new Map();
  for (const m of missions) {
    const key = String((m && (m.id || m.task_key)) || '').trim();
    if (!key) continue;
    const status = String((m && m.status) || '').toLowerCase();
    if (status === 'complete' || status === 'completed') missionOutcomes.set(key, 'accepted');
    else if (status === 'failed') missionOutcomes.set(key, 'failed');
  }

  const loopOutcomes = new Map();
  for (const row of loopRows) {
    const steps = Array.isArray(row && row.steps) ? row.steps : (row && row.step ? [row.step] : []);
    for (const s of steps) {
      if (!s || !s.ran || !s.task_key) continue;
      if (s.ok === false) loopOutcomes.set(s.task_key, 'failed');
      else if (s.reviewed === true && s.ok === true) loopOutcomes.set(s.task_key, 'accepted');
      else if (s.ok === true) loopOutcomes.set(s.task_key, 'review_pending');
    }
  }

  const outcomeByTask = new Map([...loopOutcomes, ...missionOutcomes, ...episodeOutcomes]);

  let joined = 0;
  let dirty = false;
  const updated = rows.map((row) => {
    const cur = String((row && row.outcome) || '').toLowerCase();
    if (!row || (cur && cur !== 'pending' && cur !== 'review_pending')) return row;
    const key = String(row.task_key || '').trim();
    let matched = key ? outcomeByTask.get(key) : null;
    if (!matched && row.intent) {
      const needle = String(row.intent).toLowerCase().slice(0, 40);
      const ep = episodes.find((e) => {
        const title = String((e && e.state && e.state.title) || '').toLowerCase();
        return title && needle.length >= 12 && (title.includes(needle) || needle.includes(title));
      });
      if (ep) {
        const reward = Number(ep && ep.reward && ep.reward.value);
        const st = String((ep && (ep.status || ep.outcome)) || '').toLowerCase();
        if (['failed', 'fail', 'rejected', 'reverted'].includes(st) || (Number.isFinite(reward) && reward < 0)) matched = 'failed';
        else if (['accepted', 'done', 'kept'].includes(st) || (Number.isFinite(reward) && reward > 0)) matched = 'accepted';
      }
    }
    if (!matched || matched === cur) return row;
    joined += 1;
    dirty = true;
    return { ...row, outcome: matched, joined_at: new Date().toISOString() };
  });

  if (apply && dirty) {
    writeAtomic(tracePath, `${updated.map((r) => JSON.stringify(r)).join('\n')}\n`);
  }

  const tiers = { 1: 0, 2: 0, 3: 0 };
  let accepted = 0;
  let failed = 0;
  let pending = 0;
  for (const row of updated) {
    const t = Number(row && row.tier);
    if (tiers[t] !== undefined) tiers[t] += 1;
    if (row.outcome === 'accepted') accepted += 1;
    else if (row.outcome === 'failed') failed += 1;
    else pending += 1;
  }

  return { total: updated.length, pending, joined, accepted, failed, tiers };
}

function runDreamConsolidate(root = process.cwd(), options = {}) {
  const apply = Boolean(options.apply);
  const stamp = options.stamp || new Date().toISOString();
  const maxCore = Math.max(1, Number(options.maxCore) || DEFAULT_MAX_CORE);
  const maxNowBytes = Math.max(1024, Number(options.maxNowBytes) || DEFAULT_MAX_NOW_BYTES);

  const failures = collectFailureCorpus(root);
  const parsed = parseLessonsFile(root);
  const meta = safeJson(path.join(root, 'atris', 'lessons.json'), {});
  const lessonAudit = auditLessons(root, parsed, meta, failures);
  const learnedAudit = auditLearnedFile(root);
  const bloatedNow = auditMemberNowFiles(root, maxNowBytes);
  const wikiAudit = auditWiki(root);
  const traceJoin = joinCoordinationTraceOutcomes(root, apply);

  const quarantineSlugs = new Set(
    lessonAudit.poisoned.filter((p) => p.action === 'quarantine').map((p) => p.slug)
  );
  const core = buildMemoryCore(lessonAudit.keepers, meta, quarantineSlugs, maxCore);

  const applied = {
    lessons_deduped: 0,
    lessons_quarantined: 0,
    learned_deduped: 0,
    now_files_trimmed: [],
    wiki_orphans_indexed: [],
    wiki_orphans_deferred: [],
    memory_core_written: false,
  };

  if (apply) {
    const dropIndexes = new Set([
      ...lessonAudit.duplicates.map((d) => d.lineIndex),
      ...lessonAudit.poisoned.filter((p) => p.action === 'quarantine').map((p) => p.lineIndex),
    ]);
    if (dropIndexes.size > 0 && parsed.lines.length) {
      const archiveRows = [];
      for (const dup of lessonAudit.duplicates) {
        archiveRows.push({ ts: stamp, kind: 'duplicate_lesson', slug: dup.slug, reason: dup.reason, raw: dup.raw });
      }
      for (const p of lessonAudit.poisoned.filter((item) => item.action === 'quarantine')) {
        archiveRows.push({ ts: stamp, kind: 'poisoned_lesson', slug: p.slug, reason: p.reason, raw: p.raw });
      }
      appendJsonl(path.join(root, '.atris', 'state', 'dream_archive.jsonl'), archiveRows);
      const surviving = parsed.lines.filter((_, idx) => !dropIndexes.has(idx));
      writeAtomic(parsed.file, `${surviving.join('\n').replace(/\n{3,}/g, '\n\n')}`);

      // Keep typed sidecar atris/lessons.json slug-consistent with surviving lessons.md.
      const lessonsJsonPath = path.join(root, 'atris', 'lessons.json');
      if (quarantineSlugs.size > 0 && fs.existsSync(lessonsJsonPath) && meta && typeof meta === 'object') {
        const survivingSlugs = new Set();
        for (const line of surviving) {
          const m = line.match(LESSON_LINE_RE);
          if (m) survivingSlugs.add(m[2].toLowerCase());
        }
        const prunedSidecar = {};
        let sidecarChanged = false;
        const nextMeta = { ...meta };
        for (const slug of quarantineSlugs) {
          if (!survivingSlugs.has(slug) && Object.prototype.hasOwnProperty.call(nextMeta, slug)) {
            prunedSidecar[slug] = nextMeta[slug];
            delete nextMeta[slug];
            sidecarChanged = true;
          }
        }
        if (sidecarChanged) {
          appendJsonl(path.join(root, '.atris', 'state', 'dream_archive.jsonl'), [
            { ts: stamp, kind: 'lessons_json_pruned', entries: prunedSidecar },
          ]);
          writeAtomic(lessonsJsonPath, `${JSON.stringify(nextMeta, null, 2)}\n`);
        }
      }
      applied.lessons_deduped = lessonAudit.duplicates.length;
      applied.lessons_quarantined = lessonAudit.poisoned.filter((p) => p.action === 'quarantine').length;
      try {
        appendLedgerEntry(root, {
          action: 'resolve',
          slug: 'dream-consolidate',
          evidence: `deduped ${applied.lessons_deduped}, quarantined ${applied.lessons_quarantined}`,
          outcome: 'consolidated',
        });
      } catch { /* non-fatal */ }
    }

    if (learnedAudit.exists && learnedAudit.duplicates > 0) {
      writeAtomic(learnedAudit.file, learnedAudit.cleaned);
      applied.learned_deduped = learnedAudit.duplicates;
    }

    for (const item of bloatedNow) {
      if (trimBloatedNowFile(root, item, stamp)) {
        applied.now_files_trimmed.push(item.file);
      }
    }

    if (wikiAudit.exists) {
      const patched = patchWikiOrphans(root, wikiAudit);
      applied.wiki_orphans_indexed = patched.added;
      applied.wiki_orphans_deferred = patched.deferred;
      const health = wikiAudit.stale.length === 0 && wikiAudit.brokenIndexLinks.length === 0
        ? 'clean'
        : `${wikiAudit.stale.length} stale, ${wikiAudit.brokenIndexLinks.length} broken index links`;
      const nextMove = wikiAudit.stale.length
        ? `refresh stale page ${wikiAudit.stale[0].page}`
        : (wikiAudit.brokenIndexLinks.length ? `fix broken link ${wikiAudit.brokenIndexLinks[0]}` : 'keep compiling lessons after work');
      wiki.writeWikiStatus(root, { health, nextMove });
      wiki.appendWikiLog(root, `dream consolidate (${core.items.length} core rules, ${applied.wiki_orphans_indexed.length} orphans indexed)`, [], 'public', 'DREAM');
    }

    if (fs.existsSync(path.join(root, 'atris'))) {
      writeAtomic(path.join(root, MEMORY_CORE_PATH), core.markdown);
      applied.memory_core_written = true;
    }
  }

  return {
    ok: true,
    applied: apply,
    stamp,
    failures_scanned: failures.length,
    lessons: {
      total: parsed.entries.length,
      kept: lessonAudit.keepers.length,
      duplicates: lessonAudit.duplicates.map(({ raw: _r, ...rest }) => rest),
      poisoned: lessonAudit.poisoned.map(({ raw: _r, ...rest }) => rest),
    },
    learned_duplicates: learnedAudit.duplicates,
    bloated_now_files: bloatedNow.map(({ fullPath: _p, ...rest }) => rest),
    wiki: {
      exists: wikiAudit.exists,
      stale_count: wikiAudit.stale.length,
      orphan_count: wikiAudit.orphans.length,
      broken_links: wikiAudit.brokenIndexLinks,
      metabolism_findings: wikiAudit.metabolism.length,
    },
    memory_core: {
      path: MEMORY_CORE_PATH,
      count: core.items.length,
      items: core.items,
    },
    coordination_trace: traceJoin,
    changes: applied,
  };
}

function formatConsolidateReport(result) {
  const ct = result.coordination_trace || { total: 0, joined: 0, accepted: 0, failed: 0 };
  const lines = [
    `dream consolidate (${result.applied ? 'applied' : 'dry run'})`,
    `  failures scanned: ${result.failures_scanned}`,
    `  lessons:          ${result.lessons.total} total, ${result.lessons.duplicates.length} duplicate, ${result.lessons.poisoned.length} poisoned/suspect`,
    `  bloated now.md:   ${result.bloated_now_files.length}${result.bloated_now_files.length ? ` (${result.bloated_now_files.slice(0, 4).map((f) => `${f.member} ${Math.round(f.bytes / 1024)}KB`).join(', ')})` : ''}`,
    `  wiki:             ${result.wiki.exists ? `${result.wiki.stale_count} stale, ${result.wiki.orphan_count} orphans, ${result.wiki.broken_links.length} broken links` : 'none'}`,
    `  routing trace:    ${ct.total} rows (${ct.joined} joined, ${ct.accepted} accepted, ${ct.failed} failed)`,
    `  core memory:      ${result.memory_core.count} invariants -> ${result.memory_core.path}`,
  ];
  if (result.applied) {
    lines.push(
      `  written:          deduped ${result.changes.lessons_deduped}, quarantined ${result.changes.lessons_quarantined}, trimmed ${result.changes.now_files_trimmed.length} now.md, indexed ${result.changes.wiki_orphans_indexed.length} wiki pages`
    );
  } else {
    lines.push('  next:             atris dream consolidate --apply');
  }
  return lines.join('\n');
}

module.exports = {
  runDreamConsolidate,
  formatConsolidateReport,
};
