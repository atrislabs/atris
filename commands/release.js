const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * atris release [--dry-run] - Tag a release, create GitHub release, draft /launch post
 *
 * - Reads git log since last tag
 * - Determines bump type (minor if any scorecard has reward>=5, else patch)
 * - Bumps package.json version
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

  // 4. Determine bump type — minor if any scorecard has reward >= 5, else patch
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

  // 7. Bump package.json
  const updatedPkgRaw = pkgRaw.replace(
    `"version": "${currentVersion}"`,
    `"version": "${nextVersion}"`
  );
  fs.writeFileSync(pkgPath, updatedPkgRaw);
  console.log(`bumped package.json to ${nextVersion}`);

  // 8. Commit
  execFileSync('git', ['add', 'package.json'], { cwd });
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
    console.log('push failed — you may need to push manually');
  }

  // 11. Create GitHub release via gh
  try {
    execFileSync('gh', ['release', 'create', `v${nextVersion}`,
      '--title', `v${nextVersion}`,
      '--notes', changelog
    ], { cwd });
    console.log(`github release created: v${nextVersion}`);
  } catch (err) {
    console.log('gh release create failed — install gh or create release manually');
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

module.exports = { releaseAtris };
