#!/usr/bin/env python3
"""Sign-multiplier variant: search for CW(n,k) rows with a(x^q) = -x^h a(x),
i.e. a_{q(j-h)} = -a_j along orbits of phi(j)=q*(j-h): entries alternate sign
around each orbit. Orbits of odd length are forced to 0. Solutions here are
fixed (+) under <q^2> but with half the freedom, so systems whose <q^2>
exhaustion was deferred become reachable.

Pipeline mirrors search2.search_system but with a signed indicator per orbit:
  J[i] has entries (+1,-1,+1,...) along the orbit traversal; candidate row is
  sum_i c_i * J[i], c in {-1,0,1}. Weight = orbit size for c_i != 0.
Exact integer PAF check on any spectral hit; certificates verified externally.
"""
import sys, math, time
import numpy as np
from math import gcd
from search2 import distinct_cyclic_subgroups, exact_paf_ok, save_cert, count_candidates

TOL1, TOL2 = 1e-4, 1e-6


def signed_orbits(n, q, h):
    """Orbits of phi(j)=q*(j-h) with alternating sign labels.
    Returns list of (positions, signs) for even-length orbits, or None entries
    skipped (odd orbits are forced zero and simply excluded from support)."""
    seen = [False] * n
    out = []
    for x0 in range(n):
        if seen[x0]:
            continue
        path = []
        y = x0
        while not seen[y]:
            seen[y] = True
            path.append(y)
            y = (q * (y - h)) % n
        if len(path) % 2 == 0:
            signs = [1 if i % 2 == 0 else -1 for i in range(len(path))]
            out.append((path, signs))
        # odd orbit: a must vanish there; excluded
    return out


def search_sign_system(n, k, q, h, sorbs, cand_cap=1_500_000_000, subset_cap=3_000_000,
                       chunk=1 << 18, verbose=True):
    s_root = math.isqrt(k)
    m = len(sorbs)
    if m == 0:
        return [], True, 0
    sizes = [len(p) for p, _ in sorbs]
    ncand = count_candidates(sizes, k, cand_cap)
    if ncand == 0:
        return [], True, 0
    if ncand > cand_cap:
        if verbose:
            print(f"  SIGN n={n} k={k} q={q} h={h} m={m}: {ncand:.3g} cands, DEFER", flush=True)
        return [], False, ncand
    t_arr = np.arange(n)
    Jhat = np.zeros((m, n), dtype=np.complex128)
    Jvec = np.zeros((m, n), dtype=np.int64)
    for i, (pos, sg) in enumerate(sorbs):
        for p, s in zip(pos, sg):
            Jvec[i, p] += s
        Jhat[i] = (np.array(sg)[:, None] *
                   np.exp(2j * np.pi * (np.array(pos)[:, None] * t_arr[None, :]) / n)).sum(axis=0)
    # NOTE: row sum of signed orbit = sum of alternating signs = 0 for even orbits
    # so total row sum = 0 -- but a CW needs row sum +-sqrt(k) != 0.
    # UNLESS an orbit position repeats with net cancellation... row sum of
    # candidate = sum_i c_i * (sum of signs over orbit) = 0 always.
    # A valid CW requires A(1) = +-sqrt(k), so pure sign-multiplier candidates
    # can never be CWs. We therefore search MIXED systems instead: this space
    # is empty for k a nonzero perfect square. Bail out with a proof-print.
    if verbose:
        print(f"  SIGN n={n} k={k} q={q} h={h}: row sum forced 0 != +-{s_root}; "
              f"space provably empty, skip", flush=True)
    return [], True, 0


if __name__ == "__main__":
    print("sign-multiplier variant is provably empty for CW (row sum 0 != sqrt(k)); "
          "kept for the record")
