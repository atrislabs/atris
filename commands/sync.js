const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { stateHome } = require('../lib/state-home');
const { ensureWikiScaffold } = require('../lib/wiki');
const { upsertAtrisClaudeBootBlock } = require('../lib/claude-boot-block');
const { openingLinesForRoot, upsertAgentsOpeningLines } = require('../lib/opening-lines');
const { ensureRunIgnore } = require('../lib/gitignore');
const {
  upsertAgentVoiceCard,
  upsertClaudeVoiceHook,
  upsertCursorVoiceCard,
  voiceCardForRoot,
} = require('../lib/voice-card');
const { isNonInteractive } = require('../lib/noninteractive');

const TEMPLATE_ROOT_DIR = path.join(__dirname, '..', 'templates');
const WORKSPACE_TEMPLATES = {
  business: {
    dir: path.join(TEMPLATE_ROOT_DIR, 'business-starter'),
    label: 'business environment',
  },
  research: {
    dir: path.join(TEMPLATE_ROOT_DIR, 'research-canonical'),
    label: 'research lab environment',
  },
};

/**
 * Walk a directory and return relative file paths.
 */
function _walkTemplateDir(dir, base = dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(..._walkTemplateDir(full, base));
    } else if (e.isFile()) {
      out.push(path.relative(base, full));
    }
  }
  return out;
}

