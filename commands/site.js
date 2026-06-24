// atris site — turn a folder of markdown (docs, your wiki, memory) into a
// beautiful, navigable static site in the design system. Built on lib/site.js.
//
//   atris site <dir|doc.md> [--out dist] [--theme atris|terminal|paper] [--title T] [--serve]

const { buildSite, serveSite } = require('../lib/site');

function flag(argv, name) { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] : null; }
function hasFlag(argv, name) { return argv.includes(name); }

async function run(argv) {
  const input = argv.find((a) => !a.startsWith('-'));
  if (!input || input === 'help' || hasFlag(argv, '--help')) {
    console.log(`
  atris site — a beautiful static site from a folder of markdown

    atris site <dir|doc.md> [--out dist] [--theme atris|terminal|paper] [--title T]
    atris site atris/wiki --title "Atris Wiki" --serve

  Each .md becomes a page; an index links them all. Same anti-slop design system,
  semantic data-atris-block sections, ready for the web app. --serve previews it.
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
