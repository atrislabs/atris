'use strict';

// Scanners for two attack classes in lib/security-audit-classes.js.
//
//   access-rules       database rules, row policies, bucket policies, CORS and
//                      hosting settings, example env files: settings that live
//                      as files in the repo.
//   sign-in-matching   how an outside identity becomes a local account, and
//                      server secrets copied into records others can read.
//
// Each scanner reads a whole file, so a rule with no owner check can be told
// apart from one with an owner check, and a correct rule stays quiet. A hit is
// still only a place to look, never a finding.

const CODE_RE = /\.(?:[cm]?js|jsx|tsx?|py|rb|go|java|php|rs)$/i;
const RTDB_RULES_RE = /(?:^|\/)database(?:\.[\w-]+)?\.rules\.json$/i;
const RULES_RE = /(?:^|\/)[^/]+\.rules$/i;
const SQL_RE = /\.sql$/i;
const TERRAFORM_RE = /\.tf$/i;
const INFRA_RE = /(?:^|\/)(?:infra|infrastructure|cloudformation|cfn|terraform|stacks?|deploy|deployment)\/(?:[^/]+\/)*[^/]+\.(?:ya?ml|json)$|(?:^|\/)(?:template|serverless|cors|[\w-]*bucket[\w-]*|[\w-]*storage[\w-]*|Pulumi(?:\.[\w-]+)?)\.(?:ya?ml|json)$/i;
const HOSTING_RE = /(?:^|\/)(?:vercel\.json|netlify\.toml|_headers|_redirects|firebase\.json|next\.config\.[cm]?[jt]s|nuxt\.config\.[jt]s|vite\.config\.[cm]?[jt]s)$/i;
const ENV_EXAMPLE_RE = /(?:^|\/)\.env\.(?:example|sample|template|dist|defaults)$|(?:^|\/)(?:example|sample)\.env$/i;

// What kind of settings file this is, or 'code', or null.
function settingsKind(rel) {
  if (RTDB_RULES_RE.test(rel)) return 'rtdb';
  if (RULES_RE.test(rel)) return 'rules';
  if (SQL_RE.test(rel)) return 'sql';
  if (TERRAFORM_RE.test(rel)) return 'terraform';
  if (HOSTING_RE.test(rel)) return 'hosting';
  if (ENV_EXAMPLE_RE.test(rel)) return 'env';
  if (INFRA_RE.test(rel)) return 'infra';
  if (CODE_RE.test(rel)) return 'code';
  return null;
}

// Files quick mode reads first: data rules, row policies, sign-in paths,
// credential handlers, and the middleware, filters and allowlists that
// decide who gets in. Migrations count when they hold a policy.
const FOCUS_PATH_RE = /(?:^|\/)[^/]+\.rules(?:\.json)?$|(?:^|[/._-])(?:polic(?:y|ies)|rls|auth|oauth2?|oidc|openid|sso|saml|callbacks?|signin|sign-in|sign_in|login|passport|omniauth|nextauth|credentials?|integrations?|connectors?|connections?|middlewares?|allow-?lists?|white-?lists?|ip-?filters?|firewall|guards?|acl|rbac|permissions?|api[_-]?keys?)(?:[/._-]|$)/i;
const FOCUS_CLASS_RE = /[a-z](?:Middleware|Filter|Interceptor|Guard)\.(?:java|kt|ts|js|php|cs|go)$/;

function focusFile(rel, text = '') {
  if (FOCUS_PATH_RE.test(rel) || FOCUS_CLASS_RE.test(rel)) return true;
  return SQL_RE.test(rel) && /\b(?:create\s+policy|row\s+level\s+security)\b/i.test(text);
}

function hit(line, text, why) {
  return { line, text: `${String(text).trim().slice(0, 140)}${why ? `  [${why}]` : ''}` };
}

// Lines from `start` until one holds `end`, at most `max` lines, joined.
function gather(lines, start, end, max = 10) {
  const out = [];
  for (let i = start; i < lines.length && i < start + max; i++) {
    out.push(lines[i]);
    if (end.test(lines[i])) break;
  }
  return out.join(' ');
}

function stripSlashComment(line) {
  return line.replace(/\/\/.*$/, '');
}

function stripDashComment(line) {
  return line.replace(/--.*$/, '');
}

// ---------------------------------------------------------------- firebase rules

