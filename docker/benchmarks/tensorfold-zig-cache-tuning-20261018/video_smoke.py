#!/usr/bin/env python3
"""Generate a synthetic red MP4 and check the selected GPU server's video input."""
import argparse,base64,json,subprocess
from pathlib import Path
import benchmark as bench
p=argparse.ArgumentParser()
p.add_argument('--base',default='http://127.0.0.1:8007')
p.add_argument('--out',required=True)
a=p.parse_args();out=Path(a.out);out.mkdir(exist_ok=True)
encoder='''import io,av,numpy as np,sys
b=io.BytesIO()
c=av.open(b,mode="w",format="mp4")
s=c.add_stream("mpeg4",rate=2);s.width=64;s.height=64;s.pix_fmt="yuv420p"
p=np.zeros((64,64,3),dtype=np.uint8);p[:,:,0]=255
for i in range(4):
 f=av.VideoFrame.from_ndarray(p,format="rgb24")
 for packet in s.encode(f):c.mux(packet)
for packet in s.encode():c.mux(packet)
c.close();sys.stdout.buffer.write(b.getvalue())
'''
video=subprocess.check_output(['docker','exec','qwen38_flash_next_cuda_vram128_tensorfold_zig_tuned_int4_mtp_fp8_vision','/opt/ieti-zig/venv/bin/python','-c',encoder])
(out/'red-fixture.mp4').write_bytes(video)
model=bench.api(a.base,'/v1/models')['data'][0]['id']
payload=bench.body(model,[{'role':'user','content':[
 {'type':'text','text':'What is the dominant color throughout this video? Answer one word.'},
 {'type':'video_url','video_url':{'url':'data:video/mp4;base64,'+base64.b64encode(video).decode()}}
]}],64)
payload['ignore_eos']=False
r=bench.request(a.base,payload)
r['passed']=r['error'] is None and 'red' in r['content'].lower()
(out/'video.json').write_text(json.dumps(r,indent=2)+'\n')
assert r['passed'],r
print(json.dumps({'passed':True,'video_bytes':len(video),'content':r['content'],'elapsed_s':r['elapsed_s']}))
