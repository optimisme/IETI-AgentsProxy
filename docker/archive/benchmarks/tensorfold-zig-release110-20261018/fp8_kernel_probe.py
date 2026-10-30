#!/usr/bin/env python3
"""GPU check: FP8 prep quantization, and attention equal to expanded FP8 bf16.
Runs the patched CUDA fatbin directly; no model inference through Python.
"""
import ctypes as C,json,sys
from pathlib import Path
import torch
assert torch.cuda.is_available()
torch.manual_seed(180026);device='cuda';d=C.CDLL('libcuda.so.1')
def check(v):
 if v:raise RuntimeError('CUDA driver error '+str(v))
check(d.cuInit(0));torch.empty(1,device=device)
module=C.c_void_p();check(d.cuModuleLoad(C.byref(module),sys.argv[1].encode()))
functions={}
def launch(name,grid,block,args,smem=0):
 if name not in functions:
  f=C.c_void_p();check(d.cuModuleGetFunction(C.byref(f),module,name.encode()));functions[name]=f
 f=functions[name]
 if smem:check(d.cuFuncSetAttribute(f,8,smem))
 vals=[C.c_uint64(v.data_ptr()) if isinstance(v,torch.Tensor) else C.c_float(v) if isinstance(v,float) else C.c_int(v) for v in args]
 pointers=(C.c_void_p*len(vals))(*[C.cast(C.byref(v),C.c_void_p) for v in vals])
 stream=C.c_void_p(torch.cuda.current_stream().cuda_stream)
 check(d.cuLaunchKernel(f,*[C.c_uint(x) for x in grid],*[C.c_uint(x) for x in block],C.c_uint(smem),stream,pointers,None))
 torch.cuda.synchronize()
def zeros(shape,dtype):return torch.zeros(shape,device=device,dtype=dtype)
B=torch.bfloat16;F=torch.float32;I=torch.int32;E=torch.float8_e4m3fn
NQ,HK,NI,DI,HD=32,2,8,128,256
receipts=[]
# Prep outputs shared by both cache types must be bit-identical; FP8 bytes must match quantization.
for rows,position in [(1,0),(7,2048),(16,74980)]:
 cap=position+rows;pw=2*NQ*HD+2*HK*HD+NI*DI+DI
 p=torch.randn((rows,pw),device=device,dtype=B)
 pos=torch.tensor([position,0,0,0],device=device,dtype=I)
 qw=torch.ones(HD,device=device);kw=qw.clone();iw=torch.ones(DI,device=device);inv=torch.arange(HD//2,device=device,dtype=F)/1000
 outputs=[]
 for suffix,dt in [('',B),('_fp8',E)]:
  q=zeros((rows,NQ,HD),B);kc=zeros((cap,HK,HD),dt);vc=kc.clone();iq=zeros((rows,NI,DI),B);ikc=zeros((cap,DI),B)
  launch('fn_attn_prep'+suffix,(rows,NQ+HK+NI+1,1),(HD,1,1),[p,pos,qw,kw,iw,inv,q,kc,vc,iq,ikc,1e-6,pw,NQ,HK,NI,DI,128])
  outputs.append((q,kc,vc,iq,ikc))
 a,b=outputs
 for i in (0,3,4):assert torch.equal(a[i],b[i]),('prep output',i,rows,position)
 for i in (1,2):assert torch.equal(a[i][position:].to(E).view(torch.uint8),b[i][position:].view(torch.uint8)),('quantization',i,rows,position)
 receipts.append({'kind':'prep','rows':rows,'position':position,'passed':True})
 del outputs,a,b,kc,vc,ikc
 torch.cuda.empty_cache()
# Existing bf16 path receives exactly the values stored by FP8; this isolates decode math from quantization error.
for context in (1,511,512,2048,2052,4096,75000):
 rows=1;hk=HK;group=NQ//hk;nch=5;chunks=(min(context,2051)+511)//512
 q=torch.randn((rows,NQ,HD),device=device,dtype=B)
 k=torch.randn((context,hk,HD),device=device,dtype=B).to(E);v=torch.randn((context,hk,HD),device=device,dtype=B).to(E)
 pos=torch.tensor([context-1,0,0,0],device=device,dtype=I)
 count=min(context,2048);ids=torch.linspace(0,context-1,count,device=device).to(I);ids=torch.cat((ids,zeros((max(0,2052-count),),I)))
 nk=torch.tensor([count],device=device,dtype=I);sparse=torch.tensor([int(context>2048)],device=device,dtype=I)
 for ahead in (False,True):
  outputs=[]
  for suffix,kk,vv in [('',k.to(B),v.to(B)),('_fp8',k,v)]:
   po=zeros((rows,NQ,nch,HD),F);pm=zeros((rows,NQ,nch),F);pl=pm.clone()
   nb=2 if ahead else 1;smem=(16+nb*2*32)*(HD+8)*2+16*(32+8)*2
   name='fn_attn_chunks'+('_ahead' if ahead else '')+suffix
   launch(name,(rows,hk,chunks),(128,1,1),[q,kk,vv,pos,po,pm,pl,ids,nk,sparse,NQ,hk,group,512,nch,0.0625,2052,1],smem)
   outputs.append((po,pm,pl))
  for i in range(3):assert torch.equal(outputs[0][i],outputs[1][i]),('attention',context,ahead,i,(outputs[0][i]-outputs[1][i]).abs().max().item())
  receipts.append({'kind':'attention','context':context,'ahead':ahead,'passed':True})
 del k,v,q,outputs
 torch.cuda.empty_cache()
result={'gpu':torch.cuda.get_device_name(),'checks':receipts,'all_passed':True,'scope':'Raw patched CUDA kernels, not model quality or throughput'}
Path(sys.argv[2]).write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
