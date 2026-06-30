#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = process.cwd();
const requiredFiles = [
  'lib/mission-room.js',
  'commands/mission.js',
  'test/mission-status.test.js',
];

function fail(message) {
  console.error(`MISSION ROOM VERIFY FAILED: ${message}`);
  process.exit(1);
}

for (const file of requiredFiles) {
  if (!fs.existsSync(path.join(root, file))) fail(`missing ${file}`);
}

const missionCommand = fs.readFileSync(path.join(root, 'commands/mission.js'), 'utf8');
if (!missionCommand.includes("case 'room':")) fail('mission command does not route room subcommand');
if (!missionCommand.includes('atris mission room "<messy input>"')) fail('mission help does not include room subcommand');

const missionRoomLib = fs.readFileSync(path.join(root, 'lib/mission-room.js'), 'utf8');
for (const phrase of [
  'atris.mission_room.v1',
  'atris.mission_room_receipt.v1',
  'Chaos -> Mission Room',
  'thinking.md',
  'thinking_memory',
  'writeThinkingMemory',
  'task_plan_preview',
  'member_route',
  'member_context',
  'memory_context',
  'proactive_next_mission',
  'result',
  'landing',
  'clarifying_questions',
  'approval_packet',
  'goal_chain',
  'awaiting_operator_approval',
  'approve',
  'revise',
  'stop',
  'share_line',
  'first_proof_step',
]) {
  if (!missionRoomLib.includes(phrase)) fail(`missing mission-room phrase: ${phrase}`);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'atris-mission-room-verify-'));
process.on('exit', () => fs.rmSync(temp, { recursive: true, force: true }));
fs.mkdirSync(path.join(temp, 'atris'), { recursive: true });
const memberDir = path.join(temp, 'atris', 'team', 'mission-lead');
fs.mkdirSync(path.join(memberDir, 'logs'), { recursive: true });
fs.writeFileSync(path.join(memberDir, 'MEMBER.md'), '# Mission Lead\n\nOwns Mission Room loops.\n', 'utf8');
fs.writeFileSync(path.join(memberDir, 'MISSION.md'), '# Mission\n\nTurn messy intent into proof-backed missions.\n', 'utf8');
fs.writeFileSync(path.join(memberDir, 'now.md'), '# Now\n\nMission Room context slice.\n', 'utf8');
fs.writeFileSync(path.join(memberDir, 'logs', '2026-06-30.md'), '# Mission Lead Log\n\n- last proof: thinking.md memory\n', 'utf8');
fs.mkdirSync(path.join(temp, 'atris', 'logs', '2026'), { recursive: true });
fs.writeFileSync(path.join(temp, 'atris', 'logs', '2026', '2026-06-30.md'), '# Daily Log\n\n- next: proactive mission room\n', 'utf8');

const sample = 'we only have 30 days of runway and need Atris Mission to become the product led growth wedge';
const result = spawnSync(process.execPath, [
  path.join(root, 'bin', 'atris.js'),
  'mission',
  'room',
  sample,
  '--owner',
  'mission-lead',
  '--json',
], {
  cwd: temp,
  encoding: 'utf8',
  env: {
    ...process.env,
    ATRIS_SKIP_UPDATE_CHECK: '1',
  },
});

if (result.status !== 0) fail(result.stderr || result.stdout || 'mission room command failed');

let payload;
try {
  payload = JSON.parse(result.stdout);
} catch (error) {
  fail(`mission room did not print JSON: ${error.message}`);
}

