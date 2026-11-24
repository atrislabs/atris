'use strict';

// Secret shapes the scanner's SECRET_RULES leave out because they are too
// short or too plain to pass its quality bar: database passwords,
// connection strings with a password in them, values named like a
// password or key, basic auth and a few more cloud key prefixes.
//
// These rules are for what leaves the machine (prompts to Atris models,
// upload titles, signed record entries). A line that matches is hidden
// whole. They lean toward hiding: a hidden line costs the reviewer one
// line, a leaked password costs the person their database. What they never
// hide is code that only names a secret (process.env.DB_PASSWORD,
// os.environ["X"], ${DB_PASS}, settings.password, a function call).

// A value that is a reference to a secret, not the secret.
const REFERENCE = /^(?:\$\{[^}]*\}|\$\(?[A-Za-z_][A-Za-z0-9_]*\)?|\{\{[^}]*\}\}|\{[A-Za-z_][A-Za-z0-9_.]*\}|%\(?[A-Za-z_]*\)?s|%s|<[^>]*>|\*+|x+|X+|\.{3,}|#\{[^}]*\})$/;
const NOT_A_VALUE = /^(?:none|null|nil|undefined|true|false|yes|no|on|off|required|optional|string|str|int|bool|text|password|secret|token|env|omit|include|same-origin|number|boolean|any|unknown|object|never|void|bigint|date|buffer|uuid|bytes|float|double|long|char|\[\]|\{\}|""|'')$/i;

// Names that hold a secret value: the name ends with the secret word.
// DATABASE_PASSWORD, dbPassword, client_secret, AWS_SECRET_ACCESS_KEY,
// GITHUB_TOKEN, secret_key_base. Not password_reset_url, passwordLabel,
// tokenType or secretName, which only talk about one.
const SECRET_NAME = /(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|privatekey|signing[_-]?key|encryption[_-]?key|master[_-]?key|account[_-]?key|credentials?|auth[_-]?key|session[_-]?key|webhook[_-]?secret|dsn)(?:[_-]?(?:base|value|hash|b64|base64|enc|raw))?$/i;

// name = "value", name: 'value', "name": "value", name => 'value',
// :name => "value", NAME := `value`, name="value" inside a call.
const QUOTED_ASSIGN = /(?:^|[^A-Za-z0-9_$])[:@]?["'`]?([A-Za-z_$][A-Za-z0-9_.$-]*)["'`]?\s*(?:=>|:=|\?\?=|\|\|=|=|:)\s*(?:[rbuf]{0,2})(["'`])((?:(?!\2).){1,400}?)\2/g;

// NAME=value or name: value at the start of a line, the shape of .env,
// YAML, INI, TOML and shell exports. The value runs to the end of the line
// or a comment.
const BARE_ASSIGN = /^\s*(?:export\s+|set\s+|-\s+)?["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?\s*(?:=|:)\s*([^\s'"`#;,(){}\[\]]+)\s*(?:[#;].*)?$/;

// Passwords inside a URL: scheme://user:pass@host, scheme://:pass@host.
const URL_PASSWORD = /\b[a-z][a-z0-9+.-]{1,30}:\/\/([^\s:@\/'"`<>]*):([^\s@\/'"`<>]+)@[^\s'"`<>]/gi;

// key=value pairs inside a connection string or a query:
// Password=x;  ?password=x&  AccountKey=x;  SharedAccessKey=x
const PAIR_PASSWORD = /(?:^|[;?&\s"'])(?:password|passwd|pwd|pass|secret|token|access_token|api[_-]?key|apikey|accountkey|sharedaccesskey|sharedaccesssignature|sig|client_secret|private_key)=([^;&\s'"`,)]+)/gi;

