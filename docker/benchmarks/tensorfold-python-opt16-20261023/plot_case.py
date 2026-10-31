#!/usr/bin/env python3
"""Standalone Gantt and memory evidence; run locally with Matplotlib."""
import argparse,json
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
ROOT=Path(__file__).resolve().parent
p=argparse.ArgumentParser();p.add_argument('--run',required=True);p.add_argument('--case',default='capacity-cold16');a=p.parse_args()
r=ROOT/'results'/a.run;x=json.loads((r/'client'/(a.case+'.json')).read_text());s=x['summary']
e=[json.loads(v) for v in (r/'engine.jsonl').read_text().splitlines()]
lookup={}
for v in e:
 if v.get('token_sha256'):lookup.setdefault(v['token_sha256'],{}).setdefault(v['event'],v)
t0=min(v['started_monotonic'] for v in x['requests']);epoch=min(v['started_epoch'] for v in x['requests'])
fig,axes=plt.subplots(4,1,figsize=(13,11),sharex=True,gridspec_kw={'height_ratios':[4,1.2,1.2,1.2]},layout='constrained')
colors={'Engine queue':'#d55e00','Admitted prefill (elapsed)':'#0072b2','Generation':'#009e73'}
failure_marked=False
for i,v in enumerate(x['requests']):
 d=lookup.get(v['token_sha256'],{});q=d.get('enqueue');b=d.get('admitted');f=d.get('first_token');z=d.get('finished')
 if z is None and v.get('error'):z={'monotonic':v['started_monotonic']+v['elapsed_s']}
 if not all((q,b,f,z)):
  if v.get('error'):
   axes[0].scatter(v['elapsed_s'],i,marker='x',color='#b00020',s=55,zorder=5,label='Request error' if not failure_marked else None);failure_marked=True
  continue
 for label,left,right in [('Engine queue',q,b),('Admitted prefill (elapsed)',b,f),('Generation',f,z)]:
  axes[0].barh(i,right['monotonic']-left['monotonic'],left=left['monotonic']-t0,height=.75,color=colors[label],label=label if i==0 else None)
 if v.get('error'):
  axes[0].scatter(v['elapsed_s'],i,marker='x',color='#b00020',s=55,zorder=5,label='Request error' if not failure_marked else None);failure_marked=True
axes[0].set_yticks(range(len(x['requests'])),[f'User {i+1}' for i in range(len(x['requests']))]);axes[0].invert_yaxis();axes[0].legend(loc='upper center',ncol=4,bbox_to_anchor=(.5,1.15));axes[0].set_title(f"{a.run} / {a.case}: {s['successes']}/{s['requests']} replies; output overlap {s['peak_overlapping_output_streams']}\nSwap-out {s['swap_out_pages']} pages; host OOM {s['oom_kills']} — per-trial observation")
mp=[]
for line in (r/'prometheus.jsonl').read_text().splitlines():
 try:v=json.loads(line)
 except json.JSONDecodeError:continue
 if 'metrics' in v and epoch<=v['time']<=epoch+s['wall_s']+1:mp.append(v)
for key,label,color in [('tensorfold:requests_running','Engine admitted','#0072b2'),('tensorfold:requests_waiting','Scheduler waiting','#d55e00')]:
 axes[1].step([v['time']-epoch for v in mp],[v['metrics'].get(key,0) for v in mp],where='post',label=label,color=color)
axes[1].set_ylabel('Requests');axes[1].legend(ncol=2)
sm=[v for v in e if v['event']=='sample' and epoch<=v['time']<=epoch+s['wall_s']+1]
for key,label in [('allocated_bytes','CUDA allocated'),('reserved_bytes','CUDA reserved')]:
 xx=[];yy=[];last=None
 for v in sm:
  if last is not None and v['time']-last>5:xx.append(np.nan);yy.append(np.nan)
  xx.append(v['time']-epoch);yy.append(v[key]/2**30);last=v['time']
 axes[2].plot(xx,yy,label=label)
axes[2].set_ylabel('GiB');axes[2].legend(ncol=2);axes[2].set_title('Gaps longer than 5s are left unconnected')
axes[3].plot([v['time']-epoch for v in x['monitor']],[v['available_gib'] for v in x['monitor']],label='Host available RAM')
axes[3].axhline(6,color='#d55e00',ls='--',label='Independent abort floor');axes[3].set_ylabel('GiB');axes[3].legend(ncol=2);axes[3].set_xlabel('Seconds since first client dispatch; red X = client receipt of request error')
for ax in axes:ax.grid(axis='x',alpha=.2);ax.set_axisbelow(True)
axes[-1].set_xlim(0,s['wall_s']+2)
out=ROOT/'figures';out.mkdir(exist_ok=True)
for ext in ('png','svg'):fig.savefig(out/f'{a.run}-{a.case}.{ext}',dpi=150)
plt.close(fig)
