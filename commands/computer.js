/**
 * Atris Computer — interact with your EC2 AI Computer
 *
 *   atris computer                  — Show status
 *   atris computer wake             — Start the computer
 *   atris computer sleep            — Stop (files persist)
 *   atris computer run <command>    — Run bash on EC2 (no LLM)
 *   atris computer grep <pattern>   — Search files on EC2
 *   atris computer ls [path]        — List files
 *   atris computer cat <path>       — Read a file
 *   atris computer exec <prompt>    — Run with LLM (Claude Code)
 */

const { loadCredentials } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');

function getToken() {
  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }
  return creds.token;
}

async function computerStatus(token) {
  const result = await apiRequestJson('/ai-computer/user/status', {
    method: 'GET',
    token,
  });
  if (!result.ok) {
    console.error(`Failed: ${result.errorMessage || result.status}`);
    return;
  }
  const d = result.data;
  console.log(`  Status:   ${d.status || 'unknown'}`);
  console.log(`  Agent:    ${(d.agent_id || '?').slice(0, 12)}...`);
  console.log(`  Endpoint: ${d.endpoint || 'off'}`);
}

async function computerWake(token) {
  console.log('Waking computer...');
  const result = await apiRequestJson('/ai-computer/user/wake', {
    method: 'POST',
    token,
    body: {},
  });
  if (!result.ok) {
    console.error(`Failed: ${result.errorMessage || result.status}`);
    return;
  }
  console.log(`  Status:   ${result.data.status}`);
  console.log(`  Endpoint: ${result.data.endpoint}`);
}

async function computerSleep(token) {
  console.log('Sleeping computer...');
  const result = await apiRequestJson('/ai-computer/user/sleep', {
    method: 'POST',
    token,
    body: {},
  });
  if (!result.ok) {
    console.error(`Failed: ${result.errorMessage || result.status}`);
    return;
  }
  console.log('  Computer is sleeping. Files persist.');
}

async function computerRun(token, command) {
  if (!command) {
    console.error('Usage: atris computer run <command>');
    process.exit(1);
  }
  const result = await apiRequestJson('/ai-computer/terminal', {
    method: 'POST',
    token,
    body: { command },
  });
  if (!result.ok) {
    if (result.status === 409 || (result.errorMessage || '').includes('running')) {
      console.error('Computer is off. Run: atris computer wake');
    } else {
      console.error(`Failed: ${result.errorMessage || result.status}`);
    }
    return;
  }
  const d = result.data;
  if (d.stdout) process.stdout.write(d.stdout);
  if (d.stderr) process.stderr.write(d.stderr);
  if (d.exit_code && d.exit_code !== 0) {
    console.error(`Exit: ${d.exit_code}`);
  }
}

async function computerGrep(token, pattern) {
  if (!pattern) {
    console.error('Usage: atris computer grep <pattern>');
    process.exit(1);
  }
  return computerRun(token, `grep -rni "${pattern}" . --include="*.md" --include="*.py" --include="*.js" --include="*.json" 2>/dev/null | head -30`);
}

async function computerLs(token, remotePath) {
  const path = remotePath || '/';
  const result = await apiRequestJson(`/ai-computer/files?path=${encodeURIComponent(path)}`, {
    method: 'GET',
    token,
  });
  if (!result.ok) {
    console.error(`Failed: ${result.errorMessage || result.status}`);
    return;
  }
  for (const f of (result.data.files || [])) {
    const type = f.type === 'dir' ? 'DIR ' : '    ';
    console.log(`  ${type}${f.name}  (${f.size || 0}b)`);
  }
}

async function computerCat(token, remotePath) {
  if (!remotePath) {
    console.error('Usage: atris computer cat <path>');
    process.exit(1);
  }
  const result = await apiRequestJson(`/ai-computer/file?path=${encodeURIComponent(remotePath)}`, {
    method: 'GET',
    token,
  });
  if (!result.ok) {
    console.error(`Failed: ${result.errorMessage || result.status}`);
    return;
  }
  console.log(result.data.content || '');
}

async function computerDiff(token, remotePath) {
  const rPath = remotePath || 'soul';
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');

  // List remote files
  const listResult = await apiRequestJson(`/ai-computer/files?path=${encodeURIComponent(rPath)}`, {
    method: 'GET', token,
  });
  if (!listResult.ok) {
    console.error(`Failed: ${listResult.errorMessage || listResult.status}`);
    return;
  }
  const remoteFiles = (listResult.data.files || []).filter(f => f.type === 'file');

  // Compare with local ec2_pull/
  const localDir = 'experiments/computer/ec2_pull';
  let added = 0, modified = 0, same = 0, deleted = 0;

  for (const f of remoteFiles) {
    const localPath = path.join(localDir, f.name);
    if (!fs.existsSync(localPath)) {
      console.log(`  + ${f.name} (${f.size}b) — new on EC2`);
      added++;
    } else {
      const localSize = fs.statSync(localPath).size;
      if (Math.abs(localSize - (f.size || 0)) > 10) {
        console.log(`  ~ ${f.name} (local: ${localSize}b, EC2: ${f.size}b) — changed`);
        modified++;
      } else {
        same++;
      }
    }
  }

  // Check for files deleted on EC2
  if (fs.existsSync(localDir)) {
    const remoteNames = new Set(remoteFiles.map(f => f.name));
    for (const localFile of fs.readdirSync(localDir)) {
      if (!remoteNames.has(localFile) && localFile.endsWith('.md')) {
        console.log(`  - ${localFile} — deleted on EC2`);
        deleted++;
      }
    }
  }

  console.log(`\n  ${added} new, ${modified} changed, ${deleted} deleted, ${same} unchanged`);
}

