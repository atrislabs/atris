'use strict';

// atris sentinel fix [finding-id|--all-open] [path]
//
// Turns a confirmed sentinel finding into a reviewed fix on its own branch.
// The work lives in lib/sentinel-fix.js; this file reads flags, prices atris
// model calls before any spend, prints the landing and sends one event.

const fs = require('fs');
const path = require('path');

function tildePath(p, home = require('os').homedir()) {
  return p && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function parseFixArgs(argv) {
  const opts = { positionals: [], allOpen: false, verify: null, builder: null, verifier: null, engine: null, yes: false, pr: false, upload: null, timeoutMs: null };
  const takes = (i, flag) => {
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, null];
    const value = () => (inline !== null ? inline : takes(i++, flag));
    if (flag === '--all-open') opts.allOpen = true;
    else if (flag === '--verify') opts.verify = value();
    else if (flag === '--builder') opts.builder = value();
    else if (flag === '--verifier') opts.verifier = value();
    else if (flag === '--engine') opts.engine = value();
    else if (flag === '--yes' || flag === '-y') opts.yes = true;
    else if (flag === '--pr') opts.pr = true;
    else if (flag === '--no-upload') opts.upload = false;
    else if (flag === '--upload') opts.upload = true;
    else if (flag === '--timeout') opts.timeoutMs = Number(value()) * 1000;
    else if (arg.startsWith('-')) throw new Error(`unknown flag: ${arg}`);
    else opts.positionals.push(arg);
  }
  if (opts.engine !== null && !['atris', 'local'].includes(opts.engine)) throw new Error('--engine must be atris or local');
  if (opts.timeoutMs !== null && (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 10000)) throw new Error('--timeout is in seconds, at least 10');
  if (opts.verify !== null && !opts.verify.trim()) throw new Error('--verify needs a command');
  // fix <id> <path>, fix <path>, fix <id>, fix --all-open <path>
  const [a, b] = opts.positionals;
  if (opts.positionals.length > 2) throw new Error('give at most a finding id and a path');
  if (opts.allOpen) {
    if (opts.positionals.length > 1) throw new Error('--all-open takes only a path');
    opts.path = a || null;
  } else if (opts.positionals.length === 2) {
    opts.id = a;
    opts.path = b;
  } else if (a !== undefined) {
    let isDir = false;
    try { isDir = fs.statSync(a).isDirectory(); } catch {}
    if (isDir) opts.path = a; else opts.id = a;
  }
  return opts;
}

function printFixHelp() {
  console.log(`
  atris sentinel fix, a reviewed fix for a confirmed finding

    atris sentinel fix                       list confirmed findings you can fix
    atris sentinel fix <id> [path]           fix one finding on its own branch
    atris sentinel fix --all-open [path]     fix every finding with no fix branch yet
    atris sentinel fix <id> --verify "make test"
                                             run this test command (default: npm test,
                                             pytest or go test, whichever the repo uses)
    atris sentinel fix <id> --builder claude --verifier codex
                                             which engine writes the fix and which checks it
    atris sentinel fix <id> --engine atris   atris models write and check, after a price
    atris sentinel fix <id> --pr             push the branch and open a pull request

  it needs a clean working tree. the fix is built in a temp copy on a new
  branch named sentinel/fix-<id> made from the branch you are on. your own
  checkout and branch are never changed. nothing is merged. nothing is
  pushed unless you add --pr.

  builder and checker may be codex, claude or an atris model. atris models
  always show a price and wait for a yes.

  a fix is committed only when all three hold:
    the new test fails on the old code
    the full test suite passes with the fix
    a second engine reads the fixed source and finds the attack no longer works

  the new test must fail on a real failed check. a missing module, a syntax
  error or a timeout does not count. otherwise nothing is committed and the
  attempt is saved as a patch under ~/.atris/sentinel/fixes.

  the new tests run with a temp home, no tokens or keys in the environment
  and push turned off for the temp copy. they still run as you and are not a
  sandbox. read the new test before you run it on code you do not trust.
`);
  return 0;
}

