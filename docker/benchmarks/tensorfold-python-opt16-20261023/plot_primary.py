#!/usr/bin/env python3
"""Standalone scientific figure: paired GPU trials, observed ranges (not CIs)."""
import json,statistics
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
ROOT=Path(__file__).resolve().parent

def main():
    data=json.loads((ROOT/'analysis.json').read_text());pairs=[p for p in data['primary_sequences'] if p['bounded_noise_eligible']]
    if not pairs:raise SystemExit('No completed eligible primary pair yet')
    lookup={r['id']:r for r in data['runs']};prefix=pairs[0]['case_prefix'];count=pairs[0]['expected_timed_cases'];names=[prefix+'cold16',*[f'{prefix}return{i}-16' for i in range(1,count)]]
    fig,axes=plt.subplots(2,2,figsize=(12,8));panels=[('ttft_p50_s','First-token time: cohort median (s)',True),('ttft_p95_s','First-token time: cohort p95 (s)',True),('wall_s','Time to complete all 16 replies (s)',False),('min_available_gib','Minimum host available RAM (GiB)',False)]
    for ax,(metric,title,log) in zip(axes.flat,panels):
        for key,label,color,offset in [('baseline','Unchanged Python','#555555',-.09),('candidate','Opt16 Python','#087ea4',.09)]:
            groups=[]
            for name in names:
                values=[]
                for pair in pairs:
                    case=next(c for c in lookup[pair[key]]['cases'] if c['name']==name)
                    values.append(case['summary'][metric])
                groups.append(values)
            centers=[statistics.median(v) for v in groups];xs=[i+offset for i in range(count)]
            ax.errorbar(xs,centers,yerr=[[m-min(v) for m,v in zip(centers,groups)],[max(v)-m for m,v in zip(centers,groups)]],fmt='o-',capsize=4,color=color,label=label,lw=1.4)
            for x,values in zip(xs,groups):ax.scatter([x]*len(values),values,color=color,s=15,alpha=.5)
        if log:ax.set_yscale('log')
        if metric=='min_available_gib':ax.axhline(6,color='#b43838',linestyle='--',lw=1,label='Abort floor')
        ax.set_xticks(range(count),['Cold',*[f'Return {i}' for i in range(1,count)]]);ax.set_title(title,fontsize=11);ax.grid(alpha=.2);ax.legend(fontsize=8)
    fig.suptitle(f'Sixteen users · {count} fixed near75k rounds · {len(pairs)} matched GPU pairs',fontsize=14)
    fig.text(.5,.015,'Points: individual trials. Lines: medians. Bars: observed min–max, not confidence intervals.\nBounded host pageout analysis; raw flags and strict-zero-swap sample counts are in TABLES.md.',ha='center',fontsize=9)
    fig.tight_layout(rect=(0,.065,1,.95));out=ROOT/'figures';out.mkdir(exist_ok=True)
    for ext in ('png','svg'):fig.savefig(out/f'primary-paired.{ext}',dpi=170)

if __name__=='__main__':main()
