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
const { execFileSync } = require('child_process');

const SCAN_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.mdx', '.txt',
  '.yml', '.yaml', '.env', '.sh', '.bash', '.zsh', '.py', '.rb', '.go', '.java',
  '.php', '.toml', '.ini', '.cfg', '.conf', '.html', '.vue', '.svelte', '.patch',
]);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'out', 'vendor', '.cache', '__pycache__']);

// Lines that opt out, and placeholder noise we never flag.
const ALLOW_MARKER = /atris-allow-secret|atris-security-ignore/i;
const PLACEHOLDER = /\b(?:example|placeholder|your[_-]?|my[_-]?key|xxx+|redacted|dummy|sample|changeme|test[_-]?key|fake|dummy|<[a-z_-]+>|process\.env|getenv|os\.environ|import\.meta\.env)\b/i;

// High-precision secret patterns. severity high => fails the gate.
const SECRET_RULES = [
  { id: 'private-key', sev: 'high', cat: 'secret', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA |ENCRYPTED )?PRIVATE KEY-----/, why: 'private key committed in source' },
  { id: 'aws-access-key-id', sev: 'high', cat: 'secret', re: /\bAKIA[0-9A-Z]{16}\b/, why: 'AWS access key id' },
  { id: 'github-token', sev: 'high', cat: 'secret', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, why: 'GitHub personal/OAuth token' },
  { id: 'slack-token', sev: 'high', cat: 'secret', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, why: 'Slack token' },
  { id: 'slack-webhook', sev: 'high', cat: 'secret', re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/, why: 'Slack incoming webhook url' },
  { id: 'openai-key', sev: 'high', cat: 'secret', re: /\bsk-(?:proj-)?[A-Za-z0-9]{20,}\b/, why: 'OpenAI-style API key' },
  { id: 'anthropic-key', sev: 'high', cat: 'secret', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/, why: 'Anthropic API key' },
  { id: 'google-api-key', sev: 'high', cat: 'secret', re: /\bAIza[0-9A-Za-z_-]{35}\b/, why: 'Google API key' },
  { id: 'stripe-key', sev: 'high', cat: 'secret', re: /\b[rs]k_live_[A-Za-z0-9]{20,}\b/, why: 'Stripe live key' },
  { id: 'npm-token', sev: 'high', cat: 'secret', re: /\bnpm_[A-Za-z0-9]{36}\b/, why: 'npm access token' },
  { id: 'jwt', sev: 'medium', cat: 'secret', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/, why: 'JWT (often carries claims/PII)' },
  { id: 'bearer-token', sev: 'medium', cat: 'secret', re: /\bBearer\s+[A-Za-z0-9._-]{24,}/, why: 'hardcoded Bearer token' },
  { id: 'assigned-secret', sev: 'high', cat: 'secret', re: /(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\s*[:=]\s*['"][^'"\s]{8,}['"]/i, why: 'hardcoded credential assignment' },
];

// Personal data. Home-path is the recurring leak (a username + local layout).
const PII_RULES = [
  { id: 'home-path', sev: 'medium', cat: 'pii', re: /(?:\/Users\/|\/home\/)(?!runner\/|runner\b|root\/|root\b|ubuntu\/|ubuntu\b|user\/|user\b|node\/)[a-z][a-z0-9_.-]+/i, why: 'personal home path leaks a username + local layout (use os.homedir()/relative)' },
  { id: 'windows-home-path', sev: 'medium', cat: 'pii', re: /[A-Za-z]:\\Users\\(?!Public\b)[^\\\s'"]+/, why: 'personal Windows path leaks a username' },
  { id: 'email', sev: 'low', cat: 'pii', re: /\b[A-Za-z0-9._%+-]+@(?!example\.|sentry\.io|test\b|localhost|[\w.-]*\.local\b|sub\.)[A-Za-z0-9.-]+\.(?:com|net|org|ai|io|dev|co)\b/, why: 'email address (possible PII)' },
  { id: 'phone', sev: 'low', cat: 'pii', re: /(?<![\d.\w])(?:\+?1[-.\s])?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}(?![\d.\w])/, why: 'phone-number-shaped string' },
];

// extra per-line excludes that keep email/path rules from firing on safe noise
const EMAIL_SAFE = /\b(?:noreply|no-reply|support|hello|info|contact|team|hi|admin|press)@/i;

const RULES = [...SECRET_RULES, ...PII_RULES];

// Filenames that should never be committed (checked against the tracked file list).
const SENSITIVE_FILE_RE = /(?:^|\/)(?:\.env(?:\.[\w.-]+)?|id_rsa|id_dsa|id_ed25519|.*\.pem|.*\.pfx|.*\.p12|.*\.keystore|credentials\.json|\.npmrc|\.pypirc|\.netrc|secrets?\.(?:json|ya?ml|env))$/i;
const SENSITIVE_FILE_ALLOW = /\.env\.example$|\.env\.sample$|\.env\.template$/i;

function scanLine(line, rules = RULES) {
  if (ALLOW_MARKER.test(line)) return [];
  const findings = [];
  const placeholder = PLACEHOLDER.test(line);
  for (const rule of rules) {
    const m = rule.re.exec(line);
    if (!m) continue;
    // Secrets in obvious placeholder/env-read lines are not real leaks.
    if (rule.cat === 'secret' && placeholder) continue;
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

function scanFile(file, rules = RULES) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return scanText(text, rules).map((f) => ({ ...f, file }));
}

// Repo-level hygiene: a sensitive file being tracked at all is a finding,
// independent of its contents.
function sensitiveFileFindings(relPaths) {
  const out = [];
  for (const p of relPaths) {
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

// Resolve the set of files to scan + the relative-path list for hygiene checks.
function resolveTargets({ root = process.cwd(), paths = [], staged = false } = {}) {
  if (paths.length) {
    const files = paths.flatMap((p) => walk(path.resolve(root, p), [])).filter(scannable);
    return { files, relPaths: files.map((f) => path.relative(root, f)) };
  }
  const tracked = gitTrackedFiles(root, { staged });
  if (tracked) {
    const files = tracked.filter(scannable).map((p) => path.join(root, p)).filter((f) => fs.existsSync(f));
    return { files, relPaths: tracked };
  }
  const files = walk(root, []).filter(scannable);
  return { files, relPaths: files.map((f) => path.relative(root, f)) };
}

// Full scan: line-level findings across files + repo hygiene findings.
function runScan({ root = process.cwd(), paths = [], staged = false } = {}) {
  const { files, relPaths } = resolveTargets({ root, paths, staged });
  const findings = [];
  for (const f of files) {
    for (const finding of scanFile(f)) findings.push({ ...finding, file: path.relative(root, finding.file) });
  }
  findings.push(...sensitiveFileFindings(relPaths));
  const counts = { high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.sev] = (counts[f.sev] || 0) + 1;
  return { findings, counts, scanned: files.length };
}

module.exports = {
  scanLine, scanText, scanFile, sensitiveFileFindings, gitTrackedFiles,
  resolveTargets, runScan, SECRET_RULES, PII_RULES, RULES,
};
