**Where the time goes now (2026-10-28):**
- Captions land in about 1.3s. Since Haiku now starts during the caption download (Step 10), the live full bench took 7.4s on the short captioned video and 8.5s on the long one, and the speed check measured 7.3s against 8.4s on the shared base.
- The agy sign-in check takes up to 11s to exit, but its model list shows up at 1.5 to 1.8s and the early Gemini starts on that line, so the slow exit costs nothing.
- Ruled out: agy `--disable-slash-commands` (same 7.8s median over 7 pairs), a shorter transcript (trimming risks the verbatim quote check), and remembering a passed sign-in check between runs (the bench gives every run a fresh `TMPDIR`).
- The lever left is shorter notes (fewer beats or quotes), which changes the product and waits on the owner.

# YouTube Notes: Build Plan

> **For Executor Agent.** This describes the feature as it stands on 2026-10-28. Use it to find the code before changing it.

---

## Overview

`atris youtube notes <url>` turns a YouTube link into checked notes for free. `atris youtube process <url>` is the paid lane that stores the result in the cloud.

---

## Files Touched

**Notes rail (free):**

- `commands/youtube.js`: the `atris youtube` command. It routes `notes` to the bash script and tries up to 4 caption tracks in order (`captionTrackCandidates`, `loadCaptionRaw`).
- `scripts/det/ytnotes`: the bash script that does the work. Captions, local transcription, writer choice, and the final quote check all live here.
- `scripts/det/ytquote-repair.js`: checks every quote in the notes against the transcript and prints `quotes: N kept, N repaired, N dropped`.
- `scripts/det/ytrail-eval.js`: scores one notes run and appends it to the workspace's `atris/benchmarks/ytrail.jsonl`. The bench and the engine race both use it.
- `scripts/det/ytrail-bench.js`: the speed bench (`atris youtube bench`). `--quick --score` is the number the youtube-lead speed check compares.
- `scripts/det/ytrail-race.js`: runs the same notes pass once per writer and ranks the ones that pass by seconds.

**Paid rail:**

- `commands/youtube.js`: `atris youtube process` calls `POST /agent/process_youtube` on the backend. It checks for a filled Apply file first.
- Backend: `/agent/process_youtube` charges 5 credits, refunds on failure, and writes with Gemini through OpenRouter.

**Tests:**

- `test/ytnotes.test.js`: the bash script, including missing yt-dlp, missing writer, local transcription, and download retries.
- `test/ytquote-repair.test.js`: kept, repaired, and dropped quotes, in both quote layouts.
- `test/youtube.test.js`: the `atris youtube` command, including caption track fallback and the paid lane.

