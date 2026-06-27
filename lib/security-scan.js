'use strict';

// atris security scan — deterministic secrets / PII / privacy detectors (no LLM).
//
// A finding is a fact (file:line + rule + severity), so it drops straight into a
// loop / mission / CI gate and doubles as a SOC 2 evidence artifact (machine
// JSON). Precision over recall: a noisy gate gets muted, and a muted gate is dead.
// Suppress a single line with a trailing `atris-allow-secret` comment.
//
// Zero external deps (Node built-ins only) — repo contract.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const SCAN_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.mdx', '.txt',
  '.yml', '.yaml', '.env', '.sh', '.bash', '.zsh', '.py', '.rb', '.go', '.java',
  '.php', '.toml', '.ini', '.cfg', '.conf', '.html', '.vue', '.svelte', '.patch',
]);
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'out', 'vendor',
  '.cache', '__pycache__', '_archive', 'fixtures', 'fixture', 'snapshots',
  'snapshot', '__snapshots__', 'testdata',
]);

const DEFAULT_BASELINE = '.security-review.baseline.json';

// Lines that opt out, and placeholder noise we never flag.
const ALLOW_MARKER = /atris-allow-secret|atris-security-ignore|#\s*nosec/i;
const PLACEHOLDER = /\b(?:example|placeholder|your[_-]?|my[_-]?key|xxx+|redacted|dummy|sample|changeme|test[_-]?key|fake|fixture|benchmark|mock|not[-_ ]?real|should[-_ ]?not[-_ ]?leak|should[-_ ]?redact|no\s+matches|process\.env|getenv|os\.environ|import\.meta\.env)\b|<[a-z0-9_-]+>/i;
const PLACEHOLDER_VALUE_FRAGMENTS = [
  'should-not-leak', 'should_redact', 'fixture-token', 'xoxb-secret',
  'xoxb-should-not-leak', 'xoxb-fixture-token', 'your_api_key',
  'your-api-key', 'your_key_here', 'your-token', 'secret_yyy', 'secret-yyy',
  'paid-audit-api-key', 'prod-api-key', 'free-plan-key', 'test1234567890',
  'abc123def456', 'abcdefghijklmnopqrstuvwxyz', 'abcdef1234567890',
  'sk-test', 'sk-abc', 'dev-secret', 'test-secret', 'my-super-secret',
  'same-secret', 'correct_secret', 'oauth_access_token', 'some_secret',
  'private-key-pem', 'shared-secret', 'oauth-access', 'ext-oauth',
  'environment-secret', 'immutable-secret', 'member-secret', 'atris_sk_test',
];
const COMMON_PLACEHOLDER_VALUES = new Set([
  'password', 'passw0rd', 'hunter2', 'hunter2hunter2', 'secret', 'secret123',
  'test', 'testpass123', 'test_token_123', 'dev-user', 'dev-secret-do-not-use-in-prod',
  'sovereign-local', 'my-hmac-key', 'env-token', 'audit-key',
]);

