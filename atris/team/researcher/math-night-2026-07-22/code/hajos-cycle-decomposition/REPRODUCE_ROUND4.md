# Round 4 sweeps — Hajos cycle-decomposition conjecture

Conjecture: every simple connected Eulerian graph on n vertices decomposes
into at most t = floor((n-1)/2) edge-disjoint cycles.

Tools: nauty geng 2.9.3 (brew), python3.12, ortools 9.15 (CP-SAT),
sweep.py (this dir), verify.py (independent exact BnB verifier).

## Sweep 1: all connected 8-regular graphs on n=14 (t=6)
Every 8-regular graph on 14 vertices is the complement of a 5-regular graph
on 14 vertices, and has min degree 8 >= n/2 so it is automatically connected.
Enumerating ALL 5-regular graphs (connected or not) and complementing covers
the class exactly once (complement is a bijection on isomorphism classes).

    for i in $(seq 0 9); do
      geng -q -d5 -D5 14 $i/10 | python3 sweep.py --mode complement \
        --label reg8n14-s$i --restarts 300 --seed $((3000+i)) &
    done; wait
    # class size cross-check: geng -u -d5 -D5 14

## Sweep 2: all connected 10-regular graphs on n=15 (t=7)
Same complement trick from 4-regular graphs on 15 vertices (805,579 graphs,
verified against geng -u -d4 -D4 15).

    for i in $(seq 0 9); do
      geng -q -d4 -D4 15 $i/10 | python3 sweep.py --mode complement \
        --label reg10n15-s$i --restarts 300 --seed $((2000+i)) &
    done; wait

## Sweep 3: all n=13 graphs with degree sequence (12, 6^12) (t=6)
Such a graph is exactly K1 joined to a 5-regular graph H on 12 vertices
(the apex is adjacent to everything; every other vertex sends 1 edge to the
apex and 5 into H). All 7,849 5-regular graphs on 12 vertices (geng count
7,849) were enumerated and joined:

    for i in $(seq 0 9); do
      geng -q -d5 -D5 12 $i/10 | python3 sweep.py --mode apex \
        --label apex13-s$i --restarts 400 --seed $((1000+i)) &
    done; wait

This family is margin-0: the apex has degree 12, forcing >= 6 cycles through
it, so any valid decomposition has exactly t=6 cycles, all through the apex.

## Soundness
- sweep.py validates every heuristic-claimed decomposition with
  verify.check_decomposition (exact partition into simple cycles) before
  counting it; invalid claims escalate.
- Heuristic failures escalate to exact CP-SAT (search.cpsat_leq_t,
  AddCircuit model, 600 s); UNSAT would write a certificate and exit 42,
  after which verify.py (independent pure-python BnB + CP-SAT cross-check)
  must confirm before any counterexample claim.
- Spot cross-checks: random samples from each class decided by
  verify.solve_leq_t (independent exact BnB): 43 samples, all feasible <= t,
  all partitions re-validated, zero alarms (crosscheck.py).