// NAME=value in front of a command: PGPASSWORD=x psql, TOKEN=x ./deploy.sh
const ENV_PREFIX = /(?:^|\s)([A-Z][A-Z0-9_]*(?:PASSWORD|PASSWD|PASS|PWD|SECRET|TOKEN|API_KEY|APIKEY|ACCESS_KEY))=(?![$'"{<(`])([^\s'"`;]{3,})/g;

// Other shapes that are a secret on their own.
const SHAPES = [
  // Authorization: Basic dXNlcjpwYXNz (any length), and shorter bearer tokens.
  /\bBasic\s+(?=[A-Za-z+/]*[0-9+/=]|[a-z]+[A-Z])[A-Za-z0-9+/]{6,}={0,2}(?![A-Za-z0-9+/=])/,
  /\bBearer\s+(?![$<{%])[A-Za-z0-9._~+/-]{12,}=*/,
  // A whole private key or a PuTTY key file.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/,
  /PuTTY-User-Key-File-\d/,
  // Command lines that carry a password: mysql -pSecret, --password=x,
  // curl -u user:pass, sshpass -p x, PGPASSWORD=x psql.
  /\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^\n]*\s-p(?![\s$'"])\S{3,}/,
  /--(?:password|passwd|pass|token|secret|api-key|apikey)(?:=|\s+)(?![-$<{%])['"]?[^\s'"$]{3,}/i,
  /\b(?:curl|wget|http)\b[^\n]*\s(?:-u|--user)\s+['"]?[^\s:'"$]+:(?![$<{%])[^\s'"]{3,}/,
  /\bsshpass\s+-p\s*(?![$<{%])['"]?[^\s'"$]{3,}/,
  // .netrc: machine host login user password secret
  /^\s*(?:machine|default)\b[^\n]*\bpassword\s+(?![$<{%])\S{3,}/,
  // Cloud and service keys the scanner list does not carry.
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\bhf_[A-Za-z0-9]{30,}/,
  /\bdop_v1_[a-f0-9]{40,}/,
  /\bshp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}/,
  /\b[rs]k_test_[A-Za-z0-9]{20,}/,
  /\bwhsec_[A-Za-z0-9+/=]{20,}/,
  /\bxapp-\d-[A-Za-z0-9-]{20,}/,
  /\bAC[a-f0-9]{32}\b/,
  /\bSK[a-f0-9]{32}\b/,
  /\bya29\.[A-Za-z0-9_-]{20,}/,
  /\bGOCSPX-[A-Za-z0-9_-]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:pat|pplx|gsk|xai|tvly|fw|r8|lin_api|sq0csp|sq0atp|EAAC|EAAG)[-_](?=[A-Za-z_-]*\d)[A-Za-z0-9_-]{20,}/,
  /"type"\s*:\s*"service_account"/,
];

// A value that is itself a name or a route: 'forgot-password', 'csrf_token',
// "OPENAI_API_KEY" (the name of an environment variable), '/reset-password'.
function namesASecret(value) {
  const v = String(value || '');
  if (/^\/[a-z0-9/_:.-]*$/.test(v)) return true;
  if (/^[a-z][a-z_-]*$/.test(v) && /pass|pwd|secret|token|key|cred|auth/.test(v)) return true;
  // snake_case words name a variable or a stored secret: nexus_home_db_dsn.
  if (/^_*[a-z]+(?:_[a-z]+)+_*$/.test(v)) return true;
  // a placeholder in docs: atris_..., YOUR_KEY, your-token, [REDACTED]
  if (/\.\.\.$|^your[_-]|YOUR_|REDACTED|^x{4,}|^\*{3,}/i.test(v)) return true;
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(v) && /PASS|PWD|SECRET|TOKEN|KEY|CRED|AUTH/.test(v)) return true;
  return false;
}

function isReference(value) {
  const v = String(value || '').trim();
  if (!v) return true;
  if (REFERENCE.test(v)) return true;
  if (NOT_A_VALUE.test(v)) return true;
  // ${...} or {{ }} anywhere in the value: a template, filled in later.
  if (/\$\{[^}]+\}|\{\{[^}]+\}\}|^\$[A-Za-z_]|\{[A-Za-z_][A-Za-z0-9_.]*\}/.test(v)) return true;
  return false;
}

// A bare (unquoted) value that is code, not a literal: a call, an
// attribute chain, an environment lookup, or a variable named like the
// secret it holds (password = new_password).
function isCodeValue(value) {
  const v = String(value || '').trim();
  if (isReference(v) || namesASecret(v)) return true;
  if (/[()[\]]/.test(v)) return true;
  if (/^(?:process\.env|os\.environ|os\.getenv|ENV|env|System\.getenv|config|settings|self|this|cls|params|req|request|options|opts|props|args)\b/.test(v)) return true;
  if (/^[A-Za-z_$][A-Za-z0-9_$]*(?:\??\.[A-Za-z_$][A-Za-z0-9_$]*)+$/.test(v) && !/\d/.test(v)) return true;
  if (/^[a-z_][a-zA-Z_]*$/.test(v) && /pass|pwd|secret|token|key|cred/i.test(v)) return true;
  // a camelCase variable: refreshToken = legacyRefresh
  if (/^[a-z]+(?:[A-Z][a-z]+)+$/.test(v)) return true;
  if (/^[A-Z][A-Za-z]+$/.test(v) && /^(?:String|Optional|Secret|SecretStr|Field|None|Password|Token)$/.test(v)) return true;
  return false;
}

// "pass" alone is a word ("second pass:"); db_pass and dbPass are names.
function secretName(name) {
  return SECRET_NAME.test(name) && !/^pass$|(?:by|com|sur|over|under|on)[_-]?pass$/i.test(name);
}

function quotedHit(line) {
  // type Pass = 'ground' | 'air' lists words, it sets nothing.
  if (/^\s*(?:export\s+)?type\s+\w+/.test(line)) return false;
  QUOTED_ASSIGN.lastIndex = 0;
  let m;
  while ((m = QUOTED_ASSIGN.exec(line))) {
    const name = m[1].split('.').pop();
    const value = m[3];
    // Matches can overlap ("code":"DB_PASSWORD = \"x\""), so the next try
    // starts right after this name, not after this whole match.
    QUOTED_ASSIGN.lastIndex = m.index + m[0].indexOf(m[1]) + m[1].length;
    if (!secretName(name)) continue;
    // cond ? 'pass' : 'fail' is a choice of words, not a name and a value.
    if (/\?\s*["'`]?$/.test(line.slice(0, m.index + m[0].indexOf(m[1])))) continue;
    if (isReference(value)) continue;
    // A sentence is a label or a message, not a secret: "Enter your password".
    if (/\s/.test(value.trim())) continue;
    if (value.length < 3) continue;
    if (namesASecret(value)) continue;
    return true;
  }
  return false;
}

function bareHit(line) {
  const m = BARE_ASSIGN.exec(line);
  if (!m) return false;
  const name = m[1].split('.').pop();
  if (!secretName(name)) return false;
  const value = m[2];
  if (value.length < 3) return false;
  return !isCodeValue(value);
}

function urlHit(line) {
  URL_PASSWORD.lastIndex = 0;
  let m;
  while ((m = URL_PASSWORD.exec(line))) {
    const pass = m[2];
    if (isReference(pass)) continue;
    // user:${PASS}@ or user:%s@: filled in later.
    if (/^[$%{<]/.test(pass)) continue;
    return true;
  }
  return false;
}

function pairHit(line) {
  PAIR_PASSWORD.lastIndex = 0;
  let m;
  while ((m = PAIR_PASSWORD.exec(line))) {
    const v = m[1];
    if (v.length < 3 || isCodeValue(v) || /^[$%{<]/.test(v)) continue;
    return true;
  }
  return false;
}

// The ways one source line reaches a prompt: as is, after a line number
// ("   12  DB_PASSWORD=x"), and inside a JSON string ("code":"DB_PASSWORD=x").
function readings(line) {
  const out = [line];
  const numbered = /^\s*\d+[\s:|]+/.exec(line);
  if (numbered) out.push(line.slice(numbered[0].length));
  const strings = line.match(/"(?:[^"\\]|\\.)*"/g) || [];
  for (const lit of strings) {
    if (lit.length < 6) continue;
    let inner;
    try { inner = JSON.parse(lit); } catch { inner = lit.slice(1, -1); }
    if (typeof inner === 'string') out.push(...inner.split('\n'));
  }
  return out;
}

function envPrefixHit(line) {
  ENV_PREFIX.lastIndex = 0;
  let m;
  while ((m = ENV_PREFIX.exec(line))) if (secretName(m[1]) && !isCodeValue(m[2])) return true;
  return false;
}

function lineHit(line) {
  if (SHAPES.some((re) => re.test(line))) return true;
  if (envPrefixHit(line)) return true;
  return urlHit(line) || pairHit(line) || quotedHit(line) || bareHit(line);
}

// True when the text holds a secret in one of the shapes above. Reads
// line by line.
function extraSecretHit(text) {
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    if (readings(line).some(lineHit)) return true;
  }
  return false;
}

module.exports = { extraSecretHit, SECRET_NAME, isReference };
