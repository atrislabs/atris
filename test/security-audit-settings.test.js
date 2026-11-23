'use strict';

// The settings classes: data access rules and sign-in account matching.
// Offline: only the map step and the first-wave picker run.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const audit = require('../lib/security-audit');
const settings = require('../lib/security-audit-settings');

function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-settings-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init'], { cwd: root });
  return root;
}

function withRepo(files, fn) {
  const root = repo(files);
  try { return fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

const unitsOf = (root, profile = 'standard') => audit.mapTarget(root, { profile }).units;
const has = (units, file, cls) => units.some((u) => u.attack_class === cls && u.starting_paths.includes(file));

const rules = (body) => `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n${body}\n  }\n}\n`;

test('firestore: an open read is seeded with the app code that filters, an owner rule stays quiet', () => {
  const app = "import { collection, query, where } from 'firebase/firestore';\nexport const listed = (db) => query(collection(db, 'campsites'), where('listed', '==', true));\n";
  withRepo({
    'firestore.rules': rules('    match /campsites/{userId} {\n      allow read;\n      allow write: if request.auth.uid == userId;\n    }'),
    'src/map.js': app,
  }, (root) => {
    const u = unitsOf(root).find((x) => x.attack_class === 'access-rules' && x.starting_paths[0] === 'firestore.rules');
    assert.ok(u, 'the open rule is seeded');
    assert.deepStrictEqual(u.starting_paths, ['firestore.rules', 'src/map.js']);
    assert.ok(u.hot_lines.some((h) => h.file === 'firestore.rules' && /open to anyone/.test(h.text)));
    assert.ok(u.hot_lines.some((h) => h.file === 'src/map.js' && /listed/.test(h.text)), 'the app query rides along');
    assert.deepStrictEqual(audit.validateLedger(unitsOf(root)), []);
  });
  withRepo({
    'firestore.rules': rules('    match /campsites/{userId} {\n      allow read, write: if request.auth != null && request.auth.uid == userId;\n    }'),
    'src/map.js': app,
  }, (root) => {
    assert.ok(!unitsOf(root).some((x) => x.attack_class === 'access-rules'));
  });
});

test('firestore scanner: signed-in only, test mode and open writes are seeded; data filters, helpers and deny-all are not', () => {
  const lines = (body) => settings.scanFirebaseRules(rules(body)).map((h) => h.text);
  assert.match(lines('match /m/{id} { allow read: if request.auth != null; }')[0], /any signed-in user/);
  assert.match(lines('match /m/{id} { allow read: if request.auth.uid != null; }')[0], /any signed-in user/);
  assert.match(lines('match /m/{id} { allow read, write: if request.time < timestamp.date(2030, 1, 1); }')[0], /write with no check/);
  assert.match(lines('match /m/{id} { allow get: if request.time < timestamp.date(2030, 1, 1); }')[0], /test mode/);
  assert.match(lines('match /m/{id} {\n  allow create: if\n    request.resource.data.keys().hasOnly(["a"]);\n}')[0], /write with no check/);
  assert.deepStrictEqual(lines('match /m/{id} { allow read: if resource.data.listed == true; }'), []);
  assert.deepStrictEqual(lines('match /{document=**} { allow read, write: if false; }'), []);
  assert.deepStrictEqual(lines('function isOwner(d) { return request.auth != null && request.auth.uid == d.ownerId; }\nmatch /m/{id} { allow update: if isOwner(resource.data); }'), []);
  assert.deepStrictEqual(lines('match /m/{id} { allow read: if request.auth.token.admin == true; }'), []);
});

test('supabase: a table without row level security is seeded, a later migration that turns it on counts', () => {
  withRepo({
    'supabase/migrations/001_profiles.sql': 'create table public.profiles (\n  id uuid primary key,\n  address text\n);\n',
    'supabase/migrations/002_gear.sql': 'create table public.gear (id bigint primary key, owner_id uuid);\n',
    'supabase/migrations/003_gear_rls.sql': 'alter table public.gear enable row level security;\ncreate policy "own" on public.gear for all using (auth.uid() = owner_id);\n',
    'app/profile.ts': "export const me = (sb: any, id: string) => sb.from('profiles').select('*').eq('id', id);\n",
  }, (root) => {
    const units = unitsOf(root);
    const profiles = units.find((u) => u.attack_class === 'access-rules' && u.starting_paths[0] === 'supabase/migrations/001_profiles.sql');
    assert.ok(profiles, 'table with row level security off');
    assert.ok(profiles.starting_paths.includes('app/profile.ts'), 'the query that relies on it rides along');
    assert.ok(!has(units, 'supabase/migrations/002_gear.sql', 'access-rules'));
    assert.ok(!has(units, 'supabase/migrations/003_gear_rls.sql', 'access-rules'));
  });
});

test('sql scanner: using (true), open write policies, grants, definer functions and views', () => {
  const ctx = { rls: new Set(['notes']), aware: true };
  const why = (sql) => settings.scanSql(sql, ctx).map((h) => h.text.replace(/^.*\[/, '').replace(/\]$/, ''));
  assert.deepStrictEqual(why('create policy "r" on public.notes\n  for select\n  using (true);'), ['policy allows every row']);
  assert.deepStrictEqual(why('create policy "w" on public.notes for update using (owner is not null);'), ['write policy with no check of who is asking']);
  assert.deepStrictEqual(why('create policy "r" on public.notes for select using (published = true);'), []);
  assert.deepStrictEqual(why('create policy "w" on public.notes for insert with check (auth.uid() = owner);'), []);
  assert.deepStrictEqual(why('alter table public.notes disable row level security;'), ['row level security turned off']);
  assert.deepStrictEqual(why('grant select on public.secrets to anon;'), ['granted to anonymous callers with no row level security']);
  assert.deepStrictEqual(why('create function public.f() returns int language sql security definer as $$ select 1 $$;'), ['runs with owner rights, skips row level security']);
  assert.deepStrictEqual(why('create view public.v as select * from auth.users;'), ['view skips row level security of its tables']);
  assert.deepStrictEqual(why('create view public.v with (security_invoker = on) as select * from public.notes;'), []);
  // A plain Postgres repo with no row level security anywhere: tables are not seeded.
  assert.deepStrictEqual(settings.scanSql('create table orders (id int);', { rls: new Set(), aware: false }), []);
});

test('buckets, cors and hosting: open settings are seeded, closed ones stay quiet', () => {
  withRepo({
    'infra/open.tf': 'resource "aws_s3_bucket_public_access_block" "b" {\n  block_public_acls = false\n}\n',
    'infra/closed.tf': 'resource "aws_s3_bucket_public_access_block" "b" {\n  block_public_acls = true\n  restrict_public_buckets = true\n}\n',
    'api/open.js': "app.use(cors({\n  origin: true,\n  credentials: true,\n}));\n",
    'api/closed.js': "app.use(cors({ origin: ['https://a.example.com'], credentials: true }));\napp.use(cors());\n",
    'netlify.toml': '[[redirects]]\n  from = "/admin/*"\n  to = "http://10.0.0.5:8080/:splat"\n  status = 200\n',
    'web/.env.example': 'NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY=\n',
  }, (root) => {
    const units = unitsOf(root);
    for (const f of ['infra/open.tf', 'api/open.js', 'netlify.toml', 'web/.env.example']) assert.ok(has(units, f, 'access-rules'), `missing ${f}`);
    for (const f of ['infra/closed.tf', 'api/closed.js']) assert.ok(!has(units, f, 'access-rules'), `false alarm ${f}`);
  });
});

test('example env: a guard the code reads but the example leaves out is seeded with that code; values never kept', () => {
  const code = 'module.exports = (req, res, next) => {\n  const allow = (process.env.ADMIN_ALLOWLIST || "").split(",");\n  return allow.includes(req.user) ? next() : res.end();\n};\n';
  withRepo({ '.env.example': 'ADMIN_EMAILS=ops@example.com\nPORT=3000\n', 'lib/admin.js': code }, (root) => {
    const u = unitsOf(root).find((x) => x.attack_class === 'access-rules' && x.starting_paths[0] === '.env.example');
    assert.ok(u);
    assert.ok(u.starting_paths.includes('lib/admin.js'));
    assert.ok(!u.hot_lines.some((h) => /ops@example/.test(h.text)), 'only names, never values');
  });
  withRepo({ '.env.example': 'ADMIN_ALLOWLIST=\nPORT=3000\n', 'lib/admin.js': code }, (root) => {
    assert.ok(!has(unitsOf(root), '.env.example', 'access-rules'), 'no gap, no unit');
  });
});

test('sign-in: lookups by user name or email local part are seeded, issuer plus subject stays quiet', () => {
  const cb = (pick) => [
    "const { Issuer } = require('openid-client');",
    'exports.callback = async (req, client) => {',
    '  const claims = (await client.callback(req)).claims();',
    pick,
    '  return user;',
    '};',
    '',
  ].join('\n');
  withRepo({
    'auth/a.js': cb('  const user = await db.users.findOne({ username: claims.preferred_username });'),
    'auth/b.js': cb("  const user = await db.users.findOne({ login: claims.email.split('@')[0] });"),
    'auth/c.js': cb('  const user = await db.users.findOne({ email: claims.email });'),
    'auth/ok.js': cb("  if (!claims.email_verified) throw new Error('no');\n  const user = await db.users.findOne({ iss: claims.iss, sub: claims.sub });"),
    'auth/password.js': 'exports.login = async (req) => User.findOne({ email: req.body.email });\n',
    'lib/read.js': "const email = claims.get('email');\nconst user = profile['username'];\n",
  }, (root) => {
    const units = unitsOf(root);
    for (const f of ['auth/a.js', 'auth/b.js', 'auth/c.js']) assert.ok(has(units, f, 'sign-in-matching'), `missing ${f}`);
    for (const f of ['auth/ok.js', 'auth/password.js', 'lib/read.js']) assert.ok(!has(units, f, 'sign-in-matching'), `false alarm ${f}`);
    const c = units.find((u) => u.attack_class === 'sign-in-matching' && u.starting_paths[0] === 'auth/c.js');
    assert.ok(c.hot_lines.some((h) => /email_verified never read/.test(h.text)));
  });
});

test('sign-in: email linking, first user admin, and a server secret saved into a record', () => {
  const s = (text) => settings.scanSignIn(text).map((h) => h.text.replace(/^.*\[/, '').replace(/\]$/, ''));
  assert.deepStrictEqual(s("NextAuth({ providers: [GitHub({ allowDangerousEmailAccountLinking: true })] });"), ['accounts linked by email across providers']);
  assert.deepStrictEqual(s("const n = await prisma.user.count();\nconst role = n === 0 ? 'admin' : 'member';"), ['first user becomes admin']);
  assert.deepStrictEqual(s('if User.objects.count() == 0:\n    user.is_superuser = True'), ['first user becomes admin']);
  assert.deepStrictEqual(s('await db.credentials.insert({\n  workspaceId: ws.id,\n  clientSecret: process.env.GOOGLE_CLIENT_SECRET,\n});'), ['server secret saved into a record']);
  assert.deepStrictEqual(s("Integration.objects.create(workspace=ws, client_secret=settings.SLACK_CLIENT_SECRET)"), ['server secret saved into a record']);
  // A token exchange sends the secret; it does not save it.
  assert.deepStrictEqual(s('await db.accounts.update({ id });\nconst r = await fetch(url, {\n  body: new URLSearchParams({\n    client_secret: process.env.GH_SECRET,\n  }),\n});'), []);
  assert.deepStrictEqual(s('GitHub({\n  clientId: process.env.GITHUB_ID,\n  clientSecret: process.env.GITHUB_SECRET,\n})'), []);
});

test('everyday code in a file that mentions sign-in stays quiet', () => {
  const s = (body) => settings.scanSignIn(`// handles the OAuth callback\n${body}\n`);
  for (const body of [
    'const email = row.get("email", "unknown")',
    'payload["handle"] = user_data.get("username")',
    '@router.get("/check/{username}")',
    'out = {key: person.get(key) for key in ("id", "username", "name")}',
    'const label = `${count} item${count === 1 ? "" : "s"}`; const role = "owner";',
    'if not path.exists():\n    owner = "admin"',
    'response["name"] = (user.get("email") or "").split("@")[0]',
    '// we store the key where login keeps it, keyed by email',
    "  'Find the line that picks the local user by username or email in the store',",
  ]) assert.deepStrictEqual(s(body), [], body);
  assert.deepStrictEqual(settings.scanAccessRules('const skip = process.env.ATRIS_SKIP_UPDATE_CHECK;\n', 'bin/cli.js', {}), []);
  assert.strictEqual(settings.scanAccessRules('if (process.env.SKIP_AUTH_VERIFY) return next();\n', 'lib/mw.js', {}).length, 1);
});

test('quick mode reads settings areas first in a busy repo', () => {
  const busy = {
    'lib/run.js': "const { execSync } = require('child_process');\nexports.run = (n) => execSync(`make ${n}`);\n",
    'lib/files.js': "const fs = require('fs');\nexports.save = (n, b) => fs.writeFileSync(n, b);\n",
    'lib/db.js': "exports.q = (c) => pool.query(\"SELECT * FROM t WHERE c = '\" + c + \"'\");\n",
    'lib/eval.js': 'exports.calc = (s) => eval(s);\n',
    'lib/fetch.js': 'exports.get = (u) => fetch(u);\n',
    'server.js': "require('http').createServer((req, res) => res.end(req.url)).listen(3000);\n",
    'firestore.rules': rules('    match /campsites/{id} {\n      allow read;\n    }'),
    'auth/oidc.js': "const claims = tokenSet.claims();\nconst user = await db.users.findOne({ username: claims.preferred_username });\n",
  };
  withRepo(busy, (root) => {
    const units = unitsOf(root, 'quick');
    const wave = audit.firstWave(units, 'quick');
    const classes = wave.map((u) => u.attack_class);
    assert.ok(classes.includes('access-rules'), `first wave: ${classes.join(', ')}`);
    assert.ok(classes.includes('sign-in-matching'), `first wave: ${classes.join(', ')}`);
    assert.deepStrictEqual(audit.validateLedger(units), []);
  });
});

test('focus files: rules, policy migrations, sign-in paths and credential handlers', () => {
  for (const f of ['firestore.rules', 'storage.rules', 'database.rules.json', 'db/policies/notes.sql', 'src/auth/callback.ts', 'app/api/auth/[...nextauth]/route.ts', 'lib/oauth.js', 'server/sso/saml.py', 'lib/credentials.js', 'server/integrations/slack.js']) assert.ok(settings.focusFile(f), f);
  assert.ok(settings.focusFile('db/migrations/004.sql', 'alter table x enable row level security;'));
  for (const f of ['lib/run.js', 'db/migrations/004.sql', 'src/author.js', 'lib/authority.js']) assert.ok(!settings.focusFile(f), f);
});

test('real env files are never read, only example ones', () => {
  for (const f of ['.env', '.env.local', '.env.production', 'web/.env', 'secrets.env']) assert.strictEqual(settings.settingsKind(f), null, f);
  for (const f of ['.env.example', 'web/.env.sample', '.env.template']) assert.strictEqual(settings.settingsKind(f), 'env', f);
  withRepo({ '.env': 'ADMIN_TOKEN=do-not-read\n', 'lib/a.js': 'exports.t = process.env.ADMIN_TOKEN_CHECK;\n' }, (root) => {
    const units = unitsOf(root);
    assert.ok(!units.some((u) => u.starting_paths.includes('.env')));
    assert.ok(!JSON.stringify(units).includes('do-not-read'));
  });
});
