const fs = require('fs');
const path = require('path');

// --- YAML Frontmatter Parser (regex-based, no deps) ---

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const yaml = match[1];
  const result = {};
  let currentKey = null;

  for (const line of yaml.split('\n')) {
    // List item: "  - value"
    const listMatch = line.match(/^\s+-\s+(.+)$/);
    if (listMatch && currentKey) {
      if (!Array.isArray(result[currentKey])) result[currentKey] = [];
      result[currentKey].push(listMatch[1].trim());
      continue;
    }

    // Nested key (one level): "  key: value"
    const nestedMatch = line.match(/^\s+([a-z_-]+):\s*(.*)$/);
    if (nestedMatch && currentKey && typeof result[currentKey] === 'object' && !Array.isArray(result[currentKey])) {
      result[currentKey][nestedMatch[1]] = nestedMatch[2].trim() || true;
      continue;
    }

    // Top-level key: "key: value"
    const kvMatch = line.match(/^([a-z_-]+):\s*(.*)$/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      const val = kvMatch[2].trim();
      if (val === '') {
        // Could be start of a list or nested object — leave empty, next lines fill it
        result[currentKey] = {};
      } else if (val.startsWith('[') && val.endsWith(']')) {
        // Inline array: [a, b, "c d"]
        result[currentKey] = val.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
      } else {
        result[currentKey] = val.replace(/^["']|["']$/g, '');
      }
    }
  }

  return result;
}

function getFrontmatterRaw(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  return match ? match[1] : null;
}

// --- Skill Discovery ---

function findAllSkills(skillsDir) {
  if (!fs.existsSync(skillsDir)) return [];

  const skills = [];

  function walk(dir, prefix) {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      const stat = fs.statSync(fullPath);
      if (!stat.isDirectory()) continue;

      const skillFile = path.join(fullPath, 'SKILL.md');
      if (fs.existsSync(skillFile)) {
        const content = fs.readFileSync(skillFile, 'utf8');
        const folderName = prefix ? `${prefix}/${entry}` : entry;
        skills.push({
          folder: folderName,
          leafFolder: entry,
          path: skillFile,
          content,
          frontmatter: parseFrontmatter(content)
        });
      } else if (stat.isDirectory()) {
        // Check nested (e.g., clawhub/atris)
        walk(fullPath, prefix ? `${prefix}/${entry}` : entry);
      }
    }
  }

  walk(skillsDir, '');
  return skills;
}

// --- Audit Checks ---

