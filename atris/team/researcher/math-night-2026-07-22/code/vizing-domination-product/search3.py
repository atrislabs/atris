#!/usr/bin/env python3
"""Wave 3: integrality-gap-driven search.

Fractional Vizing is a theorem: gamma_f(G box H) >= gamma_f(G) * gamma_f(H).
So any counterexample pair needs gamma_f(G)gamma_f(H) < gamma(G)gamma(H) - 1
or the LP bound alone (plus rounding) blocks a dominating set of size
gG*gH - 1. Strategy: hill-climb factors to MAXIMIZE the integrality gap
gamma(G) - gamma_f(G) at fixed gamma in {4,5}, n <= 14, then test the
high-gap pairs exactly with CP-SAT.
"""
import random, sys, time, json
from itertools import combinations
from search import (gamma_exact, connected, box_product, domset_decision,
                    gamma_product_exact, random_connected_graph, circulant,
                    nbhd_masks)
from ortools.linear_solver import pywraplp

random.seed(int(sys.argv[1]) if len(sys.argv) > 1 else 31337)
TIME_BUDGET = float(sys.argv[2]) if len(sys.argv) > 2 else 900


def gamma_frac(n, edges):
    """Fractional domination number by LP (GLOP)."""
    s = pywraplp.Solver.CreateSolver('GLOP')
    N = nbhd_masks(n, edges)
    x = [s.NumVar(0, 1, f'x{v}') for v in range(n)]
    for v in range(n):
        s.Add(sum(x[u] for u in range(n) if N[v] >> u & 1) >= 1)
    s.Minimize(sum(x))
    assert s.Solve() == pywraplp.Solver.OPTIMAL
    return s.Objective().Value()


def hill_climb_gap(n, g, iters=400):
    """Find graph on n vertices with gamma=g maximizing gamma - gamma_f."""
    # start from a cycle-ish graph with gamma g if possible, else random
    cur = None
    for _ in range(400):
        e = frozenset(random_connected_graph(n, random.uniform(0.12, 0.3)))
        if gamma_exact(n, e, cap=g) == g and gamma_exact(n, e, cap=g - 1) > g - 1:
            cur = e
            break
    if cur is None:
        return None
    cur_gap = g - gamma_frac(n, cur)
    allp = [(a, b) for a in range(n) for b in range(a + 1, n)]
    for _ in range(iters):
        trial = set(cur)
        op = random.random()
        if op < 0.4 and len(trial) > n - 1:
            trial.discard(random.choice(list(trial)))
        elif op < 0.8:
            trial.discard(random.choice(list(trial)))
            trial.add(random.choice(allp))
        else:
            trial.add(random.choice(allp))
        trial = frozenset(trial)
        if trial == cur or not connected(n, trial):
            continue
        if gamma_exact(n, trial, cap=g) != g:
            continue
        gap = g - gamma_frac(n, trial)
        if gap >= cur_gap:
            cur, cur_gap = trial, gap
    return cur, cur_gap


def main():
    t0 = time.time()
    pool = []
    # structured high-gap seeds: circulants (incl. odd cycles C10,C13),
    # generalized Petersen GP(7,2)
    gp72 = frozenset(
        [(i, (i + 1) % 7) for i in range(7)] +
        [(7 + i, 7 + (i + 2) % 7) for i in range(7)] +
        [(i, 7 + i) for i in range(7)])
    for n, e, tag in [(14, gp72, 'GP(7,2)')] + \
            [(n, circulant(n, S), f'circ{n}{S}')
             for n in range(10, 15)
             for S in [(1,), (1, 2), (1, 3), (1, 4), (2, 3), (1, 5), (2, 5),
                       (3, 4), (1, 6), (2, 7), (4, 5), (1, 7), (3, 5)]
             if max(S) <= n // 2]:
        if not connected(n, e):
            continue
        g = gamma_exact(n, e, cap=6)
        if not 4 <= g <= 6:
            continue
        gf = gamma_frac(n, e)
        pool.append((g - gf, n, e, g, tag))
    # hill-climbed high-gap randoms
    while time.time() - t0 < TIME_BUDGET * 0.4:
        n = random.choice([11, 12, 13, 14])
        g = random.choice([4, 4, 4, 5])
        r = hill_climb_gap(n, g, iters=150)
        if r is None:
            continue
        e, gap = r
        pool.append((gap, n, e, g, f'climb{n}g{g}gap{gap:.2f}'))

    pool.sort(key=lambda x: -x[0])
    print(f'pool of {len(pool)}, top gaps:', flush=True)
    for gap, n, e, g, tag in pool[:15]:
        print(f'  {tag}: n={n} gamma={g} gamma_f={g-gap:.3f} gap={gap:.3f}',
              flush=True)

    # pair the top-gap graphs, highest combined gap first
    top = pool[:22]
    cand = []
    for i in range(len(top)):
        for j in range(i, len(top)):
            gap1, n1, e1, g1, t1 = top[i]
            gap2, n2, e2, g2, t2 = top[j]
            if n1 * n2 > 225:
                continue
            lp_room = g1 * g2 - (g1 - gap1) * (g2 - gap2)  # gGgH - gfG*gfH
            cand.append((lp_room, i, j))
    cand.sort(key=lambda x: -x[0])
    print(f'{len(cand)} pairs; testing in order of LP room', flush=True)

    results = []
    for k, (room, i, j) in enumerate(cand):
        if time.time() - t0 > TIME_BUDGET:
            print('budget hit at pair', k, flush=True)
            break
        gap1, n1, e1, g1, t1 = top[i]
        gap2, n2, e2, g2, t2 = top[j]
        nP, eP = box_product(n1, e1, n2, e2)
        ts = time.time()
        feas, sol = domset_decision(nP, eP, g1 * g2 - 1, timeout=120)
        dt = time.time() - ts
        if feas is True:
            print('!!! COUNTEREXAMPLE:', t1, t2, flush=True)
            json.dump({'G': [n1, sorted(map(list, e1))],
                       'H': [n2, sorted(map(list, e2))],
                       'gG': g1, 'gH': g2, 'sol': sol},
                      open('CANDIDATE3.json', 'w'))
            return
        st = 'holds' if feas is False else 'TIMEOUT'
        # exact product gamma when cheap, for ratio records
        gP = None
        if feas is False and dt < 30:
            gP = gamma_product_exact(n1, e1, n2, e2, timeout=45,
                                     known_lb=g1 * g2)
        r = gP / (g1 * g2) if gP else None
        results.append({'G': t1, 'H': t2, 'room': room, 'gG': g1, 'gH': g2,
                        'gP': gP, 'ratio': r, 'status': st, 'dt': dt})
        rs = f' gP={gP} ratio={r:.3f}' if gP else ''
        print(f'[{k+1}/{len(cand)}] {t1} x {t2} room={room:.2f} {st} '
              f'({dt:.1f}s){rs}', flush=True)

    json.dump(results, open('results3.json', 'w'), indent=1)
    done = [x for x in results if x['ratio']]
    done.sort(key=lambda x: x['ratio'])
    print('tightest:')
    for x in done[:12]:
        print(f"  ratio={x['ratio']:.4f} {x['G']} x {x['H']} "
              f"gamma={x['gG']},{x['gH']} gP={x['gP']}")


if __name__ == '__main__':
    main()
