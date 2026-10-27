'use strict';

function roundSummaries(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.arm, row.rep]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].map((round) => {
    const times = round.flatMap((r) => r.build_seconds || []).sort((a, b) => a - b);
    const middle = Math.floor(times.length / 2);
    return { arm: round[0].arm, rep: round[0].rep,
      build_median_seconds: times.length ? (times.length % 2 ? times[middle] : (times[middle - 1] + times[middle]) / 2) : null,
      build_average_seconds: times.length ? times.reduce((a, b) => a + b, 0) / times.length : null,
      tasks: round.map((r) => ({ task: r.task, code_lines_changed: r.code_lines_changed ?? null })) };
  });
}

function summarize(rows) {
  const byArm = {};
  for (const r of rows) (byArm[r.arm] ||= []).push(r);
  const lines = [];
  for (const [name, list] of Object.entries(byArm)) {
    const infra = list.filter((r) => r.infra_error && !r.passed).length;
    const scored = list.length - infra;
    const pass = list.filter((r) => r.passed).length;
    const counted = list.filter((r) => !(r.infra_error && !r.passed));
    const avg = (key) => {
      const vals = counted.map((r) => r[key]).filter((v) => typeof v === 'number');
      return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
    };
    const opened = {};
    for (const r of counted) for (const p of r.opened || []) opened[p] = (opened[p] || 0) + 1;
    const openedText = Object.entries(opened).sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p} ${n}`).join(', ') || 'none';
    lines.push(`${name}: ${pass}/${scored} passed (${Math.round(100 * pass / Math.max(1, scored))}%)${infra ? `, ${infra} engine failures left out` : ''}, avg ${avg('secs')}s, avg tokens in ${avg('tokens_in')}, first call ${avg('first_call_in')}, tool calls ${avg('tool_calls')}; opened: ${openedText}`);
  }
  for (const round of roundSummaries(rows)) {
    const changes = round.tasks.map((r) => `${r.task} ${r.code_lines_changed ?? 'unknown'}`).join(', ');
    lines.push(`${round.arm} round ${round.rep}: build median ${round.build_median_seconds == null ? 'unavailable' : `${round.build_median_seconds}s`}, average ${round.build_average_seconds == null ? 'unavailable' : `${round.build_average_seconds}s`}; code lines changed: ${changes}`);
  }
  return lines.join('\n');
}


module.exports = { roundSummaries, summarize };