const RULES_AUTH = /\brequest\.auth\b/;
// A comparison that ties the request to a person or a role: the uid or a
// token claim compared to something, or a lookup of another document.
const RULES_SCOPED = /request\.auth\.(?:uid|token\.[\w.]+)\s*(?:==|!=|in\b)|(?:==|!=)\s*request\.auth\.(?:uid|token)|\bin\s+request\.auth\.token|request\.auth\.token\.[\w.]+\s*(?:&&|\|\||\)|;|$)|\b(?:get|exists|getAfter|existsAfter)\s*\(/;

// "signed in" checks, removed before looking for a real comparison.
const RULES_NULL_CHECK = /request\.auth(?:\.uid)?\s*(?:==|!=)\s*null|null\s*(?:==|!=)\s*request\.auth(?:\.uid)?/g;

function rulesFunctions(text) {
  const fns = new Map();
  const re = /function\s+(\w+)\s*\([^)]*\)\s*\{([\s\S]*?)\}/g;
  let m;
  while ((m = re.exec(text))) fns.set(m[1], m[2]);
  return fns;
}

// A condition with the bodies of the functions it calls written in, two levels deep.
function expandCondition(cond, fns) {
  let out = cond;
  for (let depth = 0; depth < 2; depth++) {
    let more = '';
    for (const [name, body] of fns) if (new RegExp(`\\b${name}\\s*\\(`).test(out) && !out.includes(body)) more += ` ${body}`;
    if (!more) break;
    out += more;
  }
  return out;
}

function scanFirebaseRules(text) {
  const lines = text.split('\n');
  const fns = rulesFunctions(text);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = stripSlashComment(lines[i]);
    const m = line.match(/\ballow\s+([a-z][a-z ,]*?)\s*(:|;|$)/);
    if (!m) continue;
    const ops = m[1].split(/[\s,]+/).filter(Boolean);
    const writes = ops.some((o) => ['write', 'create', 'update', 'delete'].includes(o));
    if (m[2] === ';') { hits.push(hit(i + 1, lines[i], 'open to anyone')); continue; }
    const stmt = gather(lines.map(stripSlashComment), i, /;|\}/);
    const cond = stmt.replace(/^[\s\S]*?\ballow\s+[a-z ,]+:\s*(?:if\b)?/, '').replace(/[;}][\s\S]*$/, '').trim();
    if (!cond || /^true$/.test(cond)) { hits.push(hit(i + 1, lines[i], 'open to anyone')); continue; }
    if (/^false$/.test(cond)) continue;
    const full = expandCondition(cond, fns);
    if (RULES_AUTH.test(full)) {
      if (!RULES_SCOPED.test(full.replace(RULES_NULL_CHECK, ' '))) hits.push(hit(i + 1, lines[i], 'any signed-in user'));
      continue;
    }
    if (writes) { hits.push(hit(i + 1, lines[i], 'write with no check of who is asking')); continue; }
    if (/^\(?\s*request\.time\b/.test(cond)) hits.push(hit(i + 1, lines[i], 'test mode: open until a date'));
  }
  return hits;
}

function scanRtdbRules(text) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    const m = line.match(/"\.(read|write|validate)"\s*:\s*(true|"([^"]*)")/);
    if (!m || m[1] === 'validate') return;
    if (m[2] === 'true') { hits.push(hit(i + 1, line, 'open to anyone')); return; }
    const cond = m[3] || '';
    if (/\bauth\b/.test(cond)) {
      if (!/\bauth\.(?:uid|token\.[\w.]+)\s*(?:===?|!==?)|(?:===?|!==?)\s*auth\.(?:uid|token)|\broot\.child\(/.test(cond)) hits.push(hit(i + 1, line, 'any signed-in user'));
    } else if (m[1] === 'write') hits.push(hit(i + 1, line, 'write with no check of who is asking'));
  });
  return hits;
}

// ---------------------------------------------------------------- sql policies

function tableName(raw) {
  const parts = String(raw || '').replace(/"/g, '').toLowerCase().split('.');
  return { schema: parts.length > 1 ? parts[0] : 'public', name: parts[parts.length - 1] };
}

// SQL statements with the line each starts on.
function sqlStatements(text) {
  const out = [];
  const lines = text.split('\n');
  let buf = [];
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = stripDashComment(lines[i]);
    if (!buf.length) { if (!line.trim()) continue; start = i; }
    buf.push(line);
    if (line.includes(';')) { out.push({ line: start + 1, first: lines[start], text: buf.join(' ') }); buf = []; }
  }
  if (buf.length) out.push({ line: start + 1, first: lines[start], text: buf.join(' ') });
  return out;
}

