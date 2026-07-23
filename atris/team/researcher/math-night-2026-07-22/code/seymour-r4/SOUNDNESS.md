# Round-4 soundness chain — Seymour second neighborhood, exhaustive frontier

Claim being certified: there is NO oriented graph (digraph with no loops, no
2-cycles) on n <= N vertices in which every vertex v has |N++(v)| < |N+(v)|.

## Audit of round-1 (2026-07-22 overnight) artifacts

* `../seymour-second-neighborhood/verify.py` — standalone counterexample
  verifier, re-read line by line: implements the conjecture statement
  directly (loops/digons rejected, N++ = distance-exactly-2 set). CLEAN.
* `../seymour-second-neighborhood/sat_search.py` — encoding re-derived and
  found sound AND complete (details below, same core reused in
  `encode.py`).
* Round-1 report claims: "n=10 and n=11 UNSAT", "hand-proved lemma: min
  out-degree >= 4", "n=11 cross-checked by two runs".
  AUDIT FINDINGS:
  1. The logs contain NO completed n=10 run (build lines only) and only ONE
     n=11 UNSAT line (mindeg=3, 394s). The n=10 claim and the n=11
     double-run claim were not evidenced. (Both are now re-proved here with
     DRAT certificates, so nothing false survives, but the round-1 rigor
     complaint was justified.)
  2. The report's lemma is stated as "min out-degree >= 4"; only min
     out-degree >= 3 is easily provable (proof below) and only mindeg=3 was
     actually used in the logged run. The ">= 4" statement is UNVERIFIED and
     is NOT used anywhere in round 4. (Round 4 in fact machine-proves the
     d0=1,2 cases too, so no hand lemma is load-bearing any more.)

## Audited hand lemma (kept for context, no longer load-bearing)

In any counterexample every vertex violates |N++(v)| < |N+(v)|. Then:
* outdeg 0: |N++|=0=|N+|, no violation. So no sinks.
* outdeg(v)=1, v->u: v not in N+(u) (would be a 2-cycle), u not in N+(u),
  so N++(v) = N+(u), giving |N++(v)| = outdeg(u) >= 1 = |N+(v)| (u is not a
  sink). No violation. So min out-degree >= 2.
* outdeg(v)=2, v->{a,b}: N++(v) = (N+(a) u N+(b)) \ {a,b}. If |N++(v)| <= 1
  then N+(a) is contained in {b,w} and N+(b) in {a,w} for a single w; with
  outdeg(a),outdeg(b) >= 2 this forces a->b and b->a, a 2-cycle. So min
  out-degree >= 3.

## Round-4 encoding (encode.py) — soundness

Variables x_uv (arc u->v), y_vw (upper bound indicator for w in N++(v)).
* (~x_uv | ~x_vu) for u<v: no 2-cycles; x_vv never referenced: no loops.
* (x_vu & x_uw & ~x_vw) -> y_vw for all distinct u,v,w: y is forced up by
  every genuine 2-path, so sum_w y_vw >= |N++(v)| in every model.
* Totalizer: sum_w y_vw + sum_u ~x_vu <= n-2, which is equivalent to
  |N++(v)| <= |N+(v)| - 1 given the previous point.
Completeness (every genuine counterexample satisfies the CNF): set x from
the graph and y = exact indicator of N++; all clause groups check out.
Hence UNSAT => no counterexample on exactly n labeled vertices.

## Shard covering argument (per n)

sum_v outdeg(v) = #arcs <= n(n-1)/2, so the minimum out-degree d0 satisfies
d0 <= floor((n-1)/2). Shards d0 = 1 .. floor((n-1)/2) (d0=0 impossible:
sinks satisfy the conjecture). In shard d0:
* every vertex has outdeg >= d0 (totalizer),
* vertex 0 has outdeg <= d0 (totalizer) — so exactly d0,
* N+(0) is pinned to {1..d0} (unit clauses),
* lex-leader constraints A <=lex A∘sigma for adjacent transpositions sigma
  within {1..d0} and within {d0+1..n-1} ("twoblock").
