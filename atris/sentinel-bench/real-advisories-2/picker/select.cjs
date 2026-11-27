'use strict';
// Pick exam 2 by the written rules, mechanically. Nobody (and no model) chooses
// which advisory fills a slot: candidates are walked in a fixed pseudo-random
// order (sha256 of "sentinel-exam-2:" + advisory id) and the first that passes
// every rule takes the slot. The only human step after this is reading each
// picked fix commit to write down the hole's file and line; a pick whose fix
// cannot be pinned to a few lines is rejected (with the reason logged) and the
// next candidate in order takes the slot.
//
// node select.cjs cands.tsv repos.tsv exam1.json [reject.json] > picks.json
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const [candsPath, reposPath, exam1Path, rejectPath] = process.argv.slice(2);
const exam1 = JSON.parse(fs.readFileSync(exam1Path, 'utf8'));
const rejected = rejectPath && fs.existsSync(rejectPath) ? JSON.parse(fs.readFileSync(rejectPath, 'utf8')) : {};
const oldIds = new Set(exam1.map((a) => a.id));
const oldRepos = new Set(exam1.map((a) => a.repo.toLowerCase()));

// Same classes as exam 1. Exam 1 had one Supabase RLS slot; no reviewed
// advisory in the date range names row level security with a fix commit in a
// repo exam 1 did not use, so that slot goes to access control (5 instead of 4).
const QUOTA = { 'agent-tool': 1, access: 5, signin: 3, webhook: 3, secrets: 2, injection: 2, ssrf: 2, traversal: 2 };
const ORDER = ['agent-tool', 'signin', 'webhook', 'secrets', 'injection', 'ssrf', 'traversal', 'access'];
// Exam 1 mix: 8 Go, 6 Python, 5 TS/JS, 1 SQL. The SQL slot is gone, so 6 TS/JS.
const LANG_CAP = { Go: 8, Python: 6, 'TS/JS': 6 };
const langOf = (l) => (l === 'TypeScript' || l === 'JavaScript' ? 'TS/JS' : l);

const CLASS_CWES = {
  access: [639, 862, 863, 284, 285], signin: [287, 289, 290, 305, 1390], webhook: [345, 347, 348],
  secrets: [200, 359, 522, 538, 312], injection: [89, 78, 94, 943], ssrf: [918], traversal: [22, 23],
};
const classesOf = (cwes) => Object.keys(CLASS_CWES).filter((c) => cwes.some((n) => CLASS_CWES[c].includes(n)));

const repos = new Map();
for (const line of fs.readFileSync(reposPath, 'utf8').trim().split('\n')) {
  const [name, size, language, stars, archived, topics, desc] = line.split('\t');
  repos.set(name.toLowerCase(), { name, size: Number(size), language, archived: archived === 'true', topics: topics || '', desc: desc || '' });
}

// "Web apps, APIs and agent tools over libraries": a repo counts as an app when
// its name, description or topics say so. Pass 1 takes only apps; pass 2 the rest.
const APP_RX = /\b(self[- ]?hosted|server|web ?app|webui|web ui|dashboard|panel|platform|cms|api|portal|admin|application|app|service|bot|mcp|agent|gateway|backend|saas|wiki|forum|blog|crm|erp|chat)\b/i;
const AGENT_RX = /\b(mcp|model context protocol|ai agents?|llm|coding agent)\b/i;
const LIB_RX = /\b(library|lib|sdk|framework|client library|implementation|package|module|toolkit|bindings?|parser|middleware for)\b/i;
// The summary must name the class's kind of flaw, so a CWE tag alone never
// puts an advisory in a slot (CWE tags are broad: CWE-345 covers ICMP spoofing).
const CLASS_WORDS = {
  'agent-tool': /\b(tool|tools|mcp|agent|llm|model|prompt)\b/i,
  access: /\b(authori[sz]\w*|permission\w*|access control|idor|privilege\w*|admin|role|owner\w*|other users?|any user|unauthori[sz]ed|bypass)\b/i,
  signin: /\b(log ?in|sign[- ]?in|authenticat\w*|oauth|sso|openid|oidc|session|account|password|takeover|impersonat\w*|spoof\w*)\b/i,
  webhook: /\b(webhook|signature|signing|hmac|header|forwarded|x-[a-z-]+|ip allow\w*|client ip|spoof\w*)\b/i,
  secrets: /\b(secrets?|tokens?|keys?|credentials?|passwords?|leak\w*|expos\w*|disclos\w*)\b/i,
  injection: /\b(sql|command|commands|inject\w*|exec\w*|eval|code execution|rce|shell)\b/i,
  ssrf: /\b(ssrf|server[- ]side request forgery|url|fetch\w*|redirect\w*|internal)\b/i,
  traversal: /\b(path|travers\w*|file|files|directory|lfi|zip ?slip)\b/i,
};

const cands = fs.readFileSync(candsPath, 'utf8').trim().split('\n').map((l) => {
  const [cls, eco, id, cve, severity, cwe, repoUrl, commit, published, summary] = l.split('\t');
  const slug = repoUrl.replace('https://github.com/', '');
  const cwes = cwe.split(',').filter(Boolean).map((c) => Number(c.replace('CWE-', '')));
  return { cls, eco, id, cve, severity, cwes, slug, commit: commit.split('/commit/')[1], published, summary };
}).filter((c) => c.id);