function runAuditChecks(skill) {
  const fm = skill.frontmatter || {};
  const checks = [];

  // 1. name exists
  checks.push({
    id: 'name-exists',
    severity: 'ERROR',
    pass: !!fm.name,
    message: fm.name ? `name: ${fm.name}` : 'missing name field'
  });

  // 2. name is kebab-case
  const isKebab = fm.name ? /^[a-z][a-z0-9-]*$/.test(fm.name) : false;
  checks.push({
    id: 'name-kebab',
    severity: 'ERROR',
    pass: isKebab,
    message: isKebab ? 'valid kebab-case' : `"${fm.name || ''}" is not kebab-case`
  });

  // 3. name matches folder
  const nameMatchesFolder = fm.name === skill.leafFolder;
  checks.push({
    id: 'name-matches-folder',
    severity: 'ERROR',
    pass: nameMatchesFolder,
    message: nameMatchesFolder
      ? `matches folder "${skill.leafFolder}"`
      : `name "${fm.name}" != folder "${skill.leafFolder}"`
  });

  // 4. description exists
  checks.push({
    id: 'desc-exists',
    severity: 'ERROR',
    pass: !!fm.description,
    message: fm.description ? `${fm.description.length} chars` : 'missing description'
  });

  // 5. description under 1024 chars
  const descLen = (fm.description || '').length;
  checks.push({
    id: 'desc-length',
    severity: 'WARN',
    pass: descLen <= 1024,
    message: `${descLen}/1024 chars`
  });

  // 6. description has trigger/WHEN guidance
  const desc = (fm.description || '').toLowerCase();
  const hasTriggers = /use when|triggers? on|use for|use if/.test(desc);
  checks.push({
    id: 'desc-has-when',
    severity: 'WARN',
    pass: hasTriggers,
    message: hasTriggers ? 'has WHEN guidance' : 'no trigger/WHEN phrases in description'
  });

  // 7. no XML tags in content (skip placeholders like <name>, <keyword>, code blocks)
  const xmlMatches = skill.content.match(/<[a-zA-Z][^>]*>/g) || [];
  const placeholders = /^<(name|keyword|placeholder|value|type|path|file|dir|id|url|tag|description|your-|user-|project-|skill-)/i;
  const realXml = xmlMatches.filter(t =>
    !t.startsWith('<!--') && !t.startsWith('<!') && !placeholders.test(t)
  );
  checks.push({
    id: 'no-xml-tags',
    severity: 'ERROR',
    pass: realXml.length === 0,
    message: realXml.length === 0 ? 'clean' : `found XML: ${realXml.slice(0, 3).join(', ')}`
  });

  // 8. version field present
  checks.push({
    id: 'version-exists',
    severity: 'WARN',
    pass: !!fm.version,
    message: fm.version ? `v${fm.version}` : 'missing version field'
  });

  // 9. tags field present
  const hasTags = Array.isArray(fm.tags) && fm.tags.length > 0;
  checks.push({
    id: 'tags-exist',
    severity: 'WARN',
    pass: hasTags,
    message: hasTags ? `${fm.tags.length} tags` : 'missing tags field'
  });

  // 10. no README.md in skill folder
  const skillDir = path.dirname(skill.path);
  const hasReadme = fs.existsSync(path.join(skillDir, 'README.md'));
  checks.push({
    id: 'no-readme',
    severity: 'WARN',
    pass: !hasReadme,
    message: hasReadme ? 'README.md found (should not exist in skill folder)' : 'clean'
  });

  // 11. under 5000 words
  const wordCount = skill.content.split(/\s+/).length;
  checks.push({
    id: 'word-count',
    severity: 'INFO',
    pass: wordCount <= 5000,
    message: `${wordCount} words (limit: 5000)`
  });

  // 12. has numbered steps
  const hasSteps = /^\d+\.\s/m.test(skill.content);
  checks.push({
    id: 'has-steps',
    severity: 'INFO',
    pass: hasSteps,
    message: hasSteps ? 'has numbered instructions' : 'no numbered instructions found'
  });

  return checks;
}

function getStatus(checks) {
  const hasError = checks.some(c => !c.pass && c.severity === 'ERROR');
  const hasWarn = checks.some(c => !c.pass && c.severity === 'WARN');
  if (hasError) return 'FAIL';
  if (hasWarn) return 'WARN';
  return 'PASS';
}

// --- Auto-Fix ---

