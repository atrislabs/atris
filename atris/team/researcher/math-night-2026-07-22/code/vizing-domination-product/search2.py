#!/usr/bin/env python3
"""Second wave: hill-climb on the violation margin.

Start from self-pairs (G,G) of gamma-4/5 edge-critical graphs and from the
tightest pairs found in run 1. Mutation: remove a random edge / swap an edge,
keep connectivity and gamma(G) fixed, accept the mutant if the exact product
gamma does not increase (Metropolis-ish: accept equal, always accept lower).
Objective: margin(G,H) = gamma(GboxH) - gamma(G)*gamma(H). A margin < 0 is a
counterexample.
"""
import random, sys, time, json
from search import (gamma_exact, connected, box_product, domset_decision,
                    gamma_product_exact, make_edge_critical,
                    random_connected_graph, circulant)

random.seed(int(sys.argv[1]) if len(sys.argv) > 1 else 999)
TIME_BUDGET = float(sys.argv[2]) if len(sys.argv) > 2 else 1200


def margin(nG, eG, gG, nH, eH, gH, timeout=60):
    """Return gamma(P) - gG*gH (None on solver timeout)."""
    nP, eP = box_product(nG, eG, nH, eH)
    feas, sol = domset_decision(nP, eP, gG * gH - 1, timeout=timeout)
    if feas is True:
        return -1, sol  # counterexample!
    if feas is None:
        return None, None
    gP = gamma_product_exact(nG, eG, nH, eH, timeout=timeout, known_lb=gG * gH)
    if gP is None:
        return None, None
    return gP - gG * gH, None


def mutate(n, edges, g):
    """Random small edit preserving connectivity and gamma."""
    edges = set(edges)
    allp = [(a, b) for a in range(n) for b in range(a + 1, n)]
    for _ in range(60):
        op = random.random()
        trial = set(edges)
        if op < 0.45 and len(edges) > n - 1:
            trial.discard(random.choice(list(edges)))
        elif op < 0.9:
            e = random.choice(list(edges))
            f = random.choice(allp)
            trial.discard(e)
            trial.add(f)
        else:
            trial.add(random.choice(allp))
        if trial == edges or not connected(n, trial):
            continue
        if gamma_exact(n, trial, cap=g) == g:
            return frozenset(trial)
    return None


def main():
    t0 = time.time()
    # seeds: tight pairs from run 1 if available, else fresh criticals
    seeds = []
    try:
        res = json.load(open('results.json'))
        pool_by_tag = {}
        # results.json only has tags; regenerate is hard, so also build fresh
    except FileNotFoundError:
        pass
    # fresh seeds: gamma-4 criticalized randoms, n=12..13 (self-pairs)
    while len(seeds) < 6 and time.time() - t0 < 240:
        n = random.choice([12, 13])
        e = frozenset(random_connected_graph(n, random.uniform(0.12, 0.25)))
        g = gamma_exact(n, e, cap=5)
        if g != 4:
            continue
        ec = make_edge_critical(n, e, 4)
        seeds.append((n, ec, 4))
    # plus the two structurally interesting circulants
    seeds.append((13, circulant(13, (1, 5)), 4))
    seeds.append((12, circulant(12, (1, 5)), 4))

    best_overall = (10, None)
    log = []
    for si, (n, e0, g) in enumerate(seeds):
        if time.time() - t0 > TIME_BUDGET:
            break
        cur = e0
        m0, sol = margin(n, cur, g, n, cur, g, timeout=45)
        if m0 == -1:
            print('COUNTEREXAMPLE (seed)!', flush=True)
            json.dump({'n': n, 'edges': sorted(map(list, cur)), 'sol': sol},
                      open('CANDIDATE2.json', 'w'))
            return
        if m0 is None:
            continue
        print(f'seed {si}: n={n} m={len(cur)} gamma={g} self-margin={m0}',
              flush=True)
        cur_m = m0
        stall = 0
        while time.time() - t0 < TIME_BUDGET and stall < 12:
            mut = mutate(n, cur, g)
            if mut is None:
                break
            mm, sol = margin(n, mut, g, n, mut, g, timeout=45)
            if mm == -1:
                print('COUNTEREXAMPLE (mutant)!', flush=True)
                json.dump({'n': n, 'edges': sorted(map(list, mut)), 'sol': sol},
                          open('CANDIDATE2.json', 'w'))
                return
            if mm is not None and mm <= cur_m:
                if mm < cur_m:
                    print(f'  improved margin {cur_m} -> {mm} '
                          f'(m={len(mut)})', flush=True)
                    stall = 0
                else:
                    stall += 1
                cur, cur_m = mut, mm
            else:
                stall += 1
            if cur_m < best_overall[0]:
                best_overall = (cur_m, (n, sorted(map(list, cur)), g))
        log.append({'seed': si, 'n': n, 'final_margin': cur_m,
                    'edges': sorted(map(list, cur))})
        print(f'seed {si} final margin {cur_m}', flush=True)

    json.dump({'best_margin': best_overall[0], 'best': best_overall[1],
               'log': log}, open('results2.json', 'w'), indent=1)
    print('done. best self-pair margin:', best_overall[0])


if __name__ == '__main__':
    main()
