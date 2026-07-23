#!/usr/bin/env python3
"""Meet-in-the-middle exact exhaustion of the two deferred cyclic systems for
CW(116,49): q=17 (m=32: sizes 1,1,1,1 + 28x4) and q=75 (m=31: 1,1,2 + 28x4).

Split the orbit list into halves A|B. Enumerate all ternary assignments of each
half (3^{|A|}), record (weight, rowsum, char values at TJ join frequencies).
Join constraint for a full solution: weight_A + weight_B = 49,
rowsum_A + rowsum_B = +-7, and for every t: |F_A(t) + F_B(t)|^2 = 49.

Join on quantized (F_A + target...) -- we can't invert |.|^2, so instead join
on (weight, rowsum) exactly, then filter pairs by TJ characters vectorized in
chunks; survivors get the full character check and exact integer PAF.

All float filters are loose pre-filters; final acceptance is exact integer PAF.
"""
import sys, math, time
import numpy as np
from search2 import orbit_systems, exact_paf_ok, save_cert

TOL = 1e-5


def ternary_enum(sizes):
    """All assignments c in {-1,0,1}^m as int8 array (3^m x m), with weight and
    rowsum vectors."""
    m = len(sizes)
    tot = 3 ** m
    C = np.zeros((tot, m), dtype=np.int8)
    rep = 1
    for i in range(m):
        vals = np.array([0, 1, -1], dtype=np.int8)
        C[:, i] = np.tile(np.repeat(vals, rep), tot // (3 * rep))
        rep *= 3
    sz = np.asarray(sizes, dtype=np.int64)
    w = (np.abs(C.astype(np.int64)) * sz).sum(axis=1)
    r = (C.astype(np.int64) * sz).sum(axis=1)
    return C, w, r


def run_system(n, k, q, h, orbs, max_weight=None):
    s_root = math.isqrt(k)
    m = len(orbs)
    sizes = [len(o) for o in orbs]
    print(f"MITM n={n} k={k} q={q} h={h} m={m} sizes={sorted(sizes)}", flush=True)
    t0 = time.time()
    # character table on orbit reps of the dual action t ~ q*t (all t needed for
    # final check; join uses a few)
    t_arr = np.arange(n)
    Ihat = np.zeros((m, n), dtype=np.complex128)
    for i, o in enumerate(orbs):
        Ihat[i] = np.exp(2j * np.pi * (np.array(o)[:, None] * t_arr[None, :]) / n).sum(axis=0)
    # split: put small orbits in half A, then balance counts
    order = sorted(range(m), key=lambda i: sizes[i])
    ha = order[: m // 2]
    hb = order[m // 2:]
    CA, wA, rA = ternary_enum([sizes[i] for i in ha])
    CB, wB, rB = ternary_enum([sizes[i] for i in hb])
    # prune by weight <= k
    kaA = wA <= k
    kaB = wB <= k
    CA, wA, rA = CA[kaA], wA[kaA], rA[kaA]
    CB, wB, rB = CB[kaB], wB[kaB], rB[kaB]
    print(f"  half A: {len(CA)} assignments, half B: {len(CB)} "
          f"({time.time()-t0:.0f}s)", flush=True)
    FA = CA.astype(np.float64) @ Ihat[ha]      # complex via promotion
    FB = CB.astype(np.float64) @ Ihat[hb]
    # group half A by (weight, rowsum)
    from collections import defaultdict
    groups = defaultdict(list)
    for idx in range(len(CA)):
        groups[(int(wA[idx]), int(rA[idx]))].append(idx)
    groups = {key: np.array(v) for key, v in groups.items()}
    # join characters: pick TJ frequencies with the most value diversity
    TJ = 4
    cand_t = [t for t in range(1, n)]
    # prefer t where FB values spread widely (heuristic): use variance
    var = np.argsort(-np.var(np.abs(FB[:, 1:]), axis=0))[:TJ] + 1
    jt = list(var)
    found = []
    checked_pairs = 0
    CHUNK = 4_000_000
    for target_r in (s_root, -s_root):
        for bi in range(len(CB)):
            need_w = k - int(wB[bi])
            need_r = target_r - int(rB[bi])
            g = groups.get((need_w, need_r))
            if g is None:
                continue
            # filter group by join characters
            sel = g
            for t in jt:
                if len(sel) == 0:
                    break
                vals = FA[sel, t] + FB[bi, t]
                ok = np.abs(np.abs(vals) ** 2 - k) < TOL
                sel = sel[ok]
            checked_pairs += len(g)
            if len(sel) == 0:
                continue
            # full check on survivors
            Ffull = FA[sel] + FB[bi]
            dev = np.max(np.abs(np.abs(Ffull[:, 1:]) ** 2 - k), axis=1)
            good = np.where(dev < TOL)[0]
            for gi in good:
                ai = sel[gi]
                a = np.zeros(n, dtype=np.int64)
                for ci, oi in zip(CA[ai], ha):
                    a[orbs[oi]] = int(ci)
                for ci, oi in zip(CB[bi], hb):
                    a[orbs[oi]] = int(ci)
                if exact_paf_ok(a, n, k):
                    save_cert(a, n, k, f"mitm_q{q}_h{h}_{len(found)}")
                    found.append(a)
    print(f"  MITM done: ~{checked_pairs} (weight,rowsum)-matched pairs filtered, "
          f"found={len(found)}, t={time.time()-t0:.0f}s", flush=True)
    return found


def main(n, k, want):
    for q, h, orbs in orbit_systems(n, 60, affine=True):
        if (q, h) in want:
            run_system(n, k, q, h, orbs)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "selftest":
        # rediscover CW(31,25) with q=5 via MITM machinery
        main(31, 25, {(5, 0)})
        # and CW(13,9) q=3
        main(13, 9, {(3, 0)})
    else:
        main(116, 49, {(17, 0), (75, 0)})
