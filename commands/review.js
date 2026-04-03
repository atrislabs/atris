/**
 * Atris Review — Run code review with specialist agents
 *
 *   atris review                   — Review staged changes
 *   atris review <file>            — Review a specific file
 *   atris review --diff HEAD~1     — Review last commit
 *   atris review --all             — Audit all Python services
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

function findReviewEngine() {
  // Look for review_engine.py in common locations
  const candidates = [
    path.join(process.cwd(), 'atris', 'business', 'claude-code-review', 'workspace', 'review_engine.py'),
    path.join(process.cwd(), 'review_engine.py'),
  ];
  // Also check parent dirs
  let dir = process.cwd();
  for (let i = 0; i < 3; i++) {
    candidates.push(path.join(dir, 'atris', 'business', 'claude-code-review', 'workspace', 'review_engine.py'));
    dir = path.dirname(dir);
  }
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function runReview(args) {
  const enginePath = findReviewEngine();
  if (!enginePath) {
    console.error('Review engine not found.');
    console.error('Expected at: atris/business/claude-code-review/workspace/review_engine.py');
    console.error('');
    console.error('The review engine runs 6 specialists:');
    console.error('  Security, Testing, Performance, Maintainability, Database, Async');
    console.error('');
    console.error('Install: copy review_engine.py to your project');
    process.exit(1);
  }

  // Parse args
  let file = null;
  let diffRef = null;
  let allMode = false;
  let jsonMode = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--diff' && args[i + 1]) {
      diffRef = args[i + 1];
      i++;
    } else if (args[i] === '--all') {
      allMode = true;
    } else if (args[i] === '--json') {
      jsonMode = true;
    } else if (!args[i].startsWith('-')) {
      file = args[i];
    }
  }

  // Build command
  const cmdArgs = ['python3', enginePath];
  if (file) {
    cmdArgs.push('--file', file);
  } else if (diffRef) {
    cmdArgs.push('--diff', diffRef);
  }
  if (jsonMode) {
    cmdArgs.push('--json');
  }

  if (allMode) {
    // Audit all Python services
    console.log('Auditing all Python services...\n');
    const servicesDir = path.join(process.cwd(), 'backend', 'services');
    if (!fs.existsSync(servicesDir)) {
      console.error('No backend/services/ directory found.');
      process.exit(1);
    }

    const files = fs.readdirSync(servicesDir).filter(f => f.endsWith('.py'));
    let totalFindings = 0;
    let cleanCount = 0;
    const issues = [];

    for (const f of files) {
      const filePath = path.join(servicesDir, f);
      try {
        const result = spawnSync('python3', [enginePath, '--file', filePath, '--json'], {
          encoding: 'utf8', timeout: 10000,
        });
        if (result.stdout) {
          const data = JSON.parse(result.stdout);
          const highMed = data.findings.filter(x => x.severity === 'high' || x.severity === 'medium');
          if (highMed.length > 0) {
            issues.push({ file: f, score: data.quality_score, count: highMed.length, top: highMed[0].rule });
            totalFindings += highMed.length;
          } else {
            cleanCount++;
          }
        }
      } catch {}
    }

    issues.sort((a, b) => a.score - b.score);

    console.log(`AUDIT: ${files.length} services | ${cleanCount} clean | ${issues.length} with findings\n`);
    if (issues.length > 0) {
      console.log(`${'Service'.padEnd(40)} ${'Score'.padStart(6)} ${'Findings'.padStart(8)}  Top Issue`);
      console.log(`${'─'.repeat(40)} ${'─'.repeat(6)} ${'─'.repeat(8)}  ${'─'.repeat(15)}`);
      for (const i of issues) {
        console.log(`${i.file.padEnd(40)} ${(i.score + '/10').padStart(6)} ${String(i.count).padStart(8)}  ${i.top}`);
      }
    }
    console.log('');
    return;
  }

  // Run single file or diff review
  const result = spawnSync(cmdArgs[0], cmdArgs.slice(1), {
    encoding: 'utf8',
    stdio: 'inherit',
    timeout: 30000,
  });

  process.exit(result.status || 0);
}

async function reviewCommand(...args) {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log('Usage: atris review [file] [options]');
    console.log('');
    console.log('  atris review                   Review staged changes');
    console.log('  atris review <file.py>         Review a specific file');
    console.log('  atris review --diff HEAD~1     Review last commit');
    console.log('  atris review --all             Audit all backend services');
    console.log('  atris review --json            Machine-readable output');
    console.log('');
    console.log('6 specialists: Security, Testing, Performance, Maintainability, Database, Async');
    return;
  }

  runReview(args);
}

module.exports = { reviewCommand };
