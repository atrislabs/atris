const fs = require('fs');
const path = require('path');
const { loadCredentials } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');
const { loadBusinesses, saveBusinesses } = require('./business');
const {
  WIKI_ROOT,
  PRIVATE_WIKI_ROOT,
  getWikiRoot,
  ensureWikiScaffold,
  ensureContextScaffold,
  findLocalWikiDir,
  stageWikiIngest,
  buildIngestPrompt,
  buildQueryPrompt,
  buildLintPrompt,
  writeWikiStatus,
  appendWikiLog,
  validateAgentReadableWikiPages,
} = require('../lib/wiki');

function autoDetectSlug() {
  const bizFile = path.join(process.cwd(), '.atris', 'business.json');
  if (!fs.existsSync(bizFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(bizFile, 'utf8')).slug || null;
  } catch {
    return null;
  }
}

function parseCloudArgs(args) {
  if (args.length >= 2 && /^[a-z][a-z0-9-]*$/i.test(args[0])) {
    return [args[0], args.slice(1).join(' ')];
  }
  return [autoDetectSlug(), args.join(' ')];
}

function parseModeArgs(args) {
  const cloud = args.includes('--cloud');
  const privateMode = args.includes('--private');
  if (cloud && privateMode) {
    console.error('Use either --cloud or --private, not both.');
    process.exit(1);
  }
  return {
    mode: cloud ? 'cloud' : (privateMode ? 'private' : 'local'),
    args: args.filter((arg) => arg !== '--cloud' && arg !== '--local' && arg !== '--private'),
  };
}

function requireCreds() {
  const creds = loadCredentials();
  if (!creds?.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }
  return creds;
}

async function resolveBusiness(slug, token) {
  if (!slug) {
    console.error('No business specified. Pass <slug> or run from a workspace folder.');
    process.exit(1);
  }

  const cache = loadBusinesses();
  const list = await apiRequestJson('/business/', { method: 'GET', token });
  if (list.ok) {
    const match = (list.data || []).find((business) => business.slug === slug || business.name?.toLowerCase() === slug.toLowerCase());
    if (!match) {
      console.error(`Business "${slug}" not found.`);
      process.exit(1);
    }
    cache[slug] = {
      business_id: match.id,
      workspace_id: match.workspace_id,
      name: match.name,
      slug: match.slug,
      added_at: new Date().toISOString(),
    };
    saveBusinesses(cache);
    return match;
  }

  if (cache[slug]) {
    return {
      id: cache[slug].business_id,
      workspace_id: cache[slug].workspace_id,
      name: cache[slug].name || slug,
    };
  }

  console.error(`Failed to reach API and no cached business for "${slug}".`);
  process.exit(1);
}

async function runChat(business, prompt, token) {
  const start = await apiRequestJson(`/business/${business.id}/chat`, {
    method: 'POST',
    token,
    body: { message: prompt, workspace_id: business.workspace_id },
  });

  if (!start.ok) {
    console.error(`Chat failed: ${start.error || start.status}`);
    process.exit(1);
  }

  const executionId = start.data?.execution_id;
  if (!executionId) {
    console.error('No execution_id from server.');
    process.exit(1);
  }

  let fromIndex = 0;
  let errors = 0;
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const events = await apiRequestJson(
      `/business/${business.id}/chat/events?execution_id=${executionId}&workspace_id=${business.workspace_id}&from_index=${fromIndex}`,
      { method: 'GET', token, timeoutMs: 60000 }
    );

    if (!events.ok) {
      if (++errors >= 5) {
        console.error('\nLost connection to AI computer.');
        return;
      }
      continue;
    }

    errors = 0;
    let done = false;
    for (const event of (events.data?.events || [])) {
      fromIndex++;
      if (event.type === 'assistant_text' && event.content) {
        process.stdout.write(event.content);
      } else if (event.type === 'tool_use' && event.tool) {
        const argument = event.input?.file_path || event.input?.path || event.input?.pattern || event.input?.command || '';
        if (argument) {
          console.log(`\n  [${event.tool}] ${String(argument).slice(0, 100)}`);
        }
      } else if (event.type === 'complete' || event.type === 'error') {
        done = true;
        break;
      }
    }

    if (done || ['completed', 'error'].includes(events.data?.status)) {
      console.log('');
      return;
    }
  }
}

