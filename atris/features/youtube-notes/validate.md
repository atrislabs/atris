# Validation: YouTube Notes

> **Role:** System Validation Script
> **Executor:** Validator Agent
> **Rule:** If ANY step fails, the feature is broken.

---

## Human check

Run `atris youtube notes 'https://www.youtube.com/watch?v=Am7IWP8IpEc'` and find the line that starts with `quotes:`. It should say `quotes: N kept, ...` with N above 0, and the run should finish in under about 20 seconds.

---

## 1. Environment Check

- [x] **Tests pass**
  - Command: `node --test test/ytnotes.test.js test/ytquote-repair.test.js test/youtube.test.js`
  - Expect: 0 failures. On 2026-09-28 this was 111 passing; on 2026-10-13, with test/ytrail-bench.test.js in place of test/ytquote-repair.test.js, 142 passing. Rerun on 2026-10-15: exit 0, 131 passing, 0 failing. Rerun on 2026-10-19: exit 0, 137 passing, 0 failing, in 38 seconds.

- [x] **Tools present**
  - Command: `command -v yt-dlp agy claude mlx_whisper`
  - Expect: yt-dlp and at least one writer. `mlx_whisper` is needed only for videos with no captions. Rerun on 2026-10-15: exit 0, all four found (yt-dlp, agy, claude, mlx_whisper). Rerun on 2026-10-19: exit 0, all four found, yt-dlp 2026.08.19.

---

## 2. Simulation Steps (The "Real" Test)

### Step 1: Captioned long video (happy path)

- **Action:** `time atris youtube notes 'https://www.youtube.com/watch?v=Am7IWP8IpEc'`
- **Expect:** Exit code 0, notes on screen, and a saved copy at `$TMPDIR/ytnotes/yt_Am7IWP8IpEc.md`. A line reads `quotes: N kept, N repaired, N dropped` with kept above 0, and the whole run takes under about 20 seconds with Gemini (measured 11 to 19 seconds on 2026-09-28; 9.95s on 2026-10-13, with one 64s outlier in the same session; Haiku alone took 65, then 26.9 on 2026-10-13).
- **Check the writer line.** It reads `notes by Gemini` or `notes by Haiku`: Gemini and Haiku start together and the first real notes win. A lowercase `notes by haiku` means `ATRIS_YTNOTES_ENGINE` is set in the shell and pins a writer. Run with `env -u ATRIS_YTNOTES_ENGINE` to test the default.
- **Rerun live on 2026-10-15:** exit 0 in 46.1 seconds, saved copy present, quotes 5 kept, 0 repaired, 0 dropped, but `notes by Haiku`: Gemini did not answer. A direct `agy -p` returned "Individual quota reached" (code 429, resets in about 110 hours), while the sign-in check still passed. So the 20-second bar fails until the Gemini quota resets; the run itself stays honest.
- **Rerun live on 2026-10-16** from the youtube-lead branch with the head start and quota memory in place: exit 0 in 26.3 seconds at machine load 7, saved copy present, quotes 4 kept, 1 repaired, 0 dropped, `notes by Haiku`. The run printed that Gemini's quota was used up on a recent run and skipped it, so no second Gemini request went out. The 20-second bar still fails on this 85-minute video until Gemini is back.
- **Rerun live on 2026-10-17** with Gemini back: passes. Two runs, exit 0 in 10.83 and 11.66 seconds at machine load about 3, saved copy present both times, `notes by Gemini`, quotes 4 kept, 1 repaired, 0 dropped, then 4 kept, 0 repaired, 0 dropped.
- **Rerun live on 2026-10-21** from the youtube-lead branch with fresh captions: passes. Exit 0 in 12.81 seconds at machine load about 2.4, saved copy present, `notes by Gemini`, quotes 4 kept, 1 repaired, 0 dropped. The run also warned that yt-dlp is 62 days old, and the Sunday update job is not loaded on this Mac and has no log folder, so nothing has upgraded it since August.
- **Rerun live on 2026-10-27** from the youtube-lead branch after the Oct 25-27 speed changes (iOS caption route, skipped player script, earlier Gemini start), each run in a fresh empty `TMPDIR`: passes. Two runs, exit 0 in 15.85 and 9.67 seconds at machine load 6.4 to 7, saved copy present both times, `notes by Gemini`, quotes 4 kept, 0 repaired, 0 dropped, then 5 kept, 0 repaired, 0 dropped.

