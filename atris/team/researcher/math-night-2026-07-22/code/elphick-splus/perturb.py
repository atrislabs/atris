#!/usr/bin/env python3
"""Toggle 1 and 2 edges on tight instances (stars, random trees, K_n,
complete multipartite); record most negative margin among connected results."""
import itertools, random
import numpy as np
import networkx as nx

def margin(A):
    n = A.shape[0]
    ev = np.linalg.eigvalsh(A)
    sp = (np.where(ev>1e-9, ev, 0)**2).sum() - (n-1)
    sm = (np.where(ev<-1e-9, ev, 0)**2).sum() - (n-1)
    return min(sp, sm)

def conn(A):
    n=A.shape[0]; seen=np.zeros(n,bool); seen[0]=True; st=[0]; k=1
    while st:
        v=st.pop()
        for u in np.nonzero(A[v])[0]:
            if not seen[u]: seen[u]=True;k+=1;st.append(int(u))
    return k==n

rng = random.Random(5)
worst = (np.inf, None)
def scan(name, A):
    global worst
    n = A.shape[0]
    pairs = list(itertools.combinations(range(n), 2))
    for (i,j) in pairs:
        A[i,j]^=1; A[j,i]^=1
        if conn(A):
            m = margin(A)
            if m < worst[0]: worst = (m, f'{name} toggle ({i},{j})')
            if m < -1e-7: np.savetxt(f'cand_pert.txt', A, fmt='%d'); print('CAND', name, i, j, m)
        A[i,j]^=1; A[j,i]^=1
    # 400 random double toggles
    for _ in range(400):
        (i,j),(k,l) = rng.sample(pairs, 2)
        for (a,b) in [(i,j),(k,l)]: A[a,b]^=1; A[b,a]^=1
        if conn(A):
            m = margin(A)
            if m < worst[0]: worst = (m, f'{name} toggle2')
            if m < -1e-7: np.savetxt(f'cand_pert.txt', A, fmt='%d'); print('CAND2', name, m)
        for (a,b) in [(i,j),(k,l)]: A[a,b]^=1; A[b,a]^=1

for n in [8, 12, 16, 20, 25, 30]:
    S = np.zeros((n,n), dtype=int); S[0,1:]=1; S[1:,0]=1
    scan(f'star{n}', S)
    scan(f'K{n}', (1-np.eye(n, dtype=int)))
    for _ in range(6):
        T = nx.to_numpy_array(nx.random_labeled_tree(n)).astype(int)
        scan(f'tree{n}', T)
    # random complete multipartite
    for _ in range(4):
        parts=[]; left=n
        while left: s=rng.randrange(1,left+1); parts.append(s); left-=s
        if len(parts)>=2:
            A = nx.to_numpy_array(nx.complete_multipartite_graph(*parts)).astype(int)
            scan(f'K{parts}', A)
print(f'worst perturbation margin: {worst[0]:.6e} at {worst[1]}')
