#!/usr/bin/env python3
"""Hybrid tabu / steepest-descent local search for CW(n,k).

State: a in {-1,0,1}^n with exactly k nonzeros, row sum fixed to +sqrt(k).
Energy: E = sum_{s=1..n-1} PAF(s)^2  (0 <=> valid CW).
Moves: (transfer) move a nonzero value to a zero cell; (flip-pair) flip one +1
and one -1; (swap) swap values at two cells.  Full neighborhood steepest
descent with sideways moves, random kicks on stagnation, many restarts.
"""
import sys, math, random, time
import numpy as np


def paf_np(a):
    F = np.fft.rfft(a)
    return np.rint(np.fft.irfft(np.abs(F) ** 2, len(a))).astype(np.int64)


def energy(a):
    p = paf_np(a)
    return int(np.sum(p[1:] ** 2))


def neighbors(a):
    """Yield (delta_desc, new_array) lazily? We instead build candidate list of
    moves as (type,i,j). Evaluation done by caller."""
    n = len(a)
    nz = np.flatnonzero(a)
    z = np.flatnonzero(a == 0)
    moves = []
    for i in nz:
        for j in z:
            moves.append((0, i, j))          # transfer value i->j
    pp = np.flatnonzero(a == 1)
    nn = np.flatnonzero(a == -1)
    for i in pp:
        for j in nn:
            moves.append((1, i, j))          # +1 at i becomes -1, -1 at j becomes +1
    return moves


def apply_move(a, mv):
    b = a.copy()
    t, i, j = mv
    if t == 0:
        b[j] = b[i]; b[i] = 0
    else:
        b[i] = -1; b[j] = 1
    return b


def batch_eval(cands, k):
    A = np.array(cands, dtype=np.float64)
    F = np.fft.rfft(A, axis=1)
    P = np.abs(F) ** 2
    # E = sum_{s>0} paf^2 ; parseval: sum_s paf(s)^2 = (1/n) sum |F|^4-ish; do direct
    n = A.shape[1]
    pafs = np.fft.irfft(P, n, axis=1)
    pafs = np.rint(pafs).astype(np.int64)
    return np.sum(pafs[:, 1:] ** 2, axis=1)


def run(n, k, restarts=30, max_steps=4000, seed=0):
    rng = random.Random(seed)
    s = math.isqrt(k)
    bestE_all = None
    best_a = None
    t0 = time.time()
    for r in range(restarts):
        a = np.zeros(n, dtype=np.int64)
        pos = rng.sample(range(n), k)
        npos = (k + s) // 2
        for idx, p in enumerate(pos):
            a[p] = 1 if idx < npos else -1
        E = energy(a)
        stag = 0
        for step in range(max_steps):
            moves = neighbors(a)
            rng.shuffle(moves)
            # evaluate in batches, take best
            bestE = None; bestmv = None
            B = 512
            for off in range(0, len(moves), B):
                chunk = moves[off:off + B]
                cands = [apply_move(a, mv) for mv in chunk]
                Es = batch_eval(cands, k)
                m = int(np.argmin(Es))
                if bestE is None or Es[m] < bestE:
                    bestE = int(Es[m]); bestmv = chunk[m]
                if bestE < E:
                    break  # first-improvement flavor: good enough, move on
            if bestE is None:
                break
            if bestE < E:
                a = apply_move(a, bestmv); E = bestE; stag = 0
            elif bestE == E:
                a = apply_move(a, bestmv); E = bestE; stag += 1
            else:
                stag += 1
            if E == 0:
                print(f"SOLVED n={n} k={k} restart={r} step={step}", flush=True)
                fn = f"found_{n}_{k}_ls_r{r}.txt"
                with open(fn, "w") as f:
                    f.write(f"{n} {k}\n")
                    f.write(" ".join(str(int(x)) for x in a) + "\n")
                print(f"*** WROTE CERTIFICATE {fn} ***", flush=True)
                return a, 0
            if stag > 40:
                # random kick: 3 random moves
                for _ in range(3):
                    mvs = neighbors(a)
                    a = apply_move(a, mvs[rng.randrange(len(mvs))])
                E = energy(a)
                stag = 0
        if bestE_all is None or E < bestE_all:
            bestE_all = E; best_a = a.copy()
        print(f"n={n} k={k} restart {r}: E={E} (best {bestE_all}) t={time.time()-t0:.0f}s", flush=True)
    np.save(f"best_ls_{n}_{k}.npy", best_a)
    print(f"DONE n={n} k={k} best E={bestE_all}", flush=True)
    return best_a, bestE_all


if __name__ == "__main__":
    n, k = int(sys.argv[1]), int(sys.argv[2])
    restarts = int(sys.argv[3]) if len(sys.argv) > 3 else 30
    max_steps = int(sys.argv[4]) if len(sys.argv) > 4 else 4000
    seed = int(sys.argv[5]) if len(sys.argv) > 5 else 0
    run(n, k, restarts, max_steps, seed)
