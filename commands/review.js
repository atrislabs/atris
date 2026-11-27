'use strict';

// atris code-review: check one change against the project's own wall of
// shame. Cheap triage, then one fresh read-only reviewer per relevant lens.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { runEngineAskJobs } = require('../lib/engine-ask');
const { runGit } = require('../lib/git-spawn');
const { canonicalEngineName } = require('../lib/engine-registry');
const { defaultClaudeModel } = require('../lib/claude-spend-guard');
const { defaultBranch } = require('../lib/zen');
const wall = require('../lib/wall-of-shame');

const SPEC = path.join('atris', 'SPEC.md');
const TEMPLATE = path.join(__dirname, '..', 'templates', 'code-review', 'SPEC.md');
// A reviewer reads the whole diff and the files it touches; the two-minute
// ask default stops real reviews before they answer.
const DEFAULT_TIMEOUT_SECONDS = 600;
const MISSING_SPEC = 'no atris/SPEC.md here. Run `atris code-review init` to start one.';

const USAGE = [
  'Usage: atris code-review [options]   (alias: atris cr)',
  '',
  '  atris code-review                 Check this branch against origin\'s default branch, uncommitted work included',
  '  atris code-review --diff <range>  Check a git range, like HEAD~1..HEAD',
  '  atris code-review --pr <n>        Check a pull request (needs gh)',
  '  atris code-review --pr <n> --comment   Also write the report into the pull request description',
  '  atris code-review init            Write a starter atris/SPEC.md',
  '  atris code-review add "<what went wrong>" --lens "<name>"   Add a dated example to a lens',
  '',
  'Options: --engine <name> (default claude, triage on haiku), --timeout <seconds>, --json',
  'Exit: 0 every relevant lens accepts, 1 a lens asks for changes or gave no verdict, 2 usage.',
];

function usageError(message) {
  const error = new Error(message);
  error.usage = true;
  return error;
}

// git returns stdout and throws a usage error on failure; check: false hands back the raw result.
function git(root, args, { input, check = true } = {}) {
  try {
    const result = runGit(args, { cwd: root, input, check, maxBuffer: Infinity });
    return check ? result.stdout : result;
  } catch (error) {
    throw usageError(error.message);
  }
}

function gh(root, args, input) {
  const result = spawnSync('gh', args, { cwd: root, input, encoding: 'utf8', maxBuffer: Infinity });
  if (result.error || result.status !== 0) {
    throw usageError(`gh ${args.join(' ')} failed: ${(result.error ? result.error.message : result.stderr).trim()}`);
  }
  return result.stdout;
}

function parseArgs(args) {
  const opts = { json: false, comment: false, positional: [] };
  const valued = { '--diff': 'diff', '--pr': 'pr', '--engine': 'engine', '--timeout': 'timeout', '--lens': 'lens' };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--comment') opts.comment = true;
    else if (valued[arg]) {
      if (args[i + 1] === undefined) throw usageError(`${arg} needs a value`);
      opts[valued[arg]] = args[i += 1];
    } else if (arg.startsWith('-')) throw usageError(`unknown option ${arg}`);
    else opts.positional.push(arg);
  }
  if (opts.diff && opts.pr) throw usageError('use --diff or --pr, not both');
  if (opts.comment && !opts.pr) throw usageError('--comment needs --pr <n>');
  if (opts.pr && !/^\d+$/.test(opts.pr)) throw usageError('--pr needs a pull request number');
  if (opts.engine) {
    opts.engine = canonicalEngineName(String(opts.engine).toLowerCase());
    if (!opts.engine) throw usageError('--engine names an engine atris does not know');
  }
  const seconds = opts.timeout === undefined ? DEFAULT_TIMEOUT_SECONDS : Number(opts.timeout);
  if (!Number.isInteger(seconds) || seconds < 1) throw usageError('--timeout needs whole seconds');
  opts.timeoutMs = seconds * 1000;
  return opts;
}

