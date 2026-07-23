# Math fleet run — receipts report

Date: 2026-07-22 overnight. Fleet of 9 agents, one open problem each.

## Topline

Nine open problems attacked overnight, zero refuted: nothing made it to the confirmed list and nothing was killed in verification either, because no agent ever produced a counterexample claim to kill. All nine lanes ended in "survived search": each agent built an independent, self-tested verifier first, then swept the cheap layers of its search space, and every conjecture held everywhere we could actually look. The concrete residue is real but modest: Seymour's second neighborhood conjecture got its exhaustive frontier pushed from n=7 to n=11 (conditional on an in-session lemma and an unaudited SAT stack), Hajos' conjecture was verified on all 6- and 8-regular graphs on 13 vertices (genuinely past the published n<=12 line), R(5,5)=43 got a full 2-million-case exhaust of the cyclic subcase plus a 43-vertex coloring with only 2 bad K5s, and the Elphick-et-al energy bound got a clean 12-million-graph exhaust to n=10 with the near-tight families mapped exactly. Everything else is calibration, partial sweeps cut off at report time, and a ranked list of structural gaps (mid-size-symmetry local search for circulant weighing matrices, lazy-constraint SAT at n=30-31 for Erdos-Gyarfas) that a second round should hit first. Honest read: these problems have survived decades of experts; one night of laptop compute reconfirming them is expected, and the value is the verified tooling plus the map of where the walls actually are.

## Per-problem

### 1. Strassler's open circulant weighing matrices + Leung-Ma k=25 (cw-strassler-open)

**What it says.** A circulant weighing matrix CW(n,k) is a sequence of n numbers, each -1, 0, or +1, exactly k of them nonzero, with a magic property: slide the sequence against itself by any shift and the products sum to zero. Strassler's table lists 22 (n,k) pairs where nobody knows if such a sequence exists; Leung-Ma conjecture the complete list for k=25.

