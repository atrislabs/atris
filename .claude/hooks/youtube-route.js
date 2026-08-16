#!/usr/bin/env node
// UserPromptSubmit hook: any youtube link in the prompt forces the graded notes rail.
// Silent (no output) when the prompt has no youtube link.
let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let prompt = '';
  try { prompt = String(JSON.parse(raw).prompt || ''); } catch { process.exit(0); }
  const links = [...prompt.matchAll(/https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?[^\s)>\]]*v=[\w-]{6,}[^\s)>\]]*|youtu\.be\/[\w-]{6,}[^\s)>\]]*)/g)]
    .map((m) => m[0]);
  if (!links.length) process.exit(0);
  const cmds = links.map((u) => `atris youtube notes "${u}"`).join(' ; ');
  console.log(
    `youtube gate: this message contains a youtube link. Before saying anything about the video, run exactly: ${cmds} ` +
    `and base every claim on its output (notes land in $TMPDIR/ytnotes/). ` +
    `Summarizing a video from model memory or cached notes without running the command is fabrication and forbidden. ` +
    `If the command fails, report the failure honestly instead of improvising.`
  );
  process.exit(0);
});
