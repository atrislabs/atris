#!/usr/bin/env python3
"""Anneal minimizing s- - (n-1) over connected graphs with m <= n+2."""
import sys, random
import numpy as np
from localsearch import connected

def smm(A, n):
    ev = np.linalg.eigvalsh(A)
    return float((np.where(ev<-1e-9,ev,0)**2).sum())-(n-1)

def anneal(n, steps, rng, T0=0.2):
    # start: star + pendant K4
    A = np.zeros((n,n))
    A[0,1:n-3] = A[1:n-3,0] = 1
    c = [n-4, n-3, n-2, n-1]
    A[0, n-4] = A[n-4, 0] = 1
    for a in c:
        for b in c:
            if a != b: A[a,b]=1
    A[0,n-4]=A[n-4,0]=1
    cur = smm(A, n); best = cur; bestA = A.copy()
    mmax = n + 2
    for t in range(steps):
        T = T0 * (1e-5/T0)**(t/steps)
        i,j = rng.randrange(n), rng.randrange(n)
        if i == j: continue
        adding = A[i,j] == 0
        if adding and A.sum()/2 >= mmax: continue
        A[i,j]=A[j,i]=1-A[i,j]
        if not adding and not connected(A,n):
            A[i,j]=A[j,i]=1; continue
        new = smm(A, n)
        if new <= cur or rng.random() < np.exp(-(new-cur)/T):
            cur = new
            if new < best: best, bestA = new, A.copy()
        else:
            A[i,j]=A[j,i]=1-A[i,j]
    return best, bestA

rng = random.Random(31337)
for n in [int(x) for x in sys.argv[1:]]:
    nb = np.inf; nA=None
    for r in range(6):
        b, bA = anneal(n, 10000, rng)
        if b < nb: nb, nA = b, bA
    print(f'n={n}: floor s--(n-1) with m<=n+2: {nb:.6f}', flush=True)
    if nb < -1e-7:
        np.savetxt(f'cand_sminus_n{n}.txt', nA, fmt='%d'); print('CANDIDATE!')
    else:
        np.savetxt(f'best_sminus_n{n}.txt', nA, fmt='%d')