**Upkeep (Keshav's Mac only, not in this repo):**

- Planned Mac job `ai.atris.youtube-tools-update`, every Sunday at 05:00, logging to `~/.atris/logs/youtube-tools-update/`. Not installed: on 2026-10-21 launchd had no such job and there was no plist or log folder. Upgrade by hand with `brew upgrade yt-dlp` until it is.

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

### Step 6: The writer starts while the captions download (2026-10-13)

**File:** `scripts/det/ytnotes` (`resolve_roster_writers`, `agy_signed_in`, `start_warm_gemini`, `warm_gemini`, `run_haiku`)

**What it does:**
- `auto` puts the team's notes writer first, from `atris engine resolve notes --json`. Any failure or a lookup slower than 2s falls back to the built-in order. `ATRIS_YTNOTES_ROSTER=0` skips it.
- The Gemini sign-in check (`agy models`, about 2s) runs in the background while yt-dlp fetches captions. Only a "Please sign in" answer counts as signed out, and the writer reuses that answer instead of checking twice.
- When Gemini leads and the check says signed in, Gemini starts with streamed input during the caption download and gets the prompt once the transcript is ready. It never starts before the check answers, so a signed-out Mac cannot get a Google login window.
- Haiku runs with no tools, no MCP servers, no hooks, closed input, and no nonessential traffic, which cuts Claude Code's startup.
- Quick bench median after these changes: 10.4s over five runs, all cases passing. Rechecked on 2026-10-14: 9.9s over five runs, then 9.2s and 9.4s single runs, all cases passing. The caption download (about 3.4s) and the sign-in check now set the floor.

**Validation:**
- `node --test test/ytnotes.test.js`
- `node scripts/det/ytrail-bench.js --quick --score`

---

### Step 7: A used-up Gemini no longer holds Haiku back (2026-10-15 to 2026-10-16)

**File:** `scripts/det/ytnotes` (`gemini_quota_wall`, `race_writers`, `start_writer`)

**What it does:**
- A quota error from Gemini is saved to `$TMPDIR/ytnotes/gemini_quota_until` until its reset, at most 3 hours. While it holds, `auto` skips Gemini and its early start, and never sends Gemini a second request in the same run.
- When Gemini leads and has no saved quota error, it and the first backup writer (Haiku on this Mac) start together. The 1s head start was dropped on 2026-10-25: Gemini takes about 5s from the prompt, so it only delayed Haiku (8 paired runs, median 7.80s against 8.47s). The first good answer wins, and Gemini wins a tie. The head start is a real background timer; counting 0.05s polls had stretched it to about 2s.
- `ATRIS_YTNOTES_HEDGE_SECS=off` waits for Gemini first, as before. While Gemini works, Haiku also runs on every notes request.
- Five paired runs against the code before the head start: median 10.4s against 13.0s, all passing, 0 quotes dropped.

**Validation:**
- `node --test test/ytnotes.test.js` (the slow-Gemini and quota tests)

---

### Step 8: The caption fetch stops once the original English track lands (2026-10-21)

**File:** `scripts/det/ytnotes` (the caption fetch loop after the `yt-dlp` call that asks for `en-orig,en,en-US,en-GB`)

**What it does:**
- yt-dlp runs in the background while a 0.05s loop watches for `yt_<id>.en-orig.vtt`. Once that file has content and its `.part` file is gone, the track is whole, so the loop ends yt-dlp and removes any leftover `.part` files.
- Before this, yt-dlp went on to ask for the auto `en` copy, which took about 0.5s, usually ended in a 429, and was never read.
- Five alternating pairs of the caption step: median 2.63s before, 2.50s after, and the new code faster in 5 of 5. The transcript came out byte-identical.

**Validation:**
- `node --test --test-name-pattern 'stops the caption fetch' test/ytnotes.test.js` checks that yt-dlp never reaches the `en` copy and no `.part` file is left. It fails with the watcher turned off.
- `node scripts/det/ytrail-bench.js --quick --score` on the captioned video is the live check.

---

### Step 9: Faster captions and an earlier Gemini (2026-10-25 to 2026-10-27)

**File:** `scripts/det/ytnotes` (`fetch_captions`, `captions_landed`, `start_warm_gemini`, `run_auto`)

**What it does:**
- The writer list looked up at the start of a run is saved in `$AGY_WARM.writers`, so `run_auto` no longer runs that lookup (a node start, about 0.2s) again after the captions land.
- The caption fetch passes `player_skip=js`. Solving the player script in deno took about 1.1s and only unlocks video streams the notes never download. Captions came out byte-identical on both bench videos.
- Captions come through the iOS client first (`player_client=ios`, `player_skip=js,webpage`), which skips the webpage download. When no English track lands, `captions_landed` fails and the fetch runs again the old way, so a video never reads as captionless by mistake. Caption-only runs, old against new: 2.52/1.92, 2.26/1.93, 2.58/1.63, 2.23/1.72.
- The iOS fetch also skips the initial data request (`player_skip=...,initial_data`), about 0.5s. That request was the only place yt-dlp found the channel name, so a `curl` to YouTube's oEmbed lookup (about 0.2s) runs beside the caption fetch and fills in the `NA`. When the channel is already there, the lookup is stopped unused. Caption-only runs, old against new, warm: 1.81/1.09, 1.72/1.35; captions byte-identical. Score check 12.6s base to 8.2s branch (commit ea3ba0ef9).
- The early Gemini starts on the first model line the sign-in check prints, about 0.7s before the check exits. Only a signed-in agy prints model lines, so a signed-out agy still never starts. Paired runs: 8.7 to 9.2s (4 runs) against a 12.5s median (5 runs).

**Where the time goes now (2026-10-27):**
- Five fresh quick-bench runs: median 11.4s (10.2 to 15.3), all passing. Captions are ready near 4s.
- On a cold run Gemini waits for the sign-in check (2.5 to 4s), then needs 3 to 5s to start (spikes to 17s), then writes in about 3.5s. Overlapping the check with Gemini's startup is the one lever left, and it could open a Google login for a signed-out user, so it waits on the owner.
- Ruled out: agy `--disable-slash-commands` (same 7.8s median over 7 pairs; agy has no MCP servers or plugins to skip), a shorter transcript (already about 22 KB, and trimming risks the verbatim quote check), and remembering a passed sign-in check between runs (the bench gives every run a fresh `TMPDIR`, so it never sees the memory).

**Validation:**
- `node --test --test-name-pattern 'iOS client' test/ytnotes.test.js` runs the two caption fallback tests; removing the fallback line fails the first one.
- `node --test --test-name-pattern 'oEmbed' test/ytnotes.test.js` checks that an `NA` channel is filled from oEmbed and the lookup file is cleaned up.
- `node scripts/det/ytrail-bench.js --quick` five times is the live check for the median.

---

### Step 10: Haiku starts while the captions download (2026-10-28)

**File:** `scripts/det/ytnotes` (`start_warm_haiku`, `warm_haiku`, `stop_warm_haiku`, `run_haiku`)

**What it does:**
- In `auto` and `haiku` mode, when `claude` is installed, Haiku starts with streamed input at the top of the run, so its startup of about 2s overlaps the caption download. Nothing is sent, so nothing is spent, unless a writer asks for Haiku.
- `run_haiku` hands the prompt to that early Haiku once the transcript is ready, if it runs the same model and effort and no writer took it yet. Any miss (not started, another model, an error, or an empty answer) falls back to the normal start.
- The early Haiku is stopped when the run ends, on success or failure.
- Three paired runs on the short bench video: 2.7 to 3.9s from the prompt, against 5.3 to 8.7s started cold. Score check 15.8s to 7.8s (commit c4ff16928). This had been ruled out on 2026-10-27 from a smaller timing; the paired runs showed the real cost was the 2s start.

**Validation:**
- `node --test --test-name-pattern 'Haiku started early' test/ytnotes.test.js` fails if Haiku quietly takes the normal start instead.
- `ATRIS_YTNOTES_ENGINE=haiku atris youtube notes <url>` live: 7.27s on the short bench video on 2026-10-28, against 16s on 2026-10-14.

---

## Testing Strategy

### Unit Tests

- `node --test test/ytnotes.test.js test/ytquote-repair.test.js test/youtube.test.js` runs all three files. On 2026-09-28 that was 111 passing tests.

### Integration Tests

- `atris youtube bench --quick` runs three real cases, and `atris youtube bench` runs all five. Both shipped in #1072; the full bench passed 5 of 5 live on 2026-10-21.

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

**Error:** YouTube answers the caption fetch with its "confirm you're not a bot" sign-in wall (seen live on 2026-10-14 for both bench videos).

**Handling:** Say YouTube is blocking caption downloads from this connection, skip the audio download (it would hit the same wall), print the paid command, and exit 2. It used to say the video had no captions. A bare 429 is not a block, since the machine-translated "en" track returns 429 on its own, so it still reads as no captions.

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
- `atris-fast` breaks on long videos. It splits the transcript into 11 KB chunks and sends them in one `atris engine ask` run, which takes at most 8 jobs and 64 KB of prompts, so a transcript over about 55 KB is refused (the 85-minute bench video is 101 KB, 10 chunks). Since 2026-10-21 it says so and writes no notes, instead of a stack trace. Do not make it the default until it sends more than one run.
