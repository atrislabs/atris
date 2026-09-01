// atris site — turn a folder of markdown (docs, your wiki, memory) into a
// beautiful, navigable static site in the design system. Built on lib/site.js.
//
//   atris site <dir|doc.md> [--out dist] [--theme atris|terminal|paper] [--title T] [--serve]
//   atris site publish <dir> --slug <slug> [--profile strict|app] [--spa] [--no-claim] [--build] [--json]

const { buildSite, serveSite } = require('../lib/site');
const { hasFlag } = require('../lib/arg-parser');

function flag(argv, name) { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] : null; }

async function run(argv) {
  if (argv[0] === 'publish') {
    return require('../lib/site-publish').run(argv.slice(1));
  }
  if (argv[0] === 'deploy') {
    return require('./site-deploy').run(argv.slice(1));
  }

  const input = argv.find((a) => !a.startsWith('-'));
  if (!input || input === 'help' || hasFlag(argv, '--help')) {
    console.log(`
  atris site: build markdown sites or deploy web folders

    atris site <dir|doc.md> [--out dist] [--theme atris|terminal|paper] [--title T]
    atris site atris/wiki --title "Atris Wiki" --serve
    atris site publish <dir> --slug <slug> [--profile strict|app] [--spa] [--no-claim] [--build] [--json]
    atris site deploy <dir> --name <slug> [--spa] [--dry-run] --yes
    atris site deploy <dir> --fullstack --name <slug> [--dry-run] --yes

  Each .md becomes a page; an index links them all. Same anti-slop design system,
  semantic data-atris-block sections, ready for the web app. --serve previews it.

  publish uploads any built web folder through the hosted-sites api. deploy is
  the older site setup flow; --fullstack deploys a node server with render.
`);
    return input === 'help' || hasFlag(argv, '--help') ? 0 : 2;
  }

  let res;
  try {
    res = buildSite(input, {
      out: flag(argv, '--out') || 'dist',
      theme: flag(argv, '--theme'),
      title: flag(argv, '--title'),
      brand: flag(argv, '--brand'),
    });
  } catch (e) { console.error(`  ${e.message}`); return 2; }

  console.log(`\n  ✓ site built: ${res.pages.length} page${res.pages.length === 1 ? '' : 's'} + index -> ${res.outDir}/`);
  console.log(`    open ${res.indexPath}`);

  if (hasFlag(argv, '--serve')) {
    const port = Number(flag(argv, '--port')) || 4321;
    const { url } = await serveSite(res.outDir, port);
    console.log(`\n  serving at ${url} (ctrl-c to stop)\n`);
    await new Promise(() => {}); // keep alive until killed
  }
  return 0;
}

module.exports = { run };
