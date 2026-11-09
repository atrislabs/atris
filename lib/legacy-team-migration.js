const fs = require('fs');
const path = require('path');

// Keep the source intact: it may contain conflicts, links, or files we cannot copy.
function migrateLegacyTeam(source, destination, { dryRun = false, log = console.log } = {}) {
  function statOrNull(file) {
    try { return fs.lstatSync(file); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isDirectory()) {
    const error = new Error(`Legacy team path is not a directory: ${source}`);
    error.code = 'ENOTDIR';
    throw error;
  }
  function walk(src, dest, relative, destinationAbsent = false) {
    const sourceInfo = fs.lstatSync(src);
    const destInfo = destinationAbsent ? null : statOrNull(dest);
    if (sourceInfo.isSymbolicLink() || (!sourceInfo.isDirectory() && !sourceInfo.isFile())) {
      log(`  Skipped ${relative} (unsupported entry; original retained)`);
      return;
    }
    if (sourceInfo.isDirectory()) {
      if (destInfo && (!destInfo.isDirectory() || destInfo.isSymbolicLink())) {
        log(`  Skipped ${relative || 'team/'} (destination conflict; original retained)`);
        return;
      }
      if (!destInfo && !dryRun) fs.mkdirSync(dest);
      for (const entry of fs.readdirSync(src)) {
        walk(path.join(src, entry), path.join(dest, entry), path.join(relative, entry), !destInfo && dryRun);
      }
      return;
    }
    if (destInfo) {
      log(`  Skipped ${relative} (destination exists; original retained)`);
      return;
    }
    if (!dryRun) {
      // Stage on the same filesystem and publish with an exclusive hard link.
      // A failed copy never leaves a partial file at the destination.
      const stagingDir = fs.mkdtempSync(path.join(path.dirname(dest), '.atris-migration-'));
      const staged = path.join(stagingDir, 'file');
      try {
        fs.copyFileSync(src, staged, fs.constants.COPYFILE_EXCL);
        try { fs.linkSync(staged, dest); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          log(`  Skipped ${relative} (destination exists; original retained)`);
          return;
        }
      } finally {
        try { fs.unlinkSync(staged); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        fs.rmdirSync(stagingDir);
      }
    }
    log(`  ${dryRun ? 'Would migrate' : '✓ Migrated'} ${relative}`);
  }
  walk(source, destination, '');
  log('  Legacy agent_team/ retained');
}
module.exports = { migrateLegacyTeam };
