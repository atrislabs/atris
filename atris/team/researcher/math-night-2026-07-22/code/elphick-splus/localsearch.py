#!/usr/bin/env python3
"""Simulated-annealing local search minimizing min(s+, s-) - (n-1)
over connected graphs, with structured restarts. Reports best margins."""
import sys, random
import numpy as np


def margins(A, n):
    ev = np.linalg.eigvalsh(A)
    sp = float(np.sum(np.where(ev > 1e-9, ev, 0.0) ** 2))
    sm = float(np.sum(np.where(ev < -1e-9, ev, 0.0) ** 2))
    return sp - (n - 1), sm - (n - 1)


def obj(A, n):
    mp, mm = margins(A, n)
    return min(mp, mm)


def connected(A, n):
    seen = np.zeros(n, dtype=bool)
    stack = [0]
    seen[0] = True
    c = 1
    while stack:
        v = stack.pop()
        for u in np.nonzero(A[v])[0]:
            if not seen[u]:
                seen[u] = True
                c += 1
                stack.append(int(u))
    return c == n


def random_start(n, rng, kind):
    A = np.zeros((n, n))
    if kind == 'star':
        A[0, 1:] = A[1:, 0] = 1
    elif kind == 'path':
        for i in range(n - 1):
            A[i, i + 1] = A[i + 1, i] = 1
    elif kind == 'complete':
        A = 1.0 - np.eye(n)
    elif kind == 'split':  # complete split: clique k + independent set joined
        k = rng.randrange(2, n - 1)
        A[:k, :k] = 1
        A[:k, k:] = A[k:, :k] = 1
        np.fill_diagonal(A, 0)
    elif kind == 'bipartite':
        a = rng.randrange(1, n)
        A[:a, a:] = A.T[:a, a:] = 0
        A[:a, a:] = 1
        A[a:, :a] = 1
    elif kind == 'multipartite':
        parts = []
        left = n
        while left > 0:
            s = rng.randrange(1, left + 1)
            parts.append(s)
            left -= s
        idx = np.cumsum([0] + parts)
        A = 1.0 - np.eye(n)
        for i in range(len(parts)):
            A[idx[i]:idx[i + 1], idx[i]:idx[i + 1]] = 0
    else:  # random G(n,p)
        p = rng.uniform(0.05, 0.95)
        U = rng.random()
        M = (np.random.default_rng(rng.getrandbits(32)).random((n, n)) < p)
        A = np.triu(M, 1).astype(float)
        A = A + A.T
    if not connected(A, n):
        # connect via random spanning path
        perm = list(range(n))
        rng.shuffle(perm)
        for i in range(n - 1):
            A[perm[i], perm[i + 1]] = A[perm[i + 1], perm[i]] = 1
    return A


def anneal(n, steps, rng, kind, T0=0.5, T1=1e-4):
    A = random_start(n, rng, kind)
    cur = obj(A, n)
    best = cur
    bestA = A.copy()
    for t in range(steps):
        T = T0 * (T1 / T0) ** (t / steps)
        i = rng.randrange(n)
        j = rng.randrange(n)
        if i == j:
            continue
        A[i, j] = A[j, i] = 1 - A[i, j]
        if A[i, j] == 0 and not connected(A, n):
            A[i, j] = A[j, i] = 1
            continue
        new = obj(A, n)
        if new <= cur or rng.random() < np.exp(-(new - cur) / T):
            cur = new
            if new < best:
                best = new
                bestA = A.copy()
        else:
            A[i, j] = A[j, i] = 1 - A[i, j]
    return best, bestA


def main():
    ns = [int(x) for x in sys.argv[1:]] or [12, 15, 20, 25, 30, 35, 40]
    rng = random.Random(20260722)
    kinds = ['star', 'path', 'complete', 'split', 'bipartite',
             'multipartite', 'random', 'random', 'random']
    global_best = (np.inf, None, None)
    for n in ns:
        nbest = np.inf
        for r in range(12):
            kind = kinds[r % len(kinds)]
            steps = 4000
            b, bA = anneal(n, steps, rng, kind)
            if b < nbest:
                nbest = b
                nbestA = bA
        print(f'n={n}: best min(s+,s-)-(n-1) = {nbest:.6e}', flush=True)
        if nbest < global_best[0]:
            global_best = (nbest, n, nbestA)
        if nbest < -1e-7:
            print('VIOLATION CANDIDATE at n =', n)
            np.savetxt(f'candidate_n{n}.txt', nbestA, fmt='%d')
    b, n, A = global_best
    print(f'GLOBAL BEST: margin {b:.6e} at n={n}')
    if A is not None:
        np.savetxt('best_local.txt', A, fmt='%d')


if __name__ == '__main__':
    main()
