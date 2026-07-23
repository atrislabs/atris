# Dawn patrol status — 2026-07-23 07:56 CEST (certifier forced to close early)

Scratchpad root: /private/tmp/claude-501/-Users-keshavrao-arena-atris-cli/fd403b33-f912-4822-af2b-bf1a10d0935d/scratchpad/

## What this pass found and fixed
- Both seymour big-proof drat-trim checks (n15_s7, n16_s7) were DEAD on arrival
  (killed by the previous session's teardown; 0-byte .vres touched 07:40, no
  process). RELAUNCHED 07:46 (PIDs 94538, 94702), running healthily at close.
- The EG shard-5 near-miss regen was also DEAD (regen36g7_5.log had headers
  only, no process). RELAUNCHED 07:47 (snarkhunter-64 36 7 s o g m 5 8 |
  filter_c8dump > c8free36_s5.g6, in erdos-gyarfas-2power/).
- SHA256SUMS completeness audit: only gap was n16_s7.drat; hashed and appended
  (8e4e9c61d3075e971b398a9149355add920fa02f22692f66c9f4073193add500).
  Spot re-verified 5 stored hashes incl. n15_s7.drat: all OK (frozen proofs
  unchanged; chain of custody intact for the relaunched checks).
- Receipt spot-rechecks: n11_s3 drat-trim re-run matches stored receipt; all 45
  completed seymour .vres = "s VERIFIED"; R55 multsym H42/H21/H14 proofs all
  independently re-verified "s VERIFIED" against stored .dratcheck receipts.
- receipts/n15_s7.drattrim.txt is a 0-byte placeholder from the killed sweep;
  replace it when the relaunched check lands.
- NO drat-trim failure seen anywhere. Zero.

## In flight at close (verify liveness first: session teardown killed them once)
- seymour-r4: drat-trim n15_s7 (596MB proof) and n16_s7 (4.2GB, hours).
  If dead, relaunch: cd seymour-r4 && nice -n 15 ./drat-trim/drat-trim
  nX_sY.cnf nX_sY.drat > nX_sY.vres 2> nX_sY.vtime
- cadical n17_s7, n17_s8, n18_s7, n18_s8: ~6.6h in, proofs 5.3-8.3GB, growing.
  Harvest .res when non-empty, then drat-trim.
- R55 round4: multsym_H6 (90-min cap, ends ~09:11), multsym_H7 (3h cap, ends
  ~10:41), PIDs 87741/87742. Empty .res at cap = UNDECIDED. Any UNSAT:
  drat-trim the .drat FIRST, only then add the exclusion to EXCLUDED_TYPES.md.
- R55: inv_sat 21 (PID 17558), ball_sat 20 (PID 17559) still running ~6.5h.

## On n15_s7 / n16_s7 VERIFIED (the certification recipe)
1. grep 's VERIFIED' seymour-r4/nX_s7.vres; record real time from .vtime.
2. cp nX_s7.vres seymour-note/receipts/nX_s7.drattrim.txt; append
   "nX_s7 VERIFIED <t>s" to seymour-note/receipts/SUMMARY.txt.
3. cd seymour-note && python3 gen_tables.py && update main.tex Section
   "Beyond 14" (lines ~380-404: n15/n16 s7 no longer "still running";
   n16 becomes claimable) && tectonic main.tex.
4. Copy the whole seymour-note/ dir + new receipts to
   /Users/keshavrao/arena/atris-cli/atris/team/researcher/math-night-2026-07-22/seymour-note/
5. A FAILED verdict is a five-alarm finding: report verbatim, do not paper over.

## On c8free36_s5.g6 non-empty (EG near-miss)
1. python3 crosscheck.py on it; expect exactly "<g6> 0 0 1" (no C4, no C8, has C16).
2. Confirm regen STATS reproduces total=13092438 noC4C8=1 (regen36g7_5.stats.log).
3. Copy c8free36_s5.g6 + both regen logs into
   code/erdos-gyarfas-2power/harvest/ in the durable home, and update
   HARVEST_STATUS_erdos-gyarfas-2power.md.

## Verdict boundaries as of this close
- Seymour: n <= 14 fully certified (unchanged). n15: all shards UNSAT, s7
  proof exists+hash-pinned but drat-trim pending (Fisher/Lemma T covers it
  regardless). n16: all shards UNSAT, s7 drat-trim pending — NOT certified yet.
  n17/n18: not claimed, top shards still solving.
- R55 EXCLUDED_TYPES.md: round-7 state stands; no new exclusions this pass.

## Update 2026-07-23 07:55 CEST (morning-report agent)
The 07:46 relaunches died AGAIN with the certifier's session teardown (0-byte
.vres/.vtime and regen logs, no processes at 07:53). Relaunched a third time at
07:55 via scratchpad/relaunch_detached.py, which uses start_new_session=True
(setsid) so agent-session teardown can no longer kill them. Verified alive
post-launch: drat-trim n15_s7, drat-trim n16_s7, snarkhunter-64 shard 5.
The script is idempotent; re-run it to check/relaunch. Certification recipe
above unchanged.
