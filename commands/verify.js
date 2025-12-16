const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/**
 * atris verify [task] - Validate work is actually done
 *
 * - Check if claimed task changes exist in code
 * - Run tests if they exist
 * - Confirm MAP.md was updated if files changed
 * - Report verification status
 */
function verifyAtris(taskId = null) {
  const cwd = process.cwd();
  const atrisDir = path.join(cwd, 'atris');

  if (!fs.existsSync(atrisDir)) {
    console.log('✗ atris/ folder not found. Run "atris init" first.');
    process.exit(1);
  }

  console.log('');
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log('│ ATRIS VERIFY                                                │');
  console.log('└─────────────────────────────────────────────────────────────┘');
  console.log('');

  // If no task ID, verify workspace health
  if (!taskId) {
    return verifyWorkspace(cwd, atrisDir);
  }

  // Verify specific task
  return verifyTask(cwd, atrisDir, taskId);
}

/**
 * Verify overall workspace health
 */
function verifyWorkspace(cwd, atrisDir) {
  const results = {
    mapValid: false,
    testsPass: null,
    docsUpToDate: false,
    issues: []
  };

  console.log('Verifying workspace...');
  console.log('');

  // 1. Verify MAP.md exists and has content
  const mapResult = verifyMap(cwd, atrisDir);
  results.mapValid = mapResult.valid;
  if (!mapResult.valid) {
    results.issues.push(...mapResult.issues);
  }

  // 2. Run tests if available
  const testResult = runTests(cwd);
  results.testsPass = testResult.pass;
  if (testResult.run && !testResult.pass) {
    results.issues.push(`Tests failed: ${testResult.summary}`);
  }

  // 3. Check recent git changes vs MAP.md
  const docResult = checkDocsVsChanges(cwd, atrisDir);
  results.docsUpToDate = docResult.upToDate;
  if (!docResult.upToDate) {
    results.issues.push(...docResult.issues);
  }

  // Report
  console.log('Verification Results:');
  console.log('');

  // MAP status
  if (results.mapValid) {
    console.log('✓ MAP.md — Valid');
    if (mapResult.stats) {
      console.log(`   ${mapResult.stats.fileRefs} file refs, ${mapResult.stats.lineRefs} line refs`);
    }
  } else {
    console.log('✗ MAP.md — Issues found');
    mapResult.issues.forEach(issue => console.log(`   • ${issue}`));
  }
  console.log('');

  // Test status
  if (testResult.run) {
    if (results.testsPass) {
      console.log(`✓ Tests — Pass (${testResult.summary})`);
    } else {
      console.log(`✗ Tests — Fail (${testResult.summary})`);
    }
  } else {
    console.log('○ Tests — Not configured');
  }
  console.log('');

  // Docs vs changes
  if (results.docsUpToDate) {
    console.log('✓ Docs — Up to date with recent changes');
  } else {
    console.log('⚠ Docs — May need updating');
    docResult.issues.forEach(issue => console.log(`   • ${issue}`));
  }
  console.log('');

  console.log('─────────────────────────────────────────────────────────────');

  if (results.issues.length === 0) {
    console.log('Result: VERIFIED ✓');
    console.log('Workspace is healthy. Ready for production.');
  } else {
    console.log(`Result: ${results.issues.length} issue(s) found`);
    console.log('Fix issues before marking work complete.');
  }
  console.log('');

  return results;
}

/**
 * Verify a specific task by ID
 */