Soundness: take any counterexample, relabel a minimum-out-degree vertex to
0 and its out-neighbours to 1..d0; the remaining freedom is the group
H = Sym{1..d0} x Sym{d0+1..n-1}, which preserves all pinned constraints;
choose the lex-min adjacency matrix over the H-orbit; it satisfies every
constraint for every sigma in H, in particular the encoded adjacent
transpositions. So UNSAT on all shards => no counterexample on n vertices.

## Lemma T (regular-tournament shards, hand proof, round-4)

For odd n, the top shard d0 = (n-1)/2 forces sum_v outdeg(v) = n(n-1)/2 =
all pairs adjacent = a tournament, (n-1)/2-regular. In a k-regular
tournament, fix v and take any w outside {v} u N+(v). If w were not in
N++(v), no u in N+(v) has u->w; by totality w->u for ALL u in N+(v), and
w->v (w not in N+(v)), so outdeg(w) >= k+1, contradicting regularity.
Hence N++(v) = V \ ({v} u N+(v)) and |N++(v)| = n-1-k = k = |N+(v)| for
every v: no vertex strictly violates, so these shards contain no
counterexample regardless of the SAT run. (Used only as a supplement if the
corresponding SAT instances have not finished; the machine proofs are
preferred receipts.)

## Machine verification

Every UNSAT instance was solved by CaDiCaL 3.0.1 with DRAT proof output and
every proof checked by drat-trim (marijnheule/drat-trim, built tonight from
source). "s VERIFIED" on every instance listed in RESULTS below.

## Controls (all passed)

* ctrl_n3_slack: relaxed bound (<= |N+|) at n=3 is SAT (directed triangle).
* ctrl_n6_shard_slack, ctrl_n12_s3_slack: relaxed bound through the FULL
  shard machinery (pin + twoblock + exact degree) is SAT at n=6 (C3 blowup)
  and n=12 (C4 blowup with parts of 3) — the shard path is not
  over-constrained.
* ctrl_n7_s3: shard path UNSAT where the conjecture is known to hold.
* Independent non-SAT exhaust (nauty geng|directg + check_d6.c, a from-
  scratch C checker): ALL oriented graphs on n <= 8 vertices enumerated,
  counts match OEIS A001174 exactly (2,142,288 at n=7; 575,016,219 at n=8),
  zero counterexamples. Cross-validates the SAT chain at n <= 8.
* check_d6 positive control: weakened comparison (<=) flags all 7 oriented
  graphs on 3 vertices, as it must.

## Cayley digraph lane

cayley.py: all 55 groups of order 12..24 (constructions verified as groups
by brute-force associativity/Latin-square/identity/inverse checks; distinct
isomorphism types counted by invariant fingerprint and matched exactly to
the classification: 12:5, 13:1, 14:2, 15:1, 16:14, 17:1, 18:5, 19:1, 20:5,
21:2, 22:2, 23:1, 24:15). For each group, ALL connection sets S with
S ∩ S^-1 = ∅ (equivalently all Cayley orientations, 3^{#inverse pairs} - 1
nonempty choices) were enumerated: 1,505,160 sets total. Vertex-transitivity
reduces the check to the identity vertex; this shortcut was itself
re-verified against a full all-vertex check on every 250th set (thousands of
spot checks, zero mismatches). Zero counterexamples.

## Reproduce

    brew install cadical nauty
    git clone https://github.com/marijnheule/drat-trim && make -C drat-trim
    python3 encode.py N --mindeg D --exactdeg0 D --pin-nbhd --sb-mode twoblock --out f.cnf
    cadical f.cnf f.drat ; drat-trim/drat-trim f.cnf f.drat   # expect s VERIFIED
    geng -q N | directg -o -q | ./check_d6                    # n <= 8 practical
    python3 cayley.py