function autoFix(skill, dryRun) {
  const fixes = [];
  let content = skill.content;
  const fm = skill.frontmatter || {};
  const rawFm = getFrontmatterRaw(content);
  if (!rawFm) return fixes;

  let newFmLines = rawFm.split('\n');

  // Fix 1: name mismatch — replace name value with folder name
  if (fm.name && fm.name !== skill.leafFolder) {
    const idx = newFmLines.findIndex(l => l.match(/^name:\s/));
    if (idx !== -1) {
      newFmLines[idx] = `name: ${skill.leafFolder}`;
      fixes.push(`Fixed name: "${fm.name}" -> "${skill.leafFolder}"`);
    }
  }

  // Fix 2: merge triggers into description, remove triggers field
  if (fm.triggers) {
    const triggers = Array.isArray(fm.triggers) ? fm.triggers : [fm.triggers];
    const triggerText = triggers.map(t => `"${t}"`).join(', ');

    // Update description to include triggers
    const descIdx = newFmLines.findIndex(l => l.match(/^description:\s/));
    if (descIdx !== -1) {
      let desc = fm.description || '';
      if (!/triggers? on/i.test(desc)) {
        desc = desc.replace(/\s*$/, '') + ` Triggers on ${triggerText}.`;
        newFmLines[descIdx] = `description: ${desc}`;
      }
    }

    // Remove triggers field (could be inline or block list)
    const trigIdx = newFmLines.findIndex(l => l.match(/^triggers:\s*/));
    if (trigIdx !== -1) {
      // Remove the triggers line and any following list items
      let endIdx = trigIdx + 1;
      while (endIdx < newFmLines.length && newFmLines[endIdx].match(/^\s+-\s/)) {
        endIdx++;
      }
      newFmLines.splice(trigIdx, endIdx - trigIdx);
      fixes.push(`Merged ${triggers.length} triggers into description, removed triggers field`);
    }
  }

  // Fix 3: add version if missing
  if (!fm.version) {
    // Insert after description line
    const descIdx = newFmLines.findIndex(l => l.match(/^description:\s/));
    const insertAt = descIdx !== -1 ? descIdx + 1 : newFmLines.length;
    newFmLines.splice(insertAt, 0, 'version: 1.0.0');
    fixes.push('Added version: 1.0.0');
  }

  // Fix 4: add tags if missing
  const hasTags = Array.isArray(fm.tags) && fm.tags.length > 0;
  if (!hasTags) {
    const tags = generateTags(skill.leafFolder, fm.description || '');
    const tagLines = ['tags:'].concat(tags.map(t => `  - ${t}`));
    newFmLines = newFmLines.concat(tagLines);
    fixes.push(`Added tags: [${tags.join(', ')}]`);
  }

  // Fix 5: remove XML tags from body
  const fmEnd = content.indexOf('\n---', 4);
  if (fmEnd !== -1) {
    let body = content.substring(fmEnd);
    const xmlPattern = /<([a-zA-Z][a-zA-Z0-9]*)[^>]*>([\s\S]*?)<\/\1>/g;
    let xmlCount = 0;
    const newBody = body.replace(xmlPattern, (match, tag, inner) => {
      xmlCount++;
      return `[${inner.trim()}]`;
    });
    if (xmlCount > 0) {
      content = content.substring(0, fmEnd) + newBody;
      fixes.push(`Replaced ${xmlCount} XML tag(s) with bracket notation`);
    }
  }

  if (fixes.length > 0 && !dryRun) {
    // Reconstruct file with new frontmatter
    const fmEndIdx = content.indexOf('\n---', 4);
    const bodyPart = content.substring(fmEndIdx + 4); // after closing ---
    const newContent = '---\n' + newFmLines.join('\n') + '\n---' + bodyPart;

    // Re-apply XML fixes to the full content
    const xmlPattern = /<([a-zA-Z][a-zA-Z0-9]*)[^>]*>([\s\S]*?)<\/\1>/g;
    const finalContent = newContent.replace(xmlPattern, (match, tag, inner) => {
      return `[${inner.trim()}]`;
    });

    fs.writeFileSync(skill.path, finalContent, 'utf8');
  }

  return fixes;
}

function generateTags(folderName, description) {
  const tags = [];

  // Tag from folder name
  tags.push(folderName);

  // Extract keywords from description
  const keywords = {
    'workflow': ['workflow', 'plan', 'process', 'loop'],
    'automation': ['automat', 'autonomous', 'loop', 'execute'],
    'writing': ['writing', 'essay', 'draft', 'edit', 'copy'],
    'frontend': ['frontend', 'ui', 'design', 'css', 'layout', 'component'],
    'backend': ['backend', 'api', 'server', 'database', 'endpoint'],
    'email': ['email', 'gmail', 'inbox', 'message'],
    'memory': ['memory', 'history', 'journal', 'search', 'past'],
    'metacognition': ['metacognition', 'think', 'stuck', 'self-check'],
    'navigation': ['navigation', 'map', 'codebase', 'file:line'],
    'anti-slop': ['slop', 'ai pattern', 'cleanup', 'humanize'],
    'quality': ['audit', 'review', 'validate', 'improve']
  };

  const descLower = description.toLowerCase();
  for (const [tag, patterns] of Object.entries(keywords)) {
    if (tag === folderName) continue; // Already added
    if (patterns.some(p => descLower.includes(p))) {
      tags.push(tag);
    }
  }

  return tags.slice(0, 5); // Max 5 tags
}

// --- Subcommand Handlers ---

