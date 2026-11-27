const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

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

function version(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

function revisionTarget(root, folder) {
  const target = path.resolve(root, fs.readFileSync(path.join(folder, 'path'), 'utf8'));
  if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error('Invalid pending merge path');
  return target;
}

function surfaceLateSaves(root) {
  const history = path.join(root, '.atris', 'sync', 'local-revisions');
  if (!fs.existsSync(history)) return;
  for (const entry of fs.readdirSync(history, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(history, entry.name);
    const original = path.join(folder, 'original');
    const stateFile = path.join(folder, 'observed');
    if (!fs.existsSync(stateFile)) continue;
    const [previousHash, previousVersion] = fs.readFileSync(stateFile, 'utf8').split('\n');
    const before = fs.lstatSync(original, { bigint: true });
    if (!before.isFile() || version(before) === previousVersion) continue;
    const data = fs.readFileSync(original);
    if (version(before) !== version(fs.lstatSync(original, { bigint: true }))) continue;
    const currentHash = createHash('sha256').update(data).digest('hex');
    if (currentHash !== previousHash) {
      const target = revisionTarget(root, folder);
      const current = fs.lstatSync(target, { bigint: true, throwIfNoEntry: false });
      if (!current || current.dev !== before.dev || current.ino !== before.ino) {
        // Editors may write through an old descriptor even after an atomic save. Put that
        // version beside the current file so the next normal push shares both.
        let recovered = target + '.recovered-' + currentHash + path.extname(target);
        if (Buffer.byteLength(path.basename(recovered)) > 255) {
          recovered = path.join(path.dirname(target), 'recovered-' + entry.name + '-' + currentHash);
        }
        fs.mkdirSync(path.dirname(recovered), { recursive: true });
        const options = { flag: 'wx', mode: Number(before.mode & 0o777n) };
        try {
          fs.writeFileSync(recovered, data, options);
        } catch (error) {
          if (error.code !== 'EEXIST' && error.code !== 'ENAMETOOLONG') throw error;
          if (error.code === 'ENAMETOOLONG' || !fs.readFileSync(recovered).equals(data)) {
            recovered = path.join(fs.mkdtempSync(path.join(root, 'recovered-')), 'revision');
            fs.writeFileSync(recovered, data, options);
          }
        }
        console.log('  Recovered a later editor save in ' + path.relative(root, recovered));
      }
    }
    fs.writeFileSync(stateFile, currentHash + '\n' + version(before));
  }
}

function recoverInterruptedMerges(root) {
  surfaceLateSaves(root);
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
    const target = revisionTarget(root, folder);
    restoreIfMissing(original, target);
    archive(root, folder);
  }
}

function installLocalMerge(root, target, expectedHash, merged) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') return merged === null;
    throw error;
  }
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
    fs.writeFileSync(path.join(folder, 'observed'), expectedHash ?? '');
    fs.writeFileSync(candidate, merged ?? '', { mode: stat.mode & 0o777 });
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
    if (!fs.lstatSync(original).isFile() || createHash('sha256').update(fs.readFileSync(original)).digest('hex') !== expectedHash) {
      return false;
    }
    if (merged === null) {
      installed = true;
      return !fs.existsSync(target);
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
