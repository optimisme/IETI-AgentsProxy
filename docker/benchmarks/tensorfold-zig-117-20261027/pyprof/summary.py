"""Python's reply rounds by live streams from a log with IETI_ROUND_TIMES=1 (pyprof/sitecustomize.py): rounds without a
prompt pass, median rows, forward, drafts and round ms. usage: summary.py LOG"""
import re, sys
from collections import defaultdict
from statistics import median

line_re = re.compile(r'pyphases: streams=(\d+) rows=(\d+) fill=(\d) verify=([\d.]+) draft=([\d.]+) total=([\d.]+) ms')
rounds = defaultdict(list)
for line in open(sys.argv[1], errors='replace'):
    if m := line_re.search(line):
        st, rows, fill, v, d, t = m.groups()
        if fill == '0':
            rounds[int(st)].append((int(rows), float(v), float(d), float(t)))
print('python rounds without a prompt pass: streams, count, median rows, verify, draft, total ms')
for st in sorted(rounds):
    rs = rounds[st]
    rows, v, d, t = (median(c) for c in zip(*rs))
    print(f'  {st:2d} streams: {len(rs):5d} rounds  rows {rows:.0f}  verify {v:.1f}  draft {d:.1f}  total {t:.1f}')