function skillList() {
  const skillsDir = path.join(process.cwd(), 'atris', 'skills');
  const skills = findAllSkills(skillsDir);

  if (skills.length === 0) {
    console.log('No skills found in atris/skills/. Run "atris init" first.');
    return;
  }

  console.log('');
  console.log('  Skill              Version    Checks   Status');
  console.log('  ─────              ───────    ──────   ──────');

  let needsAttention = 0;
  for (const skill of skills) {
    const checks = runAuditChecks(skill);
    const passing = checks.filter(c => c.pass).length;
    const total = checks.length;
    const status = getStatus(checks);
    const version = (skill.frontmatter || {}).version || '-';
    const statusIcon = status === 'PASS' ? '\x1b[32mPASS\x1b[0m'
                     : status === 'WARN' ? '\x1b[33mWARN\x1b[0m'
                     : '\x1b[31mFAIL\x1b[0m';

    if (status !== 'PASS') needsAttention++;

    const name = skill.folder.padEnd(18);
    const ver = version.padEnd(10);
    const score = `${passing}/${total}`.padEnd(8);
    console.log(`  ${name} ${ver} ${score} ${statusIcon}`);
  }

  console.log('');
  if (needsAttention > 0) {
    console.log(`  ${needsAttention} skill(s) need attention. Run: atris skill audit --all`);
  } else {
    console.log('  All skills passing.');
  }
  console.log('');
}

function skillAudit(name) {
  const skillsDir = path.join(process.cwd(), 'atris', 'skills');
  const allSkills = findAllSkills(skillsDir);

  const targets = name === '--all'
    ? allSkills
    : allSkills.filter(s => s.folder === name || s.leafFolder === name);

  if (targets.length === 0) {
    console.error(`Skill "${name}" not found. Run "atris skill list" to see available skills.`);
    process.exit(1);
  }

  for (const skill of targets) {
    const checks = runAuditChecks(skill);
    const errors = checks.filter(c => !c.pass && c.severity === 'ERROR').length;
    const warns = checks.filter(c => !c.pass && c.severity === 'WARN').length;
    const passing = checks.filter(c => c.pass).length;

    console.log('');
    console.log(`  Audit: ${skill.folder}`);
    console.log('  ' + '─'.repeat(40));

    for (const check of checks) {
      const icon = check.pass ? '\x1b[32m\u2713\x1b[0m' : '\x1b[31m\u2717\x1b[0m';
      const id = check.id.padEnd(22);
      console.log(`  ${icon} ${id} ${check.message}`);
    }

    console.log('');
    console.log(`  Score: ${passing}/${checks.length} (${errors} errors, ${warns} warnings)`);

    if (errors > 0 || warns > 0) {
      console.log(`  Run: atris skill fix ${skill.folder}`);
    }
    console.log('');
  }
}

function skillFix(name) {
  const skillsDir = path.join(process.cwd(), 'atris', 'skills');
  const allSkills = findAllSkills(skillsDir);

  const targets = name === '--all'
    ? allSkills
    : allSkills.filter(s => s.folder === name || s.leafFolder === name);

  if (targets.length === 0) {
    console.error(`Skill "${name}" not found. Run "atris skill list" to see available skills.`);
    process.exit(1);
  }

  let totalFixes = 0;

  for (const skill of targets) {
    const fixes = autoFix(skill, false);

    if (fixes.length > 0) {
      console.log('');
      console.log(`  Fixing: ${skill.folder}`);
      for (const fix of fixes) {
        console.log(`  \x1b[32m\u2713\x1b[0m ${fix}`);
      }
      totalFixes += fixes.length;
    }
  }

  if (totalFixes === 0) {
    console.log('');
    console.log('  Nothing to fix. All auto-fixable issues already resolved.');
  } else {
    console.log('');
    console.log(`  ${totalFixes} fix(es) applied. Run: atris skill audit ${name}`);
  }
  console.log('');
}

// --- Main Dispatcher ---

function skillCommand(subcommand, ...args) {
  switch (subcommand) {
    case 'list':
    case 'ls':
      return skillList();
    case 'audit':
      return skillAudit(args[0] || '--all');
    case 'fix':
      return skillFix(args[0] || '--all');
    default:
      console.log('');
      console.log('Usage: atris skill <subcommand> [name]');
      console.log('');
      console.log('Subcommands:');
      console.log('  list              Show all skills with compliance status');
      console.log('  audit [name|--all]  Validate skill against Anthropic guide');
      console.log('  fix [name|--all]    Auto-fix common compliance issues');
      console.log('');
  }
}

module.exports = { skillCommand, parseFrontmatter, runAuditChecks, findAllSkills };