### Step 2: Video with no captions

- **Action:** `time atris youtube notes 'https://www.youtube.com/watch?v=6DRlX5vIOE0'` on an Apple silicon Mac with `mlx_whisper`
- **Expect:** A line saying it is transcribing on this computer, then notes and a quote tally. Measured at 59 seconds. Rerun live on 2026-10-15: exit 0 in 49 seconds. Gemini did not answer, so the notes said so and switched to Haiku; quotes 5 kept, 0 repaired, 0 dropped. Rerun live on 2026-10-17 with Gemini back: exit 0 in 16.12 seconds at load about 3, the transcribing line printed, `notes by Gemini`, 172 words, quotes 5 kept, 0 repaired, 0 dropped.
- **Rerun live on 2026-10-21** from the youtube-lead branch with no cached transcript: passes. Exit 0 in 20.88 seconds at machine load about 1.8, the transcribing line printed, `notes by Gemini`, quotes 5 kept, 0 repaired, 0 dropped, saved copy present. That is about 5 seconds slower than on Oct 17, and the run warned that yt-dlp is 62 days old.
- **Rerun live on 2026-10-27** from the youtube-lead branch after the Oct 25-27 speed changes, in a fresh empty `TMPDIR`: passes. Exit 0 in 37.78 seconds at machine load about 8.4 (the Oct 21 run was 20.88 seconds at load 1.8), the transcribing line printed, `notes by Gemini`, quotes 6 kept, 0 repaired, 0 dropped, saved copy present. The video is a 1:41 BBC News Swahili clip, so the notes come out in Swahili, matching the speech.

### Step 3: Stranger with no downloader

- **Action:** from the repo root, `env HOME="$(mktemp -d)" TMPDIR="$(mktemp -d)" PATH=/usr/bin:/bin "$(command -v node)" bin/atris.js youtube notes 'https://www.youtube.com/watch?v=Am7IWP8IpEc'; echo "exit=$?"`
- **Expect:** A message that yt-dlp is missing, the install command, and `exit=2`. It must not say the video has no captions.
- **Rerun live on 2026-10-17:** passes. exit 2 in 0.12 seconds, the yt-dlp install line for Mac and any computer, and no line about captions.
- **Rerun live on 2026-10-21** from the youtube-lead branch with a fresh home and temp folder: passes. exit 2 in 0.24 seconds, the yt-dlp install line for Mac and any computer, no line saying the video has no captions, and no transcript or notes left in the temp folder.

The fresh `TMPDIR` matters. A transcript left over from an earlier run of the same video is reused, which hides the missing downloader.

### Step 4: Stranger with no AI writer

- **Action:** `node --test --test-name-pattern 'writer' test/ytnotes.test.js`, which runs the script with yt-dlp present and no writer on the PATH.
- **Expect:** Exit code 3, a list of writers to install, and the transcript kept at `$TMPDIR/ytnotes/yt_<id>.clean.txt`. No blank notes file.
- **Rerun on 2026-10-17:** passes. The test: exit 0, 17 pass, 0 fail. Live, with only node and yt-dlp linked into a fresh folder on the PATH plus `/usr/bin:/bin`, on `Z3JyAqh4ixg`: exit 3 in 2.9 seconds, the line naming all four writers to install, the 4,038-word transcript kept, no notes file.
- **Rerun on 2026-10-21:** passes. The test: exit 0, 17 pass, 0 fail. Live, with only node and yt-dlp linked into a fresh folder on the PATH plus `/usr/bin:/bin`, a fresh home, and a fresh temp folder, on `Z3JyAqh4ixg`: exit 3 in 5.08 seconds, the line naming all four writers to install, the 4,038-word transcript kept, no notes file.
- **Use a fresh home too.** The notes script also looks in `~/.local/bin`, where Claude Code installs, so with your real home the run finds Haiku and writes notes (exit 0 in 7.8 seconds on 2026-10-21). That is correct for you, but it is not the stranger case.
- **Clear the writer pin first** with `env -u ATRIS_YTNOTES_ENGINE`. A shell that sets it to `haiku` skips the writer list and prints only that `claude` is not installed, which looks like a bug but is the pinned path.

### Step 5: The scorecard