const SQL_AUTH = /\bauth\.(?:uid|jwt|role|email)\s*\(\s*\)|\bcurrent_user\b|\bsession_user\b|\bcurrent_setting\s*\(|\brequest\.jwt\b/i;

// Repo facts every migration needs: which tables turn on row level security
// somewhere, and whether the repo uses row level security at all.
function prepareSql(files) {
  const rls = new Set();
  let aware = false;
  for (const { rel, text } of files) {
    if (/(?:^|\/)supabase\//.test(rel)) aware = true;
    const re = /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([\w."]+)\s+(?:enable|force)\s+row\s+level\s+security/gi;
    let m;
    while ((m = re.exec(text))) { rls.add(tableName(m[1]).name); aware = true; }
    if (SQL_AUTH.test(text) && /\bpolicy\b/i.test(text)) aware = true;
  }
  return { rls, aware };
}

function scanSql(text, ctx = { rls: new Set(), aware: false }) {
  const hits = [];
  for (const s of sqlStatements(text)) {
    const t = s.text;
    let m = t.match(/\bcreate\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?([\w."]+)/i);
    if (m && ctx.aware) {
      const tn = tableName(m[1]);
      if (tn.schema === 'public' && !ctx.rls.has(tn.name)) hits.push(hit(s.line, s.first, 'table with row level security off'));
      continue;
    }
    if (/\bdisable\s+row\s+level\s+security\b/i.test(t)) { hits.push(hit(s.line, s.first, 'row level security turned off')); continue; }
    if (/\bcreate\s+policy\b/i.test(t)) {
      const exprs = [...t.matchAll(/\b(?:using|with\s+check)\s*\(([\s\S]*?)\)\s*(?:with\b|;|$)/gi)].map((x) => x[1]);
      const forOp = (t.match(/\bfor\s+(all|select|insert|update|delete)\b/i) || [null, 'all'])[1].toLowerCase();
      if (exprs.some((e) => /^\s*\(?\s*true\s*\)?\s*$/i.test(e))) hits.push(hit(s.line, s.first, 'policy allows every row'));
      else if (forOp !== 'select' && !exprs.some((e) => SQL_AUTH.test(e) || /\b\w+\s*\(/.test(e))) hits.push(hit(s.line, s.first, 'write policy with no check of who is asking'));
      continue;
    }
    m = t.match(/\bgrant\s+[\w\s,]+\bon\s+(?:table\s+)?([\w."]+)[^;]*\bto\s+(?:anon|public)\b/i);
    if (m && !/\ball\s+tables\b/i.test(t) && !ctx.rls.has(tableName(m[1]).name)) { hits.push(hit(s.line, s.first, 'granted to anonymous callers with no row level security')); continue; }
    if (ctx.aware && /\bsecurity\s+definer\b/i.test(t)) { hits.push(hit(s.line, s.first, 'runs with owner rights, skips row level security')); continue; }
    m = t.match(/\bcreate\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+([\w."]+)/i);
    if (m && ctx.aware && tableName(m[1]).schema === 'public' && !/security_invoker/i.test(t)) hits.push(hit(s.line, s.first, 'view skips row level security of its tables'));
  }
  return hits;
}

// ---------------------------------------------------------------- buckets, cors, hosting, env

const INFRA_LINE = [
  [/\bacl\s*[=:]\s*["']?(?:public-read|public-read-write|authenticated-read)\b/i, 'public bucket acl'],
  [/\b(?:block_public_acls|block_public_policy|ignore_public_acls|restrict_public_buckets|BlockPublicAcls|BlockPublicPolicy|IgnorePublicAcls|RestrictPublicBuckets|blockPublicAcls|blockPublicPolicy|ignorePublicAcls|restrictPublicBuckets)\s*[=:]\s*["']?false\b/, 'public access block turned off'],
  [/"Principal"\s*:\s*"\*"|\bPrincipal\s*[=:]\s*["']?\*["']?\s*,?\s*$|"AWS"\s*:\s*"\*"|\bPrincipal\s*=\s*\{\s*AWS\s*=\s*"\*"/, 'policy for anyone'],
  [/\ballUsers\b|\ballAuthenticatedUsers\b/, 'bucket open to all users'],
  [/\bAccessControl\s*:\s*["']?Public\w*/, 'public bucket acl'],
  [/\bpublicly_accessible\s*=\s*true\b|\bPubliclyAccessible\s*:\s*true\b/i, 'database reachable from the internet'],
  [/\ballowed_origins\s*=\s*\[\s*"\*"|\bAllowedOrigins\s*:\s*\[?\s*["']?\*|"AllowedOrigins"\s*:\s*\[\s*"\*"|\borigin\s*=\s*\[\s*"\*"/i, 'bucket cors for any origin'],
];

const CLIENT_KEY = /\b(?:NEXT_PUBLIC|VITE|REACT_APP|EXPO_PUBLIC|PUBLIC|NUXT_PUBLIC|GATSBY)_\w*(?:SERVICE_ROLE|SERVICE_KEY|SECRET|PRIVATE)\w*/;

const CORS_ANY = /\borigin\s*:\s*(?:true\b|["'`]\*["'`])|\borigin\s*:\s*\(?\s*\w+\s*,\s*(?:cb|callback|done)\s*\)?\s*=>\s*(?:cb|callback|done)\s*\(\s*null\s*,\s*(?:true|\w+)\s*\)|Access-Control-Allow-Origin["'`]?\s*[,:=]\s*(?:["'`]\*["'`]|(?:req|request)\.(?:headers?|get)[\w.[\]('"]*origin)|\ballow_origins\s*=\s*\[\s*["']\*["']|\bCORS_(?:ORIGIN_)?ALLOW_ALL(?:_ORIGINS)?\s*=\s*True\b|\bAllowAllOrigins\s*:\s*true\b|\bAllowOrigins\s*:\s*\[\]string\s*\{\s*"\*"|\bCORS\s*\([^)]*\borigins\s*=\s*["']\*["']/i;
const CORS_CREDS = /\bcredentials\s*:\s*true\b|\ballow_credentials\s*=\s*True\b|\bsupports_credentials\s*=\s*True\b|Access-Control-Allow-Credentials["'`]?\s*[,:=]\s*["'`]?true\b|\bCORS_ALLOW_CREDENTIALS\s*=\s*True\b|\bAllowCredentials\s*:\s*true\b/i;

const GUARD_WORD = /(?:AUTH|ADMIN|ALLOW|ORIGIN|CORS|VERIFY|VERIFICATION|REQUIRE|DISABLE|SKIP|BYPASS|INSECURE|SIGNING|SIGNATURE|WEBHOOK_SECRET|RLS|TRUSTED|ALLOWLIST|WHITELIST|PROTECT|CSRF)/;
const FAIL_OPEN_ENV = [
  /\bif\s*\(\s*!\s*process\.env\.[A-Z0-9_]+\s*\)\s*(?:\{\s*)?(?:return\s+next\s*\(|next\s*\(|return\s+true\b)/,
  /\bif\s+not\s+os\.(?:environ\.get|getenv)\(\s*["'][A-Z0-9_]+["']\s*\)\s*:\s*return\s+(?:True|None)\b/,
  /\b(?:process\.env\.|os\.(?:environ\.get|getenv)\(\s*["']|ENV\[\s*["'])[A-Z0-9_]*(?:SKIP|DISABLE|BYPASS|INSECURE|NO)_?[A-Z0-9_]*(?:AUTH|VERIFY|VERIFICATION|SIGNATURE|CSRF|RLS|TLS)\w*/,
];

function scanLines(text, rules) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    if (line.length > 2000) return;
    for (const [re, why] of rules) if (re.test(line)) { hits.push(hit(i + 1, line, why)); break; }
  });
  return hits;
}

function scanCors(text) {
  const lines = text.split('\n');
  const any = [];
  const creds = [];
  lines.forEach((line, i) => {
    if (line.length > 2000) return;
    if (CORS_ANY.test(line)) any.push(i);
    if (CORS_CREDS.test(line)) creds.push(i);
  });
  if (!any.length || !creds.length) return [];
  return [...any.map((i) => hit(i + 1, lines[i], creds.includes(i) ? 'any origin, with credentials' : 'any origin')), ...creds.filter((i) => !any.includes(i)).slice(0, 2).map((i) => hit(i + 1, lines[i], 'with credentials'))];
}

function scanHosting(text) {
  const hits = scanCors(text);
  text.split('\n').forEach((line, i) => {
    if (/(?:"destination"|destination\s*:|\bto\s*=)\s*["'`]https?:\/\/(?:localhost|127\.|10\.|192\.168\.|169\.254\.|[\w.-]+\.internal\b|[\w.-]+\.local\b|[\w.-]+:\d{4,5}\/)/i.test(line)) hits.push(hit(i + 1, line, 'forwards to an internal address'));
    else if (/(?:"destination"|destination\s*:|\bto\s*=)\s*["'`]https?:\/\/[^"'`]*(?::path\*|:splat|\/\*)/i.test(line) || /^\s*\/[\w/-]*\*\s+https?:\/\/\S+\s+200!?\s*$/.test(line)) hits.push(hit(i + 1, line, 'forwards every path to another service'));
    else if (/\bhostname\s*:\s*["'`]\*\*?["'`]|\bdangerouslyAllowSVG\s*:\s*true\b|\ballowedOrigins\s*:\s*\[\s*["'`]\*["'`]/.test(line)) hits.push(hit(i + 1, line, 'fetches or trusts any host'));
    else if (CLIENT_KEY.test(line)) hits.push(hit(i + 1, line, 'server key shipped to the browser'));
  });
  return hits;
}

const ENV_NAME_RE = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/;

function envNames(text) {
  return text.split('\n').map((l) => (l.match(ENV_NAME_RE) || [])[1]).filter(Boolean);
}

// Example env files: guard-like names only. The value is never kept.
function scanEnvExample(text) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    const m = line.match(ENV_NAME_RE);
    if (!m) return;
    if (CLIENT_KEY.test(m[1])) hits.push({ line: i + 1, text: `${m[1]}  [server key shipped to the browser]` });
    else if (GUARD_WORD.test(m[1])) hits.push({ line: i + 1, text: `${m[1]}  [guard setting]` });
  });
  return hits;
}

function scanSettingsCode(text) {
  const hits = scanCors(text);
  text.split('\n').forEach((line, i) => {
    if (line.length > 2000) return;
    if (/\bnew\s+aws\.s3\.Bucket\w*\b[^\n]*public|\bacl\s*:\s*["']public-read|\bmember\s*:\s*["']allUsers["']|\bblockPublic(?:Acls|Policy)\s*:\s*false\b/.test(line)) hits.push(hit(i + 1, line, 'public bucket'));
    else if (CLIENT_KEY.test(line)) hits.push(hit(i + 1, line, 'server key shipped to the browser'));
    else if (FAIL_OPEN_ENV.slice(0, 2).some((re) => re.test(line))) hits.push(hit(i + 1, line, 'guard that turns off when a setting is missing'));
    else if (FAIL_OPEN_ENV[2].test(line)) hits.push(hit(i + 1, line, 'setting that switches off a security check'));
  });
  return hits;
}

function scanAccessRules(text, rel, ctx = {}) {
  switch (settingsKind(rel)) {
    case 'rules': return scanFirebaseRules(text);
    case 'rtdb': return scanRtdbRules(text);
    case 'sql': return scanSql(text, ctx.sql);
    case 'terraform':
    case 'infra': return scanLines(text, INFRA_LINE);
    case 'hosting': return scanHosting(text);
    case 'env': return scanEnvExample(text);
    case 'code': return scanSettingsCode(text);
    default: return [];
  }
}

// Repo-wide facts, read once before the scan. `read` returns a file's text
// or null. Only SQL files are read here.
function prepareAccessRules(rels, read) {
  return { sql: prepareSql(rels.filter((rel) => SQL_RE.test(rel)).map((rel) => ({ rel, text: read(rel) || '' }))) };
}

// ---------------------------------------------------------------- linking rules to app code

// Names a code file reads: collections and tables it queries, and env
// settings. The rules unit carries the code that queries the same data, so
// the hunter can compare what the rule enforces with what the app assumes.
const QUERY_NAME_RES = [
  /\bcollection(?:Group)?\s*\(\s*(?:\w+\s*,\s*)?["'`]([\w-]+)["'`]/g,
  /\bdoc\s*\(\s*\w+\s*,\s*["'`]([\w-]+)["'`]/g,
  /\.from\s*\(\s*["'`]([\w-]+)["'`]\s*\)/g,
  /\bref\s*\(\s*\w+\s*,\s*["'`]([\w-]+)/g,
];
const ENV_READ_RES = [
  /\bprocess\.env\.([A-Z][A-Z0-9_]*)/g,
  /\bprocess\.env\[\s*["']([A-Z][A-Z0-9_]*)["']/g,
  /\bimport\.meta\.env\.([A-Z][A-Z0-9_]*)/g,
  /\bos\.environ(?:\.get)?\s*[[(]\s*["']([A-Z][A-Z0-9_]*)["']/g,
  /\bos\.getenv\s*\(\s*["']([A-Z][A-Z0-9_]*)["']/g,
  /\bENV(?:\.fetch)?\s*[[(]\s*["']([A-Z][A-Z0-9_]*)["']/g,
  /\bos\.Getenv\s*\(\s*"([A-Z][A-Z0-9_]*)"/g,
];

function codeRefs(text, rel) {
  if (settingsKind(rel) !== 'code') return [];
  const refs = [];
  text.split('\n').forEach((line, i) => {
    if (line.length > 2000) return;
    for (const re of QUERY_NAME_RES) for (const m of line.matchAll(re)) refs.push({ key: `t:${m[1].toLowerCase()}`, line: i + 1, text: line.trim().slice(0, 160) });
    for (const re of ENV_READ_RES) for (const m of line.matchAll(re)) refs.push({ key: `e:${m[1]}`, line: i + 1, text: line.trim().slice(0, 160) });
  });
  return refs.slice(0, 200);
}

// What a settings file guards: collection or table names, or, for an
// example env file, the names it lists.
function guardedNames(text, rel) {
  const kind = settingsKind(rel);
  const names = new Set();
  if (kind === 'rules') for (const m of text.matchAll(/\bmatch\s+\/([\w-]+)\/\{/g)) names.add(m[1].toLowerCase());
  if (kind === 'sql') for (const m of text.matchAll(/\b(?:create\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?|\bon\s+(?:table\s+)?|alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?)([\w."]+)/gi)) names.add(tableName(m[1]).name);
  if (kind === 'env') { const names = envNames(text); return { mode: 'missing', names: new Set(names), strong: names.some((n) => CLIENT_KEY.test(n)) }; }
  return names.size ? { mode: 'match', names } : null;
}

// Up to three code files for a settings file. For rules and policies: the
// files that query the same collections or tables. For an example env file:
// the files that read a guard setting the example leaves out, which a fresh
// deploy then runs without. An example env file with no such gap, and no
// server key named for the browser, is dropped.
function linkAccessRules(guards, index, rel) {
  if (!guards) return { paths: [], hot: [], keep: true };
  const files = new Map();
  const add = (ref) => { if (ref.rel !== rel && !files.has(ref.rel) && files.size < 3) files.set(ref.rel, ref); };
  if (guards.mode === 'match') {
    for (const name of [...guards.names].sort()) for (const ref of index.get(`t:${name}`) || []) add(ref);
  } else {
    const keys = [...index.keys()].filter((k) => k.startsWith('e:') && GUARD_WORD.test(k.slice(2)) && !guards.names.has(k.slice(2))).sort();
    for (const k of keys) for (const ref of index.get(k)) add(ref);
  }
  const refs = [...files.values()];
  return { paths: refs.map((r) => r.rel), hot: refs.map((r) => ({ file: r.rel, line: r.line, text: r.text })), keep: guards.mode !== 'missing' || guards.strong || refs.length > 0 };
}

// ---------------------------------------------------------------- sign-in matching

const IDP_CONTEXT = /\b(?:oauth2?|oidc|openid|id_token|idToken|userinfo|userInfo|saml2?|SAMLResponse|OneLogin_Saml2_Auth|NameID|nameID|omniauth|from_omniauth|allauth|socialaccount|social_core|NextAuth|next-auth|authorization_code|code_verifier|providerAccountId|provider_user_id|getProfile|jwks|issuer)\b|passport\.use\s*\(|profile\.(?:emails?|username|login|_json)\b|\bclaims\s*[.[]/i;
const NAME_FIELD = '(?:email|username|user_name|login|preferred_username|nickname|screen_name|handle|local_?part|localPart)';
const LOOKUP_CALL = /\b(?:find\w*|get_or_create|first_or_create|find_or_create_by|filter_by|filter|where|get|query|lookup|eq|getUserBy\w*|get_user_by_\w*|fetchUserBy\w*|loadUserBy\w*)\s*\(|\bwhere\s+\w*\.?(?:email|username|login)\s*=/i;
const NAME_KEY = new RegExp(`\\b${NAME_FIELD}\\b\\s*(?:[:=]|==)|\\b(?:eq|where|filter|equalTo|find_by|findBy)\\s*\\(\\s*["'\`]${NAME_FIELD}["'\`]\\s*,|[{,]\\s*${NAME_FIELD}\\s*[,}]|\\bwhere\\s+\\w*\\.?${NAME_FIELD}\\s*=|\\bBy(?:Email|Username|Login)\\b|_by_(?:email|username|login)\\b`, 'i');
// row.get("email", "") and row["email"] read a value; they do not look anything up.
const DICT_READ = /\.get\(\s*["'][^"']*["']\s*(?:,[^()]*)?\)|\[\s*["'][^"']*["']\s*\]/g;
const LOOKUP_BY_NAME = {
  test(line) {
    line = line.replace(DICT_READ, ' ');
    const m = LOOKUP_CALL.exec(line);
    if (!m) return false;
    return !m[0].endsWith('(') || NAME_KEY.test(line.slice(m.index));
  },
};
// The lookup must reach a user store, not just read a claim.
const USER_STORE = /user|account|member|\bdb\b|prisma|objects|repo|store|knex|supabase|\bsql\b/i;
const CLAIM_READ = /\b(?:claims|profile|userinfo|user_info|info|token|id_token|data|payload|attrs|attributes|extra_data|response|resp|json)\s*(?:\.get\s*\(|\[)\s*["'](?:email|username|preferred_username|login|nickname)["']\s*[\])]/gi;
const KEYED_BY_SUBJECT = /\b(?:sub|subject|iss|issuer|provider_?(?:user_?)?id|providerAccountId|provider_account_id|uid|external_?id|oid)\b/i;
const LOCAL_PART = /\.split\(\s*["'`]@["'`]\s*\)|\.r?partition\(\s*["']@["']\s*\)|\.rsplit\(\s*["']@["']|\.substring\s*\(\s*0\s*,\s*[\w.]+\.indexOf\(\s*["'`]@["'`]|\blocal_?part\b|\blocalPart\b/i;
const EMAIL_LINKING = /\ballowDangerousEmailAccountLinking\s*:\s*true\b|\bSOCIALACCOUNT_EMAIL_AUTHENTICATION(?:_AUTO_CONNECT)?\s*=\s*True\b|\blink_?(?:by_?)?email\b|\bauto_?link\w*\s*[:=]\s*(?:true|True)\b|\blinkAccountsByEmail\b/i;
const FIRST_USER = /\b(?:count|countDocuments|count_documents|estimatedDocumentCount|userCount|user_count|users_count)\b[^\n]*(?:(?:===?|<=)\s*0|<\s*1)\b|\b(?:is_?first_?user|isFirstUser|first_?user|no_?users_?yet)\b|\.count\(\s*\)\s*(?:===?|==)\s*0\b|(?:===?|==)\s*0\s*\?\s*["'`](?:admin|owner|superuser|super_admin)["'`]|["'](?:admin|owner|superuser)["']\s+if\s+[\w.()]+\s*==\s*0\b|\.objects\.(?:all\(\)\.)?exists\(\s*\)\s*==\s*False\b|\bnot\s+\w+\.objects\.(?:all\(\)\.)?exists\(\s*\)/i;
const ADMIN_WORD = /\b(?:admin|is_?admin|isAdmin|superuser|is_superuser|is_staff|role|owner)\b/i;
// The role actually set: a quoted admin role, or an admin flag set true.
const ADMIN_SET = /["'`](?:admin|owner|superuser|super_admin|superadmin)["'`]|\b(?:is_?admin|isAdmin|is_superuser|is_staff|superuser)\b\s*[:=]\s*(?:true|True)\b/i;
const SERVER_SECRET = /\b(?:client_?secret|clientSecret|CLIENT_SECRET|app_?secret|appSecret|APP_SECRET|signing_?(?:secret|key)|SIGNING_(?:SECRET|KEY)|private_?key|privateKey|PRIVATE_KEY|service_?role(?:_?key)?|SERVICE_ROLE(?:_KEY)?)\b/;
const SERVER_SOURCE = /\bprocess\.env\b|\bos\.(?:environ|getenv)\b|\bENV\[|\bsettings\.|\bconfig\.|\bconfig\[|\bgetConfig\(|\bSECRET\w*\b|\bos\.Getenv\b/;
const RECORD_WRITE = /\b(?:credential|integration|connection|workspace|tenant|installation|team|org|organization|account|provider_?config|oauth_?app)\w*s?\s*\.\s*(?:create|insert|insertOne|insertMany|upsert|save|update|updateOne|put|put_item|bulkCreate)\b|\.(?:credential|integration|connection|workspace|installation|providerConfig|oauthApp)\w*\.(?:create|upsert|update|insert)\b|\.from\(\s*["'`]\w*(?:credential|integration|connection|workspace|installation|provider)\w*["'`]\s*\)\s*\.(?:insert|upsert|update)|\b(?:Credential|Integration|Connection|Workspace|Installation|ProviderConfig|OAuthApp)\w*\s*(?:\.objects)?\.(?:create|update_or_create|get_or_create|insert|save|new)\b|\binsert\s+into\s+\w*(?:credential|integration|connection|workspace|installation)/i;

const USERNAME_CLAIM = /\b(?:username_?claim|username_?key|username_?attribute|username_?field|user_?id_?claim|login_?attribute|login_?claim|usernameClaim|usernameKey|usernameField|usernameAttribute)\b/i;
const EMAIL_VALUE = /["'`]email["'`]/;

const COMMENT = /^\s*(?:\/\/|#|\*|\/\*|--|<!--|@)/;
const PROSE = /^\s*["'`][^"'`]*\s\w+\s\w+\s\w+\s[^(){}=]*["'`]\s*[,+)]?\s*$/;

function lookupByName(line) {
  const bare = line.replace(CLAIM_READ, ' ');
  return LOOKUP_BY_NAME.test(bare) && USER_STORE.test(bare.replace(/\b(?:username|user_name)\b/gi, ' ')) && !KEYED_BY_SUBJECT.test(line);
}

const SECRET_AS_VALUE = /\b(?:client_?secret|clientSecret|CLIENT_SECRET|app_?secret|appSecret|signing_?(?:secret|key)|private_?key|privateKey|service_?role(?:_?key)?)\b["']?\s*[:=]/;
const NETWORK_CALL = /\bfetch\s*\(|\baxios\b|\brequests\.(?:post|get)\b|\bhttpx\b|\bURLSearchParams\b|\burlencode\b|\bgot\s*\(|\.post\s*\(|\bhttp\.(?:request|post)\b|\bNet::HTTP\b/;

function localPartLooksUp(lines, i) {
  if (LOOKUP_CALL.test(lines[i].replace(DICT_READ, ' '))) return true;
  const m = /(?:\b(?:const|let|var)\s+)?(\w+)\s*=[^=]/.exec(lines[i]);
  if (!m) return false;
  const v = new RegExp(`\\b${m[1]}\\b`);
  return lines.slice(i + 1, i + 9).some((l) => LOOKUP_CALL.test(l) && v.test(l));
}

function scanSignIn(text) {
  const lines = text.split('\n');
  const hits = [];
  const seen = new Set();
  const push = (i, why) => { if (!seen.has(i)) { seen.add(i); hits.push(hit(i + 1, lines[i], why)); } };
  const idp = IDP_CONTEXT.test(text);
  const verifiedCheck = /\bemail_?verified\b|\bemailVerified\b|\bverified_?email\b|\bverifiedEmail\b/i.test(text);
  const admin = ADMIN_WORD.test(text);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 2000) continue;
    if (idp) {
      if (COMMENT.test(line) || PROSE.test(line)) continue;
      if (LOCAL_PART.test(line) && localPartLooksUp(lines, i)) push(i, 'account picked by the part of the email before the @');
      else if (lookupByName(line)) push(i, /\bemail\b/i.test(line) && !/\b(?:username|login|preferred_username|nickname|handle)\b/i.test(line) ? (verifiedCheck ? 'account picked by email' : 'account picked by email, email_verified never read') : 'account picked by user name');
      if (EMAIL_LINKING.test(line)) push(i, 'accounts linked by email across providers');
      // The account name is set to the email claim (a setting or a default
      // that returns "email") in a file that never reads email_verified.
      if (!verifiedCheck && EMAIL_VALUE.test(line) && USERNAME_CLAIM.test(lines.slice(Math.max(0, i - 3), i + 1).join(' '))) push(i, 'account name taken from the email claim, email_verified never read');
    }
    if (admin && FIRST_USER.test(line)) {
      const near = lines.slice(Math.max(0, i - 2), i + 8).join(' ');
      if (ADMIN_SET.test(near)) push(i, 'first user becomes admin');
    }
    // The secret is a value in a record write that opens on this line or
    // up to six lines above, with no network call in between (a token
    // exchange sends the secret, it does not save it).
    if (SERVER_SECRET.test(line) && SECRET_AS_VALUE.test(line) && SERVER_SOURCE.test(line)) {
      for (let j = i; j >= Math.max(0, i - 6); j--) {
        if (NETWORK_CALL.test(lines[j])) break;
        if (RECORD_WRITE.test(lines[j])) { push(i, 'server secret saved into a record'); break; }
      }
    }
  }
  return hits;
}

module.exports = {
  settingsKind,
  focusFile,
  scanAccessRules,
  prepareAccessRules,
  scanSignIn,
  codeRefs,
  guardedNames,
  linkAccessRules,
  // exposed for tests
  scanFirebaseRules,
  scanSql,
};
