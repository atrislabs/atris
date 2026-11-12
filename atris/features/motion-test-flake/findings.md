# why the phone motion checks fail on busy CI machines

task CLI-1473. written 2026-11-12 from a local repro on master at 5f2aa7897. nothing in the test or the page was changed.

## the short version

The checks measure how far opacity moves between two animation frames and compare it to a fixed limit. The limit leaves less than two times of room over the best case. On a busy machine one slow frame is enough to break it. I made the page-open check fail locally on an unmodified checkout, once in six full runs and once in six probe runs under heavy load. The reduced-motion check did not fail in nine runs. That one is a reading of the code and not a repro.

## what the two failing checks measure

page-open check (test/gm-phone-motion.test.js:102, failing line 111). `openTrace` in scripts/gm-phone-paths.js opens the page on a card over a link with 250ms delay each way. It records every animation frame. `card_fade` is the biggest change in the card's opacity between two frames in a row. The limit is 0.15 and at least 6 frames must be mid-fade.

That number is raw. It is not divided by how long the frame took. No long frame is skipped as a stall. The card fades in over 0.45s with ease-out. By my arithmetic from the page's css (lib/gm-phone-page.js:251) the biggest one-frame step is about 0.06 at 17ms, 0.12 at 33ms, 0.14 at 40ms and 0.18 at 50ms. A single frame near 45ms during the fade fails the check. A normal local run reads 0.09.

reduced-motion check (test/gm-phone-motion.test.js:167, failing line 177). `pathsTrace` runs all 13 paths with reduced motion on. `summarizePath` turns each path's frames into numbers. `line_fade` is the biggest change in the opacity of the line under the orb between two frames, scaled to a 60fps frame. Frames longer than max(50ms, twice the typical frame) are skipped. The limit is 0.15. Under reduced motion the line fades over 0.2s linear, which is 0.083 per 60fps frame. The margin is 1.8 times.

This check does scale by frame time. A slow frame alone should not break it. Two things in the page can. The words are swapped by a 200ms timer (lib/gm-phone-page.js:454 to 461) while the css fade runs on its own clock. When the machine stalls, the timer and the fade drift apart. And a line that is hidden while still partly visible reads as a full cut, because a hidden line counts as opacity 0. I have not seen this happen. It is the best explanation for the line 177 failures that I can find by reading. It is not proven.

The CI summary with ms 2180, pace_frame_ms 17, longest_still_moving_ms 1068 and longest_still_at_ms 614 is a third kind: the first browser check allows 200ms where nothing moves while the page is busy. One path held still for about 1 second. A pace of 17ms means the machine drew normal frames overall. So the page itself sat still for a second. That fits a starved Chrome renderer. I could not reproduce it.

## how the browser is launched

No puppeteer or playwright. `findChrome` in scripts/gm-phone-trace.js picks CHROME_PATH, the Mac app, /usr/bin/google-chrome, google-chrome-stable, chromium or chromium-browser. `launch` starts it through lib/headless-chrome.js with --headless=new and a throwaway profile, plus --remote-debugging-port=0, --hide-scrollbars and a 390x844 window. On linux it adds --no-sandbox. The test talks to it over the DevTools protocol. Local and CI use the same flags except the sandbox flag. I did not read the runner image. I have not confirmed which Chrome ubuntu-latest has.

## how shard 6 is formed

.github/workflows/ci.yml runs 8 shards on ubuntu-latest. Each runs `node scripts/ci-test-shard.js N/8`, which gives every test file to the lightest shard by the weights in test/ci-file-durations.json and then runs `node --test` on that shard's files. Node runs those files as parallel processes, up to the core count minus one. So the Chrome test shares the machine with other test processes. Some of them are heavy. At this commit shard 6 holds engine-resource.test.js (51s), commands-7.test.js (29s) and dogfood-p0-safety.test.js (16s).

None of the seven tests that drive Chrome has a weight in the durations file: gm-phone-motion, gm-phone-layout, gm-phone-hands, gm-phone-health, gm-phone, gm-bet and team-tables-agree. Each is guessed at 1 second. The motion test really takes about 150 seconds and starts Chrome about twenty times. The shard builder cannot see it. The shard it lands in is an accident. I rebuilt the shard plan from the last 40 merges on master. The motion test landed in shard 1 six times, shard 3 nineteen times, shard 4 four times, shard 5 twice, shard 6 six times and shard 7 three times. At this commit it is in shard 4. Shard 6 is only where it sat on those branches.

## local results

The machine was shared with other agents the whole time. Its load average (10 cores) read between 25 and 225 before the runs. Even the bare runs were not quiet.

| run | load before | result | time |
| --- | --- | --- | --- |
| bare 1 | 225 | pass | 165s |
| bare 2 | 118 | fail, line 111 | 159s |
| bare 3 | 63 | pass | 149s |
| two light spinners 1 | 25 | pass | 145s |
| two light spinners 2 | 18 | pass | 158s |
| two light spinners 3 | 116 | pass | 157s |

The two spinners from the task take about 65 percent of a core each. That was less than the other agents were already using. Those three runs were not heavier than the bare ones. The one failure came on a bare run that started at a load of 118.

The failure, verbatim:

```
test at test/gm-phone-motion.test.js:102:1
AssertionError [ERR_ASSERTION]: {
   "first": "idea",
   "frames": 63,
   "sphere_frames_before_card": 0,
   "line_frames_before_card": 0,
   "card_frames_fading": 15,
   "card_fade": 0.16,
   "footer_seen_jump": 0,
   "dots_drawn": 0,
   "line_at_end": 0,
   "opened_ms": 0,
   "card_at_end": 1,
   "footer_at_end": 1
}
at test/gm-phone-motion.test.js:111:10
```

Everything the check cares about is right except one frame step of 0.16 against a limit of 0.15. That fits one frame of about 45ms.

Extra runs with 14 busy loops added (one per core and more):

- the two flaky checks alone, 3 runs: all passed, 38s each
- the page-open measure alone, 6 runs: five read 0.09 and one read 0.36 (57 frames instead of 63, 12 fading frames instead of 16). That one would fail line 111.

## strongest hypothesis

Chrome gets a slow frame during the 0.45s card fade, on a machine with other work running. The page-open check reads the raw step. One slow frame turns a smooth fade into a number over 0.15. CI runs this beside heavy tests in the same shard. Slow frames are more common there. The failures look random across branches because the motion test is placed by an accident of file order. The load on its machine depends on which other files landed with it.

For the reduced-motion line check and the one-second still, the same cause (a starved Chrome) is likely. The mechanism is not shown.

## smallest fix candidates

One. Make the page-open check read time, not frames. In `openTrace`, record the frame timestamp that requestAnimationFrame passes in, divide each opacity step by the frame's length as `summarizePath` does. Skip a frame longer than max(50ms, twice the typical frame). About ten lines in scripts/gm-phone-paths.js. No limit changes. This fixes the one failure I can reproduce.

Two. Put the measured timings in every failure message: biggest frame gap, typical frame and frame count. For the reduced-motion check, add the `cuts` list that `summarizePath` already builds. The next CI failure then says which kind it is without a rerun.

Three. Give the seven Chrome tests real weights in test/ci-file-durations.json so the shard builder knows the motion test costs about 150s. This removes the accident of placement. It does not remove the heavy neighbours.

Four. If one and two do not settle it, move the Chrome tests to their own job in ci.yml with nothing else running beside them. This is the bigger change.

Not recommended: derive the limits from 20 CI runs. The limits would then follow the noise. A real jump of a few frames would pass.

My pick is one and two together, then three.
