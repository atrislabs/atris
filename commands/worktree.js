'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { stampLatestOpenBriefForWorktree } = require('../lib/brief-ledger');

const REGEN_ADAPTER_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];
const COMMAND_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

function runGit(args, { cwd = process.cwd(), check = true } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (check && result.status !== 0) {
    const msg = (result.stderr || result.stdout || `git ${args.join(' ')} failed`).trim();
    throw new Error(msg);
  }
  return result;
}

function runCommand(command, { cwd = process.cwd(), check = true } = {}) {
  const result = spawnSync(command, {
    cwd,
    encoding: 'utf8',
    shell: true,
    stdio: 'pipe',
    maxBuffer: COMMAND_MAX_BUFFER_BYTES,
  });
  if (result.error) throw result.error;
  if (check && result.status !== 0) {
    const msg = (result.stderr || result.stdout || `${command} failed`).trim();
    throw new Error(msg);
  }
  return result;
}

function repoRoot(cwd = process.cwd()) {
  return runGit(['rev-parse', '--show-toplevel'], { cwd }).stdout.trim();
}

function slugify(value, fallback = 'task', limit = 48) {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, limit)
    .replace(/-+$/g, '');
  return slug || fallback;
}

function stamp(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
}

function branchName(member, task, now = new Date()) {
  return `codex/${slugify(member, 'member', 24)}-${slugify(task, 'task', 36)}-${stamp(now)}`;
}

function defaultWorktreePath(root, member, task, now = new Date()) {
  const name = `${slugify(member, 'member', 24)}-${slugify(task, 'task', 36)}-${stamp(now)}`;
  return path.join(path.dirname(root), '.agent-worktrees', path.basename(root), name);
}

function parseWorktrees(text) {
  const out = [];
  let current = {};
  for (const raw of `${text}\n`.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      if (current.worktree) {
        let branch = current.branch || 'detached';
        branch = branch.replace(/^refs\/heads\//, '');
        const item = { path: current.worktree, branch, head: current.HEAD || '' };
        if (current.locked) item.locked = true;
        if (current.prunable) item.prunable = true;
        out.push(item);
      }
      current = {};
      continue;
    }
    const idx = line.indexOf(' ');
    if (idx === -1) {
      current[line] = true;
    } else {
      current[line.slice(0, idx)] = line.slice(idx + 1);
    }
  }
  return out;
}

function listWorktrees(root = repoRoot()) {
  return parseWorktrees(runGit(['worktree', 'list', '--porcelain'], { cwd: root }).stdout);
}

function refExists(root, ref) {
  return runGit(['rev-parse', '--verify', `${ref}^{commit}`], { cwd: root, check: false }).status === 0;
}

function currentBranch(root = repoRoot()) {
  return runGit(['branch', '--show-current'], { cwd: root, check: false }).stdout.trim();
}

function detachedShipBranch(root) {
  return `codex/${path.basename(root)}`;
}

function createDetachedShipBranch(root, branch) {
  if (refExists(root, `refs/heads/${branch}`) || refExists(root, `refs/remotes/origin/${branch}`)) {
    console.error(`blocked: detached head branch already exists: ${branch}`);
    return false;
  }
  const created = runGit(['switch', '-c', branch], { cwd: root, check: false });
  if (created.status !== 0) {
    console.error(`blocked: detached head branch create failed: ${branch}`);
    console.error((created.stderr || created.stdout || '').trim());
    return false;
  }
  console.log(`ship: detached head, created branch ${branch}`);
  return true;
}

function currentUpstream(root) {
  const result = runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd: root, check: false });
  return result.status === 0 ? result.stdout.trim() : '';
}

function remoteHead(root) {
  const result = runGit(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd: root, check: false });
  return result.status === 0 ? result.stdout.trim() : '';
}