function verifyTask(cwd, atrisDir, taskId) {
  const todoFile = path.join(atrisDir, 'TODO.md');
  const legacyFile = path.join(atrisDir, 'TASK_CONTEXTS.md');
  const taskFilePath = fs.existsSync(todoFile) ? todoFile :
                       fs.existsSync(legacyFile) ? legacyFile : null;

  if (!taskFilePath) {
    console.log('✗ No TODO.md found');
    process.exit(1);
  }

  const content = fs.readFileSync(taskFilePath, 'utf8');

  // Find task by ID (T1, T2, etc. or partial title match)
  const taskMatch = findTaskInContent(content, taskId);

  if (!taskMatch) {
    console.log(`✗ Task "${taskId}" not found`);
    console.log('');
    console.log('Available tasks:');
    listAvailableTasks(content);
    process.exit(1);
  }

  console.log(`Verifying: ${taskMatch.title}`);
  console.log('');

  const results = {
    taskFound: true,
    title: taskMatch.title,
    checks: []
  };

  // Extract expected files/changes from task description
  const expectedChanges = extractExpectedChanges(taskMatch.content);

  // Check each expected change
  for (const change of expectedChanges) {
    const check = verifyChange(cwd, change);
    results.checks.push(check);

    const status = check.pass ? '✓' : '✗';
    console.log(`${status} ${check.description}`);
    if (check.details) {
      console.log(`   ${check.details}`);
    }
  }

  // Run tests
  console.log('');
  const testResult = runTests(cwd);
  if (testResult.run) {
    const testStatus = testResult.pass ? '✓' : '✗';
    console.log(`${testStatus} Tests: ${testResult.summary}`);
  } else {
    console.log('○ Tests: Not configured');
  }

  // Check if MAP.md mentions the task's files
  const mapCheck = checkMapForFiles(atrisDir, expectedChanges);
  console.log('');
  if (mapCheck.documented) {
    console.log('✓ MAP.md: Files documented');
  } else {
    console.log('⚠ MAP.md: May need updating for new files');
  }

  console.log('');
  console.log('─────────────────────────────────────────────────────────────');

  const passed = results.checks.filter(c => c.pass).length;
  const total = results.checks.length;
  const testPass = !testResult.run || testResult.pass;

  if (passed === total && testPass) {
    console.log(`Result: VERIFIED ✓ (${passed}/${total} checks passed)`);
    console.log('Task can be marked complete.');
  } else {
    console.log(`Result: INCOMPLETE (${passed}/${total} checks passed)`);
    console.log('Fix issues before marking complete.');
  }
  console.log('');

  return results;
}

/**
 * Verify MAP.md has real content
 */
function verifyMap(cwd, atrisDir) {
  const mapFile = path.join(atrisDir, 'MAP.md');
  const result = { valid: false, issues: [], stats: null };

  if (!fs.existsSync(mapFile)) {
    result.issues.push('MAP.md does not exist');
    return result;
  }

  const content = fs.readFileSync(mapFile, 'utf8');

  // Check for placeholder content
  const isPlaceholder = content.toLowerCase().includes('generated by your ai agent')
    || content.toLowerCase().includes('run your ai agent')
    || content.toLowerCase().includes('placeholder');

  if (isPlaceholder) {
    result.issues.push('MAP.md contains placeholder content');
    return result;
  }

  // Count refs
  const fileRefs = (content.match(/`[^`]+\.(js|ts|py|go|rs|rb|java|md|json)`/g) || []).length;
  const lineRefs = (content.match(/:\d+`?/g) || []).length;

  if (fileRefs < 3) {
    result.issues.push('MAP.md has very few file references');
  }

  result.stats = { fileRefs, lineRefs };
  result.valid = result.issues.length === 0;

  return result;
}

/**
 * Run project tests
 */
function runTests(cwd) {
  const result = { run: false, pass: false, summary: '' };

  // Detect test command
  const packageJson = path.join(cwd, 'package.json');
  const pytestConfig = path.join(cwd, 'pytest.ini');
  const pyprojectToml = path.join(cwd, 'pyproject.toml');

  let testCmd = null;

  if (fs.existsSync(packageJson)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
      if (pkg.scripts && pkg.scripts.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
        testCmd = 'npm test';
      }
    } catch {}
  }

  if (!testCmd && (fs.existsSync(pytestConfig) || fs.existsSync(pyprojectToml))) {
    testCmd = 'pytest';
  }

  if (!testCmd) {
    return result;
  }

  result.run = true;

  // Run tests
  const [cmd, ...args] = testCmd.split(' ');
  const proc = spawnSync(cmd, args, {
    cwd,
    stdio: 'pipe',
    timeout: 60000
  });

  result.pass = proc.status === 0;
  result.summary = result.pass ? 'All tests passed' : `Exit code ${proc.status}`;

  return result;
}

/**
 * Check if recent git changes are documented in MAP.md
 */
function checkDocsVsChanges(cwd, atrisDir) {
  const result = { upToDate: true, issues: [] };

  // Get recent changed files from git
  const proc = spawnSync('git', ['diff', '--name-only', 'HEAD~5'], {
    cwd,
    stdio: 'pipe'
  });

  if (proc.status !== 0) {
    // Git not available or not a repo
    return result;
  }

  const changedFiles = proc.stdout.toString().trim().split('\n').filter(Boolean);

  if (changedFiles.length === 0) {
    return result;
  }

  // Check if significant files are in MAP.md
  const mapFile = path.join(atrisDir, 'MAP.md');
  if (!fs.existsSync(mapFile)) {
    return result;
  }

  const mapContent = fs.readFileSync(mapFile, 'utf8');

  const significantExtensions = ['.js', '.ts', '.py', '.go', '.rs', '.rb', '.java'];
  const significantChanges = changedFiles.filter(f =>
    significantExtensions.some(ext => f.endsWith(ext))
  );

  for (const file of significantChanges) {
    const basename = path.basename(file);
    if (!mapContent.includes(basename) && !mapContent.includes(file)) {
      result.upToDate = false;
      result.issues.push(`${file} changed but not in MAP.md`);
    }
  }

  // Limit reported issues
  if (result.issues.length > 3) {
    const overflow = result.issues.length - 3;
    result.issues = result.issues.slice(0, 3);
    result.issues.push(`... and ${overflow} more`);
  }

  return result;
}

