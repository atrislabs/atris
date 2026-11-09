'use strict';

// atris sentinel record: the signed security record a reviewer can check.
//
//   atris sentinel record [show] [path]               plain summary
//   atris sentinel record key [path]                  public key and fingerprint
//   atris sentinel record export [path] --out FILE [--json]
//   atris sentinel record verify FILE                 offline check of an export
//   atris sentinel record backfill [path]             add past review runs, marked as added later
//
// The guarantee and its limits sit at the top of lib/sentinel-record.js.

const fs = require('fs');
const path = require('path');

function help() {
  console.log(`
  atris sentinel record, a signed security record you can hand to a reviewer

    atris sentinel record [path]                 what sentinel checked, what is open and fixed
    atris sentinel record key [path]             this project's public key and its fingerprint
    atris sentinel record export [path] --out record.html
                                                 one html file a reviewer opens and checks in the browser
    atris sentinel record export [path] --out record.json --json
    atris sentinel record verify FILE            check an exported record offline
    atris sentinel record backfill [path]        add past reviews, marked as added later with their dates

  every review, recheck, agent check, watch, guard status and fix adds an
  entry. each entry holds the hash of the one before it and is signed with
  a key kept in ~/.atris. an edited, moved or removed entry shows.

  what it proves: the record came from this key and was not changed.
  what it does not prove: that the checks were thorough or the code is safe.
  entries hold plain sentences, counts, file:line places and short ids only.
`);
  return 0;
}

function parse(argv) {
  const opts = { paths: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') { opts.out = argv[++i]; if (!opts.out) throw new Error('--out needs a file'); }
    else if (a === '--json') opts.json = true;
    else if (a.startsWith('-')) throw new Error(`unknown flag: ${a}`);
    else opts.paths.push(a);
  }
  return opts;
}

function rootOf(opts, deps) {
  const root = path.resolve(opts.paths[0] || deps.root || process.cwd());
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`${root} is not a folder`);
  return root;
}

function libOpts(deps) {
  const o = {};
  if (deps.recordHome) o.recordHome = deps.recordHome;
  if (deps.homeDir) o.homeDir = deps.homeDir;
  if (deps.env) o.env = deps.env;
  if (deps.now) o.now = deps.now;
  return o;
}

async function recordCommand(argv = [], deps = {}) {
  const rec = require('../lib/sentinel-record');
  const known = ['show', 'key', 'export', 'verify', 'backfill', 'help'];
  const sub = known.includes(argv[0]) ? argv[0] : 'show';
  const rest = known.includes(argv[0]) ? argv.slice(1) : argv;
  if (sub === 'help' || rest.includes('--help') || rest.includes('-h')) return help();
  let opts;
  try { opts = parse(rest); } catch (e) { console.error(`  ${e.message}`); return 2; }
  const lo = libOpts(deps);

  if (sub === 'verify') {
    const file = opts.paths[0];
    if (!file) { console.error('  name the exported file: atris sentinel record verify FILE'); return 2; }
    let doc;
    try { doc = rec.readExport(path.resolve(file)); } catch (e) { console.error(`  could not read ${file}: ${e.message}`); return 2; }
    const r = rec.verifyDoc(doc);
    if (opts.json) { console.log(JSON.stringify(r, null, 2)); return r.ok ? 0 : 1; }
    if (r.ok) {
      console.log(`  verified: all ${r.entries} entries for ${doc.project} are signed by key ${r.fingerprint}`);
      console.log('  none were changed, moved or removed. compare the fingerprint with the one the company gave you');
      return 0;
    }
    console.log(`  broken at ${r.label}: ${r.reason}`);
    return 1;
  }

  let root;
  try { root = rootOf(opts, deps); } catch (e) { console.error(`  ${e.message}`); return 2; }
  const project = rec.projectName(root);

  if (sub === 'key') {
    let key;
    try { key = rec.loadKey(project, lo); } catch (e) { console.error(`  could not open the record key: ${e.message}`); return 1; }
    if (opts.json) { console.log(JSON.stringify({ project, public_key: key.publicKey, fingerprint: key.fingerprint }, null, 2)); return 0; }
    console.log(`\n  record key for ${project}${key.created ? ' (made just now)' : ''}`);
    console.log(`  public key: ${key.publicKey}`);
    console.log(`  fingerprint: ${key.fingerprint}`);
    console.log('  give the fingerprint to reviewers through a channel they trust. the private key stays in ~/.atris\n');
    return 0;
  }

  if (sub === 'backfill') {
    let res;
    try { res = rec.backfill(root, lo); } catch (e) { console.error(`  could not backfill the record: ${e.message}`); return 1; }
    console.log(`  added ${res.added.length} past run${res.added.length === 1 ? '' : 's'} to the record, each marked as added later with its original date`);
    if (res.skipped.length) console.log(`  ${res.skipped.length} already in the record or unreadable`);
    return 0;
  }

  if (sub === 'export') {
    if (!opts.out) { console.error('  name the output file: atris sentinel record export --out record.html'); return 2; }
    let doc;
    try { doc = rec.buildExport(root, lo); } catch (e) { console.error(`  could not export the record: ${e.message}`); return 1; }
    const out = path.resolve(opts.out);
    const body = opts.json ? `${JSON.stringify(doc, null, 2)}\n` : rec.renderHtml(doc);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, body);
    console.log(`  wrote ${doc.entries.length} signed entries to ${out}`);
    console.log(`  key fingerprint: ${doc.key_fingerprint}`);
    console.log(opts.json ? '  check it with: atris sentinel record verify FILE' : '  a reviewer opens it in a browser. it checks itself and shows verified or broken');
    return 0;
  }

  // show
  let entries;
  try { entries = rec.readEntries(rec.recordPath(root, lo)); } catch (e) { console.error(`  could not read the record: ${e.message}`); return 1; }
  const key = rec.loadKey(project, { ...lo, create: false });
  if (opts.json) { console.log(JSON.stringify({ project, key_fingerprint: key ? key.fingerprint : null, ...rec.summarize(entries) }, null, 2)); return 0; }
  console.log(rec.renderShow(project, entries, key));
  return 0;
}

module.exports = { recordCommand };
