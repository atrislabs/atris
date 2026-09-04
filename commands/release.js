const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { runGit } = require('../lib/checkout-sync');

/**
 * atris release [--dry-run] - Tag a release, create GitHub release, draft /launch post
 *
 * - Reads git log since last tag
 * - Determines bump type (minor if any scorecard has reward>=5, else patch)
 * - Bumps package.json and package-lock.json together
 * - Commits, tags, pushes
 * - Creates GitHub release via `gh`
 * - Drafts a /launch post (3 emoji bullets)
 */
async function releaseAtris({ dryRun = false } = {}) {
  const cwd = process.cwd();

  // 1. Get last tag
  let lastTag;
  try {
    lastTag = execFileSync('git', ['describe', '--tags', '--abbrev=0'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    lastTag = null;
  }

  // 2. Get git log since last tag
  let logArgs = ['log', '--oneline'];
  if (lastTag) {
    logArgs = ['log', `${lastTag}..HEAD`, '--oneline'];
  }
  let commits;
  try {
    commits = execFileSync('git', logArgs, { cwd, encoding: 'utf8' }).trim();
  } catch {
    commits = '';
  }

  if (!commits) {
    console.log('no new commits since last tag' + (lastTag ? ` (${lastTag})` : '') + '. nothing to release.');
    return;
  }

  const commitLines = commits.split('\n').filter(Boolean);
  console.log('');
  console.log(`commits since ${lastTag || 'beginning'}: ${commitLines.length}`);

  // 3. Build changelog
  const changelog = commitLines.map(l => `- ${l}`).join('\n');

  // 4. Determine bump type: minor if any scorecard has reward >= 5, else patch
  const bumpType = determineBumpType(cwd);
  console.log(`bump type: ${bumpType}`);

  // 5. Read current version and compute next
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    console.log('no package.json found. cannot bump version.');
    return;
  }
  const pkgRaw = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(pkgRaw);
  const currentVersion = pkg.version;
  const nextVersion = bumpVersion(currentVersion, bumpType);

  console.log(`version: ${currentVersion} → ${nextVersion}`);
  console.log('');

  // 6. Show changelog
  console.log('changelog:');
  console.log(changelog);
  console.log('');

  if (dryRun) {
    console.log('--- dry-run: draft release ---');
    console.log(`tag: v${nextVersion}`);
    console.log(`title: v${nextVersion}`);
    console.log('');
    printLaunchPost(nextVersion, commitLines);
    return;
  }

  // 7. Let npm keep package.json and package-lock.json aligned.
  execFileSync('npm', [
    'version',
    nextVersion,
    '--no-git-tag-version',
    '--ignore-scripts',
  ], { cwd, stdio: 'ignore' });
  console.log(`bumped package.json and package-lock.json to ${nextVersion}`);

  // 8. Commit
  execFileSync('git', ['add', 'package.json', 'package-lock.json'], { cwd });
  execFileSync('git', ['commit', '-m', `v${nextVersion}`], { cwd });
  console.log('committed');

  // 9. Tag
  execFileSync('git', ['tag', `v${nextVersion}`], { cwd });
  console.log(`tagged v${nextVersion}`);

  // 10. Push + push tags
  try {
    execFileSync('git', ['push'], { cwd });
    execFileSync('git', ['push', '--tags'], { cwd });
    console.log('pushed');
  } catch (err) {
    console.log('push failed, you may need to push manually');
  }

  // 11. Create GitHub release via gh
  try {
    execFileSync('gh', ['release', 'create', `v${nextVersion}`,
      '--title', `v${nextVersion}`,
      '--notes', changelog
    ], { cwd });
    console.log(`github release created: v${nextVersion}`);
  } catch (err) {
    console.log('gh release create failed, install gh or create release manually');
  }

  // 12. Draft launch post
  console.log('');
  printLaunchPost(nextVersion, commitLines);
}

/**
 * Check scorecards for reward >= 5 → minor bump. Otherwise patch.
 */
function determineBumpType(cwd) {
  const scorecardsDir = path.join(cwd, 'atris', 'scorecards');
  if (!fs.existsSync(scorecardsDir)) return 'patch';

  try {
    const files = fs.readdirSync(scorecardsDir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(scorecardsDir, file), 'utf8');
      const rewardMatch = content.match(/reward[:\s]+(\d+)/i);
      if (rewardMatch && parseInt(rewardMatch[1], 10) >= 5) {
        return 'minor';
      }
    }
  } catch {
    // ignore
  }
  return 'patch';
}