// Local calendar day (YYYY-MM-DD). toISOString() is the UTC day, which is
// already tomorrow in the evening anywhere west of Greenwich.
function localDay(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * Substitute workspace metadata in template content.
 */
function _substituteParams(content, params) {
  return content
    .replace(/\{\{name\}\}/g, params.name || params.slug || 'this business')
    .replace(/\{\{slug\}\}/g, params.slug || 'business')
    .replace(/\{\{owner_email\}\}/g, params.owner_email || '')
    .replace(/\{\{business_id\}\}/g, params.business_id || '')
    .replace(/\{\{workspace_id\}\}/g, params.workspace_id || '')
    .replace(/\{\{today\}\}/g, params.today || localDay())
    .replace(/\{\{workspace_template\}\}/g, params.workspace_template || 'business');
}

function _templateTargetRelPath(relPath) {
  return relPath === 'persona.md' ? 'PERSONA.md' : relPath;
}

function ensureRealDirectory(dir) {
  let stat = null;
  try {
    stat = fs.lstatSync(dir);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  if (stat) {
    if (stat.isDirectory()) return;
    if (stat.isSymbolicLink()) {
      try {
        if (fs.statSync(dir).isDirectory()) return;
        fs.unlinkSync(dir);
      } catch (_) {
        fs.unlinkSync(dir);
      }
    } else {
      throw new Error(`${dir} exists and is not a directory`);
    }
  }
  fs.mkdirSync(dir, { recursive: true });
}

// Check each component below the trusted workspace or home root before
// creating directories; never follow a link into another owner's tree.
function ensureSkillDirectory(dir, root, { create = true } = {}) {
  const relative = path.relative(root, dir);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Unsafe skill path: ${dir}`);
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) return;
      try { fs.mkdirSync(current); } catch (mkdirError) {
        if (mkdirError.code !== 'EEXIST') throw mkdirError;
      }
      stat = fs.lstatSync(current);
    }
    if (!stat.isDirectory()) throw new Error(`${current} is not a real directory; skill sync skipped`);
  }
}

// One proposal and one staging file per destination. Both are create-only:
// a pre-existing file (including a symlink or an interrupted staging file)
// is always preserved and needs manual inspection/removal. We deliberately
// leave the staging link after publication so cleanup never deletes a file
// that another process might have replaced.
function proposeSkillFile(source, destPath, label, { dryRun = false } = {}) {
  const proposal = `${destPath}.atris-proposal`;
  const pending = `${proposal}.pending`;
  const version = createHash('sha256').update(source).digest('hex');
  for (const [file, description] of [[proposal, 'proposal'], [pending, 'staging file']]) {
    try {
      fs.lstatSync(file);
      console.warn(`- Kept existing ${description} for ${label}; package sha256 ${version}; inspect it before requesting a newer proposal`);
      return;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (dryRun) {
    console.warn(`- Would propose ${label} at ${proposal} (sha256 ${version})`);
    return;
  }
  let fd;
  try {
    fd = fs.openSync(pending, 'wx', 0o600);
    fs.writeFileSync(fd, source);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.linkSync(pending, proposal);
    console.warn(`- Proposed ${label} at ${proposal} (sha256 ${version}); staging file retained at ${pending}`);
  } catch (error) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
    console.warn(`- Could not propose ${label}: ${error.message}; existing files and any staging file were kept`);
  }
}

// Existing skill files are user-owned unless an ownership baseline proves
// otherwise. We have no such baseline, so never replace or follow them.
function syncSkillFile(srcPath, destPath, label, { dryRun = false, silent = false } = {}) {
  const source = fs.readFileSync(srcPath);
  let stat;
  try { stat = fs.lstatSync(destPath); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (stat) {
    if (!stat.isFile()) {
      console.warn(`- Kept ${label} (existing skill file not replaced)`);
    } else if (!source.equals(fs.readFileSync(destPath))) {
      console.warn(`- Kept ${label} (existing skill file not replaced)`);
      proposeSkillFile(source, destPath, label, { dryRun });
    }
    return 0;
  }
  if (!dryRun) {
    try { fs.writeFileSync(destPath, source, { flag: 'wx' }); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      console.warn(`- Kept ${label} (existing skill file not replaced)`);
      return 0;
    }
    if (srcPath.endsWith('.sh')) fs.chmodSync(destPath, 0o755);
  }
  if (!silent) console.log(`${dryRun ? 'Would add' : '✓ Added'} ${label}`);
  return 1;
}

// A member retired to team/_archived/<name>-<date>/ must never come back.
function isArchivedMember(teamDir, name) {
  const archiveDir = path.join(teamDir, '_archived');
  try {
    return fs.readdirSync(archiveDir).some(entry => entry === name || (entry.startsWith(`${name}-`) && /^\d{4}-\d{2}-\d{2}$/.test(entry.slice(name.length + 1))));
  } catch {
    return false;
  }
}

/**
 * Sync the canonical skill set from atris-cli/atris/skills/* into a
 * workspace's atris/skills/* (plus ensure .claude/skills/ symlinks).
 *
 * Shared by business mode (via syncWorkspaceTemplate) and legacy/dev mode
 * (via syncAtris). Single source of truth = atris-cli/atris/skills/.
 *
 * Returns the number of files updated (0 if everything was up to date).
 */
function syncPackageSkills(targetAtrisDir, opts = {}) {
  const packageSkillsDir = path.join(__dirname, '..', 'atris', 'skills');
  const userSkillsDir = path.join(targetAtrisDir, 'skills');
  const claudeSkillsBaseDir = path.join(path.dirname(targetAtrisDir), '.claude', 'skills');
  const verbose = opts.verbose !== false;
  const dryRun = opts.dryRun === true;
  let updated = 0;

  if (!fs.existsSync(packageSkillsDir)) return 0;

  if (!dryRun) {
    ensureSkillDirectory(userSkillsDir, path.dirname(targetAtrisDir));
    ensureSkillDirectory(claudeSkillsBaseDir, path.dirname(targetAtrisDir));
  }

  const skillFolders = fs.readdirSync(packageSkillsDir).filter(f => {
    try { return fs.statSync(path.join(packageSkillsDir, f)).isDirectory(); }
    catch { return false; }
  });

  for (const skill of skillFolders) {
    const srcSkillDir = path.join(packageSkillsDir, skill);
    const destSkillDir = path.join(userSkillsDir, skill);
    const symlinkPath = path.join(claudeSkillsBaseDir, skill);

    const syncRecursive = (src, dest, skillName, basePath = '') => {
      try {
        const existing = fs.lstatSync(dest);
        if (!existing.isDirectory()) {
          console.warn(`- Kept atris/skills/${skillName}${basePath ? '/' + basePath : ''} (existing skill directory not replaced)`);
          return;
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      ensureSkillDirectory(dest, path.dirname(targetAtrisDir), { create: !dryRun });
      for (const entry of fs.readdirSync(src)) {
        const srcPath = path.join(src, entry);
        const destPath = path.join(dest, entry);
        const relPath = basePath ? `${basePath}/${entry}` : entry;
        if (fs.statSync(srcPath).isDirectory()) {
          syncRecursive(srcPath, destPath, skillName, relPath);
        } else {
          updated += syncSkillFile(srcPath, destPath, `atris/skills/${skillName}/${relPath}`, {
            dryRun, silent: !verbose,
          });
        }
      }
    };

    syncRecursive(srcSkillDir, destSkillDir, skill);

    if (!fs.existsSync(symlinkPath)) {
      const relativePath = path.relative(claudeSkillsBaseDir, destSkillDir);
      if (dryRun) {
        if (verbose) console.log(`Would link .claude/skills/${skill}`);
      } else {
        try {
          fs.symlinkSync(relativePath, symlinkPath);
          if (verbose) console.log(`✓ Linked .claude/skills/${skill}`);
        } catch (e) {
          console.log(`- Kept .claude/skills/${skill} (link could not be created: ${e.code || e.message})`);
        }
      }
    }
  }

  return updated;
}

function resolveWorkspaceTemplate(templateName = 'business') {
  const normalized = String(templateName || 'business').toLowerCase();
  if (normalized === 'research-lab' || normalized === 'researchlab' || normalized === 'lab') {
    return { key: 'research', ...WORKSPACE_TEMPLATES.research };
  }
  const template = WORKSPACE_TEMPLATES[normalized];
  if (!template) return null;
  return { key: normalized, ...template };
}

function ensureWorkspaceStateFiles(targetRoot, params, options = {}) {
  const dryRun = options.dryRun === true;
  const metaDir = path.join(targetRoot, '.atris');
  const stateDir = path.join(metaDir, 'state');
  const created = [];

  const files = [
    {
      relPath: '_sync.json',
      content: `${JSON.stringify({
        workspace_slug: params.slug || 'business',
        business_id: params.business_id || '',
        workspace_id: params.workspace_id || '',
        workspace_template: params.workspace_template || 'business',
        status: 'initialized-local',
        updated_at: new Date().toISOString(),
        source: 'workspace template bootstrap',
      }, null, 2)}\n`,
    },
    { relPath: 'events.jsonl', content: '' },
    { relPath: 'episodes.jsonl', content: '' },
    { relPath: 'scorecards.jsonl', content: '' },
  ];

  for (const file of files) {
    const fullPath = path.join(stateDir, file.relPath);
    if (fs.existsSync(fullPath)) continue;
    created.push(path.join('.atris', 'state', file.relPath));
    if (!dryRun) {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, file.content);
    }
  }

  return created;
}

function renderBusinessAgentAdapter(bizMeta = {}, targetRoot = '.') {
  const name = bizMeta.name || bizMeta.slug || 'this business';
  const slug = bizMeta.slug || 'business';
  const rootHint = targetRoot || '.';
  return [
    `# AGENTS.md - ${name} Atris Workspace`,
    '',
    `You are operating inside the shared Atris workspace for ${name} (${slug}).`,
    '',
    '## Start Here',
    '',
    'Run these first from the workspace root:',
    '',
    '```bash',
    'atris',
    'atris business start',
    'atris radar',
    'atris task next',
    'atris member activate operator',
    '```',
    '',
    'If no active mission exists, start the first bounded business loop:',
    '',
    '```bash',
    'atris mission status --status active --json',
    `atris mission start "Run the first useful loop for ${name}" --owner operator --runner codex_goal --lane business --verify "atris business check" --stop "first proof recap recorded"`,
    'atris member goal-from-mission operator',
    'atris do',
    '```',
    '',
    '## Core Files',
    '',
    '| File | Purpose |',
    '|------|---------|',
    '| `atris/atris.md` | Workspace boot protocol |',
    '| `atris/MAP.md` | Navigation and where-is-X index |',
    '| `.atris/state/tasks.projection.json` | Current task projection |',
    '| `atris/TODO.md` | Rendered task fallback only |',
    '| `atris/team/START_HERE.md` | Team lanes and first-run flow |',
    '| `atris/wiki/` | Business context and source-backed briefs |',
    '| `atris/reports/` | Proof recaps and share handoffs |',
    '',
    '## Rules',
    '',
    '- Check `atris/MAP.md` before broad code or file search.',
    '- Use `atris task` for ownership, notes, proof, and review state.',
    '- Give every task a plain first layer: what changes, why it matters, and what done looks like. Keep all technical detail underneath unchanged.',
    '- Use the existing Plan/Do and accept/revise gates for approve or change actions; never bypass proof.',
    '- Use `atris mission` when work should survive the current chat.',
    '- Put completed agent work in Review with `atris task ready <id> --proof "<receipt>" --result "<day-one PM sentence>".`',
    '- Do not run `atris task accept` or claim XP unless a human approved the proof.',
    '- Do not mix another business into this workspace.',
    '- No external sends, spend, or launches without operator approval.',
    '',
    '## Proof Loop',
    '',
    '```bash',
    'atris sync --dry-run',
    'atris business check',
    'atris business record atris/reports/<recap>.md --outcome mixed --metric "operator speed"',
    'atris business share --write',
    'atris sync',
    '# Optional during active collaboration:',
    'atris sync --watch',
    '```',
    '',
    `Workspace root at creation: ${rootHint}`,
    '',
  ].join('\n');
}

function ensureBusinessRootAgentAdapters(targetRoot, bizMeta = {}, options = {}) {
  const dryRun = options.dryRun === true;
  const written = [];
  const adapter = renderBusinessAgentAdapter(bizMeta, targetRoot);
  const files = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];
  for (const file of files) {
    const fullPath = path.join(targetRoot, file);
    if (fs.existsSync(fullPath)) continue;
    written.push(file);
    if (!dryRun) fs.writeFileSync(fullPath, adapter, 'utf8');
  }
  return written;
}

