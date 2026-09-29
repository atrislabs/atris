# youtube-lead roadmap

Goal: the fastest honest video-to-knowledge loop anywhere, and it compounds. Each stage ships only with a live graded run as proof.

## shipped

- One command, any repo: `atris youtube notes <url>`, zero credits. It took about 30 to 90 seconds in August; an 85-minute captioned video now takes 11 to 19 seconds.
- Honesty enforced by machine: quotes checked against the transcript, paraphrases repaired to the speaker's exact words, inventions dropped.
- Every run graded and logged to `atris/benchmarks/ytrail.jsonl`.
- Routing at 3/3 in clean cheap-model chats: a prompt gate forces the rail on any youtube link.
- Engine choice from measured data. Haiku was the default from August until 2026-09-28, when Gemini Flash replaced it.
- Briefs file themselves (3.49.0), proven live.
- Watch feeder (3.50.0). Mission 79 ran the daily tick until it expired on 2026-09-01.
- Engine race: the first race crowned haiku (73.6s, 6/6 quotes); grok and fast lanes failed honestly and were flagged.
- Weekly digest (3.51.0): the first digest read 7 real briefs in 36s and cited its sources.
- Batch and playlists (3.52.0): one command takes several links or a playlist, caps at 10, and prints a per-video summary.

### shipped 2026-09-28 (release 3.62.0, plus #1069 after it)

- Real English captions (#1063). yt-dlp asks for `en-orig` first, and `--ignore-errors` keeps going when YouTube refuses its machine-translated `en` track (HTTP 429). `commands/youtube.js` tries up to 4 caption tracks in order.
- Free transcription when a video has no captions (#1064). On an Apple silicon Mac with `mlx_whisper`, it transcribes the audio locally at about 15 times real speed; elsewhere it prints the paid command.
- Audio download retries 3 times (#1065), because YouTube refuses some at random (HTTP 403).
- Gemini Flash writes by default (#1066). `auto` tries Gemini through `agy`, then Haiku, Codex, and Cursor; Gemini writes an 85-minute video's notes in about 8 seconds, Haiku in 30 to 42.
- The quote checker reads both quote layouts (#1067). `> [mm:ss] "quote"` was silently skipped before.
- CI passes again (#1068), which unblocked the 3.62.0 release.
- Clear answers on a fresh computer (#1069). A missing yt-dlp is named with its install command, and a missing writer exits 3 with the transcript kept, never blank notes.
- Paid lane charging confirmed live: 5 credits in `credit_transactions`, refunded on failure.
- Upkeep: the Sunday 05:00 Mac job `ai.atris.youtube-tools-update` upgrades yt-dlp and mlx-whisper.

Measured that day: `Am7IWP8IpEc` (85 min, captioned) 11 to 19 seconds with Gemini, 65 with Haiku only. `6DRlX5vIOE0` (no captions) 59 seconds, and `N10zZ1VBDOk` (10 min, no captions) 150 seconds.

In review: `atris youtube bench`, five real cases with a ledger at `~/.atris/benchmarks/ytrail.jsonl`, plus a warning when yt-dlp is over 60 days old.

## next, in order

One. The bench runs daily and its failures become the next tick's work.

Two. Fix `atris-fast` on long videos, or drop it from the writer list.

Three. Free transcription beyond Apple silicon, for example whisper.cpp on CPU, measured before shipping.

Four. Other people's yt-dlp stays current. The 60-day warning is step one.

Five. No-caption videos for non-Mac users without the Apply-form friction. This needs Keshav's call, because it touches billing.

## rules this roadmap inherits

Measure before improving; two samples minimum before shipping a tuning change. Engines build, the member verifies on real videos. No fabricated quotes survive; the grader, not the prompt, is the honesty gate.
