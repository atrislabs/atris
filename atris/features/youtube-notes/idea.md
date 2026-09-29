# YouTube Notes

> **Status:** complete (the `atris youtube bench` scorecard is in review)
> **Created:** 2026-08-15
> **Last Updated:** 2026-09-28

---

## Problem Statement

People send a YouTube link and want the ideas in it, fast, without watching the whole thing. A summary they cannot trust is worse than none, because an invented quote gets repeated as fact.

Before 2026-09-28 the free notes command failed in quiet ways. Captions got blocked by YouTube, videos with no captions just stopped, and a computer missing our tools printed wrong errors or blank notes.

---

## Solution Design

`atris youtube notes <url>` pulls the video's captions, writes notes with the fastest AI writer installed on the computer, then checks every quote against the transcript. It is free and costs zero credits.

When a video has no captions, a Mac with Apple silicon transcribes the audio on the spot, also free. When the computer is missing a tool, the command says which one and how to install it.

---

## ASCII Visualization

```
atris youtube notes <url>
        |
        v
scripts/det/ytnotes (bash)
        |
        |-- captions:     yt-dlp asks for en-orig first (the real English track)
        |                 --ignore-errors keeps going if plain "en" is blocked
        |
        |-- no captions?
        |        Mac + mlx_whisper  -> download audio (3 tries) -> transcribe locally, free
        |        anything else      -> print the paid command
        |
        |-- writer (auto): Gemini Flash (agy) -> Haiku (claude) -> codex -> cursor-agent
        |
        |-- scripts/det/ytquote-repair.js
        |        exact quote   -> kept
        |        paraphrase    -> repaired to the speaker's words
        |        invention     -> dropped
        |        prints "quotes: N kept, N repaired, N dropped"
        v
notes on screen + $TMPDIR/ytnotes/yt_<id>.md
transcript at     $TMPDIR/ytnotes/yt_<id>.clean.txt


Paid lane (stores knowledge in the cloud):
atris youtube process <url> -> POST /agent/process_youtube -> Gemini via OpenRouter
                               5 credits, refunded on failure, needs a filled Apply file
```

---

## Success Criteria

- [x] A captioned 85-minute video (`Am7IWP8IpEc`) goes from link to checked notes in 11 to 19 seconds with Gemini.
- [x] A blocked machine-translated caption track no longer stops the fetch (#1063).
- [x] A video with no captions gets notes on an Apple silicon Mac, free (`6DRlX5vIOE0` took 59 seconds) (#1064, #1065).
- [x] Every quote in the notes is checked, whichever of the two quote layouts the writer uses (#1067).
- [x] A computer without the downloader or without an AI writer gets a clear message, never blank notes (#1069).
- [x] The paid lane charges 5 credits and refunds on failure, confirmed live in the `credit_transactions` table on 2026-09-28.
- [ ] `atris youtube bench` runs five real cases and records each run (in review).

---

## User Impact

Anyone with the Atris CLI gets trustworthy notes on a video in about the time it takes to read a tweet. The quote tally at the end tells them how much the writer got right before they rely on it.

A person on a fresh computer is told what to install, instead of being told the video has no captions or handed an empty file.

---

## Technical Notes

**Captions.** yt-dlp, the free YouTube downloader, asks for `en-orig` first, which is the English track the speaker actually said. Plain `en` is YouTube's machine translation and often gets refused with HTTP 429 (too many requests), which used to stop the whole fetch.

`commands/youtube.js` also tries up to 4 caption tracks in order, so one blocked track falls through to the next.

**Local transcription.** `mlx_whisper` is a free speech-to-text tool that runs only on Apple silicon Macs. It uses the `mlx-community/whisper-large-v3-turbo` model at about 15 times real speed, around 49 seconds per 10 minutes of video on a quiet machine.

YouTube refuses some audio downloads at random (HTTP 403), so the download retries 3 times. `ATRIS_YTNOTES_LOCAL_TRANSCRIBE=0` turns local transcription off.

**Writers.** The default, `auto`, uses the fastest writer installed: Gemini Flash through the `agy` CLI, then Haiku through `claude`, then `codex`, then `cursor-agent`. Gemini writes notes for an 85-minute transcript in about 8 seconds, where Haiku takes 30 to 42.

Pin one writer with the second argument (`atris youtube notes <url> haiku`) or with `ATRIS_YTNOTES_ENGINE`.

**Sibling.** The backend Notes API member lives at `atrisos-backend/atris/team/notes/` and serves `POST /api/notes` for 10 credits.

**Upkeep on Keshav's Mac.** A scheduled Mac job, `ai.atris.youtube-tools-update`, upgrades yt-dlp and mlx-whisper every Sunday at 05:00. Its logs land in `~/.atris/logs/youtube-tools-update/`.

**In review, not shipped.** `atris youtube bench` runs five real cases and appends each run to `~/.atris/benchmarks/ytrail.jsonl`, and `--quick` runs three. A warning when yt-dlp is more than 60 days old is in the same review.

**Known gaps.**

- The `atris-fast` writer breaks on long videos, because it caps at 8 parallel jobs.
- Free transcription only works on Apple silicon Macs with `mlx_whisper` installed.
- Other people's yt-dlp does not update itself, and YouTube changes break old copies.
- For a video with no captions on a non-Mac, the paid lane's Apply form adds friction.