/**
 * Sync canonical business template files into a business workspace.
 * Used when .atris/business.json is present (business mode).
 *
 * Default: NEVER overwrites existing files (preserves customizations).
 * --force: overwrites existing canonical files (bumps to latest).
 */
function syncWorkspaceTemplate(targetRoot, bizMeta, options = {}) {
  const template = resolveWorkspaceTemplate(options.templateName || bizMeta.workspace_template || 'business');
  if (!template) {
    console.error(`✗ Unknown workspace template: ${options.templateName || bizMeta.workspace_template}`);
    process.exit(1);
  }

  const params = {
    slug: bizMeta.slug || 'business',
    name: bizMeta.name || bizMeta.slug || 'this business',
    owner_email: bizMeta.owner_email || '',
    business_id: bizMeta.business_id || '',
    workspace_id: bizMeta.workspace_id || '',
    today: localDay(),
    workspace_template: template.key,
  };
  const force = options.force != null ? options.force : process.argv.includes('--force');
  const dryRun = options.dryRun != null ? options.dryRun : process.argv.includes('--dry-run');
  const targetAtrisDir = path.join(targetRoot, 'atris');

  if (!fs.existsSync(template.dir)) {
    console.error(`✗ Workspace template directory not found: ${template.dir}`);
    console.error('  Your atris-cli installation may be incomplete.');
    process.exit(1);
  }

  console.log('');
  console.log(`Updating ${params.name} (${params.slug}) from ${template.label} templates...`);
  console.log(`  Target: ${targetAtrisDir}/`);
  console.log(`  Source: ${template.dir}`);
  console.log('');

  const templateFiles = _walkTemplateDir(template.dir).sort();
  let added = 0, updated = 0, skipped = 0, preserved = 0;
  const addedList = [], updatedList = [], preservedList = [];

  for (const relPath of templateFiles) {
    const targetRelPath = _templateTargetRelPath(relPath);
    const templatePath = path.join(template.dir, relPath);
    const targetPath = path.join(targetAtrisDir, targetRelPath);
    let templateContent;
    try { templateContent = fs.readFileSync(templatePath, 'utf-8'); } catch { continue; }
    const finalContent = _substituteParams(templateContent, params);

    const memberMatch = targetRelPath.split(path.sep).join('/').match(/^team\/([^/_][^/]*)\//);
    if (memberMatch && isArchivedMember(path.join(targetAtrisDir, 'team'), memberMatch[1])) {
      skipped++;
      continue;
    }

    if (!fs.existsSync(targetPath)) {
      addedList.push(targetRelPath); added++;
      if (!dryRun) {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, finalContent);
      }
    } else {
      const existing = fs.readFileSync(targetPath, 'utf-8');
      if (existing === finalContent) {
        skipped++;
      } else if (force && !memberMatch) {
        updatedList.push(targetRelPath); updated++;
        if (!dryRun) fs.writeFileSync(targetPath, finalContent);
      } else {
        preservedList.push(targetRelPath); preserved++;
      }
    }
  }

  const stateAddedList = ensureWorkspaceStateFiles(targetRoot, params, { dryRun });
  const agentAdapterList = ensureBusinessRootAgentAdapters(targetRoot, params, { dryRun });

  // Skills: sync the canonical skill set from atris-cli package into the
  // customer workspace. Business-starter template ships skill infra (README,
  // folders) but skill files live in atris-cli/atris/skills/, single source
  // of truth. Any new skill (e.g. AEO) auto-propagates to every customer.
  const skillsUpdated = syncPackageSkills(targetAtrisDir, { verbose: false, dryRun });

  console.log(`  Added:     ${added}`);
  console.log(`  Updated:   ${updated} ${force ? '' : '(--force to enable)'}`);
  console.log(`  Template files preserved: ${preserved} (existing customizations kept)`);
  console.log(`  Skipped:   ${skipped} (already match template)`);
  console.log(`  Skills:    ${skillsUpdated} ${dryRun ? 'would add' : 'added'} from atris-cli/atris/skills/`);
  console.log('');

  if (addedList.length > 0) {
    console.log('  New files:');
    addedList.slice(0, 15).forEach(p => console.log(`    + atris/${p}`));
    if (addedList.length > 15) console.log(`    ... +${addedList.length - 15} more`);
    console.log('');
  }
  if (updatedList.length > 0) {
    console.log(`  ${force ? 'Updated' : 'Differ from template (preserved)'}:`);
    updatedList.slice(0, 15).forEach(p => console.log(`    ↑ atris/${p}`));
    if (updatedList.length > 15) console.log(`    ... +${updatedList.length - 15} more`);
    console.log('');
  }
  if (stateAddedList.length > 0) {
    console.log('  State files:');
    stateAddedList.forEach(p => console.log(`    + ${p}`));
    console.log('');
  }
  if (agentAdapterList.length > 0) {
    console.log('  Root agent adapters:');
    agentAdapterList.forEach(p => console.log(`    + ${p}`));
    console.log('');
  }

  if (dryRun) {
    console.log('  (--dry-run, no changes made)');
  } else if (added === 0 && updated === 0 && stateAddedList.length === 0 && agentAdapterList.length === 0) {
    ensureWikiScaffold(targetRoot);
    console.log('  ✓ Already up to date');
  } else {
    ensureWikiScaffold(targetRoot);
    console.log('  ✓ Local workspace updated. Run `atris sync` to push and pull with safety checks.');
  }

  return {
    added,
    updated,
    preserved,
    skipped,
    skillsUpdated,
    addedList,
    updatedList,
    preservedList,
    stateAddedList,
    agentAdapterList,
  };
}

