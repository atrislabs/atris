#!/usr/bin/env python3
"""Anneal on non-bipartite connected graphs: minimize min(s+,s-)-(n-1),
with +0.75 penalty on bipartite graphs so the search settles on the
tightest NON-bipartite instances (bipartite case is proven)."""
import sys, random
import numpy as np
from localsearch import connected, random_start

def is_bip(A, n):
    color = np.full(n, -1); color[0]=0; stack=[0]
    while stack:
        v=stack.pop()
        for u in np.nonzero(A[v])[0]:
            u=int(u)
            if color[u]==-1: color[u]=1-color[v]; stack.append(u)
            elif color[u]==color[v]: return False
    return True

def stats(A, n):
    ev = np.linalg.eigvalsh(A)
    sp = float(np.sum(np.where(ev>1e-9, ev, 0.0)**2))
    sm = float(np.sum(np.where(ev<-1e-9, ev, 0.0)**2))
    return sp-(n-1), sm-(n-1)

def obj(A, n):
    mp, mm = stats(A, n)
    o = min(mp, mm)
    if is_bip(A, n): o += 0.75
    return o, mp, mm

def anneal(n, steps, rng, kind, T0=0.4):
    A = random_start(n, rng, kind)
    cur, _, _ = obj(A, n)
    bestnb = np.inf; bestA = None
    for t in range(steps):
        T = T0 * (1e-4/T0)**(t/steps)
        i, j = rng.randrange(n), rng.randrange(n)
        if i == j: continue
        A[i,j] = A[j,i] = 1-A[i,j]
        if A[i,j]==0 and not connected(A,n):
            A[i,j]=A[j,i]=1; continue
        new, mp, mm = obj(A, n)
        if new <= cur or rng.random() < np.exp(-(new-cur)/T):
            cur = new
            if not is_bip(A, n) and min(mp,mm) < bestnb:
                bestnb = min(mp,mm); bestA = A.copy()
        else:
            A[i,j] = A[j,i] = 1-A[i,j]
    return bestnb, bestA

def main():
    ns = [int(x) for x in sys.argv[1:]]
    rng = random.Random(99)
    kinds = ['star','complete','split','multipartite','random','random']
    gb = (np.inf, None, None)
    for n in ns:
        nbest = np.inf; nA = None
        for r in range(10):
            b, bA = anneal(n, 8000, rng, kinds[r % len(kinds)])
            if b < nbest: nbest, nA = b, bA
        print(f'n={n}: best NON-bipartite min(s+,s-)-(n-1) = {nbest:.6e}', flush=True)
        if nbest < gb[0]: gb = (nbest, n, nA)
        if nbest < -1e-7:
            np.savetxt(f'candidate_nb_n{n}.txt', nA, fmt='%d')
            print('VIOLATION CANDIDATE saved')
    b, n, A = gb
    print(f'GLOBAL BEST nonbip margin {b:.6e} at n={n}')
    if A is not None: np.savetxt('best_nonbip.txt', A, fmt='%d')

if __name__ == "__main__":
    main()