function printLocalPrompt(title, prompt, wikiRoot, details = []) {
  console.log('');
  console.log(title);
  console.log(`Target: ${wikiRoot}`);
  details.forEach((detail) => console.log(detail));
  console.log('');
  console.log('Prompt for the current coding agent:');
  console.log('');
  console.log(prompt);
  console.log('');
}

function hasHelpFlag(args) {
  return args.includes('--help') || args.includes('-h') || args[0] === 'help';
}

function printWikiHelp(scope = null) {
  const normalized = scope === 'ingest' || scope === 'query' || scope === 'lint' || scope === 'search' || scope === 'log' || scope === 'loop' || scope === 'verify'
    ? scope
    : null;

  console.log('');
  if (normalized === 'ingest') {
    console.log('Usage: atris ingest <path>');
    console.log('Usage: atris wiki ingest [--private|--cloud] [business] <path>');
    console.log('');
    console.log('Stage source files into the local wiki context pack.');
  } else if (normalized === 'query') {
    console.log('Usage: atris query "question"');
    console.log('Usage: atris wiki query [--private|--cloud] [business] "question"');
    console.log('');
    console.log('Build a local or cloud wiki query prompt.');
  } else if (normalized === 'lint') {
    console.log('Usage: atris lint');
    console.log('Usage: atris wiki lint [--private|--cloud] [business]');
    console.log('');
    console.log('Build a local or cloud wiki lint prompt.');
  } else {
    console.log('Usage: atris wiki <ingest|query|lint|search|log|loop|verify|entities|related> [business] [args]');
    console.log('');
    console.log('  ingest <path>                 Local-first ingest into atris/wiki/');
    console.log('  query  "question"             Local-first query against atris/wiki/');
    console.log('  lint                          Local-first lint for atris/wiki/');
    console.log('  search [business] <term>      Search local atris/wiki/index.md');
    console.log('  log    [business] [N]         Show recent atris/wiki/log.md entries');
    console.log('  loop                          Run local wiki upkeep analysis and refresh STATUS/log');
    console.log('  verify                        Check agent-readable source/verification metadata');
    console.log('  entities [--type T] [--json]  List extracted graph entities');
    console.log('  related <entity> [--json]     List graph relationships touching entity');
  }
  console.log('');
  console.log('Flags:');
  console.log('  --cloud                       Route ingest/query/lint to the cloud workspace');
  console.log('  --local                       Be explicit about local mode');
  console.log(`  --private                     Use local private wiki at ${PRIVATE_WIKI_ROOT}/`);
  console.log('  --help, -h                    Show this help');
  console.log('');
  console.log('Business is auto-detected from .atris/business.json for cloud mode if omitted.');
  console.log('');
}

function hasFlag(args, name) {
  return args.includes(name);
}

function optionValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 >= args.length) return fallback;
  return args[index + 1];
}

function printJsonOrText(payload, lines, asJson) {
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  lines.forEach((line) => console.log(line));
}

function readWikiGraph(root = process.cwd()) {
  const graphPath = path.join(root, 'atris', 'wiki', '.graph.json');
  if (!fs.existsSync(graphPath)) {
    return { graphPath, graph: { schema: 'atris.wiki_graph.v1', entities: [], relationships: [] } };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
    return {
      graphPath,
      graph: {
        schema: parsed.schema || 'atris.wiki_graph.v1',
        updated_at: parsed.updated_at || null,
        entities: Array.isArray(parsed.entities) ? parsed.entities : [],
        relationships: Array.isArray(parsed.relationships) ? parsed.relationships : [],
      },
    };
  } catch {
    return { graphPath, graph: { schema: 'atris.wiki_graph.v1', entities: [], relationships: [] } };
  }
}

