"""p50/p90 of the traced PLE gathers (TF_HOST_TRACE=1 'ple gather' lines) of 200+ lookups in a server log."""
import re, sys

pat = re.compile(r"items=(\d+) parts=(\d+): fill (\d+) us, sums (\d+) us, minflt (-?\d+), majflt (-?\d+), last start (\d+) us, longest part (\d+) us, busy (\d+) us, cpu (\d+) us")
rows = [tuple(map(int, m.groups())) for m in map(pat.search, open(sys.argv[1], errors="replace")) if m and int(m.group(1)) >= 200]
for name, i in [("items", 0), ("fill_us", 2), ("majflt", 5), ("longest_part_us", 7), ("busy_us", 8), ("cpu_us", 9)]:
    v = sorted(r[i] for r in rows)
    if v:
        print(f"{name:16} p50 {v[len(v) // 2]:>8} p90 {v[int(len(v) * .9)]:>8} n {len(v)}")