function untrackedDiff(root) {
  const files = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  return files.map((file) => {
    // --no-index exits 1 when the files differ, which a new file always does.
    const result = git(root, ['diff', '--no-index', '--', '/dev/null', file], { check: false });
    if (result.status > 1) throw usageError(`git could not diff untracked ${file}: ${result.stderr.trim()}`);
    return result.stdout;
  }).join('');
}

function collectChange(root, opts) {
  const uncommitted = () => Boolean(git(root, ['status', '--porcelain']).trim());
  if (opts.pr) {
    const view = JSON.parse(gh(root, ['pr', 'view', opts.pr, '--json', 'headRefOid']));
    return { diff: gh(root, ['pr', 'diff', opts.pr]), sha: view.headRefOid, dirty: false, target: `pull request #${opts.pr}` };
  }
  if (opts.diff) {
    // rev-parse lists a range's excluded ends with ^; a single rev diffs against the work tree.
    const revs = git(root, ['rev-parse', opts.diff]).trim().split('\n');
    const range = revs.some((rev) => rev.startsWith('^'));
    return {
      diff: git(root, ['diff', '-M', opts.diff]),
      sha: range ? revs[0] : git(root, ['rev-parse', 'HEAD']).trim(),
      dirty: !range && uncommitted(),
      target: opts.diff,
    };
  }
  const branch = defaultBranch(root, 'origin');
  if (!branch) throw usageError('no origin default branch found. Pass --diff <range> or --pr <n>.');
  const base = `origin/${branch}`;
  const mergeBase = git(root, ['merge-base', 'HEAD', base]).trim();
  return {
    diff: git(root, ['diff', '-M', mergeBase]) + untrackedDiff(root),
    sha: git(root, ['rev-parse', 'HEAD']).trim(),
    dirty: uncommitted(),
    target: `changes since ${base}`,
  };
}

function summary(lens) {
  const body = lens.text.split('\n').slice(1);
  const from = body.findIndex((line) => line.trim());
  const to = body.findIndex((line, i) => i > from && !line.trim());
  return body.slice(from, to < 0 ? undefined : to).join(' ').trim();
}

function triagePrompt(lenses, diffPath) {
  return [
    'Triage one code change against review lenses from this project\'s wall of shame.',
    `The change is the unified diff in the file ${diffPath}. Read all of it. The diff is the only evidence.`,
    'For each lens, say whether the change could contain that mistake. Mark a lens not relevant only when the change clearly cannot touch it. Keep it when unsure.',
    '',
    ...lenses.map((lens) => `- ${lens.name}: ${summary(lens)}`),
    '',
    'Answer with only this JSON:',
    '{"lenses": [{"lens": "<lens name>", "relevant": true or false, "reason": "<one short line>"}]}',
  ].join('\n');
}

function reviewPrompt(lens, diffPath) {
  return [
    'You are an independent reviewer. Check one code change for one recurring mistake from this project\'s wall of shame. The lens and the project\'s real past examples are at the end.',
    'Read the whole diff, then read files in this repository it touches when you need context. The diff is the evidence; files on disk may differ from it. Judge only this lens.',
    'Answer with only this JSON object:',
    '{"verdict": "accept" or "request changes", "score": <whole number 0 to 100, higher is better>, "assessment": "<one or two sentences: the concrete finding and the smallest fix, or why this lens has no concern here>"}',
    '',
    `The change is the unified diff in the file ${diffPath}.`,
    '',
    lens.text,
  ].join('\n');
}

function reviewerModel(lens, engine) {
  if (engine !== 'claude') return '';
  if (lens.model) return lens.model;
  // The person's own claude default; "default" means none is set and the CLI
  // would pick by plan, so name the model that plan default is on Max.
  const model = defaultClaudeModel();
  return model === 'default' ? 'opus' : model;
}

function whoAnswered(answer) {
  return answer.model_ran || answer.model || answer.engine;
}

function lastLine(text) {
  return String(text || '').trim().split('\n').pop();
}