function wikiEntities(args = []) {
  const asJson = hasFlag(args, '--json');
  const type = optionValue(args, '--type', null);
  const { graphPath, graph } = readWikiGraph();
  const entities = type ? graph.entities.filter((entity) => entity.type === type) : graph.entities;
  printJsonOrText(
    { ok: true, action: 'entities', graph_path: graphPath, type: type || null, entities },
    entities.length
      ? entities.map((entity) => `${entity.type || 'concept'}\t${entity.name}`)
      : ['No wiki graph entities found. Run: atris member wake wiki-miner --execute'],
    asJson,
  );
}

function wikiRelated(args = []) {
  const asJson = hasFlag(args, '--json');
  const entity = args.filter((arg) => arg !== '--json')[0] || '';
  if (!entity) {
    console.error('Usage: atris wiki related <entity>');
    process.exit(1);
  }
  const wanted = entity.toLowerCase();
  const { graphPath, graph } = readWikiGraph();
  const related = graph.relationships
    .filter((relationship) => String(relationship.from || '').toLowerCase() === wanted || String(relationship.to || '').toLowerCase() === wanted)
    .slice(0, 5);
  printJsonOrText(
    { ok: true, action: 'related', graph_path: graphPath, entity, relationships: related },
    related.length
      ? related.map((relationship) => `${relationship.from} -[${relationship.type}]-> ${relationship.to}`)
      : [`No wiki graph relationships found for "${entity}".`],
    asJson,
  );
}

async function wikiIngest(mode, slug, sourceValue) {
  if (!sourceValue) {
    console.error('Usage: atris wiki ingest [business] <path>');
    process.exit(1);
  }

  if (mode === 'local' || mode === 'private') {
    const wikiMode = mode === 'private' ? 'private' : 'public';
    const wikiDir = ensureWikiScaffold(process.cwd(), wikiMode);
    const contextDir = ensureContextScaffold(process.cwd(), wikiMode);
    const staged = stageWikiIngest(process.cwd(), sourceValue, wikiMode);
    writeWikiStatus(process.cwd(), {
      health: `ingest staged from ${staged.packPath}`,
      nextMove: `compile ${staged.promptSource} into ${getWikiRoot(wikiMode)}`,
    }, wikiMode, { lastIngest: staged.manifest.ingested_at });
    appendWikiLog(
      process.cwd(),
      `${staged.manifest.entries.length} source item(s) staged from ${sourceValue}`,
      [
        `context ${contextDir}`,
        `pack ${staged.packPath}`,
        `manifest ${staged.manifestPath}`,
        ...staged.manifest.entries.map((entry) => `${entry.kind} ${entry.staged}`),
      ],
      wikiMode,
      'INGEST'
    );
    printLocalPrompt(mode === 'private' ? 'Private wiki ingest' : 'Local wiki ingest', buildIngestPrompt(staged.promptSource, wikiMode), getWikiRoot(wikiMode), [
      `Wiki dir: ${wikiDir}`,
      `Context dir: ${contextDir}`,
      `Pack: ${staged.packPath}`,
      `Manifest: ${staged.manifestPath}`,
      `Sources: ${staged.promptSource}`,
    ]);
    return;
  }

  const creds = requireCreds();
  const business = await resolveBusiness(slug, creds.token);
  console.log(`\nIngesting ${sourceValue} into ${business.name}...\n`);
  await runChat(business, buildIngestPrompt(sourceValue), creds.token);
  console.log('\nDone. Run `atris pull --only wiki` to sync atris/wiki locally.');
}

