#!/usr/bin/env python3
"""Eleven independent inline PNGs; limited color recognition and concurrency smoke."""
import base64,json,struct,sys,zlib
from pathlib import Path
root=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(root/'tensorfold-zig-cache-tuning-20261018'))
from benchmark import api,body,cohort
base=sys.argv[1];out=Path(sys.argv[2]);out.mkdir(parents=True,exist_ok=True)
model=api(base,'/v1/models')['data'][0]['id']
def chunk(k,d):return struct.pack('>I',len(d))+k+d+struct.pack('>I',zlib.crc32(k+d)&0xffffffff)
colors=[('red',b'\xff\0\0'),('green',b'\0\xff\0'),('blue',b'\0\0\xff')]
payloads=[];expected=[]
for i in range(11):
 color,rgb=colors[i%3];expected.append(color)
 png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',64,64,8,2,0,0,0))+chunk(b'IDAT',zlib.compress((b'\0'+rgb*64)*64))+chunk(b'IEND',b'')
 b=body(model,[{'role':'user','content':[{'type':'text','text':f'Independent image request {i}. What is the dominant color? Answer one word.'},{'type':'image_url','image_url':{'url':'data:image/png;base64,'+base64.b64encode(png).decode()}}]}],64);b['ignore_eos']=False;payloads.append(b)
r=cohort(base,'images11',payloads,out)
cases=[{'expected':want,'answer':got['content'],'error':got['error'],'passed':got['error'] is None and want in got['content'].lower()} for want,got in zip(expected,r['requests'])]
(out/'images11-quality.json').write_text(json.dumps({'cases':cases,'passed':sum(c['passed'] for c in cases),'total':11,'scope':'Synthetic color recognition only; not general visual reasoning or multi-image qualification.'},indent=2)+'\n')
print(json.dumps({'passed':sum(c['passed'] for c in cases),'total':11}),flush=True)
