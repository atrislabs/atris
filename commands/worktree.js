'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function runGit(args, { cwd = process.cwd(), check = true } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (check && result.status !== 0) {
    const msg = (result.stderr || result.stdout || `git ${args.join(' ')} failed`).trim();
    throw new Error(msg);
  }
  return result;
}

function runCommand(command, { cwd = process.cwd(), check = true } = {}) {
  const result = spawnSync(command, { cwd, encoding: 'utf8', shell: true, stdio: 'pipe' });
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
        out.push({ path: current.worktree, branch, head: current.HEAD || '' });
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

function defaultStartBase(root) {
  const upstream = currentUpstream(root);
  if (upstream && refExists(root, upstream)) return upstream;
  const head = remoteHead(root);
  if (head && refExists(root, head)) return head;
  for (const candidate of ['origin/master', 'origin/main']) {
    if (refExists(root, candidate)) return candidate;
  }
  return 'HEAD';
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

function statusCounts(root) {
  if (!fs.existsSync(root)) return null;
  const result = runGit(['status', '--porcelain'], { cwd: root, check: false });
  if (result.status !== 0) return null;
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
    if (line.startsWith('??')) {
      untracked += 1;
      continue;
    }
    if (line[0] !== ' ') staged += 1;
    if (line[1] !== ' ') unstaged += 1;
  }
  return { staged, unstaged, untracked };
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
  const now = new Date();
  const branch = readFlag(args, '--branch') || branchName(owner, task, now);
  const target = path.resolve(readFlag(args, '--path') || defaultWorktreePath(root, owner, task, now));
  const base = normalizeTargetRef(root, readFlag(args, '--base') || readFlag(args, '--target') || defaultStartBase(root));
  const memberFile = member ? path.join(root, 'atris', 'team', member, 'MEMBER.md') : '';

  if (fs.existsSync(target)) {
    console.error(`refusing: worktree path already exists: ${target}`);
    return 2;
  }
  if (memberFile && !fs.existsSync(memberFile)) {
    console.error(`warning: no member persona at ${path.relative(root, memberFile)}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  refreshRemoteRef(root, base);
  runGit(['worktree', 'add', '-b', branch, target, base], { cwd: root });
  runGit(['config', `branch.${branch}.atris-base`, base], { cwd: target, check: false });
  runGit(['config', `branch.${branch}.atris-owner`, owner], { cwd: target, check: false });
  runGit(['config', `branch.${branch}.atris-task`, task], { cwd: target, check: false });

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
  const existing = spawnSync('gh', ['pr', 'view', '--json', 'number,url', '--jq', '"\\(.number) \\(.url)"'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (existing.status === 0 && existing.stdout.trim()) {
    return existing.stdout.trim();
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

function shipWorktree(args) {
  const root = repoRoot();
  const dryRun = hasFlag(args, '--dry-run');
  const noPr = hasFlag(args, '--no-pr');
  const merge = hasFlag(args, '--merge');
  const message = readFlag(args, '--message') || readFlag(args, '-m');
  const verify = readFlag(args, '--verify');
  const branch = currentBranch(root);
  const worktrees = listWorktrees(root);
  const primary = worktrees[0]?.path;
  const targetRef = normalizeTargetRef(root, readFlag(args, '--target') || defaultShipTarget(root));

  if (!branch || branch === 'master' || branch === 'main') {
    console.error('blocked: ship from a feature worktree branch, not master/main');
    return 2;
  }
  if (path.resolve(root) === path.resolve(primary) && !hasFlag(args, '--allow-primary')) {
    console.error('blocked: ship from an isolated worktree, not the primary checkout');
    return 2;
  }

  refreshRemoteRef(root, targetRef);
  const counts = statusCounts(root) || { staged: 0, unstaged: 0, untracked: 0 };
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

  console.log(`push: origin ${branch}`);
  if (!dryRun) runGit(['push', '-u', 'origin', branch], { cwd: root });

  if (!noPr || merge) {
    const title = message || branch;
    const pr = createOrFindPr(root, branch, targetRef, title, dryRun);
    console.log(`pr: ${pr}`);
    if (merge) {
      console.log('merge: requested');
      if (!dryRun) {
        const merged = spawnSync('gh', ['pr', 'merge', '--merge', '--delete-branch'], { cwd: root, encoding: 'utf8' });
        if (merged.status !== 0) throw new Error((merged.stderr || merged.stdout || 'gh pr merge failed').trim());
      }
    }
  } else {
    console.log('pr: skipped (--no-pr)');
  }

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
  const counts = statusCounts(root);
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

function help() {
  console.log('Usage: atris worktree <start|ship|status|guard|prune>');
  console.log('');
  console.log('  atris worktree start --member <member>|--agent <name> --task "<task>" [--claim]');
  console.log('  atris worktree ship --message "<commit>" --verify "<cmd>" [--merge]');
  console.log('  atris worktree status');
  console.log('  atris worktree guard [--allow-primary] [--allow-dirty]');
  console.log('  atris worktree prune [--apply]');
}

function worktreeCommand(args = []) {
  const sub = args[0] || 'status';
  const rest = args.slice(1);
  if (sub === '--help' || sub === '-h' || sub === 'help') {
    help();
    return 0;
  }
  if (sub === 'start') return startWorktree(rest);
  if (sub === 'ship') return shipWorktree(rest);
  if (sub === 'status') {
    printStatus();
    return 0;
  }
  if (sub === 'guard') return guard(rest);
  if (sub === 'prune') return prune(rest);
  help();
  return 2;
}

module.exports = {
  branchName,
  defaultShipTarget,
  defaultStartBase,
  defaultWorktreePath,
  parseWorktrees,
  normalizeTargetRef,
  slugify,
  statusCounts,
  swarloClaim,
  worktreeCommand,
};