if (payload.action !== 'mission_room_created') fail('unexpected mission room action');
if (!/Mission Room$/.test(payload.room?.name || '')) fail('missing mission room name');
if (!/proof-backed mission/.test(payload.room?.target_outcome || '')) fail('missing target outcome');
if (!/smallest artifact or change/.test(payload.room?.first_proof_step || '')) fail('missing first proof step');
if (!Array.isArray(payload.room?.clarifying_questions)) fail('missing clarifying questions');
if (payload.room.clarifying_questions.length < 2 || payload.room.clarifying_questions.length > 3) {
  fail(`expected 2-3 clarifying questions, found ${payload.room.clarifying_questions.length}`);
}
for (const question of payload.room.clarifying_questions) {
  if (!question.id || !question.question || !question.why) fail('clarifying question missing id/question/why');
}
if (payload.room?.approval_packet?.status !== 'awaiting_operator_approval') fail('approval packet must wait for operator approval');
if (!/Approve .* Mission Room/.test(payload.room?.approval_packet?.approve_question || '')) fail('approval packet missing approve question');
if (!payload.room?.approval_packet?.decision_options?.includes('approve')) fail('approval packet missing approve option');
if (!payload.room?.approval_packet?.decision_options?.includes('revise')) fail('approval packet missing revise option');
if (!payload.room?.approval_packet?.decision_options?.includes('stop')) fail('approval packet missing stop option');
if (!/judgment, priority, and final accept/.test(payload.room?.approval_packet?.operator_role || '')) fail('approval packet does not elevate operator role');
if (payload.room?.goal_chain?.mode !== 'approval_gated') fail('goal chain must be approval gated');
if (!/clarify -> approve packet -> set one goal/.test(payload.room?.goal_chain?.loop || '')) fail('goal chain loop is unclear');
if (!/After approval: atris mission start/.test(payload.room?.next_command || '')) fail('next command must wait for approval');
if (payload.room?.task_plan_preview?.schema !== 'atris.mission_room_task_plan_preview.v1') fail('missing task plan preview schema');
if (payload.room?.task_plan_preview?.order !== 'task_first') fail('task plan preview must be task first');
if (payload.room?.task_plan_preview?.mission !== payload.room?.name) fail('task plan preview mission mismatch');
if (!/Prove .* Mission Room/.test(payload.room?.task_plan_preview?.first_goal || '')) fail('task plan preview missing first goal');
if (!/one proof receipt/.test(payload.room?.task_plan_preview?.stop_rule || '')) fail('task plan preview missing stop rule');
if (payload.room?.task_plan_preview?.member_route?.suggested_member !== 'mission-lead') fail('task plan preview missing member route');
if (payload.room?.task_plan_preview?.member_route?.editable !== true) fail('task plan member route must be editable');
if (!/First understand the task/.test(payload.room?.task_plan_preview?.preview_then_route || '')) fail('preview must be task before route');
if (payload.room?.member_route?.status !== 'suggested_member') fail('member route missing suggested status');
if (payload.room?.member_route?.suggested_member !== 'mission-lead') fail('member route missing selected member');
if (payload.room?.member_route?.editable !== true) fail('member route must be editable');
if (!/Approve or change the member/.test(payload.room?.member_route?.approval_prompt || '')) fail('member route missing edit approval prompt');
if (!/--owner <member>/.test(payload.room?.member_route?.change_hint || '')) fail('member route missing change hint');
if (payload.room?.result?.schema !== 'atris.mission_room_result.v1') fail('missing result schema');
if (payload.room?.result?.status !== 'pending_goal_run') fail('result should be pending before goal run');
if (payload.room?.result?.landing?.status !== 'pending_goal_run') fail('result.landing should be pending before goal run');
if (!/^Pending:/.test(payload.room?.result?.landing?.changed || '')) fail('result.landing missing changed line');
if (!/^Pending:/.test(payload.room?.result?.landing?.checked || '')) fail('result.landing missing checked line');
if (payload.room?.result?.landing?.proof !== null) fail('result.landing proof should be null before run');
if (!/accept, revise/.test(payload.room?.result?.landing?.decision || '')) fail('result.landing missing decision line');
if (payload.room?.member_context?.status !== 'member_selected') fail('member context did not select mission-lead');
if (payload.room?.context?.selected_member !== 'mission-lead') fail('context missing selected member');
if (!payload.room?.context?.available_members?.includes('mission-lead')) fail('context missing available member');
if (!payload.room?.member_context?.files?.some((file) => file.path === 'atris/team/mission-lead/MEMBER.md')) fail('member context missing MEMBER.md');
if (!payload.room?.member_context?.files?.some((file) => file.path === 'atris/team/mission-lead/logs/2026-06-30.md')) fail('member context missing latest member log');
if (payload.room?.memory_context?.thinking?.path !== 'atris/thinking.md') fail('memory context missing thinking.md');
if (payload.room?.memory_context?.thinking?.exists !== true) fail('memory context should know thinking.md exists after write');
if (payload.room?.memory_context?.workspace_log?.path !== 'atris/logs/2026/2026-06-30.md') fail('memory context missing workspace log');
if (payload.room?.proactive_next_mission?.status !== 'suggested_after_operator_approval') fail('missing proactive next mission');
if (!/first proof receipt/.test(payload.room?.proactive_next_mission?.objective || '')) fail('proactive next mission objective is weak');
if (payload.room?.proactive_next_mission?.selected_member !== 'mission-lead') fail('proactive next mission missing member');
for (const requiredPath of [
  'atris/thinking.md',
  'atris/team/mission-lead/MEMBER.md',
  'atris/logs/2026/2026-06-30.md',
]) {
  if (!payload.room?.proactive_next_mission?.context_paths?.includes(requiredPath)) fail(`proactive next mission missing context path: ${requiredPath}`);
}
if (payload.room?.thinking_memory?.path !== 'atris/thinking.md') fail('room missing thinking.md path');
if (!/how Keshav thinks/.test(payload.room?.thinking_memory?.purpose || '')) fail('thinking memory purpose is unclear');
if (!/chaos to proof/.test(payload.room?.share_line || '')) fail('missing share line');
if (!/^atris\/runs\/mission-room-/.test(payload.receipt_path || '')) fail('missing receipt path');

