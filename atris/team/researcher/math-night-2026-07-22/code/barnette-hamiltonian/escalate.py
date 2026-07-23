import glob, sys, time, verify
files = sorted(glob.glob("candidate_*.txt"))
print(f"{len(files)} candidates")
nonham = []
for p in files:
    n, adj = verify.read_graph(p)
    t0 = time.time()
    has, _ = verify.ham_sat(n, adj)
    print(f"{p}: n={n} {'HAM' if has else '*** NON-HAMILTONIAN ***'} ({time.time()-t0:.1f}s)", flush=True)
    if not has: nonham.append(p)
print("NONHAM:", nonham)
