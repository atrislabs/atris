"""Round-2 pair processor.

For each pool pair (i<=j):
  1. certified LP prune: exact-arithmetic dual packing bound B on gamma_f(GxH).
     If ceil(B) >= gG*gH  ->  HOLD_LP (proven, no ILP needed).
  2. else CP-SAT decision: does a dominating set of size gG*gH - 1 exist?
     FEASIBLE  -> CANDIDATE counterexample (goes to full verifier)
     INFEASIBLE-> HOLD_SAT
     timeout   -> UNDECIDED
Results appended to results.jsonl (resumable).
"""
import json, math, sys, time
from lib import box_product, gamma_f_lp, certified_lb

BUDGET = float(sys.argv[1]) if len(sys.argv) > 1 else 60.0

pool = json.load(open('pool.json'))
done = set()
try:
    for ln in open('results.jsonl'):
        r = json.loads(ln)
        done.add((r['i'], r['j']))
except FileNotFoundError:
    pass

out = open('results.jsonl', 'a')
t0 = time.time()
stats = {'HOLD_LP': 0, 'HOLD_SAT': 0, 'CANDIDATE': 0, 'UNDECIDED': 0}

def sat_decide(n, edges, t, budget):
    from ortools.sat.python import cp_model
    adj = [set([v]) for v in range(n)]
    for a, b in edges:
        adj[a].add(b)
        adj[b].add(a)
    m = cp_model.CpModel()
    x = [m.NewBoolVar(f'x{v}') for v in range(n)]
    for v in range(n):
        m.AddAtLeastOne([x[u] for u in adj[v]])
    m.Add(sum(x) <= t)
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = budget
    solver.parameters.num_search_workers = 8
    st = solver.Solve(m)
    if st in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return 'SAT', [v for v in range(n) if solver.Value(x[v])]
    if st == cp_model.INFEASIBLE:
        return 'UNSAT', None
    return 'UNKNOWN', None

npairs = 0
for i in range(len(pool)):
    for j in range(i, len(pool)):
        npairs += 1
        if (i, j) in done:
            continue
        G, H = pool[i], pool[j]
        target = G['gamma'] * H['gamma']
        nP, eP = box_product(G['n'], [tuple(e) for e in G['edges']],
                             H['n'], [tuple(e) for e in H['edges']])
        lp, duals = gamma_f_lp(nP, eP)
        cert = certified_lb(nP, eP, duals)
        rec = dict(i=i, j=j, G=G['name'], H=H['name'], nP=nP,
                   target=target, lp=round(lp, 4),
                   cert=f'{cert.numerator}/{cert.denominator}')
        if math.ceil(cert) >= target or (cert == int(cert) and int(cert) >= target):
            rec['verdict'] = 'HOLD_LP'
        else:
            res, wit = sat_decide(nP, eP, target - 1, BUDGET)
            if res == 'SAT':
                rec['verdict'] = 'CANDIDATE'
                rec['witness'] = wit
            elif res == 'UNSAT':
                rec['verdict'] = 'HOLD_SAT'
            else:
                rec['verdict'] = 'UNDECIDED'
        stats[rec['verdict']] += 1
        out.write(json.dumps(rec) + '\n')
        out.flush()
        if rec['verdict'] in ('CANDIDATE', 'UNDECIDED', 'HOLD_SAT'):
            print(f"[{time.time()-t0:6.0f}s] {G['name']} x {H['name']} nP={nP} "
                  f"target={target} lp={lp:.2f} -> {rec['verdict']}", flush=True)

print(f'\ntotal pairs={npairs} stats={stats} time={time.time()-t0:.0f}s')
