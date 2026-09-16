'use strict';

const fs = require('fs');
const path = require('path');
const { resolveWorkspaceRoot } = require('../lib/mission-root');
const { readText } = require('./brain');

const BOOT_FILES = [
  'CLAUDE.md', 'AGENTS.md', 'atris/atris.md', 'atris/MAP.md',
  'atris/TODO.md', 'atris/now.md', 'atris/PERSONA.md',
  'atris/brain/STATUS.md', 'atris/brain/self_improvement_ledger.md',
  'atris/wiki/index.md', 'atris/skills/atris/SKILL.md',
];
const DAY = 86400000;
const SCAFFOLD_FOLDERS = new Set(['_archive', '_archived', '_templates', '_template', '_drafts']);
const STOP_WORDS = new Set('the and for are was were where what which who how does did can could should would this that these those with from into about find have has had there here when why'.split(' '));
const DEFAULT_QUESTIONS = 'atris/doc-health/questions.jsonl';

function stat(file) {
  try { return fs.statSync(file); } catch { return null; }
}

function entries(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function folders(root, base) {
  return entries(path.join(root, base)).filter(entry => entry.isDirectory())
    .map(entry => entry.name).sort();
}

function backtickedPaths(text) {
  return [...text.matchAll(/`([^`\r\n]+)`/g)]
    .map(match => match[1].trim().replace(/#.*$/, '').replace(/:\d+(?:-\d+)?$/, '').replace(/^\.\//, ''))
    .filter(file => !/\s|[<>*|]/.test(file) && !file.includes('://')
      && (file.includes('/') || /\.[a-z0-9]+$/i.test(file)));
}

function folderCoverage(text, base, names) {
  const mentions = new Set([...text.matchAll(new RegExp(`${base}/([a-zA-Z0-9_.-]+)`, 'g'))]
    .map(match => match[1]));
  const mentioned = names.filter(name => mentions.has(name));
  return { total: names.length, mentioned: mentioned.length, missing: names.filter(name => !mentions.has(name)) };
}

function collectMap(root, text, featureNames, memberNames) {
  let rows = 0;
  const paths = new Set();
  const lines = text.split(/\r?\n/);
  let inTable = false;
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const marker = line.match(/^(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1][0];
      else if (fence === marker[1][0]) fence = null;
      inTable = false;
      continue;
    }
    if (fence) continue;
    const cells = line.split(/(?<!\\)\|/);
    const nextIsSeparator = /^\s*\|?\s*:?-{3,}:?\s*\|(?:\s*:?-{3,}:?\s*\|?)+\s*$/.test(lines[i + 1] || '');
    if (cells.length < 2 || !(line.startsWith('|') || inTable || nextIsSeparator)) {
      inTable = false;
      continue;
    }
    inTable = true;
    if (cells[0] === '') cells.shift();
    const found = backtickedPaths(cells[1] || '');
    if (!found.length) continue;
    rows++;
    for (const file of found) paths.add(file);
  }
  const files = [...paths].map(file => ({ path: file, exists: fs.existsSync(path.resolve(root, file)) }));
  const existing = files.filter(file => file.exists).length;
  return {
    rows, paths: files.length, existing, files,
    score: files.length ? existing / files.length : 0,
    features: folderCoverage(text, 'atris/features', featureNames),
    members: folderCoverage(text, 'atris/team', memberNames),
  };
}

function collectLookups(root, mapText, questionsPath) {
  const filename = path.resolve(root, questionsPath);
  const result = {
    path: questionsPath, missing: !stat(filename)?.isFile(),
    questions: [], invalid_lines: [], one_hop: 0, two_hops: 0, unresolved: 0, score: null,
  };
  if (result.missing) {
    result.message = `create ${questionsPath} with one object per line:\n{"q":"where is the map","expect":"atris/MAP.md"}`;
    return result;
  }
  const mapLines = mapText.split(/\r?\n/);
  // Most healthy workspaces resolve every question in the map. Read second-hop
  // documents only when needed, sharing each read across unresolved questions.
  let docs;
  const viaDocument = expected => {
    if (!docs) docs = [...new Set(backtickedPaths(mapText).filter(file => file.endsWith('.md')))]
      .filter(file => path.resolve(root, file) !== path.join(root, 'atris', 'MAP.md'))
      .map(file => ({ path: file }));
    for (const doc of docs) {
      if (doc.text === undefined) doc.text = readText(path.resolve(root, doc.path));
      if (doc.text.includes(expected)) return doc.path;
    }
    return null;
  };
  readText(filename).split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    let question;
    try { question = JSON.parse(line); } catch { /* Report bad input without failing the command. */ }
    if (!question || typeof question.q !== 'string' || !question.q.trim()
      || typeof question.expect !== 'string' || !question.expect.trim()) {
      result.invalid_lines.push(index + 1);
      return;
    }
    const keywords = (question.q.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
      .filter(word => word.length >= 3 && !STOP_WORDS.has(word));
    const oneHop = mapLines.some(row => row.includes(question.expect)
      && keywords.some(word => row.toLowerCase().includes(word)));
    const via = oneHop ? null : viaDocument(question.expect);
    const hops = oneHop ? 1 : via ? 2 : null;
    result.questions.push({ q: question.q, expect: question.expect, hops, via });
  });
  result.one_hop = result.questions.filter(question => question.hops === 1).length;
  result.two_hops = result.questions.filter(question => question.hops === 2).length;
  result.unresolved = result.questions.filter(question => question.hops === null).length;
  if (result.questions.length) result.score = result.one_hop / result.questions.length;
  return result;
}

function field(text, label) {
  // Accept both plain and bold metadata labels used in feature idea files.
  const match = text.match(new RegExp(`^[ \\t]*(?:>[ \\t]*)?(?:[-*] )?(?:\\*\\*)?${label}[ \\t]*(?:\\*\\*)?:[ \\t]*(?:\\*\\*)?([^\\r\\n]*)`, 'im'));
  return match ? match[1].replace(/\*\*/g, '').trim() : '';
}

function newestLog(dir, freshAfter = Infinity) {
  let newest = null;
  for (const entry of entries(dir)) {
    const file = path.join(dir, entry.name);
    // Do not follow symlinks into another tree or a recursive loop.
    const candidate = entry.isDirectory() ? newestLog(file, freshAfter)
      : entry.isFile() ? { file, mtime: stat(file)?.mtimeMs } : null;
    if (candidate && Number.isFinite(candidate.mtime) && (!newest || candidate.mtime > newest.mtime)) newest = candidate;
    if (newest && newest.mtime >= freshAfter) return newest;
  }
  return newest;
}

function freshness(items, thresholdDays) {
  const flagged = items.filter(item => item.stale);
  return {
    total: items.length, flagged: flagged.length, threshold_days: thresholdDays,
    score: items.length ? (items.length - flagged.length) / items.length : 1,
    items,
    oldest: [...flagged].sort((a, b) => (b.age_days ?? Infinity) - (a.age_days ?? Infinity)
      || a.name.localeCompare(b.name)).slice(0, 10),
  };
}

function inactiveMember(text) {
  const frontmatter = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return Boolean(frontmatter && /^status:[ \t]*(['"]?)(?:retired|parked|archived)\1[ \t]*(?:#.*)?$/im.test(frontmatter[1]));
}

function collectStaleness(root, featureNames, memberNames, now, scoreOnly = false) {
  const features = featureNames.filter(name => stat(path.join(root, 'atris/features', name, 'idea.md'))?.isFile())
    .map(name => {
      const file = `atris/features/${name}/idea.md`;
      const text = readText(path.join(root, file));
      const date = field(text, 'Last Updated') || field(text, 'Created');
      const written = date ? Date.parse(date) : NaN;
      // Real activity counts: the newer of the written date and the newest file in the folder.
      const newest = newestLog(path.join(root, 'atris/features', name));
      const activity = newest && Number.isFinite(newest.mtime) ? newest.mtime : NaN;
      const timestamp = Number.isFinite(written) && Number.isFinite(activity) ? Math.max(written, activity) : (Number.isFinite(written) ? written : activity);
      const age = Number.isFinite(timestamp) ? (now - timestamp) / DAY : null;
      const status = field(text, 'Status');
      const exempt = /complete|shipped|live|archived|parked|retired|superseded/i.test(status);
      return { name, path: file, date: date || null, status, age_days: age === null ? null : Math.floor(age), stale: age !== null && age > 60 && !exempt };
    });
  const members = memberNames.filter(name => stat(path.join(root, 'atris/team', name, 'MEMBER.md'))?.isFile())
    .filter(name => !inactiveMember(readText(path.join(root, 'atris/team', name, 'MEMBER.md'))))
    .map(name => {
      const newest = newestLog(path.join(root, 'atris/team', name, 'logs'), scoreOnly ? now - 30 * DAY : Infinity);
      const age = newest ? (now - newest.mtime) / DAY : null;
      return {
        name, path: `atris/team/${name}`, newest_log: newest ? path.relative(root, newest.file) : null,
        last_activity: newest ? new Date(newest.mtime).toISOString() : null,
        age_days: age === null ? null : Math.floor(age), stale: !newest || age > 30,
      };
    });
  return {
    features: freshness(features, 60), members: freshness(members, 30),
    member_age_basis: 'newest log file modification time',
  };
}

function nearDuplicates(names) {
  const groups = new Map();
  for (const name of names) {
    if (name.length < 5) continue;
    const prefix = name.slice(0, 5);
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix).push(name);
  }
  return [...groups.values()].filter(group => group.length > 1).map(group => {
    let prefix = group[0];
    while (!group.every(name => name.startsWith(prefix))) prefix = prefix.slice(0, -1);
    return { prefix, names: group };
  });
}

function overallScore(boot, map, lookups, staleness) {
  const round = value => Math.round(value * 100) / 100;
  const part = (score, max) => ({ points: round((score ?? 0) * max), max });
  const parts = {
    lookup_hops: part(lookups.score, 30), map_coverage: part(map.score, 25),
    boot_load: part(Math.min(1, Math.max(0, (200000 - boot.total_chars) / 120000)), 20),
    feature_freshness: part(staleness.features.score, 15), member_freshness: part(staleness.members.score, 10),
  };
  return {
    parts, total: round(Object.values(parts).reduce((sum, value) => sum + value.points, 0)), max: 100,
    lookup_skipped: lookups.score === null,
  };
}

function collectDocHealth({ cwd = process.cwd(), questions = DEFAULT_QUESTIONS, now = Date.now() } = {}) {
  return measureDocHealth(resolveWorkspaceRoot(cwd), { questions, now });
}

// Boot already knows its root. Keep this path in-process, without asking git
// to resolve the workspace or launching another CLI. A recent log is enough
// for the score; only the detailed report needs its exact newest timestamp.
function computeDocHealth(root) {
  const payload = measureDocHealth(root, { scoreOnly: true });
  if (!payload.ok) return payload;
  const { ok, boot_load, lookup_hops, overall } = payload;
  return { ok, boot_load, lookup_hops, overall };
}

function measureDocHealth(root, { questions = DEFAULT_QUESTIONS, now = Date.now(), scoreOnly = false } = {}) {
  if (!stat(path.join(root, 'atris'))?.isDirectory()) {
    return { ok: false, action: 'doc-health', root, message: 'no atris/ folder in this workspace.' };
  }
  const files = BOOT_FILES.map(file => {
    const missing = !stat(path.join(root, file))?.isFile();
    const chars = missing ? 0 : readText(path.join(root, file)).length;
    return { path: file, missing, chars, approximate_tokens: chars / 4, oversized: chars > 20000 };
  });
  const total_chars = files.reduce((sum, file) => sum + file.chars, 0);
  const boot_load = { files, total_chars, approximate_tokens: total_chars / 4, token_estimate: 'chars divided by 4' };
  const mapText = readText(path.join(root, 'atris', 'MAP.md'));
  // Exact scaffolding folder names are skipped. A sibling like _archive-active is still real work.
  const featureNames = folders(root, 'atris/features').filter(name => !SCAFFOLD_FOLDERS.has(name));
  const memberNames = folders(root, 'atris/team').filter(name => !SCAFFOLD_FOLDERS.has(name));
  const map_coverage = collectMap(root, mapText, featureNames, memberNames);
  const lookup_hops = collectLookups(root, mapText, questions);
  const staleness = collectStaleness(root, featureNames, memberNames, now, scoreOnly);
  return {
    ok: true, action: 'doc-health', root, boot_load, map_coverage, lookup_hops, staleness,
    near_duplicates: nearDuplicates(featureNames),
    overall: overallScore(boot_load, map_coverage, lookup_hops, staleness),
  };
}

function table(headers, rows) {
  const cells = [headers, ...rows].map(row => row.map(String));
  const widths = headers.map((_, i) => Math.max(...cells.map(row => row[i].length)));
  return cells.map(row => row.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd());
}

function renderDocHealth(payload) {
  if (!payload.ok) return payload.message;
  const { boot_load: boot, map_coverage: map, lookup_hops: lookup, staleness, overall } = payload;
  const lines = [
    `document health: ${overall.total}/100`, '', 'score',
    ...table(['part', 'points', 'max'], Object.entries(overall.parts).map(([name, part]) => [name.replace(/_/g, ' '), part.points, part.max])),
    '', 'boot load', 'approximate tokens = chars divided by 4',
    ...table(['file', 'chars', 'tokens', 'status'], boot.files.map(file => [file.path, file.chars, file.approximate_tokens, file.missing ? 'missing' : file.oversized ? 'over 20,000 chars' : 'ok'])
      .concat([['total', boot.total_chars, boot.approximate_tokens, '']])),
    '', 'map coverage',
    ...table(['measure', 'count', 'total'], [
      ['routing rows', map.rows, map.rows], ['existing paths', map.existing, map.paths],
      ['features mentioned', map.features.mentioned, map.features.total], ['members mentioned', map.members.mentioned, map.members.total],
    ]),
    '', 'lookup hops',
  ];
  if (lookup.missing) {
    lines.push('skipped: question file is missing.', lookup.message);
  } else {
    lines.push(...table(['question', 'hops'], lookup.questions.map(question => [question.q, question.hops ?? 'unresolved'])));
    if (lookup.score !== null) lines.push(`one-hop share: ${Math.round(lookup.score * 100)}%`);
    if (lookup.invalid_lines.length) lines.push(`invalid question lines skipped: ${lookup.invalid_lines.join(', ')}`);
    if (!lookup.questions.length) lines.push('skipped: no valid questions.');
  }
  if (overall.lookup_skipped) lines.push('lookup score: null; contributes 0 of 30 points.');
  lines.push('', 'staleness',
    ...table(['kind', 'flagged', 'total'], ['features', 'members'].map(kind => [kind, staleness[kind].flagged, staleness[kind].total])),
    'features: older than 60 days and still active.',
    'members: no logs or newest log older than 30 days.',
    `log age: ${staleness.member_age_basis}.`);
  for (const kind of ['features', 'members']) {
    lines.push(`${kind}: oldest flagged (up to ten)`);
    if (!staleness[kind].oldest.length) lines.push('none');
    else lines.push(...table(['name', 'age in days'], staleness[kind].oldest.map(item => [item.name, item.age_days ?? 'no logs'])));
  }
  lines.push('', 'near duplicates: shared prefix of at least 5 chars');
  if (!payload.near_duplicates.length) lines.push('none');
  for (const group of payload.near_duplicates) lines.push(`${group.prefix}: ${group.names.join(', ')}`);
  return lines.join('\n');
}

function docHealthCommand(args = [], options = {}) {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    console.log('usage: atris doc-health [--json] [--questions <path>]');
    return 0;
  }
  const index = args.indexOf('--questions');
  const questions = index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1]
    : args.find(arg => arg.startsWith('--questions='))?.slice('--questions='.length);
  const payload = collectDocHealth({ ...options, ...(questions ? { questions } : {}) });
  console.log(args.includes('--json') ? JSON.stringify(payload, null, 2) : renderDocHealth(payload));
  return payload.ok ? 0 : 1;
}

module.exports = { collectDocHealth, computeDocHealth, docHealthCommand };