/**
 * Bump a semver string: "1.2.3" + "patch" → "1.2.4", "minor" → "1.3.0"
 */
function bumpVersion(version, type) {
  const parts = version.split('.').map(Number);
  if (type === 'minor') {
    parts[1]++;
    parts[2] = 0;
  } else {
    parts[2]++;
  }
  return parts.join('.');
}

/**
 * Print a 3-emoji-bullet launch post (Twitter + LinkedIn format)
 */
function printLaunchPost(version, commitLines) {
  // Pick top 3 changes (dedupe, trim hashes)
  const topChanges = commitLines
    .slice(0, 3)
    .map(l => l.replace(/^[a-f0-9]+\s+/, ''));

  const emojis = ['🚀', '⚡', '🔧'];

  console.log('--- launch post draft ---');
  console.log('');
  console.log(`Atris v${version} is out.`);
  console.log('');
  topChanges.forEach((change, i) => {
    console.log(`${emojis[i] || '•'} ${change}`);
  });
  console.log('');
  console.log('npm i -g atris');
  console.log('--- end launch post ---');
}

function readPackageVersion(cwd) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version.trim() ? pkg.version.trim() : null;
  } catch {
    return null;
  }
}

function runFullTestSuite(cwd) {
  return spawnSync('npm', ['test'], {
    cwd,
    env: { ...process.env, CI: 'true' },
    stdio: 'inherit',
  });
}

function gitStdout(result) {
  return result && result.status === 0 ? String(result.stdout || '').trim() : '';
}

/**
 * atris release preflight
 *
 * Enforced checks before pushing a v* tag from master. Prints pass/fail for
 * each check and exits nonzero if any fail. Skips the test suite when earlier
 * git checks already failed so a bad checkout does not burn a full run.
 */
function releasePreflight({ cwd = process.cwd(), runTests = runFullTestSuite } = {}) {
  let failed = false;

  const branchResult = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const branch = gitStdout(branchResult);
  if (branch === 'master') {
    console.log('pass: current branch is master');
  } else {
    failed = true;
    console.log(`fail: current branch is ${branch || 'unknown'}, need master`);
  }

  const statusResult = runGit(['status', '--porcelain'], cwd);
  if (statusResult.status === 0 && String(statusResult.stdout || '').trim() === '') {
    console.log('pass: working tree is clean');
  } else {
    failed = true;
    console.log('fail: working tree is not clean');
  }

  const localMaster = gitStdout(runGit(['rev-parse', 'master'], cwd));
  const originMaster = gitStdout(runGit(['rev-parse', 'origin/master'], cwd));
  if (!localMaster) {
    failed = true;
    console.log('fail: local master is missing');
  } else if (!originMaster) {
    failed = true;
    console.log('fail: origin/master is missing');
  } else if (localMaster !== originMaster) {
    failed = true;
    console.log('fail: local master does not match origin/master');
  } else {
    console.log('pass: local master matches origin/master');
  }

  const version = readPackageVersion(cwd);
  if (!version) {
    failed = true;
    console.log('fail: package.json version is missing');
  } else {
    const tagName = `v${version}`;
    const tagList = gitStdout(runGit(['tag', '--list', tagName], cwd));
    if (tagList) {
      failed = true;
      console.log(`fail: tag ${tagName} already exists`);
    } else {
      console.log(`pass: no tag ${tagName}`);
    }
  }

  if (failed) {
    console.log('skip: test suite (earlier checks failed)');
  } else {
    const testResult = runTests(cwd);
    if (testResult && testResult.error) {
      failed = true;
      console.log(`fail: test suite could not run (${testResult.error.message})`);
    } else if (testResult && testResult.status === 0) {
      console.log('pass: test suite');
    } else {
      const code = testResult && typeof testResult.status === 'number' ? testResult.status : 1;
      failed = true;
      console.log(`fail: test suite exited ${code}`);
    }
  }

  console.log('');
  console.log(failed ? 'release preflight failed' : 'release preflight passed');
  return failed ? 1 : 0;
}

module.exports = { releaseAtris, releasePreflight, runFullTestSuite };
