#!/usr/bin/env python3
"""Simulated-annealing search for a Seymour counterexample on n vertices.

State: oriented graph (antisymmetric 0/1 matrix). Move: pick unordered pair,
cycle its state among {none, i->j, j->i}. Objective (minimize):
   good  = #vertices with |N++(v)| >= |N+(v)|   (counterexample <=> good = 0)
   slack = sum_v max(0, |N++(v)| - |N+(v)| + 1)  (tie-break)
Seeds: random tournaments, tournaments minus random arc subsets, random G(n,p).
"""
import sys, time
import numpy as np

rng = np.random.default_rng()

def score(A):
    n = A.shape[0]
    P2 = (A.astype(np.int16) @ A.astype(np.int16)) > 0
    Npp = P2 & ~A.astype(bool) & ~np.eye(n, dtype=bool)
    out = A.sum(1)
    spp = Npp.sum(1)
    good = int((spp >= out).sum())
    slack = int(np.maximum(0, spp - out + 1).sum())
    nlow = int((out < 4).sum())
    if nlow:  # out-degree <=2 vertices provably cannot all violate; hard-reject
        return n + nlow, 10000
    return good, slack

def random_seed(n, kind):
    A = np.zeros((n, n), dtype=np.int8)
    iu = np.triu_indices(n, 1)
    m = len(iu[0])
    if kind == 0:  # random tournament
        b = rng.integers(0, 2, m)
    elif kind == 1:  # tournament minus ~15% pairs
        b = rng.integers(0, 2, m)
        drop = rng.random(m) < 0.15
    else:  # sparse-ish random orientation
        b = rng.integers(0, 2, m)
        drop = rng.random(m) < 0.45
    A[iu[0], iu[1]] = b
    A[iu[1], iu[0]] = 1 - b
    if kind >= 1:
        A[iu[0][drop], iu[1][drop]] = 0
        A[iu[1][drop], iu[0][drop]] = 0
    return A

def anneal(n, seconds, T0=1.5, T1=0.02):
    t_end = time.time() + seconds
    best = (10**9, 10**9, None)
    restart = 0
    while time.time() < t_end:
        restart += 1
        A = random_seed(n, restart % 3)
        cur = score(A)
        cur_e = cur[0] * 100 + cur[1]
        t_restart_end = min(t_end, time.time() + 20)
        while time.time() < t_restart_end:
            for _ in range(2000):
                i = rng.integers(0, n); j = rng.integers(0, n)
                if i == j: continue
                i, j = (i, j) if i < j else (j, i)
                old = (A[i, j], A[j, i])
                choice = rng.integers(0, 2)
                states = [(0, 0), (1, 0), (0, 1)]
                states.remove(old)
                A[i, j], A[j, i] = states[choice]
                new = score(A)
                new_e = new[0] * 100 + new[1]
                T = max(T1, T0 * (t_end - time.time()) / seconds)
                if new_e <= cur_e or rng.random() < np.exp((cur_e - new_e) / T):
                    cur, cur_e = new, new_e
                    if (new[0], new[1]) < best[:2]:
                        best = (new[0], new[1], A.copy())
                        if new[0] == 0:
                            return best
                else:
                    A[i, j], A[j, i] = old
        # end restart
    return best

if __name__ == '__main__':
    for n in [int(a) for a in sys.argv[1].split(',')]:
        secs = float(sys.argv[2]) if len(sys.argv) > 2 else 60
        g, s, A = anneal(n, secs)
        print(f"n={n}: best good-vertices={g} slack={s}", flush=True)
        if g == 0:
            np.savetxt(f'cert_ls_n{n}.txt', A, fmt='%d', delimiter='')
            print(f"FOUND counterexample -> cert_ls_n{n}.txt", flush=True)
            break
        np.savetxt(f'best_ls_n{n}.txt', A, fmt='%d', delimiter='')
