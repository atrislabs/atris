#!/usr/bin/env python3
"""Blowup-weight search. A vertex-weighted counterexample on base oriented
graph H (weights t_i >= 1, sum_{N++(i)} t < sum_{N+(i)} t for all i) yields an
unweighted counterexample by blowing vertex i into an independent set of size
t_i. Feasibility check by exact rational LP (Fourier-Motzkin is too slow;
use a simplex-free approach: randomized weight local search + exact integer
hill climb). No scipy needed.

For each base H: minimize violations of
    def_i := sum_{j in N+(i)} t_j - sum_{j in N++(i)} t_j >= 1
over integer weights t in [1, WMAX], by coordinate hill-climbing with restarts.
"""
import sys, time
import numpy as np

rng = np.random.default_rng(12345)

def neighborhoods(A):
    n = A.shape[0]
    Ab = A.astype(bool)
    P2 = (A.astype(np.int16) @ A.astype(np.int16)) > 0
    Npp = P2 & ~Ab & ~np.eye(n, dtype=bool)
    return Ab, Npp

def n_bad(Ab, Npp, t):
    # bad_i = 1 if sum_{N+} t - sum_{N++} t < 1
    d = Ab @ t - Npp @ t
    return int((d < 1).sum()), int(np.minimum(d - 1, 0).sum())

def try_base(A, iters=4000, wmax=60):
    Ab, Npp = neighborhoods(A)
    n = A.shape[0]
    if (A.sum(1) == 0).any():
        return None  # sink in base: blob of a sink still fails
    best = None
    for restart in range(6):
        t = rng.integers(1, 8, n).astype(np.int64)
        cur = n_bad(Ab, Npp, t)
        for _ in range(iters):
            i = rng.integers(0, n)
            old = t[i]
            t[i] = max(1, min(wmax, old + rng.integers(-3, 4)))
            new = n_bad(Ab, Npp, t)
            if new <= cur:
                cur = new
                if new[0] == 0:
                    return t.copy()
            else:
                t[i] = old
        if best is None or cur < best:
            best = cur
    return None

def random_oriented(n, p_arc=0.75):
    A = np.zeros((n, n), dtype=np.int8)
    iu = np.triu_indices(n, 1)
    b = rng.integers(0, 2, len(iu[0]))
    keep = rng.random(len(iu[0])) < p_arc
    A[iu[0], iu[1]] = b & keep
    A[iu[1], iu[0]] = (1 - b) & keep
    return A

def expand(A, t):
    n = A.shape[0]
    idx = np.repeat(np.arange(n), t)
    G = A[np.ix_(idx, idx)].copy()
    # same-blob pairs: independent (A[i][i]=0 already handles it)
    return G

if __name__ == '__main__':
    seconds = float(sys.argv[1]) if len(sys.argv) > 1 else 240
    t_end = time.time() + seconds
    tried = 0
    import glob
    bases = []
    for f in glob.glob('best_ls_n*.txt'):
        A = np.array([[int(c) for c in l.strip()] for l in open(f) if l.strip()], dtype=np.int8)
        if A.shape[0] <= 16:
            bases.append(('file:' + f, A))
    while time.time() < t_end:
        if bases:
            name, A = bases.pop()
        else:
            n = int(rng.integers(6, 14))
            A = random_oriented(n, float(rng.uniform(0.5, 1.0)))
            name = f'random n={n}'
        tried += 1
        t = try_base(A)
        if t is not None:
            G = expand(A, t)
            # direct check on expanded graph
            Ab, Npp = neighborhoods(G)
            bad = int((Npp.sum(1) >= Ab.sum(1)).sum())
            print(f"WEIGHTED HIT on {name}: t={t.tolist()} expanded N={G.shape[0]} bad={bad}")
            if bad == 0:
                np.savetxt('cert_blowup.txt', G, fmt='%d', delimiter='')
                print("FOUND blowup counterexample -> cert_blowup.txt")
                sys.exit(0)
    print(f"blowup search: {tried} base graphs tried, no feasible weight system", flush=True)