function syncBusinessCanonical(targetRoot, bizMeta, options = {}) {
  return syncWorkspaceTemplate(targetRoot, bizMeta, {
    ...options,
    templateName: options.templateName || bizMeta.workspace_template || 'business',
  });
}

// Team members follow every written update, business or legacy, into Claude
// Code, Cursor, and Codex as subagents. An export failure never fails the update.
function exportTeamAfterUpdate(root, { dryRun = false } = {}) {
  if (dryRun || !fs.existsSync(path.join(root, 'atris', 'team'))) return;
  try {
    const { exportMembers, summaryLine } = require('../lib/member-export');
    console.log(`✓ Team: ${summaryLine(exportMembers(root))}`);
  } catch (err) {
    console.log(`Team export skipped: ${err.message || err}`);
  }
}

function syncAtris(options = {}) {
  const explicitDryRun = options.dryRun != null ? options.dryRun : process.argv.includes('--dry-run');
  const yes = options.yes != null
    ? options.yes
    : (process.argv.includes('--yes') || process.argv.includes('-y'));
  // Default is plan-only. Writes require an explicit --yes.
  const dryRun = explicitDryRun || !yes;
  const force = options.force != null ? options.force : process.argv.includes('--force');
  // Business mode detection: if .atris/business.json exists, use canonical templates
  const bizFile = path.join(process.cwd(), '.atris', 'business.json');
  if (fs.existsSync(bizFile)) {
    try {
      const bizMeta = JSON.parse(fs.readFileSync(bizFile, 'utf8'));
      const result = syncWorkspaceTemplate(process.cwd(), bizMeta, {
        templateName: bizMeta.workspace_template || 'business',
        dryRun,
        force,
      });
      const bizRunIgnore = ensureRunIgnore(process.cwd(), { dryRun });
      if (bizRunIgnore.changed) {
        console.log(`${dryRun ? 'Would update' : '✓ Updated'} .gitignore (atris run output ignored)`);
      }
      exportTeamAfterUpdate(process.cwd(), { dryRun });
      if (!yes) {
        console.log('\nPlan only. Re-run with --yes to write these files.');
        if (!explicitDryRun && isNonInteractive()) process.exit(2);
      }
      return result;
    } catch (e) {
      console.error(`✗ Failed to read .atris/business.json: ${e.message}`);
      process.exit(1);
    }
  }

  // Legacy/dev mode: sync from atris-cli's own atris/ folder
  const targetDir = path.join(process.cwd(), 'atris');
  const teamDir = path.join(targetDir, 'team');
  const legacyAgentTeamDir = path.join(targetDir, 'agent_team');

  if (!fs.existsSync(targetDir)) {
    console.error('✗ Error: atris/ folder not found. Run "atris init" first.');
    process.exit(1);
  }

  // MIGRATION: agent_team/ → team/ (v2.0.x → v2.1.0)
  if (fs.existsSync(legacyAgentTeamDir)) {
    console.log('');
    console.log('📦 Migrating agent_team/ → team/ (v2.1.0 update)');

    // Create team/ if it doesn't exist
    if (!dryRun && !fs.existsSync(teamDir)) {
      fs.mkdirSync(teamDir, { recursive: true });
    }

    // Copy any custom files from agent_team/ to team/
    const legacyFiles = fs.readdirSync(legacyAgentTeamDir);
    for (const file of legacyFiles) {
      const srcPath = path.join(legacyAgentTeamDir, file);
      const destPath = path.join(teamDir, file);

      // Only copy if destination doesn't exist (preserve any customizations)
      if (!fs.existsSync(destPath)) {
        if (fs.statSync(srcPath).isFile()) {
          if (!dryRun) fs.copyFileSync(srcPath, destPath);
          console.log(`  ${dryRun ? 'Would migrate' : '✓ Migrated'} ${file}`);
        }
      }
    }

    // Remove old agent_team/ folder
    if (!dryRun) fs.rmSync(legacyAgentTeamDir, { recursive: true, force: true });
    console.log(`  ${dryRun ? 'Would remove' : '✓ Removed'} old agent_team/ folder`);
    console.log('');
  }

  if (!fs.existsSync(teamDir)) {
    if (!dryRun) fs.mkdirSync(teamDir, { recursive: true });
  }

  // Ensure policies folder exists
  const policiesDir = path.join(targetDir, 'policies');
  if (!fs.existsSync(policiesDir)) {
    if (!dryRun) fs.mkdirSync(policiesDir, { recursive: true });
    console.log(`${dryRun ? 'Would create' : '✓ Created'} atris/policies/ folder`);
  }

  const filesToSync = [
    { source: 'atris.md', target: 'atris.md' },
    { source: 'PERSONA.md', target: 'PERSONA.md' },
    { source: 'GETTING_STARTED.md', target: 'GETTING_STARTED.md' },
    { source: 'atris/CLAUDE.md', target: 'CLAUDE.md' },
    { source: 'atris/team/navigator/MEMBER.md', target: 'team/navigator/MEMBER.md' },
    { source: 'atris/team/executor/MEMBER.md', target: 'team/executor/MEMBER.md' },
    { source: 'atris/team/validator/MEMBER.md', target: 'team/validator/MEMBER.md' },
    { source: 'atris/team/launcher/MEMBER.md', target: 'team/launcher/MEMBER.md' },
    { source: 'atris/team/brainstormer/MEMBER.md', target: 'team/brainstormer/MEMBER.md' },
    { source: 'atris/team/researcher/MEMBER.md', target: 'team/researcher/MEMBER.md' },
    { source: 'atris/policies/ANTISLOP.md', target: 'policies/ANTISLOP.md' }
  ];

  let updated = 0;
  let skipped = 0;

  filesToSync.forEach(({ source, target }) => {
    const sourceFile = path.join(__dirname, '..', source);
    const targetFile = path.join(targetDir, target);

    if (!fs.existsSync(sourceFile)) {
      console.log(`⚠ Skipping ${source} (not found in package)`);
      return;
    }

    const currentContent = fs.existsSync(targetFile) ? fs.readFileSync(targetFile, 'utf8') : '';
    const newContent = fs.readFileSync(sourceFile, 'utf8');

    if (currentContent === newContent) {
      skipped++;
      return;
    }

    // Team members belong to the project. Update never adds a member (init
    // does that, and a missing member may have been retired to
    // team/_archived/) and never replaces one the project has changed.
    if (target.startsWith('team/')) {
      if (fs.existsSync(targetFile)) {
        console.log(`- Kept ${target} (newer template exists in the package, yours not replaced)`);
      }
      skipped++;
      return;
    }

    if (!dryRun) {
      fs.mkdirSync(path.dirname(targetFile), { recursive: true });
      fs.copyFileSync(sourceFile, targetFile);
    }
    console.log(`${dryRun ? 'Would update' : '✓ Updated'} ${target}`);
    updated++;
  });

  // Migrate legacy TASK_CONTEXTS.md → TODO.md if needed
  const todoFile = path.join(targetDir, 'TODO.md');
  const legacyTaskFile = path.join(targetDir, 'TASK_CONTEXTS.md');
  if (!fs.existsSync(todoFile) && fs.existsSync(legacyTaskFile)) {
    if (!dryRun) fs.renameSync(legacyTaskFile, todoFile);
    console.log(`${dryRun ? 'Would migrate' : '✓ Migrated'} TASK_CONTEXTS.md to TODO.md`);
    updated++;
  }

  // Sync all skills from package to user's project via shared helper.
  updated += syncPackageSkills(targetDir, { verbose: true, dryRun });

  const voiceCard = voiceCardForRoot(process.cwd());
  const cursorVoiceFile = path.join(process.cwd(), '.cursor', 'rules', 'atris-voice.mdc');
  const cursorVoiceResult = upsertCursorVoiceCard(cursorVoiceFile, voiceCard, { dryRun });
  if (cursorVoiceResult.action !== 'unchanged') {
    console.log(`${dryRun ? 'Would update' : '✓ Updated'} .cursor/rules/atris-voice.mdc`);
    updated++;
  }

  const agentsMdFile = path.join(process.cwd(), 'AGENTS.md');
  const agentsVoiceResult = upsertAgentVoiceCard(agentsMdFile, voiceCard, { dryRun });
  if (agentsVoiceResult.action !== 'unchanged') {
    console.log(`${dryRun ? 'Would update' : '✓ Updated'} AGENTS.md voice card`);
    updated++;
  }

  const openingLines = openingLinesForRoot(process.cwd());
  const agentsOpeningResult = upsertAgentsOpeningLines(agentsMdFile, openingLines, { dryRun });
  if (agentsOpeningResult.action !== 'unchanged') {
    console.log(`${dryRun ? 'Would update' : '✓ Updated'} AGENTS.md operating rules`);
    updated++;
  }

  // syncPackageSkills above creates the canonical Atris skill and link. Do
  // not write through .claude/skills/atris: it may be a user-owned link.

  // Update .claude/settings.json with startup and per-prompt hooks.
  const claudeSettingsFile = path.join(process.cwd(), '.claude', 'settings.json');
  const claudeSettingsResult = upsertClaudeVoiceHook(claudeSettingsFile, {
    dryRun,
    initialSettings: {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: "[ -d atris ] && atris atris.md || true"
              }
            ]
          }
        ]
      }
    },
  });
  if (claudeSettingsResult.action !== 'unchanged' && claudeSettingsResult.action !== 'skipped') {
    console.log(`${dryRun ? 'Would update' : '✓ Updated'} .claude/settings.json (voice hook)`);
    updated++;
  }

  // Update root CLAUDE.md with Atris block (prepend with markers)
  const rootClaudeMd = path.join(process.cwd(), 'CLAUDE.md');
  const applyClaudeUpdate = (content, dryAction, completedAction) => {
    if (!dryRun) fs.writeFileSync(rootClaudeMd, content);
    console.log(dryRun ? `Would ${dryAction}` : `✓ ${completedAction}`);
    updated++;
  };

  if (fs.existsSync(rootClaudeMd)) {
    const source = fs.readFileSync(rootClaudeMd, 'utf8');
    const result = upsertAtrisClaudeBootBlock(source, { openingLines });
    if (result.action === 'repaired') {
      applyClaudeUpdate(result.content, 'repair atris block in CLAUDE.md (missing end marker)', 'repaired atris block in CLAUDE.md (missing end marker)');
    } else if (result.action === 'updated') {
      applyClaudeUpdate(result.content, 'update atris block in CLAUDE.md', 'updated atris block in CLAUDE.md');
    } else if (result.action === 'prepended') {
      applyClaudeUpdate(result.content, 'prepend atris block to CLAUDE.md', 'prepended atris block to CLAUDE.md');
    }
  } else {
    // Create new CLAUDE.md with just Atris block
    const content = upsertAtrisClaudeBootBlock('', { openingLines }).content;
    applyClaudeUpdate(content, 'create CLAUDE.md with atris block', 'created CLAUDE.md with atris block');
  }

  // Member run output must stay out of git or member self-merge never fires
  // on a dirty tree. Append-only; plan-only mode prints instead of writing.
  const runIgnore = ensureRunIgnore(process.cwd(), { dryRun });
  if (runIgnore.changed) {
    console.log(`${dryRun ? 'Would update' : '✓ Updated'} .gitignore (atris run output ignored)`);
    updated++;
  }

  if (dryRun) {
    console.log(`\nDry run: ${updated} file(s) would update, ${skipped} unchanged; no changes made.`);
    if (!yes) {
      console.log('Plan only. Re-run with --yes to write these files.');
      if (!explicitDryRun && isNonInteractive()) process.exit(2);
    }
  } else if (updated === 0) {
    ensureWikiScaffold(process.cwd());
    console.log('✓ Already up to date');
  } else {
    ensureWikiScaffold(process.cwd());
    console.log(`\n✓ Updated ${updated} file(s), ${skipped} unchanged`);
    console.log('\nRun your AI agent again to use the latest specs and agent templates.');
  }

  exportTeamAfterUpdate(process.cwd(), { dryRun });
}

