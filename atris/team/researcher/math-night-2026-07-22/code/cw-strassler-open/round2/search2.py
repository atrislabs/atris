#!/usr/bin/env python3
"""Round-2 symmetry-restricted search for circulant weighing matrices CW(n,k).

Ansatz: first row a (ternary, weight k) constant on the orbits of a permutation
  phi(j) = q*(j - h) mod n,   q a unit of Z_n, h in {0..gcd(q-1,n)-1}.
h=0 is the classical fixed-multiplier case (a(x^q)=a(x)); h>0 is the affine
variant a(x^q) = x^{h'} a(x), which round 1 did not search at all.

Pipeline per orbit system:
  1. count sign-candidates (subsets of orbits with sizes summing to k, times
     2^(r-1) signings); skip system if > cand_cap (goes to tabu instead).
  2. enumerate: per subset, vectorized mask -> sign matrix; filter row sum ==
     +-sqrt(k); stage-1 spectral check on 10 columns of the orbit character
     table; survivors get the full spectral check; final exact integer PAF.
  3. write certificate found2_<n>_<k>_*.txt on success.

All spectral checks are float pre-filters only; nothing is claimed without the
exact integer check (and external verify.py / verify2.py afterwards).
"""
import sys, math, time
import numpy as np
from math import gcd

TOL1 = 1e-4   # stage-1 loose tolerance on | |A(w^t)|^2 - k |
TOL2 = 1e-6


def orbits_of_affine(n, q, h):
    """Orbits of phi(j) = q*(j-h) mod n."""
    seen = [False] * n
    orbs = []
    for x in range(n):
        if not seen[x]:
            o = []
            y = x
            while not seen[y]:
                seen[y] = True
                o.append(y)
                y = (q * (y - h)) % n
            orbs.append(sorted(o))
    return orbs


def distinct_cyclic_subgroups(n):
    """One representative q per distinct nontrivial cyclic subgroup of Z_n^*."""
    seen = set()
    out = []
    for q in range(2, n):
        if gcd(q, n) != 1:
            continue
        sg = set()
        y = 1
        while y not in sg:
            sg.add(y)
            y = (y * q) % n
        key = frozenset(sg)
        if key in seen:
            continue
        seen.add(key)
        out.append((q, len(sg)))
    return out


def orbit_systems(n, max_orbits, affine=True):
    """Yield (q, h, orbs) for all distinct systems with <= max_orbits orbits.
    Dedupe by the orbit partition itself."""
    seen_part = set()
    for q, order in distinct_cyclic_subgroups(n):
        g = gcd(q - 1, n) if affine else 1
        for h in range(g):
            orbs = orbits_of_affine(n, q, h)
            if len(orbs) > max_orbits:
                continue
            key = frozenset(frozenset(o) for o in orbs)
            if key in seen_part:
                continue
            seen_part.add(key)
            yield q, h, orbs


def count_candidates(sizes, k, cap):
    """Sum over subsets with |sizes| summing to k of 2^(r-1), early-exit at cap.
    DP over (weight) tracking sum of 2^r; then divide by 2."""
    # dp[w] = sum over subsets with weight w of 2^(#chosen)
    dp = [0] * (k + 1)
    dp[0] = 1
    for s in sizes:
        if s > k:
            continue
        for w in range(k, s - 1, -1):
            if dp[w - s]:
                dp[w] += 2 * dp[w - s]
        if dp[k] > 2 * cap * 4:  # generous early exit
            pass
    return dp[k] // 2  # first sign fixed +


def exact_paf_ok(a, n, k):
    ai = [int(x) for x in a]
    if sum(1 for x in ai if x != 0) != k:
        return False
    for s in range(1, n):
        if sum(ai[i] * ai[(i + s) % n] for i in range(n)) != 0:
            return False
    return True


def save_cert(a, n, k, tag, outdir="."):
    fn = f"{outdir}/found2_{n}_{k}_{tag}.txt"
    with open(fn, "w") as f:
        f.write(f"{n} {k}\n")
        f.write(" ".join(str(int(x)) for x in a) + "\n")
    print(f"*** WROTE CERTIFICATE {fn} ***", flush=True)
    return fn


