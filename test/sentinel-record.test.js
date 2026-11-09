'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const rec = require('../lib/sentinel-record');
const { recordCommand } = require('../commands/sentinel-record');

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-record-'));
  const root = path.join(tmp, 'shop');
  fs.mkdirSync(root);
  const opts = { recordHome: path.join(tmp, 'audit'), homeDir: path.join(tmp, 'home') };
  return { tmp, root, opts, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

function writeRun(opts, project, n, meta, findings) {
  const dir = path.join(opts.recordHome, project, `run-${n}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run-metadata.json'), JSON.stringify({ run_id: `run-${n}`, run_status: 'complete', coverage: { in_scope: 10, done: 4 }, ...meta }));
  fs.writeFileSync(path.join(dir, 'findings.json'), JSON.stringify(findings));
  return dir;
}

const LEAK = 'AKIAIOSFODNN7EXAMPLQ';
function finding(fp, verdict, extra = {}) {
  return {
    fingerprint: fp,
    verdict,
    title: 'Login token is shown on screen',
    severity: { overall: 'medium' },
    root_cause: `const token = process.env.API_KEY; console.log(token) // ${LEAK}`,
    description: 'readFileSync(secret) prints the key',
    trace: [{ file: 'src/auth.js', line: 12 }, { file: 'src/login.js', line: 40 }],
    ...extra,
  };
}

function seed(ctx) {
  writeRun(ctx.opts, 'shop', 1, { finished_at: '2026-10-01T10:00:00.000Z' }, [finding('src/login.js:show/token', 'confirmed')]);
  writeRun(ctx.opts, 'shop', 2, { mode: 'recheck', finished_at: '2026-10-04T10:00:00.000Z' }, [finding('src/login.js:show/token', 'fixed')]);
  rec.backfill(ctx.root, ctx.opts);
  rec.append(ctx.root, { kind: 'agent_check', summary: 'Sentinel checked the agent setup. 0 problems are open.', counts: { open: { high: 0 } } }, ctx.opts);
  rec.append(ctx.root, { kind: 'guard', summary: 'The sentinel guard stopped 2 agent actions.', counts: { blocked: 2, blocked_by_rule: { 'exfil-secret-file': 2 } } }, ctx.opts);
  return rec.buildExport(ctx.root, ctx.opts);
}

function browserFromHtml(html) {
  const m = html.match(/<script>\n([\s\S]*?)\nwindow\.recordChecked = /);
  assert.ok(m, 'html holds the verifier');
  // eslint-disable-next-line no-new-func
  return new Function(`${m[1]}\nreturn browserVerify;`)();
}

async function both(doc, html) {
  const cli = rec.verifyDoc(doc);
  const web = await (html ? browserFromHtml(html) : rec.browserVerify)(doc, globalThis.crypto.subtle);
  assert.deepStrictEqual(web, cli, 'browser and cli agree');
  return cli;
}

const clone = (x) => JSON.parse(JSON.stringify(x));

test('chain and signatures verify in node and in the browser code', async () => {
  const ctx = setup();
  try {
    const doc = seed(ctx);
    assert.strictEqual(doc.entries.length, 4);
    const r = await both(doc);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.entries, 4);
    assert.strictEqual(doc.entries[0].prev, rec.ZERO_HASH);
    assert.strictEqual(doc.entries[1].prev, doc.entries[0].hash);
  } finally { ctx.cleanup(); }
});

test('editing, deleting, reordering, inserting or cutting any entry breaks verify and names it', async () => {
  const ctx = setup();
  try {
    const doc = seed(ctx);
    const html = rec.renderHtml(doc);
    for (let i = 0; i < doc.entries.length; i += 1) {
      const edited = clone(doc); edited.entries[i].summary = 'Nothing was ever found.';
      let r = await both(edited, html);
      assert.deepStrictEqual([r.ok, r.entry, r.code], [false, i + 1, 'hash']);

      const counts = clone(doc); counts.entries[i].counts.blocked = 99;
      r = await both(counts, html);
      assert.deepStrictEqual([r.ok, r.entry, r.code], [false, i + 1, 'hash']);

      const deleted = clone(doc); deleted.entries.splice(i, 1);
      r = await both(deleted, html);
      assert.strictEqual(r.ok, false);
      if (i < doc.entries.length - 1) assert.deepStrictEqual([r.entry, r.code], [i + 1, 'seq']);
      else assert.strictEqual(r.code, 'head');
    }
    const swapped = clone(doc); [swapped.entries[1], swapped.entries[2]] = [swapped.entries[2], swapped.entries[1]];
    let r = await both(swapped, html);
    assert.deepStrictEqual([r.ok, r.entry, r.code], [false, 2, 'seq']);
    assert.strictEqual(r.label, 'entry 2');

    // An attacker without the key builds a perfect-looking entry 2.
    const other = crypto.generateKeyPairSync('ed25519').privateKey;
    const inserted = clone(doc);
    const body = { kind: 'review', at: '2026-10-02T00:00:00.000Z', summary: 'Sentinel reviewed the project. 0 problems are open.', counts: {}, findings: [], exam_version: 'x', atris_version: '1', seq: 2, prev: inserted.entries[0].hash };
    const hash = crypto.createHash('sha256').update(rec.canonical(body)).digest('hex');
    inserted.entries.splice(1, 0, { ...body, hash, sig: crypto.sign(null, Buffer.from(hash), other).toString('base64url') });
    r = await both(inserted, html);
    assert.deepStrictEqual([r.ok, r.entry, r.code], [false, 2, 'signature']);

    const head = clone(doc); head.head.count = 3;
    r = await both(head, html);
    assert.deepStrictEqual([r.ok, r.code], [false, 'head']);
  } finally { ctx.cleanup(); }
});

