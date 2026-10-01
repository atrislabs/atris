'use strict';

// How a launch names the member it runs as, in one place. The writers use
// these lines and the team view reads them back with patterns built from the
// same lines, so the wording cannot drift apart.
//
// Mission ticks (atris member run, atris mission) say:
//   You are the member "validator".
//   **Objective:** <what the run is for>
// Dispatch briefs say:
//   You are acting as validator. <the work>

const escapeRegExp = require('./escape-regexp');

const NAME = '([a-z0-9][a-z0-9_-]*[a-z0-9])';
const SLOT = '\u0000';

function memberIdentityLine(name) {
  return `You are the member "${name}".`;
}

function missionObjectiveLine(objective) {
  return `**Objective:** ${objective}`;
}

function patternFrom(line, name) {
  return new RegExp(escapeRegExp(line).replace(escapeRegExp(SLOT), name), 'i');
}

const MISSION_MEMBER = patternFrom(memberIdentityLine(SLOT), NAME);
const DISPATCH_MEMBER = /\bacting as (?:the )?([a-z0-9][a-z0-9_-]*[a-z0-9])[.,:;]?/i;
const OBJECTIVE = patternFrom(missionObjectiveLine(SLOT), '(.+?)(?=\\s\\*\\*[A-Z][^*]*:\\*\\*|\\s#|$)');

// One prompt -> { member, doing }. The member is the name the prompt runs
// as, or null. doing is what the run is for: a mission's objective, or the
// words after the dispatch line.
function readMemberLaunch(prompt) {
  const text = String(prompt || '').replace(/\\0?12|\\n/g, ' ').replace(/\s+/g, ' ').trim();
  const mission = MISSION_MEMBER.exec(text);
  if (mission) {
    const objective = OBJECTIVE.exec(text);
    return { member: mission[1].toLowerCase(), doing: objective ? objective[1].trim() : text };
  }
  const dispatch = DISPATCH_MEMBER.exec(text);
  if (dispatch) {
    const after = text.slice(dispatch.index + dispatch[0].length).trim();
    return { member: dispatch[1].toLowerCase(), doing: after || text };
  }
  return { member: null, doing: text };
}

module.exports = {
  memberIdentityLine,
  missionObjectiveLine,
  readMemberLaunch,
};
