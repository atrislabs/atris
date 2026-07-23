#!/bin/bash
# Exhaust Barnette graphs on 44,46,48 vertices (triangulation orders 24,25,26).
cd "$(dirname "$0")"
rm -f exhaust_survivors.pc exhaust.log
for n in 24 25 26; do
  echo "=== n=$n (dual $((2*n-4)) vertices) ===" >> exhaust.log
  for r in $(seq 0 19); do
    while [ "$(jobs -r | wc -l)" -ge 8 ]; do sleep 2; done
    ( ./plantri -bd $n $r/20 2>/dev/null | ./ham2 exhaust_survivors.pc 500000000 \
        >> exhaust.log 2>&1 ) &
  done
  wait
  echo "=== done n=$n ===" >> exhaust.log
done
echo "ALL DONE" >> exhaust.log