async function computerPull(token, remotePath, localDir) {
  const rPath = remotePath || 'soul';
  const lDir = localDir || 'ec2_pull';
  const fs = require('fs');
  const path = require('path');

  // List files
  const listResult = await apiRequestJson(`/ai-computer/files?path=${encodeURIComponent(rPath)}`, {
    method: 'GET', token,
  });
  if (!listResult.ok) {
    console.error(`Failed to list: ${listResult.errorMessage || listResult.status}`);
    return;
  }
  const files = (listResult.data.files || []).filter(f => f.type === 'file');
  if (files.length === 0) {
    console.log('  No files to pull.');
    return;
  }

  // Create local dir
  fs.mkdirSync(lDir, { recursive: true });
  console.log(`Pulling ${files.length} files from ${rPath}/ → ${lDir}/`);

  let pulled = 0;
  for (const f of files) {
    const fileResult = await apiRequestJson(
      `/ai-computer/file?path=${encodeURIComponent(rPath + '/' + f.name)}`,
      { method: 'GET', token, timeoutMs: 15000 }
    );
    if (fileResult.ok && fileResult.data.content) {
      const localPath = path.join(lDir, f.name);
      fs.writeFileSync(localPath, fileResult.data.content);
      console.log(`  ${f.name} (${fileResult.data.content.length}b)`);
      pulled++;
    }
  }
  console.log(`\n  Pulled ${pulled} files.`);
}

async function computerLearn(token) {
  console.log('Starting learning cycle on EC2...');

  // First check how many learnings exist
  const countResult = await apiRequestJson('/ai-computer/terminal', {
    method: 'POST', token,
    body: { command: 'ls soul/learning-*.md 2>/dev/null | wc -l | tr -d " "' },
  });
  const count = parseInt((countResult.ok && countResult.data.stdout || '0').trim()) || 0;
  const next = String(count + 1).padStart(3, '0');
  console.log(`  Existing learnings: ${count}`);
  console.log(`  Next: soul/learning-${next}.md`);

  // Trigger LLM learning cycle
  const prompt = `Self-improvement cycle. Read soul/INDEX.md to see what you know. ` +
    `Check existing soul/learning-*.md files to avoid repeating topics. ` +
    `Pick ONE new topic that would make the overnight agent better at earning money for the business owner. ` +
    `Research it using the files and tools available. ` +
    `Write your finding to soul/learning-${next}.md. Be specific and actionable. ` +
    `Then run: bash tools/rebuild_index.sh`;

  const result = await apiRequestJson('/ai-computer/execute', {
    method: 'POST', token,
    body: { prompt },
  });
  if (!result.ok) {
    console.error(`Failed: ${result.errorMessage || result.status}`);
    return;
  }
  console.log(`  Learning cycle started: ${result.data.execution_id}`);
  console.log(`  The computer is thinking... check back with: atris computer diff soul`);
}

async function computerExec(token, prompt) {
  if (!prompt) {
    console.error('Usage: atris computer exec "<prompt>"');
    process.exit(1);
  }
  console.log('Executing on computer (with LLM)...');
  const result = await apiRequestJson('/ai-computer/execute', {
    method: 'POST',
    token,
    body: { prompt },
  });
  if (!result.ok) {
    console.error(`Failed: ${result.errorMessage || result.status}`);
    return;
  }
  console.log(`  Execution: ${result.data.execution_id}`);
  console.log(`  Stream: ${result.data.endpoint}/events/stream?execution_id=${result.data.execution_id}`);
  console.log('  Use the stream URL to watch progress.');
}

async function runComputer() {
  const sub = process.argv[3];

  if (!sub || sub === '--help') {
    console.log('Usage: atris computer <command>');
    console.log('');
    console.log('Commands:');
    console.log('  status          Show computer status');
    console.log('  wake            Start the computer');
    console.log('  sleep           Stop the computer (files persist)');
    console.log('  run <cmd>       Run bash on EC2 (no LLM cost)');
    console.log('  grep <pattern>  Search files on EC2');
    console.log('  ls [path]       List files');
    console.log('  cat <path>      Read a file');
    console.log('  exec "<prompt>" Run with LLM (Claude Code)');
    console.log('  pull [path] [dir] Pull files from EC2 to local');
    console.log('  diff [path]       Show what changed on EC2 since last pull');
    console.log('  learn             Trigger autonomous learning cycle');
    console.log('');
    console.log('Examples:');
    console.log('  atris computer status');
    console.log('  atris computer wake');
    console.log('  atris computer run "ls -la /workspace"');
    console.log('  atris computer grep "overnight"');
    console.log('  atris computer cat soul/soul.md');
    console.log('  atris computer exec "Read soul/ and suggest what to work on"');
    return;
  }

  const token = getToken();
  const rest = process.argv.slice(4).join(' ');

  switch (sub) {
    case 'status': return computerStatus(token);
    case 'wake': return computerWake(token);
    case 'sleep': return computerSleep(token);
    case 'run': return computerRun(token, rest);
    case 'grep': return computerGrep(token, rest);
    case 'ls': return computerLs(token, rest || undefined);
    case 'cat': return computerCat(token, rest);
    case 'exec': return computerExec(token, rest);
    case 'pull': {
      const parts = rest.split(' ').filter(Boolean);
      return computerPull(token, parts[0], parts[1]);
    }
    case 'diff': return computerDiff(token, rest || undefined);
    case 'learn': return computerLearn(token);
    default:
      console.error(`Unknown subcommand: ${sub}`);
      console.log('Run: atris computer --help');
  }
}

module.exports = { runComputer };