**How far we searched.** Reconstructed the exact 22-case open list from arXiv 1908.08447v3 (cross-checked the paper's own arithmetic: 34-7-5=22). Built verify.py, an exact-integer verifier validated on four known matrices and corrupted negatives. Then: complete orbit-ansatz exhaust (signed unions of orbits of every cyclic subgroup with <=26 orbits) for CW(105,36); a multiplier-5 sweep for k=25 to n=200 (extension to 420 still running); simulated annealing on raw vectors; and a novel orbit-coefficient-space local search over subgroups with 24-64 orbits, which rediscovered the known CW(21,16) in seconds. Pipeline proven closed-loop by rediscovering CW(7,4), CW(13,9), CW(21,16), CW(31,25), CW(33,25).

**Result.** No certificate from any lane. CW(105,36) orbit exhaust completed with zero hits; k=25 sweep found only the known n=31, 33. Annealing plateaus (E=120 for (105,36)) carry no signal — calibration showed annealing also misses solutions that exist. 21 of 22 orbit exhausts and the orbit-LS lanes were still running at report time.

**Receipts.** verify.py, exhaust/sweep/anneal scripts and logs in the fleet scratchpad working dir for this lane; any late certificate would land as found_*.txt there and needs the double-verification step before belief.

### 2. Erdos-Gyarfas conjecture (cycle of length a power of 2)

**What it says.** Take any graph where every vertex has at least 3 edges. The conjecture: it must contain a cycle whose length is a power of two (4, 8, 16, 32, ...). Erdos put $100 on it.

**How far we searched.** Exact verifier (pruned DFS) cross-validated against networkx on 60 random graphs with zero mismatches, and against an independent SAT encoding. Swept: all 210 generalized Petersen graphs to 60 vertices; ~9000 degree-3/4 circulants n=17-60; the named high-girth cubic graphs up to Foster (90 vertices, girth 10); then ~20 targeted annealing runs (~3M rewirings) on cubic graphs at 10 orders in [25,58], with moves aimed at edges of offending power-of-2 cycles.

**Result.** Every structured graph contains a power-of-2 cycle. Annealing kills all 4-cycles and 8-cycles easily but the 16-cycle count floors far above zero everywhere (210 distinct C16s at n=30 across three independent runs; 227 at n=27). No counterexample; the C16 mass looks structurally unavoidable at these orders. Not exhaustive — the published cubic-below-30 frontier was not extended (no nauty in-session).

**Receipts.** /private/tmp/claude-501/-Users-keshavrao-arena-atris-cli/fd403b33-f912-4822-af2b-bf1a10d0935d/scratchpad/erdos-gyarfas-2power/ — verify.py, sat_cycle.py, best_n30_s201.txt (428 C16s, networkx-confirmed spectrum).

### 3. Positive square energy bound s+ >= n-1 (Elphick-Farber-Goldberg-Wocjan)

**What it says.** Square a graph's adjacency-matrix eigenvalues and add up just the positive ones (call it s+), or just the negative ones (s-). Conjecture: for any connected graph on n vertices, both sums are at least n-1.

**How far we searched.** Exhaustive over all ~12M connected graphs n=4-10 (counts verified against OEIS); n=11 (1e9 graphs) launched, ~30% done, no candidate. Exhaustive sparse corners (m<=n+3, n to 16), dense corners (near-complete, n to 20), threshold graphs to n=16, ~40k structured instances, 6M random graphs, ~2M annealing evaluations to n=40, plus fully exact sympy certification (isolating intervals of width 1e-40) on the near-ties.

**Result.** Holds everywhere. Margin 0 only at the proven-tight families (trees; K_n on the s- side). Closest strict approach: star-plus-pendant-clique families whose s- margin decays like ~1/n, verified positive out to n=3200 — asymptotically sharp but never crossing. The s+ side over non-bipartite graphs is bounded away by ~0.78 with no downward trend. A counterexample would have to be discontinuously unlike every family observed.

**Receipts.** verify.py (independent exact certifier), geng slice logs, and the extremal-family exact certifications in the lane working dir.

### 4. Seymour's second neighborhood conjecture

**What it says.** In any directed graph with no 2-cycles, some vertex has at least as many friends-of-friends (vertices exactly two steps away) as direct friends.

**How far we searched.** Complete SAT encoding, validated by reproducing the known UNSAT record at n=6,7. Unconditional machine proof extended to n=8 (0.7s) and n=9 (16.8s). With an in-session hand-proved lemma (any counterexample has min out-degree >= 4) plus partial lex-leader symmetry breaking: n=10 and n=11 UNSAT, n=11 cross-checked by two runs with different prunes. Positive control confirmed the encoding is not over-constrained. Also: exhaustive circulant sweep n=3-31 (margin exactly 0, never negative), ~10^6-eval annealing per size to n=32, blowup-weight search.

**Result.** Exhaustive record extended n<=7 to n<=11. Solid unconditionally to n=9; n=10-11 conditional on the unreviewed lemma, my own symmetry-breaking implementation, and cadical with no DRAT proof logging — that is the rigor gap for a proper record claim. n=12 still grinding at report time. Heuristic walls landed exactly where the lemma predicts.

**Receipts.** SAT encoder, lemma writeup, and UNSAT run logs in the lane working dir; the n=11 double-run (mindeg>=3 vs >=4) is the internal cross-check.

### 5. Hajos' cycle decomposition conjecture (hajos-cycle-decomposition)

**What it says.** Any graph where every vertex touches an even number of edges can be split into at most (n-1)/2 cycles that together use every edge exactly once. Verified in the literature only up to 12 vertices.

**How far we searched.** Exhaustive over all 367,860 connected 6-regular graphs on 13 vertices, all 10,786 8-regular n=13, all 540 10-regular n=14, all 4,207 12-regular n=16, all even circulants n=13-16, systematic dense families, ~170k random even graphs. Pipeline: cheap randomized decomposer, escalating to exact CP-SAT; verifier sanity-tested both directions on K5/K7/octahedron/K13.

**Result.** New territory: Hajos holds for all connected 6- and 8-regular graphs on 13 vertices (beyond the published n<=12). Zero escalations — the cheap heuristic decomposed every single graph. Exact probes on 100k of the most-suspect slice show true margin >= 1 everywhere except the counting-tight near-complete graphs (K13, K13 minus triangles: margin exactly 0, all decomposable). Mixed-degree n=13-16 space only sampled; 8-regular n=14 sweep incomplete.

**Receipts.** verify.py (B&B + CP-SAT cross-check), the 6-regular n=13 heuristic histogram, and sweep logs in the lane working dir.

### 6. Gallai's path decomposition conjecture (gallai-path-decomposition)

**What it says.** Any connected graph on n vertices can be split into at most n/2 (rounded up) paths that together use every edge exactly once.

**How far we searched.** Two independent exact engines (pysat and CP-SAT), cross-checked on knowns (pn(K5)=3, pn(Petersen)=5). Exhaustive n=8 (all 7442 connected graphs); n=9 and 6-way-parallel n=10 running (~520k n=10 graphs scanned, zero needed the exact solver — greedy alone decomposed everything); all 20 6-regular graphs on 10 vertices; large structured-family and random dense sweeps; hill-climbing on the tight ridge.

**Result.** Holds everywhere decided; best margin ever seen is 0 (tight), never a violation. Tight instances match known extremal theory exactly (cliques, complete multipartite, glued odd cliques). Notable empirical: Eulerian regular graphs — the family the literature flags — are actually slack. n=9/n=10 sweeps incomplete at report time.

**Receipts.** verify.py, search.py, tight_instances.txt (~80 tight graphs with edge lists), exhaustive_n9.log, exhaustive_n10_*.log in the lane working dir.

### 7. Barnette's conjecture

**What it says.** Every planar, bipartite, 3-connected, 3-regular graph has a cycle visiting every vertex once. Tutte's analogous conjecture without "bipartite" was famously false; Barnette's version has held since 1969.

**How far we searched.** plantri compiled locally; ~2M Barnette graphs on 44 vertices and ~7M on 46 exhausted (48-vertex sweep still running, zero survivors); ~25k class-verified grown graphs at 66-120 vertices via a class-preserving expansion operator with solver-hardness hill-climbing; 60,720 Kelmans edge-pair queries; dead/mandatory-edge (Tutte-gadget) search over 3,292 graphs. Two independent Hamiltonicity engines agreeing 25/25 and correctly flagging the known non-Hamiltonian controls.

**Result.** Every graph Hamiltonian, usually trivially. Zero dead or mandatory edges and zero Kelmans failures — consistent with the parity intuition for why the conjecture should be true. Honest caveat: the exhaustive range (44-48) is below the published ~66-vertex frontier, so it validates the pipeline rather than extending the record; the 66-120 sweep covers only the subclass reachable by the growth operator.

**Receipts.** s2hard_* / candidate_* solver-hard certificates and sweep logs in the lane working dir.

### 8. R(5,5) = 43 (McKay-Radziszowski)

**What it says.** Color every edge among 43 people red or blue; the conjecture says you cannot avoid a same-colored group of 5 who all know each other. (Known: 43 <= R(5,5) <= 46; McKay-Radziszowski conjecture 43 exactly.)

**How far we searched.** Standalone brute-force verifier (all 962,598 5-subsets) self-tested on Paley graphs. Exhaustive over all 2^21 symmetric circulant colorings of K_43. Tabu search on general 903-bit colorings at ~17k flips/sec; SAT rigidity probe on the best near-miss. ~15 minutes total compute.

**Result.** Cyclic subcase fully exhausted: zero valid colorings (re-derivation of folklore, now with receipts); minimum 43 mono-K5s, all translates of the step-10 arithmetic progression. Best general coloring: exactly 2 monochromatic K5s (both blue, sharing a 4-term AP), red side completely K5-free, and SAT-proved unfixable within its 6-vertex neighborhood. Not claimed as a record — the published fewest-mono-K5 figure at n=43 was not checked.

**Receipts.** best_tabu_99.txt (the 2-K5 coloring, independently verified), circulant exhaust output, and the UNSAT rigidity instance in the lane working dir.

### 9. Vizing's domination product conjecture (vizing-domination-product)

**What it says.** The domination number of a graph is the fewest guards needed so every vertex is a guard or next to one. Vizing conjectured that for the box product of two graphs, you never need fewer than the product of the two individual guard counts.

**How far we searched.** Verifier validated on C4xC4 and C5xC5. Pool of 60 factors with domination number 4-5 (circulants + edge-critical random graphs, per the known minimal-counterexample reductions), CP-SAT decision tests on products up to 196 vertices. Forced report landed mid-sweep: ~200 of 1830 pairs decided.

**Result.** Every decided pair satisfies the conjecture, with infeasibility certificates. Minimum observed ratio 1.30. Key structural finding: for random edge-critical factors the LP (fractional Vizing, a theorem) kills candidacy in milliseconds — any real hunt must target factors with large integrality gap. That targeted third wave (search3.py) was written and LP-sanity-checked but never ran. Weakest coverage of the nine lanes.

**Receipts.** verify.py, search3.py (unrun), pair-sweep logs and the 4 queued timeout pairs in the lane working dir.

## What a second round would try, ranked by promise

1. **CW: orbit-coefficient-space local search at 24-64 orbits (and 64-120).** The genuinely underexplored gap in the literature — published exhausts stop at few-orbit subgroups (15 workstation-days for one case), and heuristic search inside mid-size symmetric subspaces found the known CW(21,16) in seconds where raw annealing failed. Longer caps, compound moves. Best novelty-per-compute of anything from tonight.
2. **Erdos-Gyarfas: complete methods at n=30-32.** Two concrete plans: geng-exhaust cubic girth>=5 graphs on 30-32 vertices filtering C8/C16 (extends the known bound or finds the counterexample — feasible with graph6 streaming plus the validated verifier), and lazy-constraint SAT (solve for a cubic graph, block each offending power-of-2 cycle, repeat) — complete, unlike annealing. n=30-31 is the unique window where only C4/C8/C16 must die.
3. **Seymour: make the n=10-11 record solid, then push.** DRAT-logged UNSAT with a second solver (closes the main rigor gap on an actual frontier extension), finish n=12, and try extending the hand lemma to min out-degree >= 5 — the counting slack at degree 4 is only 2, so it may fall to the same argument.
4. **Vizing: run the integrality-gap wave.** search3.py targets the only regime the LP does not instantly close (factors like C_{3k+1} with large gamma - gamma_f). Written, sanity-checked, never executed; plus 4 queued timeout pairs. Cheapest unfinished business in the fleet.
5. **Hajos: finish 8-regular n=14 (geng res/mod parallel), 10-regular n=15 via complements, and the targeted one-hub mixed-degree n=13 family.** Mechanical extension of a pipeline that already broke new ground.
6. **Gallai: finish n=9/n=10, run n=11 overnight (~500 graphs/s/worker supports it), climb near K(2,2,...,2) and edge-glued odd cliques.**
7. **s+ >= n-1: finish n=11 on uncontended compute, push n=12; deeper search interpolating between the K4-pendant family and split graphs at n=50-200; try proving s- - (n-1) >= c/n for graphs with a dominating vertex.** Evidence points at true-but-asymptotically-sharp; the proof attempt may now be worth more than more search.
8. **CW k=100 dense cases: reparametrize.** (112,100) is 89% dense — search over the 12 zero positions plus sign pattern, or Type-II compositions per the paper's Theorem 6.1. Untried angle.
9. **R(5,5): run the widened SAT and phase-seeded full instance to completion (hours), seed from Exoo/McKay (5,5;42) graphs extended by a vertex, attack the AP-shaped 2-K5 residue algebraically.** High effort, lowest odds — decades of prior CPU.
10. **Barnette: flip-based MCMC over the full class at n=70-90 with Hamiltonian-cycle count (DP over a path decomposition) as the direct fitness**, replacing solver-inconvenience proxies that demonstrably measured nothing.
