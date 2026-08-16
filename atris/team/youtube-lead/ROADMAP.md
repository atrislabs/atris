# youtube-lead roadmap

Goal: the fastest honest video-to-knowledge loop anywhere, and it compounds. Each stage ships only with a live graded run as proof.

## shipped

- One command, any repo: `atris youtube notes <url>`, about 30 to 90 seconds, zero credits.
- Honesty enforced by machine: quotes checked against the transcript, paraphrases repaired to the speaker's exact words, inventions dropped.
- Every run graded and logged to `atris/benchmarks/ytrail.jsonl`.
- Routing at 3/3 in clean cheap-model chats: a prompt gate forces the rail on any youtube link.
- Engine choice from measured data: haiku default, bake-off table in the member log.

## next, in order

One. Briefs file themselves: notes land in `atris/wiki/briefs/` with a claimable journal line, so any watched video becomes memory other agents mine. (in flight)

Two. Watch feeder: subscribe to channels, a scheduled tick pulls new uploads through the rail overnight, mornings open with fresh briefs.

Three. Weekly engine re-race: replay the canary set through every engine, read the ledger, flip the default when someone faster and honest shows up.

Four. Weekly synthesis: one digest brief that reads the week's video briefs and answers what changed our plans, with links back.

Five. Batch and playlists: hand the rail a playlist or several links, get one run with per-video grades.

## rules this roadmap inherits

Measure before improving; two samples minimum before shipping a tuning change. Engines build, the member verifies on real videos. No fabricated quotes survive; the grader, not the prompt, is the honesty gate.
