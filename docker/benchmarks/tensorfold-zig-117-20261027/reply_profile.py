"""Reply rounds from a server log run with TF_LANES_PHASES=1 TF_FLASHNEXT_PROFILE=2 TF_FLASHNEXT_DEPTH_LOG=1:
each round's host phases by live streams, and each decode pass's block times (verify rows at position 0).
usage: reply_profile.py LOG"""
import re, sys
from collections import defaultdict
from statistics import median

phase = re.compile(r'phases: gap=([\d.]+) plan=([\d.]+) streams=(\d+) rows=(\d+) verify=([\d.]+) conclude=([\d.]+) '
                   r'draft=([\d.]+) keep=([\d.]+) ms')
blocks = re.compile(r'blocks: (\d+) rows (.*) ms')
batch = re.compile(r'batch: (\d+) rows at (\d+) in ([\d.]+) ms')
rounds = defaultdict(list)
passes = defaultdict(list)
pending = None
depth = []
for line in open(sys.argv[1], errors='replace'):
    if m := phase.search(line):
        g, pl, st, rw, v, c, d, k = m.groups()
        rounds[int(st)].append((float(g), float(pl), int(rw), float(v), float(c), float(d), float(k)))
    elif m := blocks.search(line):
        pending = (int(m.group(1)), {kv.split('=')[0]: float(kv.split('=')[1]) for kv in m.group(2).split()})
    elif m := batch.search(line):
        n, at, ms = int(m.group(1)), int(m.group(2)), float(m.group(3))
        if pending and pending[0] == n and at == 0:
            passes[n].append((ms, pending[1]))
        pending = None
    elif line.startswith('DEPTH'):
        depth.append(line.strip())

print('rounds by live streams: count, median ms of gap plan verify conclude draft keep, rows, round total')
for st in sorted(rounds):
    rs = rounds[st]
    cols = list(zip(*rs))
    med = [median(c) for c in cols]
    total = median([sum(r[i] for i in (0, 1, 3, 4, 5, 6)) for r in rs])
    print(f'  {st:2d} streams: {len(rs):5d} rounds  gap {med[0]:.1f} plan {med[1]:.1f} verify {med[3]:.1f} conclude {med[4]:.1f} '
          f'draft {med[5]:.1f} keep {med[6]:.1f}  rows {med[2]:.0f}  total {total:.1f}')
print('decode passes (rows at 0) by rows: count, median wall ms, median block ms')
for n in sorted(passes):
    ps = passes[n]
    if len(ps) < 5:
        continue
    names = ps[0][1].keys()
    bl = ' '.join(f'{k} {median(p[1][k] for p in ps):.1f}' for k in names)
    print(f'  {n:3d} rows: {len(ps):5d}  wall {median(p[0] for p in ps):.1f}  {bl}')
print('draft depth, last report:')
for line in depth[-5:]:
    print(' ', line)
