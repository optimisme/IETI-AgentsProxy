#!/usr/bin/env python3
"""Exercise actual JPEG decoding on the deployed native runtime."""
import json,subprocess,sys
from pathlib import Path
root=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(root/'tensorfold-zig-cache-tuning-20261018'))
from benchmark import api,body,request
base,out,container=sys.argv[1:];out=Path(out);out.mkdir(parents=True,exist_ok=True)
code="import io,base64;from PIL import Image;b=io.BytesIO();Image.new('RGB',(64,64),(255,0,0)).save(b,format='JPEG');print(base64.b64encode(b.getvalue()).decode())"
data=subprocess.check_output(['docker','exec',container,'python3','-c',code],text=True).strip()
model=api(base,'/v1/models')['data'][0]['id'];b=body(model,[{'role':'user','content':[{'type':'text','text':'What is the dominant color? Answer one word.'},{'type':'image_url','image_url':{'url':'data:image/jpeg;base64,'+data}}]}],64);b['ignore_eos']=False
r=request(base,b);r['passed']=r['error'] is None and 'red' in r['content'].lower()
(out/'jpeg-smoke.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r),flush=True)