test('a different key fails', async () => {
  const ctx = setup();
  try {
    const doc = seed(ctx);
    const pub = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x;
    const swapped = clone(doc); swapped.public_key = pub; swapped.key_fingerprint = rec.keyFingerprint(pub);
    let r = await both(swapped);
    assert.deepStrictEqual([r.ok, r.entry, r.code], [false, 1, 'signature']);
    const mismatch = clone(doc); mismatch.public_key = pub;
    r = await both(mismatch);
    assert.deepStrictEqual([r.ok, r.code], [false, 'key']);
  } finally { ctx.cleanup(); }
});

test('the html export has no external urls and its verifier matches the cli', async () => {
  const ctx = setup();
  try {
    const doc = seed(ctx);
    const html = rec.renderHtml(doc);
    assert.doesNotMatch(html, /https?:\/\//i);
    assert.doesNotMatch(html, /\b(src|href)\s*=/i);
    assert.doesNotMatch(html, /@import|url\(/i);
    assert.match(html, new RegExp(doc.key_fingerprint));
    assert.deepStrictEqual(rec.readExport(writeTmp(ctx, 'r.html', html)), doc);
    const r = await both(doc, html);
    assert.strictEqual(r.ok, true);
  } finally { ctx.cleanup(); }
});

function writeTmp(ctx, name, text) { const f = path.join(ctx.tmp, name); fs.writeFileSync(f, text); return f; }

test('no code or secret reaches an entry', () => {
  const ctx = setup();
  try {
    seed(ctx);
    rec.append(ctx.root, {
      kind: 'review',
      summary: `const key = process.env.SECRET; ${LEAK}`,
      counts: { 'bad key!': 3, open: { high: 1 } },
      findings: [{ fingerprint: 'x', severity: 'high', status: 'open', title: `readFileSync(path) leaks ${LEAK}`, location: `/etc/passwd:1` }, { fingerprint: 'y', title: 'Token sits in the log', location: `src/${LEAK}.js:3` }],
    }, ctx.opts);
    const text = fs.readFileSync(rec.recordPath(ctx.root, ctx.opts), 'utf8');
    for (const bad of [LEAK, 'process.env', 'readFileSync', 'console.log', '/etc/passwd', 'bad key', 'src/auth.js:12']) assert.ok(!text.includes(bad), `record holds ${bad}`);
    assert.ok(text.includes('src/login.js:40'), 'file:line locations stay');
    assert.ok(text.includes('Token sits in the log'), 'plain titles stay');
    assert.ok(!text.includes('root_cause') && !text.includes('description'), 'only the record fields are kept')
  } finally { ctx.cleanup(); }
});

test('the key lives outside the repo with 0600 and backfill marks old runs once', () => {
  const ctx = setup();
  try {
    const doc = seed(ctx);
    const kp = rec.keyPath(rec.projectId(ctx.root), ctx.opts);
    assert.ok(!kp.startsWith(ctx.root));
    assert.strictEqual(fs.statSync(kp).mode & 0o777, 0o600);
    assert.strictEqual(doc.entries[0].backfilled, true);
    assert.strictEqual(doc.entries[0].at, '2026-10-01T10:00:00.000Z');
    assert.strictEqual(doc.entries[1].kind, 'recheck');
    assert.strictEqual(rec.backfill(ctx.root, ctx.opts).added.length, 0);
    const s = rec.summarize(doc.entries);
    assert.strictEqual(s.fixed.medium, 1);
    assert.strictEqual(s.fixed_list[0].open_ms, 3 * 86400000);
    assert.strictEqual(s.guard.blocked, 2);
    assert.strictEqual(s.checks.review, 1);
  } finally { ctx.cleanup(); }
});

test('a failed append warns and never throws', () => {
  const ctx = setup();
  try {
    fs.writeFileSync(path.join(ctx.tmp, 'file'), 'x');
    const res = rec.appendSafe(ctx.root, { kind: 'guard', summary: 'ok' }, { recordHome: path.join(ctx.tmp, 'file'), homeDir: ctx.opts.homeDir });
    assert.strictEqual(res.ok, false);
    assert.match(rec.warnLine(res), /^ {2}warning: could not add this to the security record/);
    assert.deepStrictEqual(rec.appendSafe(ctx.root, { kind: 'guard' }, {}), { ok: true, skipped: true }, 'off in tests without a record home');
  } finally { ctx.cleanup(); }
});

test('cli: show, export html and json, verify names the broken entry', async () => {
  const ctx = setup();
  const lines = [];
  const log = console.log; const err = console.error;
  console.log = (m) => lines.push(String(m)); console.error = (m) => lines.push(String(m));
  try {
    seed(ctx);
    const deps = { ...ctx.opts, root: ctx.root };
    assert.strictEqual(await recordCommand(['show'], deps), 0);
    assert.match(lines.join('\n'), /fixed: 0 critical, 0 high, 1 medium/);
    assert.match(lines.join('\n'), /stayed open 3 days/);
    const html = path.join(ctx.tmp, 'out', 'r.html');
    const json = path.join(ctx.tmp, 'out', 'r.json');
    assert.strictEqual(await recordCommand(['export', '--out', html], deps), 0);
    assert.strictEqual(await recordCommand(['export', '--out', json, '--json'], deps), 0);
    assert.strictEqual(await recordCommand(['verify', html], deps), 0);
    assert.strictEqual(await recordCommand(['verify', json], deps), 0);
    const doc = JSON.parse(fs.readFileSync(json, 'utf8'));
    doc.entries[2].summary = 'changed';
    fs.writeFileSync(json, JSON.stringify(doc));
    lines.length = 0;
    assert.strictEqual(await recordCommand(['verify', json], deps), 1);
    assert.match(lines.join('\n'), /broken at entry 3: its contents were changed/);
    for (const l of lines) { assert.doesNotMatch(l, /—/); assert.doesNotMatch(l, /, (and|but|so|then|because|which|when) /); }
  } finally { console.log = log; console.error = err; ctx.cleanup(); }
});

test('sentinel commands add an entry when they finish', async () => {
  const ctx = setup();
  try {
    fs.writeFileSync(path.join(ctx.root, 'CLAUDE.md'), 'be careful\n');
    const powers = require('../commands/sentinel-powers');
    const out = await powers.runAgents(ctx.root, { upload: false, deps: { ...ctx.opts } });
    assert.strictEqual(out.record.ok, true);
    const dir = writeRun(ctx.opts, 'shop', 1, { finished_at: '2026-10-01T10:00:00.000Z' }, [finding('a/b', 'confirmed')]);
    assert.strictEqual(rec.appendSafe(ctx.root, rec.entryFromRun(dir), ctx.opts).ok, true);
    const entries = rec.readEntries(rec.recordPath(ctx.root, ctx.opts));
    assert.deepStrictEqual(entries.map((e) => e.kind), ['agent_check', 'review']);
    assert.strictEqual(entries[1].backfilled, undefined);
    assert.strictEqual(entries[1].atris_version, require('../package.json').version);
    assert.match(entries[1].exam_version, /^rules-[0-9a-f]{12}/);
    assert.strictEqual(rec.verifyDoc(rec.buildExport(ctx.root, ctx.opts)).ok, true);
  } finally { ctx.cleanup(); }
});

// A tiny stand-in for the browser page: runs the page's own script.
function fakePage(html) {
  const make = (tag) => ({ tag, children: [], textContent: '', className: '', appendChild(c) { this.children.push(c); return c; } });
  const json = html.match(/<script type="application\/json" id="record">([\s\S]*?)<\/script>/)[1];
  const els = { status: make('div'), report: make('div'), record: { textContent: json } };
  const document = { getElementById: (id) => els[id], createElement: make };
  const window = { crypto: globalThis.crypto };
  const script = html.match(/<script>\n([\s\S]*?)<\/script>/)[1];
  // eslint-disable-next-line no-new-func
  new Function('document', 'window', script)(document, window);
  const text = (el) => [el.textContent, ...(el.children || []).map(text)].join(' ');
  return window.recordChecked.then(() => ({ status: els.status.textContent, ok: els.status.className === 'ok', report: text(els.report), drawn: els.report.children.length }));
}

test('the page shows nothing from the record until it verifies', async () => {
  const ctx = setup();
  try {
    const doc = seed(ctx);
    const html = rec.renderHtml(doc);
    const outside = html.replace(/<script type="application\/json" id="record">[\s\S]*?<\/script>/, '');
    for (const e of doc.entries) assert.ok(!outside.includes(e.summary), 'no pre-rendered entry text');
    assert.ok(!outside.includes(doc.key_fingerprint), 'no pre-rendered key');
    assert.match(outside, /atris sentinel record verify FILE/, 'the page names the check to trust');

    const good = await fakePage(html);
    assert.strictEqual(good.ok, true);
    assert.ok(good.report.includes(doc.entries[1].summary));
    assert.ok(good.report.includes(doc.key_fingerprint));

    // Editing visible text changes nothing the page shows about the record.
    const visible = await fakePage(html.replace('this page checks the signed record', 'this page was audited by a big firm and checks the signed record'));
    assert.deepStrictEqual(visible, good);

    // Editing the record breaks it and nothing is drawn.
    const changed = await fakePage(html.replace('2 problems were confirmed fixed', '9 problems were confirmed fixed').replace(/1 problem was confirmed fixed/, '9 problems were confirmed fixed'));
    assert.strictEqual(changed.ok, false);
    assert.match(changed.status, /^broken at entry 2: /);
    assert.strictEqual(changed.drawn, 0);
  } finally { ctx.cleanup(); }
});

test('two folders with the same name get their own key and record', () => {
  const ctx = setup();
  try {
    const other = path.join(ctx.tmp, 'elsewhere', 'shop');
    fs.mkdirSync(other, { recursive: true });
    assert.notStrictEqual(rec.projectId(ctx.root), rec.projectId(other));
    rec.append(ctx.root, { kind: 'guard', summary: 'One.' }, ctx.opts);
    rec.append(other, { kind: 'guard', summary: 'Two.' }, ctx.opts);
    assert.notStrictEqual(rec.recordPath(ctx.root, ctx.opts), rec.recordPath(other, ctx.opts));
    assert.notStrictEqual(rec.buildExport(ctx.root, ctx.opts).key_fingerprint, rec.buildExport(other, ctx.opts).key_fingerprint);
    assert.strictEqual(rec.buildExport(other, ctx.opts).project, 'shop', 'the readable name is kept for display');
    assert.strictEqual(rec.readEntries(rec.recordPath(other, ctx.opts)).length, 1);
  } finally { ctx.cleanup(); }
});

test('a threat is fixed only when its own lockfile was read and is clean', () => {
  const ctx = setup();
  try {
    const threat = { ecosystem: 'npm', name: 'left-pad', version: '1.0.0', severity: 'high', lockfile: 'web/package-lock.json' };
    const scan = (lockfiles, affected, extra = {}) => rec.append(ctx.root, rec.entryFromWatch(ctx.root, { lockfiles: lockfiles.map((file) => ({ file })), affected, ...extra }, ctx.opts), ctx.opts);
    scan(['web/package-lock.json', 'package-lock.json'], [threat]);
    // The lockfile was removed: the threat was not checked, so it stays open.
    let e = scan(['package-lock.json'], []);
    assert.deepStrictEqual(e.findings, []);
    assert.strictEqual(e.counts.held, 1);
    // A side branch with the threat still live on the default branch: open.
    const id = e && rec.summarize(rec.readEntries(rec.recordPath(ctx.root, ctx.opts))).findings[0].id;
    e = rec.append(ctx.root, rec.entryFromWatch(ctx.root, { lockfiles: [{ file: 'web/package-lock.json' }], affected: [] }, { ...ctx.opts, branch: { onDefault: false, liveFingerprints: new Set([id]) } }), ctx.opts);
    assert.strictEqual(e.counts.held, 1);
    let s = rec.summarize(rec.readEntries(rec.recordPath(ctx.root, ctx.opts)));
    assert.strictEqual(s.open.high, 1);
    assert.strictEqual(s.fixed.high, 0);
    // Its own lockfile read on the default branch and clean: fixed.
    e = scan(['web/package-lock.json'], []);
    assert.deepStrictEqual(e.findings.map((f) => f.status), ['fixed']);
    s = rec.summarize(rec.readEntries(rec.recordPath(ctx.root, ctx.opts)));
    assert.strictEqual(s.open.high, 0);
    assert.strictEqual(s.fixed.high, 1);
  } finally { ctx.cleanup(); }
});