- **Action:** `atris youtube bench --quick` (three cases) or `atris youtube bench` (all five)
- **Expect:** One pass or fail per case, and one new line per run in `~/.atris/benchmarks/ytrail.jsonl`. The five cases are captioned-short `Z3JyAqh4ixg` (21 min), captioned-long `Am7IWP8IpEc` (85 min), no-captions `6DRlX5vIOE0`, stranger-no-downloader, and stranger-no-writer.
- **Full bench rerun live on 2026-10-15:** exit 1 in 67 seconds, all five cases ran and five new lines landed in the log. Captioned-short passed in 15s, no-captions in 19.5s, both stranger cases passed (exit 2 and exit 3 with the install messages). Captioned-long failed on time, 28s with Haiku, because Gemini was still out of quota; its 5 quotes were all kept.
- **Full bench rerun live on 2026-10-17** at load about 3.7: passes, exit 0, 5 of 5 in 40 seconds, five new lines in the log. Captioned-short 9.9s and captioned-long 12.1s, both by Haiku; no-captions 14.4s by Gemini; stranger-no-downloader exit 2 and stranger-no-writer exit 3 with the install messages. No quote dropped; the long video had 5 kept and 3 repaired.
- **Full bench rerun live on 2026-10-21** from the youtube-lead branch at load about 2.4: passes, exit 0, 5 of 5 in 37 seconds, five new lines in the log. Captioned-short 10.4s, captioned-long 8.6s, and no-captions 14s, all by Gemini; stranger-no-downloader exit 2 and stranger-no-writer exit 3 with the install messages. 16 quotes kept, none repaired or dropped.
- **Full bench rerun live on 2026-10-27** from the youtube-lead branch after the Oct 25-27 speed changes, at load 8 to 12: passes, exit 0, 5 of 5 in 65 seconds, five new lines in the log. Captioned-short 11.2s by Haiku, captioned-long 11.3s by Gemini, and no-captions 36.6s by Gemini with local transcription; stranger-no-downloader exit 2 and stranger-no-writer exit 3 with the install messages. 11 quotes kept, 4 repaired, none dropped.
- **Full bench rerun live on 2026-10-28** from the youtube-lead branch after the caption fetch stopped asking for the initial data request and began taking the channel from oEmbed, at load about 5: passes, exit 0, 5 of 5 in 64 seconds, five new lines in the log. Captioned-short 15.3s, captioned-long 10.4s, and no-captions 33.3s with local transcription, all by Gemini; stranger-no-downloader exit 2 and stranger-no-writer exit 3 with the install messages. 15 quotes kept, none repaired or dropped.

---

## 3. Regression Check

- [ ] `atris youtube process <url>` still charges 5 credits and refunds on failure. Only run this with a human's go, because it spends credits.
- [x] `ATRIS_YTNOTES_ENGINE=haiku atris youtube notes <url>` still pins Haiku. Rerun live on 2026-10-14 with `Z3JyAqh4ixg`: exit 0 in 16 seconds, "notes by haiku", quotes 5 kept, 0 repaired, 0 dropped. Rerun live on 2026-10-28 from the youtube-lead branch after Haiku began starting during the caption download, at load about 4.5: exit 0 in 7.27 seconds, "notes by haiku", quotes 5 kept, 1 repaired, 0 dropped.
- [x] `ATRIS_YTNOTES_LOCAL_TRANSCRIBE=0` on a no-caption video prints the paid command instead of transcribing. Rerun live on 2026-10-14 with `6DRlX5vIOE0`: exit 2 in 3 seconds, "No English captions found" plus the 5-credit paid command, no notes or transcript left behind.
- [x] A sign-in wall on the caption fetch says YouTube is blocking caption downloads, not that the video has no captions, and a bare 429 still says no captions. Run `node --test --test-name-pattern 'sign-in wall|only a 429' test/ytnotes.test.js`: 2 pass on 2026-10-14. The live block lifted before it could be rerun, so this one is proven with a fake downloader only.

---

**Status:** Verified live on 2026-10-21 for all five steps from the youtube-lead branch: step 1 in 12.81s, step 2 in 20.88s, step 3 exit 2, step 4 exit 3 with a fresh home, and the full bench 5 of 5 in 37 seconds. Rerun live on 2026-10-27 after the Oct 25-27 speed changes: step 1 in 9.67 to 15.85s, step 2 in 37.78s at load 8.4, and the full bench 5 of 5 in 65 seconds, including both stranger cases. Full bench rerun on 2026-10-28 after the oEmbed channel change: 5 of 5 in 64 seconds. First verified on 2026-09-28 for steps 1 to 4.