const thinkingPath = path.join(temp, 'atris/thinking.md');
if (!fs.existsSync(thinkingPath)) fail('thinking.md was not written');
const thinkingBody = fs.readFileSync(thinkingPath, 'utf8');
for (const phrase of [
  '# thinking.md',
  'Team logs say what happened.',
  'This file says how Keshav thinks.',
  'Approval Rules',
  'Proof Standards',
  'Mission Room Signals',
  payload.room.name,
]) {
  if (!thinkingBody.includes(phrase)) fail(`thinking.md missing phrase: ${phrase}`);
}

const receiptPath = path.join(temp, payload.receipt_path);
if (!fs.existsSync(receiptPath)) fail('receipt file was not written');

const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
if (receipt.schema !== 'atris.mission_room_receipt.v1') fail('bad receipt schema');
if (receipt.product_wedge !== 'Chaos -> Mission Room') fail('bad product wedge');
if (receipt.room?.name !== payload.room.name) fail('receipt room does not match payload');
if (receipt.room?.approval_packet?.status !== 'awaiting_operator_approval') fail('receipt missing approval packet');
if (receipt.room?.task_plan_preview?.order !== 'task_first') fail('receipt missing task-first preview');
if (receipt.room?.member_route?.editable !== true) fail('receipt missing editable member route');
if (receipt.room?.result?.landing?.status !== 'pending_goal_run') fail('receipt missing pending result landing');
if (receipt.room?.member_context?.status !== 'member_selected') fail('receipt missing member context');
if (receipt.room?.proactive_next_mission?.selected_member !== 'mission-lead') fail('receipt missing proactive next mission');
if (receipt.thinking_memory?.path !== 'atris/thinking.md') fail('receipt missing thinking memory path');

console.log('MISSION ROOM VERIFIED');
console.log(`receipt=${payload.receipt_path}`);
console.log(`name=${payload.room.name}`);
console.log(`clarifiers=${payload.room.clarifying_questions.length}`);
console.log(`thinking=${payload.room.thinking_memory.path}`);
console.log(`member=${payload.room.context.selected_member}`);