async function wikiQuery(mode, slug, question) {
  if (!question) {
    console.error('Usage: atris wiki query [business] "question"');
    process.exit(1);
  }

  if (mode !== 'cloud') {
    const wikiMode = mode === 'private' ? 'private' : 'public';
    const wikiDir = findLocalWikiDir(process.cwd(), slug, wikiMode);
    if (!wikiDir) {
      console.error(`No local wiki found at ${getWikiRoot(wikiMode)}. Run: atris wiki ingest${wikiMode === 'private' ? ' --private' : ''} <path>`);
      process.exit(1);
    }
    printLocalPrompt(mode === 'private' ? 'Private wiki query' : 'Local wiki query', buildQueryPrompt(question, wikiMode), getWikiRoot(wikiMode), [
      `Wiki dir: ${wikiDir}`,
      `Question: ${question}`,
    ]);
    return;
  }

  const creds = requireCreds();
  const business = await resolveBusiness(slug, creds.token);
  await runChat(business, buildQueryPrompt(question), creds.token);
}

async function wikiLint(mode, slug) {
  if (mode !== 'cloud') {
    const wikiMode = mode === 'private' ? 'private' : 'public';
    const wikiDir = findLocalWikiDir(process.cwd(), slug, wikiMode);
    if (!wikiDir) {
      console.error(`No local wiki found at ${getWikiRoot(wikiMode)}. Run: atris wiki ingest${wikiMode === 'private' ? ' --private' : ''} <path>`);
      process.exit(1);
    }
    printLocalPrompt(mode === 'private' ? 'Private wiki lint' : 'Local wiki lint', buildLintPrompt(wikiMode), getWikiRoot(wikiMode), [`Wiki dir: ${wikiDir}`]);
    return;
  }

  const creds = requireCreds();
  const business = await resolveBusiness(slug, creds.token);
  console.log(`\nLinting ${business.name} wiki...\n`);
  await runChat(business, buildLintPrompt(), creds.token);
}

function wikiSearch(mode, slug, query) {
  if (!query) {
    console.error('Usage: atris wiki search [business] <term>');
    process.exit(1);
  }

  const wikiMode = mode === 'private' ? 'private' : 'public';
  const wikiDir = findLocalWikiDir(process.cwd(), slug, wikiMode);
  if (!wikiDir) {
    console.error(`No local wiki found at ${getWikiRoot(wikiMode)}.`);
    process.exit(1);
  }

  const indexPath = path.join(wikiDir, 'index.md');
  if (!fs.existsSync(indexPath)) {
    console.error('No wiki index found. Run an ingest first.');
    process.exit(1);
  }

  const lowered = query.toLowerCase();
  const matches = fs.readFileSync(indexPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().startsWith('-') && line.toLowerCase().includes(lowered));

  if (matches.length === 0) {
    console.log(`No matches for "${query}".`);
    return;
  }

  console.log(`\n${matches.length} match${matches.length === 1 ? '' : 'es'}:\n`);
  matches.forEach((match) => console.log(match));
  console.log('');
}