function normalizeTargetRef(root, target) {
  const value = String(target || '').trim();
  if (!value) return '';
  const remotes = runGit(['remote'], { cwd: root, check: false }).stdout.split(/\r?\n/);
  const preferRemote =
    !value.startsWith('origin/') &&
    !value.startsWith('refs/') &&
    value !== 'HEAD' &&
    !/^[0-9a-f]{7,40}$/i.test(value) &&
    remotes.includes('origin');
  const remoteRef = value.startsWith('origin/') ? value : `origin/${value}`;
  if (preferRemote && refExists(root, remoteRef)) return remoteRef;
  if (preferRemote) return remoteRef;
  if (refExists(root, value)) return value;
  if (refExists(root, remoteRef)) return remoteRef;
  if (value.startsWith('origin/') || remotes.includes('origin')) return remoteRef;
  return value;
}

function defaultMainlineBase(root) {
  const head = remoteHead(root);
  if (head && refExists(root, head)) return head;
  for (const candidate of ['origin/master', 'origin/main']) {
    if (refExists(root, candidate)) return candidate;
  }
  return 'HEAD';
}

function defaultStartBase(root) {
  const upstream = currentUpstream(root);
  const mainline = defaultMainlineBase(root);
  // Always refresh before cutting a worktree: a stale origin/master base sent
  // an engine off to rebuild work that had already landed (2026-07-09, packs
  // one-click flight rebuilt the stars backend from a base two PRs behind).
  refreshRemoteRef(root, mainline);
  if (!upstream || !refExists(root, upstream)) return mainline;
  if (mainline === 'HEAD' || mainline === upstream) return upstream;
  // A launcher upstream that is behind the mainline is a stale cut point
  // (2026-07-05: a stale origin/task branch sent two flights into rebase
  // conflicts). Start from the mainline unless the upstream carries new work.
  refreshRemoteRef(root, upstream);
  const behind = runGit(['merge-base', '--is-ancestor', upstream, mainline], { cwd: root, check: false });
  return behind.status === 0 ? mainline : upstream;
}

function defaultShipTarget(root) {
  const branch = currentBranch(root);
  if (branch) {
    const configured = runGit(['config', '--get', `branch.${branch}.atris-base`], { cwd: root, check: false }).stdout.trim();
    if (configured && refExists(root, configured)) return configured;
  }
  const head = remoteHead(root);
  if (head && refExists(root, head)) return head;
  for (const candidate of ['origin/master', 'origin/main']) {
    if (refExists(root, candidate)) return candidate;
  }
  return 'HEAD';
}

function refreshRemoteRef(root, ref) {
  if (!ref.startsWith('origin/')) return;
  const remoteBranch = ref.slice('origin/'.length);
  runGit(['fetch', 'origin', remoteBranch], { cwd: root, check: false });
}

function baseBranchName(ref) {
  return String(ref || '').replace(/^refs\/heads\//, '').replace(/^origin\//, '');
}

function statusCounts(root, { ignoredUnstagedFiles = new Set(), ignoredUntrackedFiles = new Set() } = {}) {
  if (!fs.existsSync(root)) return null;
  // -uall expands untracked directories to individual files so ignoredUntrackedFiles
  // can match exact paths (plain porcelain collapses them to "?? dir/").
  const statusArgs = ignoredUntrackedFiles.size ? ['status', '--porcelain', '-uall'] : ['status', '--porcelain'];
  const result = runGit(statusArgs, { cwd: root, check: false });
  if (result.status !== 0) return null;
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
    const file = line.slice(3);
    if (ignoredUnstagedFiles.has(file) && line[0] === ' ' && line[1] !== ' ') continue;
    if (line.startsWith('??')) {
      if (ignoredUntrackedFiles.has(file)) continue;
      untracked += 1;
      continue;
    }
    if (line[0] !== ' ') staged += 1;
    if (line[1] !== ' ') unstaged += 1;
  }
  return { staged, unstaged, untracked };
}

function changedFiles(root, args) {
  const result = runGit([...args, '--', ...REGEN_ADAPTER_FILES], { cwd: root, check: false });
  if (result.status !== 0) return new Set();
  return new Set(result.stdout.split(/\r?\n/).filter(Boolean));
}

