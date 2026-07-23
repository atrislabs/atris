#!/usr/bin/env python3
"""s+-side probe: minimize s+ - (n-1) over connected NON-bipartite graphs
(bipartite is proven; s+ side violation would need lambda1^2 < n-1, i.e.
sparse, no high-degree vertex). Reports floor per n."""
import sys, random
import numpy as np
from localsearch import connected
from nonbip_search import is_bip

def mp_only(A, n):
    ev = np.linalg.eigvalsh(A)
    return float(np.sum(np.where(ev>1e-9, ev, 0.0)**2)) - (n-1)

def start(n, rng):
    # odd cycle of random odd length k + random tree hanging off it
    k = rng.choice(range(3, n if n%2 else n-1, 2))
    A = np.zeros((n,n))
    for i in range(k): A[i,(i+1)%k] = A[(i+1)%k,i] = 1
    for v in range(k, n):
        u = rng.randrange(v); A[u,v]=A[v,u]=1
    return A

def anneal(n, steps, rng, T0=0.3):
    A = start(n, rng)
    def f(A):
        o = mp_only(A, n)
        if is_bip(A, n): o += 0.75
        return o
    cur = f(A); best = np.inf; bestA=None
    for t in range(steps):
        T = T0 * (1e-4/T0)**(t/steps)
        i,j = rng.randrange(n), rng.randrange(n)
        if i==j: continue
        A[i,j]=A[j,i]=1-A[i,j]
        if A[i,j]==0 and not connected(A,n):
            A[i,j]=A[j,i]=1; continue
        new = f(A)
        if new <= cur or rng.random() < np.exp(-(new-cur)/T):
            cur = new
            if not is_bip(A,n):
                v = mp_only(A,n)
                if v < best: best=v; bestA=A.copy()
        else:
            A[i,j]=A[j,i]=1-A[i,j]
    return best, bestA

rng = random.Random(4242)
gb=(np.inf,None,None)
for n in [int(x) for x in sys.argv[1:]]:
    nb=np.inf; nA=None
    for r in range(8):
        b,bA = anneal(n, 8000, rng)
        if b<nb: nb,nA=b,bA
    print(f'n={n}: floor of s+-(n-1) over non-bipartite = {nb:.6f}', flush=True)
    if nb<gb[0]: gb=(nb,n,nA)
    if nb < -1e-7: np.savetxt(f'cand_splus_n{n}.txt', nA, fmt='%d'); print('CANDIDATE!')
print(f'GLOBAL: {gb[0]:.6f} at n={gb[1]}')
if gb[2] is not None: np.savetxt('best_splus_nonbip.txt', gb[2], fmt='%d')
