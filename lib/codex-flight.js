'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const CODEX_COMPANION = '/Users/keshavrao/.claude/plugins/cache/openai-codex/codex/1.0.4/scripts/codex-companion.mjs';
const CONTRACT = "CRITICAL: complete the entire job in this single run; never end your reply on a plan. Do NOT run any atris boot/brain/state commands; the only atris commands allowed are 'atris worktree guard' and 'atris worktree ship'.";
const COAUTHOR = 'Co-authored-by: Atris <299057014+atris-builder[bot]@users.noreply.github.com>';

function safeSlug(value) {
  return String(value || 'mission')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'mission';
}

function stamp() {
  return new Date().toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function repoParts(repoPath) {
  const resolved = path.resolve(repoPath || process.cwd());
  const parts = resolved.split(path.sep);
  const worktreesIndex = parts.lastIndexOf('.agent-worktrees');
  if (worktreesIndex >= 0 && parts[worktreesIndex + 1]) {
    return {
      repoPath: resolved,
      repoName: parts[worktreesIndex + 1],
      arenaRoot: parts.slice(0, worktreesIndex).join(path.sep) || path.sep,
    };
  }
  return {
    repoPath: resolved,
    repoName: path.basename(resolved),
    arenaRoot: path.dirname(resolved),
  };
}

function buildPrompt({ worktreePath, branch, brief, verifyCmd }) {
  const verify = String(verifyCmd || 'git diff --check').trim() || 'git diff --check';
  return [
    CONTRACT,
    `Worktree: ${worktreePath}`,
    `Branch: ${branch}`,
    '',
    String(brief || '').trim(),
    '',
    'Instructions:',
    `- First run: atris worktree guard`,
    `- Verify with this bare command and use its real exit code: ${verify}`,
    '- Stage and commit only files you changed.',
    `- Commit with a plain-English message and include this trailer: ${COAUTHOR}`,
    `- Run: atris worktree ship --message "<plain-English summary>" --verify "${verify.replace(/"/g, '\\"')}" --merge`,
    '- Report the PR URL, commit sha, verify exit code, and ship exit code.',
    '- If rebase or merge reports a conflict, stop immediately and report the conflict; do not resolve it yourself.',
  ].join('\n');
}

function renderCommand(argv) {
  return argv.map(shellQuote).join(' ');
}

function runWorktreeAdd(repoPath, branch, worktreePath) {
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  const baseArgs = ['-C', repoPath, 'worktree', 'add', '-b', branch, worktreePath];
  const master = spawnSync('git', [...baseArgs, 'origin/master'], { encoding: 'utf8' });
  if (master.status === 0) return { baseRef: 'origin/master' };
  const main = spawnSync('git', [...baseArgs, 'origin/main'], { encoding: 'utf8' });
  if (main.status === 0) return { baseRef: 'origin/main' };
  const detail = [
    `origin/master: ${(master.stderr || master.stdout || '').trim()}`,
    `origin/main: ${(main.stderr || main.stdout || '').trim()}`,
  ].join('\n');
  throw new Error(`git worktree add failed for ${worktreePath}\n${detail}`);
}

function parseTaskId(stdout) {
  const text = String(stdout || '');
  const jsonMatch = text.match(/"jobId"\s*:\s*"([^"]+)"/);
  if (jsonMatch) return jsonMatch[1];
  const taskMatch = text.match(/\b(task-[A-Za-z0-9_.:-]+)\b/);
  if (taskMatch) return taskMatch[1];
  const asMatch = text.match(/\bas\s+([A-Za-z0-9_.:-]+)\b/);
  return asMatch ? asMatch[1] : '';
}

function spawnCodex(worktreePath, prompt) {
  return new Promise((resolve, reject) => {
    const argv = [CODEX_COMPANION, 'task', '--background', '--write', prompt];
    const child = spawn('node', argv, {
      cwd: worktreePath,
      env: { ...process.env, CODEX_COMPANION_SANDBOX: 'danger-full-access' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`codex companion exited ${code}\n${stderr || stdout}`));
        return;
      }
      const taskId = parseTaskId(stdout);
      if (!taskId) {
        reject(new Error(`could not parse codex task id from stdout\n${stdout}`));
        return;
      }
      resolve({ taskId, stdout, stderr });
    });
  });
}

async function dispatchCodexFlight({ repoPath, slug, brief, verifyCmd, dryRun = false } = {}) {
  const repo = repoParts(repoPath);
  const flightSlug = safeSlug(slug);
  const flightStamp = stamp();
  const branch = `codex/${flightSlug}-${flightStamp}`;
  const worktreePath = path.join(repo.arenaRoot, '.agent-worktrees', repo.repoName, `codex-${flightSlug}-${flightStamp}`);
  const prompt = buildPrompt({ worktreePath, branch, brief, verifyCmd });
  const worktreeCommand = ['git', '-C', repo.repoPath, 'worktree', 'add', '-b', branch, worktreePath, 'origin/master'];
  const fallbackCommand = ['git', '-C', repo.repoPath, 'worktree', 'add', '-b', branch, worktreePath, 'origin/main'];

  if (dryRun) {
    console.log(`Worktree command: ${renderCommand(worktreeCommand)}`);
    console.log(`Fallback command: ${renderCommand(fallbackCommand)}`);
    console.log(`Codex cwd: ${worktreePath}`);
    console.log('Prompt:');
    console.log(prompt);
    return { dryRun: true, prompt };
  }

  runWorktreeAdd(repo.repoPath, branch, worktreePath);
  const task = await spawnCodex(worktreePath, prompt);
  return { taskId: task.taskId, worktreePath, branch };
}

module.exports = {
  dispatchCodexFlight,
  buildPrompt,
  parseTaskId,
};