def search_system(n, k, q, h, orbs, cand_cap=1_500_000_000, subset_cap=3_000_000,
                  chunk=1 << 18, verbose=True):
    """Exhaust ternary orbit assignments for one orbit system. Returns
    (found_list, complete_bool, ncands)."""
    s_root = math.isqrt(k)
    assert s_root * s_root == k
    sizes = [len(o) for o in orbs]
    m = len(orbs)
    ncand = count_candidates(sizes, k, cand_cap)
    if ncand == 0:
        return [], True, 0
    if ncand > cand_cap:
        if verbose:
            print(f"  n={n} k={k} q={q} h={h} m={m}: {ncand:.3g} cands > cap, DEFER", flush=True)
        return [], False, ncand
    # orbit character table: Ihat[i, t] = sum_{x in O_i} exp(2*pi*i*t*x/n)
    t_arr = np.arange(n)
    Ihat = np.zeros((m, n), dtype=np.complex128)
    for i, o in enumerate(orbs):
        Ihat[i] = np.exp(2j * np.pi * (np.array(o)[:, None] * t_arr[None, :]) / n).sum(axis=0)
    # stage-1 columns: a few t spread out, prefer t that are "generic"
    rng = np.random.default_rng(12345 + n * 7 + q * 3 + h)
    cols1 = rng.choice(np.arange(1, n), size=min(10, n - 1), replace=False)
    found = []
    # enumerate subsets with sizes summing to k
    order = sorted(range(m), key=lambda i: -sizes[i])
    suf = [0] * (m + 1)
    for i in range(m - 1, -1, -1):
        suf[i] = suf[i + 1] + sizes[order[i]]
    subsets = []
    overflow = [False]

    def dfs(idx, rem, chosen):
        if overflow[0]:
            return
        if rem == 0:
            subsets.append(list(chosen))
            if len(subsets) > subset_cap:
                overflow[0] = True
            return
        if idx >= m or suf[idx] < rem:
            return
        sz = sizes[order[idx]]
        if sz <= rem:
            chosen.append(order[idx])
            dfs(idx + 1, rem - sz, chosen)
            chosen.pop()
        dfs(idx + 1, rem, chosen)

    dfs(0, k, [])
    if overflow[0]:
        if verbose:
            print(f"  n={n} k={k} q={q} h={h} m={m}: subset cap, DEFER", flush=True)
        return [], False, ncand
    if verbose:
        print(f"  n={n} k={k} q={q} h={h} m={m} sizes={sorted(sizes)}: "
              f"{len(subsets)} subsets, {ncand} sign-cands", flush=True)
    t0 = time.time()
    checked = 0
    for ss in subsets:
        r = len(ss)
        szs = np.array([sizes[i] for i in ss], dtype=np.int64)
        Isub1 = Ihat[np.array(ss)][:, cols1]         # r x 10
        nmask = 1 << (r - 1) if r >= 1 else 1
        for start in range(0, nmask, chunk):
            end = min(start + chunk, nmask)
            masks = np.arange(start, end, dtype=np.uint64)
            C = len(masks)
            signs = np.ones((C, r), dtype=np.int64)
            for b in range(r - 1):
                signs[:, b + 1] = 1 - 2 * ((masks >> np.uint64(b)) & np.uint64(1)).astype(np.int64)
            rowsum = signs @ szs
            keep = np.abs(rowsum) == s_root
            if not keep.any():
                checked += C
                continue
            S = signs[keep].astype(np.float64)
            F1 = S @ Isub1
            dev1 = np.max(np.abs(np.abs(F1) ** 2 - k), axis=1)
            k1 = dev1 < TOL1
            checked += C
            if not k1.any():
                continue
            S2 = S[k1]
            Ifull = Ihat[np.array(ss)]                # r x n
            F2 = S2 @ Ifull
            dev2 = np.max(np.abs(np.abs(F2[:, 1:]) ** 2 - k), axis=1)
            k2 = dev2 < TOL2
            for row in S2[k2]:
                a = np.zeros(n, dtype=np.int64)
                for ci, oi in zip(row, ss):
                    a[orbs[oi]] = int(round(ci))
                if exact_paf_ok(a, n, k):
                    tag = f"q{q}_h{h}_{len(found)}"
                    save_cert(a, n, k, tag)
                    found.append(a.copy())
    if verbose:
        print(f"    done {checked} masks in {time.time()-t0:.1f}s, found={len(found)}", flush=True)
    return found, True, ncand


def run_target(n, k, max_orbits=45, affine=True, cand_cap=1_500_000_000):
    print(f"===== CW({n},{k}) round2 exhaustion (affine={affine}, max_orbits={max_orbits}) =====", flush=True)
    t0 = time.time()
    deferred = []
    total_found = []
    nsys = 0
    for q, h, orbs in orbit_systems(n, max_orbits, affine=affine):
        nsys += 1
        f, complete, ncand = search_system(n, k, q, h, orbs, cand_cap=cand_cap)
        total_found += f
        if not complete:
            deferred.append((q, h, len(orbs), ncand))
    print(f"===== CW({n},{k}) done: {nsys} systems, found={len(total_found)}, "
          f"deferred={len(deferred)}, t={time.time()-t0:.0f}s =====", flush=True)
    for d in deferred:
        print(f"  DEFERRED q={d[0]} h={d[1]} m={d[2]} cands={d[3]:.3g}", flush=True)
    return total_found, deferred


if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "target":
        n, k = int(sys.argv[2]), int(sys.argv[3])
        mo = int(sys.argv[4]) if len(sys.argv) > 4 else 45
        affine = not (len(sys.argv) > 5 and sys.argv[5] == "linear")
        run_target(n, k, max_orbits=mo, affine=affine)
    elif mode == "system":
        # deep run of one specific orbit system with custom cap
        n, k, q0, h0 = (int(x) for x in sys.argv[2:6])
        cap = int(float(sys.argv[6])) if len(sys.argv) > 6 else 20_000_000_000
        hit = False
        for q, h, orbs in orbit_systems(n, 100, affine=True):
            if q == q0 and h == h0:
                hit = True
                f, complete, nc = search_system(n, k, q, h, orbs, cand_cap=cap,
                                                subset_cap=30_000_000)
                print(f"system q={q} h={h}: complete={complete} found={len(f)}", flush=True)
        if not hit:
            print(f"no system q={q0} h={h0} found for n={n}", flush=True)
    elif mode == "selftest":
        # known-existing cases: pipeline must rediscover them
        for (n, k) in [(7, 4), (13, 9), (21, 16), (26, 9), (31, 25)]:
            run_target(n, k, max_orbits=20, affine=True, cand_cap=10_000_000)
    else:
        print("usage: search2.py target <n> <k> [max_orbits] [linear] | selftest")
