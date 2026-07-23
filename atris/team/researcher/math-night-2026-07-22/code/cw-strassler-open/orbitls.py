#!/usr/bin/env python3
"""Local search in orbit-coefficient space for CW(n,k).

For each cyclic subgroup <q> of Z_n^* whose orbit count m lies in [MIN_ORB,
MAX_ORB] (too many orbits to exhaust 3^m, few enough for local search to
move), search c in {-1,0,1}^m minimizing E = sum_{s>0} PAF(s)^2 of
a = sum_i c_i * indicator(orbit_i), subject to weight == k (sum of |O_i| over
nonzero c_i) and row sum == +-sqrt(k).

Exhaustive-neighborhood tabu descent with kicks; solutions found are exact CWs
invariant under x -> qx.
"""
import sys, math, random, time
import numpy as np
from math import gcd
from search import orbits_of, exact_paf_ok, save_cert


def subgroups_in_range(n, lo, hi):
    seen = set()
    out = []
    for q in range(2, n):
        if gcd(q, n) != 1:
            continue
        sg = set(); y = 1
        while y not in sg:
            sg.add(y); y = (y * q) % n
        key = frozenset(sg)
        if key in seen:
            continue
        seen.add(key)
        orbs = orbits_of(n, q)
        if lo <= len(orbs) <= hi:
            out.append((q, orbs))
    return out


def run_case(n, k, lo=24, hi=64, restarts=25, max_steps=3000, time_cap=900, seed=0):
    rng = random.Random(seed + n * 1000 + k)
    s = math.isqrt(k)
    subs = subgroups_in_range(n, lo, hi)
    print(f"CW({n},{k}): {len(subs)} subgroups with orbit count in [{lo},{hi}]", flush=True)
    t0 = time.time()
    bestE_all = None
    for q, orbs in subs:
        m = len(orbs)
        sizes = np.array([len(o) for o in orbs])
        ind = np.zeros((m, n), dtype=np.float64)
        for i, o in enumerate(orbs):
            ind[i, o] = 1.0

        def compose(c):
            return c @ ind

        def E_of(c):
            a = compose(c)
            F = np.fft.rfft(a)
            p = np.rint(np.fft.irfft(np.abs(F) ** 2, n)).astype(np.int64)
            return int(np.sum(p[1:] ** 2))

        for r in range(restarts):
            if time.time() - t0 > time_cap:
                break
            # random start: greedy fill to weight k
            c = np.zeros(m, dtype=np.int64)
            order = list(range(m)); rng.shuffle(order)
            w = 0
            for i in order:
                if w + sizes[i] <= k:
                    c[i] = rng.choice([1, -1]); w += sizes[i]
                if w == k:
                    break
            if w != k:
                continue
            E = E_of(c)
            stag = 0
            for step in range(max_steps):
                # neighborhood: sign flips, drop+add (keep weight), value changes
                moves = []
                on = [i for i in range(m) if c[i] != 0]
                off = [i for i in range(m) if c[i] == 0]
                for i in on:
                    moves.append(("flip", i, -1))
                for i in on:
                    for j in off:
                        if sizes[i] == sizes[j]:
                            moves.append(("move", i, j))
                # swap signs pattern between two on-orbits of different sign
                rng.shuffle(moves)
                bestE = None; bestmv = None
                for mv in moves:
                    c2 = c.copy()
                    if mv[0] == "flip":
                        c2[mv[1]] *= -1
                    else:
                        c2[mv[2]] = c2[mv[1]]; c2[mv[1]] = 0
                        if rng.random() < 0.5:
                            c2[mv[2]] *= -1
                    E2 = E_of(c2)
                    if bestE is None or E2 < bestE:
                        bestE, bestmv, bestc = E2, mv, c2
                        if E2 < E:
                            break
                if bestE is None:
                    break
                if bestE <= E:
                    stag = stag + 1 if bestE == E else 0
                    c, E = bestc, bestE
                else:
                    stag += 1
                if E == 0:
                    a = np.rint(compose(c)).astype(int)
                    if exact_paf_ok(a) and int(np.count_nonzero(a)) == k:
                        # exclude row-sum violation? row sum = sum c*sizes; check
                        print(f"SOLVED CW({n},{k}) q={q}", flush=True)
                        save_cert(a, n, k, f"orbitls_q{q}")
                        return True
                if stag > 25:
                    # kick
                    for _ in range(2):
                        i = rng.choice([i for i in range(m) if c[i] != 0])
                        js = [j for j in range(m) if c[j] == 0 and sizes[j] == sizes[i]]
                        if js:
                            j = rng.choice(js)
                            c[j] = rng.choice([1, -1]); c[i] = 0
                    E = E_of(c); stag = 0
            if bestE_all is None or E < bestE_all:
                bestE_all = E
        print(f"  q={q} m={m} done, best E so far {bestE_all}, t={time.time()-t0:.0f}s", flush=True)
        if time.time() - t0 > time_cap:
            print("  time cap reached", flush=True)
            break
    print(f"CASE CW({n},{k}) best E={bestE_all}", flush=True)
    return False


if __name__ == "__main__":
    if sys.argv[1] == "all":
        cap = int(sys.argv[2]) if len(sys.argv) > 2 else 600
        from search import OPEN_CASES
        for n, k in OPEN_CASES:
            run_case(n, k, time_cap=cap)
    else:
        n, k = int(sys.argv[1]), int(sys.argv[2])
        cap = int(sys.argv[3]) if len(sys.argv) > 3 else 900
        run_case(n, k, time_cap=cap)