function askYesNo(question, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve) => {
    const rl = require('readline').createInterface({ input, output });
    rl.question(question, (answer) => { rl.close(); resolve(/^\s*y(es)?\s*$/i.test(String(answer || ''))); });
  });
}

function sevOf(r) {
  return (r.severity && r.severity.overall) || 'unrated';
}

async function fixCommand(argv, deps = {}) {
  if (argv[0] === 'help' || argv.includes('--help') || argv.includes('-h')) return printFixHelp();
  const fix = deps.fixLib || require('../lib/sentinel-fix');
  const env = deps.env || process.env;
  let opts;
  try { opts = parseFixArgs(argv); } catch (e) { console.error(`  ${e.message}`); return 2; }

  const start = path.resolve(opts.path || deps.root || process.cwd());
  const top = fix.git(start, ['rev-parse', '--show-toplevel'], { allowFail: true });
  if (!top) { console.error(`  ${tildePath(start)} is not a git repository. a fix needs a branch to go on`); return 2; }
  const root = top;
  require('../lib/sentinel-cloud').keepProjectClean(root);

  const { records, system, dir } = fix.confirmedFindings(root);
  if (system) {
    const names = system.parts.map((p) => p.name);
    console.log(`\n  the last review of this repository read ${names.length} places together (${names.join(', ')}), with this one as the ${system.part} part. it has ${system.confirmed} confirmed finding${system.confirmed === 1 ? '' : 's'}.`);
    console.log('  fix works on a review of one folder for now, so nothing was changed.');
    console.log(`  the findings are in ${tildePath(path.join(dir, 'REPORT.md'))}. to fix one here, review this folder alone first: atris sentinel\n`);
    return opts.id || opts.allOpen ? 2 : 0;
  }
  if (!records.length) {
    if (!dir) console.log('\n  no review of this project yet. run atris sentinel first, then come back here\n');
    else console.log('\n  the last review has no confirmed problems, so there is nothing to fix.\n  a possible problem that is not double-checked yet cannot be fixed. run atris sentinel again to check it\n');
    return 0;
  }

  if (!opts.id && !opts.allOpen) {
    const rank = { critical: 0, high: 1, medium: 2, low: 3, informational: 4 };
    const sorted = [...records].sort((a, b) => (rank[sevOf(a)] ?? 5) - (rank[sevOf(b)] ?? 5));
    console.log('\n  confirmed problems you can fix, worst first\n');
    const open = [];
    for (const r of sorted) {
      const branch = fix.branchFor(r);
      const has = fix.branchExists(root, branch);
      if (!has) open.push(r);
      console.log(`  ${fix.shortId(r.fingerprint)}  ${sevOf(r).padEnd(8)}  ${r.title}${has ? `  (fix ready: ${branch})` : ''}`);
    }
    if (open.length) {
      console.log(`\n  fix one with: atris sentinel fix ${fix.shortId(open[0].fingerprint)}`);
      console.log('  it writes the fix and a test that proves the hole is closed, on a new branch.');
      console.log('  nothing goes into your code until you merge that branch.\n');
    } else {
      console.log('\n  every problem here has a fix ready. take one with git merge <branch>, or say no with git branch -D <branch>\n');
    }
    return 0;
  }

  let targets;
  if (opts.allOpen) {
    targets = records.filter((r) => !fix.branchExists(root, fix.branchFor(r)));
    if (!targets.length) { console.log('\n  every confirmed finding already has a fix branch\n'); return 0; }
  } else {
    const r = fix.matchFinding(records, opts.id);
    if (!r) { console.error(`  no confirmed finding matches ${opts.id}. run atris sentinel fix to list them`); return 2; }
    targets = [r];
  }

  if (fix.changedPaths(root).length) { console.error('  this repository has uncommitted changes. commit or stash them first so the fix branch holds only the fix'); return 2; }
  const from = fix.git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true });
  if (!from || from === 'HEAD') { console.error('  check out a branch first. a fix branch is made from the branch you are on'); return 2; }

  const testCommand = opts.verify || fix.detectTestCommand(root);
  if (!testCommand) {
    console.error('  a fix is kept only when a new test proves the hole is closed, so sentinel needs to run your tests.');
    const example = fs.existsSync(path.join(root, 'package.json')) ? 'node --test' : fs.existsSync(path.join(root, 'go.mod')) ? 'go test ./...' : 'pytest';
    console.error('  it could not tell how. name the command that runs them, for example:');
    console.error(`    atris sentinel fix ${opts.id || '<id>'} --verify "${example}"`);
    return 2;
  }

  let engines;
  try { engines = fix.resolveFixEngines({ engine: opts.engine, builder: opts.builder, verifier: opts.verifier, env, available: deps.available }); } catch (e) { console.error(`  ${e.message}`); return 2; }

  const cloud = deps.cloud || require('../lib/sentinel-cloud');
  const hosted = fix.isHosted(engines.builder) || fix.isHosted(engines.verifier);
  const token = deps.token !== undefined ? deps.token : cloud.authToken();
  let hostedRun = deps.hostedRun || null;
  let allowed = new Set();
  if (hosted) {
    if (!token) { console.error('  fixes on atris models need a login. run atris login first'); return 2; }
    allowed = require('../lib/security-audit').hostedAllowedFiles(root, []);
    const rows = [];
    if (fix.isHosted(engines.builder)) {
      const sizes = targets.map((r) => Buffer.byteLength(fix.builderPrompt(r, { testCommand, hosted: true, others: records, fileList: [...allowed].slice(0, 400), source: fix.hostedSourceBlock(root, fix.citedFiles(r), allowed, 64 * 1024) })));
      const max = Math.max(4096, ...sizes) + 1024;
      rows.push({ role: 'builder', model: engines.builder, calls: targets.length, input_tokens: max, output_tokens: fix.HOSTED_OUTPUT_TOKENS.builder, max_input_bytes: max });
    }
    if (fix.isHosted(engines.verifier)) rows.push({ role: 'verifier', model: engines.verifier, calls: targets.length, input_tokens: fix.HOSTED_CHECK_MAX_BYTES, output_tokens: fix.HOSTED_OUTPUT_TOKENS.verifier, max_input_bytes: fix.HOSTED_CHECK_MAX_BYTES });
    let quote;
    try { quote = await cloud.quoteEstimate({ calls: rows }, { token }); } catch (e) { console.error(`  nothing was spent. ${e.message}`); return 2; }
    console.log(`\n  ${cloud.describeQuote(quote).replace(/^this review/, 'this fix')}\n`);
    let yes = opts.yes;
    if (!yes) {
      const input = deps.input || process.stdin;
      if (!input.isTTY && !deps.input) { console.error('  nothing was spent. add --yes to run without this question'); return 1; }
      yes = await (deps.ask || askYesNo)('  spend these credits? (y/N) ', { input, output: process.stdout });
      if (!yes) { console.log('  nothing was spent'); return 1; }
    }
    if (!hostedRun) {
      const spend = cloud.spendGuard({ quoteCall: deps.quoteCall });
      spend.max = quote.credits;
      spend.limits = quote.limits;
      const runner = cloud.atrisJobRunner({ token, spend });
      hostedRun = (jobs) => runner(jobs, { root, concurrency: 1, timeoutMs: opts.timeoutMs || 20 * 60 * 1000 });
    }
  }

  const log = deps.log || ((m) => console.log(`  · ${m}`));
  const ctx = {
    from,
    testCommand,
    others: records,
    engines,
    env,
    allowed,
    hostedRun,
    runBuilder: deps.runBuilder || fix.defaultRunBuilder,
    runChecker: deps.runChecker || fix.defaultRunChecker,
    copyDependencies: deps.copyDependencies,
    timeouts: { build: opts.timeoutMs || 20 * 60 * 1000, check: opts.timeoutMs || 10 * 60 * 1000, test: 20 * 60 * 1000 },
    log,
  };

  console.log(`\n  ◉ sentinel fix · ${engines.builder} writes the fix · ${engines.verifier} checks it · tests: ${testCommand}`);
  if (engines.same) console.log(`  only ${engines.builder} is ready on this computer, so it also checks its own fix, in a fresh session. a second tool makes that check stronger`);
  console.log('  this takes a few minutes. your own branch and files are not touched');
  const results = [];
  for (const record of targets) {
    console.log(`\n  ${fix.shortId(record.fingerprint)} · ${record.title}`);
    const res = await fix.fixOne(root, record, ctx);
    results.push({ record, res });
    if (res.ok) {
      console.log(`  prepared a fix on a new branch: ${res.branch}`);
      console.log(`  the new test failed on the old code and passes with the fix. the full test suite passes. ${engines.verifier} checked from source that the attack no longer works`);
      console.log(`  review it with: git diff ${from}...${res.branch}`);
      if (opts.pr) {
        const pr = fix.openPr(root, res, record, { run: deps.run, verifier: engines.verifier });
        res.pr = pr;
        if (pr.ok) console.log(`  opened a pull request${pr.url ? `: ${pr.url}` : ''}. nothing was merged`);
        else console.log(`  no pull request was opened: ${pr.reason}${pr.pushed ? '' : '. nothing was pushed'}`);
      } else {
        console.log('  nothing was pushed');
      }
      if (res.pr && res.pr.ok) console.log('  to take it, merge the pull request. to say no, close it');
      else {
        console.log(`  to take it: git merge ${res.branch}`);
        console.log(`  to say no:  git branch -D ${res.branch}`);
      }
    } else {
      console.log(`  no fix was committed: ${res.reason}`);
      if (res.branch === null || res.branch === undefined) console.log(`  you are on ${from}. nothing in your project changed${res.patch ? `. the attempt is saved at ${tildePath(res.patch, env.HOME || undefined)}` : ''}`);
      if (res.test_output) console.log(`  what the tests printed: ${tildePath(res.test_output, env.HOME || undefined)}`);
      // A refusal is a dead end without a next step.
      if (records.length > 1) console.log(`  if that reason points at another problem on the list, fix that one first (atris sentinel fix), then try this one again`);
      console.log(`  try again with: atris sentinel fix ${fix.shortId(record.fingerprint)}`);
      // A tool that stopped or wrote nothing may simply decline this one; the other may not.
      const otherTool = { codex: 'claude', claude: 'codex' }[engines.builder];
      if (otherTool && !engines.same && /the builder (stopped|changed nothing)/.test(res.reason || '')) {
        console.log(`  or let the other tool write it: atris sentinel fix ${fix.shortId(record.fingerprint)} --builder ${otherTool} --verifier ${engines.builder}`);
      }
    }
  }

  {
    const rec = require('../lib/sentinel-record');
    const o = { recordHome: deps.recordHome, homeDir: deps.homeDir, env: deps.env, record: deps.record };
    let r;
    try { r = rec.appendSafe(root, results.map((x) => rec.entryFromFix(x.record, x.res)), o); } catch (e) { r = { ok: false, reason: e.message }; }
    const w = rec.warnLine(r);
    if (w) console.log(w);
  }
  const done = results.filter((x) => x.res.ok);
  if (done.length) {
    const events = require('../lib/sentinel-events');
    let upload;
    const consent = token ? await require('../lib/sentinel-consent').uploadConsent(opts.upload, { token, deps, tell: (m) => console.log(m) }) : null;
    if (opts.upload === false || (consent && !consent.upload)) upload = { skipped: 'no-upload' };
    else if (!token) upload = { skipped: 'not-logged-in' };
    else {
      try { upload = await events.postEvents(done.map((x) => fix.fixEvent(root, x.record, x.res)), { token, base: deps.base }); } catch (e) { upload = { ok: false, reason: e.message }; }
    }
    if (upload.skipped === 'no-upload') console.log('\n  kept on this machine. nothing was sent to your dashboard');
    else if (upload.skipped === 'not-logged-in') console.log('\n  not logged in. nothing was sent to your dashboard');
    else if (!upload.ok) console.log(`\n  warning: could not tell your atris dashboard: ${upload.reason}. the fix itself is done`);
    else console.log('\n  told your atris dashboard. no code was sent');
  }
  console.log('');
  return results.every((x) => x.res.ok) ? 0 : 1;
}

module.exports = { fixCommand, parseFixArgs };
