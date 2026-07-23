#!/usr/bin/env python3
"""Floor of min(s+,s-)-(n-1) over connected graphs that are neither
bipartite nor complete multipartite."""
import sys, random
import numpy as np
from localsearch import connected, random_start
from nonbip_search import is_bip

def is_cmp(A, n):
    # complete multipartite iff complement is a disjoint union of cliques:
    # i.e., non-adjacency is transitive
    C = 1 - A - np.eye(n)
    for i in range(n):
        Ni = np.nonzero(C[i])[0]
        for j in Ni:
            if not np.all(C[j][Ni] + (Ni == j)):
                return False
    return True

def stats(A, n):
    ev = np.linalg.eigvalsh(A)
    sp = float((np.where(ev>1e-9,ev,0)**2).sum())-(n-1)
    sm = float((np.where(ev<-1e-9,ev,0)**2).sum())-(n-1)
    return min(sp, sm)

def f(A, n):
    o = stats(A, n)
    if is_bip(A, n) or is_cmp(A, n): o += 0.6
    return o

def anneal(n, steps, rng, kind):
    A = random_start(n, rng, kind)
    cur = f(A, n)
    best = np.inf; bestA=None
    for t in range(steps):
        T = 0.3 * (1e-4/0.3)**(t/steps)
        i,j = rng.randrange(n), rng.randrange(n)
        if i==j: continue
        A[i,j]=A[j,i]=1-A[i,j]
        if A[i,j]==0 and not connected(A,n): A[i,j]=A[j,i]=1; continue
        new = f(A, n)
        if new <= cur or rng.random() < np.exp(-(new-cur)/T):
            cur = new
            if not is_bip(A,n) and not is_cmp(A,n):
                v = stats(A,n)
                if v < best: best=v; bestA=A.copy()
        else: A[i,j]=A[j,i]=1-A[i,j]
    return best, bestA

rng = random.Random(777)
for n in [int(x) for x in sys.argv[1:]]:
    nb=np.inf; nA=None
    for r in range(8):
        b,bA = anneal(n, 8000, rng, ['star','split','multipartite','random'][r%4])
        if b<nb: nb,nA=b,bA
    print(f'n={n}: floor over non-bip non-complete-multipartite = {nb:.6f}', flush=True)
    if nb < -1e-7: np.savetxt(f'cand_gap_n{n}.txt', nA, fmt='%d'); print('CANDIDATE!')