function restoreRegeneratedAdapterChurn(root, message, { dryRun = false } = {}) {
  const unstaged = changedFiles(root, ['diff', '--name-only']);
  const staged = changedFiles(root, ['diff', '--cached', '--name-only']);
  const commitMessage = String(message || '');
  const skipped = REGEN_ADAPTER_FILES.filter(
    (file) => unstaged.has(file) && !staged.has(file) && !commitMessage.includes(file)
  );
  if (!skipped.length) return [];
  console.log(`ship: skipped regenerated adapter churn: ${skipped.join(', ')}`);
  if (!dryRun) runGit(['checkout', '--', ...skipped], { cwd: root });
  return skipped;
}

function readFlag(args, name, fallback = '') {
  const prefix = `${name}=`;
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (arg === name && args[i + 1] && !String(args[i + 1]).startsWith('--')) return String(args[i + 1]);
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return fallback;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function swarloClaim(root, { channel, taskKey, content }) {
  const script = path.join(root, 'scripts', 'swarlo.py');
  if (!fs.existsSync(script)) return 'skip: scripts/swarlo.py not found';
  const result = spawnSync('python3', [script, 'claim', channel, taskKey, content], { cwd: root, encoding: 'utf8' });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (result.status === 0) return output || `claimed ${taskKey}`;
  return `skip: swarlo claim failed: ${output || result.status}`;
}

function printStatus() {
  const root = repoRoot();
  const worktrees = listWorktrees(root);
  const primary = worktrees[0]?.path;
  for (const wt of worktrees) {
    const counts = statusCounts(wt.path);
    const tags = [];
    if (wt.path === primary) tags.push('primary');
    if (path.resolve(wt.path) === path.resolve(root)) tags.push('current');
    const tagText = tags.length ? ` [${tags.join(' ')}]` : '';
    if (!counts) {
      console.log(`${wt.path}${tagText} branch=${wt.branch} missing=true`);
      continue;
    }
    console.log(`${wt.path}${tagText} branch=${wt.branch} staged=${counts.staged} unstaged=${counts.unstaged} untracked=${counts.untracked}`);
  }
}

// Programmatic core shared by `atris worktree start` and `atris mission start
// --worktree`: creates the branch + isolated checkout + identity sidecar and
// returns the facts. Throws on failure; callers own messaging and next steps.
//
// checkoutBase (what the branch is cut from) and shipBase (what `atris
// worktree ship` targets, recorded as branch.<branch>.atris-base) are kept
// separate on purpose. checkoutBase defaults to the launcher's own
// upstream/default remote base, so the agent starts from current work.
// shipBase defaults to origin/master for agent/member worktrees regardless of
// what branch the launcher happened to have checked out. recording the
// launcher's own feature branch as the ship target false-landed two PRs on
// 2026-07-04 (ship merged into the launcher's branch, never reached master).
// --base/--target still overrides both when the caller wants a different
// checkout point and ship target on purpose.
function createAgentWorktree({ root = repoRoot(), member = '', agent = '', task, branch: branchOverride, path: pathOverride, base: baseOverride, now = new Date() } = {}) {
  const owner = member || agent;
  if (!owner || !task) throw new Error('createAgentWorktree: owner (member/agent) and task required');
  const branch = branchOverride || branchName(owner, task, now);
  const target = path.resolve(pathOverride || defaultWorktreePath(root, owner, task, now));
  const explicitBase = Boolean(baseOverride);
  // Agent/member worktrees always cut from the mainline: honoring the
  // launcher checkout's upstream let a dispatch inherit another session's
  // in-progress feature branch (2026-07-09: an auth fix arrived carrying 13
  // unpushed commits from a parallel session and could not merge).
  const checkoutBase = normalizeTargetRef(root, baseOverride || defaultMainlineBase(root));
  const shipBase = explicitBase ? checkoutBase : normalizeTargetRef(root, 'origin/master');
  if (fs.existsSync(target)) throw new Error(`worktree path already exists: ${target}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  refreshRemoteRef(root, checkoutBase);
  runGit(['worktree', 'add', '-b', branch, target, checkoutBase], { cwd: root });
  runGit(['config', `branch.${branch}.atris-base`, shipBase], { cwd: target, check: false });
  runGit(['config', `branch.${branch}.atris-owner`, owner], { cwd: target, check: false });
  runGit(['config', `branch.${branch}.atris-task`, task], { cwd: target, check: false });
  fs.mkdirSync(path.join(target, '.atris'), { recursive: true });
  fs.writeFileSync(
    path.join(target, '.atris', 'agent-worktree.json'),
    JSON.stringify({
      agent: agent || null,
      member: member || null,
      owner,
      task,
      branch,
      base: shipBase,
      checkout_base: checkoutBase,
      workspace_root: root,
      created_at: now.toISOString(),
    }, null, 2) + '\n',
    'utf8'
  );
  return { path: target, branch, base: shipBase, checkoutBase, owner };
}

function startWorktree(args) {
  const root = repoRoot();
  const member = readFlag(args, '--member');
  const agent = readFlag(args, '--agent');
  const owner = member || agent;
  const task = readFlag(args, '--task');
  if (!owner || !task) {
    console.error('Usage: atris worktree start --member <member>|--agent <name> --task "<short task>" [--claim]');
    return 2;
  }
  const memberFile = member ? path.join(root, 'atris', 'team', member, 'MEMBER.md') : '';
  if (memberFile && !fs.existsSync(memberFile)) {
    console.error(`warning: no member persona at ${path.relative(root, memberFile)}`);
  }
  let created;
  try {
    created = createAgentWorktree({
      root,
      member,
      agent,
      task,
      branch: readFlag(args, '--branch'),
      path: readFlag(args, '--path'),
      base: readFlag(args, '--base') || readFlag(args, '--target'),
    });
  } catch (e) {
    console.error(`refusing: ${e.message}`);
    return 2;
  }
  const { path: target, branch, base } = created;

  const counts = statusCounts(root);
  if (counts && (counts.staged || counts.unstaged || counts.untracked)) {
    console.log(`note: primary checkout is dirty staged=${counts.staged} unstaged=${counts.unstaged} untracked=${counts.untracked}`);
  }
  console.log(`path: ${target}`);
  console.log(`branch: ${branch}`);
  console.log(`${member ? 'member' : 'agent'}: ${owner}`);
  if (hasFlag(args, '--claim')) {
    const channel = readFlag(args, '--swarlo-channel', 'general');
    const taskKey = readFlag(args, '--swarlo-task-key') || `${slugify(owner, 'agent', 24)}-${slugify(task, 'task', 36)}`;
    const content = readFlag(args, '--swarlo-content') || `${owner} owns ${task} in ${target}`;
    console.log(`swarlo_channel: ${channel}`);
    console.log(`swarlo_claim: ${swarloClaim(target, { channel, taskKey, content })}`);
  }
  console.log(`base: ${base}`);
  console.log(`next: cd ${target}`);
  return 0;
}

function createOrFindPr(root, branch, targetRef, title, dryRun) {
  const targetBranch = baseBranchName(targetRef);
  // `gh pr view` (no --state filter) returns ANY PR for this branch name,
  // including one already MERGED or CLOSED. A worktree branch that ships
  // more than once (this same branch, more commits, another `worktree ship`)
  // would then reuse the dead PR number: `gh pr merge <dead pr> --merge`
  // exits 0 with just a warning (never fails), so the new commits silently
  // never land while the ship command still reports success. Only reuse a
  // PR that is still OPEN; anything else gets a fresh one.
  const existing = spawnSync('gh', ['pr', 'view', '--json', 'number,url,state', '--jq', '"\\(.number) \\(.url) \\(.state)"'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (existing.status === 0 && existing.stdout.trim()) {
    const parts = existing.stdout.trim().split(/\s+/);
    const state = parts.pop();
    if (state === 'OPEN') return parts.join(' ');
  }
  const body = [
    'Automated Atris worktree ship.',
    '',
    `Branch: ${branch}`,
    `Target: ${targetBranch}`,
  ].join('\n');
  if (dryRun) return `dry-run: gh pr create --base ${targetBranch} --head ${branch}`;
  const created = spawnSync(
    'gh',
    ['pr', 'create', '--base', targetBranch, '--head', branch, '--title', title, '--body', body],
    { cwd: root, encoding: 'utf8' }
  );
  if (created.status !== 0) {
    throw new Error((created.stderr || created.stdout || 'gh pr create failed').trim());
  }
  return created.stdout.trim();
}

function prMergeRef(prOutput) {
  const text = String(prOutput || '').trim();
  if (!text || text.startsWith('dry-run:')) return '';
  return text.split(/\s+/)[0];
}

function shipHelp() {
  console.log('Usage: atris worktree ship --message "<commit>" --verify "<cmd>" [--merge] [--target <ref>] [--local]');
  console.log('');
  console.log('  --target <ref>  override the default landing target (default: branch atris-base, else origin default branch)');
  console.log('  --local         merge into the local primary checkout instead of pushing and opening a PR');
  console.log('  unstaged regenerated adapter files are skipped unless staged first or named in --message');
  console.log('  recommended flight verify: npm run test:fast && node --test <focused files>');
}

function shipWorktree(args) {
  if (hasFlag(args, '--help') || hasFlag(args, '-h') || args[0] === 'help') {
    shipHelp();
    return 0;
  }
  const root = repoRoot();
  const dryRun = hasFlag(args, '--dry-run');
  const noPr = hasFlag(args, '--no-pr');
  const localMode = hasFlag(args, '--local') || hasFlag(args, '--local-merge');
  const merge = hasFlag(args, '--merge');
  const message = readFlag(args, '--message') || readFlag(args, '-m');
  const verify = readFlag(args, '--verify');
  let branch = currentBranch(root);
  const worktrees = listWorktrees(root);
  const primary = worktrees[0]?.path;
  const targetRef = normalizeTargetRef(root, readFlag(args, '--target') || defaultShipTarget(root));

  if (!branch && path.resolve(root) === path.resolve(primary)) {
    console.error('blocked: detached head on the primary checkout');
    return 2;
  }
  if (!branch) {
    branch = detachedShipBranch(root);
    if (!createDetachedShipBranch(root, branch)) return 2;
  }
  if (branch === 'master' || branch === 'main') {
    console.error('blocked: ship from a feature worktree branch, not master/main');
    return 2;
  }
  if (path.resolve(root) === path.resolve(primary) && !hasFlag(args, '--allow-primary')) {
    console.error('blocked: ship from an isolated worktree, not the primary checkout');
    return 2;
  }

  refreshRemoteRef(root, targetRef);
  const skippedAdapters = restoreRegeneratedAdapterChurn(root, message, { dryRun });
  const ignoredUnstagedFiles = dryRun ? new Set(skippedAdapters) : new Set();
  const counts = statusCounts(root, { ignoredUnstagedFiles }) || { staged: 0, unstaged: 0, untracked: 0 };
  const dirty = counts.staged || counts.unstaged || counts.untracked;
  if (dirty && !message) {
    console.error('blocked: --message is required when there are local changes to commit');
    return 2;
  }

  if (dirty) {
    console.log(`commit: ${message}`);
    if (!dryRun) {
      runGit(['add', '-A'], { cwd: root });
      runGit(['commit', '-m', message], { cwd: root });
    }
  } else {
    console.log('commit: skipped (no local changes)');
  }

  if (verify) {
    console.log(`verify: ${verify}`);
    if (!dryRun) runCommand(verify, { cwd: root });
    const afterVerify = dryRun ? { staged: 0, unstaged: 0, untracked: 0 } : statusCounts(root) || { staged: 0, unstaged: 0, untracked: 0 };
    if (!dryRun && (afterVerify.staged || afterVerify.unstaged || afterVerify.untracked)) {
      console.error(
        `blocked: verifier left checkout dirty staged=${afterVerify.staged} ` +
          `unstaged=${afterVerify.unstaged} untracked=${afterVerify.untracked}`
      );
      return 3;
    }
  } else {
    console.log('verify: skipped (no --verify)');
  }

  const mergeCheck = dryRun
    ? { status: 0, stdout: 'dry-run' }
    : runGit(['merge-tree', '--write-tree', targetRef, 'HEAD'], { cwd: root, check: false });
  if (mergeCheck.status !== 0) {
    console.error(`blocked: branch does not merge cleanly into ${targetRef}`);
    console.error((mergeCheck.stderr || mergeCheck.stdout || '').trim());
    return 3;
  }
  console.log(`merge_check: ${targetRef} clean`);

  if (localMode) {
    console.log('push: skipped (local mode)');
    if (merge) {
      console.log('merge: requested (local mode)');
      if (!dryRun) {
        const targetBranch = baseBranchName(targetRef);
        const primaryBranch = currentBranch(primary);
        if (primaryBranch !== targetBranch) {
          const switched = runGit(['switch', targetBranch], { cwd: primary, check: false });
          if (switched.status !== 0) {
            throw new Error((switched.stderr || switched.stdout || `git switch ${targetBranch} failed`).trim());
          }
        }
        const primaryCounts = statusCounts(primary) || { staged: 0, unstaged: 0, untracked: 0 };
        if (primaryCounts.staged || primaryCounts.unstaged || primaryCounts.untracked) {
          throw new Error(
            `primary checkout dirty staged=${primaryCounts.staged} ` +
            `unstaged=${primaryCounts.unstaged} untracked=${primaryCounts.untracked}`
          );
        }
        runGit(['merge', '--no-ff', branch, '-m', `Merge ${branch}`], { cwd: primary });
        console.log('merge: merged (local mode)');
      }
    }
    console.log('pr: skipped (local mode)');
    console.log('done: worktree shipped');
    return 0;
  }

  console.log(`push: origin ${branch}`);
  if (!dryRun) runGit(['push', '-u', 'origin', branch], { cwd: root });

  if (!noPr || merge) {
    const title = message || branch;
    const pr = createOrFindPr(root, branch, targetRef, title, dryRun);
    console.log(`pr: ${pr}`);
    if (merge) {
      console.log('merge: requested');
      if (!dryRun) {
        const mergeRef = prMergeRef(pr);
        const mergeArgs = ['pr', 'merge'];
        if (mergeRef) mergeArgs.push(mergeRef);
        mergeArgs.push('--merge');
        const merged = spawnSync('gh', mergeArgs, { cwd: root, encoding: 'utf8' });
        if (merged.status !== 0) throw new Error((merged.stderr || merged.stdout || 'gh pr merge failed').trim());
        // `gh pr merge` on an already-merged PR exits 0 with a warning
        // instead of failing, which would otherwise report a false landing.
        if (/already merged/i.test(`${merged.stdout}${merged.stderr}`)) {
          throw new Error(`gh pr merge reported the PR was already merged (stale PR reused): ${(merged.stdout || merged.stderr).trim()}`);
        }
        console.log('merge: merged');
        const deleted = runGit(['push', 'origin', '--delete', branch], { cwd: root, check: false });
        if (deleted.status === 0) {
          console.log(`merge: remote branch deleted ${branch}`);
        } else {
          const deleteOutput = (deleted.stderr || deleted.stdout || 'remote branch delete failed').trim();
          console.log(`merge: remote branch delete skipped: ${deleteOutput}`);
        }
      }
    }
  } else {
    console.log('pr: skipped (--no-pr)');
  }

  try {
    stampLatestOpenBriefForWorktree(root, {
      result: 'pass',
      note: `worktree ship completed into ${targetRef}`,
    }, { worktree: root });
  } catch {}
  console.log('done: worktree shipped');
  return 0;
}

function guard(args) {
  const root = repoRoot();
  const worktrees = listWorktrees(root);
  const primary = worktrees[0]?.path;
  if (path.resolve(root) === path.resolve(primary) && !hasFlag(args, '--allow-primary')) {
    console.error('blocked: this is the primary checkout; create an agent worktree first');
    console.error('run: atris worktree start --member <member>|--agent <name> --task "<short task>" --claim');
    return 2;
  }
  // The CLI's own worktree metadata (written by `worktree start`) must not count as dirt.
  const counts = statusCounts(root, { ignoredUntrackedFiles: new Set(['.atris/agent-worktree.json']) });
  if (counts && (counts.staged || counts.unstaged || counts.untracked) && !hasFlag(args, '--allow-dirty')) {
    console.error(`blocked: checkout is dirty staged=${counts.staged} unstaged=${counts.unstaged} untracked=${counts.untracked}`);
    return 3;
  }
  console.log('atris worktree guard: ok');
  return 0;
}

function prune(args) {
  const cmd = ['worktree', 'prune', '--verbose'];
  if (!hasFlag(args, '--apply')) cmd.push('--dry-run');
  const result = runGit(cmd, { cwd: repoRoot(), check: false });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  console.log(output || (hasFlag(args, '--apply') ? 'no stale worktree registrations removed' : 'no stale worktree registrations found'));
  return result.status || 0;
}

const PROTECTED_BRANCHES = new Set(['main', 'master']);

// A worktree fresh off `worktree start` is merged into base by definition
// (zero commits yet), so without a grace window the janitor reaps it while
// the engine that requested it is still booting inside.
const WORKTREE_REAP_GRACE_MS = 60 * 60 * 1000;

function worktreeWithinReapGrace(worktreePath, now = Date.now()) {
  try {
    return now - fs.statSync(worktreePath).mtimeMs < WORKTREE_REAP_GRACE_MS;
  } catch {
    return false;
  }
}

function cleanupWorktrees({ root = repoRoot(), base: baseOverride = '', apply = false } = {}) {
  const worktrees = listWorktrees(root);
  const primary = worktrees[0]?.path ? path.resolve(worktrees[0].path) : '';
  const current = path.resolve(root);
  const base = normalizeTargetRef(root, baseOverride || defaultShipTarget(root));
  refreshRemoteRef(root, base);
  const candidates = [];
  const kept = [];
  const removed = [];

  for (const wt of worktrees) {
    const wtPath = path.resolve(wt.path);
    const item = { path: wt.path, branch: wt.branch, head: wt.head };
    if (wtPath === primary) {
      kept.push({ ...item, reason: 'primary_checkout' });
      continue;
    }
    if (wtPath === current) {
      kept.push({ ...item, reason: 'current_checkout' });
      continue;
    }
    if (wt.locked) {
      kept.push({ ...item, reason: 'locked' });
      continue;
    }
    if (PROTECTED_BRANCHES.has(wt.branch)) {
      kept.push({ ...item, reason: 'protected_branch' });
      continue;
    }
    const counts = statusCounts(wt.path);
    if (!counts) {
      kept.push({ ...item, reason: 'missing_or_unreadable' });
      continue;
    }
    if (counts.staged || counts.unstaged || counts.untracked) {
      kept.push({ ...item, reason: 'dirty', staged: counts.staged, unstaged: counts.unstaged, untracked: counts.untracked });
      continue;
    }
    if (!wt.head) {
      kept.push({ ...item, reason: 'missing_head' });
      continue;
    }
    const merged = runGit(['merge-base', '--is-ancestor', wt.head, base], { cwd: root, check: false }).status === 0;
    if (!merged) {
      kept.push({ ...item, reason: 'unmerged' });
      continue;
    }
    if (worktreeWithinReapGrace(wtPath)) {
      kept.push({ ...item, reason: 'fresh_worktree_grace' });
      continue;
    }
    const candidate = { ...item, reason: 'merged_into_base' };
    candidates.push(candidate);
    if (!apply) continue;
    const removedResult = runGit(['worktree', 'remove', wt.path], { cwd: root, check: false });
    if (removedResult.status === 0) {
      removed.push(candidate);
    } else {
      kept.push({ ...item, reason: 'remove_failed', error: (removedResult.stderr || removedResult.stdout || '').trim() });
    }
  }

  return { apply, base, candidates, removed, kept };
}

function cleanup(args) {
  const asJson = hasFlag(args, '--json');
  const result = cleanupWorktrees({
    root: repoRoot(),
    base: readFlag(args, '--base'),
    apply: hasFlag(args, '--apply'),
  });
  if (asJson) {
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    return 0;
  }
  const action = result.apply ? 'removed' : 'candidate';
  console.log(`cleanup: ${result.apply ? 'applied' : 'dry-run'} base=${result.base}`);
  console.log(`${action}s: ${result.apply ? result.removed.length : result.candidates.length}`);
  for (const item of result.apply ? result.removed : result.candidates) {
    console.log(`${action}: ${item.path} branch=${item.branch} reason=${item.reason}`);
  }
  console.log(`kept: ${result.kept.length}`);
  if (!result.apply && result.candidates.length) console.log('next: atris worktree cleanup --apply');
  return 0;
}

function guide() {
  console.log('Atris worktree agent recipe');
  console.log('');
  console.log('Default: stay in the current checkout for small, clean, single-agent fixes.');
  console.log('Use a worktree for dirty launchers, parallel agents, risky edits, releases, or long proof runs.');
  console.log('');
  console.log('1. Start isolated work when needed:');
  console.log('   atris worktree start --member <member> --task "<task>" --claim');
  console.log('   atris worktree start --agent <agent> --task "<task>"');
  console.log('');
  console.log('2. Move into the printed path:');
  console.log('   cd <printed path>');
  console.log('   atris worktree guard');
  console.log('');
  console.log('3. Tie work to mission/member state when relevant:');
  console.log('   atris mission start "<objective>" --owner <member> --verify "<cmd>"');
  console.log('   atris member goal-from-mission <member>');
  console.log('   atris member tick <member>');
  console.log('   atris mission tick <id> --verify --complete-on-pass');
  console.log('');
  console.log('4. Ship only from the isolated worktree:');
  console.log('   atris worktree ship --message "<commit>" --verify "<cmd>" --merge [--target <ref>]');
  console.log('   --target <ref> overrides the default landing target (default: branch atris-base, else origin default branch)');
  console.log('   recommended verify: npm run test:fast && node --test <focused files>');
  console.log('');
  console.log('5. Clean merged worktrees:');
  console.log('   atris worktree cleanup');
  console.log('   atris worktree cleanup --apply');
  console.log('');
  console.log('Notes: start uses the current upstream/default remote base, not dirty local HEAD.');
  console.log('Use `atris worktree status` to see all worktrees and dirty counts.');
  return 0;
}

function help() {
  console.log('Usage: atris worktree <guide|start|ship|status|guard|prune|cleanup>');
  console.log('');
  console.log('  atris worktree guide');
  console.log('  atris worktree start --member <member>|--agent <name> --task "<task>" [--claim]');
  console.log('  atris worktree ship --message "<commit>" --verify "<cmd>" [--merge] [--target <ref>] [--local]');
  console.log('    --target <ref>  override the default landing target (default: branch atris-base, else origin default branch)');
  console.log('    --local         merge into the local primary checkout instead of pushing and opening a PR');
  console.log('    recommended verify: npm run test:fast && node --test <focused files>');
  console.log('  atris worktree status');
  console.log('  atris worktree guard [--allow-primary] [--allow-dirty]');
  console.log('  atris worktree prune [--apply]');
  console.log('  atris worktree cleanup [--apply] [--json] [--base origin/master]');
}

function worktreeCommand(args = []) {
  const sub = args[0] || 'status';
  const rest = args.slice(1);
  if (sub === '--help' || sub === '-h' || sub === 'help') {
    help();
    return 0;
  }
  if (sub === 'guide' || sub === 'recipe') return guide();
  if (sub === 'start') return startWorktree(rest);
  if (sub === 'ship') return shipWorktree(rest);
  if (sub === 'status') {
    printStatus();
    return 0;
  }
  if (sub === 'guard') return guard(rest);
  if (sub === 'prune') return prune(rest);
  if (sub === 'cleanup' || sub === 'clean') return cleanup(rest);
  help();
  return 2;
}

module.exports = {
  branchName,
  createAgentWorktree,
  createOrFindPr,
  cleanupWorktrees,
  defaultShipTarget,
  defaultStartBase,
  defaultWorktreePath,
  listWorktrees,
  parseWorktrees,
  REGEN_ADAPTER_FILES,
  normalizeTargetRef,
  restoreRegeneratedAdapterChurn,
  prMergeRef,
  slugify,
  statusCounts,
  swarloClaim,
  worktreeCommand,
};