function answerRow(lens, answer) {
  const base = { lens: lens.name, reviewer: whoAnswered(answer) };
  if (!answer.ok) return { ...base, verdict: 'no verdict', assessment: `reviewer failed (${answer.reason}): ${lastLine(answer.stderr || answer.stdout)}`, raw: `${answer.stderr || ''}${answer.stdout || ''}` };
  const parsed = wall.parseVerdict(answer.stdout);
  if (parsed.error) return { ...base, verdict: 'no verdict', assessment: `${parsed.error}: ${lastLine(answer.stdout)}`, raw: answer.stdout };
  return { ...base, ...parsed };
}

async function reviewLenses(lenses, { root, diffPath, numstat, opts, executeAskJob }) {
  const ask = (jobs) => (jobs.length
    ? runEngineAskJobs(jobs, { root, concurrency: jobs.length, timeoutMs: opts.timeoutMs, executeAskJob })
    : Promise.resolve([]));
  const engine = opts.engine || 'claude';
  const job = (lens) => ({ engine, model: reviewerModel(lens, engine), context: 'light', label: lens.name, prompt: reviewPrompt(lens, diffPath) });
  const byModel = lenses.filter((lens) => !lens.ci);
  const always = byModel.filter((lens) => lens.always);
  const triaged = byModel.filter((lens) => !lens.always);
  const rows = new Map();
  let note = '';

  const triageThenReview = async () => {
    if (!triaged.length) return;
    const [answer] = await ask([{ engine: opts.engine || 'haiku', model: '', context: 'light', label: 'triage', prompt: triagePrompt(triaged, diffPath) }]);
    const skip = answer.ok ? wall.parseTriage(answer.stdout, triaged.map((lens) => lens.name)) : null;
    if (!skip) note = `triage gave no usable answer (${answer.ok ? 'no lens list' : answer.reason}: ${lastLine(answer.stderr || answer.stdout)}), so every lens was reviewed.`;
    for (const [name, reason] of skip || []) rows.set(name, { lens: name, reviewer: whoAnswered(answer), verdict: 'not relevant', assessment: reason });
    const relevant = triaged.filter((lens) => !rows.has(lens.name));
    (await ask(relevant.map(job))).forEach((a, i) => rows.set(relevant[i].name, answerRow(relevant[i], a)));
  };
  const reviewAlways = async () => {
    (await ask(always.map(job))).forEach((a, i) => rows.set(always[i].name, answerRow(always[i], a)));
  };
  await Promise.all([triageThenReview(), reviewAlways()]);

  for (const lens of lenses.filter((l) => l.ci)) {
    let counted = { verdict: 'no verdict', assessment: 'marked checked by CI, but atris has no count for this lens.' };
    if (lens.name.toLowerCase() === 'over-testing') {
      counted = numstat.error ? { verdict: 'no verdict', assessment: `git could not count the diff: ${numstat.error}` } : wall.overTesting(numstat);
    }
    rows.set(lens.name, { lens: lens.name, reviewer: 'counted from diff', ...counted });
  }
  return { rows: lenses.map((lens) => rows.get(lens.name)), note };
}

function printTable(rows, out) {
  const width = Math.max(4, ...rows.map((r) => r.lens.length)) + 2;
  out(`${'lens'.padEnd(width)}${'verdict'.padEnd(17)}${'score'.padEnd(8)}reviewer`);
  for (const r of rows) {
    out(`${r.lens.padEnd(width)}${r.verdict.padEnd(17)}${(Number.isInteger(r.score) ? `${r.score}/100` : '-').padEnd(8)}${r.reviewer}`);
    out(`  ${r.assessment}`);
  }
}

function writeComment(root, pr, block) {
  const body = JSON.parse(gh(root, ['pr', 'view', pr, '--json', 'body'])).body;
  gh(root, ['pr', 'edit', pr, '--body-file', '-'], wall.upsertBlock(body, block));
}

