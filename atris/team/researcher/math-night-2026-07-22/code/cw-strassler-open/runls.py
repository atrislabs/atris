import sys
from orbitls import run_case
from search import OPEN_CASES
half = int(sys.argv[1])
cap = int(sys.argv[2])
cases = OPEN_CASES[half::2]
for n, k in cases:
    run_case(n, k, time_cap=cap)