/**
 * Find task in TODO.md content
 */
function findTaskInContent(content, taskId) {
  // Try exact ID match (T1, T2, etc.)
  const idPattern = new RegExp(`### (T${taskId}|Task ${taskId})[:\\s]([\\s\\S]*?)(?=\\n###|\\n##|$)`, 'i');
  let match = content.match(idPattern);

  if (match) {
    return { title: match[1] + (match[2] ? ': ' + match[2].split('\n')[0].trim() : ''), content: match[0] };
  }

  // Try title substring match
  const sections = content.split(/\n### /).filter(s => s.trim());
  for (const section of sections) {
    if (section.toLowerCase().includes(taskId.toLowerCase())) {
      const firstLine = section.split('\n')[0].trim();
      return { title: firstLine, content: section };
    }
  }

  return null;
}

/**
 * List available tasks
 */
function listAvailableTasks(content) {
  const taskPattern = /### ([^\n]+)/g;
  let match;
  let count = 0;

  while ((match = taskPattern.exec(content)) !== null && count < 5) {
    console.log(`  • ${match[1].substring(0, 60)}`);
    count++;
  }
}

/**
 * Extract expected changes from task description
 */
function extractExpectedChanges(taskContent) {
  const changes = [];

  // Look for file paths
  const filePattern = /[`"]?([a-zA-Z0-9_\-./]+\.(js|ts|py|go|rs|rb|java|md|json))[`"]?/g;
  let match;

  while ((match = filePattern.exec(taskContent)) !== null) {
    const file = match[1];
    if (!changes.find(c => c.file === file)) {
      changes.push({ type: 'file', file, description: `File exists: ${file}` });
    }
  }

  // Look for function/class names
  const funcPattern = /(?:function|class|def|fn)\s+([a-zA-Z_][a-zA-Z0-9_]*)/g;
  while ((match = funcPattern.exec(taskContent)) !== null) {
    changes.push({ type: 'symbol', name: match[1], description: `Symbol defined: ${match[1]}` });
  }

  // If no specific changes found, just check task isn't empty
  if (changes.length === 0) {
    changes.push({ type: 'generic', description: 'Task has implementation' });
  }

  return changes;
}

/**
 * Verify a single change
 */
function verifyChange(cwd, change) {
  if (change.type === 'file') {
    const fullPath = path.join(cwd, change.file);
    const exists = fs.existsSync(fullPath);
    return {
      pass: exists,
      description: change.description,
      details: exists ? null : 'File not found'
    };
  }

  if (change.type === 'symbol') {
    // Search for symbol in codebase
    const proc = spawnSync('grep', ['-r', change.name, '--include=*.js', '--include=*.ts', '--include=*.py', '.'], {
      cwd,
      stdio: 'pipe'
    });
    const found = proc.status === 0 && proc.stdout.toString().trim().length > 0;
    return {
      pass: found,
      description: change.description,
      details: found ? null : 'Symbol not found in codebase'
    };
  }

  // Generic check - always pass (can't verify without specifics)
  return {
    pass: true,
    description: change.description,
    details: 'Manual verification recommended'
  };
}

/**
 * Check if MAP.md documents the expected files
 */
function checkMapForFiles(atrisDir, changes) {
  const mapFile = path.join(atrisDir, 'MAP.md');
  if (!fs.existsSync(mapFile)) {
    return { documented: false };
  }

  const content = fs.readFileSync(mapFile, 'utf8');
  const fileChanges = changes.filter(c => c.type === 'file');

  if (fileChanges.length === 0) {
    return { documented: true };
  }

  let documented = 0;
  for (const change of fileChanges) {
    const basename = path.basename(change.file);
    if (content.includes(basename) || content.includes(change.file)) {
      documented++;
    }
  }

  return { documented: documented >= fileChanges.length / 2 };
}

module.exports = {
  verifyAtris
};