function wikiLog(mode, slug, limit) {
  const wikiMode = mode === 'private' ? 'private' : 'public';
  const wikiDir = findLocalWikiDir(process.cwd(), slug, wikiMode);
  if (!wikiDir) {
    console.error(`No local wiki found at ${getWikiRoot(wikiMode)}.`);
    process.exit(1);
  }

  const logPath = path.join(wikiDir, 'log.md');
  if (!fs.existsSync(logPath)) {
    console.log('No wiki log yet.');
    return;
  }

  const lines = fs.readFileSync(logPath, 'utf8').split('\n');
  const entries = lines.filter((line) => /^## \d{4}-\d{2}-\d{2}/.test(line) || /^- \d{1,2}:\d{2}/.test(line) || /^  - /.test(line));
  if (entries.length === 0) {
    console.log('No wiki log entries yet.');
    return;
  }

  const output = [];
  let bullets = 0;
  let firstIndex = entries.length;
  for (let index = entries.length - 1; index >= 0; index--) {
    if (bullets >= limit && /^- /.test(entries[index])) break;
    output.unshift(entries[index]);
    firstIndex = index;
    if (/^- /.test(entries[index])) bullets++;
  }

  if (output.length > 0 && !/^## /.test(output[0])) {
    for (let index = firstIndex - 1; index >= 0; index--) {
      if (/^## /.test(entries[index])) {
        output.unshift(entries[index]);
        break;
      }
    }
  }

  console.log('');
  output.forEach((line) => console.log(line));
  console.log('');
}

function wikiVerify(mode, slug) {
  const wikiMode = mode === 'private' ? 'private' : 'public';
  const wikiDir = findLocalWikiDir(process.cwd(), slug, wikiMode);
  if (!wikiDir) {
    console.error(`No local wiki found at ${getWikiRoot(wikiMode)}.`);
    process.exit(1);
  }

  const report = validateAgentReadableWikiPages(process.cwd(), wikiMode);
  console.log('');
  console.log(`Agent-readable wiki contract: ${report.ok ? 'pass' : 'fail'}`);
  console.log(`  pages: ${report.pageCount}`);
  console.log(`  findings: ${report.findingCount}`);
  if (!report.ok) {
    for (const finding of report.findings.slice(0, 20)) {
      console.log(`  - ${finding.page}: ${finding.code} - ${finding.message}`);
    }
    if (report.findings.length > 20) {
      console.log(`  ... +${report.findings.length - 20} more`);
    }
    console.log('');
    process.exit(1);
  }
  console.log('');
}

async function wikiCommand(subcommand, ...args) {
  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h' || hasHelpFlag(args)) {
    printWikiHelp(subcommand);
    return;
  }

  const { mode, args: cleanArgs } = parseModeArgs(args);

  switch (subcommand) {
    case 'entities': {
      wikiEntities(cleanArgs);
      break;
    }
    case 'related': {
      wikiRelated(cleanArgs);
      break;
    }
    case 'ingest': {
      const [slug, sourceValue] = mode === 'cloud' ? parseCloudArgs(cleanArgs) : [null, cleanArgs.join(' ')];
      await wikiIngest(mode, slug, sourceValue);
      break;
    }
    case 'query': {
      const [slug, question] = mode === 'cloud' ? parseCloudArgs(cleanArgs) : [null, cleanArgs.join(' ')];
      await wikiQuery(mode, slug, question);
      break;
    }
    case 'lint': {
      const slug = mode === 'cloud' ? (cleanArgs[0] || autoDetectSlug()) : null;
      await wikiLint(mode, slug);
      break;
    }
    case 'search': {
      if (mode === 'private') {
        wikiSearch(mode, null, cleanArgs.join(' '));
      } else {
        const [slug, query] = parseCloudArgs(cleanArgs);
        wikiSearch(mode, slug, query);
      }
      break;
    }
    case 'log': {
      let slug;
      let limit;
      if (mode === 'private') {
        slug = null;
        limit = parseInt(cleanArgs[0], 10) || 20;
      } else if (cleanArgs.length === 0) {
        slug = autoDetectSlug();
        limit = 20;
      } else if (cleanArgs.length === 1) {
        if (/^\d+$/.test(cleanArgs[0])) {
          slug = autoDetectSlug();
          limit = parseInt(cleanArgs[0], 10);
        } else {
          slug = cleanArgs[0];
          limit = 20;
        }
      } else {
        slug = cleanArgs[0];
        limit = parseInt(cleanArgs[1], 10) || 20;
      }
      wikiLog(mode, slug, limit);
      break;
    }
    case 'loop': {
      if (mode === 'cloud') {
        console.error('Cloud loop is not implemented yet. Run local `atris loop` first.');
        process.exit(1);
      }
      const { loopAtris } = require('./loop');
      await loopAtris(cleanArgs);
      break;
    }
    case 'verify':
    case 'contract': {
      const slug = mode === 'cloud' ? (cleanArgs[0] || autoDetectSlug()) : null;
      if (mode === 'cloud') {
        console.error('Cloud wiki verify is local-first. Run after `atris pull --only atris/wiki --no-manifest` or inside a workspace.');
        process.exit(1);
      }
      wikiVerify(mode, slug);
      break;
    }
    default:
      printWikiHelp();
  }
}

module.exports = {
  wikiCommand,
  wikiIngest,
  wikiQuery,
  wikiLint,
  wikiSearch,
  wikiLog,
  wikiVerify,
  wikiEntities,
  wikiRelated,
};
