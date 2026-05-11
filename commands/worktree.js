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
  const member = readFlag(args, '--member') || readFlag(args, '--agent');
  const task = readFlag(args, '--task');
  if (!member || !task) {
    console.error('Usage: atris worktree start --member <member> --task "<short task>" [--claim]');
    return 2;
  }
  const now = new Date();
  const branch = readFlag(args, '--branch') || branchName(member, task, now);
  const target = path.resolve(readFlag(args, '--path') || defaultWorktreePath(root, member, task, now));
  const base = readFlag(args, '--base') || 'HEAD';
  const memberFile = path.join(root, 'atris', 'team', member, 'MEMBER.md');

  if (fs.existsSync(target)) {
    console.error(`refusing: worktree path already exists: ${target}`);
    return 2;
  }
  if (!fs.existsSync(memberFile)) {
    console.error(`warning: no member persona at ${path.relative(root, memberFile)}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  runGit(['worktree', 'add', '-b', branch, target, base], { cwd: root });

  const counts = statusCounts(root);
  if (counts && (counts.staged || counts.unstaged || counts.untracked)) {
    console.log(`note: primary checkout is dirty staged=${counts.staged} unstaged=${counts.unstaged} untracked=${counts.untracked}`);
  }
  console.log(`path: ${target}`);
  console.log(`branch: ${branch}`);
  console.log(`member: ${member}`);
  if (hasFlag(args, '--claim')) {
    const channel = readFlag(args, '--swarlo-channel', 'general');
    const taskKey = readFlag(args, '--swarlo-task-key') || `${slugify(member, 'member', 24)}-${slugify(task, 'task', 36)}`;
    const content = readFlag(args, '--swarlo-content') || `${member} owns ${task} in ${target}`;
    console.log(`swarlo_channel: ${channel}`);
    console.log(`swarlo_claim: ${swarloClaim(target, { channel, taskKey, content })}`);
  }
  console.log(`base: ${base}`);
  console.log(`next: cd ${target}`);
  return 0;
}

function guard(args) {
  const root = repoRoot();
  const worktrees = listWorktrees(root);
  const primary = worktrees[0]?.path;
  if (path.resolve(root) === path.resolve(primary) && !hasFlag(args, '--allow-primary')) {
    console.error('blocked: this is the primary checkout; create an agent worktree first');
    console.error('run: atris worktree start --member <member> --task "<short task>" --claim');
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
  console.log('Usage: atris worktree <start|status|guard|prune>');
  console.log('');
  console.log('  atris worktree start --member <member> --task "<task>" [--claim]');
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
  defaultWorktreePath,
  parseWorktrees,
  slugify,
  statusCounts,
  swarloClaim,
  worktreeCommand,
};
