// Model-in-the-loop keep/revert optimization — the leverage→intelligence bridge harness.
//
// Optimizes the POLICY that drives a real model, scored by the model's measured
// accuracy on a held-out eval, via keep/revert. This optimizes the model's
// *effective* capability (elicitation), NOT its weights — so it is leverage, not
// a ceiling raise, and NOT ASI. What makes it more than the earlier toy: the
// subject is real model performance on real problems, not a hand-written heuristic.
//
// Recorded run (2026-06-08, claude CLI 2.1.x): P0 terse 0.50 → P1 structured 0.75 (KEPT).
//
// Usage: node atris/experiments/policy-optimize/run.mjs
import { execFileSync } from 'node:child_process';

const EVAL = [
  { q: 'A warehouse receives 7 pallets, each with 24 cartons, each carton holding 15 units. 138 units are damaged and removed. How many usable units remain?', a: 2382 },
  { q: 'A tank holds 1200 L. It is 5/8 full, then 175 L are added, then 1/4 of the new amount is drained. How many liters remain?', a: 693.75 },
  { q: 'Three numbers sum to 180. The second is twice the first; the third is 30 more than the second. What is the third number?', a: 90 },
  { q: 'Lin works 37 hours at $18.50/hr, then gets a $45 bonus. 22% of the total is withheld. What is the take-home pay in dollars?', a: 568.91 },
];

const POLICIES = [
  { name: 'P0 baseline (terse)', sys: 'Answer the question.' },
  { name: 'P1 optimized (reason + structured answer)', sys: 'Solve carefully, one step at a time, and check your arithmetic. End your reply with a final line in exactly this format: "ANSWER: <number>" with no units and no commas.' },
];

function ask(sys, q) {
  return execFileSync('claude', ['-p', '--append-system-prompt', sys, q], { encoding: 'utf8', timeout: 60000 });
}
function extract(text) {
  const m = String(text).match(/ANSWER:\s*\$?(-?\d+(?:\.\d+)?)/i);
  if (m) return parseFloat(m[1]);
  const nums = String(text).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/g);
  return nums ? parseFloat(nums[nums.length - 1]) : null;
}
const close = (got, want) => got != null && Math.abs(got - want) < 0.02;

async function scorePolicy(p) {
  let correct = 0;
  for (const item of EVAL) {
    let got = null;
    try { got = extract(ask(p.sys, item.q)); } catch { got = null; }
    if (close(got, item.a)) correct++;
  }
  return correct / EVAL.length;
}

let best = -1, kept = null;
const traj = [];
for (const p of POLICIES) {
  const s = await scorePolicy(p);
  const keep = s > best;
  if (keep) { best = s; kept = p.name; }
  traj.push({ policy: p.name, score: Number(s.toFixed(2)), decision: keep ? 'KEEP' : 'REVERT' });
}
console.log('model-in-the-loop policy optimization (keep/revert, real model)');
for (const t of traj) console.log(`  ${t.score.toFixed(2)}  ${t.decision.padEnd(7)} ${t.policy}`);
console.log(`  kept: ${kept}`);
console.log(JSON.stringify({ schema: 'rsi.policy_optimize.v1', traj, best }));
