#!/bin/sh
cd "$(dirname "$0")"
PY=/Users/keshavrao/.pyenv/versions/3.12.0/bin/python3
rm -f r5_reg8n14_exits.txt r5_reg10n15_exits.txt
for i in 0 1 2 3 4 5 6 7 8 9; do
  ( geng -q -d4 -D4 15 $i/10 | $PY sweep.py --mode complement \
      --label reg10n15-s$i --restarts 300 --seed $((2000+i)) \
      > r5_log_reg10n15_s$i.txt 2>&1; echo "shard $i exit $?" >> r5_reg10n15_exits.txt ) &
done
for i in 0 1 2 3 4 5 6 7 8 9; do
  ( geng -q -d5 -D5 14 $i/10 | $PY sweep.py --mode complement \
      --label reg8n14-s$i --restarts 300 --seed $((3000+i)) \
      > r5_log_reg8n14_s$i.txt 2>&1; echo "shard $i exit $?" >> r5_reg8n14_exits.txt ) &
done
wait
echo ALLDONE > r5_all_done.txt