const key = (id) => crypto.createHash('sha256').update(`sentinel-exam-2:${id}`).digest('hex');
cands.sort((a, b) => (key(a.id) < key(b.id) ? -1 : 1));

const log = [];
function staticReject(c) {
  const r = repos.get(c.slug.toLowerCase());
  if (oldIds.has(c.id)) return 'in exam 1';
  if (oldRepos.has(c.slug.toLowerCase())) return 'repo used in exam 1';
  if (!r || Number.isNaN(r.size)) return 'repo info missing';
  if (r.archived) return 'repo archived';
  if (r.size > 61440) return `repo over 60 MB (${Math.round(r.size / 1024)} MB)`;
  if (!['Go', 'Python', 'TypeScript', 'JavaScript'].includes(r.language)) return `language ${r.language}`;
  if (/^(Duplicate|Withdrawn) Advisory/i.test(c.summary)) return 'duplicate or withdrawn advisory';
  if (rejected[c.id]) return `rejected on reading the fix: ${rejected[c.id]}`;
  return null;
}

const TEST_RX = /(^|\/)(tests?|__tests__|spec|e2e|testdata|fixtures?)(\/|$)|(_test\.go|\.test\.[jt]sx?|\.spec\.[jt]sx?|test_[^/]*\.py|_test\.py)$/i;
const CODE_RX = /\.(go|py|ts|tsx|js|jsx|mjs|cjs|sql)$/i;
const ghJson = (p) => JSON.parse(execFileSync('gh', ['api', p], { encoding: 'utf8', maxBuffer: 256 << 20 }));
const cache = {};
function fixReject(c) {
  let commit;
  try { commit = ghJson(`repos/${c.slug}/commits/${c.commit}`); } catch { return 'fix commit not readable'; }
  if ((commit.parents || []).length !== 1) return `fix commit has ${(commit.parents || []).length} parents`;
  const files = (commit.files || []).filter((f) => CODE_RX.test(f.filename) && !TEST_RX.test(f.filename));
  const lines = files.reduce((t, f) => t + f.additions + f.deletions, 0);
  if (!files.length) return 'fix changes no non-test code';
  if (files.length > 4) return `fix touches ${files.length} code files`;
  if (lines > 120) return `fix changes ${lines} code lines`;
  let tree;
  try { tree = ghJson(`repos/${c.slug}/git/trees/${commit.parents[0].sha}?recursive=1`); } catch { return 'tree not readable'; }
  const blobs = (tree.tree || []).filter((t) => t.type === 'blob').length;
  if (tree.truncated || blobs >= 3000) return `repo has ${tree.truncated ? 'over 100k' : blobs} tracked files`;
  cache[c.id] = { fix_commit: commit.sha, vulnerable_commit: commit.parents[0].sha, files: files.map((f) => `${f.filename} +${f.additions}-${f.deletions}`), repo_files: blobs };
  return null;
}

const picks = [];
const usedRepos = new Set();
const langCount = {};
function take(slot, filter) {
  for (const pass of [1, 2]) {
    for (const c of cands) {
      if (picks.filter((p) => p.slot === slot).length >= QUOTA[slot]) return;
      if (usedRepos.has(c.slug.toLowerCase())) continue;
      if (!filter(c)) continue;
      const r = repos.get(c.slug.toLowerCase());
      const s = staticReject(c);
      if (s) continue;
      const text = `${r.name} ${r.desc} ${r.topics}`;
      const app = APP_RX.test(text) && !LIB_RX.test(`${r.desc} ${r.topics}`);
      if (pass === 1 && !app) continue;
      if (pass === 2 && app) continue;
      if (!CLASS_WORDS[slot].test(c.summary)) { log.push(`${slot}\t${c.id}\tskip: summary does not name the flaw kind`); continue; }
      const lang = langOf(r.language);
      if ((langCount[lang] || 0) >= LANG_CAP[lang]) { log.push(`${slot}\t${c.id}\tskip: ${lang} cap reached`); continue; }
      const f = fixReject(c);
      if (f) { log.push(`${slot}\t${c.id}\treject: ${f}`); continue; }
      usedRepos.add(c.slug.toLowerCase());
      langCount[lang] = (langCount[lang] || 0) + 1;
      picks.push({ slot, id: c.id, cve: c.cve || null, severity: c.severity, cwes: c.cwes, repo: r.name, language: r.language, published: c.published, summary: c.summary, pass, ...cache[c.id] });
      log.push(`${slot}\t${c.id}\tPICK (pass ${pass})`);
    }
  }
}

for (const slot of ORDER) {
  if (slot === 'agent-tool') {
    take(slot, (c) => {
      const r = repos.get(c.slug.toLowerCase());
      const cl = classesOf(c.cwes);
      return r && AGENT_RX.test(`${r.name} ${r.desc} ${r.topics}`) && cl.length >= 1;
    });
  } else {
    take(slot, (c) => { const cl = classesOf(c.cwes); return cl.length === 1 && cl[0] === slot; });
  }
}

fs.writeFileSync('select.log', log.join('\n') + '\n');
console.log(JSON.stringify({ picks, langCount }, null, 2));
