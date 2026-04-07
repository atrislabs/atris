const path = require('path');
const {
  WIKI_ROOT,
  ensureWikiScaffold,
  readWikiPages,
  findStaleWikiPages,
  findWikiOrphans,
  findSuggestedSources,
  writeWikiStatus,
  appendWikiLog,
} = require('../lib/wiki');

function formatPageList(items, limit = 3) {
  return items.slice(0, limit).map((item) => item.page || item);
}

function buildReport(projectRoot = process.cwd(), limit = 3) {
  ensureWikiScaffold(projectRoot);
  const pages = readWikiPages(projectRoot);
  const stalePages = findStaleWikiPages(projectRoot);
  const orphanPages = findWikiOrphans(projectRoot);
  const nextSources = findSuggestedSources(projectRoot, limit);

  let health = 'wiki is in good shape';
  let nextMove = 'run `atris query "..."` or ingest a new source';

  if (stalePages.length > 0) {
    health = `${stalePages.length} stale page${stalePages.length === 1 ? '' : 's'} need recompiling`;
    nextMove = `recompile ${stalePages[0].page} from ${stalePages[0].staleSource}`;
  } else if (orphanPages.length > 0) {
    health = `${orphanPages.length} orphan page${orphanPages.length === 1 ? '' : 's'} need linking or index coverage`;
    nextMove = `link or index ${orphanPages[0]}`;
  } else if (nextSources.length > 0) {
    health = `wiki is stable, ${nextSources.length} high-value source${nextSources.length === 1 ? '' : 's'} ready for ingest`;
    nextMove = `ingest ${nextSources[0]}`;
  }

  return {
    wikiDir: path.join(projectRoot, WIKI_ROOT),
    pageCount: pages.length,
    stalePages,
    orphanPages,
    nextSources,
    health,
    nextMove,
    details: [
      `pages=${pages.length}`,
      `stale=${stalePages.length}`,
      `orphans=${orphanPages.length}`,
      `suggested=${nextSources.length}`,
    ],
  };
}

function printReport(report) {
  console.log('');
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log('│ Wiki Loop                                                   │');
  console.log('├─────────────────────────────────────────────────────────────┤');
  const summary = `Pages: ${report.pageCount} | Stale: ${report.stalePages.length} | Orphans: ${report.orphanPages.length} | Next: ${report.nextSources.length}`;
  console.log(`│ ${summary.padEnd(59)} │`);
  console.log('└─────────────────────────────────────────────────────────────┘');
  console.log('');
  console.log(`Health: ${report.health}`);
  console.log(`Next move: ${report.nextMove}`);
  if (report.stalePages.length > 0) {
    console.log('');
    console.log('Stale pages:');
    formatPageList(report.stalePages).forEach((page) => console.log(`- ${page}`));
  }
  if (report.orphanPages.length > 0) {
    console.log('');
    console.log('Orphans:');
    formatPageList(report.orphanPages).forEach((page) => console.log(`- ${page}`));
  }
  if (report.nextSources.length > 0) {
    console.log('');
    console.log('Next ingest candidates:');
    report.nextSources.forEach((source) => console.log(`- ${source}`));
  }
  console.log('');
}

async function loopAtris(args = []) {
  const dryRun = args.includes('--dry-run');
  const json = args.includes('--json');
  const limitArg = args.find((arg) => arg.startsWith('--limit='));
  const limit = limitArg ? Math.max(1, parseInt(limitArg.split('=')[1], 10) || 3) : 3;

  const report = buildReport(process.cwd(), limit);

  if (!dryRun) {
    writeWikiStatus(process.cwd(), report);
    appendWikiLog(
      process.cwd(),
      `${report.pageCount} pages, ${report.stalePages.length} stale, ${report.orphanPages.length} orphan, ${report.nextSources.length} suggested`,
      report.stalePages.slice(0, 3).map((item) => `stale ${item.page} <- ${item.staleSource}`)
        .concat(report.orphanPages.slice(0, 3).map((item) => `orphan ${item}`))
        .concat(report.nextSources.slice(0, 3).map((item) => `next ingest ${item}`))
    );
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printReport(report);
}

module.exports = {
  loopAtris,
  buildReport,
};
