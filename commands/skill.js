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

function localSkillsDir() {
  return path.join(process.cwd(), 'atris', 'skills');
}

function bundledSkillsDir() {
  return path.join(__dirname, '..', 'atris', 'skills');
}

function readableSkillRoots() {
  const roots = [localSkillsDir(), bundledSkillsDir()];
  const seen = new Set();
  return roots.filter((root) => {
    if (!root || !fs.existsSync(root)) return false;
    const real = fs.realpathSync(root);
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
}

function findReadableSkills() {
  const seen = new Set();
  const skills = [];
  for (const root of readableSkillRoots()) {
    for (const skill of findAllSkills(root)) {
      if (seen.has(skill.folder)) continue;
      seen.add(skill.folder);
      skills.push(skill);
    }
  }
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
  const proseContent = skill.content
    .replace(/```[\s\S]*?```/g, '')   // fenced code blocks
    .replace(/`[^`\n]*`/g, '');        // inline code spans
  const xmlMatches = proseContent.match(/<[a-zA-Z][^>]*>/g) || [];
  // Single-letter tags like <X>/<N> are prose placeholders, not real XML.
  const placeholders = /^<(name|keyword|placeholder|value|type|path|file|dir|id|url|tag|description|your-|user-|project-|skill-|[a-zA-Z]>)/i;
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

  // 11. under 5000 words (body only, excluding frontmatter)
  const bodyStart = skill.content.indexOf('---', skill.content.indexOf('---') + 3);
  const bodyContent = bodyStart >= 0 ? skill.content.slice(bodyStart + 3) : skill.content;
  const wordCount = bodyContent.split(/\s+/).filter(Boolean).length;
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
  const skills = findReadableSkills();

  if (skills.length === 0) {
    console.log('No skills found in local or bundled Atris skill roots.');
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
  const allSkills = findReadableSkills();

  const targets = name === '--all'
    ? allSkills
    : allSkills.filter(s => s.folder === name || s.leafFolder === name);

  if (targets.length === 0) {
    console.error(`Skill "${name}" not found. Run "atris skill list" to see available local and bundled skills.`);
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

// --- Skill Scaffold Template ---

function generateSkillTemplate(name, description) {
  return `---
name: ${name}
description: "${(description || `Custom skill for ${name}. Use when user asks about ${name}-related tasks.`).replace(/"/g, '\\"')}"
version: 1.0.0
tags:
  - ${name}
---

# ${name}

## What This Skill Does

Describe what this skill does in 2-3 sentences.

## Workflows

### "Example trigger phrase"

1. Step one
2. Step two
3. Step three

## Rules

- Always confirm before taking destructive actions
- Never skip the approval gate on sends/deletes
`;
}

function generateIntegrationSkillTemplate(name, description) {
  return `---
name: ${name}
description: ${description || `Integration skill for ${name}. Use when user asks about ${name}-related tasks.`}
version: 1.0.0
tags:
  - ${name}
  - integration
---

# ${name}

## Bootstrap (ALWAYS Run First)

Before any operation, run this bootstrap to ensure everything is set up:

\`\`\`bash
#!/bin/bash
set -e

# 1. Check if logged in to AtrisOS
if [ ! -f ~/.atris/credentials.json ]; then
  echo "Not logged in to AtrisOS."
  echo "Run: atris login"
  exit 1
fi

# 2. Extract token
TOKEN=$(node -e "console.log(require('$HOME/.atris/credentials.json').token)")

# 3. Check connection status
STATUS=$(curl -s "https://api.atris.ai/api/integrations/YOUR_INTEGRATION/status" \\
  -H "Authorization: Bearer $TOKEN")

echo "$STATUS"
export ATRIS_TOKEN="$TOKEN"
\`\`\`

## API Reference

Base: \`https://api.atris.ai/api/integrations/YOUR_INTEGRATION\`

All requests require: \`-H "Authorization: Bearer $TOKEN"\`

### Get Token (after bootstrap)
\`\`\`bash
TOKEN=$(node -e "console.log(require('$HOME/.atris/credentials.json').token)")
\`\`\`

### List Items
\`\`\`bash
curl -s "https://api.atris.ai/api/integrations/YOUR_INTEGRATION/items" \\
  -H "Authorization: Bearer $TOKEN"
\`\`\`

## Workflows

### "Example trigger phrase"

1. Run bootstrap
2. Call the API
3. Display results
4. **Confirm with user before any write action**

## Error Handling

| Error | Meaning | Solution |
|-------|---------|----------|
| \`Token expired\` | AtrisOS session expired | Run \`atris login\` |
| \`401 Unauthorized\` | Invalid/expired token | Run \`atris login\` |
| \`429 Rate limited\` | Too many requests | Wait 60s, retry |

## Security Model

1. **Local token** (\`~/.atris/credentials.json\`): Stored locally with 600 permissions.
2. **Integration credentials**: Stored server-side in AtrisOS encrypted vault. Never local.
3. **HTTPS only**: All API communication encrypted in transit.
`;
}

