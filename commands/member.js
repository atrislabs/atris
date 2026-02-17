const fs = require('fs');
const path = require('path');

// --- YAML Frontmatter Parser (shared with skill.js) ---

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const yaml = match[1];
  const result = {};
  let currentKey = null;

  for (const line of yaml.split('\n')) {
    const listMatch = line.match(/^\s+-\s+(.+)$/);
    if (listMatch && currentKey) {
      if (!Array.isArray(result[currentKey])) result[currentKey] = [];
      result[currentKey].push(listMatch[1].trim());
      continue;
    }

    const nestedMatch = line.match(/^\s+([a-z_-]+):\s*(.*)$/);
    if (nestedMatch && currentKey && typeof result[currentKey] === 'object' && !Array.isArray(result[currentKey])) {
      const val = nestedMatch[2].trim();
      result[currentKey][nestedMatch[1]] = val === 'true' ? true : val === 'false' ? false : val || true;
      continue;
    }

    const kvMatch = line.match(/^([a-z_-]+):\s*(.*)$/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      const val = kvMatch[2].trim();
      if (val === '') {
        result[currentKey] = {};
      } else if (val.startsWith('[') && val.endsWith(']')) {
        result[currentKey] = val.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
      } else {
        result[currentKey] = val.replace(/^["']|["']$/g, '');
      }
    }
  }

  return result;
}

// --- Member Discovery ---

function findAllMembers(teamDir) {
  if (!fs.existsSync(teamDir)) return [];

  const members = [];
  const entries = fs.readdirSync(teamDir);

  for (const entry of entries) {
    const fullPath = path.join(teamDir, entry);
    const stat = fs.statSync(fullPath);

    // Directory format: team/<name>/MEMBER.md
    if (stat.isDirectory()) {
      const memberFile = path.join(fullPath, 'MEMBER.md');
      if (fs.existsSync(memberFile)) {
        const content = fs.readFileSync(memberFile, 'utf8');
        const fm = parseFrontmatter(content) || {};

        // Count local skills
        const skillsDir = path.join(fullPath, 'skills');
        let skillCount = 0;
        if (fs.existsSync(skillsDir)) {
          const skillEntries = fs.readdirSync(skillsDir);
          for (const s of skillEntries) {
            if (fs.existsSync(path.join(skillsDir, s, 'SKILL.md'))) skillCount++;
          }
        }

        // Count context files
        const contextDir = path.join(fullPath, 'context');
        let contextCount = 0;
        if (fs.existsSync(contextDir)) {
          contextCount = fs.readdirSync(contextDir).filter(f => f.endsWith('.md')).length;
        }

        // Check for tools
        const toolsDir = path.join(fullPath, 'tools');
        const hasTools = fs.existsSync(toolsDir);

        members.push({
          name: fm.name || entry,
          role: fm.role || '(no role)',
          description: fm.description || '',
          version: fm.version || '',
          format: 'directory',
          path: memberFile,
          dir: fullPath,
          skillCount,
          contextCount,
          hasTools,
          skills: Array.isArray(fm.skills) ? fm.skills : [],
          permissions: fm.permissions || {},
          frontmatter: fm
        });
      }
      continue;
    }

    // Flat file format: team/<name>.md
    if (entry.endsWith('.md') && stat.isFile()) {
      const content = fs.readFileSync(fullPath, 'utf8');
      const fm = parseFrontmatter(content);
      if (!fm) continue; // No frontmatter = not a member

      const name = entry.replace('.md', '');
      members.push({
        name: fm.name || name,
        role: fm.role || '(no role)',
        description: fm.description || '',
        version: fm.version || '',
        format: 'flat',
        path: fullPath,
        dir: path.dirname(fullPath),
        skillCount: 0,
        contextCount: 0,
        hasTools: false,
        skills: Array.isArray(fm.skills) ? fm.skills : [],
        permissions: fm.permissions || {},
        frontmatter: fm
      });
    }
  }

  return members;
}

// --- LIST subcommand ---

function memberList() {
  const teamDir = path.join(process.cwd(), 'atris', 'team');
  const members = findAllMembers(teamDir);

  if (members.length === 0) {
    console.log('No team members found in atris/team/.');
    console.log('Run "atris member create <name>" to create one.');
    return;
  }

  console.log('');
  console.log('Team Members');
  console.log('─'.repeat(70));

  const nameW = 16;
  const roleW = 16;
  const fmtW = 6;
  const skillW = 8;
  const ctxW = 8;

  console.log(
    '  ' +
    'Name'.padEnd(nameW) +
    'Role'.padEnd(roleW) +
    'Format'.padEnd(fmtW) +
    'Skills'.padEnd(skillW) +
    'Context'.padEnd(ctxW) +
    'Version'
  );
  console.log('  ' + '─'.repeat(66));

  for (const m of members) {
    const skills = m.format === 'directory' ? String(m.skillCount) : '-';
    const context = m.format === 'directory' ? String(m.contextCount) : '-';
    console.log(
      '  ' +
      m.name.padEnd(nameW) +
      m.role.substring(0, roleW - 1).padEnd(roleW) +
      (m.format === 'directory' ? 'dir' : 'flat').padEnd(fmtW) +
      skills.padEnd(skillW) +
      context.padEnd(ctxW) +
      (m.version || '-')
    );
  }

  console.log('');
  console.log(`${members.length} member(s) found.`);
}

// --- CREATE subcommand ---

function memberCreate(name, ...flags) {
  if (!name) {
    console.error('Usage: atris member create <name> [--role="Title"]');
    process.exit(1);
  }

  // Parse flags
  let role = name.charAt(0).toUpperCase() + name.slice(1).replace(/-/g, ' ');
  let description = '';

  for (const flag of flags) {
    const roleMatch = flag.match(/^--role=["']?(.+?)["']?$/);
    if (roleMatch) role = roleMatch[1];

    const descMatch = flag.match(/^--description=["']?(.+?)["']?$/);
    if (descMatch) description = descMatch[1];
  }

  const teamDir = path.join(process.cwd(), 'atris', 'team');
  const memberDir = path.join(teamDir, name);
  const memberFile = path.join(memberDir, 'MEMBER.md');
  const legacyFile = path.join(teamDir, `${name}.md`);

  // Check for existing
  if (fs.existsSync(memberFile)) {
    console.error(`Member "${name}" already exists at team/${name}/MEMBER.md`);
    process.exit(1);
  }
  if (fs.existsSync(legacyFile)) {
    console.error(`Member "${name}" already exists at team/${name}.md`);
    console.log(`Run "atris member upgrade ${name}" to convert to directory format.`);
    process.exit(1);
  }

  // Scaffold
  fs.mkdirSync(memberDir, { recursive: true });
  fs.mkdirSync(path.join(memberDir, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(memberDir, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(memberDir, 'context'), { recursive: true });

  const content = `---
name: ${name}
role: ${role}
description: ${description || `Handles ${role.toLowerCase()} tasks`}
version: 1.0.0

skills: []

permissions:
  can-read: true
---

# ${role}

## Persona

(Define how this member communicates, their tone, and decision-making style)

## Workflow

1. Step one
2. Step two
3. Step three

## Rules

1. Rule one
2. Rule two
`;

  fs.writeFileSync(memberFile, content);

  console.log('');
  console.log(`✓ Created team/${name}/MEMBER.md`);
  console.log(`✓ Created team/${name}/skills/`);
  console.log(`✓ Created team/${name}/tools/`);
  console.log(`✓ Created team/${name}/context/`);
  console.log('');
  console.log(`Next: edit team/${name}/MEMBER.md to define persona, workflow, and permissions.`);
  console.log(`      add skills to team/${name}/skills/<skill-name>/SKILL.md`);
  console.log(`      add context docs to team/${name}/context/`);
}

// --- ACTIVATE subcommand ---

function memberActivate(name) {
  if (!name) {
    console.error('Usage: atris member activate <name>');
    process.exit(1);
  }

  const teamDir = path.join(process.cwd(), 'atris', 'team');
  const memberDir = path.join(teamDir, name);
  const memberFile = path.join(memberDir, 'MEMBER.md');
  const legacyFile = path.join(teamDir, `${name}.md`);

  // Find the member (directory first, flat fallback)
  let activePath = null;
  let activeDir = null;
  let isLegacy = false;

  if (fs.existsSync(memberFile)) {
    activePath = memberFile;
    activeDir = memberDir;
  } else if (fs.existsSync(legacyFile)) {
    activePath = legacyFile;
    activeDir = teamDir;
    isLegacy = true;
  } else {
    console.error(`Member "${name}" not found. Run "atris member list".`);
    process.exit(1);
  }

  const content = fs.readFileSync(activePath, 'utf8');
  const fm = parseFrontmatter(content) || {};

  console.log('');
  console.log(`Activating: ${fm.name || name} (${fm.role || 'no role'})`);

  // If legacy format, offer upgrade
  if (isLegacy) {
    console.log(`  Format: flat file (team/${name}.md)`);
    console.log(`  Tip: run "atris member upgrade ${name}" to convert to directory format.`);
  }

  // Symlink member's local skills to system-level
  if (!isLegacy) {
    const skillsDir = path.join(activeDir, 'skills');
    if (fs.existsSync(skillsDir)) {
      const home = require('os').homedir();
      const toolDirs = [
        { dir: path.join(home, '.claude', 'skills'), label: 'Claude' },
        { dir: path.join(home, '.codex', 'skills'), label: 'Codex' },
        { dir: path.join(home, '.cursor', 'skills'), label: 'Cursor' },
      ];

      for (const { dir } of toolDirs) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const skillEntries = fs.readdirSync(skillsDir);
      let linked = 0;

      for (const entry of skillEntries) {
        const skillDir = path.join(skillsDir, entry);
        if (!fs.statSync(skillDir).isDirectory()) continue;
        if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) continue;

        for (const { dir, label } of toolDirs) {
          const linkPath = path.join(dir, entry);
          if (fs.existsSync(linkPath)) continue;

          try {
            fs.symlinkSync(skillDir, linkPath);
          } catch (e) { /* silent */ }
        }
        linked++;
        console.log(`  ✓ Linked skill: ${entry}`);
      }

      if (linked === 0) {
        console.log('  No local skills to link.');
      }
    }

    // Show context files
    const contextDir = path.join(activeDir, 'context');
    if (fs.existsSync(contextDir)) {
      const ctxFiles = fs.readdirSync(contextDir).filter(f => f.endsWith('.md'));
      if (ctxFiles.length > 0) {
        console.log(`  Context: ${ctxFiles.join(', ')}`);
      }
    }

    // Show tools
    const toolsDir = path.join(activeDir, 'tools');
    if (fs.existsSync(toolsDir)) {
      const toolFiles = fs.readdirSync(toolsDir);
      if (toolFiles.length > 0) {
        console.log(`  Tools: ${toolFiles.join(', ')}`);
      }
    }
  }

  // Show permissions
  if (fm.permissions && typeof fm.permissions === 'object') {
    const perms = Object.entries(fm.permissions);
    if (perms.length > 0) {
      const allowed = perms.filter(([, v]) => v === true || v === 'true').map(([k]) => k);
      const denied = perms.filter(([, v]) => v === false || v === 'false').map(([k]) => k);
      if (allowed.length) console.log(`  Allowed: ${allowed.join(', ')}`);
      if (denied.length) console.log(`  Denied: ${denied.join(', ')}`);
    }
  }

  console.log('');
  console.log(`Member "${fm.name || name}" activated.`);
  console.log(`Tell your agent: "You are the ${fm.role || name}. Read team/${name}/MEMBER.md."`);
}

// --- UPGRADE subcommand ---

function memberUpgrade(name) {
  if (!name) {
    console.error('Usage: atris member upgrade <name>');
    process.exit(1);
  }

  const teamDir = path.join(process.cwd(), 'atris', 'team');
  const legacyFile = path.join(teamDir, `${name}.md`);
  const memberDir = path.join(teamDir, name);
  const memberFile = path.join(memberDir, 'MEMBER.md');

  if (!fs.existsSync(legacyFile)) {
    if (fs.existsSync(memberFile)) {
      console.log(`"${name}" is already in directory format.`);
    } else {
      console.error(`Member "${name}" not found at team/${name}.md`);
    }
    return;
  }

  if (fs.existsSync(memberDir)) {
    console.error(`Directory team/${name}/ already exists. Resolve manually.`);
    process.exit(1);
  }

  // Move flat file to directory format
  fs.mkdirSync(memberDir, { recursive: true });
  fs.mkdirSync(path.join(memberDir, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(memberDir, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(memberDir, 'context'), { recursive: true });
  fs.renameSync(legacyFile, memberFile);

  console.log(`✓ Upgraded team/${name}.md → team/${name}/MEMBER.md`);
  console.log(`✓ Created skills/, tools/, context/ directories`);
}

// --- Command Dispatcher ---

function memberCommand(subcommand, ...args) {
  switch (subcommand) {
    case 'list':
    case 'ls':
      return memberList();
    case 'create':
    case 'new':
      return memberCreate(args[0], ...args.slice(1));
    case 'activate':
      return memberActivate(args[0]);
    case 'upgrade':
      return memberUpgrade(args[0]);
    default:
      console.log('');
      console.log('Usage: atris member <subcommand> [name]');
      console.log('');
      console.log('Subcommands:');
      console.log('  create <name>       Scaffold a new team member (MEMBER.md + dirs)');
      console.log('  list                Show all team members');
      console.log('  activate <name>     Symlink member skills, show context and permissions');
      console.log('  upgrade <name>      Convert flat file (name.md) to directory format');
      console.log('');
      console.log('Create flags:');
      console.log('  --role="Title"         Set the member role');
      console.log('  --description="..."    Set the member description');
      console.log('');
      console.log('Examples:');
      console.log('  atris member create sdr --role="Sales Development Rep"');
      console.log('  atris member list');
      console.log('  atris member activate navigator');
      console.log('  atris member upgrade executor');
      console.log('');
  }
}

module.exports = { memberCommand, findAllMembers, parseFrontmatter };
