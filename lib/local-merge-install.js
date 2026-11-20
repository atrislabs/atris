const fs = require('fs');
const path = require('path');

function restoreIfMissing(original, target) {
  try {
    fs.linkSync(original, target);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

// Keep the displaced inode: an editor can still hold it open for an in-place save.
function archive(root, folder) {
  const history = path.join(root, '.atris', 'sync', 'local-revisions');
  fs.mkdirSync(history, { recursive: true });
  fs.renameSync(folder, path.join(history, path.basename(folder)));
}

function recoverInterruptedMerges(root) {
  const pending = path.join(root, '.atris', 'sync', 'pending-merges');
  if (!fs.existsSync(pending)) return;
  for (const entry of fs.readdirSync(pending, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+-[a-zA-Z0-9]+$/.test(entry.name)) continue;
    const owner = Number(entry.name.split('-')[0]);
    try {
      process.kill(owner, 0);
      continue;
    } catch (error) {
      if (error.code !== 'ESRCH') continue;
    }
    const folder = path.join(pending, entry.name);
    const original = path.join(folder, 'original');
    if (!fs.existsSync(original)) continue;
    const target = path.resolve(root, fs.readFileSync(path.join(folder, 'path'), 'utf8'));
    if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error('Invalid pending merge path');
    restoreIfMissing(original, target);
    archive(root, folder);
  }
}

function installLocalMerge(root, target, expected, merged) {
  const stat = fs.lstatSync(target);
  if (!stat.isFile()) return false;
  const pending = path.join(root, '.atris', 'sync', 'pending-merges');
  fs.mkdirSync(pending, { recursive: true });
  const folder = fs.mkdtempSync(path.join(pending, process.pid + '-'));
  const original = path.join(folder, 'original');
  const candidate = path.join(folder, 'candidate');
  let displaced = false;
  let installed = false;
  try {
    fs.writeFileSync(path.join(folder, 'path'), path.relative(root, target));
    fs.writeFileSync(candidate, merged, { mode: stat.mode & 0o777 });
    fs.chmodSync(candidate, stat.mode & 0o777);
    // Check hard-link support before displacing anything on this volume.
    const probe = path.join(folder, 'link-probe');
    try {
      fs.linkSync(candidate, probe);
      fs.unlinkSync(probe);
    } catch (error) {
      if (['EPERM', 'EOPNOTSUPP', 'ENOTSUP', 'ENOSYS'].includes(error.code)) return false;
      throw error;
    }
    // A missing target or an unsupported cross-device rename leaves the editor's file intact.
    try {
      fs.renameSync(target, original);
    } catch (error) {
      if (['ENOENT', 'EXDEV'].includes(error.code)) return false;
      throw error;
    }
    displaced = true;
    if (!fs.lstatSync(original).isFile() || !fs.readFileSync(original).equals(Buffer.from(expected))) {
      return false;
    }
    try {
      // Exclusive installation also preserves an editor's replacement saved after our rename.
      fs.linkSync(candidate, target);
      installed = true;
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      throw error;
    }
    return true;
  } finally {
    if (displaced) {
      if (!installed) restoreIfMissing(original, target);
      fs.unlinkSync(candidate);
      archive(root, folder);
    } else {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  }
}

module.exports = { installLocalMerge, recoverInterruptedMerges };
