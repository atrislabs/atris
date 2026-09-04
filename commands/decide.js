'use strict';

const {
  answerMissionHumanAsk,
  listMissions,
  listWorktreeRollupMissions,
  pingMission,
} = require('./mission');
const { openHumanAsks, normalizeHumanAsks } = require('../lib/mission-human-asks');
const { redirectToWorkspaceRoot } = require('../lib/mission-root');
const { shortId } = require('../lib/short-name');

const TERMINAL_STATUSES = new Set(['stopped', 'complete']);

function missionTouchedAt(mission) {
  return String(mission.updated_at || mission.created_at || '');
}

function liveMissions(root = process.cwd()) {
  const seen = new Set();
  return [...listMissions(root), ...listWorktreeRollupMissions(root)]
    .filter((mission) => {
      if (!mission || !mission.id || seen.has(mission.id) || TERMINAL_STATUSES.has(mission.status)) return false;
      seen.add(mission.id);
      return true;
    })
    .sort((left, right) => (
      missionTouchedAt(right).localeCompare(missionTouchedAt(left))
      || String(left.id).localeCompare(String(right.id))
    ));
}

function collectOpenDecisions(root = process.cwd()) {
  const decisions = [];
  for (const mission of liveMissions(root)) {
    const normalized = normalizeHumanAsks(mission.human_asks);
    normalized.forEach((ask, askIndex) => {
      if (!ask.text.trim() || ask.answered_at) return;
      decisions.push({
        number: decisions.length + 1,
        owner: String(mission.owner || 'unowned'),
        mission_id: mission.id,
        mission_short_id: shortId(mission.id),
        mission_status: mission.status,
        mission_updated_at: missionTouchedAt(mission),
        ask_index: askIndex,
        text: ask.text,
      });
    });
  }
  return decisions;
}

function printHelp() {
  console.log('Usage:');
  console.log('  atris decide');
  console.log('  atris decide <n> y|n|yes|no [--note "<text>"]');
  console.log('  atris decide --json');
  console.log('  atris decide <n> y --json');
}

function fail(message, asJson, code = 2) {
  if (asJson) {
    console.log(JSON.stringify({ ok: false, action: 'decide_error', error: message }));
  } else {
    console.error(message);
  }
  process.exitCode = code;
}

function parseArgs(args) {
  const asJson = args.includes('--json');
  const rest = args.filter((arg) => arg !== '--json');
  let note = '';
  const noteIndex = rest.findIndex((arg) => arg === '--note' || String(arg).startsWith('--note='));
  if (noteIndex !== -1) {
    const noteArg = String(rest[noteIndex]);
    if (noteArg === '--note') {
      if (rest[noteIndex + 1] == null) return { asJson, error: '--note requires text' };
      note = String(rest[noteIndex + 1]).trim();
      rest.splice(noteIndex, 2);
    } else {
      note = noteArg.slice('--note='.length).trim();
      rest.splice(noteIndex, 1);
    }
  }
  return { asJson, note, rest };
}

function decideCommand(args = []) {
  redirectToWorkspaceRoot();
  const parsed = parseArgs(args);
  if (parsed.error) return fail(parsed.error, parsed.asJson);
  const { asJson, note, rest } = parsed;
  if (rest.includes('--help') || rest.includes('-h') || rest[0] === 'help') {
    printHelp();
    return;
  }

  const decisions = collectOpenDecisions();
  if (!rest.length) {
    if (asJson) {
      console.log(JSON.stringify({
        ok: true,
        action: 'decide_list',
        count: decisions.length,
        decisions,
      }, null, 2));
    } else if (!decisions.length) {
      console.log('nothing is waiting for a decision.');
    } else {
      for (const decision of decisions) {
        console.log(`[${decision.number}] ${decision.owner} · ${decision.mission_short_id} · ${decision.text}`);
      }
      console.log('atris decide <n> y|n');
    }
    return;
  }

  if (rest.length !== 2) {
    return fail('usage: atris decide <n> y|n|yes|no [--note "<text>"]', asJson);
  }
  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) {
    return fail('decision number must be a positive integer', asJson);
  }
  const answerToken = String(rest[1]).toLowerCase();
  const answer = answerToken === 'y' || answerToken === 'yes'
    ? 'yes'
    : (answerToken === 'n' || answerToken === 'no' ? 'no' : null);
  if (!answer) return fail('answer must be y, n, yes, or no', asJson);
  const decision = decisions[number - 1];
  if (!decision) return fail(`decision ${number} is not open`, asJson, 1);

  const message = `Decision on "${decision.text}": ${answer.toUpperCase()}${note ? `, ${note}` : ''}`;
  pingMission([decision.mission_id, message, '--from', 'decide'], { silent: true });
  const mission = answerMissionHumanAsk(decision.mission_id, decision.ask_index, answer, note);
  const remainingOpenAsks = openHumanAsks(mission.human_asks).length;
  const payload = {
    ok: true,
    action: 'decision_answered',
    decision: {
      ...decision,
      answer,
      note,
      message,
    },
    mission: {
      id: mission.id,
      short_id: decision.mission_short_id,
      owner: mission.owner,
      status: mission.status,
      remaining_open_asks: remainingOpenAsks,
    },
  };
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`sent to ${decision.mission_short_id}: ${message}`);
    console.log(`mission ${decision.mission_short_id} will read it on its next tick.`);
  }
}

module.exports = {
  decideCommand,
};
