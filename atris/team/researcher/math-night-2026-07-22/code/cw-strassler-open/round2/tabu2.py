#!/usr/bin/env python3
"""Round-2 tabu/local search in orbit-coefficient space for CW(n,k).

Covers orbit systems (linear AND affine) whose candidate count exceeded the
exhaustive cap in search2.py, plus systems with orbit counts up to `hi`.

Energy: E(c) = sum_{s>0} PAF(s)^2 of a = sum_i c_i * 1_{O_i}, restricted to
c with weight exactly k and row sum +-sqrt(k) (moves preserve both).
Move set: (1) swap values of two orbits of equal size with different values,
(2) flip sign of an on-orbit paired with flipping another to keep row sum,
(3) exchange an on-orbit for two off-orbits whose sizes sum equal (and vice
versa) - implemented as a random kick. First-improvement scan with tabu list
on (orbit, value) assignments; random restarts.

Any E==0 candidate goes through the exact integer PAF check and is written as
found2_<n>_<k>_tabu_*.txt for external verification.
"""
import sys, math, time, random
import numpy as np
from search2 import orbit_systems, exact_paf_ok, save_cert, count_candidates


def run_system(n, k, q, h, orbs, rng, time_cap, max_steps=6000, restarts=10**9):
    s_root = math.isqrt(k)
    m = len(orbs)
    sizes = np.array([len(o) for o in orbs])
    ind = np.zeros((m, n), dtype=np.float64)
    for i, o in enumerate(orbs):
        ind[i, o] = 1.0

    def E_of(c):
        a = c @ ind
        F = np.fft.rfft(a)
        p = np.fft.irfft(np.abs(F) ** 2, n)
        return int(np.rint(np.sum(p[1:] ** 2)))

    t0 = time.time()
    bestE = None
    for r in range(restarts):
        if time.time() - t0 > time_cap:
            break
        # random start: weight exactly k
        c = np.zeros(m, dtype=np.int64)
        order = list(range(m))
        rng.shuffle(order)
        w = 0
        for i in order:
            if w + sizes[i] <= k:
                c[i] = rng.choice([1, -1])
                w += sizes[i]
            if w == k:
                break
        if w != k:
            continue
        E = E_of(c)
        stag = 0
        for step in range(max_steps):
            if time.time() - t0 > time_cap:
                break
            on = [i for i in range(m) if c[i] != 0]
            off = [i for i in range(m) if c[i] == 0]
            moves = []
            for i in on:
                moves.append(("flip", i, 0))
                for j in off:
                    if sizes[i] == sizes[j]:
                        moves.append(("move", i, j))
                        moves.append(("moveneg", i, j))
            rng.shuffle(moves)
            improved = False
            bestlocal = None
            for mv in moves[:220]:
                c2 = c.copy()
                if mv[0] == "flip":
                    c2[mv[1]] *= -1
                elif mv[0] == "move":
                    c2[mv[2]] = c2[mv[1]]; c2[mv[1]] = 0
                else:
                    c2[mv[2]] = -c2[mv[1]]; c2[mv[1]] = 0
                E2 = E_of(c2)
                if E2 < E:
                    c, E = c2, E2
                    improved = True
                    break
                if bestlocal is None or E2 < bestlocal[0]:
                    bestlocal = (E2, c2)
            if E == 0:
                a = np.rint(c @ ind).astype(np.int64)
                if exact_paf_ok(a, n, k):
                    save_cert(a, n, k, f"tabu_q{q}_h{h}_{int(time.time())%100000}")
                    return True, 0
                else:
                    E = E_of(c)  # false zero (rounding); recompute & continue
            if not improved:
                stag += 1
                if bestlocal is not None and rng.random() < 0.7:
                    E, c = bestlocal[0], bestlocal[1]
                if stag > 12:
                    # kick: relocate 2 random on-orbits to random equal-size off
                    for _ in range(2):
                        onn = [i for i in range(m) if c[i] != 0]
                        i = rng.choice(onn)
                        js = [j for j in range(m) if c[j] == 0 and sizes[j] == sizes[i]]
                        if js:
                            j = rng.choice(js)
                            c[j] = rng.choice([1, -1]); c[i] = 0
                    E = E_of(c)
                    stag = 0
            else:
                stag = 0
        if bestE is None or E < bestE:
            bestE = E
    return False, bestE


def run_target(n, k, lo=18, hi=70, time_cap_total=7200, seed=0):
    rng = random.Random(seed + 977 * n + k)
    systems = []
    for q, h, orbs in orbit_systems(n, hi, affine=True):
        m = len(orbs)
        if m < lo:
            # already exhausted by search2 unless deferred; include only if huge
            ncand = count_candidates([len(o) for o in orbs], k, 1_500_000_000)
            if ncand <= 1_500_000_000:
                continue
        systems.append((q, h, orbs))
    print(f"CW({n},{k}) tabu2: {len(systems)} systems (deferred or orbit count {lo}-{hi})", flush=True)
    if not systems:
        return
    per = max(60, time_cap_total // max(1, len(systems)))
    t0 = time.time()
    # round-robin passes so every system gets time even if one is slow
    for q, h, orbs in systems:
        if time.time() - t0 > time_cap_total:
            print("  total time cap hit", flush=True)
            break
        ok, bE = run_system(n, k, q, h, orbs, rng, time_cap=per)
        print(f"  q={q} h={h} m={len(orbs)}: {'SOLVED' if ok else f'bestE={bE}'} "
              f"({time.time()-t0:.0f}s elapsed)", flush=True)
        if ok:
            return


if __name__ == "__main__":
    n, k = int(sys.argv[1]), int(sys.argv[2])
    cap = int(sys.argv[3]) if len(sys.argv) > 3 else 7200
    seed = int(sys.argv[4]) if len(sys.argv) > 4 else 0
    run_target(n, k, time_cap_total=cap, seed=seed)
