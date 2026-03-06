const fs = require('fs');
const path = require('path');
const { loadCredentials } = require('../utils/auth');
const { apiRequestJson } = require('../utils/api');
const { findAllMembers } = require('./member');
const { loadConfig } = require('../utils/config');
const { getLogPath } = require('../lib/file-ops');
const { parseJournalSections, mergeSections, reconstructJournal } = require('../lib/journal');

async function pullAtris() {
  const targetDir = path.join(process.cwd(), 'atris');

  if (!fs.existsSync(targetDir)) {
    console.error('atris/ folder not found. Run "atris init" first.');
    process.exit(1);
  }

  const creds = loadCredentials();
  if (!creds || !creds.token) {
    console.error('Not logged in. Run: atris login');
    process.exit(1);
  }

  console.log('');
  console.log('Pulling from cloud...');
  console.log('');

  let totalSynced = 0;

  // --- 1. General journal sync ---
  const config = loadConfig();
  if (config.agent_id) {
    const journalSynced = await pullGeneralJournal(creds.token, config.agent_id);
    totalSynced += journalSynced;
  } else {
    console.log('  Skip general journal (no agent selected, run "atris agent")');
  }

  // --- 2. Member journal sync ---
  const teamDir = path.join(targetDir, 'team');
  const members = findAllMembers(teamDir);
  const membersWithAgents = members.filter(m => m.frontmatter && m.frontmatter['agent-id']);

  if (membersWithAgents.length === 0) {
    console.log('  No members with cloud agents (run "atris member push <name>")');
  } else {
    for (const member of membersWithAgents) {
      const agentId = member.frontmatter['agent-id'];
      const synced = await pullMemberJournal(creds.token, agentId, member.name, member.dir);
      totalSynced += synced;
    }
  }

  // --- Summary ---
  console.log('');
  if (totalSynced > 0) {
    console.log(`Done. ${totalSynced} file${totalSynced > 1 ? 's' : ''} synced.`);
  } else {
    console.log('Everything up to date.');
  }
}

async function pullGeneralJournal(token, agentId) {
  // Pull today's journal and recent days
  const today = new Date();
  const dates = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().split('T')[0]);
  }

  let synced = 0;

  for (const date of dates) {
    const result = await apiRequestJson(`/agents/${agentId}/journal/${date}`, {
      method: 'GET',
      token,
    });

    if (!result.ok || !result.data || !result.data.content) continue;

    const remoteContent = result.data.content;
    const { logFile, yearDir } = getLogPath(date);

    if (!fs.existsSync(yearDir)) {
      fs.mkdirSync(yearDir, { recursive: true });
    }

    const localContent = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';

    if (localContent.trim() === remoteContent.trim()) continue;

    if (!localContent || localContent.trim() === '') {
      // No local — just write remote
      fs.writeFileSync(logFile, remoteContent);
      console.log(`  Journal ${date} pulled`);
      synced++;
    } else {
      // Both exist and differ — merge
      try {
        const localSections = parseJournalSections(localContent);
        const remoteSections = parseJournalSections(remoteContent);
        const { merged, conflicts } = mergeSections(localSections, remoteSections);

        if (conflicts.length === 0) {
          const mergedContent = reconstructJournal(merged);
          fs.writeFileSync(logFile, mergedContent);
          console.log(`  Journal ${date} merged`);
          synced++;
        } else {
          // Conflicts — keep local, warn
          console.log(`  Journal ${date} has conflicts (kept local, run "atris log sync" to resolve)`);
        }
      } catch {
        console.log(`  Journal ${date} differs (run "atris log sync" to resolve)`);
      }
    }
  }

  if (synced === 0) {
    console.log('  General journal: up to date');
  }

  return synced;
}

async function pullMemberJournal(token, agentId, memberName, memberDir) {
  const result = await apiRequestJson(`/agent/${agentId}/export-journal`, {
    method: 'GET',
    token,
  });

  if (!result.ok || !result.data || !result.data.files) {
    console.log(`  ${memberName}: no journal entries`);
    return 0;
  }

  const files = result.data.files;
  let synced = 0;

  for (const file of files) {
    if (!file.path || !file.content) continue;

    const localPath = path.resolve(memberDir, file.path);
    if (!localPath.startsWith(path.resolve(memberDir))) continue;
    const localContent = fs.existsSync(localPath) ? fs.readFileSync(localPath, 'utf8') : '';

    if (localContent.trim() === file.content.trim()) continue;

    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, file.content);
    synced++;
  }

  if (synced > 0) {
    console.log(`  ${memberName}: ${synced} journal ${synced === 1 ? 'entry' : 'entries'} pulled`);
  } else {
    console.log(`  ${memberName}: up to date`);
  }

  return synced;
}

module.exports = { pullAtris };
