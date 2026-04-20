const path = require('path');
const os = require('os');

// Returns a human-readable reason string if `dir` is a path we must never
// treat as an Atris workspace root (pull/push would walk and mutate it).
// Returns null if the dir is safe.
//
// The real bug this guards against: if outputDir resolves to $HOME, pull's
// force mirror sweep walks ~/Library, ~/Documents, ~/Downloads, ... and
// deletes any local file not on cloud. That wipes the user's home dir.
function dangerousWorkspaceReason(dir) {
  if (!dir) return 'empty path';
  const abs = path.resolve(dir);
  const home = os.homedir();
  const rootParsed = path.parse(abs).root;

  if (abs === home) return 'your home directory';
  if (abs === rootParsed) return 'the filesystem root';
  if (abs === path.dirname(home)) return `the users root (${path.dirname(home)})`;

  const systemPaths = [
    '/tmp', '/var', '/etc', '/usr', '/bin', '/sbin', '/opt',
    '/private', '/Library', '/Applications', '/System', '/Volumes',
    '/Users', '/home', '/root',
  ];
  for (const p of systemPaths) {
    if (abs === p) return `the system path ${p}`;
  }

  // Reserved top-level folders inside the user's home — never workspaces.
  const homeReservedNames = new Set([
    'Library', 'Applications', 'Documents', 'Downloads', 'Desktop',
    'Pictures', 'Music', 'Movies', 'Public', 'Sites', 'Dropbox',
    'OneDrive', 'iCloud Drive',
  ]);
  if (path.dirname(abs) === home && homeReservedNames.has(path.basename(abs))) {
    return `a reserved home folder (~/${path.basename(abs)})`;
  }

  return null;
}

// Pick a safe fallback directory for a business workspace when the
// originally-resolved path is dangerous. Prefers cwd/slug, falls back to
// ~/atris-workspaces/slug if cwd itself is unsafe.
function safeFallbackDir(slug, cwd) {
  const cwdFallback = path.join(cwd, slug);
  if (!dangerousWorkspaceReason(cwdFallback)) return cwdFallback;
  return path.join(os.homedir(), 'atris-workspaces', slug);
}

// Resolve an outputDir, auto-relocating to a safe fallback if the originally
// chosen path is dangerous. Non-technical users don't need to know about
// mkdir/cd — atris picks a safe folder and tells them where it landed.
function resolveSafeOutputDir(requested, { slug, cwd = process.cwd(), op = 'use' } = {}) {
  const reason = dangerousWorkspaceReason(requested);
  if (!reason) return { dir: path.resolve(requested), relocated: false };

  const fallback = safeFallbackDir(slug, cwd);
  console.log('');
  console.log(`  ${requested} is ${reason} — not safe to ${op}.`);
  console.log(`  Using ${fallback} instead.`);
  console.log('');
  return { dir: fallback, relocated: true, originalReason: reason };
}

// Hard-refuse variant — used by push where we can't auto-relocate (the
// source has to be where the user actually has their files).
function assertSafeWorkspaceRoot(dir, { slug, op } = {}) {
  const reason = dangerousWorkspaceReason(dir);
  if (!reason) return;
  const label = op || 'operate on';
  console.error('');
  console.error(`  Refusing to ${label} ${dir} (${reason}).`);
  console.error('');
  console.error('  Atris would walk this folder and sync files inside it.');
  console.error('  Cd into a dedicated workspace folder first.');
  if (slug) console.error(`  For example:  mkdir -p ~/code/${slug} && cd ~/code/${slug}`);
  process.exit(1);
}

module.exports = {
  dangerousWorkspaceReason,
  safeFallbackDir,
  resolveSafeOutputDir,
  assertSafeWorkspaceRoot,
};
