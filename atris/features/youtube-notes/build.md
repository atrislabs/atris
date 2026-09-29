# YouTube Notes: Build Plan

> **For Executor Agent.** This describes the feature as it stands on 2026-09-28. Use it to find the code before changing it.

---

## Overview

`atris youtube notes <url>` turns a YouTube link into checked notes for free. `atris youtube process <url>` is the paid lane that stores the result in the cloud.

---

## Files Touched

**Notes rail (free):**

- `commands/youtube.js`: the `atris youtube` command. It routes `notes` to the bash script and tries up to 4 caption tracks in order (`captionTrackCandidates`, `loadCaptionRaw`).
- `scripts/det/ytnotes`: the bash script that does the work. Captions, local transcription, writer choice, and the final quote check all live here.
- `scripts/det/ytquote-repair.js`: checks every quote in the notes against the transcript and prints `quotes: N kept, N repaired, N dropped`.
- `scripts/det/ytrail-eval.js`: older scored self-test. It appends to the workspace's `atris/benchmarks/ytrail.jsonl`.

**Paid rail:**

- `commands/youtube.js`: `atris youtube process` calls `POST /agent/process_youtube` on the backend. It checks for a filled Apply file first.
- Backend: `/agent/process_youtube` charges 5 credits, refunds on failure, and writes with Gemini through OpenRouter.

**Tests:**

- `test/ytnotes.test.js`: the bash script, including missing yt-dlp, missing writer, local transcription, and download retries.
- `test/ytquote-repair.test.js`: kept, repaired, and dropped quotes, in both quote layouts.
- `test/youtube.test.js`: the `atris youtube` command, including caption track fallback and the paid lane.

**Upkeep (Keshav's Mac only, not in this repo):**

- Scheduled Mac job `ai.atris.youtube-tools-update`, every Sunday at 05:00. Logs in `~/.atris/logs/youtube-tools-update/`.

---

## Build Steps

These steps name what shipped, in the order it landed on 2026-09-28. Each one is a change you can read by its PR number.

### Step 1: Fetch the real English captions (#1063)

**Files:** `scripts/det/ytnotes`, `commands/youtube.js`

**What it does:**
- yt-dlp asks for `en-orig,en,en-US,en-GB` with `--ignore-errors`, so a refused `en` track (HTTP 429, too many requests) no longer stops the fetch.
- `commands/youtube.js` tries up to 4 caption tracks in order.

**Validation:**
- `node --test test/youtube.test.js`

---

### Step 2: Transcribe on this computer when there are no captions (#1064, #1065)

**File:** `scripts/det/ytnotes` (`transcribe_locally`)

**What it does:**
- If `mlx_whisper` is installed, it downloads the audio and transcribes it with `mlx-community/whisper-large-v3-turbo`, free.
- The audio download tries 3 times, because YouTube refuses some at random (HTTP 403).
- `ATRIS_YTNOTES_LOCAL_TRANSCRIBE=0` turns this off. Without `mlx_whisper`, it prints the paid command instead.

**Validation:**
- `node --test test/ytnotes.test.js`

---

### Step 3: Fastest writer first (#1066, #1069)

**File:** `scripts/det/ytnotes` (`AUTO_WRITERS`)

**What it does:**
- `auto` tries Gemini Flash (`agy`), then Haiku (`claude`), then `codex`, then `cursor-agent`, and uses the first that answers.
- The second argument or `ATRIS_YTNOTES_ENGINE` pins one writer.

**Validation:**
- `node --test test/ytnotes.test.js`

---

### Step 4: Check quotes in both layouts (#1067)

**File:** `scripts/det/ytquote-repair.js`

**What it does:**
- Reads both `> "quote" [mm:ss]` and `> [mm:ss] "quote"`. The second layout was skipped without a word before this fix.

**Validation:**
- `node --test test/ytquote-repair.test.js`

---

### Step 5: Clear answers on a fresh computer (#1069)

**File:** `scripts/det/ytnotes`

**What it does:**
- Missing yt-dlp: says so and prints the install command. It used to say the video had no captions.
- Missing AI writer: exits with code 3, names the writers to install, and keeps the transcript. It used to exit 0 with blank notes.

**Validation:**
- `node --test test/ytnotes.test.js`

---

## Testing Strategy

### Unit Tests

- `node --test test/ytnotes.test.js test/ytquote-repair.test.js test/youtube.test.js` runs all three files. On 2026-09-28 that was 111 passing tests.

### Integration Tests

- `atris youtube bench --quick` runs three real cases, and `atris youtube bench` runs all five. This command is in review, not shipped yet.

### Manual Testing

One. Run `atris youtube notes 'https://www.youtube.com/watch?v=Am7IWP8IpEc'`. Keep the quotes, because zsh treats the `?` in the link as a wildcard.

Two. Expect notes on screen, exit code 0, and a last line of `quotes: N kept, N repaired, N dropped` with kept above 0.

---

## Error Cases

**Error:** yt-dlp is not installed.

**Handling:** Print that yt-dlp is missing and the install command (`brew install yt-dlp` on a Mac, `pipx install yt-dlp` anywhere).

**Error:** No AI writer is installed, or none answers.

**Handling:** Exit 3, name the writers to install, and keep the transcript at `$TMPDIR/ytnotes/yt_<id>.clean.txt`.

**Error:** The video has no captions and this is not an Apple silicon Mac with `mlx_whisper`.

**Handling:** Print the paid command, `atris youtube process <url>`.

**Error:** The writer invents a quote.

**Handling:** `ytquote-repair.js` drops it and counts it in the tally line.

---

## Dependencies

- yt-dlp on the PATH for captions and audio.
- At least one AI writer CLI: `agy`, `claude`, `codex`, or `cursor-agent`.
- Optional: `mlx_whisper` on an Apple silicon Mac for videos with no captions.
- The paid lane needs an Atris login with credits and a filled Apply file.

---

## Rollback Plan

One. Revert the PR that broke things, for example `git revert <commit>` for #1066 to go back to Haiku as the default writer.

Two. Rerun `node --test test/ytnotes.test.js test/ytquote-repair.test.js test/youtube.test.js` and one live `atris youtube notes` run.

---

## Notes for Executor

- Read the tally line, not just the notes. If it says `0 kept, 0 repaired, 0 dropped` on a long video, the quote checker probably did not recognize the layout.
- Test as a stranger too: a shell with only `node` on the PATH shows failures a fully loaded Mac hides.
- `atris-fast` breaks on long videos because of its 8-job cap. Do not make it the default until that is fixed.