/**
 * Recursively sync files from src to dest. Returns count of files updated.
 */
function syncRecursiveCount(src, dest, label, silent, root) {
  let count = 0;
  try {
    const existing = fs.lstatSync(dest);
    if (!existing.isDirectory()) {
      console.warn(`- Kept ${label} (existing skill directory not replaced)`);
      return 0;
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  ensureSkillDirectory(dest, root);
  const entries = fs.readdirSync(src);
  for (const entry of entries) {
    const srcPath = path.join(src, entry);
    const destPath = path.join(dest, entry);

    if (fs.statSync(srcPath).isDirectory()) {
      count += syncRecursiveCount(srcPath, destPath, `${label}/${entry}`, silent, root);
    } else {
      count += syncSkillFile(srcPath, destPath, `${label}/${entry}`, { silent });
    }
  }
  return count;
}

/**
 * Lightweight skill-only sync. Syncs skills from the npm package to:
 *   1. Global skill dirs (~/.claude/skills/, ~/.codex/skills/), always, if they exist
 *   2. Project-level (atris/skills/ + .claude/skills/ symlinks), if in a project
 *
 * Global = baseline truth. Project = optional override.
 * Returns number of files updated (0 = already current).
 */
function syncSkills({ silent = false } = {}) {
  const packageSkillsDir = path.join(__dirname, '..', 'atris', 'skills');
  if (!fs.existsSync(packageSkillsDir)) {
    return 0;
  }

  let updated = 0;
  const homeDir = stateHome();

  const skillFolders = fs.readdirSync(packageSkillsDir).filter(f =>
    fs.statSync(path.join(packageSkillsDir, f)).isDirectory()
  );

  // Preflight before init or update gets a chance to traverse these roots.
  for (const dir of [path.join(homeDir, '.claude', 'skills'), path.join(homeDir, '.codex', 'skills')]) {
    ensureSkillDirectory(dir, homeDir, { create: false });
  }
  for (const dir of [path.join(process.cwd(), '.claude', 'skills'), path.join(process.cwd(), 'atris', 'skills')]) {
    ensureSkillDirectory(dir, process.cwd(), { create: false });
  }

  // --- 1. Global skill directories (sync if they exist) ---
  const globalSkillDirs = [
    path.join(homeDir, '.claude', 'skills'),
    path.join(homeDir, '.codex', 'skills'),
  ];

  for (const globalDir of globalSkillDirs) {
    if (!fs.existsSync(globalDir)) continue;
    const dirName = path.basename(path.dirname(globalDir)); // .claude or .codex

    for (const skill of skillFolders) {
      const srcSkillDir = path.join(packageSkillsDir, skill);
      const destSkillDir = path.join(globalDir, skill);

      if (fs.existsSync(destSkillDir) || fs.existsSync(globalDir)) {
        updated += syncRecursiveCount(srcSkillDir, destSkillDir, `~/${dirName}/skills/${skill}`, silent, homeDir);
      }
    }
  }

  // --- 2. Project-level (only if inside an atris project AND not a business workspace) ---
  // BUSINESS GATE: don't sync framework skills into business workspaces.
  // Per the canonical-layout decision, framework skills (autopilot, wiki, loop, etc.) live
  // at the system level on EC2, NOT inside per-business workspaces. Customer workspaces
  // contain ONLY business-specific custom skills in atris/skills/.
  const businessJson = path.join(process.cwd(), '.atris', 'business.json');
  if (fs.existsSync(businessJson)) {
    // We're inside a business workspace, skip project-level skill sync.
    return updated;
  }

  const targetDir = path.join(process.cwd(), 'atris');
  if (fs.existsSync(targetDir)) {
    const userSkillsDir = path.join(targetDir, 'skills');
    const claudeSkillsBaseDir = path.join(process.cwd(), '.claude', 'skills');

    ensureSkillDirectory(userSkillsDir, process.cwd());
    ensureSkillDirectory(claudeSkillsBaseDir, process.cwd());

    for (const skill of skillFolders) {
      const srcSkillDir = path.join(packageSkillsDir, skill);
      const destSkillDir = path.join(userSkillsDir, skill);
      const symlinkPath = path.join(claudeSkillsBaseDir, skill);

      updated += syncRecursiveCount(srcSkillDir, destSkillDir, `atris/skills/${skill}`, silent, process.cwd());

      // Create symlink if doesn't exist
      if (!fs.existsSync(symlinkPath)) {
        const relativePath = path.join('..', '..', 'atris', 'skills', skill);
        try {
          fs.symlinkSync(relativePath, symlinkPath);
          if (!silent) {
            console.log(`✓ Linked .claude/skills/${skill}`);
          }
        } catch (e) {
          console.log(`- Kept .claude/skills/${skill} (link could not be created: ${e.code || e.message})`);
        }
      }
    }
  }

  return updated;
}

/**
 * Discover atris-managed projects under a root directory.
 * A project is any directory whose immediate child `atris/` folder contains `atris.md`.
 * Skips noise: node_modules, .git, .claude, dist, build, _archive, worktrees.
 */
function _findAtrisProjects(rootDir, maxDepth = 8) {
  const skip = new Set([
    'node_modules', '.git', '.claude', '.next', 'dist', 'build',
    '_archive', 'worktrees', '.codex', '.venv', 'venv', '__pycache__',
  ]);
  const found = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    const atrisMd = path.join(dir, 'atris', 'atris.md');
    if (fs.existsSync(atrisMd)) found.push(dir);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (skip.has(e.name)) continue;
      if (e.name.startsWith('.')) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  }
  walk(path.resolve(rootDir), 0);
  return found;
}

/**
 * Sync canonical atris.md (and core docs) across every atris project under cwd.
 * Walks the subtree, finds every `atris/atris.md`, copies the package source.
 *
 * Flags: --dry-run (preview only), --yes/--force (skip confirm).
 * Skips business workspaces (they use syncWorkspaceTemplate via syncAtris).
 */
// Canonical files shipped from the package root. Must match syncAtris's filesToSync.
const SYNC_ALL_FILES = [
  { source: 'atris.md', target: 'atris.md' },
  { source: 'PERSONA.md', target: 'PERSONA.md' },
  { source: 'GETTING_STARTED.md', target: 'GETTING_STARTED.md' },
  { source: 'atris/CLAUDE.md', target: 'CLAUDE.md' },
];

/**
 * Pure function: build the sync plan for every atris project under root.
 * No console output, no writes. Returns { projects, plan } for inspection.
 * Plan entries: { projectRoot, isBusiness, isCustomized, changes }.
 *
 * Exported for tests, the production syncAtrisAll wraps this.
 */
function buildSyncAllPlan({ root, pkgRoot, filesToSync = SYNC_ALL_FILES } = {}) {
  const projects = _findAtrisProjects(root);
  const plan = [];
  for (const projectRoot of projects) {
    const atrisDir = path.join(projectRoot, 'atris');
    const bizFile = path.join(projectRoot, '.atris', 'business.json');
    const isSelf = path.resolve(projectRoot) === path.resolve(pkgRoot);
    const isInBusinessDir = projectRoot.split(path.sep).includes('atris-business');
    let isBusiness = isInBusinessDir || (fs.existsSync(bizFile) && !isSelf);
    if (isBusiness && !isInBusinessDir) {
      try {
        const head = fs.readFileSync(path.join(atrisDir, 'atris.md'), 'utf8').slice(0, 300);
        if (!/^#\s+Atris Boot Protocol/i.test(head)) isBusiness = false;
      } catch {}
    }
    let isCustomized = false;
    if (!isSelf && !isBusiness) {
      try {
        const head = fs.readFileSync(path.join(atrisDir, 'atris.md'), 'utf8').slice(0, 500);
        const isNewCanonical = /^#\s+atris\s*\n\nAtris exists because/m.test(head);
        const isOldGeneric = /^#\s+atris\.md\s*\n\n>\s+Drop this file anywhere/m.test(head);
        if (!isNewCanonical && !isOldGeneric) isCustomized = true;
      } catch {}
    }
    const changes = [];
    for (const { source, target } of filesToSync) {
      const sourceFile = path.join(pkgRoot, source);
      const targetFile = path.join(atrisDir, target);
      if (!fs.existsSync(sourceFile)) continue;
      const newContent = fs.readFileSync(sourceFile, 'utf8');
      const currentContent = fs.existsSync(targetFile) ? fs.readFileSync(targetFile, 'utf8') : '';
      if (currentContent !== newContent) changes.push(target);
    }
    plan.push({ projectRoot, isBusiness, isCustomized, changes });
  }
  return { projects, plan };
}

function syncAtrisAll({ dryRun = false, force = false, yes = false } = {}) {
  const root = process.cwd();
  const pkgRoot = path.join(__dirname, '..');
  const writeYes = yes || process.argv.includes('--yes') || process.argv.includes('-y');
  const explicitDryRun = dryRun || process.argv.includes('--dry-run');
  // Default is plan-only. Writes require --yes.
  const planOnly = explicitDryRun || !writeYes;

  console.log('');
  console.log(`Scanning ${root} for atris projects...`);

  const filesToSync = SYNC_ALL_FILES;
  const { projects, plan: initialPlan } = buildSyncAllPlan({ root, pkgRoot, filesToSync });

  if (projects.length === 0) {
    console.log('No atris projects found under current directory.');
    return;
  }

  const plan = initialPlan;

  // Report.
  console.log(`Found ${projects.length} ${projects.length === 1 ? 'project' : 'projects'}.`);
  console.log('');
  let wouldUpdate = 0, unchanged = 0, skipped = 0;
  for (const p of plan) {
    const rel = path.relative(root, p.projectRoot) || '.';
    if (p.isBusiness) {
      console.log(`  ⏭  ${rel} (business workspace, run "atris update" in that dir)`);
      skipped++;
    } else if (p.isCustomized) {
      console.log(`  ⏭  ${rel} (customized atris.md, review manually)`);
      skipped++;
    } else if (p.changes.length === 0) {
      console.log(`  ·  ${rel} (up to date)`);
      unchanged++;
    } else {
      console.log(`  →  ${rel}: ${p.changes.length} ${p.changes.length === 1 ? 'file' : 'files'}: ${p.changes.join(', ')}`);
      wouldUpdate++;
    }
  }
  console.log('');

  if (planOnly) {
    console.log(`Dry run: ${wouldUpdate} project(s) would update, ${unchanged} unchanged, ${skipped} skipped.`);
    if (!writeYes) {
      console.log('Plan only. Re-run with --yes to write these files.');
      if (!explicitDryRun && isNonInteractive()) process.exit(2);
    }
    return;
  }

  if (wouldUpdate === 0) {
    console.log('Nothing to sync.');
    return;
  }

  // --yes already consented; skip the interactive confirm.
  _executeSyncAll(plan, pkgRoot, filesToSync, root);
}

function _executeSyncAll(plan, pkgRoot, filesToSync, root) {
  let updated = 0;
  for (const p of plan) {
    if (p.isBusiness || p.isCustomized || p.changes.length === 0) continue;
    const atrisDir = path.join(p.projectRoot, 'atris');
    for (const { source, target } of filesToSync) {
      const sourceFile = path.join(pkgRoot, source);
      const targetFile = path.join(atrisDir, target);
      if (!fs.existsSync(sourceFile)) continue;
      const newContent = fs.readFileSync(sourceFile, 'utf8');
      const currentContent = fs.existsSync(targetFile) ? fs.readFileSync(targetFile, 'utf8') : '';
      if (currentContent === newContent) continue;
      fs.mkdirSync(path.dirname(targetFile), { recursive: true });
      fs.copyFileSync(sourceFile, targetFile);
    }
    updated++;
  }
  console.log('');
  console.log(`✓ Synced ${updated} project(s).`);
}

module.exports = {
  syncAtris,
  syncAtrisAll,
  buildSyncAllPlan,
  SYNC_ALL_FILES,
  syncSkills,
  syncBusinessCanonical,
  syncWorkspaceTemplate,
  ensureWorkspaceStateFiles,
  ensureBusinessRootAgentAdapters,
};
