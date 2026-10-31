#!/usr/bin/env python3
"""Standalone publication-style latency plot; ranges are observations, not CIs."""
import json
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
ROOT=Path(__file__).resolve().parent


def main():
    d=json.loads((ROOT/'analysis.json').read_text());cells={x['case']:x for x in d['aggregates']}
    plt.rcParams.update({'font.family':'DejaVu Sans','font.size':10,'axes.spines.top':False,'axes.spines.right':False})
    fig,axes=plt.subplots(3,2,figsize=(11,9),layout='constrained')
    for row,(kind,title) in enumerate([('context2k','~2k histories'),('context8k','~8k histories'),('mixed','Mixed ~16k / ~2k / ~8k histories')]):
        for col,turn in enumerate([0,2]):
            ax=axes[row,col]
            for variant,label,color in [('original','Original','#2166AC'),('tuned','Opt16','#C65428')]:
                points=[]
                for n in [1,2,4,8]:
                    c=cells[f'{kind}-n{n}-turn{turn}'];assert c['matched_pairs']==3
                    points.append(c[variant]['ttft_p50_s'])
                ys=[p['median'] for p in points]
                ax.errorbar(range(4),ys,yerr=[[p['median']-p['min'] for p in points],[p['max']-p['median'] for p in points]],marker='o',color=color,label=label,capsize=3,linewidth=1.8)
            ax.set_xticks(range(4),['1','2','4','8']);ax.set_xlabel('Concurrent users (server cap stays 16)')
            ax.set_ylabel('Median first SSE output (s)');ax.set_title(title+' — '+('cold' if turn==0 else 'second return'))
            ax.grid(axis='y',alpha=.2);ax.set_ylim(bottom=0)
    axes[0,0].legend(frameon=False)
    fig.suptitle('Typical-load latency: original Python versus opt16\nThree matched fresh-process pairs; bars show observed ranges',fontsize=14)
    fig.supxlabel('Synthetic fixed histories, reasoning disabled, equal output budgets. 75k context limit retained. Mixed at one user is a single ~16k history.',fontsize=9)
    folder=ROOT/'figures';folder.mkdir(exist_ok=True)
    for ext in ['png','svg']:fig.savefig(folder/f'typical-latency.{ext}',dpi=170)
    plt.close(fig)


if __name__=='__main__':main()