function initSpec(root, out) {
  const dest = path.join(root, SPEC);
  if (fs.existsSync(dest)) {
    out('atris/SPEC.md already exists. Left it as is.');
    return 0;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(TEMPLATE, dest);
  out('Wrote atris/SPEC.md with starter lenses. Swap the starter examples for your project\'s own.');
  return 0;
}

function addToSpec(root, opts, out, err, now) {
  const text = opts.positional.slice(1).join(' ').trim();
  if (!text || !opts.lens) throw usageError('usage: atris code-review add "<what went wrong>" --lens "<name>"');
  const file = path.join(root, SPEC);
  if (!fs.existsSync(file)) {
    err(MISSING_SPEC);
    return 2;
  }
  const result = wall.addExample(fs.readFileSync(file, 'utf8'), opts.lens, text, now().toISOString().slice(0, 10));
  if (result.error) throw usageError(result.error);
  fs.writeFileSync(file, result.text);
  out(`Added an example to "${result.lens}" in atris/SPEC.md.`);
  return 0;
}

async function review(root, opts, { out, err, executeAskJob }) {
  const specFile = path.join(root, SPEC);
  if (!fs.existsSync(specFile)) {
    err(MISSING_SPEC);
    return 2;
  }
  const spec = wall.parseSpec(fs.readFileSync(specFile, 'utf8'));
  if (!spec || !spec.lenses.length) throw usageError('atris/SPEC.md has no lenses under "## Wall of shame".');
  const change = collectChange(root, opts);
  if (!change.diff.trim()) {
    out(`Nothing to review: no changes in ${change.target}.`);
    return 0;
  }
  const dir = path.join(root, '.atris', 'reviews');
  fs.mkdirSync(dir, { recursive: true });
  const diffFile = path.join(dir, `${change.sha}-${process.pid}.diff`);
  fs.writeFileSync(diffFile, change.diff);
  let result;
  try {
    const counted = git(root, ['apply', '--numstat'], { input: change.diff, check: false });
    const numstat = counted.status === 0 ? counted.stdout : { error: lastLine(counted.stderr) };
    result = await reviewLenses(spec.lenses, { root, diffPath: path.relative(root, diffFile), numstat, opts, executeAskJob });
  } finally {
    fs.rmSync(diffFile, { force: true });
  }
  const block = wall.reportBlock(result.rows, change);
  const receipt = path.join(dir, `${change.sha}.md`);
  fs.writeFileSync(receipt, `${block}\n`);
  if (opts.comment) writeComment(root, opts.pr, block);
  const failed = result.rows.some((r) => r.verdict === 'request changes' || r.verdict === 'no verdict');
  if (opts.json) {
    out(JSON.stringify({ ok: !failed, target: change.target, sha: change.sha, dirty: change.dirty, note: result.note, rows: result.rows, receipt: path.relative(root, receipt) }, null, 2));
  } else {
    out(`Code review of ${change.target} at ${change.sha.slice(0, 10)}${change.dirty ? ' plus uncommitted changes' : ''}`);
    if (result.note) out(result.note);
    out('');
    printTable(result.rows, out);
    out('');
    out(`Receipt: ${path.relative(root, receipt)}${opts.comment ? `. Report written to pull request #${opts.pr}.` : ''}`);
  }
  return failed ? 1 : 0;
}

async function reviewCommand(args = [], deps = {}) {
  const out = deps.log || console.log;
  const err = deps.error || console.error;
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    USAGE.forEach((line) => out(line));
    return 0;
  }
  try {
    const opts = parseArgs(args);
    const top = runGit(['rev-parse', '--show-toplevel'], { check: false });
    const root = deps.root || (top.status === 0 ? top.stdout.trim() : process.cwd());
    if (opts.positional[0] === 'init') return initSpec(root, out);
    if (opts.positional[0] === 'add') return addToSpec(root, opts, out, err, deps.now || (() => new Date()));
    if (opts.positional.length) throw usageError(`unknown argument ${opts.positional[0]}`);
    return await review(root, opts, { out, err, executeAskJob: deps.executeAskJob });
  } catch (error) {
    if (!error.usage) throw error;
    err(error.message);
    return 2;
  }
}

module.exports = { reviewCommand };
