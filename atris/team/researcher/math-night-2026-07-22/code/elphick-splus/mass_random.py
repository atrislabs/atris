#!/usr/bin/env python3
"""Mass random sampling: batched eigvalsh over millions of random labeled
graphs at n=12..16, all densities; track min margins (connectivity checked
only for candidates below threshold)."""
import numpy as np
rng = np.random.default_rng(123)
worst = {}
for n in range(12, 17):
    iu = np.triu_indices(n, 1)
    minp = minm = np.inf
    B = 20000
    reps = 60
    for rep in range(reps):
        p = rng.uniform(0.05, 0.95)
        bits = (rng.random((B, len(iu[0]))) < p)
        A = np.zeros((B, n, n))
        A[:, iu[0], iu[1]] = bits
        A[:, iu[1], iu[0]] = bits
        ev = np.linalg.eigvalsh(A)
        sp = (np.where(ev>1e-9, ev, 0)**2).sum(1) - (n-1)
        sm = (np.where(ev<-1e-9, ev, 0)**2).sum(1) - (n-1)
        # candidates below threshold: verify connectivity
        cand = np.where((sp < 1e-6) | (sm < 1e-6))[0]
        for c in cand:
            M = A[c]
            seen = np.zeros(n, bool); seen[0]=True; st=[0]; k=1
            while st:
                v=st.pop()
                for u in np.nonzero(M[v])[0]:
                    if not seen[u]: seen[u]=True; k+=1; st.append(int(u))
            if k==n:
                if sp[c] < minp: minp = sp[c]
                if sm[c] < minm: minm = sm[c]
                if sp[c] < -1e-7 or sm[c] < -1e-7:
                    np.savetxt(f'cand_rand_n{n}_{rep}_{c}.txt', M, fmt='%d')
                    print('CANDIDATE FOUND', n, sp[c], sm[c])
    print(f'n={n}: sampled {B*reps} labeled graphs; '
          f'min connected s+ margin={minp:.3e}, s- margin={minm:.3e}', flush=True)
