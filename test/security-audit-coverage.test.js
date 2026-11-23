'use strict';

// Quick review coverage: where a quick run reads first, how its hunters
// share files, and which leads its verifiers check first.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const audit = require('../lib/security-audit');
const headers = require('../lib/security-audit-headers');
const settings = require('../lib/security-audit-settings');
const { kindsOf, hotspotLift } = require('../lib/security-audit-hotspots');

function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-coverage-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: root });
  return root;
}

test('a quick budget spends no call on a critic and half on checking leads', () => {
  assert.deepStrictEqual(audit.budgetPlan('quick', 8), { total: 8, critics: 0, verifyReserve: 4, hunters: 4 });
  assert.strictEqual(audit.budgetPlan('standard', 20).critics, 2);
});

test('verifiers take proposed confirmed leads first, highest severity first', () => {
  const leads = [
    { fingerprint: 'a.go:x/needs-fact', proposed_verdict: 'needs_validation' },
    { fingerprint: 'b.go:x/medium', proposed_verdict: 'confirmed', severity: { overall: 'medium' } },
    { fingerprint: 'z.go:x/high', proposed_verdict: 'confirmed', severity: { overall: 'high' } },
  ];
  assert.deepStrictEqual([...leads].sort(audit.verifyOrder).map((l) => l.fingerprint), ['z.go:x/high', 'b.go:x/medium', 'a.go:x/needs-fact']);
});

test('a quick hunter checks a shared file for every class that seeded it', () => {
  const root = repo({
    'app/routes/notes.js': [
      "const db = require('../db');",
      "app.get('/notes/:id', async (req, res) => {",
      '  const note = await db.notes.findOne({ id: req.params.id });',
      '  res.json(note);',
      '});',
      "app.post('/notes/import', async (req, res) => {",
      '  const body = await fetch(req.body.source_url);',
      '  res.json(await body.text());',
      '});',
      '',
    ].join('\n'),
    'app/db.js': 'module.exports = { notes: { findOne: async () => null } };\n',
  });
  try {
    const { units } = audit.mapTarget(root, { profile: 'quick' });
    const wave = audit.firstWave(units, 'quick');
    const onNotes = wave.filter((u) => u.starting_paths.includes('app/routes/notes.js')).map((u) => u.attack_class).sort();
    assert.ok(onNotes.includes('access-control'), onNotes.join(','));
    assert.ok(onNotes.includes('outbound-request'), onNotes.join(','));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('kinds of code where holes live lift only the classes that hunt them', () => {
  const kinds = kindsOf('server/webhooks/stripe.js', "const sig = req.headers['stripe-signature'];");
  assert.ok(kinds.has('inbound'));
  assert.ok(hotspotLift('inbound-signature', kinds) > 0);
  assert.strictEqual(hotspotLift('command-injection', kinds), 0);
});

test('a signed inbound request seeds; a signing helper with no request stays quiet', () => {
  const handler = [
    'func (a *API) Handle(w http.ResponseWriter, r *http.Request) {',
    '  q := r.URL.Query()',
    '  sig := q.Get("auth_signature")',
    '  bodyMD5 := q.Get("body_md5")',
    '  stringToSign := "POST\\n" + r.URL.Path + "&body_md5=" + bodyMD5',
    '  if !a.verifier.Verify(stringToSign, sig) { return }',
    '}',
  ].join('\n');
  assert.ok(headers.scanInboundSignature(handler).length > 0);
  const helper = 'function sign(secret, text) { return crypto.createHmac("sha256", secret).update(text).digest("hex"); }\n';
  assert.deepStrictEqual(headers.scanInboundSignature(helper), []);
});

test('an allowlist on a framework client IP helper seeds header trust; a log line does not', () => {
  const allow = [
    'func IpLimit(cfg *Config) Handler {',
    '  return func(c *Context) {',
    '    for _, n := range cfg.MCPAllowedRemoteIPs { if n.Match(c.ClientIP()) { c.Next(); return } }',
    '    c.AbortWithStatus(403)',
    '  }',
    '}',
  ].join('\n');
  assert.strictEqual(headers.scanHeaderTrust(allow).length, 1);
  assert.deepStrictEqual(headers.scanHeaderTrust('log.Info("request from", c.ClientIP())\n'), []);
});

test('an account name taken from the email claim seeds sign-in, unless email_verified is read', () => {
  const claim = [
    'from .oauth2 import OAuthenticator',
    'class Provider(OAuthenticator):',
    '    @default("username_claim")',
    '    def _username_claim_default(self):',
    '        return "email"',
  ].join('\n');
  assert.strictEqual(settings.scanSignIn(claim).length, 1);
  assert.deepStrictEqual(settings.scanSignIn(`${claim}\n    def check(self, info):\n        return info.get("email_verified")\n`), []);
});