// High-precision secret patterns. Known-provider keys become critical only when
// their value quality check says the variable part looks real.
const SECRET_RULES = [
  { id: 'private-key', sev: 'critical', cat: 'secret', re: /(-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA |ENCRYPTED )?PRIVATE KEY-----)/, known: true, noEntropy: true, why: 'private key committed in source' },
  { id: 'aws-access-key-id', sev: 'critical', cat: 'secret', re: /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/, known: true, why: 'real-looking AWS access key id' },
  { id: 'github-token', sev: 'critical', cat: 'secret', re: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/, known: true, why: 'real-looking GitHub token' },
  { id: 'slack-token', sev: 'critical', cat: 'secret', re: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/, known: true, why: 'real-looking Slack token' },
  { id: 'slack-webhook', sev: 'critical', cat: 'secret', re: /(https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,})/, known: true, why: 'real-looking Slack incoming webhook url' },
  { id: 'openai-key', sev: 'critical', cat: 'secret', re: /\b(sk-proj-[A-Za-z0-9_-]{32,}|sk-[A-Za-z0-9]{32,})\b/, known: true, why: 'real-looking OpenAI-style API key' },
  { id: 'anthropic-key', sev: 'critical', cat: 'secret', re: /\b(sk-ant-[A-Za-z0-9_-]{20,})\b/, known: true, why: 'real-looking Anthropic API key' },
  { id: 'google-api-key', sev: 'critical', cat: 'secret', re: /\b(AIza[0-9A-Za-z_-]{35})\b/, known: true, why: 'real-looking Google API key' },
  { id: 'stripe-key', sev: 'critical', cat: 'secret', re: /\b([rs]k_live_[A-Za-z0-9]{20,})\b/, known: true, why: 'real-looking Stripe live key' },
  { id: 'npm-token', sev: 'critical', cat: 'secret', re: /\b(npm_[A-Za-z0-9]{36})\b/, known: true, why: 'real-looking npm access token' },
  { id: 'sendgrid-key', sev: 'critical', cat: 'secret', re: /\b(SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})\b/, known: true, why: 'real-looking SendGrid API key' },
  { id: 'jwt', sev: 'medium', cat: 'secret', re: /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,})\b/, why: 'JWT-like token in source' },
  { id: 'bearer-token', sev: 'medium', cat: 'secret', re: /\bBearer\s+([A-Za-z0-9._~+/=-]{24,})/, why: 'hardcoded Bearer token' },
  { id: 'assigned-secret', sev: 'high', cat: 'secret', re: /\b(?:password|passwd|pwd|secret|api[_-]?key|apikey|apiKey|access[_-]?token|accessToken|auth[_-]?token|authToken|client[_-]?secret|clientSecret|private[_-]?key|privateKey)\b\s*[:=]\s*(['"`])([^'"`\s]{8,})\1/i, valueGroup: 2, why: 'real-looking hardcoded credential value' },
];

// Personal data. Home-path is the recurring leak (a username + local layout).
const PII_RULES = [
  { id: 'home-path', sev: 'medium', cat: 'pii', re: /(?:\/Users\/|\/home\/)(?!runner\/|runner\b|root\/|root\b|ubuntu\/|ubuntu\b|user\/|user\b|node\/)[a-z][a-z0-9_.-]+/i, why: 'personal home path leaks a username + local layout (use os.homedir()/relative)' },
  { id: 'windows-home-path', sev: 'medium', cat: 'pii', re: /[A-Za-z]:\\Users\\(?!Public\b)[^\\\s'"]+/, why: 'personal Windows path leaks a username' },
  { id: 'email', sev: 'low', cat: 'pii', re: /\b[A-Za-z0-9._%+-]+@(?!example\.|sentry\.io|test\b|localhost|[\w.-]*\.local\b|sub\.)[A-Za-z0-9.-]+\.(?:com|net|org|ai|io|dev|co)\b/, why: 'email address (possible PII)' },
  { id: 'phone', sev: 'low', cat: 'pii', re: /(?<![\d.\w])(?:\+?1[-.\s])?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}(?![\d.\w])/, why: 'phone-number-shaped string' },
];

// Code-execution risks. For an AI CLI that runs autonomous loops and shells out,
// these are the "are we actually safe" checks beyond data exposure. eval/Function
// are almost never legitimate (HIGH); shelling out with interpolated input is the
// command-injection class (MEDIUM — common and sometimes safe, so it asks for a
// human look rather than hard-failing the gate).
const CODE_RULES = [
  { id: 'eval-call', sev: 'medium', cat: 'code', re: /(?<![.\w])eval\((?!\s*\))/, why: 'eval() can run untrusted code' },
  { id: 'new-function', sev: 'medium', cat: 'code', re: /\bnew\s+Function\(/, why: 'new Function() can run untrusted code' },
  { id: 'shell-exec-interpolation', sev: 'medium', cat: 'code', re: /\b(?:exec|execSync)\s*\(\s*[`'"][^`'"]*(?:\$\{|"\s*\+|'\s*\+)/, why: 'shell exec with interpolated input (command-injection risk; prefer execFile/spawn with an args array)' },
  { id: 'child-process-shell-true', sev: 'medium', cat: 'code', re: /\bshell\s*:\s*true\b/, why: 'child_process shell:true enables shell interpretation of args' },
];

// extra per-line excludes that keep email/path rules from firing on safe noise
const EMAIL_SAFE = /\b(?:noreply|no-reply|support|hello|info|contact|team|hi|admin|press)@/i;

const RULES = [...SECRET_RULES, ...PII_RULES, ...CODE_RULES];
const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const SEVERITY_RANK = { low: 0, medium: 1, high: 2, critical: 3 };

// Filenames that should never be committed (checked against the tracked file list).
const SENSITIVE_FILE_RE = /(?:^|\/)(?:\.env(?:\.[\w.-]+)?|id_rsa|id_dsa|id_ed25519|.*\.pem|.*\.pfx|.*\.p12|.*\.keystore|credentials\.json|\.npmrc|\.pypirc|\.netrc|secrets?\.(?:json|ya?ml|env))$/i;
const SENSITIVE_FILE_ALLOW = /\.env\.example$|\.env\.sample$|\.env\.template$/i;

function normalizeSnippet(snippet) {
  return String(snippet || '').replace(/\s+/g, ' ').trim();
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function shannonEntropy(value) {
  const s = String(value || '');
  if (!s) return 0;
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) || 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function charClassCount(value) {
  const s = String(value || '');
  let count = 0;
  if (/[a-z]/.test(s)) count++;
  if (/[A-Z]/.test(s)) count++;
  if (/[0-9]/.test(s)) count++;
  if (/[^A-Za-z0-9]/.test(s)) count++;
  return count;
}

function uniqueChars(value) {
  return new Set(String(value || '').split('')).size;
}

function hasRepeatedChunk(value) {
  const s = String(value || '');
  if (/^(.)\1{7,}$/.test(s)) return true;
  for (let size = 2; size <= Math.min(24, Math.floor(s.length / 2)); size++) {
    if (s.length % size !== 0) continue;
    const chunk = s.slice(0, size);
    if (chunk.repeat(s.length / size) === s) return true;
  }
  return /(.{8,})\1/.test(s);
}

function hasSequentialRun(value) {
  const s = String(value || '').toLowerCase();
  const sequences = [
    'abcdefghijklmnopqrstuvwxyz',
    'zyxwvutsrqponmlkjihgfedcba',
    '0123456789',
    '9876543210',
    'qwertyuiopasdfghjklzxcvbnm',
  ];
  for (const seq of sequences) {
    for (let i = 0; i <= seq.length - 8; i++) {
      if (s.includes(seq.slice(i, i + 8))) return true;
    }
  }
  return false;
}

function stripKnownPrefix(value) {
  return String(value || '')
    .replace(/^(?:AKIA|ASIA)/, '')
    .replace(/^github_pat_/, '')
    .replace(/^gh[pousr]_/, '')
    .replace(/^xox[baprs]-/, '')
    .replace(/^https:\/\/hooks\.slack\.com\/services\//, '')
    .replace(/^sk-proj-/, '')
    .replace(/^sk-ant-/, '')
    .replace(/^sk-/, '')
    .replace(/^AIza/, '')
    .replace(/^[rs]k_live_/, '')
    .replace(/^npm_/, '')
    .replace(/^SG\./, '');
}

function isPlaceholderSecretValue(value, line = '') {
  const raw = String(value || '');
  const lowValue = raw.toLowerCase();
  const lowLine = String(line || '').toLowerCase();
  if (!raw) return true;
  if (PLACEHOLDER.test(lowLine) || PLACEHOLDER.test(lowValue)) return true;
  if (COMMON_PLACEHOLDER_VALUES.has(lowValue)) return true;
  if (/^<[^>]+>$/.test(raw) || /^\$\{?[A-Z0-9_]+\}?$/.test(raw)) return true;
  if (/^(?:x+|\*+|\.+|-+|_+)$/.test(raw)) return true;
  if (PLACEHOLDER_VALUE_FRAGMENTS.some((fragment) => lowValue.includes(fragment) || lowLine.includes(fragment))) return true;
  return false;
}

function secretQuality(value, { known = false, noEntropy = false } = {}, line = '') {
  const raw = String(value || '').trim();
  if (isPlaceholderSecretValue(raw, line)) return { ok: false, reason: 'placeholder' };
  if (noEntropy) return { ok: true, entropy: null, reason: 'private-key-marker' };

  const core = stripKnownPrefix(raw).replace(/[-_.:/]/g, '');
  const entropy = shannonEntropy(core);
  const minLength = known ? 16 : 18;
  const minEntropy = known ? 3.0 : 3.35;
  const minUnique = known ? 8 : 10;

  if (core.length < minLength) return { ok: false, entropy, reason: 'too-short' };
  if (uniqueChars(core) < minUnique) return { ok: false, entropy, reason: 'low-variety' };
  if (charClassCount(core) < 2) return { ok: false, entropy, reason: 'single-charset' };
  if (entropy < minEntropy) return { ok: false, entropy, reason: 'low-entropy' };
  if (hasRepeatedChunk(core)) return { ok: false, entropy, reason: 'repeating' };
  if (hasSequentialRun(core)) return { ok: false, entropy, reason: 'sequential' };
  return { ok: true, entropy, reason: 'real-shaped' };
}

function extractSecretValue(rule, match) {
  if (!match) return '';
  if (rule.valueGroup != null) return match[rule.valueGroup] || '';
  return match[1] || match[0] || '';
}

function secretSnippet(rule, value) {
  const safeValue = String(value || '');
  if (rule.id === 'private-key') return 'private key header';
  const prefix = safeValue.slice(0, Math.min(12, safeValue.length));
  return `${prefix}${safeValue.length > prefix.length ? '...' : ''} sha256:${sha256(safeValue).slice(0, 12)}`;
}

function findingFingerprint(finding) {
  const raw = [
    finding.rule,
    finding.cat,
    finding.file || '',
    normalizeSnippet(finding.snippet),
  ].join('|');
  return sha256(raw);
}

function withFingerprint(finding) {
  return { ...finding, fingerprint: findingFingerprint(finding), suppressed: false };
}

function scanLine(line, rules = RULES) {
  if (ALLOW_MARKER.test(line)) return [];
  const findings = [];
  for (const rule of rules) {
    const m = rule.re.exec(line);
    if (!m) continue;
    if (rule.cat === 'secret') {
      const value = extractSecretValue(rule, m);
      const quality = secretQuality(value, rule, line);
      if (!quality.ok) continue;
      findings.push({
        rule: rule.id,
        sev: rule.sev,
        cat: rule.cat,
        why: rule.why,
        snippet: secretSnippet(rule, value),
        entropy: quality.entropy == null ? null : Number(quality.entropy.toFixed(2)),
      });
      continue;
    }
    if (rule.id === 'email' && EMAIL_SAFE.test(line)) continue;
    findings.push({ rule: rule.id, sev: rule.sev, cat: rule.cat, why: rule.why, snippet: m[0].trim().slice(0, 60) });
  }
  return findings;
}

function scanText(text, rules = RULES) {
  const out = [];
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const f of scanLine(lines[i], rules)) out.push({ ...f, line: i + 1 });
  }
  return out;
}

// Code-execution rules only make sense in actual code files — `eval(` written in
// a markdown doc is prose, not a vuln.
const CODE_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.java', '.php', '.sh', '.bash', '.zsh']);
const DOC_EXTS = new Set(['.md', '.mdx', '.txt', '.patch']);

function rulesForFile(file) {
  return CODE_EXTS.has(path.extname(file)) ? RULES : RULES.filter((r) => r.cat !== 'code');
}

function scanFile(file, rules) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const ext = path.extname(file);
  return scanText(text, rules || rulesForFile(file)).map((f) => {
    if (DOC_EXTS.has(ext) && f.rule === 'assigned-secret' && f.sev === 'high') {
      return { ...f, sev: 'medium', why: 'credential-looking value in documentation; verify before publishing', file };
    }
    return { ...f, file };
  });
}

// Repo-level hygiene: a sensitive file being tracked at all is a finding,
// independent of its contents.
function sensitiveFileFindings(relPaths) {
  const out = [];
  for (const p of relPaths) {
    if (shouldSkipRelPath(p)) continue;
    if (SENSITIVE_FILE_RE.test(p) && !SENSITIVE_FILE_ALLOW.test(p)) {
      out.push({ file: p, line: 0, rule: 'tracked-sensitive-file', sev: 'high', cat: 'privacy', why: 'sensitive file is tracked in git (gitignore + remove it)', snippet: path.basename(p) });
    }
  }
  return out;
}

function gitTrackedFiles(root, { staged = false } = {}) {
  try {
    const args = staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACM'] : ['ls-files'];
    const out = execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return null; // not a git repo / git unavailable
  }
}

function walk(target, out) {
  let stat;
  try { stat = fs.statSync(target); } catch { return out; }
  if (stat.isFile()) { out.push(target); return out; }
  if (stat.isDirectory()) {
    if (SKIP_DIRS.has(path.basename(target))) return out;
    for (const name of fs.readdirSync(target)) {
      if (name === '.git' || SKIP_DIRS.has(name)) continue;
      walk(path.join(target, name), out);
    }
  }
  return out;
}

function scannable(file) {
  const ext = path.extname(file);
  return SCAN_EXTS.has(ext) || path.basename(file).startsWith('.env');
}

function shouldSkipRelPath(relPath) {
  const parts = String(relPath || '').split(/[\\/]+/).filter(Boolean);
  return parts.some((part) => SKIP_DIRS.has(part));
}

// Resolve the set of files to scan + the relative-path list for hygiene checks.
function resolveTargets({ root = process.cwd(), paths = [], staged = false } = {}) {
  if (paths.length) {
    const files = paths.flatMap((p) => walk(path.resolve(root, p), []))
      .filter(scannable)
      .filter((f) => !shouldSkipRelPath(path.relative(root, f)));
    return { files, relPaths: files.map((f) => path.relative(root, f)) };
  }
  const tracked = gitTrackedFiles(root, { staged });
  if (tracked) {
    const relPaths = tracked.filter((p) => !shouldSkipRelPath(p));
    const files = relPaths.filter(scannable).map((p) => path.join(root, p)).filter((f) => fs.existsSync(f));
    return { files, relPaths };
  }
  const files = walk(root, []).filter(scannable).filter((f) => !shouldSkipRelPath(path.relative(root, f)));
  return { files, relPaths: files.map((f) => path.relative(root, f)) };
}

// Full scan: line-level findings across files + repo hygiene findings.
// The scanner's own pattern database and its fixtures necessarily contain the
// very strings it detects — never scan them (a tool that flags itself is noise).
const SELF_FILES = new Set(['lib/security-scan.js', 'commands/security-review.js', 'test/security-scan.test.js']);

function runScan({ root = process.cwd(), paths = [], staged = false } = {}) {
  const { files, relPaths } = resolveTargets({ root, paths, staged });
  const findings = [];
  for (const f of files) {
    if (SELF_FILES.has(path.relative(root, f))) continue;
    for (const finding of scanFile(f)) findings.push({ ...finding, file: path.relative(root, finding.file) });
  }
  findings.push(...sensitiveFileFindings(relPaths.filter((p) => !SELF_FILES.has(p))));
  const withIds = findings.map(withFingerprint);
  const counts = summarizeFindings(withIds);
  return { findings: withIds, counts, scanned: files.length };
}

function summarizeFindings(findings) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.sev] = (counts[f.sev] || 0) + 1;
  return counts;
}

function loadBaseline(root = process.cwd(), baselineFile = DEFAULT_BASELINE) {
  const file = path.isAbsolute(baselineFile) ? baselineFile : path.join(root, baselineFile);
  if (!fs.existsSync(file)) return { file, fingerprints: [] };
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { throw new Error(`invalid baseline json: ${path.relative(root, file) || file} (${e.message})`); }
  const values = Array.isArray(raw) ? raw : raw && raw.fingerprints;
  if (!Array.isArray(values)) throw new Error('invalid baseline json: expected {"fingerprints":[...]}');
  return { file, fingerprints: values.filter((v) => typeof v === 'string') };
}

function writeBaseline(root = process.cwd(), findings = [], baselineFile = DEFAULT_BASELINE) {
  const file = path.isAbsolute(baselineFile) ? baselineFile : path.join(root, baselineFile);
  const payload = {
    generated_at: new Date().toISOString(),
    fingerprints: [...new Set(findings.map((f) => f.fingerprint || findingFingerprint(f)))].sort(),
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n');
  return { file, fingerprints: payload.fingerprints };
}

function applyBaseline(findings, fingerprints = []) {
  const accepted = new Set(fingerprints);
  let suppressed = 0;
  const all = findings.map((finding) => {
    const fp = finding.fingerprint || findingFingerprint(finding);
    const isSuppressed = accepted.has(fp);
    if (isSuppressed) suppressed++;
    return { ...finding, fingerprint: fp, suppressed: isSuppressed };
  });
  const active = all.filter((f) => !f.suppressed);
  return {
    findings: active,
    allFindings: all,
    suppressed,
    counts: summarizeFindings(active),
    countsAll: summarizeFindings(all),
  };
}

function shouldFail(findings, failOn = 'high') {
  const threshold = SEVERITY_RANK[failOn] == null ? SEVERITY_RANK.high : SEVERITY_RANK[failOn];
  return findings.some((f) => SEVERITY_RANK[f.sev] >= threshold);
}

function scoreFindings(findings) {
  const score = { low: 1, medium: 10, high: 50, critical: 100 };
  return findings.reduce((sum, f) => sum + (score[f.sev] || 0), 0);
}

module.exports = {
  scanLine, scanText, scanFile, sensitiveFileFindings, gitTrackedFiles,
  resolveTargets, runScan, SECRET_RULES, PII_RULES, RULES, CODE_RULES,
  DEFAULT_BASELINE, SEVERITIES, SEVERITY_RANK, normalizeSnippet,
  shannonEntropy, secretQuality, findingFingerprint, summarizeFindings,
  loadBaseline, writeBaseline, applyBaseline, shouldFail, scoreFindings,
};
