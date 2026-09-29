# Validation: YouTube Notes

> **Role:** System Validation Script
> **Executor:** Validator Agent
> **Rule:** If ANY step fails, the feature is broken.

---

## Human check

Run `atris youtube notes 'https://www.youtube.com/watch?v=Am7IWP8IpEc'` and look at the last line. It should say `quotes: N kept, ...` with N above 0, in under about 20 seconds.

---

## 1. Environment Check

- [ ] **Tests pass**
  - Command: `node --test test/ytnotes.test.js test/ytquote-repair.test.js test/youtube.test.js`
  - Expect: 0 failures. On 2026-09-28 this was 111 passing.

- [ ] **Tools present**
  - Command: `command -v yt-dlp agy claude mlx_whisper`
  - Expect: yt-dlp and at least one writer. `mlx_whisper` is needed only for videos with no captions.

---

## 2. Simulation Steps (The "Real" Test)

### Step 1: Captioned long video (happy path)

- **Action:** `time atris youtube notes 'https://www.youtube.com/watch?v=Am7IWP8IpEc'`
- **Expect:** Exit code 0, notes on screen, and a saved copy at `$TMPDIR/ytnotes/yt_Am7IWP8IpEc.md`. The last line reads `quotes: N kept, N repaired, N dropped` with kept above 0, and the whole run takes under about 20 seconds with Gemini (measured 11 to 19 seconds; Haiku alone took 65).

### Step 2: Video with no captions

- **Action:** `time atris youtube notes 'https://www.youtube.com/watch?v=6DRlX5vIOE0'` on an Apple silicon Mac with `mlx_whisper`
- **Expect:** A line saying it is transcribing on this computer, then notes and a quote tally. Measured at 59 seconds.

### Step 3: Stranger with no downloader

- **Action:** from the repo root, `env HOME="$(mktemp -d)" TMPDIR="$(mktemp -d)" PATH=/usr/bin:/bin "$(command -v node)" bin/atris.js youtube notes 'https://www.youtube.com/watch?v=Am7IWP8IpEc'; echo "exit=$?"`
- **Expect:** A message that yt-dlp is missing, the install command, and `exit=2`. It must not say the video has no captions.

The fresh `TMPDIR` matters. A transcript left over from an earlier run of the same video is reused, which hides the missing downloader.

### Step 4: Stranger with no AI writer

- **Action:** `node --test --test-name-pattern 'writer' test/ytnotes.test.js`, which runs the script with yt-dlp present and no writer on the PATH.
- **Expect:** Exit code 3, a list of writers to install, and the transcript kept at `$TMPDIR/ytnotes/yt_<id>.clean.txt`. No blank notes file.

### Step 5: The scorecard (in review)

- **Action:** `atris youtube bench --quick` (three cases) or `atris youtube bench` (all five)
- **Expect:** One pass or fail per case, and one new line per run in `~/.atris/benchmarks/ytrail.jsonl`. The five cases are captioned-short `Z3JyAqh4ixg` (21 min), captioned-long `Am7IWP8IpEc` (85 min), no-captions `6DRlX5vIOE0`, stranger-no-downloader, and stranger-no-writer.

---

## 3. Regression Check

- [ ] `atris youtube process <url>` still charges 5 credits and refunds on failure. Only run this with a human's go, because it spends credits.
- [ ] `ATRIS_YTNOTES_ENGINE=haiku atris youtube notes <url>` still pins Haiku.
- [ ] `ATRIS_YTNOTES_LOCAL_TRANSCRIBE=0` on a no-caption video prints the paid command instead of transcribing.

---

**Status:** Verified on 2026-09-28 for steps 1 to 4 (step 3 rerun live on 2026-09-29, exit 2). Step 5 waits on the bench landing.