// --- CREATE subcommand ---

function skillCreate(nameArg, ...flags) {
  if (!nameArg) {
    console.error('Usage: atris skill create <name> [--integration] [--description="..."] [--local]');
    console.error('');
    console.error('Examples:');
    console.error('  atris skill create daily-standup');
    console.error('  atris skill create email-outreach --integration');
    console.error('  atris skill create example-co/bol-processor --integration');
    console.error('  atris skill create my-skill --local     # project only, skip system dirs');
    process.exit(1);
  }

  const isIntegration = flags.includes('--integration');
  const isLocal = flags.includes('--local');
  const descFlag = flags.find(f => f.startsWith('--description='));
  const description = descFlag ? descFlag.split('=').slice(1).join('=').replace(/^["']|["']$/g, '') : '';

  // Parse name — supports "customer/skill-name" format
  let skillDir, skillName, customerName;
  if (nameArg.includes('/')) {
    const parts = nameArg.split('/');
    customerName = parts[0];
    skillName = parts[1];
    const customersDir = path.join(process.cwd(), 'atris', 'customers', customerName, 'skills');
    skillDir = path.join(customersDir, skillName);
  } else {
    skillName = nameArg;
    skillDir = path.join(process.cwd(), 'atris', 'skills', skillName);
  }

  // Check if already exists
  if (fs.existsSync(skillDir)) {
    console.error(`✗ Skill "${nameArg}" already exists at ${skillDir}`);
    process.exit(1);
  }

  // Generate content
  const content = isIntegration
    ? generateIntegrationSkillTemplate(skillName, description)
    : generateSkillTemplate(skillName, description);

  // Create skill directory and SKILL.md
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content);

  console.log('');
  if (customerName) {
    console.log(`✓ Created atris/customers/${customerName}/skills/${skillName}/SKILL.md`);
  } else {
    console.log(`✓ Created atris/skills/${skillName}/SKILL.md`);
  }

  // Symlink to project-level .claude/skills/
  const projectClaudeSkills = path.join(process.cwd(), '.claude', 'skills');
  if (fs.existsSync(path.join(process.cwd(), '.claude'))) {
    fs.mkdirSync(projectClaudeSkills, { recursive: true });
    const projectLink = path.join(projectClaudeSkills, skillName);
    if (!fs.existsSync(projectLink)) {
      try {
        const relTarget = path.relative(projectClaudeSkills, skillDir);
        fs.symlinkSync(relTarget, projectLink);
        console.log(`✓ Linked .claude/skills/${skillName} (project-level)`);
      } catch (e) {
        // Copy fallback
        fs.mkdirSync(projectLink, { recursive: true });
        fs.copyFileSync(path.join(skillDir, 'SKILL.md'), path.join(projectLink, 'SKILL.md'));
        console.log(`✓ Copied to .claude/skills/${skillName} (project-level)`);
      }
    }
  }

  // Symlink to all AI tool skill directories (always, unless --local)
  if (!isLocal) {
    const home = require('os').homedir();
    const toolDirs = [
      { dir: path.join(home, '.claude', 'skills'), label: 'Claude' },
      { dir: path.join(home, '.codex', 'skills'), label: 'Codex' },
      { dir: path.join(home, '.cursor', 'skills'), label: 'Cursor' },
    ];

    const linked = [];
    for (const { dir, label } of toolDirs) {
      fs.mkdirSync(dir, { recursive: true });
      const linkPath = path.join(dir, skillName);
      if (!fs.existsSync(linkPath)) {
        try {
          fs.symlinkSync(skillDir, linkPath);
          linked.push(label);
        } catch (e) {
          // Copy fallback
          fs.mkdirSync(linkPath, { recursive: true });
          fs.copyFileSync(path.join(skillDir, 'SKILL.md'), path.join(linkPath, 'SKILL.md'));
          linked.push(label);
        }
      }
    }
    if (linked.length > 0) {
      console.log(`✓ Linked to ${linked.join(', ')} (system-level — all tools)`);
    }
  }

  // Summary
  console.log('');
  if (isIntegration) {
    console.log('  Template: integration (bootstrap + API reference + error handling)');
  } else {
    console.log('  Template: standard (workflows + rules)');
  }
  console.log(`  Edit: ${path.join(skillDir, 'SKILL.md')}`);
  console.log('');
}

// --- LINK subcommand (system-level symlink for existing skills) ---

function skillLink(name, ...flags) {
  const isAll = name === '--all';

  const skillsDir = path.join(process.cwd(), 'atris', 'skills');
  const allSkills = findAllSkills(skillsDir);

  if (allSkills.length === 0) {
    console.error('No skills found in atris/skills/.');
    process.exit(1);
  }

  const targets = isAll
    ? allSkills
    : allSkills.filter(s => s.folder === name || s.leafFolder === name);

  if (targets.length === 0) {
    console.error(`Skill "${name}" not found. Run "atris skill list".`);
    process.exit(1);
  }

  const home = require('os').homedir();
  const toolDirs = [
    { dir: path.join(home, '.claude', 'skills'), label: 'Claude' },
    { dir: path.join(home, '.codex', 'skills'), label: 'Codex' },
    { dir: path.join(home, '.cursor', 'skills'), label: 'Cursor' },
  ];

  // Ensure all tool directories exist
  for (const { dir } of toolDirs) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let linked = 0;
  for (const skill of targets) {
    const srcDir = path.dirname(skill.path);
    const linkName = skill.leafFolder;
    const toolsLinked = [];

    for (const { dir, label } of toolDirs) {
      const linkPath = path.join(dir, linkName);

      if (fs.existsSync(linkPath)) {
        try {
          const existing = fs.readlinkSync(linkPath);
          if (existing === srcDir || path.resolve(linkPath, '..', existing) === srcDir) {
            continue; // Already linked correctly
          }
        } catch (e) {
          continue; // Not a symlink, skip
        }
      }

      try {
        fs.symlinkSync(srcDir, linkPath);
        toolsLinked.push(label);
      } catch (e) {
        // silent fail per tool
      }
    }

    if (toolsLinked.length > 0) {
      console.log(`✓ ${linkName} → ${toolsLinked.join(', ')}`);
      linked++;
    }
  }

  if (linked === 0) {
    console.log('All skills already linked at system level.');
  } else {
    console.log(`\n${linked} skill(s) linked to ~/.claude/skills/ (available in all tools).`);
  }
}

// --- DELETE subcommand ---

function skillDelete(name) {
  if (!name) {
    console.error('Usage: atris skill delete <name>');
    process.exit(1);
  }

  const home = require('os').homedir();
  const removed = [];

  // Remove from atris/skills/
  const skillDir = path.join(process.cwd(), 'atris', 'skills', name);
  if (fs.existsSync(skillDir)) {
    fs.rmSync(skillDir, { recursive: true, force: true });
    removed.push(`atris/skills/${name}`);
  }

  // Remove from atris/customers/ (check all customers)
  const customersDir = path.join(process.cwd(), 'atris', 'customers');
  if (fs.existsSync(customersDir)) {
    const customers = fs.readdirSync(customersDir);
    for (const customer of customers) {
      const custSkillDir = path.join(customersDir, customer, 'skills', name);
      if (fs.existsSync(custSkillDir)) {
        fs.rmSync(custSkillDir, { recursive: true, force: true });
        removed.push(`atris/customers/${customer}/skills/${name}`);
      }
    }
  }

  // Remove symlinks — use unlinkSync for symlinks, rmSync for directories
  function removeLink(linkPath, label) {
    try {
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(linkPath);
      } else {
        fs.rmSync(linkPath, { recursive: true, force: true });
      }
      removed.push(label);
    } catch (e) { /* doesn't exist */ }
  }

  // Project-level
  removeLink(path.join(process.cwd(), '.claude', 'skills', name), `.claude/skills/${name}`);

  // System-level — all tool directories
  const toolDirs = [
    { dir: path.join(home, '.claude', 'skills', name), label: '~/.claude' },
    { dir: path.join(home, '.codex', 'skills', name), label: '~/.codex' },
    { dir: path.join(home, '.cursor', 'skills', name), label: '~/.cursor' },
  ];

  for (const { dir, label } of toolDirs) {
    removeLink(dir, `${label}/skills/${name}`);
  }

  if (removed.length === 0) {
    console.error(`✗ Skill "${name}" not found anywhere.`);
    process.exit(1);
  }

  console.log('');
  for (const r of removed) {
    console.log(`✓ Removed ${r}`);
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
    case 'create':
    case 'new':
      return skillCreate(args[0], ...args.slice(1));
    case 'link':
      return skillLink(args[0] || '--all', ...args.slice(1));
    case 'delete':
    case 'rm':
    case 'remove':
      return skillDelete(args[0]);
    default:
      console.log('');
      console.log('Usage: atris skill <subcommand> [name]');
      console.log('');
      console.log('Subcommands:');
      console.log('  create <name>       Scaffold a new skill with SKILL.md template');
      console.log('  delete <name>       Remove a skill and all its symlinks');
      console.log('  link [name|--all]   Symlink skills to ~/.claude/skills/ (system-level)');
      console.log('  list                Show all skills with compliance status');
      console.log('  audit [name|--all]  Validate skill against Anthropic guide');
      console.log('  fix [name|--all]    Auto-fix common compliance issues');
      console.log('');
      console.log('Create flags:');
      console.log('  --integration       Use integration template (bootstrap + API)');
      console.log('  --local             Only link to this project (skip system-level)');
      console.log('  --description="..."  Set the skill description');
      console.log('');
      console.log('Examples:');
      console.log('  atris skill create daily-standup');
      console.log('  atris skill create email-outreach --integration');
      console.log('  atris skill create example-co/bol-processor --integration');
      console.log('  atris skill link --all');
      console.log('');
  }
}

module.exports = { skillCommand, parseFrontmatter, runAuditChecks, findAllSkills };
